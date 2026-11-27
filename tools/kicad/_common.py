"""Shared helpers for the KiCad tools in this directory.

Everything here exists because of something that actually went wrong while
working on NTC_SENSOR, not because it seemed tidy.
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# KiCad 10 first, deliberately. Both 9.0 and 10.0 are installed on the dev
# machine and NTC_SENSOR.kicad_pcb is a KiCad 10 file (format 20260206, with
# name-based `(net "GND")` pad syntax). Opening it with 9.0 risks a silent
# format downgrade, so the newer version wins unless KICAD_CLI overrides.
_CLI_CANDIDATES = [
    r"C:\Program Files\KiCad\10.0\bin\kicad-cli.exe",
    r"C:\Program Files\KiCad\9.0\bin\kicad-cli.exe",
    "/usr/bin/kicad-cli",
    "/usr/local/bin/kicad-cli",
]


def kicad_cli() -> str:
    """Absolute path to kicad-cli, or exit with a useful message.

    Never returns a bare "kicad-cli": relying on PATH is exactly how Konnect's
    own ERC broke (it spawned the bare name and failed on a machine where
    KiCad's bin is not on PATH).
    """
    override = os.environ.get("KICAD_CLI")
    if override and Path(override).is_file():
        return override
    for c in _CLI_CANDIDATES:
        if Path(c).is_file():
            return c
    found = shutil.which("kicad-cli")
    if found:
        return found
    sys.exit(
        "kicad-cli not found. Set KICAD_CLI to its full path, e.g.\n"
        r"  KICAD_CLI='C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'"
    )


def run(args, **kw):
    """Run a command as a list — never through a shell.

    Every path here contains spaces ("Program Files", "Temp32"), and shell
    quoting on Windows is a reliable source of silent breakage.
    """
    return subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw
    )


def git_show(repo: Path, rev: str, relpath: str) -> str:
    """Return a file's contents at a git revision, or exit explaining why not."""
    r = run(["git", "-C", str(repo), "show", f"{rev}:{relpath}"])
    if r.returncode != 0:
        sys.exit(
            f"could not read {relpath} at {rev}:\n{r.stderr.strip()}\n"
            "Is this file committed, and is the revision valid?"
        )
    return r.stdout


def git_repo_for(path: Path) -> Path:
    r = run(["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"])
    if r.returncode != 0:
        sys.exit(f"{path.parent} is not inside a git repository — no baseline to diff against.")
    return Path(r.stdout.strip())


def load_json(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
