# KiCad workflow tools

Three small tools for working on `NTC_SENSOR`. Each exists because something
went wrong without it — see the docstring in each file for the specific
incident.

Requires KiCad 10 (`kicad-cli` is found automatically, or set `KICAD_CLI`),
plus `pypdfium2` and `pillow` for `view.py`.

---

## `drc_diff.py` — what broke *since the baseline*

```bash
python tools/kicad/drc_diff.py <board.kicad_pcb> [--baseline HEAD]
```

Runs DRC twice — on the working file and on the same file at a git revision —
and reports only what changed. Exits non-zero when something new appeared, so
it works as a gate.

A raw DRC run on this board returns dozens of violations, most of them
long-standing, and a genuinely new fault reads as noise among them. `bat_ADC`
lost its connection to `U1` pad 27 during layout and was invisible for an hour
for exactly that reason.

The baseline copy is written into the real project directory on purpose:
`fp-lib-table` and the sibling `.kicad_pro` resolve relative to the project, so
a board evaluated from somewhere else reports footprint-link failures for every
custom-library part.

Violation identity deliberately ignores coordinates — nudging a part 0.2 mm
should not make every violation look new. The cost is that distinct violations
can share an identity, so occurrences are **counted** rather than
deduplicated and reported as `x7`. Seven isolated copper fills in one zone
are seven warnings whose only distinguishing feature is a position, and KiCad
reports `pos: null` for that check — the first version of this tool said `x1`
and lost six of them.

## `sch_diff.py` — reviewing a schematic that was rewritten wholesale

```bash
python tools/kicad/sch_diff.py <schematic.kicad_sch> [--baseline HEAD]
```

`git diff` is useless here. Konnect reserialises the entire `.kicad_sch` on
every write, so adding one symbol produced a **19,235-line diff** on a
9,420-line file — in which "the tool rewrote everything" and "the tool ate
something" look identical.

This compares facts instead: symbols added, removed or changed; global-label
counts per net; wire, junction and no-connect totals; and the number of named
symbol blocks. It flags a newly added symbol with no footprint, since that
silently never reaches the board.

It answers *"did anything change that I did not ask for"*. Run ERC as well — it
does not check electrical validity.

## `view.py` — look at the board

```bash
python tools/kicad/view.py <board.kicad_pcb> [-o out.png] [-l LAYERS] [-w PX]
```

Exports a composite layer plot and rasterises it. Default layers are chosen for
placement review rather than looks: `F.CrtYd` (the courtyards, i.e. the thing
that actually collides), `F.Cu`/`B.Cu` (where copper already is) and
`Edge.Cuts` (so "outside the board" is visible).

At the default width that is roughly 25 px/mm on this board — enough to judge
whether a part sits on a trace, never enough to judge a 0.2 mm clearance. DRC
remains the authority.

---

**All three read the saved file.** Unsaved edits in an open pcbnew are invisible
to them, exactly as they are to DRC. Save first.
