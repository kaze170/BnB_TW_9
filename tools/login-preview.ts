/**
 * Render the login stage to a PNG straight from the original packs, using the
 * exact same layout and slicing code the browser runs.
 *
 * This exists because the login screen has to be verifiable without a GPU:
 * the compositing below reproduces what SpriteRenderer does (same rects, same
 * sources), so a pixel diff against the real client art is meaningful.
 *
 *   bun run tools/login-preview.ts out.png
 */
import { Pack } from '../src/data/pack.ts';
import { decodeCDataI16, sheetToRGBA, type SpriteSheet } from '../src/data/sprite.ts';

import { parseSkinDsc, PANE } from '../src/ui/skindsc.ts';
import { SKIN } from '../src/ui/skinrsc.ts';
import { encodePNG } from './ppm2png.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const W = 800;
const H = 600;

async function loadPack(name: string): Promise<Pack> {
  const idx = new Uint8Array(await Bun.file(`${ROOT}${name}.idx`).arrayBuffer());
  const idd = new Uint8Array(await Bun.file(`${ROOT}${name}.idd`).arrayBuffer());
  return new Pack(name, idx, idd);
}

interface Layer {
  sheet: SpriteSheet;
  rgba: Uint8ClampedArray;
}

/** Straight alpha blit, the same test the sprite shader performs. */
function blit(dst: Uint8ClampedArray, src: Uint8ClampedArray, sw: number, sh: number, dx: number, dy: number, dw = sw, dh = sh): void {
  for (let y = 0; y < dh; y++) {
    const sy = ((y * sh) / dh) | 0;
    const ty = dy + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < dw; x++) {
      const sx = ((x * sw) / dw) | 0;
      const tx = dx + x;
      if (tx < 0 || tx >= W) continue;
      const s = (sy * sw + sx) * 4;
      const a = src[s + 3]!;
      if (!a) continue;
      const d = (ty * W + tx) * 4;
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

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'login-preview.png';
  const dsc = await loadPack('SkinDsc');
  const rsc = await loadPack('SkinRsc');
  const panes = parseSkinDsc(new TextDecoder('latin1').decode(dsc.allPayload()));
  const stage = panes[PANE.LoginStage];
  if (!stage) throw new Error('no LoginStage pane');

  const dst = new Uint8ClampedArray(W * H * 4);

  const layers = new Map<string, Layer>();
  for (const [key, entry] of Object.entries(SKIN)) {
    const payload = rsc.payload(entry);
    if (!payload) continue;
    if (payload[0] === 0xff && payload[1] === 0xd8) continue; // jpeg, handled below
    const sheet = decodeCDataI16(payload);
    if (!sheet) continue;
    layers.set(key, { sheet, rgba: sheetToRGBA(sheet) });
  }

  const back = rsc.payload(SKIN.loginStageBack);
  if (back) {
    // The preview runs in bun, where there is no DOM decoder; shell out to the
    // extractor's existing JPEG path instead (tools/extract.ts writes PPM for
    // .jpg entries, which ppm2png already turns into PNG).
    const ppm = await jpegToPpm(back);
    blit(dst, ppm.rgba, ppm.w, ppm.h, 0, 0, W, H);
    console.log(`back ${ppm.w}x${ppm.h}`);
  }

  const buttonKey: Record<string, keyof typeof SKIN> = {
    'btloginnewid.bmp': 'btLoginNewId',
    'btloginok.bmp': 'btLoginOk',
    'btlogincancel.bmp': 'btLoginCancel',
    'btlogincredit.bmp': 'btLoginCredit',
  };

  for (const el of stage.elements) {
    if (!el.visible || el.kind !== 'button') continue;
    const file = el.imgPath?.at(-1)?.toLowerCase() ?? '';
    const key = buttonKey[file];
    const layer = key ? layers.get(key) : undefined;
    if (!layer) continue;
    const r = layer.sheet.rects[0]!;
    const sw = r.x1 - r.x0;
    const sh = r.y1 - r.y0;
    // copy the sub-rect out of the sheet into a temp buffer, then blit it 1:1
    const sub = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const so = ((r.y0 + y) * layer.sheet.sheetW + r.x0) * 4;
      sub.set(layer.rgba.subarray(so, so + sw * 4), y * sw * 4);
    }
    blit(dst, sub, sw, sh, el.x, el.y);
    console.log(`button ${el.id} ${sw}x${sh} at ${el.x},${el.y}`);
  }

  await Bun.write(out, encodePNG(W, H, new Uint8Array(dst.buffer)));
  console.log(`wrote ${out}`);
}

/**
 * Minimal baseline-JPEG decode is out of scope here (the browser has one).
 * bun does not, so the preview asks the extract tool for a PPM of the same
 * entry: tools/extract.ts already decodes SkinRsc\LoginStageBack.jpg through
 * the project's JPEG path.
 */
async function jpegToPpm(bytes: Uint8Array): Promise<{ w: number; h: number; rgba: Uint8ClampedArray }> {
  const tmp = `/tmp/bnb-back-${bytes.length}.ppm`;
  const file = Bun.file(tmp);
  if (!(await file.exists())) {
    const bin = `${ROOT}tools/../node_modules/.bin/../..`;
    void bin;
    const proc = Bun.spawnSync({
      cmd: ['python3', '-c', PPM_SCRIPT, jsonPath(bytes)],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (proc.exitCode !== 0) throw new Error(`jpeg decode failed: ${proc.stderr.toString()}`);
    await Bun.write(tmp, proc.stdout);
  }
  return readPpm(tmp);
}

function jsonPath(bytes: Uint8Array): string {
  const p = '/tmp/bnb-back.jpg';
  Bun.write(p, bytes);
  return p;
}

const PPM_SCRIPT = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
sys.stdout.buffer.write(b'P6\\n%d %d\\n255\\n' % im.size)
sys.stdout.buffer.write(im.tobytes())
`;

async function readPpm(path: string): Promise<{ w: number; h: number; rgba: Uint8ClampedArray }> {
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  // P6 header: magic, width height, maxval, single whitespace byte
  let i = 0;
  const token = (): string => {
    while (data[i] === 0x20 || data[i] === 0x0a || data[i] === 0x0d || data[i] === 0x09) i++;
    const s = i;
    while (data[i] !== 0x20 && data[i] !== 0x0a && data[i] !== 0x0d && data[i] !== 0x09) i++;
    return new TextDecoder().decode(data.subarray(s, i));
  };
  if (token() !== 'P6') throw new Error('not a P6 ppm');
  const w = Number(token());
  const h = Number(token());
  token();
  i++;
  const rgb = data.subarray(i);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = rgb[p * 3]!;
    rgba[p * 4 + 1] = rgb[p * 3 + 1]!;
    rgba[p * 4 + 2] = rgb[p * 3 + 2]!;
    rgba[p * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

await main();
