"""Reject stale entry captures by checking raster theme and island transparency."""
from pathlib import Path
from PIL import Image
import json
import re

root = Path(__file__).resolve().parent.parent
light, dark = (root / "src/styles/tokens.css").read_text().split('[data-theme="dark"]', 1)
reports = []
for theme, block in [("light", light), ("dark", dark)]:
    tokens = dict(re.findall(r"--([a-z-]+):\s*(#[0-9A-Fa-f]{6});", block))
    def rgb(token):
        value = tokens[token]
        return tuple(int(value[i:i+2], 16) for i in [1, 3, 5])
    for scale in [1, 1.5]:
        for surface, point, token in [("settings", (4, 60), "bg-surface"), ("sticky", (20, 100), "note-default")]:
            path = root / f"progress/v2/M2/v14-{surface}-{theme}@{scale}x.png"
            image = Image.open(path).convert("RGB")
            actual = image.getpixel(tuple(round(v * scale) for v in point))
            assert actual == rgb(token), (path.name, actual, rgb(token))
            reports.append({"file": path.name, "token": token, "actual": actual})
        path = root / f"progress/v2/M2/v14-island-{theme}@{scale}x.png"
        image = Image.open(path).convert("RGBA")
        assert image.size == (round(720 * scale), round(460 * scale))
        assert image.getpixel((0, 0))[3] == 0
        assert image.getpixel((round(360 * scale), round(19 * scale))) == (*rgb("island-bg"), 255)
    for surface, point, token in [("settings", (4, 60), "bg-surface"), ("sticky", (20, 100), "note-default")]:
        path = root / f"progress/v2/M2/v14-native-{surface}-{theme}.png"
        image = Image.open(path).convert("RGB")
        actual = image.getpixel(point)
        assert actual == rgb(token), (path.name, actual, rgb(token))
        reports.append({"file": path.name, "token": token, "actual": actual})
(root / "progress/v2/M2/v14-capture-checks.json").write_text(json.dumps({"samples": reports, "browserIslandTransparencyVerified": True}, indent=2) + "\n")
print("Verified entry raster themes and transparent browser island in all captured contexts.")
