import React from "react";
import { createRoot } from "react-dom/client";
import { initializeTheme } from "../../lib/theme";
import { StickyApp } from "./StickyApp";
import "../../styles/index.css";
import "./sticky.css";

initializeTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StickyApp />
  </React.StrictMode>,
);
