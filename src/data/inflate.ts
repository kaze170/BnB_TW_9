/**
 * zlib (RFC 1950/1951) inflate in plain TypeScript.
 *
 * The game data ships zlib streams (`.ssd` / `stringtable.ini`) and the browser
 * build cannot use node:zlib, so the decoder is implemented here from the spec.
 * Exact inverse of the writer side is not needed — the client never writes
 * compressed streams.
 */

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  /** number of symbols with each code length */
  counts: Uint16Array;
  /** symbols ordered by code */
  symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  let total = 0;
  for (let i = 1; i < 16; i++) {
    offs[i] = total;
    total += counts[i];
  }
  const symbols = new Uint16Array(total);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l !== 0) symbols[offs[l]++] = i;
  }
  return { counts, symbols };
}

export class InflateError extends Error {}

/** Decode a zlib stream (2-byte header + deflate + adler32). */
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (data.length < 6) throw new InflateError('zlib: too short');
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 0x0f) !== 8) throw new InflateError('zlib: not deflate');
  if (((cmf << 8) | flg) % 31 !== 0) throw new InflateError('zlib: bad FCHECK');
  if (flg & 0x20) throw new InflateError('zlib: preset dictionary not supported');
  return inflateRaw(data.subarray(2));
}

/** Decode a raw deflate stream. */
export function inflateRaw(src: Uint8Array): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let outLen = 0;

  const need = (n: number) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new InflateError('deflate: out of input');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n: number): number => {
    if (n === 0) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const grow = (extra: number) => {
    if (outLen + extra <= out.length) return;
    let cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, outLen));
    out = next;
  };
  const decodeSym = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new InflateError('deflate: bad huffman code');
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // stored block
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > src.length) throw new InflateError('deflate: stored header');
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new InflateError('deflate: stored LEN/NLEN');
      if (pos + len > src.length) throw new InflateError('deflate: stored data');
      grow(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }
    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      const l = new Uint8Array(288);
      l.fill(8, 0, 144);
      l.fill(9, 144, 256);
      l.fill(7, 256, 280);
      l.fill(8, 280, 288);
      lit = buildHuffman(l, 288);
      const d = new Uint8Array(30);
      d.fill(5);
      dist = buildHuffman(d, 30);
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = bits(3);
      const clh = buildHuffman(clens, 19);
      const lengths = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decodeSym(clh);
        if (sym < 16) {
          lengths[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) throw new InflateError('deflate: repeat with no previous');
          const prev = lengths[i - 1];
          const rep = 3 + bits(2);
          for (let k = 0; k < rep; k++) lengths[i++] = prev;
        } else if (sym === 17) {
          const rep = 3 + bits(3);
          for (let k = 0; k < rep; k++) lengths[i++] = 0;
        } else {
          const rep = 11 + bits(7);
          for (let k = 0; k < rep; k++) lengths[i++] = 0;
        }
      }
      lit = buildHuffman(lengths.subarray(0, hlit), hlit);
      dist = buildHuffman(lengths.subarray(hlit), hdist);
    } else {
      throw new InflateError('deflate: bad block type');
    }

    for (;;) {
      const sym = decodeSym(lit);
      if (sym < 256) {
        grow(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError('deflate: bad length symbol');
        const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        const di = decodeSym(dist);
        if (di >= 30) throw new InflateError('deflate: bad distance symbol');
        const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (d > outLen) throw new InflateError('deflate: distance too far');
        grow(len);
        for (let k = 0; k < len; k++) {
          out[outLen] = out[outLen - d];
          outLen++;
        }
      }
    }
  }
  return out.subarray(0, outLen);
}

/**
 * Adler-32 (RFC 1950).
 *
 * The zlib stream trailers use the standard init of 1.  The `ssi1` header
 * stores the same checksum with init 0 over file[8..EOF] — that is exactly what
 * the client computes (`sub_556BC0` starts from `a1` and the loader passes the
 * value it read, i.e. 0), so `adler32(data, 0)` reproduces the header field.
 */
export function adler32(data: Uint8Array, init = 1): number {
  let a = init & 0xffff;
  let b = (init >>> 16) & 0xffff;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
