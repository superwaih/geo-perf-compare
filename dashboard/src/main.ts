// Dashboard: hosts both apps in iframes, drives them over postMessage, and says which one kept up.
import { generatePoints } from "./geojson.js";

type AppId = "react" | "rust";
const APP_IDS: AppId[] = ["react", "rust"];
const LABEL: Record<AppId, string> = { react: "React", rust: "Rust" };
const BATCH = 2000; // points per click
const STALL_MS = 1500; // no stats for this long => app is not responding (a "break")

const params = new URLSearchParams(location.search);
// Local dev (`npm start`): each app on its own port. Deployed (`npm run build:site`):
// one site with the apps at ./react/ and ./rust/. Override either with ?react=…&rust=…
const isLocalDev = location.port === "5173";
const URLS: Record<AppId, string> = {
  react: params.get("react") ?? (isLocalDev ? `http://${location.hostname}:5174/` : new URL("react/", location.href).href),
  rust: params.get("rust") ?? (isLocalDev ? `http://${location.hostname}:5175/` : new URL("rust/", location.href).href),
};

interface Stats { fps: number; maxFrameMs: number; jankFrames: number; freezes: number; count: number }
interface AppState {
  id: AppId; frame: HTMLIFrameElement; origin: string; ready: boolean;
  statusEl: HTMLElement; resultEl: HTMLElement;
  stats: Stats | null; lastStatsAt: number; count: number; busy: boolean;
  lastMs: number | null; lastLabel: string; fingerprint: number | null;
  waiters: Map<number, (msg: any) => void>;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const apps = {} as Record<AppId, AppState>;
for (const id of APP_IDS) {
  const panel = $(`[data-app="${id}"]`);
  const frame = panel.querySelector("[data-frame]") as HTMLIFrameElement;
  frame.src = URLS[id];
  apps[id] = {
    id, frame, origin: new URL(URLS[id], location.href).origin, ready: false,
    statusEl: panel.querySelector("[data-status]")!, resultEl: panel.querySelector("[data-result]")!,
    stats: null, lastStatsAt: 0, count: 0, busy: false, lastMs: null, lastLabel: "", fingerprint: null, waiters: new Map(),
  };
}

// ---------------------------------------------------------------- messaging

let runSeq = 1;
const send = (a: AppState, cmd: object) => a.frame.contentWindow?.postMessage(cmd, a.origin);

function request(a: AppState, cmd: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
  const runId = runSeq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { a.waiters.delete(runId); resolve({ error: "timeout" }); }, timeoutMs);
    a.waiters.set(runId, (msg) => { clearTimeout(timer); resolve(msg); });
    send(a, { ...cmd, runId });
  });
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  const a = APP_IDS.map((id) => apps[id]).find((x) => x.origin === e.origin && x.frame.contentWindow === e.source);
  if (!a || !msg?.type) return;
  switch (msg.type) {
    case "ready":
      a.ready = true; updateStatus(a);
      break;
    case "stats":
      a.ready = true; a.stats = msg; a.lastStatsAt = performance.now(); a.count = msg.count;
      updateStatus(a);
      break;
    case "loaded":
    case "clustered":
      if (msg.count != null) a.count = msg.count;
      a.waiters.get(msg.runId)?.(msg);
      a.waiters.delete(msg.runId);
      break;
  }
});

// ------------------------------------------------------------------ actions

const loadBtn = $<HTMLButtonElement>("#loadBtn");
const clearBtn = $<HTMLButtonElement>("#clearBtn");
const clusterBtn = $<HTMLButtonElement>("#clusterBtn");
const CLUSTER = { n: 100_000, k: 50, iterations: 15, seed: 7, runs: 3 };
const progressEl = $("#progress");
const say = (text: string) => { progressEl.textContent = text; };
const idle = (ms: number) => new Promise((r) => setTimeout(r, ms));
let flip = false;
let addSeed = 1000;

/** One app at a time, alternating who goes first, so they never compete for the CPU. */
async function forBoth(fn: (a: AppState) => Promise<void>) {
  const order = (flip = !flip) ? APP_IDS : [...APP_IDS].reverse();
  const targets = order.map((id) => apps[id]).filter((a) => a.ready);
  if (targets.length < 2) throw new Error("The maps are still starting. Try again in a few seconds.");
  for (const a of targets) await fn(a);
}

async function busy(job: () => Promise<void>) {
  loadBtn.disabled = clearBtn.disabled = clusterBtn.disabled = true;
  try { await job(); } catch (err) {
    say(err instanceof Error ? err.message : "Something went wrong. Try again.");
  } finally {
    loadBtn.disabled = clusterBtn.disabled = false;
    clearBtn.disabled = Math.max(...APP_IDS.map((id) => apps[id].count)) === 0 && APP_IDS.every((id) => apps[id].lastMs == null);
    APP_IDS.forEach((id) => { apps[id].busy = false; updateStatus(apps[id]); });
  }
}

