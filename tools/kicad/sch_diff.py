"""Diff a schematic semantically against a git baseline.

    python tools/kicad/sch_diff.py <schematic.kicad_sch> [--baseline HEAD]

Why this exists: `git diff` is useless on a .kicad_sch touched by tooling.
Konnect reserialises the whole file on every write, so adding one symbol
produced a 19,235-line diff on a 9,420-line file. Nothing in that is
reviewable, and "the diff is huge" is indistinguishable from "the tool ate
something".

This compares the facts instead: which symbols exist, what they are, and how
much connectivity there is. Running it after four symbol adds and twelve
connections is what established that the rewrite was lossless rather than
merely large.

It is deliberately not a parser for the whole format — it answers "did anything
disappear or change that I did not ask for", which is the question that matters
after a tool rewrites a file.
"""

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import git_repo_for, git_show  # noqa: E402

# Counted rather than parsed. A change in these totals is a reliable signal
# that connectivity moved, without needing to model wire geometry.
COUNTED = ["(wire", "(junction", "(global_label", "(label", "(no_connect", "(bus_entry"]


def symbols(text: str) -> dict:
    """reference -> (lib_id, value, footprint) for every placed symbol."""
    out = {}
    for m in re.finditer(r'\(symbol\s*\n\s*\(lib_id "([^"]+)"', text):
        # 6000 chars comfortably covers one symbol instance including its
        # property block; the next instance's lib_id would fall outside it.
        blk = text[m.start():m.start() + 6000]

        def prop(name):
            mm = re.search(r'\(property "%s" "([^"]*)"' % name, blk)
            return mm.group(1) if mm else None

        ref = prop("Reference")
        if ref:
            out[ref] = (m.group(1), prop("Value"), prop("Footprint"))
    return out


def labels(text: str) -> dict:
    d = {}
    for n in re.findall(r'\(global_label "([^"]*)"', text):
        d[n] = d.get(n, 0) + 1
    return d


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("schematic", type=Path)
    ap.add_argument("--baseline", default="HEAD")
    a = ap.parse_args()
    sch = a.schematic.resolve()
    if not sch.is_file():
        sys.exit(f"no such schematic: {sch}")

    repo = git_repo_for(sch)
    before = git_show(repo, a.baseline, sch.relative_to(repo).as_posix())
    after = sch.read_text(encoding="utf-8")

    b, c = symbols(before), symbols(after)
    added = sorted(set(c) - set(b))
    removed = sorted(set(b) - set(c))
    changed = sorted(k for k in set(b) & set(c) if b[k] != c[k])

    print(f"symbols: {len(b)} -> {len(c)}")
    if added:
        print(f"\nADDED ({len(added)}):")
        for k in added:
            lib, val, fp = c[k]
            print(f"  + {k:<10} {lib:<34} {val or ''}")
            if not fp:
                # A symbol with no footprint never reaches the board, and the
                # sync reports success regardless. Worth shouting about.
                print(f"    {'':<10} !! no footprint assigned")
    if removed:
        print(f"\nREMOVED ({len(removed)}):   <-- verify this was intended")
        for k in removed:
            print(f"  - {k:<10} {b[k][0]}")
    if changed:
        print(f"\nCHANGED ({len(changed)}):")
        for k in changed:
            for field, ob, oc in zip(("lib_id", "value", "footprint"), b[k], c[k]):
                if ob != oc:
                    print(f"  ~ {k:<10} {field}: {ob!r} -> {oc!r}")
    if not (added or removed or changed):
        print("  (no symbol-level differences)")

    lb, lc = labels(before), labels(after)
    net_rows = [(n, lb.get(n, 0), lc.get(n, 0)) for n in sorted(set(lb) | set(lc))
                if lb.get(n, 0) != lc.get(n, 0)]
    if net_rows:
        print("\nGLOBAL LABELS (net membership changed):")
        for n, x, y in net_rows:
            flag = "  <-- net lost all labels" if y == 0 else ""
            print(f"  {n:<16} {x} -> {y}{flag}")

    print("\nCONNECTIVITY TOTALS:")
    for tag in COUNTED:
        x, y = before.count(tag), after.count(tag)
        if x or y:
            print(f"  {tag[1:]:<14} {x:>5} -> {y:<5}{'' if x == y else '   CHANGED'}")

    # Named symbol blocks live in (lib_symbols ...) — the sheet's private copy
    # of every symbol it uses. Losing one is how a schematic starts drawing
    # blank boxes, so it is worth watching, even though this count includes
    # sub-units alongside top-level definitions.
    nb = len(re.findall(r'\(symbol "', before))
    nc = len(re.findall(r'\(symbol "', after))
    print(f"\nnamed symbol blocks (lib_symbols + units): {nb} -> {nc}"
          f"{'' if nb == nc else '   CHANGED'}")
    print("\nRun ERC as well — this compares structure, not electrical validity.")


if __name__ == "__main__":
    main()
