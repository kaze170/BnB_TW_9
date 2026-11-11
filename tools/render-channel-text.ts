/**
 * Render the channel screen *with its text*, the way the browser does.
 *
 * tools/render-channel.ts proves the art and the row geometry; this one adds
 * the text pass, because a text layout cannot be checked without glyphs and
 * bun has no canvas.  A tiny PAM-based text compositor stands in for
 * `CanvasRenderingContext2D.fillText` (Pillow renders the same strings the
 * browser would draw), using the stage's own exported rects.
 *
 *   bun run tools/render-channel-text.ts out.png
 */

import { Pack } from '../src/data/pack.ts';
import { readChannelFile } from '../src/data/channel.ts';
import { readSsi, decodeSystemStrings } from '../src/data/ssi.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const W = 800;
const H = 600;

interface Bmp {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

async function decodeJpeg(bytes: Uint8Array): Promise<Bmp> {
  const jpg = '/tmp/bnb-ct.jpg';
  const pam = '/tmp/bnb-ct.ppm';
  await Bun.write(jpg, bytes);
  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGBA')\nw,h=im.size\n" +
        "hdr=('P7\\nWIDTH %d\\nHEIGHT %d\\nDEPTH 4\\nMAXVAL 255\\nTUPLTYPE RGB_ALPHA\\nENDHDR\\n'%(w,h)).encode()\n" +
        "open(sys.argv[2],'wb').write(hdr+im.tobytes())",
      jpg,
      pam,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const buf = new Uint8Array(await Bun.file(pam).arrayBuffer());
  const text = new TextDecoder('latin1').decode(buf.subarray(0, 256));
  const end = text.indexOf('ENDHDR\n') + 7;
  const w = Number(/WIDTH (\d+)/.exec(text)?.[1]);
  const h = Number(/HEIGHT (\d+)/.exec(text)?.[1]);
  return { width: w, height: h, rgba: new Uint8ClampedArray(buf.subarray(end, end + w * h * 4)) };
}

/** One text draw request, in the stage's logical coordinates. */
interface TextOp {
  text: string;
  x: number;
  y: number;
  size: number;
  colour: string;
  align: 'left' | 'center' | 'right';
  maxWidth?: number;
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'channel-text.png';
  const { LIST_RECT, WELL_RECT, DESC } = await import('../src/stage/channel.ts');

  const pack = new Pack(
    'Cx',
    new Uint8Array(await Bun.file(`${ROOT}Cx.idx`).arrayBuffer()),
    new Uint8Array(await Bun.file(`${ROOT}Cx.idd`).arrayBuffer()),
  );
  const jpeg = pack.payload('StageChannel/CAStage');
  if (!jpeg) throw new Error('StageChannel/CAStage missing');
  const back = await decodeJpeg(jpeg);

  const channels =
    readChannelFile(
      new Uint8Array(await Bun.file(`${ROOT}channel2_000.ssd`).arrayBuffer()),
      'channel2_000.ssd',
    )?.channels ?? [];

  const sys = decodeSystemStrings(
    readSsi(new Uint8Array(await Bun.file(`${ROOT}csysstr.ssd`).arrayBuffer()))!.payload,
  )!;
  const descFor = (position: number, kind: number): string | null =>
    sys.find((r) => r.name === `ChannelExplain${position}`)?.text ??
    sys.find((r) => r.name === `ChannelDesc${kind}`)?.text ??
    null;

  // Rebuild the stage's text pass.  These are the same calls
  // ChannelStage.renderOverlay makes.
  const ops: TextOp[] = [];
  for (let i = 0; i < Math.min(channels.length, LIST_RECT.rows); i++) {
    const c = channels[i]!;
    const y = LIST_RECT.y + i * LIST_RECT.rowH;
    ops.push({ text: c.name, x: LIST_RECT.x + 4, y: y + 5, size: 12, colour: '#ffffff', align: 'left' });
    ops.push({
      text: `${c.users}/${c.maxUsers}`,
      x: LIST_RECT.x + LIST_RECT.w - 4,
      y: y + 5,
      size: 11,
      colour: '#c8e4ff',
      align: 'right',
    });
  }
  const labels = ['進入', '佈告欄', '離開'];
  for (let i = 0; i < WELL_RECT.x.length; i++) {
    ops.push({
      text: labels[i]!,
      x: WELL_RECT.x[i]! + WELL_RECT.w / 2,
      y: WELL_RECT.y + 11,
      size: 12,
      colour: '#ffffff',
      align: 'center',
    });
  }
  const selected = 0;
  const desc = descFor(selected, channels[selected]!.kind);
  if (desc) ops.push({ text: desc, x: DESC.x, y: DESC.y + 7, size: 11, colour: '#ffffff', align: 'left', maxWidth: 200 });

  console.log(`selected ${channels[selected]!.name} (kind ${channels[selected]!.kind})`);
  console.log(`description: ${desc ?? '(none in csysstr.ssd)'}`);

  // Composite: base art, selection highlight, then the text.
  console.log(`art ${back.width}x${back.height}, rgba ${back.rgba.length}`);
  const dst = new Uint8ClampedArray(back.rgba);
  const wash = (x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): void => {
    const [r, g, b, a] = rgba;
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= H) continue;
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= W) continue;
        const o = (yy * W + xx) * 4;
        dst[o] = (dst[o]! * (255 - a) + r * a) / 255;
        dst[o + 1] = (dst[o + 1]! * (255 - a) + g * a) / 255;
        dst[o + 2] = (dst[o + 2]! * (255 - a) + b * a) / 255;
      }
    }
  };
  wash(LIST_RECT.x, LIST_RECT.y, LIST_RECT.w, LIST_RECT.rowH - 1, [255, 255, 255, 90]);

  // Hand the compositor a PNG: bun cannot render text, Pillow can, and PNG is
  // the one format both sides definitely agree on.
  const base = '/tmp/bnb-ct-base.png';
  const { encodePNG } = await import('./ppm2png.ts');
  await Bun.write(base, encodePNG(W, H, new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)));

  const opsJson = JSON.stringify(ops);
  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      TEXT_SCRIPT,
      base,
      out,
      opsJson,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  console.log(proc.stdout.toString().trim());
}

const TEXT_SCRIPT = `
import json, sys
from PIL import Image, ImageDraw, ImageFont

base, out, ops_json = sys.argv[1], sys.argv[2], sys.argv[3]
ops = json.loads(ops_json)
im = Image.open(base).convert('RGBA')
d = ImageDraw.Draw(im)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

def wrap(text, font, maxw):
    lines, line = [], ''
    for ch in text:
        t = line + ch
        if d.textlength(t, font=font) > maxw and line:
            lines.append(line); line = ch
        else:
            line = t
    if line: lines.append(line)
    return lines

for op in ops:
    font = ImageFont.truetype(FONT, op['size'])
    x, y = op['x'], op['y']
    lines = wrap(op['text'], font, op['maxWidth']) if op.get('maxWidth') else [op['text']]
    for i, ln in enumerate(lines):
        w = d.textlength(ln, font=font)
        dx = x - (w / 2 if op['align'] == 'center' else w if op['align'] == 'right' else 0)
        d.text((dx, y + i * 15), ln, font=font, fill=op['colour'])

im.convert('RGB').save(out)
print('rendered %d text op(s) -> %s' % (len(ops), out))
`;

await main();
