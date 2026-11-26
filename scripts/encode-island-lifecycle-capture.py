"""Verify idle Figma geometry from an exact owned HWND capture; retain alpha."""
import sys
from pathlib import Path
from PIL import Image

source, width, height, shape, scale, destination = sys.argv[1:]
width, height, scale = int(width), int(height), float(scale)
# Rust f64::round rounds positive halves away from zero.
rounded = lambda value: int(value + .5)
assert (width, height) == (rounded(720 * scale), rounded(460 * scale))
pixels = bytearray(Path(source).read_bytes())
assert len(pixels) == width * height * 4
for i in range(0, len(pixels), 4):
    b, g, r, a = pixels[i:i + 4]
    pixels[i:i + 4] = bytes((min(255, round(r * 255 / a)) if a else 0,
                           min(255, round(g * 255 / a)) if a else 0,
                           min(255, round(b * 255 / a)) if a else 0, a))
image = Image.frombytes("RGBA", (width, height), bytes(pixels))
assert image.getpixel((0, height - 1))[3] == 0, "Host margins must be transparent"
notch = shape == 'notch'
top = 0 if notch else 6 * scale
pill_width, pill_height = (168 if notch else 112) * scale, (24 if notch else 26) * scale
center = (width // 2, rounded(top + pill_height / 2))
assert image.getpixel(center) == (5, 5, 6, 255), "Island must remain dark"
solid = [x for x in range(width) if image.getpixel((x, center[1]))[3] == 255]
assert abs(max(solid) - min(solid) + 1 - pill_width) <= 2, "Incorrect idle width"
left = (width - pill_width) / 2
if notch:
    assert image.getpixel((rounded(left + 2 * scale), 0))[3] == 255, "Notch must have square top corners"
    assert image.getpixel((rounded(left + scale), rounded(pill_height - scale)))[3] < 200, "Notch bottom corners must be rounded"
    assert image.getpixel((width // 2, rounded(pill_height + 2 * scale)))[3] == 0, "Notch must not have a floating shadow"
else:
    assert image.getpixel((rounded(left + scale), rounded(top + scale)))[3] < 200, "Floating corners must be rounded"
    assert image.getpixel((width // 2, rounded(top + pill_height + 5 * scale)))[3] > 0, "Floating shadow missing"
image.save(destination, optimize=True)
assert Path(destination).stat().st_size <= 300_000
print(f"Verified {shape}, {scale:g} combined scale: {width}x{height} RGBA.")
