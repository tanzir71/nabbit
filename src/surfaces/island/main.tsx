import React from "react";
import { createRoot } from "react-dom/client";
import { IdleIsland } from "./IdleIsland";
import "./island.css";

// The native compact renderer remains selected. V2 will mount the larger web
// surfaces here; no activity services or module bodies run from this entry.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IdleIsland />
  </React.StrictMode>,
);
