//! Rust + Leptos (CSR, WebAssembly) map app.
//!
//! Mirrors the React app: point state lives in a Leptos signal and an effect syncs
//! it to the same Leaflet engine. GeoJSON parsing happens in Rust (serde_json).
mod cluster;
mod leaflet;
mod perf;

use leaflet as l;
use leptos::prelude::*;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

const APP: &str = "rust";
const COLORS: [&str; 5] = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed"];

// ---------- data -------------------------------------------------------------

#[derive(Clone, Copy)]
struct Point {
    lat: f64,
    lng: f64,
    category: u32,
}

#[derive(Clone, Default)]
struct Points {
    list: Vec<Point>,
    /// Bumped whenever the map must be fully re-rendered (replace / clear / renderer change).
    version: u32,
}

#[derive(Deserialize)]
struct FeatureCollection {
    features: Vec<Feature>,
}
#[derive(Deserialize)]
struct Feature {
    geometry: Geometry,
    #[serde(default)]
    properties: Option<Properties>,
}
#[derive(Deserialize)]
struct Geometry {
    coordinates: (f64, f64),
}
#[derive(Deserialize)]
struct Properties {
    #[serde(default)]
    category: u32,
}

// ---------- protocol (see README) ---------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Command {
    #[serde(rename_all = "camelCase")]
    Load { run_id: f64, mode: String, geojson: String },
    #[serde(rename_all = "camelCase")]
    Clear { run_id: f64 },
    #[serde(rename_all = "camelCase")]
    SetRenderer { run_id: f64, renderer: String },
    SetTiles { enabled: bool },
    #[serde(rename_all = "camelCase")]
    Stress { run_id: f64, duration_ms: f64 },
    #[serde(rename_all = "camelCase")]
    Cluster { run_id: f64, n: usize, k: usize, iterations: usize, seed: u32 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Loaded {
    r#type: &'static str,
    run_id: f64,
    count: usize,
    added: usize,
    parse_ms: f64,
    render_ms: f64,
    total_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WithCount<T: Serialize> {
    r#type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<f64>,
    count: usize,
    #[serde(flatten)]
    data: T,
}

fn is_embedded() -> bool {
    let w = web_sys::window().unwrap();
    match w.parent() {
        Ok(Some(p)) => JsValue::from(p) != JsValue::from(w),
        _ => false,
    }
}

fn post<T: Serialize>(msg: &T) {
    if !is_embedded() {
        return;
    }
    let parent = web_sys::window().unwrap().parent().unwrap().unwrap();
    let json = serde_json::to_string(msg).unwrap();
    let v = js_sys::JSON::parse(&json).unwrap();
    let _ = js_sys::Reflect::set(&v, &"app".into(), &APP.into());
    let _ = parent.post_message(&v, "*");
}

// ---------- engine state (non-Send JS handles live outside the reactive graph) ---

struct Engine {
    map: l::Map,
    group: l::LayerGroup,
    tiles: l::Layer,
    /// Results of the clustering test.
    clusters: l::LayerGroup,
    styles: Vec<JsValue>,
    rendered: usize,
    last_version: u32,
}

struct Pending {
    run_id: f64,
    t0: f64,
    parse_ms: f64,
    added: usize,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static PENDING: RefCell<Option<Pending>> = const { RefCell::new(None) };
}

fn build_styles(renderer: &JsValue) -> Vec<JsValue> {
    COLORS
        .iter()
        .map(|c| {
            l::obj(&[
                ("renderer", renderer.clone()),
                ("radius", 4.into()),
                ("weight", 1.into()),
                ("color", "#0f172a".into()),
                ("fillColor", (*c).into()),
                ("fillOpacity", 0.75.into()),
            ])
        })
        .collect()
}

fn no_anim() -> JsValue {
    l::obj(&[("animate", false.into())])
}

#[derive(Clone, Copy)]
struct Ctx {
    points: RwSignal<Points>,
    stats: RwSignal<Option<perf::Stats>>,
    last: RwSignal<Option<(f64, f64, f64)>>,
}

impl Ctx {
    fn count(&self) -> usize {
        ENGINE.with_borrow(|e| e.as_ref().map(|e| e.rendered).unwrap_or(0))
    }
}

fn init_engine(ctx: Ctx) {
    let map = l::map("map", &l::obj(&[("worldCopyJump", true.into())]));
    map.set_view(&l::lat_lng(20.0, 10.0), 2.0, &JsValue::UNDEFINED);
    let tiles = l::tile_layer(
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        &l::obj(&[
            ("maxZoom", 19.into()),
            ("attribution", "&copy; OpenStreetMap contributors".into()),
        ]),
    );
    tiles.add_to(&map);
    let group = l::layer_group();
    group.add_to(&map);
    let clusters = l::layer_group();
    clusters.add_to(&map);

    // Click to add a point.
    let on_click = Closure::<dyn FnMut(JsValue)>::new(move |e: JsValue| {
        let ll = l::get(&e, "latlng");
        let lat = l::get(&ll, "lat").as_f64().unwrap_or(0.0);
        let lng = l::get(&ll, "lng").as_f64().unwrap_or(0.0);
        PENDING.set(Some(Pending { run_id: -1.0, t0: perf::now(), parse_ms: 0.0, added: 1 }));
        ctx.points.update(|p| p.list.push(Point { lat, lng, category: 3 }));
    });
    map.on("click", on_click.as_ref().unchecked_ref());
    on_click.forget();

    ENGINE.set(Some(Engine {
        map,
        group,
        tiles,
        clusters,
        styles: build_styles(&l::svg()),
        rendered: 0,
        last_version: 0,
    }));

    perf::start(move |s| {
        ctx.stats.set(Some(s));
        post(&WithCount { r#type: "stats", run_id: None, count: ctx.count(), data: s });
    });

    // Commands from the dashboard.
    let on_msg = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
        let t0 = perf::now();
        let parent: JsValue = web_sys::window().unwrap().parent().ok().flatten().into();
        if e.source().map(JsValue::from) != Some(parent) {
            return;
        }
        // Includes copying the GeoJSON string from JS into WASM memory (UTF-16 -> UTF-8).
        if let Ok(cmd) = serde_wasm_bindgen::from_value::<Command>(e.data()) {
            handle(cmd, t0, ctx);
        }
    });
    let _ = web_sys::window()
        .unwrap()
        .add_event_listener_with_callback("message", on_msg.as_ref().unchecked_ref());
    on_msg.forget();

    if is_embedded() {
        post(&serde_json::json!({ "type": "ready" }));
    } else {
        wasm_bindgen_futures::spawn_local(async move {
            let w = web_sys::window().unwrap();
            let resp: web_sys::Response =
                wasm_bindgen_futures::JsFuture::from(w.fetch_with_str("points-2000.geojson"))
                    .await
                    .unwrap()
                    .unchecked_into();
            let text = wasm_bindgen_futures::JsFuture::from(resp.text().unwrap())
                .await
                .unwrap()
                .as_string()
                .unwrap_or_default();
            handle(
                Command::Load { run_id: 0.0, mode: "replace".into(), geojson: text },
                perf::now(),
                ctx,
            );
        });
    }
}

fn handle(cmd: Command, t0: f64, ctx: Ctx) {
    match cmd {
        Command::Load { run_id, mode, geojson } => {
            let parsed: Vec<Point> = match serde_json::from_str::<FeatureCollection>(&geojson) {
                Ok(fc) => fc
                    .features
                    .into_iter()
                    .map(|f| Point {
                        lng: f.geometry.coordinates.0,
                        lat: f.geometry.coordinates.1,
                        category: f.properties.map(|p| p.category).unwrap_or(0),
                    })
                    .collect(),
                Err(err) => {
                    web_sys::console::error_1(&format!("bad geojson: {err}").into());
                    return;
                }
            };
            let parse_ms = perf::now() - t0;
            PENDING.set(Some(Pending { run_id, t0, parse_ms, added: parsed.len() }));
            ctx.points.update(|p| {
                if mode == "append" {
                    p.list.extend(parsed);
                } else {
                    p.list = parsed;
                    p.version += 1;
                }
            });
        }
        Command::Clear { run_id } => {
            ENGINE.with_borrow(|e| {
                if let Some(e) = e.as_ref() {
                    e.clusters.clear_layers();
                }
            });
            PENDING.set(Some(Pending { run_id, t0, parse_ms: 0.0, added: 0 }));
            ctx.points.update(|p| {
                p.list.clear();
                p.version += 1;
            });
        }
        Command::SetRenderer { run_id, renderer } => {
            let r = if renderer == "canvas" {
                l::canvas(&l::obj(&[("padding", 0.5.into())]))
            } else {
                l::svg()
            };
            ENGINE.with_borrow_mut(|e| {
                if let Some(e) = e.as_mut() {
                    e.styles = build_styles(&r);
                }
            });
            PENDING.set(Some(Pending { run_id, t0, parse_ms: 0.0, added: 0 }));
            ctx.points.update(|p| p.version += 1);
        }
        Command::SetTiles { enabled } => ENGINE.with_borrow(|e| {
            if let Some(e) = e.as_ref() {
                if enabled {
                    e.tiles.add_to(&e.map);
                } else {
                    e.tiles.remove();
                }
            }
        }),
        Command::Cluster { run_id, n, k, iterations, seed } => {
            let pts = cluster::make_points(n, seed); // not timed
            let t0 = perf::now();
            let result = cluster::kmeans(&pts, k, iterations);
            let ms = perf::now() - t0;
            draw_clusters(&result);
            // fingerprint: identical in both apps when they found the same groups
            let fingerprint: usize = result.iter().enumerate().map(|(i, c)| (i + 1) * c.count).sum();
            post(&serde_json::json!({ "type": "clustered", "runId": run_id, "ms": ms, "n": n, "k": k, "fingerprint": fingerprint }));
        }
        Command::Stress { run_id, duration_ms } => {
            stress(duration_ms, move |r| {
                post(&WithCount { r#type: "stressResult", run_id: Some(run_id), count: ctx.count(), data: r });
            });
        }
    }
}

/// One bubble per cluster, sized by how many points it holds.
fn draw_clusters(result: &[cluster::Cluster]) {
    ENGINE.with_borrow(|e| {
        let Some(e) = e.as_ref() else { return };
        e.clusters.clear_layers();
        let max = result.iter().map(|c| c.count).max().unwrap_or(1).max(1) as f64;
        for c in result {
            let opts = l::obj(&[
                ("radius", (6.0 + 22.0 * (c.count as f64 / max).sqrt()).into()),
                ("weight", 1.5.into()),
                ("color", "#0f172a".into()),
                ("fillColor", "#0f172a".into()),
                ("fillOpacity", 0.35.into()),
            ]);
            let marker = l::circle_marker(&l::lat_lng(c.lat, c.lng), &opts);
            marker.bind_tooltip(&format!("{} points", c.count));
            e.clusters.add_layer(&marker);
        }
    });
}

/// Continuous pan + periodic zoom for `duration_ms`, recording every frame time.
fn stress(duration_ms: f64, done: impl FnOnce(perf::StressResult) + 'static) {
    let Some(map) = ENGINE.with_borrow(|e| e.as_ref().map(|e| e.map.clone())) else { return };
    let center = map.get_center();
    let zoom = map.get_zoom();
    perf::begin_recording();
    let start = perf::now();
    let mut last_zoom = start;
    let mut zoom_in = true;
    let mut done = Some(done);
    perf::raf_loop(move |ts| {
        let t = ts - start;
        if t >= duration_ms {
            let r = perf::end_recording(t);
            map.set_view(&center, zoom, &no_anim());
            if let Some(d) = done.take() {
                d(r);
            }
            return false;
        }
        let offset = js_sys::Array::of2(&((t / 600.0).cos() * 6.0).into(), &((t / 600.0).sin() * 6.0).into());
        map.pan_by(&offset, &no_anim());
        if ts - last_zoom > 700.0 {
            map.set_zoom(map.get_zoom() + if zoom_in { 1.0 } else { -1.0 });
            zoom_in = !zoom_in;
            last_zoom = ts;
        }
        true
    });
}

fn add_random(ctx: Ctx, n: usize) {
    let t0 = perf::now();
    let mut s = String::from("{\"features\":[");
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        let lng = -170.0 + js_sys::Math::random() * 340.0;
        let lat = -55.0 + js_sys::Math::random() * 125.0;
        s.push_str(&format!(
            "{{\"geometry\":{{\"coordinates\":[{lng},{lat}]}},\"properties\":{{\"category\":{}}}}}",
            i % 5
        ));
    }
    s.push_str("]}");
    handle(Command::Load { run_id: -1.0, mode: "append".into(), geojson: s }, t0, ctx);
}

// ---------- UI -----------------------------------------------------------------

#[component]
fn App() -> impl IntoView {
    let ctx = Ctx {
        points: RwSignal::new(Points::default()),
        stats: RwSignal::new(None),
        last: RwSignal::new(None),
    };

    // Create the Leaflet map once the #map div is in the DOM.
    Effect::new(move |_| {
        if ENGINE.with_borrow(|e| e.is_none()) {
            init_engine(ctx);
        }
    });

    // Sync signal state -> Leaflet (equivalent of the React useEffect).
    Effect::new(move |_| {
        ctx.points.with(|p| {
            let synced = ENGINE.with_borrow_mut(|eng| {
                let Some(e) = eng.as_mut() else { return false };
                if p.version != e.last_version {
                    e.group.clear_layers();
                    e.rendered = 0;
                    e.last_version = p.version;
                }
                for pt in &p.list[e.rendered.min(p.list.len())..] {
                    let marker = l::circle_marker(
                        &l::lat_lng(pt.lat, pt.lng),
                        &e.styles[(pt.category % 5) as usize],
                    );
                    e.group.add_layer(&marker);
                }
                e.rendered = p.list.len();
                true
            });
            if !synced {
                return;
            }
            let count = p.list.len();
            if let Some(job) = PENDING.take() {
                perf::after_paint(move |t_end| {
                    let total_ms = t_end - job.t0;
                    let render_ms = total_ms - job.parse_ms;
                    ctx.last.set(Some((job.parse_ms, render_ms, total_ms)));
                    post(&Loaded {
                        r#type: "loaded",
                        run_id: job.run_id,
                        count,
                        added: job.added,
                        parse_ms: job.parse_ms,
                        render_ms,
                        total_ms,
                    });
                });
            }
        });
    });

    let count = Memo::new(move |_| ctx.points.with(|p| p.list.len()));
    let embedded = is_embedded();

    view! {
        <div id="map"></div>
        <div class="badge">"Rust + Leptos (WASM)"</div>
        <div class="hud">
            <div>"points " <b>{move || count.get().to_string()}</b></div>
            {move || ctx.stats.get().map(|s| view! {
                <div>
                    "fps " <b class={if s.fps < 30.0 { "bad" } else { "" }}>{format!("{:.0}", s.fps)}</b>
                    " · max frame " <b class={if s.max_frame_ms > 50.0 { "bad" } else { "" }}>{format!("{:.0}ms", s.max_frame_ms)}</b>
                </div>
                <div>
                    "jank " <b>{s.jank_frames}</b>
                    " · freezes " <b class={if s.freezes > 0 { "bad" } else { "" }}>{s.freezes}</b>
                </div>
            })}
            {move || ctx.last.get().map(|(parse, _render, total)| view! {
                <div>"last load " <b>{format!("{total:.0}ms")}</b>{format!(" (parse {parse:.1})")}</div>
            })}
            {(!embedded).then(|| view! {
                <div>
                    <button on:click=move |_| add_random(ctx, 1000)>"+1000"</button>
                    <button on:click=move |_| stress(4000.0, |r| {
                        let _ = web_sys::window().unwrap().alert_with_message(&format!("{r:#?}"));
                    })>"stress"</button>
                </div>
            })}
        </div>
    }
}

fn main() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(App);
}
