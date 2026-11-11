/**
 * End-to-end login stage test, no GPU and no browser.
 *
 * This drives the *real* LoginStage: it stubs the three browser globals the
 * stage touches (`ImageData`, `createImageBitmap`, and a SpriteRenderer-shaped
 * recorder) and then replays the recorded draw quads through a software blit.
 * So a diff against the original art exercises the same code the browser runs,
 * not a copy of it in the tool.
 *
 *   bun run tools/render-stage.ts out.png [--player 2]
 */

import { Pack } from '../src/data/pack.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SCREEN_W = 800;
const SCREEN_H = 600;

// --- browser global stand-ins ------------------------------------------------

interface FakeBitmap {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

class ImageDataStub {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

(globalThis as Record<string, unknown>).ImageData = ImageDataStub;

/** JPEG decoding for the one JPEG in the packs, via the system Pillow. */
async function decodeJpeg(bytes: Uint8Array): Promise<FakeBitmap> {
  const jpg = '/tmp/bnb-stage-back.jpg';
  const ppm = '/tmp/bnb-stage-back.ppm';
  await Bun.write(jpg, bytes);
  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      `import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
w, h = im.size
hdr = ('P7\\nWIDTH %d\\nHEIGHT %d\\nDEPTH 4\\nMAXVAL 255\\nTUPLTYPE RGB_ALPHA\\nENDHDR\\n' % (w, h)).encode()
open(sys.argv[2], 'wb').write(hdr + im.tobytes())`,
      jpg,
      ppm,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(`jpeg decode failed: ${proc.stderr.toString()}`);
  const buf = new Uint8Array(await Bun.file(ppm).arrayBuffer());
  // PAM header: P7, WIDTH, HEIGHT, DEPTH, MAXVAL, ENDHDR
  const text = new TextDecoder('latin1').decode(buf.subarray(0, 256));
  const end = text.indexOf('ENDHDR\n') + 'ENDHDR\n'.length;
  const w = Number(/WIDTH (\d+)/.exec(text)?.[1]);
  const h = Number(/HEIGHT (\d+)/.exec(text)?.[1]);
  return { width: w, height: h, rgba: new Uint8ClampedArray(buf.subarray(end, end + w * h * 4)) };
}

(globalThis as Record<string, unknown>).createImageBitmap = async (src: unknown): Promise<FakeBitmap> => {
  if (src instanceof ImageDataStub) {
    return { width: src.width, height: src.height, rgba: src.data };
  }
  if (src instanceof Blob) {
    return decodeJpeg(new Uint8Array(await src.arrayBuffer()));
  }
  throw new Error(`unsupported createImageBitmap source: ${String(src)}`);
};

// --- fake renderer ----------------------------------------------------------

interface RecordedQuad {
  key: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

const bitmapsByTexture = new Map<object, FakeBitmap>();
const textureKey = new Map<object, string>();

class FakeRenderer {
  beginCalls = 0;
  endCalls = 0;
  readonly quads: RecordedQuad[] = [];

  createTexture(bitmap: FakeBitmap): object {
    const tex = {};
    bitmapsByTexture.set(tex, bitmap);
    textureKey.set(tex, `${bitmap.width}x${bitmap.height}#${bitmapsByTexture.size}`);
    return tex;
  }

  begin(): void {
    this.beginCalls++;
    this.quads.length = 0;
  }

  draw(q: Omit<RecordedQuad, 'key'> & { texture: object }): void {
    const { texture, ...rest } = q;
    this.quads.push({ ...rest, key: textureKey.get(texture) ?? '?' });
  }

