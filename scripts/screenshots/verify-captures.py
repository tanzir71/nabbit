"""Independent PNG decoding for the screenshot runner's evidence manifest."""
import argparse
import hashlib
import json
import re
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("--milestone", required=True)
parser.add_argument("--prefix", required=True)
args = parser.parse_args()
assert re.fullmatch(r"M(?:[0-9]|1[0-2])", args.milestone)
assert re.fullmatch(r"[a-z][a-z0-9-]{0,63}", args.prefix)
root = Path(__file__).resolve().parents[2]
folder = root / "progress/v2" / args.milestone
report = json.loads((folder / f"{args.prefix}-screenshots.json").read_text(encoding="utf-8"))
assert report["milestone"] == args.milestone and report["prefix"] == args.prefix
surface_cases = {"tray-downloads", "tray-clipboard", "settings", "sticky-unbound", "island-idle"}
foundation_cases = {"brand", "controls"}
expected = {"all": surface_cases | foundation_cases, "surfaces": surface_cases, "foundations": foundation_cases}[report["suite"]]
assert len(report["captures"]) == len(expected) * 4
assert {(c["scenario"], c["theme"], c["scale"]) for c in report["captures"]} == {(case, theme, scale) for case in expected for theme in ["light", "dark"] for scale in [1, 1.5]}
assert report["screenshotScale"] == "device"
captures = []
island_hashes = {}
for capture in report["captures"]:
    name = capture["file"]
    assert name == f'{args.prefix}-{capture["scenario"]}-{capture["theme"]}@{capture["scale"]}x.png'
    data = (folder / name).read_bytes()
    assert hashlib.sha256(data).hexdigest() == capture["sha256"]
    assert len(data) == capture["bytes"] <= 300 * 1024
    image = Image.open(folder / name)
    image.load()
    assert image.format == "PNG" and image.size == (capture["width"], capture["height"])
    assert image.size == (round(capture["clip"]["width"] * capture["scale"]), round(capture["clip"]["height"] * capture["scale"]))
    assert not capture["unsupported"] and not capture["runtimeAndNetworkProblems"]
    commands = [call["command"] for call in capture["ipc"]]
    assert "start_download" not in commands
    case, theme, scale = capture["scenario"], capture["theme"], capture["scale"]
    if case == "island-idle":
        assert capture["resolvedTheme"] == "dark" and not commands
        rgba = image.convert("RGBA")
        assert rgba.getpixel((0, 0))[3] == 0
        assert rgba.getpixel((int(360 * scale), int(19 * scale))) == (5, 5, 6, 255)
        island_hashes.setdefault(scale, set()).add(capture["sha256"])
    else:
        assert capture["resolvedTheme"] == theme
    if case == "brand":
        # Compare to the original Figma-reviewed foundation evidence when on the
        # same renderer/platform. Other environments retain geometric/raster QA.
        baseline = folder / f"v15-mark-{theme}@{scale}x.png"
        if report["platform"] == "win32" and baseline.exists():
            assert data == baseline.read_bytes(), f"Brand differs from Figma-reviewed baseline: {name}"
    if case in {"tray-downloads", "tray-clipboard", "settings", "sticky-unbound"}:
        assert "plugin:window|theme" in commands
        # Sample an actual opaque surface pixel, not just a DOM theme attribute.
        point = (4, 60) if case == "settings" else (20, 100) if case == "sticky-unbound" else (4, 4)
        expected_pixel = (27, 27, 30) if case == "sticky-unbound" and theme == "dark" else (22, 22, 24) if theme == "dark" else (255, 255, 255)
        assert image.convert("RGB").getpixel((int(point[0] * scale), int(point[1] * scale))) == expected_pixel, (name, expected_pixel)
    captures.append({"file": name, "pngDecoded": True, "dimensionsHashAndBudgetMatch": True})
assert all(len(values) == 1 for values in island_hashes.values())
validation = {"scenarios": sorted(expected), "matrixComplete": True, "islandDarkTransparentAndIdenticalAcrossThemes": bool(island_hashes), "captures": captures, "maximumPngBytes": max(c["bytes"] for c in report["captures"])}
with (folder / f"{args.prefix}-validation.json").open("x", encoding="utf-8") as stream:
    stream.write(json.dumps(validation, indent=2) + "\n")
print(f"Passed {len(captures)} independently decoded PNGs, complete theme/scale matrix, hashes, budgets and actual theme/island pixels.")
