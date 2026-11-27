import { DesignIcon } from "../../components/DesignIcon";
import { notesAssets } from "./assets";
export function NotesIcon({ name }: { name: keyof typeof notesAssets }) {
  return <DesignIcon asset={notesAssets[name]} />;
}