  end(): void {
    this.endCalls++;
  }
}

// --- software blit ----------------------------------------------------------

function blit(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  for (let y = 0; y < dh; y++) {
    const sy = ((y * sh) / dh) | 0;
    const ty = (dy + y) | 0;
    if (ty < 0 || ty >= SCREEN_H) continue;
    for (let x = 0; x < dw; x++) {
      const sx = ((x * sw) / dw) | 0;
      const tx = (dx + x) | 0;
      if (tx < 0 || tx >= SCREEN_W) continue;
      const s = (sy * sw + sx) * 4;
      const a = src[s + 3]!;
      if (!a) continue;
      const d = (ty * SCREEN_W + tx) * 4;
      if (a === 255) {
        dst[d] = src[s]!;
        dst[d + 1] = src[s + 1]!;
        dst[d + 2] = src[s + 2]!;
        dst[d + 3] = 255;
      } else {
        const ia = 255 - a;
        dst[d] = ((src[s]! * a + dst[d]! * ia) / 255) | 0;
        dst[d + 1] = ((src[s + 1]! * a + dst[d + 1]! * ia) / 255) | 0;
        dst[d + 2] = ((src[s + 2]! * a + dst[d + 2]! * ia) / 255) | 0;
        dst[d + 3] = Math.max(dst[d + 3]!, a);
      }
    }
  }
}

// --- stage under test -------------------------------------------------------

const { LoginStage } = await import('../src/stage/login.ts');
const { encodePNG } = await import('./ppm2png.ts');

const out = process.argv[2] ?? 'stage.png';
const playerArg = process.argv.indexOf('--player');
const player = playerArg > 0 ? Number(process.argv[playerArg + 1]) : 1;

/** GameAssets-shaped shim: the stage only ever calls `pack(name)`. */
const packs = new Map<string, Pack>();
const assets = {
  async pack(name: string): Promise<Pack> {
    let p = packs.get(name);
    if (!p) {
      const idx = new Uint8Array(await Bun.file(`${ROOT}${name}.idx`).arrayBuffer());
      const idd = new Uint8Array(await Bun.file(`${ROOT}${name}.idd`).arrayBuffer());
      p = new Pack(name, idx, idd);
      packs.set(name, p);
    }
    return p;
  },
};

const renderer = new FakeRenderer();
const stage = new LoginStage(assets as never, renderer as never);
await stage.load((m) => console.log(`  load: ${m}`));

// Select the pane first: the 1P pane carries a Button_2P that moves to 2P.
if (player === 2) {
  const p2 = (stage as unknown as {
    buttons: { id: string; kind: string; player?: number; visible: boolean; x: number; y: number; sw: number; sh: number }[];
  }).buttons.find((b) => b.kind === 'player' && b.visible && b.id === 'Button_2P');
  if (!p2) throw new Error('no visible Button_2P');
  stage.handleClick(p2.x + p2.sw / 2, p2.y + p2.sh / 2);
}

// Type into the field that is actually shown, the way the browser does.
const visibleEdits = (stage as unknown as { edits: { id: string; visible: boolean }[] }).edits.filter((e) => e.visible);
if (visibleEdits.length) {
  (stage as unknown as { focus: number }).focus = (stage as unknown as { edits: { id: string; visible: boolean }[] }).edits.indexOf(
    visibleEdits[0] as never,
  );
}
const type = (text: string): void => {
  for (const ch of text) stage.handleKey({ key: ch, preventDefault() {} } as KeyboardEvent);
};
type('tester');
stage.handleKey({ key: 'Tab', preventDefault() {} } as KeyboardEvent);
type('hunter2');

stage.render();

const dst = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4);
let drawn = 0;
for (const q of renderer.quads) {
  const bmp = bitmapsByTexture.get([...textureKey.entries()].find(([, v]) => v === q.key)?.[0] as object);
  if (!bmp) continue;
  const src = bmp.rgba;
  // Crop the source rect out of the sheet, then blit it to the destination.
  const sw = Math.round(q.sw);
  const sh = Math.round(q.sh);
  const sub = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const so = ((Math.round(q.sy) + y) * bmp.width + Math.round(q.sx)) * 4;
    sub.set(src.subarray(so, so + sw * 4), y * sw * 4);
  }
  blit(dst, sub, sw, sh, q.dx, q.dy, Math.round(q.dw), Math.round(q.dh));
  drawn++;
}

console.log(`renderer: begin ${renderer.beginCalls}, end ${renderer.endCalls}, quads replayed ${drawn}`);
for (const q of renderer.quads) console.log(`   quad ${q.key} src ${q.sx},${q.sy} ${q.sw}x${q.sh} -> ${q.dx},${q.dy} ${q.dw}x${q.dh}`);
console.log(`player ${player}, typed id/pass into the visible pane`);

await Bun.write(out, encodePNG(SCREEN_W, SCREEN_H, new Uint8Array(dst.buffer)));
console.log(`wrote ${out}`);
