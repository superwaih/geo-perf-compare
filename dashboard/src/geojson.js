// Deterministic GeoJSON point generator shared by the dashboard (browser) and scripts (Node).

/** mulberry32 seeded PRNG */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = [
  [6.52, 3.38], [51.5, -0.12], [40.71, -74.0], [35.68, 139.69], [-23.55, -46.63],
  [28.61, 77.2], [-33.87, 151.2], [30.04, 31.23], [-1.29, 36.82], [48.85, 2.35],
  [19.43, -99.13], [1.35, 103.82], [55.75, 37.62], [-26.2, 28.04], [37.77, -122.42],
];
const CATEGORIES = ["sensor", "store", "vehicle", "incident", "asset"];

/**
 * @param {number} n number of points
 * @param {number} seed PRNG seed (same seed => identical data in both apps)
 * @param {number} idOffset first feature id
 */
export function generatePoints(n, seed = 42, idOffset = 0) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    let lat, lng;
    if (r() < 0.7) {
      const [clat, clng] = CITIES[Math.floor(r() * CITIES.length)];
      lat = clat + gauss() * 1.5;
      lng = clng + gauss() * 1.5;
    } else {
      lat = -55 + r() * 125;
      lng = -170 + r() * 340;
    }
    const cat = Math.floor(r() * CATEGORIES.length);
    features[i] = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [+lng.toFixed(5), +Math.max(-85, Math.min(85, lat)).toFixed(5)] },
      properties: {
        id: idOffset + i,
        name: `${CATEGORIES[cat]}-${idOffset + i}`,
        category: cat,
        value: Math.round(r() * 1000),
      },
    };
  }
  return { type: "FeatureCollection", features };
}
