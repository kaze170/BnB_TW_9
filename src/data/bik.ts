// Pure-TypeScript Bink Video ('BIKi' / 'BIKf'..'BIKk') container & frame decoder
// for retail Taiwan BnB v9's intro movie (`nm.bik`, 800x600 @ 30fps, 90 frames).
// Decodes native YUV420P planes (Y, Cb/U, Cr/V) and converts to RGBA8 or exposes
// raw YUV420P planes for WebGPU upload.

import {
  BINK_INTER_QUANT,
  BINK_INTRA_QUANT,
  BINK_PATTERNS,
  BINK_SCAN,
  BINK_VLC_TABLE,
} from "./bikData.ts";

const BINK_FLAG_ALPHA = 0x00100000;

const SRC_BLOCK_TYPES = 0;
const SRC_SUB_BLOCK_TYPES = 1;
const SRC_COLORS = 2;
const SRC_PATTERN = 3;
const SRC_X_OFF = 4;
const SRC_Y_OFF = 5;
const SRC_INTRA_DC = 6;
const SRC_INTER_DC = 7;
const SRC_RUN = 8;
const NB_SRC = 9;

const SKIP_BLOCK = 0;
const SCALED_BLOCK = 1;
const MOTION_BLOCK = 2;
const RUN_BLOCK = 3;
const RESIDUE_BLOCK = 4;
const INTRA_BLOCK = 5;
const FILL_BLOCK = 6;
const INTER_BLOCK = 7;
const PATTERN_BLOCK = 8;
const RAW_BLOCK = 9;

const RLE_LENS = [4, 8, 12, 32] as const;

class BitReaderLE {
  readonly buf: Uint8Array;
  bitPos = 0;
  readonly totalBits: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.totalBits = buf.byteLength * 8;
  }

  bitsLeft(): number {
    return this.totalBits - this.bitPos;
  }

  getBit(): number {
    const p = this.bitPos;
    if (p >= this.totalBits) return 0;
    this.bitPos = p + 1;
    return (this.buf[p >>> 3]! >>> (p & 7)) & 1;
  }

  getBits(n: number): number {
    if (n <= 0) return 0;
    let p = this.bitPos;
    this.bitPos = p + n;
    const byteIdx = p >>> 3;
    const bitOff = p & 7;
    const b = this.buf;
    const len = b.byteLength;
    const b0 = byteIdx < len ? b[byteIdx]! : 0;
    const b1 = byteIdx + 1 < len ? b[byteIdx + 1]! : 0;
    const b2 = byteIdx + 2 < len ? b[byteIdx + 2]! : 0;
    const b3 = byteIdx + 3 < len ? b[byteIdx + 3]! : 0;
    const word = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> bitOff;
    return n === 32 ? word >>> 0 : word & ((1 << n) - 1);
  }

  peek7(): number {
    const p = this.bitPos;
    const byteIdx = p >>> 3;
    const bitOff = p & 7;
    const b = this.buf;
    const len = b.byteLength;
    const b0 = byteIdx < len ? b[byteIdx]! : 0;
    const b1 = byteIdx + 1 < len ? b[byteIdx + 1]! : 0;
    return ((b0 | (b1 << 8)) >>> bitOff) & 0x7f;
  }

  skipBits(n: number): void {
    this.bitPos += n;
  }

  align32(): void {
    const rem = this.bitPos & 31;
    if (rem !== 0) this.bitPos += 32 - rem;
  }
}

interface HuffTree {
  vlcNum: number;
  syms: Uint8Array; // 16 entries
}

interface Bundle {
  len: number;
  tree: HuffTree;
  data: Uint8Array;
  i16View: Int16Array;
  curDec: number; // byte offset, -1 means inactive/exhausted
  curPtr: number; // byte offset
}

function makeTree(): HuffTree {
  return { vlcNum: 0, syms: new Uint8Array(16) };
}

function avLog2(v: number): number {
  return v <= 0 ? 0 : 31 - Math.clz32(v);
}

function getHuff(gb: BitReaderLE, tree: HuffTree): number {
  if (tree.vlcNum === 0) {
    return tree.syms[gb.getBits(4)]!;
  }
  const entry = BINK_VLC_TABLE[(tree.vlcNum << 7) | gb.peek7()]!;
  gb.bitPos += entry >>> 4;
  return tree.syms[entry & 15]!;
}

function mergeLists(gb: BitReaderLE, dst: Uint8Array, dstOff: number, src: Uint8Array, srcOff: number, size: number): void {
  let i1 = srcOff;
  let i2 = srcOff + size;
  let s1 = size;
  let s2 = size;
  let d = dstOff;
  do {
    if (gb.getBit() === 0) {
      dst[d++] = src[i1++]!;
      s1--;
    } else {
      dst[d++] = src[i2++]!;
      s2--;
    }
  } while (s1 > 0 && s2 > 0);
  while (s1-- > 0) dst[d++] = src[i1++]!;
  while (s2-- > 0) dst[d++] = src[i2++]!;
}

