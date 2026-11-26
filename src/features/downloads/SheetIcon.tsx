import { DesignIcon } from "../../components/DesignIcon";
const assets = {
  close: ["d2028", 18, 18],
  folder: ["aa883", 15, 15],
  download: ["3d2ea", 16, 16],
  play: ["a9396", 18, 18],
  trim: ["2ed91", 16, 16],
  layers: ["ad273", 18, 18],
  check: ["338a5", 12, 12],
} as const;
const files = import.meta.glob<string>("../../assets/download-sheets/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
export function SheetIcon({ name }: { name: keyof typeof assets }) {
  const [file, width, height] = assets[name];
  return (
    <DesignIcon
      asset={{
        src: files[`../../assets/download-sheets/${file}.svg`],
        file: `download-sheets/${file}.svg`,
        width,
        height,
      }}
    />
  );
}
export function SheetRadio({ checked }: { checked: boolean }) {
  const file = checked ? "fd956" : "ef790";
  return (
    <img
      className="sheet-radio"
      src={files[`../../assets/download-sheets/${file}.svg`]}
      data-asset={`download-sheets/${file}.svg`}
      width={14}
      height={14}
      alt=""
    />
  );
}
