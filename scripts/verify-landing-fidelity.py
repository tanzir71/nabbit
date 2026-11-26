import hashlib
import json
import math
import argparse
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

parser = argparse.ArgumentParser(description='Verify that landing screenshot changes stay inside the documented text-color rectangles.')
parser.add_argument('--baseline', required=True)
parser.add_argument('--current', required=True)
args = parser.parse_args()
for prefix in [args.baseline, args.current]:
    assert prefix and all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in prefix)
folder = Path(__file__).resolve().parents[1] / 'progress/v2/M3'
old = json.loads((folder / f'{args.baseline}-tiles.json').read_text())
new = json.loads((folder / f'{args.current}-tiles.json').read_text())
checks = json.loads((folder / f'{args.current}-browser-checks.json').read_text())
assert len(old['captures']) == len(new['captures']) == len(checks['contexts']) == 8
def reconstruct(capture):
    image = Image.new(capture['mode'], (capture['width'], capture['height']))
    for tile in capture['tiles']:
        data = (folder / tile['file']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == tile['sha256']
        with Image.open(folder / tile['file']) as part:
            image.paste(part, tuple(tile['clipPhysicalPixels'][:2]))
    assert hashlib.sha256(image.tobytes()).hexdigest() == capture['decodedPixelSha256']
    return image
results = []
for before, after, context in zip(old['captures'], new['captures'], checks['contexts']):
    first, second = reconstruct(before), reconstruct(after)
    assert first.size == second.size
    diff = ImageChops.difference(first, second)
    bands = diff.split()
    changed = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), bands[2]).point(lambda p: 255 if p else 0)
    permitted = Image.new('L', first.size)
    draw = ImageDraw.Draw(permitted)
    scale = context['scale']
    for rect in context['geometry']['colorAdjustmentRects']:
        draw.rectangle((math.floor(rect['x'] * scale) - 2, math.floor(rect['y'] * scale) - 2,
                        math.ceil((rect['x'] + rect['width']) * scale) + 2,
                        math.ceil((rect['y'] + rect['height']) * scale) + 2), fill=255)
    outside = ImageChops.multiply(changed, ImageChops.invert(permitted))
    assert outside.getbbox() is None, (before['source'], outside.getbbox())
    results.append({'width': context['width'], 'theme': context['theme'], 'scale': scale,
                    'baselineSource': before['source'], 'currentSource': after['source'],
                    'changedPixels': changed.histogram()[255], 'changedPixelsOutsideTextAdjustmentRects': 0,
                    'pageDimensionsUnchanged': True})
with (folder / f'{args.current}-fidelity-checks.json').open('x', encoding='utf-8', newline='\n') as output:
    output.write(json.dumps({'comparison': f'{args.baseline} against {args.current}; only documented text-color rectangles may differ', 'contexts': results}, indent=2) + '\n')
print('All 8 current page rasters retain identical geometry and differ only inside the documented text-color rectangles.')