function readTree(gb: BitReaderLE, tree: HuffTree, tmp1: Uint8Array, tmp2: Uint8Array): void {
  if (gb.bitsLeft() < 4) return;
  tree.vlcNum = gb.getBits(4);
  if (tree.vlcNum === 0) {
    for (let i = 0; i < 16; i++) tree.syms[i] = i;
    return;
  }
  if (gb.getBit() === 1) {
    tmp1.fill(0);
    let len = gb.getBits(3);
    for (let i = 0; i <= len; i++) {
      const s = gb.getBits(4);
      tree.syms[i] = s;
      tmp1[s] = 1;
    }
    for (let i = 0; i < 16 && len < 15; i++) {
      if (tmp1[i] === 0) tree.syms[++len] = i;
    }
  } else {
    const len = gb.getBits(2);
    let inp = tmp1;
    let out = tmp2;
    for (let i = 0; i < 16; i++) inp[i] = i;
    for (let i = 0; i <= len; i++) {
      const size = 1 << i;
      for (let t = 0; t < 16; t += size << 1) {
        mergeLists(gb, out, t, inp, t, size);
      }
      const swap = inp;
      inp = out;
      out = swap;
    }
    tree.syms.set(inp);
  }
}

// Bink 8x8 integer IDCT (ported 1:1 from FFmpeg libavcodec/binkdsp.c)
const A1 = 2896;
const A2 = 2217;
const A3 = 3784;
const A4 = -5352;

function mul(x: number, y: number): number {
  return Math.imul(x, y) >> 11;
}

function idctCol(dest: Int32Array, col: number, src: Int32Array): void {
  if (
    (src[col + 8]! |
      src[col + 16]! |
      src[col + 24]! |
      src[col + 32]! |
      src[col + 40]! |
      src[col + 48]! |
      src[col + 56]!) ===
    0
  ) {
    const v = src[col]!;
    dest[col] = v;
    dest[col + 8] = v;
    dest[col + 16] = v;
    dest[col + 24] = v;
    dest[col + 32] = v;
    dest[col + 40] = v;
    dest[col + 48] = v;
    dest[col + 56] = v;
    return;
  }
  const s0 = src[col]!;
  const s1 = src[col + 8]!;
  const s2 = src[col + 16]!;
  const s3 = src[col + 24]!;
  const s4 = src[col + 32]!;
  const s5 = src[col + 40]!;
  const s6 = src[col + 48]!;
  const s7 = src[col + 56]!;

  const a0 = s0 + s4;
  const a1 = s0 - s4;
  const a2 = s2 + s6;
  const a3 = mul(A1, s2 - s6);
  const a4 = s5 + s3;
  const a5 = s5 - s3;
  const a6 = s1 + s7;
  const a7 = s1 - s7;
  const b0 = a4 + a6;
  const b1 = mul(A3, a5 + a7);
  const b2 = mul(A4, a5) - b0 + b1;
  const b3 = mul(A1, a6 - a4) - b2;
  const b4 = mul(A2, a7) + b3 - b1;

  dest[col] = a0 + a2 + b0;
  dest[col + 8] = a1 + a3 - a2 + b2;
  dest[col + 16] = a1 - a3 + a2 + b3;
  dest[col + 24] = a0 - a2 - b4;
  dest[col + 32] = a0 - a2 + b4;
  dest[col + 40] = a1 - a3 + a2 - b3;
  dest[col + 48] = a1 + a3 - a2 - b2;
  dest[col + 56] = a0 + a2 - b0;
}

function idctPut(dest: Uint8Array, destOff: number, stride: number, block: Int32Array, temp: Int32Array): void {
  for (let i = 0; i < 8; i++) idctCol(temp, i, block);
  for (let row = 0; row < 8; row++) {
    const r = row << 3;
    const d = destOff + row * stride;
    const s0 = temp[r]!;
    const s1 = temp[r + 1]!;
    const s2 = temp[r + 2]!;
    const s3 = temp[r + 3]!;
    const s4 = temp[r + 4]!;
    const s5 = temp[r + 5]!;
    const s6 = temp[r + 6]!;
    const s7 = temp[r + 7]!;

    const a0 = s0 + s4;
    const a1 = s0 - s4;
    const a2 = s2 + s6;
    const a3 = mul(A1, s2 - s6);
    const a4 = s5 + s3;
    const a5 = s5 - s3;
    const a6 = s1 + s7;
    const a7 = s1 - s7;
    const b0 = a4 + a6;
    const b1 = mul(A3, a5 + a7);
    const b2 = mul(A4, a5) - b0 + b1;
    const b3 = mul(A1, a6 - a4) - b2;
    const b4 = mul(A2, a7) + b3 - b1;

    dest[d] = (a0 + a2 + b0 + 0x7f) >> 8;
    dest[d + 1] = (a1 + a3 - a2 + b2 + 0x7f) >> 8;
    dest[d + 2] = (a1 - a3 + a2 + b3 + 0x7f) >> 8;
    dest[d + 3] = (a0 - a2 - b4 + 0x7f) >> 8;
    dest[d + 4] = (a0 - a2 + b4 + 0x7f) >> 8;
    dest[d + 5] = (a1 - a3 + a2 - b3 + 0x7f) >> 8;
    dest[d + 6] = (a1 + a3 - a2 - b2 + 0x7f) >> 8;
    dest[d + 7] = (a0 + a2 - b0 + 0x7f) >> 8;
  }
}

