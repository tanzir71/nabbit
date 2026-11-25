import React from "react";
import ReactDOM from "react-dom/client";
import { ComponentsPreview } from "./ComponentsPreview";
import "../styles/index.css";
import "./preview.css";
document.documentElement.dataset.componentPreview = "";
document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ComponentsPreview />
  </React.StrictMode>,
);
