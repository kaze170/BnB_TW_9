/**
 * Render the channel select stage to a PNG, driving the real ChannelStage.
 *
 * The stage's draw list is replayed through a software blit (there is no GPU
 * here) and its overlay rects are composed by hand, because bun has no canvas.
 * The row geometry comes from the stage's own exported constants, so this file
 * cannot drift from what the browser paints.
 *
 * The channel rows come from the shipped `channel2_000.ssd` through
 * src/data/channel.ts: the same records the server puts on the wire.
 *
 *   bun run tools/render-channel.ts out.png [--rows]
 */

import { Pack } from '../src/data/pack.ts';
import { readChannelFile } from '../src/data/channel.ts';
import { encodePNG } from './ppm2png.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const W = 800;
const H = 600;

interface Bmp {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

// --- browser stubs the stage touches ---------------------------------------

(globalThis as Record<string, unknown>).ImageData = class {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

async function decodeJpeg(bytes: Uint8Array): Promise<Bmp> {
  const jpg = '/tmp/bnb-channel.jpg';
  const pam = '/tmp/bnb-channel.ppm';
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

(globalThis as Record<string, unknown>).createImageBitmap = async (src: unknown): Promise<Bmp> => {
  const s = src as { width?: number; height?: number; data?: Uint8ClampedArray };
  if (s && typeof s.width === 'number' && s.data) {
    return { width: s.width, height: s.height!, rgba: new Uint8ClampedArray(s.data) };
  }
  if (src instanceof Blob) return decodeJpeg(new Uint8Array(await src.arrayBuffer()));
  throw new Error('unsupported bitmap source');
};

// --- recording renderer ----------------------------------------------------

interface Quad {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const textures = new Map<object, Bmp>();
const drawn: { quad: Quad; bmp: Bmp }[] = [];

const renderer = {
  createTexture(bitmap: Bmp): object {
    const tex = { id: textures.size };
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

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'channel.png';
  const { ChannelStage, LIST_RECT, WELL_RECT } = await import('../src/stage/channel.ts');

  const pack = new Pack(
    'Cx',
    new Uint8Array(await Bun.file(`${ROOT}Cx.idx`).arrayBuffer()),
    new Uint8Array(await Bun.file(`${ROOT}Cx.idd`).arrayBuffer()),
  );
  const jpeg = pack.payload('StageChannel/CAStage');
  if (!jpeg) throw new Error('StageChannel/CAStage missing');
  const back = await decodeJpeg(jpeg);
  console.log(`background ${back.width}x${back.height} (${jpeg.length} byte JPEG in Cx.idd)`);

  const stage = new ChannelStage(renderer as never);
  // Feed the already-decoded bitmap: the stage only needs something
  // createTexture-shaped, and we keep the pixels here.
  stage.setBackground({ width: back.width, height: back.height } as never);
  // The stage uploaded the object above; swap in the real pixels for replay.
  const uploaded = [...textures.values()][0];
  if (uploaded) Object.assign(uploaded, back);

  const chFile = readChannelFile(
    new Uint8Array(await Bun.file(`${ROOT}channel2_000.ssd`).arrayBuffer()),
    'channel2_000.ssd',
  );
  const channels = chFile?.channels ?? [];
  stage.setChannels(channels);
  stage.render();

  // Replay.
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
        const a = bmp.rgba[s + 3]!;
        if (!a) continue;
        dst[d] = bmp.rgba[s]!;
        dst[d + 1] = bmp.rgba[s + 1]!;
        dst[d + 2] = bmp.rgba[s + 2]!;
        dst[d + 3] = 255;
      }
    }
  }
  console.log(`replayed ${drawn.length} quad(s)`);

  // Overlay: a translucent wash over the list and a marker on each row edge,
  // so the row geometry can be checked against the art without a font.
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
        dst[o + 3] = 255;
      }
    }
  };

  if (process.argv.includes('--rows')) {
    wash(LIST_RECT.x, LIST_RECT.y, LIST_RECT.w, LIST_RECT.rows * LIST_RECT.rowH, [255, 255, 255, 26]);
    for (let i = 0; i < LIST_RECT.rows; i++) {
      wash(LIST_RECT.x, LIST_RECT.y + i * LIST_RECT.rowH, 2, LIST_RECT.rowH - 1, [255, 40, 40, 255]);
    }
    for (const x of WELL_RECT.x) wash(x, WELL_RECT.y, 2, WELL_RECT.h, [255, 40, 40, 255]);
    console.log(`list ${LIST_RECT.x},${LIST_RECT.y} ${LIST_RECT.w}x${LIST_RECT.rows * LIST_RECT.rowH}, rowH ${LIST_RECT.rowH}`);
    console.log(`wells y=${WELL_RECT.y} h=${WELL_RECT.h} at x=${WELL_RECT.x.join(', ')}`);
  }

  for (let i = 0; i < Math.min(channels.length, LIST_RECT.rows); i++) {
    const c = channels[i]!;
    console.log(`  row ${i}: ${c.name}  ${c.users}/${c.maxUsers}  y=${LIST_RECT.y + i * LIST_RECT.rowH}`);
  }

  await Bun.write(out, encodePNG(W, H, new Uint8Array(dst.buffer)));
  console.log(`wrote ${out}`);
}

await main();
