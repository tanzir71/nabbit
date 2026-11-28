import { fixtureData } from "./fixtures.mjs";
import { mediaPresets } from "./media-tools-fixtures.mjs";
export function imageDocumentFixture(mode) {
  const imageTypes = ["png", "jpg", "jpeg", "heic", "heif", "webp", "avif", "svg"];
  const specs = [
    ["to-jpg", "Convert images", "images", imageTypes, ["jpg", "png", "webp", "avif"]],
    ["smaller-image", "Make smaller", "images", imageTypes, ["smaller"]],
    [
      "fit-size",
      "Fit under a size",
      "media",
      imageTypes,
      ["discord", "email", "outlook", "whatsapp", "custom-fit"],
    ],
    ["merge-pdf", "Merge PDFs", "documents", ["pdf"], ["pdf"]],
    ["split-pdf", "Split PDF", "documents", ["pdf"], ["split"]],
    ["pdf-png", "PDF to PNG", "documents", ["pdf"], ["png"]],
    ["images-pdf", "Make PDF", "documents", imageTypes, ["pdf"]],
    ["image-text", "Text from image", "documents", imageTypes, ["text"]],
    ["decode-qr", "Read QR from image", "documents", imageTypes, ["text"]],
    ["encode-qr", "Text file to QR", "documents", ["txt"], ["qr"]],
  ];
  const tools = specs.map(([id, name, category, filetypes, presets]) => ({
    id,
    name,
    category,
    presets,
    keywords: [],
    icon: "iconFile",
    accepts: { filetypes, text: false, link: false, image: category === "images" },
    form: [],
  }));
  const id =
    {
      smaller: "smaller-image",
      fit: "fit-size",
      merge: "merge-pdf",
      split: "split-pdf",
      render: "pdf-png",
      pdf: "images-pdf",
      ocr: "image-text",
      decode: "decode-qr",
      encode: "encode-qr",
    }[mode] ?? "to-jpg";
  const images = [
    "C:\\Fixture\\IMG_4821.HEIC",
    "C:\\Fixture\\IMG_4822.HEIC",
    "C:\\Fixture\\IMG_4830.HEIC",
  ];
  const inputs =
    mode === "choose"
      ? []
      : ["merge", "split", "render"].includes(mode)
        ? ["C:\\Fixture\\Report.pdf", ...(mode === "merge" ? ["C:\\Fixture\\Appendix.pdf"] : [])]
        : mode === "encode"
          ? ["C:\\Fixture\\Link.txt"]
          : ["ocr", "decode"].includes(mode)
            ? images.slice(0, 1)
            : images;
  return {
    data: fixtureData("tray"),
    responses: {
      tool_catalog: tools,
      tool_presets: [
        ...mediaPresets,
        ...["jpg", "png", "webp", "avif", "smaller", "pdf", "split", "text", "qr"].map((id) => ({
          id,
          name: id,
          maxMb: null,
          quality: 82,
        })),
      ],
      tool_media_sheet: {
        id: "51000000-0000-4000-8000-000000000001",
        toolId: id,
        input: inputs[0] ?? "",
        inputs,
      },
      tool_media_sheet_ready: null,
      shelf_list: [],
      tool_pdf_pages: 7,
      tool_image_inspect:
        mode === "codec"
          ? { info: null, error: "Windows could not decode this HEIC image.", codecRequired: true }
          : {
              info: {
                width: 3992,
                height: 2992,
                bytes: 2400000,
                format: "heic",
                orientation: 1,
                hasExif: true,
                hasProfile: true,
                animated: false,
                decoder: "WIC",
              },
              error: null,
              codecRequired: false,
            },
    },
  };
}
