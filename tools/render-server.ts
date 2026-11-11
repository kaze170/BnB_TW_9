/**
 * Render the server select stage (CSelectServerStage) with its text.
 *
 * Same approach as tools/render-channel-text.ts: the real stage supplies the
 * draw list and the row geometry, a Pillow pass supplies glyphs.
 *
 *   bun run tools/render-server.ts out.png [--rows]
 */

import { Pack } from '../src/data/pack.ts';
import { readServerList, mergeWithBuiltins } from '../src/data/serverlist.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const W = 800;
const H = 600;

interface Bmp {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

async function decodeJpeg(bytes: Uint8Array): Promise<Bmp> {
  const jpg = '/tmp/bnb-ss.jpg';
  const png = '/tmp/bnb-ss.png';
  await Bun.write(jpg, bytes);
  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      'import sys\nfrom PIL import Image\nImage.open(sys.argv[1]).convert("RGBA").save(sys.argv[2])',
      jpg,
      png,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const raw = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\n' +
        'w,h=im.size\nsys.stdout.buffer.write(w.to_bytes(4,"little")+h.to_bytes(4,"little")+im.tobytes())',
      png,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (raw.exitCode !== 0) throw new Error(raw.stderr.toString());
  const buf = new Uint8Array(raw.stdout);
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  return { width: w, height: h, rgba: new Uint8ClampedArray(buf.subarray(8, 8 + w * h * 4)) };
}

interface Quad {
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

const textures = new Map<object, Bmp>();
const drawn: { quad: Quad; bmp: Bmp }[] = [];
const renderer = {
  createTexture(bitmap: Bmp): object {
    const tex = {};
    textures.set(tex, bitmap);
    return tex;
  },
  begin(): void {
    drawn.length = 0;
  },
  draw(q: Quad & { texture: object }): void {
    const bmp = textures.get(q.texture);
    if (bmp) drawn.push({ quad: q, bmp });
  },
  end(): void {},
};

interface TextOp {
  text: string;
  x: number;
  y: number;
  size: number;
  colour: string;
  align: 'left' | 'center' | 'right';
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'server.png';
  const { SelectServerStage, PANEL, SROW, INFO } = await import('../src/stage/selectserver.ts');

  const pack = new Pack(
    'Cx',
    new Uint8Array(await Bun.file(`${ROOT}Cx.idx`).arrayBuffer()),
    new Uint8Array(await Bun.file(`${ROOT}Cx.idd`).arrayBuffer()),
  );
  const jpeg = pack.payload('MultiServer/CAStage');
  if (!jpeg) throw new Error('MultiServer/CAStage missing');
  const art = await decodeJpeg(jpeg);
  console.log(`art ${art.width}x${art.height} (${jpeg.length} byte JPEG in Cx.idd)`);

  const realms = mergeWithBuiltins(
    readServerList(new Uint8Array(await Bun.file(`${ROOT}multisvr.ssd`).arrayBuffer())),
  );
  const rows = realms.map((e) => ({ address: e.address, port: e.port, label: e.address }));

  const stage = new SelectServerStage(renderer as never);
  stage.setBackground({ width: art.width, height: art.height } as never);
  const uploaded = [...textures.values()][0];
  if (uploaded) Object.assign(uploaded, art);
  stage.setRows(rows, 0);
  stage.render();

  const dst = new Uint8ClampedArray(W * H * 4);
  for (const { quad, bmp } of drawn) {
    for (let y = 0; y < quad.dh; y++) {
      const sy = ((y * quad.sh) / quad.dh) | 0;
      const ty = quad.dy + y;
      if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < quad.dw; x++) {
        const sx = ((x * quad.sw) / quad.dw) | 0;
        const tx = quad.dx + x;
        if (tx < 0 || tx >= W) continue;
        const s = ((quad.sy + sy) * bmp.width + (quad.sx + sx)) * 4;
        const d = (ty * W + tx) * 4;
        dst[d] = bmp.rgba[s]!;
        dst[d + 1] = bmp.rgba[s + 1]!;
        dst[d + 2] = bmp.rgba[s + 2]!;
        dst[d + 3] = 255;
      }
    }
  }
  console.log(`replayed ${drawn.length} quad(s)`);

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
  wash(PANEL.x + SROW.x, PANEL.y + SROW.y, SROW.w, SROW.rowH - 1, [255, 255, 255, 90]);

  if (process.argv.includes('--rows')) {
    for (let i = 0; i < SROW.rows; i++) {
      wash(PANEL.x + SROW.x, PANEL.y + SROW.y + i * SROW.rowH, 2, SROW.rowH - 1, [255, 40, 40, 255]);
    }
    wash(PANEL.x + INFO.x, PANEL.y + INFO.y, 2, INFO.h, [255, 40, 40, 255]);
    console.log(`rows x=${PANEL.x + SROW.x} y=${PANEL.y + SROW.y} w=${SROW.w} rowH=${SROW.rowH} visible=${SROW.rows}`);
    console.log(`info x=${PANEL.x + INFO.x} y=${PANEL.y + INFO.y} ${INFO.w}x${INFO.h}`);
  }

  // The stage's text pass.
  const ops: TextOp[] = [];
  for (let i = 0; i < Math.min(rows.length, SROW.rows); i++) {
    const row = rows[i]!;
    const x = PANEL.x + SROW.x;
    const y = PANEL.y + SROW.y + i * SROW.rowH;
    ops.push({ text: row.label, x: x + 4, y: y + 5, size: 12, colour: '#ffffff', align: 'left' });
    ops.push({ text: `:${row.port}`, x: x + SROW.w - 4, y: y + 5, size: 11, colour: '#cfe6ff', align: 'right' });
    console.log(`  row ${i}: ${row.address}:${row.port} at ${x},${y}`);
  }
  ops.push({ text: rows[0]!.address, x: PANEL.x + INFO.x + 6, y: PANEL.y + INFO.y + 8, size: 12, colour: '#ffffff', align: 'left' });
  ops.push({ text: `port ${rows[0]!.port}`, x: PANEL.x + INFO.x + 6, y: PANEL.y + INFO.y + 26, size: 12, colour: '#d8d8d8', align: 'left' });

  const { encodePNG } = await import('./ppm2png.ts');
  const base = '/tmp/bnb-ss-base.png';
  await Bun.write(base, encodePNG(W, H, new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)));

  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      `import json, sys
from PIL import Image, ImageDraw, ImageFont
im = Image.open(sys.argv[1]).convert('RGBA')
d = ImageDraw.Draw(im)
for op in json.loads(sys.argv[3]):
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', op['size'])
    w = d.textlength(op['text'], font=f)
    dx = op['x'] - (w/2 if op['align']=='center' else w if op['align']=='right' else 0)
    d.text((dx, op['y']), op['text'], font=f, fill=op['colour'])
im.convert('RGB').save(sys.argv[2])
print('rendered %d text op(s)' % len(json.loads(sys.argv[3])))`,
      base,
      out,
      JSON.stringify(ops),
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  console.log(proc.stdout.toString().trim());
  console.log(`wrote ${out}`);
}

await main();
