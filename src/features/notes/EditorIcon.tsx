import { DesignIcon } from "../../components/DesignIcon";
import { editorAssets } from "./editorAssets";
export function EditorIcon({ name }: { name: keyof typeof editorAssets }) {
  return <DesignIcon asset={editorAssets[name]} />;
}
