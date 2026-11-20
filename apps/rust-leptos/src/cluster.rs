//! CPU-heavy test: k-means clustering, written the way a Rust developer normally would
//! (a Vec of small structs). Same algorithm and same seeded random numbers as the
//! React app's src/cluster.ts, so both should produce the same clusters.

#[derive(Clone, Copy)]
pub struct Pt {
    pub lat: f64,
    pub lng: f64,
}

pub struct Cluster {
    pub lat: f64,
    pub lng: f64,
    pub count: usize,
}

/// mulberry32: tiny seeded PRNG, bit-for-bit identical to the TypeScript version.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

const CITIES: [(f64, f64); 15] = [
    (6.52, 3.38), (51.5, -0.12), (40.71, -74.0), (35.68, 139.69), (-23.55, -46.63),
    (28.61, 77.2), (-33.87, 151.2), (30.04, 31.23), (-1.29, 36.82), (48.85, 2.35),
    (19.43, -99.13), (1.35, 103.82), (55.75, 37.62), (-26.2, 28.04), (37.77, -122.42),
];

/// Points clustered around cities plus a spread of background points. Not timed.
pub fn make_points(n: usize, seed: u32) -> Vec<Pt> {
    let mut r = Rng(seed);
    let mut pts = Vec::with_capacity(n);
    for _ in 0..n {
        if r.next() < 0.7 {
            let (clat, clng) = CITIES[(r.next() * CITIES.len() as f64) as usize];
            // cheap bell curve, evaluated in the same order as the TypeScript version
            let dlat = (r.next() + r.next() + r.next() - 1.5) * 4.0;
            let dlng = (r.next() + r.next() + r.next() - 1.5) * 4.0;
            pts.push(Pt { lat: clat + dlat, lng: clng + dlng });
        } else {
            let lat = -55.0 + r.next() * 125.0;
            let lng = -170.0 + r.next() * 340.0;
            pts.push(Pt { lat, lng });
        }
    }
    pts
}

/// Lloyd's k-means with a fixed number of rounds so both apps do exactly the same work.
pub fn kmeans(pts: &[Pt], k: usize, iterations: usize) -> Vec<Cluster> {
    let step = pts.len() / k;
    let mut centers: Vec<Pt> = (0..k).map(|c| pts[c * step]).collect();
    let mut assign = vec![0usize; pts.len()];

    for _ in 0..iterations {
        for (i, p) in pts.iter().enumerate() {
            let mut best = 0;
            let mut best_d = f64::INFINITY;
            for (c, ctr) in centers.iter().enumerate() {
                let d_lat = p.lat - ctr.lat;
                let d_lng = p.lng - ctr.lng;
                let d = d_lat * d_lat + d_lng * d_lng;
                if d < best_d {
                    best_d = d;
                    best = c;
                }
            }
            assign[i] = best;
        }
        let mut sums = vec![(0.0f64, 0.0f64, 0usize); k];
        for (i, p) in pts.iter().enumerate() {
            let s = &mut sums[assign[i]];
            s.0 += p.lat;
            s.1 += p.lng;
            s.2 += 1;
        }
        for (c, s) in sums.iter().enumerate() {
            if s.2 > 0 {
                centers[c] = Pt { lat: s.0 / s.2 as f64, lng: s.1 / s.2 as f64 };
            }
        }
    }

    let mut counts = vec![0usize; k];
    for &a in &assign {
        counts[a] += 1;
    }
    centers
        .iter()
        .zip(counts)
        .map(|(c, count)| Cluster { lat: c.lat, lng: c.lng, count })
        .collect()
}
