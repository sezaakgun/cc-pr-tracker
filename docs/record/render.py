# render `tmux capture-pane -e -p` output (SGR only) to a PNG, like a dark terminal
import re, sys
from PIL import Image, ImageDraw, ImageFont
FS = 15
F = {(b, i): ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/DejaVuSansMono{s}.ttf", FS)
     for (b, i), s in {(0, 0): '', (1, 0): '-Bold', (0, 1): '-Oblique', (1, 1): '-BoldOblique'}.items()}
CW, CH, PAD = 9, 19, 12
from fontTools.ttLib import TTFont
HAS = set(TTFont('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf').getBestCmap())
FB = ImageFont.truetype('/usr/share/fonts/truetype/freefont/FreeMono.ttf', FS + 1)
BG, FG = (13, 13, 13), (220, 220, 220)
BASE = [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(229,229,229),
        (102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)]
def c256(n):
    if n < 16: return BASE[n]
    if n < 232:
        n -= 16; v = [0, 95, 135, 175, 215, 255]; return (v[n // 36], v[n // 6 % 6], v[n % 6])
    g = 8 + (n - 232) * 10; return (g, g, g)
def parse(text, cols, rows):
    grid = [[(' ', {}) for _ in range(cols)] for _ in range(rows)]
    for y, line in enumerate(text.split('\n')[:rows]):
        st, x = {}, 0
        for m in re.finditer(r'\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|([^\x1b])', line):
            if m.group(2) is not None:
                ch = m.group(2)
                if x < cols: grid[y][x] = (ch, dict(st))
                x += 2 if ord(ch) > 0x2e7f and not (0x2500 <= ord(ch) < 0x2bff) else 1
                continue
            if m.group(1) is None: continue
            ps = [int(p) if p else 0 for p in re.split('[;:]', m.group(1))] or [0]
            i = 0
            while i < len(ps):
                p = ps[i]
                if p == 0: st = {}
                elif p == 1: st['b'] = 1
                elif p == 2: st['dim'] = 1
                elif p == 3: st['i'] = 1
                elif p == 4: st['u'] = 1
                elif p == 7: st['inv'] = 1
                elif p == 9: st['s'] = 1
                elif p == 22: st.pop('b', None); st.pop('dim', None)
                elif p == 23: st.pop('i', None)
                elif p == 24: st.pop('u', None)
                elif p == 27: st.pop('inv', None)
                elif p == 29: st.pop('s', None)
                elif 30 <= p <= 37: st['fg'] = BASE[p - 30]
                elif 90 <= p <= 97: st['fg'] = BASE[p - 82]
                elif 40 <= p <= 47: st['bg'] = BASE[p - 40]
                elif 100 <= p <= 107: st['bg'] = BASE[p - 92]
                elif p == 39: st.pop('fg', None)
                elif p == 49: st.pop('bg', None)
                elif p in (38, 48):
                    k = 'fg' if p == 38 else 'bg'
                    if ps[i + 1] == 5: st[k] = c256(ps[i + 2]); i += 2
                    elif ps[i + 1] == 2: st[k] = tuple(ps[i + 2:i + 5]); i += 4
                i += 1
    return grid
def render(text, out, cols=150, rows=40):
    grid = parse(text, cols, rows)
    im = Image.new('RGB', (cols * CW + 2 * PAD, rows * CH + 2 * PAD), BG)
    d = ImageDraw.Draw(im)
    for y, row in enumerate(grid):
        for x, (ch, st) in enumerate(row):
            fg, bg = st.get('fg', FG), st.get('bg')
            if st.get('inv'): fg, bg = (bg or BG), fg
            if st.get('dim'): fg = tuple(int(c * 0.6 + BG[i] * 0.4) for i, c in enumerate(fg))
            px, py = PAD + x * CW, PAD + y * CH
            if bg: d.rectangle([px, py, px + CW - 1, py + CH - 1], fill=bg)
            if ch != ' ':
                if 0x2580 <= ord(ch) <= 0x259f or 0x2500 <= ord(ch) <= 0x257f:
                    d.text((px, py + 1), ch, font=F[(0, 0)], fill=fg)
                else:
                    d.text((px, py + 2), ch, font=F[(st.get('b', 0), st.get('i', 0))] if ord(ch) in HAS else FB, fill=fg)
            if st.get('u'): d.line([px, py + CH - 3, px + CW, py + CH - 3], fill=fg)
            if st.get('s'): d.line([px, py + CH // 2 + 1, px + CW, py + CH // 2 + 1], fill=fg)
    im.save(out)
if __name__ == '__main__':
    render(open(sys.argv[1], encoding='utf-8', errors='replace').read(), sys.argv[2])