loadBtn.onclick = () => busy(async () => {
  const first = Math.max(...APP_IDS.map((id) => apps[id].count)) === 0;
  const geojson = JSON.stringify(first ? generatePoints(BATCH, 42) : generatePoints(BATCH, addSeed++, apps.react.count));
  await forBoth(async (a) => {
    a.busy = true; updateStatus(a);
    say(`Putting ${BATCH.toLocaleString()} points on the ${LABEL[a.id]} map…`);
    const res = await request(a, { type: "load", mode: first ? "replace" : "append", geojson });
    a.busy = false;
    a.lastMs = typeof res.totalMs === "number" ? res.totalMs : null;
    a.lastLabel = `Showed ${BATCH.toLocaleString()} points`;
    if (typeof res.count === "number") a.count = res.count;
    updateStatus(a);
    await idle(150);
  });
  renderResults();
  say(`Now ${apps.react.count.toLocaleString()} points on each map. Drag and zoom them to feel the difference.`);
  loadBtn.textContent = `Add ${BATCH.toLocaleString()} more`;
});

// Pure calculation, inside each app: where Rust/WebAssembly is expected to shine.
clusterBtn.onclick = () => busy(async () => {
  const { n, k, iterations, seed, runs } = CLUSTER;
  await forBoth(async (a) => {
    a.busy = true; updateStatus(a);
    let best: number | null = null;
    for (let run = 1; run <= runs; run++) {
      say(`Grouping ${n.toLocaleString()} points on the ${LABEL[a.id]} map, run ${run} of ${runs}…`);
      const res = await request(a, { type: "cluster", n, k, iterations, seed });
      if (typeof res.ms !== "number") { best = null; break; }
      best = best == null ? res.ms : Math.min(best, res.ms);
      a.fingerprint = typeof res.fingerprint === "number" ? res.fingerprint : null;
      await idle(100);
    }
    a.busy = false;
    a.lastMs = best;
    a.lastLabel = `Grouped ${n.toLocaleString()} points into ${k} clusters`;
    updateStatus(a);
    await idle(150);
  });
  renderResults();
  const same = apps.react.fingerprint != null && apps.react.fingerprint === apps.rust.fingerprint;
  say(same
    ? `Both found the same ${k} groups. Best of ${runs} runs each, pure calculation.`
    : "The two apps found different groups, so this comparison isn’t like for like.");
});

clearBtn.onclick = () => busy(async () => {
  await forBoth(async (a) => { await request(a, { type: "clear" }); a.count = 0; a.lastMs = null; });
  APP_IDS.forEach((id) => (apps[id].resultEl.textContent = "Waiting for points."));
  loadBtn.textContent = `Load ${BATCH.toLocaleString()} points`;
  say("Both maps are empty.");
});

// -------------------------------------------------------------- rendering

/** Always seconds, so the two maps' times read side by side without unit conversion. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10 ? 3 : 2)} s`;

function renderResults() {
  const [r, s] = APP_IDS.map((id) => apps[id]);
  for (const a of [r, s]) {
    const other = a === r ? s : r;
    if (a.lastMs == null) { a.resultEl.textContent = "No answer: this map may have frozen."; continue; }
    let verdict = "";
    if (other.lastMs != null) {
      const ratio = Math.max(a.lastMs, other.lastMs) / Math.min(a.lastMs, other.lastMs);
      // Times that read the same on screen are called a tie, never a win.
      const tie = ratio < 1.05 || seconds(a.lastMs) === seconds(other.lastMs);
      verdict = tie ? ", about the same as the other" : a.lastMs < other.lastMs ? ", the faster of the two" : "";
    }
    a.resultEl.textContent = `${a.lastLabel} in ${seconds(a.lastMs)}${verdict}.`;
  }
}

function updateStatus(a: AppState) {
  const stalled = a.ready && a.lastStatsAt > 0 && performance.now() - a.lastStatsAt > STALL_MS;
  let cls = "", text = "Getting ready";
  if (!a.ready) { /* getting ready */ }
  else if (document.visibilityState !== "visible") { text = "Paused, tab in background"; }
  // A test the tester started blocks the app on purpose: say "working", not "not responding".
  else if (a.busy) { cls = "is-busy"; text = "Working…"; }
  else if (stalled) { cls = "is-frozen"; text = "Not responding"; }
  else if (a.stats && a.stats.maxFrameMs > 250) { cls = "is-frozen"; text = `Froze for ${seconds(a.stats.maxFrameMs)}`; }
  else if (a.stats && (a.stats.fps < 30 || a.stats.maxFrameMs > 50)) { cls = "is-lag"; text = "Choppy"; }
  else { cls = "is-ok"; text = "Smooth"; }
  a.statusEl.className = `status ${cls}`;
  a.statusEl.textContent = text;
}

// Watchdog: notices an app that stopped reporting (main thread blocked or crashed).
setInterval(() => APP_IDS.forEach((id) => updateStatus(apps[id])), 500);
document.addEventListener("visibilitychange", () => APP_IDS.forEach((id) => updateStatus(apps[id])));
