import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { initializeTheme } from "./lib/theme";

const DownloadSheetApp = React.lazy(() => import("./features/downloads/DownloadSheetApp"));
const MediaSheetApp = React.lazy(() => import("./features/tools/MediaSheetApp"));
const isDownloadSheet = new URLSearchParams(location.search).has("download-sheet");
const isMediaSheet = new URLSearchParams(location.search).has("media-sheet");
initializeTheme();
document.documentElement.dataset.surface = isMediaSheet
  ? "media-sheet"
  : isDownloadSheet
    ? "download-sheet"
    : "tray";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isMediaSheet ? (
      <React.Suspense fallback={null}>
        <MediaSheetApp />
      </React.Suspense>
    ) : isDownloadSheet ? (
      <React.Suspense fallback={null}>
        <DownloadSheetApp />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
