/**
 * `ssi1` container — reversed from CA.exe.
 *
 *   sub_5800C0  (0x005800C0)  load:   magic "ssi1", u32 crc, one smart record
 *   sub_57FBC0  (0x0057FBC0)  save:   magic "ssi1", u32 crc, raw record
 *   sub_57FEB0  (0x0057FEB0)  record: u8 0x18 | u32 len | len bytes
 *   sub_556BC0  (0x00556BC0)  crc32 of the stored record body
 *
 * File layout (verified byte exact on all seven shipped files):
 *   +0   "ssi1"
 *   +4   u32 adler32        Adler-32 of everything from +8 to EOF
 *   +8   u8 0x18            CISmartStream magic (sub_57FEB0 throws on mismatch)
 *   +9   u32 len            record length
 *   +13  u8 flag            0 = stored, 1 = zlib
 *   +14  u32 rawLen         only when flag == 1
 *   ...  body               `len - 1 - (flag ? 4 : 0)` bytes
 *
 * `recordEnd = 13 + len` lands exactly on EOF for every shipped file.
 */
import { adler32 } from './inflate.ts';
import { inflateZlib } from './inflate.ts';

export interface SsiRecord {
  /** u8 marker, always 0x18 */
  magic: number;
  /** declared record length (bytes after the length dword, plus 4) */
  length: number;
  /** 0 = stored, 1 = zlib */
  compressed: number;
  /** size of the decoded body */
  rawLength: number;
  /** decoded body */
  body: Uint8Array;
}

export interface SsiFile {
  /** Adler-32 of file[8..EOF] — *not* a CRC despite the loader's naming */
  adler: number;
  /** every record in the file (the shipped files all carry exactly one) */
  records: SsiRecord[];
  /** concatenation of the decoded bodies */
  payload: Uint8Array;
}

/** Parse an `.ssd` / `stringtable.ini` style `ssi1` file. */
export function readSsi(buf: Uint8Array): SsiFile | null {
  if (buf.length < 14) return null;
  if (buf[0] !== 0x73 || buf[1] !== 0x73 || buf[2] !== 0x69 || buf[3] !== 0x31) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const adler = dv.getUint32(4, true);
  const records: SsiRecord[] = [];
  let off = 8;
  while (off + 5 <= buf.length) {
    const magic = buf[off];
    if (magic !== 0x18) break;
    const length = dv.getUint32(off + 1, true);
    const end = off + 5 + length; // magic + len dword + `length` bytes
    if (length < 5 || end > buf.length) break;
    const compressed = buf[off + 5];
    let rawLength: number;
    let body: Uint8Array;
    if (compressed === 1) {
      rawLength = dv.getUint32(off + 6, true);
      body = buf.subarray(off + 10, end);
    } else {
      rawLength = length - 1;
      body = buf.subarray(off + 6, end);
    }
    let decoded: Uint8Array;
    try {
      decoded = compressed === 1 ? inflateZlib(body) : body;
    } catch {
      return null;
    }
    records.push({ magic, length, compressed, rawLength, body: decoded });
    off = end;
  }
  if (off !== buf.length || records.length === 0) return null;
  let total = 0;
  for (const r of records) total += r.body.length;
  const payload = new Uint8Array(total);
  let p = 0;
  for (const r of records) {
    payload.set(r.body, p);
    p += r.body.length;
  }
  return { adler, records, payload };
}

/** Serialise a body back into the stored (uncompressed) `ssi1` form. */
export function writeSsiRaw(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + 5 + payload.length);
  out.set([0x73, 0x73, 0x69, 0x31], 0);
  const dv = new DataView(out.buffer);
  out[8] = 0x18;
  dv.setUint32(9, 5 + payload.length, true);
  out[13] = 0;
  out.set(payload, 14);
  dv.setUint32(4, adler32(out.subarray(8), 0) >>> 0, true);
  return out;
}

/**
 * `stringtable.ini` layout (the only file in the shipped set that uses it):
 *   u16 count, count * { u32 id, u32 len, bytes text }   (Big5 / CP950)
 */
export interface StringRow {
  id: number;
  text: string;
}

/**
 * This build is the Taiwan release: every string table, channel name and
 * system message in the shipped data is Big5 (CP950), not EUC-KR.  Verified by
 * decoding the channel list ("BnB初級-1", "BnB高手-4") and csysstr.ssd.
 */
const BIG5 = new TextDecoder('big5', { fatal: false });

export function decodeBig5(bytes: Uint8Array): string {
  return BIG5.decode(bytes);
}

/** Kept for the call sites that still spell it CP950. */
export const decodeCp950 = decodeBig5;

export function decodeStringTable(payload: Uint8Array): StringRow[] | null {
  if (payload.length < 2) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = dv.getUint16(0, true);
  if (count === 0) return null;
  const rows: StringRow[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    if (off + 8 > payload.length) return null;
    const id = dv.getUint32(off, true);
    const len = dv.getUint32(off + 4, true);
    off += 8;
    if (len > payload.length - off) return null;
    rows.push({ id, text: BIG5.decode(payload.subarray(off, off + len)) });
    off += len;
  }
  if (off !== payload.length) return null;
  return rows;
}

/**
 * `csysstr.ssd` layout:
 *   u16 count, count * { u32 nameLen, name, u32 textLen, text }
 * The names carry the leading `?` the client uses to mark system keys.
 */
export interface SystemStringRow {
  name: string;
  text: string;
}

export function decodeSystemStrings(payload: Uint8Array): SystemStringRow[] | null {
  if (payload.length < 2) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = dv.getUint16(0, true);
  if (count === 0) return null;
  const rows: SystemStringRow[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    if (off + 4 > payload.length) return null;
    const nlen = dv.getUint32(off, true);
    off += 4;
    if (nlen > payload.length - off) return null;
    const name = BIG5.decode(payload.subarray(off, off + nlen));
    off += nlen;
    if (off + 4 > payload.length) return null;
    const tlen = dv.getUint32(off, true);
    off += 4;
    if (tlen > payload.length - off) return null;
    rows.push({ name, text: BIG5.decode(payload.subarray(off, off + tlen)) });
    off += tlen;
  }
  if (off !== payload.length) return null;
  return rows;
}
