// CPU-heavy test: k-means clustering, written the way a TypeScript developer normally would
// (arrays of plain objects). The Rust app runs the exact same algorithm in src/cluster.rs,
// with the same seeded random numbers, so both should produce the same clusters.

export interface Pt { lat: number; lng: number }
export interface Cluster { lat: number; lng: number; count: number }

/** mulberry32: tiny seeded PRNG, bit-for-bit identical to the Rust version. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES: [number, number][] = [
  [6.52, 3.38], [51.5, -0.12], [40.71, -74.0], [35.68, 139.69], [-23.55, -46.63],
  [28.61, 77.2], [-33.87, 151.2], [30.04, 31.23], [-1.29, 36.82], [48.85, 2.35],
  [19.43, -99.13], [1.35, 103.82], [55.75, 37.62], [-26.2, 28.04], [37.77, -122.42],
];

/** Points clustered around cities plus a spread of background points. Not timed. */
export function makePoints(n: number, seed: number): Pt[] {
  const r = rng(seed);
  const spread = () => (r() + r() + r() - 1.5) * 4; // cheap bell curve, no Math.log/cos
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.7) {
      const c = CITIES[Math.floor(r() * CITIES.length)];
      pts.push({ lat: c[0] + spread(), lng: c[1] + spread() });
    } else {
      pts.push({ lat: -55 + r() * 125, lng: -170 + r() * 340 });
    }
  }
  return pts;
}

/** Lloyd's k-means with a fixed number of rounds so both apps do exactly the same work. */
export function kmeans(pts: Pt[], k: number, iterations: number): Cluster[] {
  const step = Math.floor(pts.length / k);
  const centers: Pt[] = [];
  for (let c = 0; c < k; c++) centers.push({ ...pts[c * step] });
  const assign: number[] = new Array(pts.length).fill(0);

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dLat = p.lat - centers[c].lat;
        const dLng = p.lng - centers[c].lng;
        const d = dLat * dLat + dLng * dLng;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => ({ lat: 0, lng: 0, count: 0 }));
    for (let i = 0; i < pts.length; i++) {
      const s = sums[assign[i]];
      s.lat += pts[i].lat; s.lng += pts[i].lng; s.count++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c].count > 0) centers[c] = { lat: sums[c].lat / sums[c].count, lng: sums[c].lng / sums[c].count };
    }
  }

  const counts: number[] = new Array(k).fill(0);
  for (const a of assign) counts[a]++;
  return centers.map((c, i) => ({ lat: c.lat, lng: c.lng, count: counts[i] }));
}
