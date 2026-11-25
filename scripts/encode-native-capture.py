"""Encode/verify the exact HWND's WGC BGRA pixels, never a desktop crop.

Retain transparency. Theme is metadata for the two comparison contexts; the
island itself is always dark. WGC uses premultiplied alpha, PNG uses straight.
"""
import sys
from pathlib import Path
from PIL import Image

source, width, height, state, theme, scale, destination = sys.argv[1:]
width, height, scale = int(width), int(height), float(scale)
assert (width, height) == (round(720 * scale), round(460 * scale))
pixels = bytearray(Path(source).read_bytes())
assert len(pixels) == width * height * 4
for i in range(0, len(pixels), 4):
    b, g, r, a = pixels[i:i + 4]
    pixels[i:i + 4] = bytes((min(255, round(r * 255 / a)) if a else 0,
                           min(255, round(g * 255 / a)) if a else 0,
                           min(255, round(b * 255 / a)) if a else 0, a))
image = Image.frombytes("RGBA", (width, height), bytes(pixels))
alpha = image.getchannel("A")
assert alpha.getpixel((0, height - 1)) == 0, "Window margins must stay transparent"
if state == "fullscreen":
    assert alpha.getbbox() is None, "Fullscreen must make every native pixel transparent"
else:
    assert image.getpixel((width // 2, round(8 * scale))) == (5, 5, 6, 255)
    if state == "live":
        lime = sum(1 for r, g, b, a in image.getdata()
                   if a > 200 and 160 < r < 230 and g > 220 and b < 130)
        assert lime > 15 * scale * scale, "The original SVG progress ring is missing"
        text = image.crop((round(236 * scale), round(13 * scale),
                           round(506 * scale), round(31 * scale)))
        assert sum(1 for r, g, b, a in text.getdata() if a > 200 and r > 90 and g > 90 and b > 90) > 100 * scale * scale, "Native text is missing"
    expected_width = round((112 if state == "idle" else 320) * scale)
    row = round((6 + (13 if state == "idle" else 16)) * scale)
    solid = [x for x in range(width) if image.getpixel((x, row))[3] == 255]
    assert abs((max(solid) - min(solid) + 1) - expected_width) <= 2
    edge = image.crop((round((720 - expected_width / scale) / 2 * scale), round(6 * scale),
                       round((720 - expected_width / scale) / 2 * scale + 18 * scale), round(24 * scale)))
    assert any(50 < a < 240 and 0 < r < 15 for r, g, b, a in edge.getdata()), "Rounded clips must be antialiased"
image.save(destination, optimize=True)
assert Path(destination).stat().st_size <= 300 * 1024
print(f"Verified {state}, {theme}/{scale:g}x: own HWND RGBA {width}x{height}.")