function idctAdd(dest: Uint8Array, destOff: number, stride: number, block: Int32Array, temp: Int32Array): void {
  for (let i = 0; i < 8; i++) idctCol(temp, i, block);
  for (let row = 0; row < 8; row++) {
    const r = row << 3;
    const d = destOff + row * stride;
    const s0 = temp[r]!;
    const s1 = temp[r + 1]!;
    const s2 = temp[r + 2]!;
    const s3 = temp[r + 3]!;
    const s4 = temp[r + 4]!;
    const s5 = temp[r + 5]!;
    const s6 = temp[r + 6]!;
    const s7 = temp[r + 7]!;

    const a0 = s0 + s4;
    const a1 = s0 - s4;
    const a2 = s2 + s6;
    const a3 = mul(A1, s2 - s6);
    const a4 = s5 + s3;
    const a5 = s5 - s3;
    const a6 = s1 + s7;
    const a7 = s1 - s7;
    const b0 = a4 + a6;
    const b1 = mul(A3, a5 + a7);
    const b2 = mul(A4, a5) - b0 + b1;
    const b3 = mul(A1, a6 - a4) - b2;
    const b4 = mul(A2, a7) + b3 - b1;

    dest[d] = dest[d]! + ((a0 + a2 + b0 + 0x7f) >> 8);
    dest[d + 1] = dest[d + 1]! + ((a1 + a3 - a2 + b2 + 0x7f) >> 8);
    dest[d + 2] = dest[d + 2]! + ((a1 - a3 + a2 + b3 + 0x7f) >> 8);
    dest[d + 3] = dest[d + 3]! + ((a0 - a2 - b4 + 0x7f) >> 8);
    dest[d + 4] = dest[d + 4]! + ((a0 - a2 + b4 + 0x7f) >> 8);
    dest[d + 5] = dest[d + 5]! + ((a1 - a3 + a2 - b3 + 0x7f) >> 8);
    dest[d + 6] = dest[d + 6]! + ((a1 + a3 - a2 - b2 + 0x7f) >> 8);
    dest[d + 7] = dest[d + 7]! + ((a0 + a2 - b0 + 0x7f) >> 8);
  }
}

export class BikVideo {
  readonly fileBytes: Uint8Array;
  readonly version: number; // ASCII code e.g. 0x69 ('i')
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly fps: number;
  readonly hasAlpha: boolean;
  readonly swapPlanes: boolean;
  readonly frameOffsets: Uint32Array;

  readonly lumaStride: number;
  readonly lumaHeight: number;
  readonly chromaStride: number;
  readonly chromaHeight: number;

  // Current & previous YUV420P planes (plane 0=Y, 1=U/Cb, 2=V/Cr, 3=A)
  private curPlanes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  private prevPlanes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  private hasPrev = false;
  frameIndex = 0;

  private readonly bundles: Bundle[];
  private readonly colHigh: HuffTree[];
  private colLastVal = 0;

  // Scratch buffers (zero per-frame heap allocation)
  private readonly tmpTree1 = new Uint8Array(16);
  private readonly tmpTree2 = new Uint8Array(16);
  private readonly resBlock = new Int16Array(64);
  private readonly uBlock = new Uint8Array(64);
  private readonly dctBlock = new Int32Array(64);
  private readonly idctTemp = new Int32Array(64);
  private readonly coefIdx = new Int32Array(64);
  private readonly coefList = new Int32Array(128);
  private readonly modeList = new Int32Array(128);
  private readonly nzCoeff = new Int32Array(64);
  private readonly coordMap = new Int32Array(64);

  constructor(fileBytes: Uint8Array) {
    if (fileBytes.byteLength < 44 || fileBytes[0] !== 0x42 || fileBytes[1] !== 0x49 || fileBytes[2] !== 0x4b) {
      throw new Error("Invalid BIK video header");
    }
    this.fileBytes = fileBytes;
    this.version = fileBytes[3]!;
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    this.frameCount = dv.getUint32(8, true);
    this.width = dv.getUint32(20, true);
    this.height = dv.getUint32(24, true);
    this.fpsNum = dv.getUint32(28, true) || 30;
    this.fpsDen = dv.getUint32(32, true) || 1;
    this.fps = this.fpsNum / this.fpsDen;
    const videoFlags = dv.getUint32(36, true);
    const audioTracks = dv.getUint32(40, true);

    this.hasAlpha = (videoFlags & BINK_FLAG_ALPHA) !== 0;
    this.swapPlanes = this.version >= 0x68; // >= 'h'

    // Skip audio track headers (12 bytes per track: 4B info + 4B flags + 4B id)
    const indexOff = 44 + audioTracks * 12;
    this.frameOffsets = new Uint32Array(this.frameCount + 1);
    for (let i = 0; i <= this.frameCount; i++) {
      this.frameOffsets[i] = dv.getUint32(indexOff + i * 4, true) & ~1;
    }

    const bw = (this.width + 7) >> 3;
    const bh = (this.height + 7) >> 3;
    const cbw = (this.width + 15) >> 4;
    const cbh = (this.height + 15) >> 4;
    this.lumaStride = bw * 8;
    this.lumaHeight = bh * 8;
    this.chromaStride = cbw * 8;
    this.chromaHeight = cbh * 8;

    const ySize = this.lumaStride * this.lumaHeight;
    const cSize = this.chromaStride * this.chromaHeight;
    this.curPlanes = [
      new Uint8Array(ySize),
      new Uint8Array(cSize),
      new Uint8Array(cSize),
      new Uint8Array(this.hasAlpha ? ySize : 0),
    ];
    this.prevPlanes = [
      new Uint8Array(ySize),
      new Uint8Array(cSize),
      new Uint8Array(cSize),
      new Uint8Array(this.hasAlpha ? ySize : 0),
    ];

    const bundleBytes = bw * bh * 64;
    this.bundles = [];
    for (let i = 0; i < NB_SRC; i++) {
      const buf = new Uint8Array(bundleBytes);
      this.bundles.push({
        len: 0,
        tree: makeTree(),
        data: buf,
        i16View: new Int16Array(buf.buffer, buf.byteOffset, bundleBytes >> 1),
        curDec: 0,
        curPtr: 0,
      });
    }
    this.colHigh = [];
    for (let i = 0; i < 16; i++) this.colHigh.push(makeTree());
  }

