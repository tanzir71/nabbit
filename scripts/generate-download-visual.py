"""Publish native downloader captures with lossless, exact RGBA encoding."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
check = '--check' in sys.argv
manifest = {'figma': {'desktop': '27:499', 'mobile': '31:1036'}, 'captures': []}
specs = [
    ('tray', 'v37-native-rendered-tray-light@2x.png', 'v37-native-rendered-downloads.json', (920, 1360)),
    ('peek', 'v37-peek@2x.png', 'v37-peek.json', (864, 280)),
]
for role, filename, receipt, size in specs:
    source = root / 'progress/v2/M7' / filename
    report = json.loads((source.parent / receipt).read_text(encoding='utf-8'))
    capture = next(c for c in report['screenshots'] if c['file'] == filename) if role == 'tray' else report
    digest = lambda data: hashlib.sha256(data).hexdigest()
    assert digest(source.read_bytes()) == capture['sha256'] and capture['repeatMatches']
    image = Image.open(source).convert('RGBA')
    assert image.size == size and source.stat().st_size <= 300000
    output = root / f'docs/assets/visuals/download-{role}@2x.webp'
    if not check:
        image.save(output, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    decoded = Image.open(output).convert('RGBA')
    assert decoded.size == size and decoded.tobytes() == image.tobytes()
    assert output.stat().st_size < 180000
    manifest['captures'].append({
        'role': role, 'file': output.relative_to(root / 'docs').as_posix(),
        'source': source.relative_to(root).as_posix(), 'sourceReport': f'progress/v2/M7/{receipt}',
        'sourceSha256': capture['sha256'], 'sha256': digest(output.read_bytes()),
        'decodedRgbaSha256': digest(image.tobytes()), 'width': size[0], 'height': size[1], 'scale': 2,
        'bytes': output.stat().st_size, 'executableSha256': report['executableSha256'],
        'sourceType': 'Owned release WebView2 with real Rust capture, SQLite, Tauri IPC and isolated fixture data',
        'encoding': 'Lossless WebP, exact RGBA; no cropping, resizing or retouching',
    })
target = root / 'docs/assets/download-capture.json'
if check:
    assert json.loads(target.read_text(encoding='utf-8')) == manifest
else:
    target.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print('Verified two exact native download captures as lossless WebP')
