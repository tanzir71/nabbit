import { Toggle } from "../../components/Toggle";
import type { DownloadMetadata, DownloadOptions } from "../../lib/types";
import { siteLabel } from "./model";
export type SheetControls = {
  metadata: DownloadMetadata;
  options: Required<DownloadOptions>;
  setOptions: (value: Required<DownloadOptions>) => void;
  busy: boolean;
  setProblem: (value: string) => void;
  onKind: (kind: "options" | "trim" | "playlist") => void;
};
export function Remember({
  checked,
  onChange,
  site,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  site: string;
}) {
  return (
    <div className="sheet-remember">
      <Toggle
        layout="control"
        label={`Remember for ${siteLabel(site)}`}
        checked={checked}
        onChange={onChange}
      />
      <span>Remember for {siteLabel(site)}</span>
    </div>
  );
}
