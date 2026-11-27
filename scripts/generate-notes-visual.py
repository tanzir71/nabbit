"""Encode real native Notes captures losslessly; never resize or retouch pixels."""
import hashlib
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
check = '--check' in sys.argv
receipt = 'progress/v2/M9/v48-landing-native-scene.json'
report = json.loads((root / receipt).read_text(encoding='utf-8'))
assert report['passed'] and report['noUserProfile'] and report['noHostedTack']
manifest = {'figma': {'desktop': '27:605', 'mobile': '31:1064'}, 'captures': []}
digest = lambda data: hashlib.sha256(data).hexdigest()
for capture in report['captures']:
    source = root / 'progress/v2/M9' / capture['file']
    raw = source.read_bytes()
    assert digest(raw) == capture['sha256'] and capture['repeatMatches']
    image = Image.open(source).convert('RGBA')
    assert image.size == (capture['width'], capture['height']) and len(raw) <= 300000
    assert image.width == round(capture['logicalBounds']['width'] * 2)
    assert image.height == round(capture['logicalBounds']['height'] * 2)
    output = root / f'docs/assets/visuals/notes-{capture["role"]}@2x.webp'
    if not check:
        image.save(output, 'WEBP', lossless=True, quality=100, method=6, exact=True)
    decoded = Image.open(output).convert('RGBA')
    assert decoded.size == image.size and decoded.tobytes() == image.tobytes()
    assert output.stat().st_size < 180000
    manifest['captures'].append({
        'role': capture['role'], 'file': output.relative_to(root / 'docs').as_posix(),
        'source': source.relative_to(root).as_posix(), 'sourceReport': receipt,
        'sourceSha256': capture['sha256'], 'sha256': digest(output.read_bytes()),
        'decodedRgbaSha256': digest(image.tobytes()), 'width': image.width,
        'height': image.height, 'scale': 2, 'bytes': output.stat().st_size,
        'executableSha256': report['executableSha256'],
        'buildManifestSha256': report['buildManifestSha256'],
        'sourceType': 'Owned release WebView2, actual Tauri IPC and SQLite; synthetic local-only notes',
        'encoding': 'Lossless WebP, exact RGBA; no resizing or retouching; DOM surface crop only',
    })
target = root / 'docs/assets/notes-capture.json'
if check:
    assert json.loads(target.read_text(encoding='utf-8')) == manifest
else:
    target.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print('Verified three exact native Notes captures as lossless WebP')
