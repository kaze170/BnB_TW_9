/**
 * Asset extractor — dumps the original BnB client resources to public/assets.
 *
 * Everything is derived from the reversed loaders in CA.exe (see src/data/*).
 * No format is "detected" by magic bytes except where the client itself does
 * so (SkinDsc stores a JPEG, Cx stores a CFB document, music is MP3/WAV).
 *
 * Usage:  bun run tools/extract.ts [pack ...]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pack } from '../src/data/pack.ts';
import {
  decodeCDataI16,
  decodeCDataI16Character,
  sheetToRGBA,
  type SpriteSheet,
} from '../src/data/sprite.ts';
import { encodePNG } from './ppm2png.ts';
import { readSsi, decodeStringTable, decodeSystemStrings } from '../src/data/ssi.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'public/assets');
const ALL_PACKS = ['SkinRsc', 'SkinDsc', 'Cx', 'Fx', 'CharTE', 'EmoTE'] as const;
const PACKS = process.argv.slice(2).length ? process.argv.slice(2) : ALL_PACKS;

function write(p: string, data: Uint8Array | string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data as never);
}

interface ManifestEntry {
  type: 'sheet' | 'jpeg' | 'text' | 'blob';
  size: number;
  w?: number;
  h?: number;
  frames?: number;
  images?: number;
  overrun?: boolean;
  rects?: SpriteSheet['rects'];
  at?: string;
}
type Manifest = Record<string, Record<string, ManifestEntry>>;

function stripExt(p: string) {
  return p.replace(/\.(bmp|jpg|jpeg|png)$/i, '');
}

/** JPEG sniff — the skin/background art is stored as a raw JPEG blob. */
function isJpeg(b: Uint8Array) {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
/** RIFF/WAVE — EmoTE carries the fanfare jingles this way. */
function isWav(b: Uint8Array) {
  return b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57;
}
/** MPEG audio frame sync (MP3 stored raw inside Cx). */
function isMp3(b: Uint8Array) {
  return b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
}
/** OLE compound file — the thumbnail sheets are CFB documents. */
function isCfb(b: Uint8Array) {
  return b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

/** Text-ish payloads (XML skins, INI tables, .ssd lists). */
function isText(b: Uint8Array) {
  const n = Math.min(b.length, 96);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c >= 0x20 && c < 0x7f) continue;
    if (c >= 0x81) continue;
    bad++;
  }
  return bad === 0;
}

const manifest: Manifest = {};
let nSheet = 0, nRaw = 0, nOther = 0;

