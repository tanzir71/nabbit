import { createRoot } from "react-dom/client";
import { IslandSpike } from "./IslandSpike";
import "./motion.css";
import "./spike.css";
import "../../src/styles/tokens.css";

document.documentElement.dataset.theme = "dark";

if (new URLSearchParams(location.search).has("preview"))
  document.documentElement.dataset.preview = "";
if (window.__NABBIT_NATIVE_COMPACT__) document.documentElement.dataset.nativeWaiting = "true";
createRoot(document.getElementById("spike-root")!).render(<IslandSpike />);
