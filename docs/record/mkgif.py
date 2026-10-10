import glob, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from render import render
from PIL import Image
d = sys.argv[1]; out = sys.argv[2]
fs = sorted(glob.glob(d + '/*.ans'))
frames, durs, prev = [], [], None
for i, f in enumerate(fs):
    t = int(os.path.basename(f)[:-4]); txt = open(f, encoding='utf-8', errors='replace').read()
    if txt == prev: continue
    prev = txt
    p = f[:-4] + '.png'; render(txt, p); frames.append((t, p))
ims, ds = [], []
for k, (t, p) in enumerate(frames):
    nt = frames[k + 1][0] if k + 1 < len(frames) else t + 2500
    ims.append(Image.open(p).convert('RGB')); ds.append(max(40, nt - t))
pal = ims[-1].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in ims]
q[0].save(out, save_all=True, append_images=q[1:], duration=ds, loop=0, optimize=True)
print(len(q), sum(ds))
