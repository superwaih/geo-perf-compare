import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { FrameMonitor, afterPaint, type Stats } from "./perf";
import { makePoints, kmeans, type Cluster } from "./cluster";

const APP = "react";
const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed"];
const embedded = window.parent !== window;

interface Point { lat: number; lng: number; category: number }
type Renderer = "svg" | "canvas";

/** Message protocol shared with the dashboard and the Rust app (see README). */
type Command =
  | { type: "load"; runId: number; mode: "replace" | "append"; geojson: string }
  | { type: "clear"; runId: number }
  | { type: "setRenderer"; runId: number; renderer: Renderer }
  | { type: "setTiles"; enabled: boolean }
  | { type: "stress"; runId: number; durationMs: number }
  | { type: "cluster"; runId: number; n: number; k: number; iterations: number; seed: number };

const post = (msg: object) => {
  if (embedded) window.parent.postMessage({ ...msg, app: APP }, "*");
};

interface Pending { runId: number; t0: number; parseMs: number; added: number }

export default function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const group = useRef<L.LayerGroup>();
  const clusters = useRef<L.LayerGroup>(); // results of the clustering test
  const tiles = useRef<L.TileLayer>();
  const renderer = useRef<{ kind: Renderer; r: L.Renderer }>({ kind: "svg", r: L.svg() });
  const rendered = useRef(0); // how many points of `points` are already on the map
  const pending = useRef<Pending | null>(null);
  const monitor = useRef(new FrameMonitor());

  // App state: the point list lives in React state; an effect syncs it to Leaflet.
  const [points, setPoints] = useState<{ list: Point[]; version: number }>({ list: [], version: 0 });
  const [stats, setStats] = useState<Stats | null>(null);
  const [last, setLast] = useState<{ parseMs: number; renderMs: number; totalMs: number } | null>(null);

  // --- map setup -----------------------------------------------------------
  useEffect(() => {
    const m = L.map(mapDiv.current!, { worldCopyJump: true }).setView([20, 10], 2);
    tiles.current = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);
    group.current = L.layerGroup().addTo(m);
    clusters.current = L.layerGroup().addTo(m);
    map.current = m;

    // Click to add a point.
    m.on("click", (e: L.LeafletMouseEvent) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng, category: 3 };
      pending.current = { runId: -1, t0: performance.now(), parseMs: 0, added: 1 };
      setPoints((s) => ({ list: [...s.list, p], version: s.version }));
    });

    monitor.current.start((s) => {
      setStats(s);
      post({ type: "stats", ...s, count: rendered.current });
    });

    if (embedded) post({ type: "ready" });
    else
      fetch(`${import.meta.env.BASE_URL}points-2000.geojson`)
        .then((r) => r.text())
        .then((geojson) => handle({ type: "load", runId: 0, mode: "replace", geojson }));

    return () => { m.remove(); };
  }, []);

  // --- sync React state -> Leaflet ------------------------------------------
  const lastVersion = useRef(0);
  useEffect(() => {
    const g = group.current!;
    if (points.version !== lastVersion.current) {
      g.clearLayers();
      rendered.current = 0;
      lastVersion.current = points.version;
    }
    const r = renderer.current.r;
    const styles = COLORS.map((c) => ({
      renderer: r, radius: 4, weight: 1, color: "#0f172a", fillColor: c, fillOpacity: 0.75,
    }));
    const list = points.list;
    for (let i = rendered.current; i < list.length; i++) {
      const p = list[i];
      g.addLayer(L.circleMarker([p.lat, p.lng], styles[p.category % styles.length]));
    }
    rendered.current = list.length;

    const job = pending.current;
    if (job) {
      pending.current = null;
      afterPaint().then((tEnd) => {
        // renderMs = state update + reconciliation + marker creation + paint
        const totalMs = tEnd - job.t0;
        const res = { parseMs: job.parseMs, renderMs: totalMs - job.parseMs, totalMs };
        setLast(res);
        post({ type: "loaded", runId: job.runId, count: list.length, added: job.added, ...res });
      });
    }
  }, [points]);

  // --- command handling ------------------------------------------------------
  const handle = async (cmd: Command) => {
    switch (cmd.type) {
      case "load": {
        const t0 = performance.now();
        const fc = JSON.parse(cmd.geojson);
        const parsed: Point[] = fc.features.map((f: any) => ({
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          category: f.properties?.category ?? 0,
        }));
        const parseMs = performance.now() - t0;
        pending.current = { runId: cmd.runId, t0, parseMs, added: parsed.length };
        setPoints((s) =>
          cmd.mode === "append"
            ? { list: s.list.concat(parsed), version: s.version }
            : { list: parsed, version: s.version + 1 },
        );
        break;
      }
      case "clear":
        clusters.current?.clearLayers();
        pending.current = { runId: cmd.runId, t0: performance.now(), parseMs: 0, added: 0 };
        setPoints((s) => ({ list: [], version: s.version + 1 }));
        break;
      case "setRenderer":
        renderer.current = { kind: cmd.renderer, r: cmd.renderer === "canvas" ? L.canvas({ padding: 0.5 }) : L.svg() };
        pending.current = { runId: cmd.runId, t0: performance.now(), parseMs: 0, added: 0 };
        setPoints((s) => ({ list: s.list, version: s.version + 1 })); // force full re-render
        break;
      case "setTiles":
        if (cmd.enabled) tiles.current!.addTo(map.current!);
        else tiles.current!.remove();
        break;
      case "cluster": {
        const pts = makePoints(cmd.n, cmd.seed); // not timed
        const t0 = performance.now();
        const result = kmeans(pts, cmd.k, cmd.iterations);
        const ms = performance.now() - t0;
        drawClusters(result);
        // fingerprint: identical in both apps when they found the same groups
        const fingerprint = result.reduce((s, c, i) => s + (i + 1) * c.count, 0);
        post({ type: "clustered", runId: cmd.runId, ms, n: cmd.n, k: cmd.k, fingerprint });
        break;
      }
      case "stress":
        post({ type: "stressResult", runId: cmd.runId, count: rendered.current, ...(await stress(cmd.durationMs)) });
        break;
    }
  };
  /** One bubble per cluster, sized by how many points it holds. */
  const drawClusters = (result: Cluster[]) => {
    const g = clusters.current!;
    g.clearLayers();
    const max = Math.max(...result.map((c) => c.count));
    for (const c of result) {
      g.addLayer(L.circleMarker([c.lat, c.lng], {
        radius: 6 + 22 * Math.sqrt(c.count / max), weight: 1.5, color: "#0f172a", fillColor: "#0f172a", fillOpacity: 0.35,
      }).bindTooltip(`${c.count.toLocaleString()} points`));
    }
  };

  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window.parent || !e.data?.type) return;
      handleRef.current(e.data as Command);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  /** Continuous pan + periodic zoom for `durationMs`, recording every frame time. */
  const stress = (durationMs: number) =>
    new Promise<ReturnType<FrameMonitor["endRecording"]>>((resolve) => {
      const m = map.current!;
      const center = m.getCenter();
      const zoom = m.getZoom();
      monitor.current.beginRecording();
      const start = performance.now();
      let lastZoom = start;
      let zoomIn = true;
      const step = (ts: number) => {
        const t = ts - start;
        if (t >= durationMs) {
          const res = monitor.current.endRecording(t);
          m.setView(center, zoom, { animate: false });
          return resolve(res);
        }
        m.panBy([Math.cos(t / 600) * 6, Math.sin(t / 600) * 6], { animate: false });
        if (ts - lastZoom > 700) {
          m.setZoom(m.getZoom() + (zoomIn ? 1 : -1));
          zoomIn = !zoomIn;
          lastZoom = ts;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

  const addRandom = (n: number) => {
    const fc = { features: [] as any[] };
    for (let i = 0; i < n; i++)
      fc.features.push({
        geometry: { coordinates: [-170 + Math.random() * 340, -55 + Math.random() * 125] },
        properties: { category: i % 5 },
      });
    handle({ type: "load", runId: -1, mode: "append", geojson: JSON.stringify(fc) });
  };

  const bad = (v: number, limit: number) => (v > limit ? "bad" : "");
  return (
    <>
      <div id="map" ref={mapDiv} />
      <div className="badge">React + Vite</div>
      <div className="hud">
        <div>points <b>{points.list.length.toLocaleString()}</b></div>
        {stats && (
          <>
            <div>fps <b className={bad(30 - stats.fps, 0)}>{stats.fps.toFixed(0)}</b> · max frame{" "}
              <b className={bad(stats.maxFrameMs, 50)}>{stats.maxFrameMs.toFixed(0)}ms</b></div>
            <div>jank <b>{stats.jankFrames}</b> · freezes <b className={bad(stats.freezes, 0)}>{stats.freezes}</b></div>
          </>
        )}
        {last && <div>last load <b>{last.totalMs.toFixed(0)}ms</b> (parse {last.parseMs.toFixed(1)})</div>}
        {!embedded && (
          <div>
            <button onClick={() => addRandom(1000)}>+1000</button>
            <button onClick={() => stress(4000).then((r) => alert(JSON.stringify(r, null, 1)))}>stress</button>
          </div>
        )}
      </div>
    </>
  );
}
