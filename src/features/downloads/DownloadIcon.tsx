import { DesignIcon } from "../../components/DesignIcon";
import { downloadAssets } from "./assets";
export function DownloadIcon({ name }: { name: keyof typeof downloadAssets }) {
  return <DesignIcon asset={downloadAssets[name]} />;
}
