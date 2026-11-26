"""Publish lossless screenshot tiles below 300 KB, retaining full-page pixel hashes."""

import argparse
import hashlib
import io
import json
import math
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--prefix", required=True)
args = parser.parse_args()
assert args.prefix and all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in args.prefix)
root = Path(__file__).resolve().parents[1]
output = root / "progress/v2/M3"
temporary = root / ".tools/landing-captures" / args.prefix
report_path = output / f"{args.prefix}-tiles.json"
assert not report_path.exists(), "Use a fresh capture prefix"
browser_report = json.loads((output / f"{args.prefix}-browser-checks.json").read_text())
captures = []


def sha(data):
    return hashlib.sha256(data).hexdigest()


for context in browser_report["contexts"]:
    source = temporary / context["fullSource"]
    assert sha(source.read_bytes()) == context["fullSha256"]
    with Image.open(source) as image:
        image.load()
        assert image.width == math.ceil(context["width"] * context["scale"])
        assert image.height == math.ceil(context["geometry"]["pageHeight"] * context["scale"])
        reconstructed = Image.new(image.mode, image.size)
        stem = source.stem.removesuffix("-full")
        tiles = []

        def publish(top, bottom):
            tile = image.crop((0, top, image.width, bottom))
            buffer = io.BytesIO()
            tile.save(buffer, format="PNG", optimize=True, compress_level=9)
            data = buffer.getvalue()
            if len(data) > 300000:
                assert bottom - top > 1
                middle = (top + bottom) // 2
                publish(top, middle)
                publish(middle, bottom)
                return
            name = f"{stem}-part-{len(tiles) + 1:02}.png"
            with (output / name).open("xb") as destination:
                destination.write(data)
            with Image.open(io.BytesIO(data)) as decoded:
                assert decoded.mode == image.mode
                assert decoded.tobytes() == tile.tobytes()
                reconstructed.paste(decoded, (0, top))
            tiles.append({
                "file": name,
                "clipPhysicalPixels": [0, top, image.width, bottom - top],
                "bytes": len(data),
                "sha256": sha(data),
            })

        if source.stat().st_size <= 300000:
            publish(0, image.height)
        else:
            height = math.floor(500 * context["scale"])
            for top in range(0, image.height, height):
                publish(top, min(top + height, image.height))
        assert reconstructed.tobytes() == image.tobytes()
        captures.append({
            "source": context["fullSource"],
            "sourceSha256": context["fullSha256"],
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "decodedPixelSha256": sha(image.tobytes()),
            "losslessReconstruction": True,
            "tiles": tiles,
        })

with report_path.open("x", encoding="utf-8", newline="\n") as destination:
    json.dump({"maximumPngBytes": 300000, "captures": captures}, destination, indent=2)
    destination.write("\n")
all_tiles = [tile for capture in captures for tile in capture["tiles"]]
print(f"Published {len(all_tiles)} lossless tiles; largest {max(t['bytes'] for t in all_tiles):,} bytes.")
