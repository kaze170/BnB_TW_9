/**
 * BnB (Crazy Arcade) TW client 9 — archive layer.
 *
 * Reversed from CA.exe:
 *   CPackSysMan::possible_ctor_or_dtor_1        (0x00573750)  .idd/.idx mount
 *   sub_572CC0                                  (0x00572CC0)  memory mapped file
 *   sub_572280                                  (0x00572280)  .idx decryption (cumulative xor)
 *   sub_572310                                  (0x00572310)  CData payload decryption
 *   sub_566620 / sub_566730                     (0x00566620)  CRC-32 (poly 0x107, table 0x5DE2E0)
 *   sub_5733D0 / sub_572B30                     (0x005733D0)  index node push (0x90 bytes)
 *
 * .idd entry layout (144 byte index node):
 *   +0   char   name[?]   (variable, NUL terminated, stored inline)
 *   ...
 *   the loader copies 144 bytes from the index buffer per entry.
 *
 * .idx decryption:
 *   The whole index buffer is xor-accumulated as 32 bit words:
 *     w[0] = seed ^ E[0]
 *     w[i] = w[i-1] ^ E[i]
 *   (sub_572280 with a4 = seed, the "plain" variant used by index files)
 */

export const INDEX_SEED = 0x719cab30; // "Fx", "Cx", SkinRsc, SkinDsc
export const INDEX_SEED_CHARTE = 0x05b201fc; // "CharTE", "EmoTE"
export const PAYLOAD_KEY = 0x5b201fc;

/** sub_572280 — plain cumulative xor (index files) */
export function decryptIndex(buf: Uint8Array, seed: number): Uint8Array {
  const out = new Uint8Array(buf.length);
  const n = buf.length >>> 2;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const oview = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let prev = 0;
  if (n > 0) {
    prev = (seed ^ view.getUint32(0, true)) >>> 0;
    oview.setUint32(0, prev, true);
    for (let i = 1; i < n; i++) {
      prev = (prev ^ view.getUint32(i * 4, true)) >>> 0;
      oview.setUint32(i * 4, prev, true);
    }
  }
  const tail = buf.length - n * 4;
  for (let k = 0; k < tail; k++) {
    out[n * 4 + k] = buf[n * 4 + k] ^ ((prev >>> (8 * k)) & 0xff);
  }
  return out;
}

/** sub_572310 — CData payload decryption (keyed, position dependent) */
export function decryptPayload(buf: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(buf.length);
  const n = buf.length >>> 2;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const oview = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let prev = 0;
  if (n > 0) {
    prev = (key ^ view.getUint32(0, true) ^ 0x9c6c95ce) >>> 0;
    oview.setUint32(0, prev, true);
    for (let i = 1; i < n; i++) {
      const poly = Math.imul(Math.imul(i, i), Math.imul(i + 966, i + 2020)) >>> 0;
      prev = (prev ^ view.getUint32(i * 4, true) ^ poly ^ 0x9c6c95ce) >>> 0;
      oview.setUint32(i * 4, prev, true);
    }
  }
  const tail = buf.length - n * 4;
  for (let k = 0; k < tail; k++) {
    out[n * 4 + k] = buf[n * 4 + k] ^ ((prev >>> (8 * k)) & 0xff);
  }
  return out;
}

/** CRC table built from polynomial 0x107 (sub_566690) — MSB first, init passed by caller */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let b = 0; b < 8; b++) v = v & 1 ? (v >>> 1) ^ 0x107 : v >>> 1;
    t[i] = v >>> 0;
  }
  return t;
})();

/** sub_566620 — running CRC used to validate CData payloads */
export function crc32Bnb(init: number, data: Uint8Array, start = 0, end = data.length): number {
  let v = init >>> 0;
  for (let i = start; i < end; i++) {
    v = (CRC_TABLE[(data[i] ^ (v >>> 24)) & 0xff] ^ ((v << 8) >>> 0)) >>> 0;
  }
  return v >>> 0;
}

export interface IdxEntry {
  /** name as stored in the index (backslashes preserved) */
  name: string;
  /** byte offset inside the .idd */
  offset: number;
  /** byte size inside the .idd */
  size: number;
  /** per-entry decryption key (sub_572310 seed) */
  key: number;
  /** expected crc of decrypted payload (sub_566620) */
  crc: number;
}