  get yPlane(): Uint8Array {
    return this.curPlanes[0];
  }
  get uPlane(): Uint8Array {
    return this.curPlanes[1];
  }
  get vPlane(): Uint8Array {
    return this.curPlanes[2];
  }

  reset(): void {
    this.frameIndex = 0;
    this.hasPrev = false;
    for (const p of this.curPlanes) p.fill(0);
    for (const p of this.prevPlanes) p.fill(0);
  }

  /** Decode the next frame in sequence. Returns false if all frames have played. */
  decodeNextFrame(): boolean {
    if (this.frameIndex >= this.frameCount) return false;
    const idx = this.frameIndex++;
    const start = this.frameOffsets[idx]!;
    const end = this.frameOffsets[idx + 1]!;
    if (end <= start || end > this.fileBytes.byteLength) return false;

    // Swap prev <-> cur so cur becomes our write target and prev holds last decoded frame
    if (idx > 0) {
      const tmp = this.prevPlanes;
      this.prevPlanes = this.curPlanes;
      this.curPlanes = tmp;
      this.hasPrev = true;
    } else {
      this.hasPrev = false;
    }

    const pkt = this.fileBytes.subarray(start, end);
    const gb = new BitReaderLE(pkt);

    // Note: audio track packets precede video if audioTracks > 0, nm.bik has 0 audio tracks.
    if (this.hasAlpha) {
      if (this.version >= 0x69) gb.skipBits(32);
      this.decodePlane(gb, 3, false);
    }
    if (this.version >= 0x69) {
      gb.skipBits(32);
    }

    for (let plane = 0; plane < 3; plane++) {
      const planeIdx = plane === 0 || !this.swapPlanes ? plane : plane ^ 3;
      this.decodePlane(gb, planeIdx, plane !== 0);
      if (gb.bitsLeft() <= 0) break;
    }

    return true;
  }

  /** Convert the currently decoded YUV420P frame into RGBA8 (`width * height * 4`). */
  writeRgba(out: Uint8Array): void {
    const w = this.width;
    const h = this.height;
    const yPlane = this.curPlanes[0];
    const uPlane = this.curPlanes[1];
    const vPlane = this.curPlanes[2];
    const yStride = this.lumaStride;
    const cStride = this.chromaStride;

    // BT.601 MPEG-range YUV420P -> RGB24/RGBA8 (matches FFmpeg swscale default)
    let outIdx = 0;
    for (let y = 0; y < h; y++) {
      const yRow = y * yStride;
      const cRow = (y >> 1) * cStride;
      for (let x = 0; x < w; x++) {
        const Y = yPlane[yRow + x]!;
        const U = uPlane[cRow + (x >> 1)]! - 128;
        const V = vPlane[cRow + (x >> 1)]! - 128;
        const c = (Y - 16) * 298;
        let r = (c + 409 * V + 128) >> 8;
        let g = (c - 100 * U - 208 * V + 128) >> 8;
        let b = (c + 516 * U + 128) >> 8;
        if (r < 0) r = 0;
        else if (r > 255) r = 255;
        if (g < 0) g = 0;
        else if (g > 255) g = 255;
        if (b < 0) b = 0;
        else if (b > 255) b = 255;
        out[outIdx] = r;
        out[outIdx + 1] = g;
        out[outIdx + 2] = b;
        out[outIdx + 3] = 255;
        outIdx += 4;
      }
    }
  }

  private initLengths(width: number, bw: number): void {
    const aligned = (Math.max(width, 8) + 7) & ~7;
    const baseLen = avLog2((aligned >> 3) + 511) + 1;
    this.bundles[SRC_BLOCK_TYPES]!.len = baseLen;
    this.bundles[SRC_SUB_BLOCK_TYPES]!.len = avLog2((aligned >> 4) + 511) + 1;
    this.bundles[SRC_COLORS]!.len = avLog2(bw * 64 + 511) + 1;
    this.bundles[SRC_INTRA_DC]!.len = baseLen;
    this.bundles[SRC_INTER_DC]!.len = baseLen;
    this.bundles[SRC_X_OFF]!.len = baseLen;
    this.bundles[SRC_Y_OFF]!.len = baseLen;
    this.bundles[SRC_PATTERN]!.len = avLog2((bw << 3) + 511) + 1;
    this.bundles[SRC_RUN]!.len = avLog2(bw * 48 + 511) + 1;
  }

  private readBundleHeader(gb: BitReaderLE, bundleNum: number): void {
    if (bundleNum === SRC_COLORS) {
      for (let i = 0; i < 16; i++) {
        readTree(gb, this.colHigh[i]!, this.tmpTree1, this.tmpTree2);
      }
      this.colLastVal = 0;
    }
    const b = this.bundles[bundleNum]!;
    if (bundleNum !== SRC_INTRA_DC && bundleNum !== SRC_INTER_DC) {
      readTree(gb, b.tree, this.tmpTree1, this.tmpTree2);
    }
    b.curDec = 0;
    b.curPtr = 0;
  }

  private checkReadVal(gb: BitReaderLE, b: Bundle): number {
    if (b.curDec < 0 || b.curDec > b.curPtr) return 0;
    const t = gb.getBits(b.len);
    if (t === 0) {
      b.curDec = -1;
      return 0;
    }
    return t;
  }

