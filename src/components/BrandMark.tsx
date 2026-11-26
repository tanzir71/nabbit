const tiles = {
  16: new URL("../assets/brand/app-16.svg", import.meta.url).href,
  24: new URL("../assets/brand/app-24.svg", import.meta.url).href,
  32: new URL("../assets/brand/app-32.svg", import.meta.url).href,
  64: new URL("../assets/brand/app-64.svg", import.meta.url).href,
  128: new URL("../assets/brand/app-128.svg", import.meta.url).href,
};

export function BrandMark({ size = 32 }: { size?: keyof typeof tiles }) {
  return (
    <img
      src={tiles[size]}
      width={size}
      height={size}
      alt=""
      className="shrink-0"
      data-asset={`brand/app-${size}.svg`}
    />
  );
}
