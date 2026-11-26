"""Decode only an exact Nabbit HWND's premultiplied BGRA capture, without resizing."""
import json,sys
from pathlib import Path
from PIL import Image
source,width,height,destination=sys.argv[1:]
width,height=int(width),int(height)
raw=bytearray(Path(source).read_bytes());assert len(raw)==width*height*4
for index in range(0,len(raw),4):
    b,g,r,a=raw[index:index+4]
    raw[index:index+4]=bytes((min(255,round(r*255/a)) if a else 0,min(255,round(g*255/a)) if a else 0,min(255,round(b*255/a)) if a else 0,a))
image=Image.frombytes('RGBA',(width,height),bytes(raw))
assert image.getpixel((0,height-1))[3]==0,'Host margin is not transparent'
assert image.getextrema()[3][1]>0,'Visible surface is empty'
with Path(destination).open('xb') as output:image.save(output,format='PNG',optimize=True)
assert Path(destination).stat().st_size<=300_000
print(json.dumps({'width':width,'height':height,'bytes':Path(destination).stat().st_size,'originalDeviceResolution':True,'transparentMargin':True}))
