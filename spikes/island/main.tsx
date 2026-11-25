import { createRoot } from "react-dom/client";
import { IslandSpike } from "./IslandSpike";
import "./motion.css";
import "./spike.css";

if (new URLSearchParams(location.search).has("preview"))
  document.documentElement.dataset.preview = "";
createRoot(document.getElementById("spike-root")!).render(<IslandSpike />);
