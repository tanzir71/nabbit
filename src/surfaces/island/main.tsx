import React from "react";
import { createRoot } from "react-dom/client";
import { IslandApp } from "./IslandApp";
import "./island.css";

// Native idle/live owns the compact surface; this entry is allocated on demand.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IslandApp />
  </React.StrictMode>,
);
