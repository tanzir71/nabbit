"""Add only disposable keyboard/pin fixtures after the normal isolated seed."""
import pathlib,sqlite3,sys
directory=pathlib.Path(sys.argv[1]).resolve()
assert '.tools' in directory.parts and directory.name=='app-data'
fixture=directory/'keyboard-fixtures';fixture.mkdir()
with sqlite3.connect(directory/'nabbit.sqlite3') as db:
    db.execute("CREATE TABLE IF NOT EXISTS pins (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, label TEXT, slot INTEGER, sort TEXT NOT NULL DEFAULT 'name', verb TEXT, added_at TEXT, last_used TEXT)")
    for slot in range(1,10):
        path=fixture/f'Invoice-{slot}.txt'
        if slot==1:path.mkdir()
        else:path.write_text('Owned keyboard fixture; shell launch is injected.\n')
        db.execute("INSERT INTO pins(id,kind,path,label,slot) VALUES(?,?,?,?,?)",(f'pin-{slot}','folder' if slot==1 else 'file',str(path),f'Invoice PDF {slot}',slot))
print('Seeded nine owned pin slots; no user paths or applications.')
