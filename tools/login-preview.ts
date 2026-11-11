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
import { EDIT_WELLS } from '../src/stage/login.ts';
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

  /** Blit one frame of a sheet (the 48-byte rect records slice the bitmap). */
  const blitFrame = (layer: Layer, frame: number, x: number, y: number): void => {
    const r = layer.sheet.rects[frame];
    if (!r) return;
    const sw = r.x1 - r.x0;
    const sh = r.y1 - r.y0;
    const sub = new Uint8ClampedArray(sw * sh * 4);
    for (let cy = 0; cy < sh; cy++) {
      const so = ((r.y0 + cy) * layer.sheet.sheetW + r.x0) * 4;
      sub.set(layer.rgba.subarray(so, so + sw * 4), cy * sw * 4);
    }
    blit(dst, sub, sw, sh, x, y);
  };

  /** imgpath -> SkinRsc key, for both the stage and its inner panes. */
  const pathKey = (el: { imgPath?: string[] }): keyof typeof SKIN | undefined => {
    const file = el.imgPath?.at(-1)?.toLowerCase() ?? '';
    return (Object.entries(SKIN).find(([, v]) => v.split('\\').at(-1)!.toLowerCase() === file)?.[0] as
      | keyof typeof SKIN
      | undefined);
  };

  // The inner pane is what the login form lives on: Inner_1P at 197,395 hosts
  // the Login_1P pane (407x156 LoginTable00.bmp, edits, 1P/2P and the
  // multiserver selector).  Inner_2P is hidden while 1P is selected.
  const inner = stage.elements.find((e) => e.id === 'Inner_1P');
  const form = panes[PANE.Login1P];
  if (inner && form) {
    for (const el of form.elements) {
      if (!el.visible) continue;
      if (el.kind === 'img' || el.kind === 'button') {
        const key = pathKey(el);
        const layer = key ? layers.get(key) : undefined;
        if (layer) {
          blitFrame(layer, el.kind === 'img' ? 0 : 1, inner.x + el.x, inner.y + el.y);
          const r = layer.sheet.rects[el.kind === 'img' ? 0 : 1]!;
          console.log(`inner ${el.id} ${r.x1 - r.x0}x${r.y1 - r.y0} at ${inner.x + el.x},${inner.y + el.y}`);
        }
      }
      if (el.kind === 'sel') {
        const selPane = panes.find((p) => p.elements.some((e) => e.id === 'Button_Dream') && p === panes[PANE.Login1PMultiserver]);
        void selPane;
        const mp = panes[PANE.Login1PMultiserver];
        if (!mp) continue;
        for (const se of mp.elements) {
          if (!se.visible || se.kind !== 'button') continue;
          const key = pathKey(se);
          const layer = key ? layers.get(key) : undefined;
          if (!layer) continue;
          // checkbox=1 buttons on the server pane: frame 1 is the checked art.
          blitFrame(layer, se.id === 'Button_Dream' ? 1 : 0, inner.x + el.x + se.x, inner.y + el.y + se.y);
          console.log(`  server ${se.id} at ${inner.x + el.x + se.x},${inner.y + el.y + se.y}`);
        }
      }
    }
    console.log(`inner pane Inner_1P at ${inner.x},${inner.y} (${form.elements.length} elements)`);
  }

  const buttonKey: Record<string, string> = {
    'btloginnewid.bmp': 'btLoginNewId',
    'btloginok.bmp': 'btLoginOk',
    'btlogincancel.bmp': 'btLoginCancel',
    'btlogincredit.bmp': 'btLoginCredit',
  };

  for (const el of stage.elements) {
    if (!el.visible || el.kind !== 'button') continue;
    const file = el.imgPath?.at(-1)?.toLowerCase() ?? '';
    const key = buttonKey[file];
    const layer = key ? layers.get(key as keyof typeof SKIN) : undefined;
    if (!layer) continue;
    const r = layer.sheet.rects[0]!;
    blitFrame(layer, 0, el.x, el.y);
    console.log(`button ${el.id} ${r.x1 - r.x0}x${r.y1 - r.y0} at ${el.x},${el.y}`);
  }

  // Optional: outline the edit wells so their alignment with the pane art can
  // be checked by eye (`--edits`).  The browser paints text into these rects.
  if (process.argv.includes('--edits') && inner) {
    const rect = (x: number, y: number, w: number, h: number, colour: [number, number, number]) => {
      for (let i = 0; i < w; i++) {
        for (const yy of [y, y + h - 1]) {
          const o = ((yy * W) + x + i) * 4;
          dst[o] = colour[0];
          dst[o + 1] = colour[1];
          dst[o + 2] = colour[2];
          dst[o + 3] = 255;
        }
      }
      for (let i = 0; i < h; i++) {
        for (const xx of [x, x + w - 1]) {
          const o = ((y + i) * W + xx) * 4;
          dst[o] = colour[0];
          dst[o + 1] = colour[1];
          dst[o + 2] = colour[2];
          dst[o + 3] = 255;
        }
      }
    };
    for (const [id, well] of Object.entries(EDIT_WELLS[1] ?? {})) {
      rect(inner.x + well.x, inner.y + well.y, well.w, well.h, [255, 0, 0]);
      console.log(`well ${id} ${well.w}x${well.h} at ${inner.x + well.x},${inner.y + well.y}`);
    }
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