for (const name of PACKS) {
  const idx = new Uint8Array(await Bun.file(join(ROOT, name + '.idx')).arrayBuffer());
  const idd = new Uint8Array(await Bun.file(join(ROOT, name + '.idd')).arrayBuffer());
  const pack = new Pack(name, idx, idd);
  const packManifest: Record<string, ManifestEntry> = {};
  let sheets = 0;

  for (const e of pack.entries) {
    const base = e.name.replace(/\\/g, '/');
    const payload = pack.payload(e.name)!;

    // --- 1. SkinDsc is plain XML (CDataFile of type XML) -------------------
    if (name === 'SkinDsc') {
      write(join(OUT, 'text', name, base + '.xml'), payload);
      packManifest[base] = { type: 'text', size: payload.length };
      nOther++;
      continue;
    }

    // --- 2. sprite sheets ---------------------------------------------------
    const sheet = decodeCDataI16(payload) ?? decodeCDataI16Character(payload);
    if (sheet) {
      // one PNG per logical image: a sheet may hold several side by side
      let x = 0;
      for (let i = 0; i < sheet.images.length; i++) {
        const img = sheet.images[i];
        if (img.w === 0 || img.h === 0) continue;
        const file = sheet.images.length > 1 ? `${stripExt(base)}_img${i}.png` : stripExt(base) + '.png';
        write(join(OUT, 'cx', name, file), encodePNG(img.w, img.h, new Uint8Array(sheetToRGBA({
          count: 0, variant: 0, sheetW: img.w, sheetH: img.h, rects: [], images: [img], pixels: img.pixels, written: img.written,
        }).buffer)));
        x++;
      }
      packManifest[base] = {
        type: 'sheet',
        size: payload.length,
        w: sheet.sheetW,
        h: sheet.sheetH,
        frames: sheet.count,
        images: sheet.images.length,
        overrun: sheet.images.some((im) => im.overrun) || undefined,
        rects: sheet.rects,
      };
      sheets++;
      continue;
    }

    // --- 3. non-sheet payloads ---------------------------------------------
    if (isJpeg(payload)) {
      write(join(OUT, 'raw', name, stripExt(base) + '.jpg'), payload);
      packManifest[base] = { type: 'jpeg', size: payload.length };
      nRaw++;
    } else if (isWav(payload)) {
      write(join(OUT, 'raw', name, base + '.wav'), payload);
      packManifest[base] = { type: 'blob', size: payload.length };
      nRaw++;
    } else if (isMp3(payload)) {
      write(join(OUT, 'raw', name, base + '.mp3'), payload);
      packManifest[base] = { type: 'blob', size: payload.length };
      nRaw++;
    } else if (isCfb(payload)) {
      write(join(OUT, 'blob', name, base + '.cfb'), payload);
      packManifest[base] = { type: 'blob', size: payload.length };
      nOther++;
    } else if (isText(payload)) {
      write(join(OUT, 'text', name, base + '.bin'), payload);
      packManifest[base] = { type: 'text', size: payload.length };
      nOther++;
    } else {
      write(join(OUT, 'blob', name, base + '.bin'), payload);
      packManifest[base] = { type: 'blob', size: payload.length };
      nOther++;
    }
  }

  manifest[name] = packManifest;
  nSheet += sheets;
  console.log(`${name.padEnd(8)} ${String(pack.entries.length).padStart(5)} entries  ${String(sheets).padStart(5)} sheets`);
}

write(join(OUT, 'manifest.json'), JSON.stringify(manifest));

// --- 4. `ssi1` config/table containers (Sub_5800C0) -----------------------
// stringtable.ini / csysstr.ssd hold the shipped UI text; the rest are config
// blobs the client parses with its own record readers.
const CONFIGS = [
  'stringtable.ini',
  'csysstr.ssd',
  'fxstock.ini',
  'packagemap.ini',
  'fxdynmapinfo.ssd',
  'channel2_000.ssd',
  'multisvr.ssd',
];
const configManifest: Record<string, unknown> = {};
for (const f of CONFIGS) {
  const file = Bun.file(join(ROOT, f));
  if (!(await file.exists())) continue;
  const raw = new Uint8Array(await file.arrayBuffer());
  const ssi = readSsi(raw);
  if (!ssi) continue;
  write(join(OUT, 'config', f + '.bin'), ssi.payload);
  const entry: Record<string, unknown> = {
    adler: ssi.adler.toString(16),
    records: ssi.records.map((r) => ({ len: r.length, compressed: r.compressed, raw: r.rawLength })),
    payload: ssi.payload.length,
  };
  const table = decodeStringTable(ssi.payload);
  if (table) {
    write(join(OUT, 'config', f + '.json'), JSON.stringify(table, null, 0));
    entry.rows = table.length;
    entry.kind = 'stringtable';
  }
  const sys = decodeSystemStrings(ssi.payload);
  if (sys) {
    write(join(OUT, 'config', f + '.json'), JSON.stringify(sys, null, 0));
    entry.rows = sys.length;
    entry.kind = 'systemstrings';
  }
  configManifest[f] = entry;
  console.log(`config   ${f.padEnd(18)} ${String(ssi.payload.length).padStart(7)} bytes  ${entry.kind ?? 'blob'}`);
}
write(join(OUT, 'config', 'manifest.json'), JSON.stringify(configManifest, null, 1));

console.log(`sheets=${nSheet} raw=${nRaw} other=${nOther}`);
