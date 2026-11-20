import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import App from "./App";

// No <StrictMode>: it double-invokes effects in dev, which would distort timings.
createRoot(document.getElementById("root")!).render(<App />);