  private readRuns(gb: BitReaderLE, b: Bundle): void {
    const t = this.checkReadVal(gb, b);
    if (t <= 0) return;
    const decEnd = b.curDec + t;
    if (gb.getBit() === 1) {
      const v = gb.getBits(4);
      b.data.fill(v, b.curDec, decEnd);
      b.curDec = decEnd;
    } else {
      while (b.curDec < decEnd) {
        b.data[b.curDec++] = getHuff(gb, b.tree);
      }
    }
  }

  private readMotionValues(gb: BitReaderLE, b: Bundle): void {
    const t = this.checkReadVal(gb, b);
    if (t <= 0) return;
    const decEnd = b.curDec + t;
    if (gb.getBit() === 1) {
      let v = gb.getBits(4);
      if (v !== 0 && gb.getBit() === 1) v = -v;
      b.data.fill(v & 0xff, b.curDec, decEnd);
      b.curDec = decEnd;
    } else {
      while (b.curDec < decEnd) {
        let v = getHuff(gb, b.tree);
        if (v !== 0 && gb.getBit() === 1) v = -v;
        b.data[b.curDec++] = v & 0xff;
      }
    }
  }

  private readBlockTypes(gb: BitReaderLE, b: Bundle): void {
    let t = this.checkReadVal(gb, b);
    if (t <= 0) return;
    if (this.version === 0x6b) {
      t ^= 0xbb;
      if (t === 0) {
        b.curDec = -1;
        return;
      }
    }
    const decEnd = b.curDec + t;
    if (gb.getBit() === 1) {
      const v = gb.getBits(4);
      b.data.fill(v, b.curDec, decEnd);
      b.curDec = decEnd;
    } else {
      let last = 0;
      while (b.curDec < decEnd) {
        const v = getHuff(gb, b.tree);
        if (v < 12) {
          last = v;
          b.data[b.curDec++] = v;
        } else {
          const run = RLE_LENS[v - 12]!;
          const stop = Math.min(decEnd, b.curDec + run);
          b.data.fill(last, b.curDec, stop);
          b.curDec = stop;
        }
      }
    }
  }

  private readPatterns(gb: BitReaderLE, b: Bundle): void {
    const t = this.checkReadVal(gb, b);
    if (t <= 0) return;
    const decEnd = b.curDec + t;
    while (b.curDec < decEnd) {
      const lo = getHuff(gb, b.tree);
      const hi = getHuff(gb, b.tree);
      b.data[b.curDec++] = lo | (hi << 4);
    }
  }

  private readColors(gb: BitReaderLE, b: Bundle): void {
    const t = this.checkReadVal(gb, b);
    if (t <= 0) return;
    const decEnd = b.curDec + t;
    if (gb.getBit() === 1) {
      this.colLastVal = getHuff(gb, this.colHigh[this.colLastVal]!);
      let v = (this.colLastVal << 4) | getHuff(gb, b.tree);
      if (this.version < 0x69) {
        const sign = (v << 24) >> 31;
        v = (((v & 0x7f) ^ sign) - sign + 0x80) & 0xff;
      }
      b.data.fill(v, b.curDec, decEnd);
      b.curDec = decEnd;
    } else {
      while (b.curDec < decEnd) {
        this.colLastVal = getHuff(gb, this.colHigh[this.colLastVal]!);
        let v = (this.colLastVal << 4) | getHuff(gb, b.tree);
        if (this.version < 0x69) {
          const sign = (v << 24) >> 31;
          v = (((v & 0x7f) ^ sign) - sign + 0x80) & 0xff;
        }
        b.data[b.curDec++] = v;
      }
    }
  }

  private readDcs(gb: BitReaderLE, b: Bundle, startBits: number, hasSign: number): void {
    let len = this.checkReadVal(gb, b);
    if (len <= 0) return;
    let dstIdx = b.curDec >> 1;
    const dst = b.i16View;

    let v = gb.getBits(startBits - hasSign);
    if (v !== 0 && hasSign !== 0 && gb.getBit() === 1) v = -v;
    dst[dstIdx++] = v;
    len--;

    for (let i = 0; i < len; i += 8) {
      const len2 = Math.min(len - i, 8);
      const bsize = gb.getBits(4);
      if (bsize !== 0) {
        for (let j = 0; j < len2; j++) {
          let v2 = gb.getBits(bsize);
          if (v2 !== 0 && gb.getBit() === 1) v2 = -v2;
          v += v2;
          dst[dstIdx++] = v;
        }
      } else {
        for (let j = 0; j < len2; j++) {
          dst[dstIdx++] = v;
        }
      }
    }
    b.curDec = dstIdx << 1;
  }

  private getValue(bundleNum: number): number {
    const b = this.bundles[bundleNum]!;
    if (bundleNum < SRC_X_OFF || bundleNum === SRC_RUN) {
      return b.data[b.curPtr++]!;
    }
    if (bundleNum === SRC_X_OFF || bundleNum === SRC_Y_OFF) {
      return (b.data[b.curPtr++]! << 24) >> 24;
    }
    const idx = b.curPtr >> 1;
    b.curPtr += 2;
    return b.i16View[idx]!;
  }

