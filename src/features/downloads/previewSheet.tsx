import { createRoot } from "react-dom/client";
import DownloadSheetApp from "./DownloadSheetApp";
let cleanup: (() => void) | undefined;
export function mountPreviewSheet() {
  cleanup?.();
  const node = document.createElement("div");
  node.className = "download-sheet-backdrop";
  document.body.append(node);
  const root = createRoot(node);
  const close = () => {
    root.unmount();
    node.remove();
    window.removeEventListener("nabbit:close-download-sheet", close);
    cleanup = undefined;
  };
  cleanup = close;
  window.addEventListener("nabbit:close-download-sheet", close);
  root.render(<DownloadSheetApp />);
}
