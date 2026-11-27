import { DesignIcon } from "../../components/DesignIcon";
import { linkAssets } from "./linkAssets";
export function LinkIcon({ name }: { name: keyof typeof linkAssets }) {
  return <DesignIcon asset={linkAssets[name]} />;
}
