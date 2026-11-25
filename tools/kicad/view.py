"""Render a layer-aware view of a board as a PNG.

    python tools/kicad/view.py <board.kicad_pcb> [-o out.png] [-l LAYERS] [-w PX]

Why this exists: reading a board from `get_component_list` gives footprint
origins and nothing else — no courtyards, no bodies, no copper. Placing from
that put three parts on top of existing traces and one through SW1. A picture
showing F.CrtYd is the cheapest way to catch that class of mistake before
anyone else sees it.

The default layer set is chosen for placement review, not for looking pretty:

    F.CrtYd    the courtyards, i.e. the thing that actually collides
    F.Cu/B.Cu  where copper already is
    Edge.Cuts  the outline, so "outside the board" is visible

Note this renders the FILE. Unsaved edits in an open pcbnew are invisible here,
exactly as they are to DRC.
"""

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import kicad_cli, run  # noqa: E402

DEFAULT_LAYERS = "F.Cu,B.Cu,Edge.Cuts,F.CrtYd"


def render(board: Path, out: Path, layers: str, width: int) -> None:
    with tempfile.TemporaryDirectory() as td:
        pdf = Path(td) / "board.pdf"
        # --mode-single composites every layer onto one page. Without it
        # kicad-cli writes one file per layer and there is nothing to look at
        # as a whole.
        r = run([
            kicad_cli(), "pcb", "export", "pdf",
            "--mode-single", "--layers", layers,
            "-o", str(pdf), str(board),
        ])
        if r.returncode != 0 or not pdf.is_file():
            sys.exit(f"kicad-cli pdf export failed:\n{r.stdout}\n{r.stderr}")

        try:
            import pypdfium2 as pdfium
            from PIL import Image, ImageChops
        except ImportError as exc:
            sys.exit(f"missing dependency: {exc}\n  pip install pypdfium2 pillow")

        # Keep the document handle: on Windows the temp directory cannot be
        # removed while pypdfium2 still holds the file open, which surfaces as
        # a PermissionError long after the render succeeded.
        doc = pdfium.PdfDocument(str(pdf))
        page = doc[0]
        # Render generously first, then crop. KiCad plots onto a full page
        # (A4 by default), so the board occupies a small part of the sheet —
        # rendering at the final size directly would waste most of the pixels
        # on white paper.
        img = page.render(scale=4.0).to_pil().convert("RGB")
        bbox = ImageChops.difference(img, Image.new("RGB", img.size, (255, 255, 255))).getbbox()
        if bbox is None:
            sys.exit("nothing was plotted — check the layer names")
        pad = 12
        img = img.crop((
            max(0, bbox[0] - pad), max(0, bbox[1] - pad),
            min(img.size[0], bbox[2] + pad), min(img.size[1], bbox[3] + pad),
        ))
        scale = width / max(img.size)
        img = img.resize((max(1, int(img.size[0] * scale)), max(1, int(img.size[1] * scale))),
                         Image.LANCZOS)
        img.save(out)
        doc.close()

    print(f"wrote {out}  ({img.size[0]}x{img.size[1]} px)")
    print(f"layers: {layers}")
    print("Reminder: this is the saved file. Unsaved editor state is not shown.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("board", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=Path("board_view.png"))
    ap.add_argument("-l", "--layers", default=DEFAULT_LAYERS,
                    help=f"comma-separated KiCad layer names (default: {DEFAULT_LAYERS})")
    ap.add_argument("-w", "--width", type=int, default=1500,
                    help="long edge in pixels (default 1500; ~25 px/mm on a 60 mm board)")
    a = ap.parse_args()
    if not a.board.is_file():
        sys.exit(f"no such board: {a.board}")
    render(a.board, a.out, a.layers, a.width)


if __name__ == "__main__":
    main()