export interface PackIndex {
  seed: number;
  entries: IdxEntry[];
}

/**
 * Parse a decrypted index file.
 *
 * Two header layouts exist:
 *   count != 0 : count, then entries { u32 nameLen, name, u32 offset, u32 size }
 *                (sub_572280 -> CData::sub_5730A0 fast path, used by Cx.idx)
 *   count == 0 : 0, 15, count, then entries
 *                { u32 nameLen, name, u32 off, u32 size, u32 key, u32 crc }
 *                (used by Fx / CharTE / EmoTE / Skin*)
 */
export function parseIndex(raw: Uint8Array): PackIndex | null {
  // The seed is the very first dword of the .idx itself: decryption makes
  // word[0] == 0 and then accumulates. Verified against all six shipped
  // archives (Cx, Fx, CharTE, EmoTE, SkinDsc, SkinRsc).
  if (raw.length < 4) return null;
  const seed = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
  const dec = decryptIndex(raw, seed);
  return tryParse(dec, seed);
}

function tryParse(dec: Uint8Array, seed: number): PackIndex | null {
  const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
  if (dec.length < 12) return null;
  const v0 = dv.getUint32(0, true);
  const v1 = dv.getUint32(4, true);
  let count: number;
  let off: number;
  let wide: boolean;
  if (v0 === 0) {
    if (v1 !== 15) return null;
    count = dv.getUint32(8, true);
    off = 12;
    wide = true;
  } else {
    if (v0 > 40000) return null;
    count = v0;
    off = 4;
    wide = false;
  }
  const entries: IdxEntry[] = [];
  const nameBytes: number[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > dec.length) return null;
    const nlen = dv.getUint32(off, true);
    off += 4;
    if (nlen < 1 || nlen > 250 || off + nlen > dec.length) return null;
    nameBytes.length = 0;
    for (let k = 0; k < nlen; k++) {
      const c = dec[off + k];
      if (c < 0x20 || c > 0x7e) return null;
      nameBytes.push(c);
    }
    const name = String.fromCharCode(...nameBytes);
    off += nlen;
    if (off + (wide ? 16 : 8) > dec.length) return null;
    const o = dv.getUint32(off, true);
    const s = dv.getUint32(off + 4, true);
    off += 8;
    let key = 0;
    let crc = 0;
    if (wide) {
      key = dv.getUint32(off, true);
      crc = dv.getUint32(off + 4, true);
      off += 8;
    }
    entries.push({ name, offset: o, size: s, key, crc });
  }
  return { seed, entries };
}

/** An in-memory .idd image together with its parsed index. */
export class Pack {
  readonly name: string;
  readonly entries: IdxEntry[];
  private readonly byName = new Map<string, IdxEntry>();
  private readonly data: Uint8Array;

  constructor(name: string, idx: Uint8Array, idd: Uint8Array) {
    this.name = name;
    const parsed = parseIndex(idx);
    if (!parsed) throw new Error(`[Pack] invalid index for ${name}`);
    this.entries = parsed.entries;
    this.data = idd;
    for (const e of parsed.entries) this.byName.set(normalizeName(e.name), e);
  }

  has(name: string): boolean {
    return this.byName.has(normalizeName(name));
  }

  entry(name: string): IdxEntry | undefined {
    return this.byName.get(normalizeName(name));
  }

  /** raw (still encrypted/compressed) bytes of one entry */
  raw(name: string): Uint8Array | null {
    const e = this.entry(name);
    if (!e) return null;
    return this.data.subarray(e.offset, e.offset + e.size);
  }


  /**
   * Whole-file payload, for the one pack whose entries are not independently
   * addressable (SkinDsc: its index offsets are one byte short, and the client
   * parses the file as a single XML stream).
   */
  allPayload(): Uint8Array {
    return this.data;
  }

  /** payload after sub_572310 decryption (CDataI16 sprite sheets / attr tables) */
  payload(name: string): Uint8Array | null {
    const e = this.entry(name);
    if (!e) return null;
    const raw = this.data.subarray(e.offset, e.offset + e.size);
    if (e.key) return decryptPayload(raw, e.key);
    return raw;
  }
}

export function normalizeName(n: string): string {
  return n.replace(/\\/g, '/').toLowerCase();
}
