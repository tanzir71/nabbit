import type { CSSProperties } from "react";
import { componentAssets } from "../assets/components/assets";
export function DesignIcon({ name }: { name: keyof typeof componentAssets }) {
  const asset = componentAssets[name];
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
