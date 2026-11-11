/**
 * Format regression test: every decoder in src/data has to agree with the
 * shipped packs.  Run with `bun run tools/check-formats.ts`.
 *
 * The assertions are the invariants the CA.exe loaders themselves enforce:
 *   - ssi checksum: Adler-32(0) over file[8..] must match +4 (sub_556BC0)
 *   - CDataI16: the size fields have to land exactly on EOF
 *   - CDataI16Character: the interleaved size walk has to land exactly on EOF
 *   - depth-4 decode must not overrun the stream
 */

import { inflateSync } from 'node:zlib';
import { Pack } from '../src/data/pack.ts';
import { decodeCDataI16, decodeCDataI16Character } from '../src/data/sprite.ts';
import { readSsi } from '../src/data/ssi.ts';

/**
 * Entries that are not sprites at all.  The client keeps them inside the same
 * packs, and this list is the result of classifying every rejected entry:
 * JPEG stills, OLE compound documents (`Thumbs`), HTML help, WAV effects and
 * plain-text attribute tables.
 */
function nonImageKind(raw: Uint8Array): string | null {
  if (raw.length < 8) return 'short';
  const hex = (o: number, n: number) =>
    [...raw.subarray(o, o + n)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex(0, 3) === 'ffd8ff') return 'jpeg';
  if (hex(0, 4) === 'd0cf11e0') return 'ole';
  // `Etc/CxLang`, `Etc/FxLang`: the ISTF string-table container.
  if (hex(0, 4) === '49535446') return 'istf';
  if (hex(0, 4) === '52494646') return 'wav';
  // `Etc/*_mm`: u32 id, u32 raw length, then a zlib stream (verified: every
  // one of them inflates to exactly the declared length).
  if (raw.length > 8 && raw[8] === 0x78) {
    const rawLen = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
    try {
      if (inflateSync(raw.subarray(8)).length === rawLen) return 'zlib';
    } catch {
      /* fall through */
    }
  }
  // MPEG audio (`MP3/*`), with or without an ID3v2 tag in front.
  if (hex(0, 3) === '494433') return 'mp3';
  if (raw[0] === 0xff && (raw[1]! & 0xe0) === 0xe0) return 'mp3';
  const head = new TextDecoder('latin1').decode(raw.subarray(0, 64));
  if (head.trimStart().startsWith('<')) return 'html';
  // Plain text, either UTF-8/ASCII or CP949 help pages (`Help/Help`).
  if (/^[\t\n\r\x20-\x7e\x80-\xff]*$/.test(head) && /[\r\n]/.test(head)) return 'text';
  // Stage layouts (`Map/Camp*`, `Map/Bula*`): grid width 1000 at +0 and a NUL
  // separated entity-name table at the tail.
  if (raw.length >= 16 && new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) === 1000) {
    const tail = raw.subarray(Math.max(0, raw.length - 64));
    if (tail.some((b) => b === 0)) return 'stage';
  }
  // Attribute / object tables (`Attr/*`, `ObjectTable/*`): a record count
  // followed by records that start with a NUL terminated ASCII asset path.
  const rec0 = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
  // Some tables put a word or two before the first record (`Attr/MapGroup`
  // starts with 3,15), so probe a few starts.
  for (const start of [4, 8, 12]) {
    if (start + 8 > raw.length) break;
    const head2 = new TextDecoder('latin1').decode(raw.subarray(start, start + 48));
    if (rec0 >= 1 && rec0 < 100000 && /^[\x20-\x7e]{2,}\0/.test(head2)) return 'attr';
  }
  return null;
}

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const PACKS = ['SkinRsc', 'Cx', 'Fx', 'CharTE', 'EmoTE'] as const;

for (const packName of PACKS) {
  const idx = new Uint8Array(await Bun.file(`${ROOT}${packName}.idx`).arrayBuffer());
  const idd = new Uint8Array(await Bun.file(`${ROOT}${packName}.idd`).arrayBuffer());
  const pack = new Pack(packName, idx, idd);
  let sheets = 0;
  let failed = 0;
  let overrun = 0;
  const firstFails: string[] = [];
  const variantSheets: Record<number, number> = {};

  for (const entry of pack.entries) {
    const payload = pack.payload(entry.name);
    if (!payload || payload.length < 16) continue;
    if (nonImageKind(payload)) continue;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const variant = dv.getUint32(4, true);
    // Fx reuses the header word for other payload kinds: variants 3/4/8 are
    // stage data (grid width 1000 at +0, tile lists, entity names at the
    // tail), variant 7 the object tables.  They are not sprites.
    if (variant > 2 && variant < 9) {
      variantSheets[variant] = (variantSheets[variant] ?? 0) + 1;
      continue;
    }
    const sheet =
      variant === 1 || variant === 2
        ? decodeCDataI16(payload) ?? decodeCDataI16Character(payload)
        : decodeCDataI16Character(payload);
    if (!sheet) {
      failed++;
      if (firstFails.length < 3) firstFails.push(entry.name);
      continue;
    }
    sheets++;
    if (sheet.images.some((i) => i.overrun)) overrun++;
  }
  check(`${packName.padEnd(8)} decodes (${sheets} sheets)`, failed === 0, `${failed} rejected: ${firstFails.join(', ')}`);
  check(`${packName.padEnd(8)} no stream overrun`, overrun === 0, `${overrun} overran`);
}

// ssi containers
for (const name of [
  'stringtable.ini',
  'csysstr.ssd',
  'fxstock.ini',
  'packagemap.ini',
  'fxdynmapinfo.ssd',
  'channel2_000.ssd',
  'multisvr.ssd',
]) {
  const bytes = new Uint8Array(await Bun.file(`${ROOT}${name}`).arrayBuffer());
  const ssi = readSsi(bytes);
  check(`ssi  ${name.padEnd(18)} checksum + length`, ssi !== null);
}

console.log(failures === 0 ? '\nall format checks passed' : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
