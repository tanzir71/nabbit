"""Validate opacity from a premultiplied exact-owned-HWND WGC frame."""
import sys
from pathlib import Path
from PIL import Image

source, width, height, shape, scale, mode, destination = sys.argv[1:]
width, height, scale = int(width), int(height), float(scale)
assert (width, height) == (int(720 * scale + .5), int(460 * scale + .5))
pixels = bytearray(Path(source).read_bytes())
assert len(pixels) == width * height * 4
expected = {"visible": 255, "faded": 89, "hidden": 0}[mode]
alpha = pixels[3::4]
assert abs(max(alpha) - expected) <= 1, (mode, max(alpha), expected)
if mode == "hidden":
    assert not any(alpha), "Hidden host must be entirely transparent"
else:
    center = (width // 2, int((12 if shape == "notch" else 19) * scale + .5))
    offset = (center[1] * width + center[0]) * 4
    b, g, r, a = pixels[offset:offset + 4]
    assert abs(a - expected) <= 1
    # Faded channels are quantised after premultiplication at 35%.
    assert all(abs(value * 255 / a - target) <= 3 for value, target in zip((r, g, b), (5, 5, 6)))
assert alpha[(height - 1) * width] == 0, "Host margins must stay transparent"
for i in range(0, len(pixels), 4):
    b, g, r, a = pixels[i:i + 4]
    pixels[i:i + 4] = bytes((min(255, round(r * 255 / a)) if a else 0,
                           min(255, round(g * 255 / a)) if a else 0,
                           min(255, round(b * 255 / a)) if a else 0, a))
Image.frombytes("RGBA", (width, height), bytes(pixels)).save(destination, optimize=True)
assert Path(destination).stat().st_size <= 300_000
print(f"Verified {shape} {mode} {scale:g}x: {width}x{height}, maximum alpha {max(alpha)}.")
