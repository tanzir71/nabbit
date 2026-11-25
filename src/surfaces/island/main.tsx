import React from "react";
import { createRoot } from "react-dom/client";
import "./island.css";

// The native compact renderer remains selected. V2 will mount the larger web
// surfaces here; no activity services or module bodies run from this entry.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <main className="island-host" aria-label="Nabbit island">
      <div className="island-idle" aria-hidden="true" />
    </main>
  </React.StrictMode>,
);
