"""Regenerate golden merges with unmodified, locally supplied pinned Tack PHP.

Usage: python scripts/generate-tack-merge-fixtures.py --merge <merge.php> --sharing <sharing.php>
No network, accounts, SQLite extension or persistent PHP configuration required.
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import subprocess
import tempfile


def pinned(path, expected):
    raw = path.read_bytes().replace(b"\r\n", b"\n")
    # Accept the connector's single extra final newline, not arbitrary edits.
    for candidate in (raw, raw[:-1] if raw.endswith(b"\n") else raw):
        digest = hashlib.sha1(b"blob " + str(len(candidate)).encode() + b"\0" + candidate).hexdigest()
        if digest == expected:
            return
    raise ValueError(f"Pinned Tack source mismatch: {path.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merge", required=True, type=Path)
    parser.add_argument("--sharing", required=True, type=Path)
    args = parser.parse_args()
    pinned(args.merge, "edb57b693ee3de8a85e679e80165f6f71c39b2d5")
    pinned(args.sharing, "e8c855205b2a33b4246270bf528a0a1eb2a7dc3f")
    cases = []

    def add(name, base, current, incoming):
        cases.append(dict(name=name, base=base, current=current, incoming=incoming))

    def text(name, base, current, incoming):
        add(name, dict(id="merge", body=base, revision=0), dict(id="merge", body=current, revision=1), dict(id="merge", body=incoming, revision=1))

    text("disjoint-words", "alpha beta gamma", "ALPHA beta gamma", "alpha beta GAMMA")
    text("overlapping-text", "alpha beta", "LEFT beta", "RIGHT beta")
    text("same-change", "alpha", "ALPHA", "ALPHA")
    text("unicode-scalars", "বাংলা 🐰 café\nsecond line", "বাংলা 🐰 CAFÉ\nsecond line", "বাংলা 🐰 café\nlast line")
    text("ecmascript-whitespace", "one\ufefftwo\u00a0three", "ONE\ufefftwo\u00a0three", "one\ufefftwo\u00a0THREE")
    text("crlf", "first\r\nsecond\r\nlast", "FIRST\r\nsecond\r\nlast", "first\r\nsecond\r\nLAST")
    text("insert-same-offset", "abc", "abXc", "abYc")
    text("insert-disjoint", "abc", "Xabc", "abcY")
    text("delete-v-edit", "abcde", "abe", "abXYe")
    text("empty-base", "", "left", "right")
    text("sparse-large", "a" * 70000 + " middle " + "z" * 70000, "b" * 70000 + " middle " + "z" * 70000, "a" * 70000 + " middle " + "y" * 70000)
    text("high-distance-anchor", "a" * 2400 + " marker " + "z" * 2400, "b" * 2400 + " marker " + "z" * 2400, "a" * 2400 + " marker " + "y" * 2400)
    text("repeated-unicode", "🐰" * 3000 + " anchor " + "文" * 3000, "🐱" * 3000 + " anchor " + "文" * 3000, "🐰" * 3000 + " anchor " + "字" * 3000)
    add("sets-structured-unknown", dict(id="merge", labels=["keep", "remove"], pinned=False, revision=0), dict(id="merge", labels=["keep", "remove", "remote"], pinned=True, future=dict(n=42), revision=2), dict(id="merge", labels=["keep", "local"], pinned=False, revision=1))
    add("field-removal", dict(id="merge", url="https://example.test", color="default"), dict(id="merge", url="https://example.test", color="blue", future=True), dict(id="merge", color="default"))
    add("delete", dict(id="merge"), dict(id="merge"), None)
    add("absent-base", None, dict(id="merge"), dict(id="merge"))
    rng = random.Random(42)
    for i in range(80):
        base = "".join(rng.choice("ab 🐰\n") for _ in range(rng.randrange(3, 30)))
        current, incoming = list(base), list(base)
        a, b = rng.randrange(len(current)), rng.randrange(len(incoming))
        current[a:a + 1] = rng.choice(["X", "", "🐱"])
        incoming[b:b + 1] = rng.choice(["Y", "", "文"])
        text(f"random-{i}", base, "".join(current), "".join(incoming))
    base = dict(id="merge", body="human", completed=False, revision=0, updatedAt="old")
    current = dict(base, agentState={"runId": "run-1", "status": "done"}, completed=True, revision=1, updatedAt="remote")
    add("agent-completion-race", base, current, dict(base, body="human edit", revision=1))
    add("agent-and-human-race", base, dict(current, body="human remote"), dict(base, body="human local", revision=1))
    add("human-completion-override", base, current, dict(base, completed=True, body="human edit", revision=1))
    driver = """<?php
function canonical(mixed $v):mixed { if(!is_array($v))return $v;if(array_is_list($v))return array_map('canonical',$v);ksort($v);return array_map('canonical',$v); }
function stamp():string { return '2026-11-27T00:00:00.000Z'; }
require $argv[1]; require $argv[2];
$cases=json_decode(file_get_contents('php://stdin'),true,512,JSON_THROW_ON_ERROR);
foreach($cases as &$case) {
    $merged=is_array($case['current'])&&is_array($case['incoming'])?merge_protocol_write($case['current'],$case['incoming'],$case['base'],'cards'):null;
    $case['expected']=$merged??merge_fields($case['base'],$case['current'],$case['incoming']);
}
echo json_encode($cases,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
"""
    with tempfile.TemporaryDirectory(prefix="nabbit-tack-merge-") as directory:
        script = Path(directory) / "reference.php"
        script.write_text(driver, encoding="utf-8")
        result = subprocess.run(["php", "-n", str(script), str(args.merge.resolve()), str(args.sharing.resolve())], input=json.dumps(cases).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    output = Path(__file__).resolve().parent.parent / "src-tauri/tests/fixtures/tack/merge.json"
    output.write_text(json.dumps(json.loads(result.stdout), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(dict(cases=len(cases), php=subprocess.check_output(["php", "-n", "-v"]).decode().splitlines()[0], sha256=hashlib.sha256(output.read_bytes()).hexdigest())))


if __name__ == "__main__":
    main()
