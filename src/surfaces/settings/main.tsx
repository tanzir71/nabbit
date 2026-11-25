import React from "react";
import { createRoot } from "react-dom/client";
import { initializeTheme } from "../../lib/theme";
import { SettingsApp } from "./SettingsApp";
import "../../styles/index.css";

initializeTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
