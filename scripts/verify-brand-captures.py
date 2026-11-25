"""Independently decode icon containers and inspect actual brand screenshot pixels."""
import hashlib
import json
import sys
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image, ImageChops

root = Path(__file__).resolve().parents[1]
icons = root / "src-tauri/icons"
output = root / "progress/v2/M2"
ns = {"svg": "http://www.w3.org/2000/svg"}
sizes = [16, 24, 32, 48, 64, 128, 256]
ico = Image.open(icons / "icon.ico")
assert ico.ico.sizes() == {(s, s) for s in sizes}
for size in sizes:
    frame = ico.ico.getimage((size, size)).convert("RGBA")
    expected = Image.open(icons / f"{size}x{size}.png").convert("RGBA")
    assert frame.tobytes() == expected.tobytes(), f"ICO {size} differs"
icns = Image.open(icons / "icon.icns")
icns_sizes = []
for entry in icns.info["sizes"]:
    frame = icns.icns.getimage(entry).convert("RGBA")
    size = frame.width
    expected = Image.open(icons / f"{size}x{size}.png").convert("RGBA")
    assert frame.tobytes() == expected.tobytes(), f"ICNS {size} differs"
    icns_sizes.append(size)
assert sorted(icns_sizes) == [16, 32, 64, 128, 256, 512, 1024]
for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    frame = Image.open(icons / f"{size}x{size}.png").convert("RGBA")
    assert frame.size == (size, size)
    assert frame.getpixel((0, 0))[3] == 0
    assert frame.getpixel((size // 2, size // 2))[3] == 255
assert (root / "docs/assets/favicon.svg").read_bytes() == (root / "src/assets/brand/app-32.svg").read_bytes()
assert (root / "docs/assets/favicon.ico").read_bytes() == (icons / "icon.ico").read_bytes()

checks = []
for theme in ["light", "dark"]:
    for scale in [1, 1.5]:
        mark = Image.open(output / f"v15-mark-{theme}@{scale}x.png").convert("RGB")
        assert mark.size == (int(506 * scale), int(186 * scale))
        x = 29
        for size in [16, 24, 32, 64, 128]:
            source = ElementTree.parse(root / f"src/assets/brand/app-{size}.svg").getroot()
            dot = source.find(".//svg:circle", ns)
            cx, cy = float(dot.attrib["cx"]), float(dot.attrib["cy"])
            py = int((29 + (128 - size) / 2 + cy) * scale)
            px = int((x + cx) * scale)
            pixel = mark.getpixel((px, py))
            # Tiny 1px-radius marks at 1.5x have an antialiased edge sample.
            assert max(abs(a - b) for a, b in zip(pixel, (198, 242, 78))) <= (65 if size == 16 else 1), (size, scale, pixel)
            x += size + 24
        for size in [16, 24]:
            center = (int((x + size / 2) * scale), int(93 * scale))
            expected = (23, 23, 26) if theme == "light" else (255, 255, 255)
            assert mark.getpixel(center) == expected, (theme, scale, center, mark.getpixel(center))
            x += size + 24
        tray = Image.open(output / f"v15-tray-{theme}@{scale}x.png").convert("RGB")
        # Actual header tile, after the first-run dialog has been acknowledged.
        assert tray.getpixel((int(33 * scale), int(15 * scale))) == (5, 5, 6)
        checks.append({"theme": theme, "scale": scale, "liveDotAndMonochromePixels": True, "headerMarkUnobscured": True})

native = []
if "--native" in sys.argv:
    for size in sizes:
        resource = Image.open(output / f"v15-resource-{size}.png").convert("RGBA")
        decoded = Image.open(output / f"v15-win32-icon-{size}.png").convert("RGBA")
        assert resource.size == decoded.size == (size, size)
        assert resource.getchannel("A").tobytes() == decoded.getchannel("A").tobytes()
        # Win32 round-trips premultiplied channels at translucent edges. Compare
        # visible output on both taskbar backgrounds, rather than invisible RGB.
        maximum = 0
        for background in [(255, 255, 255, 255), (22, 22, 24, 255)]:
            a = Image.alpha_composite(Image.new("RGBA", resource.size, background), resource)
            b = Image.alpha_composite(Image.new("RGBA", resource.size, background), decoded)
            maximum = max(maximum, max(extreme[1] for extreme in ImageChops.difference(a, b).getextrema()))
        assert maximum <= 2, (size, maximum)
        native.append({"size": size, "alphaMatches": True, "maximumCompositeChannelDifference": maximum})

pngs = [{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(output.glob("v15-*.png"))]
assert all(p["bytes"] <= 300 * 1024 for p in pngs)
report = {"icoSizes": sizes, "icnsSizes": sorted(icns_sizes), "faviconOriginalsMatch": True, "rasterChecks": checks, "nativeDecodedFrames": native, "pngs": pngs}
(output / "v15-capture-validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(f"Passed independent ICO/ICNS decoding and brand raster checks; {len(native)} Win32 frames, {len(pngs)} PNGs.")
