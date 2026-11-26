import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { initializeTheme } from "./lib/theme";

const DownloadSheetApp = React.lazy(() => import("./features/downloads/DownloadSheetApp"));
const isDownloadSheet = new URLSearchParams(location.search).has("download-sheet");
initializeTheme();
document.documentElement.dataset.surface = isDownloadSheet ? "download-sheet" : "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isDownloadSheet ? (
      <React.Suspense fallback={null}>
        <DownloadSheetApp />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
