// Builds all three projects into one static site in ./dist, ready for Vercel (or any static host):
//   dist/          dashboard
//   dist/react/    React + Vite app
//   dist/rust/     Rust + Leptos (WASM) app
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function run(label, cmd, cwd) {
  console.log(`\n▶ ${label}\n  ${cmd}`);
  const r = spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n✖ ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(join(root, "dashboard/public/points-2000.geojson"))) {
  run("Generate GeoJSON datasets", "node scripts/generate-geojson.mjs", root);
}

// Dashboard first: it empties dist/.
run("Dashboard", `npx vite build --outDir "${dist}" --emptyOutDir`, join(root, "dashboard"));
run(
  "React + Vite app",
  `npx vite build --base /react/ --outDir "${join(dist, "react")}" --emptyOutDir`,
  join(root, "apps/react-vite"),
);
run(
  "Rust + Leptos app (release WASM)",
  `trunk build --release --public-url /rust/ --dist "${join(dist, "rust")}"`,
  join(root, "apps/rust-leptos"),
);

// Static-site config for Vercel: long cache for hashed assets, correct WASM type.
writeFileSync(
  join(dist, "vercel.json"),
  JSON.stringify(
    {
      headers: [
        {
          source: "/(react/assets|rust)/(.*)\\.(js|css|wasm)",
          headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
        },
        { source: "/(.*)\\.wasm", headers: [{ key: "Content-Type", value: "application/wasm" }] },
      ],
    },
    null,
    2,
  ),
);

console.log(`\n✔ Site ready in ${dist}\n  Preview:  npm run preview:site\n  Deploy:   npm run deploy:vercel`);
