//! Frame-time monitor: detects lag (janky frames) and breaks (freezes) via
//! requestAnimationFrame and the Long Tasks API. Same thresholds as the React app.
use serde::Serialize;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

pub const JANK_MS: f64 = 50.0;
pub const FREEZE_MS: f64 = 250.0;

pub fn now() -> f64 {
    web_sys::window().unwrap().performance().unwrap().now()
}

fn raf(cb: &Closure<dyn FnMut(f64)>) {
    let _ = web_sys::window()
        .unwrap()
        .request_animation_frame(cb.as_ref().unchecked_ref());
}

/// Calls `f(timestamp)` on every animation frame while it returns `true`.
pub fn raf_loop(mut f: impl FnMut(f64) -> bool + 'static) {
    let cell: Rc<RefCell<Option<Closure<dyn FnMut(f64)>>>> = Rc::new(RefCell::new(None));
    let inner = cell.clone();
    *cell.borrow_mut() = Some(Closure::new(move |ts: f64| {
        if f(ts) {
            raf(inner.borrow().as_ref().unwrap());
        }
    }));
    raf(cell.borrow().as_ref().unwrap());
}

/// Runs `cb(now)` once the browser has painted the current DOM changes.
pub fn after_paint(cb: impl FnOnce(f64) + 'static) {
    let inner = Closure::once_into_js(move || cb(now()));
    let outer = Closure::once_into_js(move |_ts: f64| {
        let _ = web_sys::window()
            .unwrap()
            .set_timeout_with_callback_and_timeout_and_arguments_0(inner.unchecked_ref(), 0);
    });
    let _ = web_sys::window()
        .unwrap()
        .request_animation_frame(outer.unchecked_ref());
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub fps: f64,
    pub max_frame_ms: f64,
    pub jank_frames: u32,
    pub freezes: u32,
    pub long_tasks: u32,
    pub long_task_ms: f64,
    #[serde(rename = "jsHeapMB")]
    pub js_heap_mb: Option<f64>,
    #[serde(rename = "wasmMemMB")]
    pub wasm_mem_mb: Option<f64>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StressResult {
    pub duration_ms: f64,
    pub frames: usize,
    pub avg_fps: f64,
    pub p95_frame_ms: f64,
    pub max_frame_ms: f64,
    pub jank_frames: usize,
    pub freezes: usize,
}

#[derive(Default)]
struct Monitor {
    last: f64,
    window: Vec<f64>,
    window_start: f64,
    recording: Option<Vec<f64>>,
    jank: u32,
    freezes: u32,
    long_tasks: u32,
    long_task_ms: f64,
}

thread_local! {
    static MON: RefCell<Monitor> = RefCell::new(Monitor::default());
}

fn memory_mb() -> (Option<f64>, Option<f64>) {
    let perf: JsValue = web_sys::window().unwrap().performance().unwrap().into();
    let mem = crate::leaflet::get(&perf, "memory");
    let js = if mem.is_undefined() {
        None
    } else {
        crate::leaflet::get(&mem, "usedJSHeapSize").as_f64().map(|b| b / 1048576.0)
    };
    let buf = crate::leaflet::get(&wasm_bindgen::memory(), "buffer");
    let wasm = crate::leaflet::get(&buf, "byteLength").as_f64().map(|b| b / 1048576.0);
    (js, wasm)
}

fn is_visible() -> bool {
    let doc = crate::leaflet::get(&web_sys::window().unwrap().into(), "document");
    crate::leaflet::get(&doc, "visibilityState").as_string().as_deref() == Some("visible")
}

pub fn start(mut on_stats: impl FnMut(Stats) + 'static) {
    // Long Tasks API (main-thread tasks > 50 ms).
    let cb = Closure::<dyn FnMut(web_sys::PerformanceObserverEntryList)>::new(
        |list: web_sys::PerformanceObserverEntryList| {
            let entries = list.get_entries();
            MON.with_borrow_mut(|m| {
                for e in entries.iter() {
                    m.long_tasks += 1;
                    m.long_task_ms += crate::leaflet::get(&e, "duration").as_f64().unwrap_or(0.0);
                }
            });
        },
    );
    if let Ok(obs) = web_sys::PerformanceObserver::new(cb.as_ref().unchecked_ref()) {
        let init = js_sys::Object::new();
        let _ = js_sys::Reflect::set(
            &init,
            &"entryTypes".into(),
            &js_sys::Array::of1(&"longtask".into()),
        );
        let _ = obs.observe(init.unchecked_ref());
    }
    cb.forget();

    raf_loop(move |ts| {
        // Background tabs are throttled by the browser; those frames say nothing about the app.
        if !is_visible() {
            MON.with_borrow_mut(|m| {
                m.last = 0.0;
                m.window.clear();
            });
            return true;
        }
        let report = MON.with_borrow_mut(|m| {
            if m.last > 0.0 {
                let dt = ts - m.last;
                m.window.push(dt);
                if let Some(r) = m.recording.as_mut() {
                    r.push(dt);
                }
                if dt > FREEZE_MS {
                    m.freezes += 1;
                } else if dt > JANK_MS {
                    m.jank += 1;
                }
            } else {
                m.window_start = ts;
            }
            m.last = ts;
            if ts - m.window_start >= 500.0 {
                let elapsed = ts - m.window_start;
                let (js_heap_mb, wasm_mem_mb) = memory_mb();
                let s = Stats {
                    fps: m.window.len() as f64 * 1000.0 / elapsed,
                    max_frame_ms: m.window.iter().cloned().fold(0.0, f64::max),
                    jank_frames: m.jank,
                    freezes: m.freezes,
                    long_tasks: m.long_tasks,
                    long_task_ms: m.long_task_ms,
                    js_heap_mb,
                    wasm_mem_mb,
                };
                m.window.clear();
                m.window_start = ts;
                Some(s)
            } else {
                None
            }
        });
        if let Some(s) = report {
            on_stats(s);
        }
        true
    });
}

pub fn begin_recording() {
    MON.with_borrow_mut(|m| m.recording = Some(Vec::new()));
}

pub fn end_recording(duration_ms: f64) -> StressResult {
    let mut f = MON.with_borrow_mut(|m| m.recording.take()).unwrap_or_default();
    let frames = f.len();
    let jank_frames = f.iter().filter(|&&d| d > JANK_MS && d <= FREEZE_MS).count();
    let freezes = f.iter().filter(|&&d| d > FREEZE_MS).count();
    f.sort_by(|a, b| a.partial_cmp(b).unwrap());
    StressResult {
        duration_ms,
        frames,
        avg_fps: frames as f64 * 1000.0 / duration_ms,
        p95_frame_ms: f.get((frames as f64 * 0.95) as usize).copied().unwrap_or(0.0),
        max_frame_ms: f.last().copied().unwrap_or(0.0),
        jank_frames,
        freezes,
    }
}
