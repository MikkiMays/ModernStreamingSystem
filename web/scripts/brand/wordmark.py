"""Outline the Cord wordmark ("cord" + accent dot) from Inter Variable into the 30-px logo box.

The lockup repeats the old text logo exactly: 29 px Inter at weight 730, letter-spacing -1.6 px,
a 30-px symbol, 13 px between them, and the baseline 25.5 px below the top of the symbol box
(where `align-items: center` with `line-height: 1` used to put it).
"""
import io, json, sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
import uharfbuzz as hb

src, weight = sys.argv[1], float(sys.argv[2])
static = instantiateVariableFont(TTFont(src), {"wght": weight})
buf = io.BytesIO(); static.flavor = None; static.save(buf)
upm = static["head"].unitsPerEm
hbfont = hb.Font(hb.Face(buf.getvalue()))
size, origin_x, baseline = 29.0, 43.0, 25.5
scale = size / upm
tracking = -1.6 / scale            # px → font units

def shape(text):
    b = hb.Buffer(); b.add_str(text); b.guess_segment_properties()
    hb.shape(hbfont, b, {"kern": True})
    return list(zip(b.glyph_infos, b.glyph_positions))

glyphs = static.getGlyphSet(); order = static.getGlyphOrder()
fmt = lambda v: (f"{v:.2f}".rstrip('0').rstrip('.') or '0')
def outline(name, dx):
    matrix = (scale, 0, 0, -scale, origin_x + dx * scale, baseline)
    pen = SVGPathPen(glyphs, fmt); glyphs[name].draw(TransformPen(pen, matrix))
    bp = BoundsPen(glyphs); glyphs[name].draw(TransformPen(bp, matrix))
    return pen.getCommands(), bp.bounds

x = 0.0; word = []; boxes = []
for info, pos in shape("cord"):
    d, b = outline(order[info.codepoint], x + pos.x_offset); word.append(d); boxes.append(b)
    x += pos.x_advance + tracking
# The old `.brand-dot { margin-left: -11px }` only cancelled the 11-px flex gap of `.brand`, so the
# period sits right after "d", spaced like any other letter.
dot, dot_box = outline(order[shape(".")[0][0].codepoint], x)
right = max(b[2] for b in boxes + [dot_box])
json.dump({"word": " ".join(word), "dot": dot, "right": right,
           "top": min(b[1] for b in boxes), "bottom": max(b[3] for b in boxes)}, sys.stdout)
