"""Check actual raster colours of the exported, theme-aware switch assets."""
from pathlib import Path
from PIL import Image
import json
import re

root = Path(__file__).resolve().parent.parent
css = (root / "src/styles/tokens.css").read_text()
light, dark = css.split('[data-theme="dark"]', 1)
reports = []
for theme, block in [("light", light), ("dark", dark)]:
    tokens = dict(re.findall(r"--([a-z-]+):\s*(#[0-9A-Fa-f]{6});", block))
    def rgb(name):
        value = tokens[name]
        return tuple(int(value[i:i+2], 16) for i in [1, 3, 5])
    for scale in [1, 1.5]:
        path = root / f"progress/v2/M2/v13-core-{theme}@{scale}x.png"
        im = Image.open(path).convert("RGB")
        assert im.size == (round(624 * scale), round(766 * scale))
        samples = [
            (54, 64, "action-primary"),
            (52, 454, "action-primary"),
            (72, 454, "action-on-primary"),
            (122, 454, "border-strong"),
            (104, 454, "bg-surface"),
            (54, 357, "island-fg"),
        ]
        results = []
        for x, y, token in samples:
            actual = im.getpixel((round(x * scale), round(y * scale)))
            expected = rgb(token)
            assert max(abs(a-b) for a, b in zip(actual, expected)) <= 1, (path.name, x, y, token, actual, expected)
            results.append({"token": token, "actual": actual, "expected": expected})
        reports.append({"theme": theme, "scale": scale, "samples": results})
(root / "progress/v2/M2/v13-pixel-checks.json").write_text(json.dumps({"reports": reports}, indent=2) + "\n")
print("Passed actual button/switch/island raster tokens in four contexts (1 RGB tolerance).")
