// Generates deterministic GeoJSON point datasets used by both apps in standalone mode.
// The dashboard generates the same data in-browser (same PRNG + seed) for side-by-side runs.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePoints } from "../dashboard/src/geojson.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = (process.argv[2] ?? "2000,10000").split(",").map(Number);
const targets = ["apps/react-vite/public", "apps/rust-leptos/public", "dashboard/public"];

for (const n of sizes) {
  const json = JSON.stringify(generatePoints(n, 42));
  for (const t of targets) {
    const dir = join(root, t);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `points-${n}.geojson`), json);
  }
  console.log(`points-${n}.geojson  (${(json.length / 1024).toFixed(0)} KB)`);
}
