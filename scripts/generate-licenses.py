"""Generate the offline third-party screen from locked, locally installed packages.

Run after npm ci and cargo fetch. No network requests or licence substitutions.
"""
import argparse, hashlib, json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

def sha(data):
    return hashlib.sha256(data).hexdigest()

def texts(folder):
    found = []
    for file in sorted(folder.iterdir(), key=lambda p:p.name):
        if file.is_file() and re.match(r'(?i)^(licen[cs]e|copying|notice|copyright)([.\-_]|$)', file.name):
            if file.stat().st_size > 1_000_000:
                raise ValueError(f'Licence is unexpectedly large: {file.name}')
            found.append({'name':file.name, 'text':file.read_text(encoding='utf-8',errors='replace')})
    return found

def generate():
    metadata = json.loads(subprocess.check_output(['cargo','metadata','--manifest-path',str(ROOT/'src-tauri/Cargo.toml'),'--locked','--format-version','1'],cwd=ROOT))
    components = []
    for package in sorted(metadata['packages'],key=lambda p:(p['name'],p['version'])):
        if package['name'] == 'nabbit':
            continue
        folder = pathlib.Path(package['manifest_path']).parent
        notices = texts(folder)
        if package.get('license_file'):
            file = folder/package['license_file']
            if file.is_file() and not any(n['name']==file.name for n in notices):
                notices.append({'name':file.name,'text':file.read_text(encoding='utf-8',errors='replace')})
        components.append({'name':f"Rust · {package['name']}", 'version':package['version'], 'license':package['license'] or 'Not declared in the published package', 'repository':package.get('repository') or '', 'texts':notices})
    lock=json.loads((ROOT/'package-lock.json').read_text(encoding='utf-8'))
    for path, package in sorted(lock['packages'].items()):
        if not path or package.get('link'):
            continue
        folder=ROOT/path
        if not (folder/'package.json').is_file():
            # OS-specific optional packages omitted by npm on this machine are
            # metadata-only entries; they are not in this installed distribution.
            if not package.get('optional'):
                raise ValueError(f'Run npm ci: {path}')
            continue
        info=json.loads((folder/'package.json').read_text(encoding='utf-8'))
        repo=info.get('repository','')
        if isinstance(repo,dict):
            repo=repo.get('url','')
        license=info.get('license',package.get('license','Not declared in the published package'))
        if isinstance(license,dict):license=license.get('type','Not declared in the published package')
        components.append({'name':f"JavaScript · {info['name']}", 'version':info['version'], 'license':license, 'repository':repo, 'texts':texts(folder)})
    components.append({'name':'Geist and Geist Mono','version':'bundled','license':'OFL-1.1','repository':'https://github.com/vercel/geist-font','texts':[{'name':'OFL.txt','text':(ROOT/'src/assets/fonts/OFL.txt').read_text(encoding='utf-8')} ]})
    builds=json.loads((ROOT/'third-party/ffmpeg/builds.json').read_text(encoding='utf-8'))
    return {'inputs':{str(p):sha((ROOT/p).read_bytes().replace(b'\r\n',b'\n')) for p in ['src-tauri/Cargo.lock','package-lock.json','scripts/engine-pins.json']},'components':components,'ffmpeg':{'builds':builds,'gpl':(ROOT/'third-party/ffmpeg/x86_64-pc-windows-msvc-LICENSE.txt').read_text(encoding='utf-8'),'sourceOffer':(ROOT/'third-party/ffmpeg/SOURCE-OFFER.txt').read_text(encoding='utf-8')}}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    value=generate();output=ROOT/'third-party/notices.json';body=json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n'
    if args.check:
        if not output.is_file() or output.read_text(encoding='utf-8')!=body:raise SystemExit('Third-party notices are stale: python scripts/generate-licenses.py')
    else:output.write_text(body,encoding='utf-8',newline='\n')
    print(f"Verified {len(value['components'])} third-party component notices" if args.check else f"Generated {len(value['components'])} third-party component notices")
