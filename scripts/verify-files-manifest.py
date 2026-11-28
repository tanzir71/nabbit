"""Read the built PE manifest as data; never execute it or change Windows policy."""
import ctypes
from ctypes import wintypes
import hashlib
import gzip
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

assert sys.platform == "win32"
root = Path(__file__).resolve().parent.parent
prefix = sys.argv[1] if len(sys.argv) > 1 else "v58-manifest"
assert re.fullmatch(r"v[0-9]+-[a-z0-9-]+", prefix)
exe = root / "src-tauri/target/release/nabbit.exe"
folder = root / "progress/v2/M10"
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
kernel.LoadLibraryExW.restype = wintypes.HMODULE
kernel.FindResourceW.argtypes = [wintypes.HMODULE, ctypes.c_void_p, ctypes.c_void_p]
kernel.FindResourceW.restype = wintypes.HANDLE
kernel.LoadResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
kernel.LoadResource.restype = wintypes.HANDLE
kernel.SizeofResource.argtypes = [wintypes.HMODULE, wintypes.HANDLE]
kernel.SizeofResource.restype = wintypes.DWORD
kernel.LockResource.argtypes = [wintypes.HANDLE]
kernel.LockResource.restype = ctypes.c_void_p
kernel.FreeLibrary.argtypes = [wintypes.HMODULE]
module = kernel.LoadLibraryExW(str(exe), None, 0x22)
assert module, ctypes.get_last_error()
try:
    resource = kernel.FindResourceW(module, 1, 24)
    assert resource, ctypes.get_last_error()
    size = kernel.SizeofResource(module, resource)
    pointer = kernel.LockResource(kernel.LoadResource(module, resource))
    assert pointer and 0 < size < 100_000
    raw = ctypes.string_at(pointer, size).rstrip(b"\x00")
finally:
    kernel.FreeLibrary(module)
tree = ET.fromstring(raw)
long_path = tree.find(".//{http://schemas.microsoft.com/SMI/2016/WindowsSettings}longPathAware")
assert long_path is not None and long_path.text == "true"
controls = [node.attrib for node in tree.iter("{urn:schemas-microsoft-com:asm.v1}assemblyIdentity")
            if node.get("name") == "Microsoft.Windows.Common-Controls"]
assert len(controls) == 1 and controls[0]["version"] == "6.0.0.0"
sha = lambda data: hashlib.sha256(data).hexdigest()
canonical = ("\n".join(line.rstrip() for line in raw.decode("utf-8-sig").splitlines()).strip() + "\n").encode()
with (folder / f"{prefix}.xml").open("xb") as output:
    output.write(canonical)
with (folder / f"{prefix}.xml.original.gz").open("xb") as output:
    output.write(gzip.compress(raw, mtime=0))
report = {"executableSha256": sha(exe.read_bytes()), "manifestSha256": sha(raw),
          "canonicalManifestSha256": sha(canonical), "originalArchive": f"{prefix}.xml.original.gz",
          "resource": {"type": 24, "id": 1, "bytes": len(raw)},
          "longPathAware": True, "commonControls": controls,
          "method": "LoadLibraryExW as data/image resource only; no execution or policy changes"}
with (folder / f"{prefix}.json").open("x", encoding="utf-8", newline="\n") as output:
    output.write(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
