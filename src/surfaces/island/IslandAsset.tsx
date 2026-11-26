import slots from "../../assets/island/slots.json";
const files = import.meta.glob<string>("../../assets/island/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});
export type AssetGroup = keyof typeof slots;
function assetUrl(group: AssetGroup, name: string) {
  const file = (slots[group] as Record<string, string>)[name];
  return file ? files[`../../assets/island/${file}`] : undefined;
}
/** Original exports keep their own intrinsic width/height. Only the slot is styled. */
export function IslandAsset({ group = "compact", name }: { group?: AssetGroup; name: string }) {
  const src = assetUrl(group, name);
  return src ? (
    <img
      className="island-asset"
      src={src}
      alt=""
      draggable={false}
      data-asset-slot={`${group}/${name}`}
    />
  ) : null;
}
