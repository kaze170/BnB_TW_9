/**
 * Render the lobby stage (CLobbyStage) against its real art.
 *
 * The background is `Channel/CAStage` from Fx.idd — the shipped 800x600 lobby
 * JPEG.  Slot, list and panel geometry come from src/stage/lobby.ts, which was
 * measured off that JPEG and cross-checked against CLobbyStage's own six-slot
 * table in the executable.
 *
 *   bun run tools/render-lobby.ts out.png [--rows]
 */

import { Pack } from '../src/data/pack.ts';
import { SLOTS, SLOT_FIELDS, PLAYER_ORIGINS, PLAYER_FIELDS, CHAT, BAR, SCREEN_W, SCREEN_H } from '../src/stage/lobby.ts';
import { decodeCDataI16Character, sheetToRGBA } from '../src/data/sprite.ts';
import { encodePNG } from './ppm2png.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const W = SCREEN_W;
const H = SCREEN_H;

interface Bmp {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

async function decodeJpeg(bytes: Uint8Array): Promise<Bmp> {
  await Bun.write('/tmp/bnb-lobby.jpg', bytes);
  const proc = Bun.spawnSync({
    cmd: [
      'python3',
      '-c',
      'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\n' +
        'w,h=im.size\nsys.stdout.buffer.write(w.to_bytes(4,"little")+h.to_bytes(4,"little")+im.tobytes())',
      '/tmp/bnb-lobby.jpg',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  const buf = new Uint8Array(proc.stdout);
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  return { width: w, height: h, rgba: new Uint8ClampedArray(buf.subarray(8, 8 + w * h * 4)) };
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? 'lobby.png';
  const pack = new Pack(
    'Fx',
    new Uint8Array(await Bun.file(`${ROOT}Fx.idx`).arrayBuffer()),
    new Uint8Array(await Bun.file(`${ROOT}Fx.idd`).arrayBuffer()),
  );
  const jpeg = pack.payload('Channel/CAStage');
  if (!jpeg) throw new Error('Channel/CAStage missing');
  const art = await decodeJpeg(jpeg);
  console.log(`art ${art.width}x${art.height} (${jpeg.length} byte JPEG in Fx.idd)`);

  const dst = art.rgba.slice();

  // Composite the real BtSessionSlot art into the six cells.
  const sheetRaw = pack.payload('Channel/BtSessionSlot');
  const sheet = sheetRaw ? decodeCDataI16Character(sheetRaw) : null;
  if (!sheet) throw new Error('Channel/BtSessionSlot missing');
  // sheet.pixels is packed 0xAARRGGBB words; blit from the RGBA conversion.
  const sheetRGBA = sheetToRGBA(sheet);
  console.log(`slot sheet ${sheet.sheetW}x${sheet.sheetH} frames=${sheet.count}`);
  const blit = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number): void => {
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const s = ((sy + y) * sheet.sheetW + (sx + x)) * 4;
        const a = sheetRGBA[s + 3]!;
        if (!a) continue;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
        const d = (ty * W + tx) * 4;
        dst[d] = sheetRGBA[s]!;
        dst[d + 1] = sheetRGBA[s + 1]!;
        dst[d + 2] = sheetRGBA[s + 2]!;
        dst[d + 3] = 255;
      }
    }
  };
  for (let i = 0; i < SLOTS.length; i++) {
    const r = sheet.rects[i === 0 ? 3 : i === 1 ? 2 : 0]!;
    blit(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, SLOTS[i]!.x, SLOTS[i]!.y);
  }
  const wash = (
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: [number, number, number, number],
  ): void => {
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

  if (process.argv.includes('--rows')) {
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i]!;
      wash(s.x, s.y, 2, s.h, [255, 40, 40, 255]);
      wash(s.x, s.y, s.w, 2, [255, 40, 40, 255]);
      console.log(`  slot ${i}: ${s.x},${s.y} ${s.w}x${s.h}`);
    }
    for (const [px, py] of PLAYER_ORIGINS) wash(px, py, 6, 1, [255, 200, 0, 255]);
    console.log(`players ${PLAYER_ORIGINS.length} rows at x=${PLAYER_ORIGINS[0]![0]} y=${PLAYER_ORIGINS[0]![1]}..${PLAYER_ORIGINS[15]![1]}`);
    wash(CHAT.x, CHAT.y, CHAT.w, 1, [0, 255, 120, 255]);
    wash(CHAT.x, CHAT.y, 1, CHAT.h, [0, 255, 120, 255]);
    console.log(`chat ${CHAT.x},${CHAT.y} ${CHAT.w}x${CHAT.h}`);
    for (const w of BAR.wells) wash(w.x, BAR.y, w.w, 1, [255, 40, 40, 255]);
    console.log(`bar y=${BAR.y} h=${BAR.h} wells ${BAR.wells.map((w) => `${w.x}+${w.w}`).join(', ')}`);
  }