  private readDctCoeffs(gb: BitReaderLE, block: Int32Array): { quantIdx: number; coefCount: number } {
    const coefList = this.coefList;
    const modeList = this.modeList;
    const coefIdx = this.coefIdx;
    let listStart = 64;
    let listEnd = 64;
    let coefCount = 0;

    coefList[listEnd] = 4;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 24;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 44;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 1;
    modeList[listEnd++] = 3;
    coefList[listEnd] = 2;
    modeList[listEnd++] = 3;
    coefList[listEnd] = 3;
    modeList[listEnd++] = 3;

    for (let bits = gb.getBits(4) - 1; bits >= 0; bits--) {
      let listPos = listStart;
      while (listPos < listEnd) {
        if ((modeList[listPos]! | coefList[listPos]!) === 0 || gb.getBit() === 0) {
          listPos++;
          continue;
        }
        let ccoef = coefList[listPos]!;
        const mode = modeList[listPos]!;
        if (mode === 0 || mode === 2) {
          if (mode === 0) {
            coefList[listPos] = ccoef + 4;
            modeList[listPos] = 1;
          } else {
            coefList[listPos] = 0;
            modeList[listPos++] = 0;
          }
          for (let i = 0; i < 4; i++, ccoef++) {
            if (gb.getBit() === 1) {
              --listStart;
              coefList[listStart] = ccoef;
              modeList[listStart] = 3;
            } else {
              let t: number;
              if (bits === 0) {
                t = 1 - (gb.getBit() << 1);
              } else {
                t = gb.getBits(bits) | (1 << bits);
                if (gb.getBit() === 1) t = -t;
              }
              block[BINK_SCAN[ccoef]!] = t;
              coefIdx[coefCount++] = ccoef;
            }
          }
        } else if (mode === 1) {
          modeList[listPos] = 2;
          for (let i = 0; i < 3; i++) {
            ccoef += 4;
            coefList[listEnd] = ccoef;
            modeList[listEnd++] = 2;
          }
        } else if (mode === 3) {
          let t: number;
          if (bits === 0) {
            t = 1 - (gb.getBit() << 1);
          } else {
            t = gb.getBits(bits) | (1 << bits);
            if (gb.getBit() === 1) t = -t;
          }
          block[BINK_SCAN[ccoef]!] = t;
          coefIdx[coefCount++] = ccoef;
          coefList[listPos] = 0;
          modeList[listPos++] = 0;
        }
      }
    }

    const quantIdx = gb.getBits(4);
    return { quantIdx, coefCount };
  }

  private unquantizeDct(block: Int32Array, quantTable: Int32Array, quantIdx: number, coefCount: number): void {
    const qBase = quantIdx << 6;
    block[0] = Math.imul(block[0]!, quantTable[qBase]!) >> 11;
    const coefIdx = this.coefIdx;
    for (let i = 0; i < coefCount; i++) {
      const idx = coefIdx[i]!;
      const pos = BINK_SCAN[idx]!;
      block[pos] = Math.imul(block[pos]!, quantTable[qBase + idx]!) >> 11;
    }
  }

  private readResidue(gb: BitReaderLE, block: Int16Array, masksCount: number): void {
    const coefList = this.coefList;
    const modeList = this.modeList;
    const nzCoeff = this.nzCoeff;
    let listStart = 64;
    let listEnd = 64;
    let nzCount = 0;

    coefList[listEnd] = 4;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 24;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 44;
    modeList[listEnd++] = 0;
    coefList[listEnd] = 0;
    modeList[listEnd++] = 2;

    for (let mask = 1 << gb.getBits(3); mask !== 0; mask >>= 1) {
      for (let i = 0; i < nzCount; i++) {
        if (gb.getBit() === 0) continue;
        const pos = nzCoeff[i]!;
        if (block[pos]! < 0) block[pos]! -= mask;
        else block[pos]! += mask;
        if (--masksCount < 0) return;
      }
      let listPos = listStart;
      while (listPos < listEnd) {
        if ((coefList[listPos]! | modeList[listPos]!) === 0 || gb.getBit() === 0) {
          listPos++;
          continue;
        }
        let ccoef = coefList[listPos]!;
        const mode = modeList[listPos]!;
        if (mode === 0 || mode === 2) {
          if (mode === 0) {
            coefList[listPos] = ccoef + 4;
            modeList[listPos] = 1;
          } else {
            coefList[listPos] = 0;
            modeList[listPos++] = 0;
          }
          for (let i = 0; i < 4; i++, ccoef++) {
            if (gb.getBit() === 1) {
              --listStart;
              coefList[listStart] = ccoef;
              modeList[listStart] = 3;
            } else {
              const pos = BINK_SCAN[ccoef]!;
              nzCoeff[nzCount++] = pos;
              const sign = -gb.getBit();
              block[pos] = (mask ^ sign) - sign;
              if (--masksCount < 0) return;
            }
          }
        } else if (mode === 1) {
          modeList[listPos] = 2;
          for (let i = 0; i < 3; i++) {
            ccoef += 4;
            coefList[listEnd] = ccoef;
            modeList[listEnd++] = 2;
          }
        } else if (mode === 3) {
          const pos = BINK_SCAN[ccoef]!;
          nzCoeff[nzCount++] = pos;
          const sign = -gb.getBit();
          block[pos] = (mask ^ sign) - sign;
          coefList[listPos] = 0;
          modeList[listPos++] = 0;
          if (--masksCount < 0) return;
        }
      }
    }
  }

  private copyBlock8x8(dst: Uint8Array, dstOff: number, src: Uint8Array, srcOff: number, stride: number): void {
    for (let r = 0; r < 8; r++) {
      const d = dstOff + r * stride;
      const s = srcOff + r * stride;
      for (let c = 0; c < 8; c++) {
        dst[d + c] = src[s + c]!;
      }
    }
  }

