"""Seed only the disposable V0 database; never use the user's normal app data."""
import datetime
import json
import pathlib
import sqlite3
import sys

directory = pathlib.Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
settings = {
    "retentionDays": 30, "captureImages": True, "imageSizeCapMb": 10,
    "pasteOnSelect": False, "sensitiveHeuristics": False, "autoDetectLinks": False,
    "showDetectNotification": False, "pauseAutoDetect": True, "launchAtLogin": False,
    "startHidden": True, "showDockIcon": False, "togglePopoverShortcut": "",
    "quickDownloadShortcut": "", "clipboardSearchShortcut": "", "defaultQuality": "1080p",
    "outputDir": "", "filenameTemplate": "%(title)s [%(id)s].%(ext)s",
    "maxConcurrentDownloads": 2, "revealAfterDownload": False, "engineAutoUpdate": False,
    "firstRunAcknowledged": True, "lastTab": "download",
}
with sqlite3.connect(directory / "nabbit.sqlite3") as database:
    database.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)")
    database.execute("INSERT OR REPLACE INTO settings VALUES (?, ?, ?)",
                     ("app_settings", json.dumps(settings), datetime.datetime.now(datetime.timezone.utc).isoformat()))