  const rooms = [
    { name: 'Room 1', map: 'BnB Town', state: '等待中', players: 1, capacity: 8 },
    { name: 'Room 2', map: 'Forest', state: '等待中', players: 2, capacity: 8 },
    { name: 'Room 3', map: 'Desert', state: '等待中', players: 1, capacity: 8 },
    { name: 'Room 4', map: 'Ice Field', state: '遊戲中', players: 0, capacity: 8 },
    { name: 'Room 5', map: 'Pirate Ship', state: '遊戲中', players: 0, capacity: 8 },
    { name: 'Room 6', map: 'Ghost Castle', state: '遊戲中', players: 0, capacity: 8 },
  ];
  const inputLine = '_';
  const players = Array.from({ length: PLAYER_ORIGINS.length }, (_, i) => ({
    name: `player${i + 1}`,
    level: 1 + ((i * 7) % 20),
  }));

  const ops: TextOp[] = [];
  for (let i = 0; i < rooms.length; i++) {
    const s = SLOTS[i]!;
    const r = rooms[i]!;
    const o = { x: s.x, y: s.y };
    ops.push({
      text: r.name,
      x: o.x + SLOT_FIELDS.name.x + 6,
      y: o.y + SLOT_FIELDS.name.y + 7,
      size: 13,
      colour: '#ffffff',
      align: 'left',
    });
    ops.push({
      text: r.map,
      x: o.x + SLOT_FIELDS.field1.x + 6,
      y: o.y + SLOT_FIELDS.field1.y + 5,
      size: 11,
      colour: '#dff0ff',
      align: 'left',
    });
    ops.push({
      text: r.state,
      x: o.x + SLOT_FIELDS.field2.x + 6,
      y: o.y + SLOT_FIELDS.field2.y + 5,
      size: 11,
      colour: '#dff0ff',
      align: 'left',
    });
    ops.push({
      text: `${r.players}/${r.capacity}`,
      x: o.x + SLOT_FIELDS.field3.x + 20,
      y: o.y + SLOT_FIELDS.field3.y + 5,
      size: 11,
      colour: '#ffffff',
      align: 'center',
    });
  }
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    const [rx, ry] = PLAYER_ORIGINS[i]!;
    ops.push({
      text: p.name,
      x: rx + PLAYER_FIELDS.name.dx,
      y: ry + PLAYER_FIELDS.name.dy,
      size: 12,
      colour: '#ffffff',
      align: 'left',
    });
    ops.push({
      text: String(p.level),
      x: rx + PLAYER_FIELDS.level.dx,
      y: ry + PLAYER_FIELDS.level.dy,
      size: 11,
      colour: '#bfe0ff',
      align: 'left',
    });
  }
  ops.push({
    text: inputLine,
    x: BAR.wells[0]!.x + 6,
    y: BAR.y + 5,
    size: 12,
    colour: '#9dc4e8',
    align: 'left',
  });

  const base = '/tmp/bnb-lobby-base.png';
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

interface TextOp {
  text: string;
  x: number;
  y: number;
  size: number;
  colour: string;
  align: 'left' | 'center' | 'right';
}

await main();
