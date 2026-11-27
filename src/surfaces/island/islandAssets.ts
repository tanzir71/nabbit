import slots from "../../assets/island/slots.json";
const files = import.meta.glob<string>("../../assets/island/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});
export type AssetGroup = keyof typeof slots;
export function islandAssetUrl(group: AssetGroup, name: string) {
  const file = (slots[group] as Record<string, string>)[name];
  return file ? files[`../../assets/island/${file}`] : undefined;
}
