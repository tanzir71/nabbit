import type { CSSProperties } from "react";
import { componentAssets } from "../assets/components/assets";
export function DesignIcon(
  props:
    | { name: keyof typeof componentAssets }
    | { asset: { src: string; file: string; width: number; height: number } },
) {
  const asset = "asset" in props ? props.asset : componentAssets[props.name];
  return (
    <span
      aria-hidden="true"
      className="n-asset"
      style={
        {
          width: asset.width,
          height: asset.height,
          "--asset": `url("${asset.src}")`,
        } as CSSProperties
      }
    >
      <img
        src={asset.src}
        width={asset.width}
        height={asset.height}
        alt=""
        draggable={false}
        data-asset={asset.file}
      />
    </span>
  );
}