  private putMotionPixels(
    dst: Uint8Array,
    dstOff: number,
    prev: Uint8Array,
    prevOff: number,
    stride: number,
    maxOff: number,
  ): void {
    const xoff = this.getValue(SRC_X_OFF);
    const yoff = this.getValue(SRC_Y_OFF);
    const refOff = Math.max(0, Math.min(maxOff, prevOff + xoff + yoff * stride));
    if (dst === prev) {
      const u = this.uBlock;
      for (let r = 0; r < 8; r++) {
        const s = refOff + r * stride;
        const o = r << 3;
        for (let c = 0; c < 8; c++) u[o + c] = prev[s + c]!;
      }
      for (let r = 0; r < 8; r++) {
        const d = dstOff + r * stride;
        const o = r << 3;
        for (let c = 0; c < 8; c++) dst[d + c] = u[o + c]!;
      }
    } else {
      this.copyBlock8x8(dst, dstOff, prev, refOff, stride);
    }
  }

  private scaleBlock8To16(src64: Uint8Array, dst: Uint8Array, dstOff: number, stride: number): void {
    for (let j = 0; j < 8; j++) {
      const s = j << 3;
      const d1 = dstOff + (j << 1) * stride;
      const d2 = d1 + stride;
      for (let i = 0; i < 8; i++) {
        const v = src64[s + i]!;
        const x = i << 1;
        dst[d1 + x] = v;
        dst[d1 + x + 1] = v;
        dst[d2 + x] = v;
        dst[d2 + x + 1] = v;
      }
    }
  }

