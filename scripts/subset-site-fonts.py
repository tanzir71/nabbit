"""Create the site's Latin subsets from the app's pinned, OFL-licensed fonts."""
import hashlib
import json
from pathlib import Path
from shutil import copyfile
from fontTools import subset

root = Path(__file__).resolve().parents[1]
source = root / "src/assets/fonts"
target = root / "docs/assets/fonts"
target.mkdir(parents=True, exist_ok=True)
unicode_ranges = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-21FF,U+2212,U+2215,U+FEFF,U+FFFD"
manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
outputs = []
for family in ["Geist", "GeistMono"]:
    name = f"{family}-Variable.woff2"
    original = source / name
    digest = hashlib.sha256(original.read_bytes()).hexdigest()
    assert digest == manifest["files"][name]["sha256"]
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.recalc_timestamp = False
    font = subset.load_font(str(original), options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(unicode_ranges))
    subsetter.subset(font)
    destination = target / f"{family}-Latin.woff2"
    subset.save_font(font, str(destination), options)
    outputs.append({"file": destination.name, "bytes": destination.stat().st_size, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(), "sourceSha256": digest})
copyfile(source / "OFL.txt", target / "OFL.txt")
(target / "manifest.json").write_text(json.dumps({"version": manifest["version"], "license": manifest["license"], "unicodeRanges": unicode_ranges, "files": outputs}, indent=2) + "\n", encoding="utf-8")
print("Generated pinned Latin variable-font subsets:", [(item["file"], item["bytes"]) for item in outputs])
