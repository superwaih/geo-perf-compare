# GeoPerf — React + Vite vs Rust (Leptos/WASM)

A side-by-side performance lab for two frontend stacks rendering the same GeoJSON points on the same map.

```
geo-perf-compare/
├── dashboard/            Comparison UI (Vite, vanilla TS) — http://localhost:5173
│   └── src/geojson.js    Deterministic point generator (seeded, shared with scripts/)
├── apps/
│   ├── react-vite/       React 18 + Vite + Leaflet  — http://localhost:5174
│   └── rust-leptos/      Rust + Leptos 0.7 (CSR, WASM) + Leaflet via wasm-bindgen — http://localhost:5175
└── scripts/generate-geojson.mjs   Writes points-2000 / points-10000 .geojson into each app
```

## What you can do

- **Load 2,000 GeoJSON points** (or any number) into both apps and compare parse, render and total time.
- **Add more points** to both maps (`Add to both`), or click on either map to add a point by hand.
- **See lag and breaks** live: FPS sparkline, worst frame, jank frames (>50 ms), freezes (>250 ms),
  Long Tasks API, and a watchdog that flags *not responding* when an app stops reporting for 1.5 s.
- **Stress test** (continuous pan + zoom) to measure FPS while interacting with the loaded points.
- **Run a suite** (2k → 5k → 10k → 20k by default), then export everything as CSV.
- Switch **SVG (one DOM node per point) vs Canvas** markers, and turn map tiles off to remove network noise.

## Requirements

- Node 18+
- Rust (stable) with the wasm target and Trunk:

  ```bash
  rustup target add wasm32-unknown-unknown
  ```
  ```bash
  cargo install trunk --version 0.21.14 --locked
  ```
  (Trunk 0.22+ needs a newer rustc than 1.91. Use the latest Trunk if your Rust is up to date.)

## Run

```bash
npm run setup
```
```bash
npm start
```

Open http://localhost:5173. `npm start` serves **production builds** of both apps (React `vite build` +
`vite preview`, Rust `trunk serve --release`), which is what you should benchmark. `npm run dev` gives
hot-reload dev builds — fine for hacking, misleading for numbers.

Each app also works on its own (open :5174 or :5175 directly): it auto-loads `points-2000.geojson`
and shows `+1000` and `stress` buttons.

> **Windows PowerShell:** if `npm` says "running scripts is disabled", use `npm.cmd` (e.g. `npm.cmd start`).

## Deploy to Vercel

Everything is static, so the whole thing deploys as **one Vercel site**:

```
your-site.vercel.app/         → the comparison dashboard
your-site.vercel.app/react/   → React + Vite app
your-site.vercel.app/rust/    → Rust + Leptos app
```

1. Build everything into `dist/` (React with base `/react/`, Rust with public URL `/rust/`, plus a `vercel.json`):

   ```bash
   npm run build:site
   ```
2. Check it locally at http://localhost:4173:

   ```bash
   npm run preview:site
   ```
3. Deploy the prebuilt folder (the first run asks you to log in and name the project):

   ```bash
   npx vercel@latest deploy dist --prod
   ```
   or both steps at once: `npm run deploy:vercel`.

Build on your machine (or in CI), not on Vercel: Vercel's build image has no Rust/WASM toolchain or Trunk.
Before sharing widely, swap the OpenStreetMap tiles for a provider with a free tier (MapTiler, Stadia):
OSM's tile policy doesn't allow heavy public traffic.

> **Windows:** if Cargo fails with `LNK1104: cannot open file … build_script_build-….exe`, the project path is
> too long (260-char limit). Move the project to a shorter path or set `CARGO_TARGET_DIR=C:\t\geoperf`.

## How the comparison is kept fair

Both apps use **the same map engine (Leaflet 1.9.4)**, the same marker style, the same frame-monitor
thresholds, and receive **the exact same GeoJSON string** from the dashboard. What differs is the
framework layer — which is the thing being measured:

| Stage | React + Vite | Rust + Leptos |
|---|---|---|
| Parse | `JSON.parse` (native, in V8) | JS string → WASM memory copy + `serde_json` |
| State | `useState` array | `RwSignal<Vec<Point>>` |
| Sync to map | `useEffect` adds new markers | `Effect` adds new markers via wasm-bindgen calls |
| Timing | `parse` = message received → parsed; `render` = parsed → next paint; `total` = both | same |

**Sequential mode (default)** runs one app at a time, alternating which goes first, because both
iframes usually share one browser renderer process and would otherwise compete for the main thread.
Uncheck it to watch them under load *simultaneously* (useful for seeing lag, not for numbers).

What to expect: rendering cost is dominated by Leaflet/DOM work, which is identical JS in both apps,
so differences come mostly from parsing and the JS↔WASM boundary. Don't be surprised if React matches or
beats Rust here — `JSON.parse` is extremely fast and WASM pays a cost to copy strings across. Rust/WASM
pulls ahead on CPU-heavy work done *inside* WASM (clustering, spatial indexing, geometry math).

## The two tests

- **Load 2,000 points** measures drawing: the browser and Leaflet do most of the work, identically in both apps, and Rust pays to copy the GeoJSON into WebAssembly and to call Leaflet across the JS↔WASM boundary. React usually matches or beats Rust here.
- **Group 100,000 points** measures pure calculation: each app generates the same 100,000 points from one seed (not timed), then runs k-means (50 clusters, 15 rounds, about 75 million distance checks) in its own language, and draws the 50 clusters as bubbles. Only the clustering is timed, best of 3 runs. Both apps return a fingerprint of their result, and the dashboard confirms they found the same groups. This is where Rust/WebAssembly pulls ahead (about 2× in our runs).

The code is `apps/react-vite/src/cluster.ts` and `apps/rust-leptos/src/cluster.rs`, written the normal way in each language.

## Message protocol (dashboard ⇄ apps, `postMessage`)

Dashboard → app: `load {runId, mode: "replace"|"append", geojson}`, `clear {runId}`,
`setRenderer {runId, renderer: "svg"|"canvas"}`, `setTiles {enabled}`, `stress {runId, durationMs}`.

App → dashboard (all include `app: "react"|"rust"`): `ready`, `stats {fps, maxFrameMs, jankFrames, freezes,
longTasks, longTaskMs, jsHeapMB, wasmMemMB, count}` every 500 ms, `loaded {runId, count, added, parseMs,
renderMs, totalMs}`, `stressResult {runId, count, durationMs, frames, avgFps, p95FrameMs, maxFrameMs,
jankFrames, freezes}`.

Override app URLs with `?react=…&rust=…` on the dashboard URL (e.g. to point at deployed builds).
