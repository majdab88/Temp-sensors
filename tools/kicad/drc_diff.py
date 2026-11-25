"""Run DRC and report only what is NEW since a git baseline.

    python tools/kicad/drc_diff.py <board.kicad_pcb> [--baseline HEAD]

Why this exists: while laying out the panel-button block, bat_ADC quietly lost
its connection from U1 pad 27 to its B.Cu track. A raw DRC run says "1
unconnected item" among a pile of pre-existing violations and it reads as
noise. The pristine board reported zero unconnected items, so the break was
only obvious *against the baseline*. A broken battery divider reports a wrong
percentage, which in a freezer looks like a flat cell rather than a fault —
this is exactly the class of defect that must not be discovered later.

So: two DRC runs, and a diff. New violations are what you act on; resolved ones
are there so a fix can be seen to have worked.
"""

import argparse
from collections import Counter
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import git_repo_for, git_show, kicad_cli, run  # noqa: E402


def drc(board: Path) -> list:
    """Return DRC violations plus unconnected items for one board file."""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "drc.json"
        r = run([
            kicad_cli(), "pcb", "drc",
            "--output", str(out), "--format", "json",
            "--severity-error", "--severity-warning",
            str(board),
        ])
        if not out.is_file():
            sys.exit(f"DRC failed on {board}:\n{r.stdout}\n{r.stderr}")
        d = json.loads(out.read_text(encoding="utf-8"))

    items = []
    for v in d.get("violations", []):
        items.append(("violation", v))
    # kicad-cli reports these in their own list, not under violations, and they
    # are the ones that matter most: an unconnected pad is a board that does not
    # work, not a style complaint.
    for v in d.get("unconnected_items", []):
        items.append(("unconnected", v))
    return items


def signature(kind: str, v: dict) -> str:
    """A stable identity for one violation.

    Deliberately excludes coordinates. Nudging a part by 0.2 mm changes every
    position in the report; it does not make the violation a different one.
    The item descriptions name the components involved, which is what
    distinguishes two violations of the same type.

    The cost is that genuinely distinct violations can share a signature —
    seven isolated copper fills in one zone are seven separate warnings whose
    only distinguishing feature is a position, and KiCad reports `pos: null`
    for that check anyway. So signatures are COUNTED rather than deduplicated;
    an earlier version reported "x1" for those seven and quietly lost six.
    """
    parts = sorted((i.get("description") or "") for i in v.get("items", []))
    return json.dumps([kind, v.get("type") or v.get("rule"), parts], sort_keys=True)


def describe(v: dict) -> str:
    sev = v.get("severity", "?")
    rule = v.get("type") or v.get("rule") or "?"
    who = "; ".join((i.get("description") or "")[:70] for i in v.get("items", [])[:2])
    return f"[{sev:7}] {rule:24} {who}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("board", type=Path)
    ap.add_argument("--baseline", default="HEAD",
                    help="git revision to compare against (default HEAD)")
    a = ap.parse_args()
    board = a.board.resolve()
    if not board.is_file():
        sys.exit(f"no such board: {board}")

    repo = git_repo_for(board)
    rel = board.relative_to(repo).as_posix()
    base_text = git_show(repo, a.baseline, rel)

    # The baseline copy MUST live in the real project directory. DRC resolves
    # fp-lib-table and the sibling .kicad_pro relative to the project, so a
    # board evaluated from a temp directory elsewhere reports footprint_link
    # failures for every custom-library part — noise that looks like real
    # findings. Same folder, throwaway name, deleted afterwards.
    tmp = board.with_name(f".drcbase_{board.name}")
    try:
        tmp.write_text(base_text, encoding="utf-8", newline="")
        base_items = drc(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    cur_items = drc(board)

    def tally(items):
        """signature -> occurrence count, plus one exemplar for printing."""
        counts, sample = Counter(), {}
        for kind, v in items:
            sig = signature(kind, v)
            counts[sig] += 1
            sample.setdefault(sig, v)
        return counts, sample

    base, base_ex = tally(base_items)
    cur, cur_ex = tally(cur_items)

    appeared = [s for s in cur if s not in base]
    increased = [s for s in cur if s in base and cur[s] > base[s]]
    resolved = [s for s in base if s not in cur]
    reduced = [s for s in base if s in cur and cur[s] < base[s]]

    def line(sig, ex, n, was=None):
        mult = f"  x{n}" if n > 1 else ""
        delta = f"   (was x{was})" if was is not None else ""
        return "  " + describe(ex) + mult + delta

    print(f"baseline {a.baseline}: {sum(base.values())} violation(s)   "
          f"current: {sum(cur.values())}")
    print()

    new_total = sum(cur[s] for s in appeared) + sum(cur[s] - base[s] for s in increased)
    if appeared or increased:
        print(f"NEW ({new_total}) — introduced since {a.baseline}:")
        for s in sorted(appeared, key=lambda s: cur_ex[s].get("severity", "")):
            print(line(s, cur_ex[s], cur[s]))
        for s in sorted(increased, key=lambda s: cur_ex[s].get("severity", "")):
            print(line(s, cur_ex[s], cur[s], was=base[s]))
    else:
        print("NEW (0) — nothing introduced since the baseline.")

    if resolved or reduced:
        print()
        print(f"RESOLVED ({sum(base[s] for s in resolved) + sum(base[s] - cur[s] for s in reduced)}):")
        for s in resolved:
            print(line(s, base_ex[s], base[s]))
        for s in reduced:
            print(line(s, base_ex[s], cur[s], was=base[s]))

    unchanged = sum(min(cur[s], base[s]) for s in set(cur) & set(base))
    print()
    print(f"unchanged: {unchanged}")
    # Non-zero exit only for new problems: pre-existing ones are not this run's
    # business, so this stays usable as a gate.
    sys.exit(1 if new_total else 0)


if __name__ == "__main__":
    main()
