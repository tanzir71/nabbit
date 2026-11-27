from pathlib import Path
import base64,hashlib,io,json,tarfile
root=Path.cwd()
assert (root/'NABBIT_V2_HANDOFF.md').is_file(), 'Run from the repository root with the pinned inputs in .tools/'
commit='70d6608e4c4a4b9e4dd38b9bf2124187f6285893'
items=[
 ('v43-tack-0.txt','package-lock.json','ac57b7fc74e70fbef77a33e9854096c0b6a74401'),
 ('v43-tack-1.txt','src/sync-merge.ts','2738ff17724bfb5eceb2d157a1f33b69fd278611'),
 ('v43-tack-2.txt','src/sync.ts','a43e712bd5d8000d8fb47176dfab6895d0097152'),
 ('v43-tack-3.txt','src/cards.ts','c42023c5de81d918e56dbd3efd8bd6714533d6e8'),
 ('v43-tack-4.txt','src/capture.ts','ab0f158880424cd76817eafa61a73fd31c2b0e02'),
 ('v43-rank-source-0.txt','src/rank.ts','67657bb72f4adc34387b3bec207b649580f0128d'),
 ('v43-rank-source-1.txt','src/rank-schema.ts','adf568753f072012763c1cae79d332b9b4f17d67'),
 ('v43-rank-source-2.txt','backend/ranks.php','7ccfc02d7ede01037bbbb4a04b80d1a8432c2daa'),
]
def blob(raw):return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
verified=[]
for local,path,expected in items:
 raw=(root/'.tools'/local).read_bytes()
 if blob(raw)!=expected and raw.endswith(b'\n'):raw=raw[:-1]
 assert blob(raw)==expected,(path,blob(raw))
 verified.append(dict(url=f'https://github.com/tanzir71/tack/blob/{commit}/project-priority/{path}',gitBlob=expected,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
 if path=='package-lock.json':
  locked=json.loads(raw)['packages']['node_modules/fractional-indexing']
  assert locked['version']=='4.0.0'
archive=(root/'.tools/fractional-indexing-4.0.0.tgz').read_bytes()
integrity='sha512-'+base64.b64encode(hashlib.sha512(archive).digest()).decode()
assert integrity==locked['integrity']
with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:source=tar.extractfile('package/src/index.js').read()
rank=json.loads((root/'src-tauri/tests/fixtures/tack/rank-source.json').read_text())
assert hashlib.sha256(source).hexdigest()==rank['sourceSha256']
assert len(json.loads((root/'src-tauri/tests/fixtures/tack/ranks.json').read_text()))==515
assert len(json.loads((root/'src-tauri/tests/fixtures/tack/rank-tack.json').read_text()))==36
prior=json.loads((root/'.tools/v42-source-verification.json').read_text())
report=dict(commit=commit,verifiedSources=verified,reusedV42Sources=prior['verifiedSources'],package=dict(name='fractional-indexing',version='4.0.0',integrity=integrity,sourceSha256=hashlib.sha256(source).hexdigest()),fixtureCases=515,tackWrapperCases=36,scope='Pinned upstream read-only source; no hosted Tack or user account used.')
(root/'.tools/v43-source-verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(dict(status='passed',freshlyVerifiedSources=len(verified),reusedV42Sources=len(prior['verifiedSources']),fractionalRankCases=515,tackWrapperCases=36)))
