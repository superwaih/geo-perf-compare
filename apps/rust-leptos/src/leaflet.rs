//! Minimal wasm-bindgen bindings to the global Leaflet (`L`) object.
use js_sys::{Function, Object, Reflect};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[derive(Clone)]
    pub type Map;
    #[wasm_bindgen(js_namespace = L, js_name = map)]
    pub fn map(id: &str, options: &JsValue) -> Map;
    #[wasm_bindgen(method, js_name = setView)]
    pub fn set_view(this: &Map, center: &JsValue, zoom: f64, options: &JsValue) -> Map;
    #[wasm_bindgen(method, js_name = setZoom)]
    pub fn set_zoom(this: &Map, zoom: f64) -> Map;
    #[wasm_bindgen(method, js_name = getZoom)]
    pub fn get_zoom(this: &Map) -> f64;
    #[wasm_bindgen(method, js_name = getCenter)]
    pub fn get_center(this: &Map) -> JsValue;
    #[wasm_bindgen(method, js_name = panBy)]
    pub fn pan_by(this: &Map, offset: &JsValue, options: &JsValue) -> Map;
    #[wasm_bindgen(method)]
    pub fn on(this: &Map, event: &str, callback: &Function) -> Map;

    #[derive(Clone)]
    pub type Layer;
    #[wasm_bindgen(method, js_name = addTo)]
    pub fn add_to(this: &Layer, map: &Map) -> Layer;
    #[wasm_bindgen(method)]
    pub fn remove(this: &Layer) -> Layer;
    #[wasm_bindgen(method, js_name = bindTooltip)]
    pub fn bind_tooltip(this: &Layer, content: &str) -> Layer;

    #[derive(Clone)]
    #[wasm_bindgen(extends = Layer)]
    pub type LayerGroup;
    #[wasm_bindgen(js_namespace = L, js_name = layerGroup)]
    pub fn layer_group() -> LayerGroup;
    #[wasm_bindgen(method, js_name = addLayer)]
    pub fn add_layer(this: &LayerGroup, layer: &Layer) -> LayerGroup;
    #[wasm_bindgen(method, js_name = clearLayers)]
    pub fn clear_layers(this: &LayerGroup) -> LayerGroup;

    #[wasm_bindgen(js_namespace = L, js_name = tileLayer)]
    pub fn tile_layer(url: &str, options: &JsValue) -> Layer;
    #[wasm_bindgen(js_namespace = L, js_name = latLng)]
    pub fn lat_lng(lat: f64, lng: f64) -> JsValue;
    #[wasm_bindgen(js_namespace = L, js_name = circleMarker)]
    pub fn circle_marker(latlng: &JsValue, options: &JsValue) -> Layer;
    #[wasm_bindgen(js_namespace = L)]
    pub fn svg() -> JsValue;
    #[wasm_bindgen(js_namespace = L)]
    pub fn canvas(options: &JsValue) -> JsValue;
}

/// Build a plain JS object from key/value pairs.
pub fn obj(pairs: &[(&str, JsValue)]) -> JsValue {
    let o = Object::new();
    for (k, v) in pairs {
        let _ = Reflect::set(&o, &JsValue::from_str(k), v);
    }
    o.into()
}

pub fn get(target: &JsValue, key: &str) -> JsValue {
    Reflect::get(target, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}