  private decodePlane(gb: BitReaderLE, planeIdx: number, isChroma: boolean): void {
    const stride = isChroma ? this.chromaStride : this.lumaStride;
    const bw = isChroma ? (this.width + 15) >> 4 : (this.width + 7) >> 3;
    const bh = isChroma ? (this.height + 15) >> 4 : (this.height + 7) >> 3;
    const planeW = isChroma ? this.width >> 1 : this.width;
    const planeH = isChroma ? this.height >> 1 : this.height;

    const dstPlane = this.curPlanes[planeIdx]!;
    const prevPlane = this.hasPrev ? this.prevPlanes[planeIdx]! : dstPlane;
    const maxRefOff = (bw - 1 + stride * (bh - 1)) * 8;

    if (this.version === 0x6b && gb.getBit() === 1) {
      const fill = gb.getBits(8);
      for (let r = 0; r < planeH; r++) {
        dstPlane.fill(fill, r * stride, r * stride + planeW);
      }
      gb.align32();
      return;
    }

    this.initLengths(planeW, bw);
    for (let i = 0; i < NB_SRC; i++) {
      this.readBundleHeader(gb, i);
    }

    const coordMap = this.coordMap;
    for (let i = 0; i < 64; i++) {
      coordMap[i] = (i & 7) + (i >> 3) * stride;
    }

    const dctBlock = this.dctBlock;
    const idctTemp = this.idctTemp;
    const resBlock = this.resBlock;
    const uBlock = this.uBlock;

    for (let by = 0; by < bh; by++) {
      this.readBlockTypes(gb, this.bundles[SRC_BLOCK_TYPES]!);
      this.readBlockTypes(gb, this.bundles[SRC_SUB_BLOCK_TYPES]!);
      this.readColors(gb, this.bundles[SRC_COLORS]!);
      this.readPatterns(gb, this.bundles[SRC_PATTERN]!);
      this.readMotionValues(gb, this.bundles[SRC_X_OFF]!);
      this.readMotionValues(gb, this.bundles[SRC_Y_OFF]!);
      this.readDcs(gb, this.bundles[SRC_INTRA_DC]!, 11, 0);
      this.readDcs(gb, this.bundles[SRC_INTER_DC]!, 11, 1);
      this.readRuns(gb, this.bundles[SRC_RUN]!);

      let dstOff = 8 * by * stride;
      let prevOff = dstOff;

      for (let bx = 0; bx < bw; bx++, dstOff += 8, prevOff += 8) {
        let blk = this.getValue(SRC_BLOCK_TYPES);
        if (((by & 1) !== 0 || (bx & 1) !== 0) && blk === SCALED_BLOCK) {
          bx++;
          dstOff += 8;
          prevOff += 8;
          continue;
        }

        switch (blk) {
          case SKIP_BLOCK: {
            if (dstPlane !== prevPlane) {
              this.copyBlock8x8(dstPlane, dstOff, prevPlane, prevOff, stride);
            }
            break;
          }
          case SCALED_BLOCK: {
            blk = this.getValue(SRC_SUB_BLOCK_TYPES);
            switch (blk) {
              case RUN_BLOCK: {
                const patBase = gb.getBits(4) << 6;
                let scanPos = 0;
                let i = 0;
                do {
                  const run = this.getValue(SRC_RUN) + 1;
                  i += run;
                  if (i > 64) break;
                  if (gb.getBit() === 1) {
                    const v = this.getValue(SRC_COLORS);
                    for (let j = 0; j < run; j++) {
                      uBlock[BINK_PATTERNS[patBase + scanPos++]!] = v;
                    }
                  } else {
                    for (let j = 0; j < run; j++) {
                      uBlock[BINK_PATTERNS[patBase + scanPos++]!] = this.getValue(SRC_COLORS);
                    }
                  }
                } while (i < 63);
                if (i === 63) {
                  uBlock[BINK_PATTERNS[patBase + scanPos]!] = this.getValue(SRC_COLORS);
                }
                break;
              }
              case INTRA_BLOCK: {
                dctBlock.fill(0);
                dctBlock[0] = this.getValue(SRC_INTRA_DC);
                const { quantIdx, coefCount } = this.readDctCoeffs(gb, dctBlock);
                this.unquantizeDct(dctBlock, BINK_INTRA_QUANT, quantIdx, coefCount);
                idctPut(uBlock, 0, 8, dctBlock, idctTemp);
                break;
              }
              case FILL_BLOCK: {
                const v = this.getValue(SRC_COLORS);
                for (let r = 0; r < 16; r++) {
                  const rowOff = dstOff + r * stride;
                  dstPlane.fill(v, rowOff, rowOff + 16);
                }
                break;
              }
              case PATTERN_BLOCK: {
                const c0 = this.getValue(SRC_COLORS);
                const c1 = this.getValue(SRC_COLORS);
                for (let j = 0; j < 8; j++) {
                  let v = this.getValue(SRC_PATTERN);
                  const row = j << 3;
                  for (let i = 0; i < 8; i++, v >>= 1) {
                    uBlock[row + i] = (v & 1) !== 0 ? c1 : c0;
                  }
                }
                break;
              }
              case RAW_BLOCK: {
                for (let j = 0; j < 64; j++) {
                  uBlock[j] = this.getValue(SRC_COLORS);
                }
                break;
              }
            }
            if (blk !== FILL_BLOCK) {
              this.scaleBlock8To16(uBlock, dstPlane, dstOff, stride);
            }
            bx++;
            dstOff += 8;
            prevOff += 8;
            break;
          }
          case MOTION_BLOCK: {
            this.putMotionPixels(dstPlane, dstOff, prevPlane, prevOff, stride, maxRefOff);
            break;
          }
          case RUN_BLOCK: {
            const patBase = gb.getBits(4) << 6;
            let scanPos = 0;
            let i = 0;
            do {
              const run = this.getValue(SRC_RUN) + 1;
              i += run;
              if (i > 64) break;
              if (gb.getBit() === 1) {
                const v = this.getValue(SRC_COLORS);
                for (let j = 0; j < run; j++) {
                  dstPlane[dstOff + coordMap[BINK_PATTERNS[patBase + scanPos++]!]!] = v;
                }
              } else {
                for (let j = 0; j < run; j++) {
                  dstPlane[dstOff + coordMap[BINK_PATTERNS[patBase + scanPos++]!]!] = this.getValue(SRC_COLORS);
                }
              }
            } while (i < 63);
            if (i === 63) {
              dstPlane[dstOff + coordMap[BINK_PATTERNS[patBase + scanPos]!]!] = this.getValue(SRC_COLORS);
            }
            break;
          }
          case RESIDUE_BLOCK: {
            this.putMotionPixels(dstPlane, dstOff, prevPlane, prevOff, stride, maxRefOff);
            resBlock.fill(0);
            const masks = gb.getBits(7);
            this.readResidue(gb, resBlock, masks);
            for (let r = 0; r < 8; r++) {
              const d = dstOff + r * stride;
              const s = r << 3;
              for (let c = 0; c < 8; c++) {
                dstPlane[d + c] = dstPlane[d + c]! + resBlock[s + c]!;
              }
            }
            break;
          }
          case INTRA_BLOCK: {
            dctBlock.fill(0);
            dctBlock[0] = this.getValue(SRC_INTRA_DC);
            const { quantIdx, coefCount } = this.readDctCoeffs(gb, dctBlock);
            this.unquantizeDct(dctBlock, BINK_INTRA_QUANT, quantIdx, coefCount);
            idctPut(dstPlane, dstOff, stride, dctBlock, idctTemp);
            break;
          }
          case FILL_BLOCK: {
            const v = this.getValue(SRC_COLORS);
            for (let r = 0; r < 8; r++) {
              const d = dstOff + r * stride;
              dstPlane.fill(v, d, d + 8);
            }
            break;
          }
          case INTER_BLOCK: {
            this.putMotionPixels(dstPlane, dstOff, prevPlane, prevOff, stride, maxRefOff);
            dctBlock.fill(0);
            dctBlock[0] = this.getValue(SRC_INTER_DC);
            const { quantIdx, coefCount } = this.readDctCoeffs(gb, dctBlock);
            this.unquantizeDct(dctBlock, BINK_INTER_QUANT, quantIdx, coefCount);
            idctAdd(dstPlane, dstOff, stride, dctBlock, idctTemp);
            break;
          }
          case PATTERN_BLOCK: {
            const c0 = this.getValue(SRC_COLORS);
            const c1 = this.getValue(SRC_COLORS);
            for (let r = 0; r < 8; r++) {
              let v = this.getValue(SRC_PATTERN);
              const d = dstOff + r * stride;
              for (let c = 0; c < 8; c++, v >>= 1) {
                dstPlane[d + c] = (v & 1) !== 0 ? c1 : c0;
              }
            }
            break;
          }
          case RAW_BLOCK: {
            const cb = this.bundles[SRC_COLORS]!;
            for (let r = 0; r < 8; r++) {
              const d = dstOff + r * stride;
              for (let c = 0; c < 8; c++) {
                dstPlane[d + c] = cb.data[cb.curPtr + r * 8 + c]!;
              }
            }
            cb.curPtr += 64;
            break;
          }
        }
      }
    }

    gb.align32();
  }
}
