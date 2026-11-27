import { islandAssetUrl, type AssetGroup } from "./islandAssets";
export type { AssetGroup } from "./islandAssets";
/** Original exports keep their own intrinsic width/height. Only the slot is styled. */
export function IslandAsset({ group = "compact", name }: { group?: AssetGroup; name: string }) {
  const src = islandAssetUrl(group, name);
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
