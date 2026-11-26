"""Losslessly publish the actual shell capture; never fabricate product pixels."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
source = root / 'progress/v2/M5/v27-accepted-expanded-nab-dark@1.5x.png'
destination = root / 'docs/assets/visuals/island-shell@1.5x.webp'
manifest_path = root / 'docs/assets/island-hero.json'
image = Image.open(source).convert('RGBA')
assert image.size == (1080, 690)
destination.parent.mkdir(parents=True, exist_ok=True)
check = '--check' in sys.argv
if not check:
    image.save(destination, 'WEBP', lossless=True, quality=100, method=6, exact=True)
decoded = Image.open(destination).convert('RGBA')
assert decoded.size == image.size and decoded.tobytes() == image.tobytes()
assert destination.stat().st_size < 180000
manifest = {
    'file': 'assets/visuals/island-shell@1.5x.webp',
    'source': source.relative_to(root).as_posix(),
    'sourceReport': 'progress/v2/M5/v27-accepted-screenshots.json',
    'scenario': 'expanded-nab',
    'figmaShell': '10:519',
    'figmaComposition': '27:273',
    'sourceType': 'Actual compiled React island, automated Chromium capture with fixture IPC; no screenshot of an unbuilt control.',
    'width': 1080, 'height': 690, 'scale': 1.5,
    'encoding': 'Lossless WebP, exact RGBA, method 6; no cropping, resizing or retouching',
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
    'decodedRgbaSha256': hashlib.sha256(image.tobytes()).hexdigest(),
    'bytes': destination.stat().st_size,
}
report = json.loads((root / manifest['sourceReport']).read_text(encoding='utf-8'))
capture = next(c for c in report['captures'] if c['file'] == source.name)
assert capture['sha256'] == manifest['sourceSha256'] and capture['repeatMatches']
assert not capture['runtimeAndNetworkProblems'] and not capture['unsupported']
mobile_source = root / 'progress/v2/M5/v27-accepted-peek-link-dark@1.5x.png'
mobile_receipt = next(c for c in report['captures'] if c['file'] == mobile_source.name)
assert mobile_receipt['repeatMatches'] and not mobile_receipt['runtimeAndNetworkProblems']
assert hashlib.sha256(mobile_source.read_bytes()).hexdigest() == mobile_receipt['sha256']
geometry = mobile_receipt['assertions']['geometry']
assert geometry == {'x': 160, 'y': 6, 'width': 400, 'height': 100}
crop = (228, 0, 852, 183)  # physical pixels: full Peek plus its transparent margin
mobile = Image.open(mobile_source).convert('RGBA').crop(crop)
mobile_output = destination.with_name('island-peek@1.5x.webp')
if not check:
    mobile.save(mobile_output, 'WEBP', lossless=True, quality=100, method=6, exact=True)
assert Image.open(mobile_output).convert('RGBA').tobytes() == mobile.tobytes()
manifest['mobile'] = {
    'file': 'assets/visuals/island-peek@1.5x.webp',
    'source': mobile_source.relative_to(root).as_posix(),
    'sourceSha256': mobile_receipt['sha256'],
    'cropPhysicalPixels': list(crop), 'width': 624, 'height': 183, 'scale': 1.5,
    'encoding': 'Lossless WebP, exact RGBA crop including margin; no scaling or retouching',
    'sha256': hashlib.sha256(mobile_output.read_bytes()).hexdigest(),
    'decodedRgbaSha256': hashlib.sha256(mobile.tobytes()).hexdigest(),
    'bytes': mobile_output.stat().st_size,
}
if check:
    assert json.loads(manifest_path.read_text(encoding='utf-8')) == manifest
else:
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(f"Verified exact {image.width}x{image.height} capture as {destination.stat().st_size} byte lossless WebP")
