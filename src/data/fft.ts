/**
 * Retail `.fft` bitmap font loader (`CFontMan`, `CA.exe` `0x573B00..0x574890`).
 *
 * Verified directly against `CxUni.fft` (2,927,597 bytes) and `CxDefault.fft`:
 *   - 32-byte header:
 *       +0   u32 version / flags
 *       +4   u32 glyphCount (65535 in CxUni.fft)
 *       +8   u32 glyphW (12)
 *       +12  u32 glyphH (12)
 *       +16  u32 glyphRecordBytes (19 = 1-byte advance + 18-byte 1bpp 12x12 bitmap)
 *       +20  u32 hasOutline (1 in CxUni.fft)
 *       +24  u32 outlineRecordBytes (26 = 1-byte advance + 25-byte 1bpp 14x14 bitmap)
 *       +28  u32 reserved
 *   - Base glyph table at `32 + cp * 19`:
 *       byte[0]    = advance width (`6` forced for `{0, 10, 13, 32}`)
 *       byte[1..18]= MSB-first packed 12*12 = 144 bits
 *   - Outline table at `32 + 65535 * 19 + cp * 26` (`1,245,197 + cp * 26`):
 *       byte[0]    = outline width (`adv = byte[0] - 2`)
 *       byte[1..25]= MSB-first packed 14*14 = 196 bits, drawn at `(-1, -1)`
 *
 * Retail text styles (`0x61E7D8`):
 *   0 = plain   (12x12 foreground)
 *   1 = shadow  (12x12 shadow at (+1,+1), then foreground at (0,0))
 *   2 = outline (14x14 outline at (-1,-1), then foreground at (0,0))
 *   3 = bold    (12x12 foreground at (0,0) and (+1,0))
 */

export type FontStyle = 0 | 1 | 2 | 3;
export type FftStyle = FontStyle;

export interface GlyphBitmap {
  /** pixel width of the rasterized cell (14 for outline/shadow/bold, 12 for plain) */
  w: number;
  h: number;
  /** draw offset relative to pen `(x, y)` */
  dx: number;
  dy: number;
  /** horizontal pen advance in logical pixels */
  advance: number;
  /** packed RGBA pixels (`w * h`): white `(255,255,255,255)` = fg, black `(0,0,0,255)` = outline/shadow */
  // Channel encoding for single-pass tinted shader:
  //    We rasterize two masks or directly bake RGBA for `(fgColor, bgColor)` OR
  //   even cleaner: rasterize separate `outlineMask` + `fgMask` into two quads
  //   so ANY arbitrary `(fgColor, outlineColor)` tints at zero extra atlas cost!
  fgPixels: Uint8Array; // w * h * 4 white+alpha
  bgPixels: Uint8Array | null; // w * h * 4 white+alpha (for style 1 shadow or style 2 outline)
}

export class FftFont {
  readonly count: number;
  readonly width: number;
  readonly height: number;
  readonly recordSize: number;
  readonly hasOutline: boolean;
  readonly outlineRecordSize: number;
  private readonly buf: Uint8Array;
  private readonly glyphBase = 32;
  private readonly outlineBase: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Validate CxUni.fft / CxDefault.fft layout
    const c1 = dv.getUint32(4, true);
    if (buf.length >= 2900000) {
      // CxUni.fft exact layout verified from CA.exe CFontMan
      this.count = 65535;
      this.width = 12;
      this.height = 12;
      this.recordSize = 19;
      this.hasOutline = true;
      this.outlineRecordSize = 26;
      this.outlineBase = 32 + 65535 * 19;
    } else {
      this.count = c1 > 0 && c1 <= 65536 ? c1 : Math.floor((buf.length - 32) / 19);
      this.width = 12;
      this.height = 12;
      this.recordSize = 19;
      this.outlineBase = 32 + this.count * 19;
      this.hasOutline = this.outlineBase + this.count * 26 <= buf.length;
      this.outlineRecordSize = 26;
    }
  }

  advanceOf(cp: number, style: FontStyle = 0): number {
    if (cp === 0 || cp === 10 || cp === 13 || cp === 32) return 6;
    if (cp === 9) return 24;
    if (cp < 0 || cp >= this.count) return 6;
    const off = this.glyphBase + cp * this.recordSize;
    if (off >= this.buf.length) return 6;
    const rawAdv = this.buf[off]!;
    const base = rawAdv > 0 && rawAdv <= 16 ? rawAdv : cp < 128 ? 6 : 12;
    return style === 3 ? base + 1 : base;
  }

  measureText(text: string, style: FontStyle = 0): number {
    let w = 0;
    let maxW = 0;
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp === 10) {
        if (w > maxW) maxW = w;
        w = 0;
        continue;
      }
      if (cp === 13) continue;
      w += this.advanceOf(cp, style);
    }
    return Math.max(maxW, w);
  }

  rasterize(cp: number, style: FontStyle): GlyphBitmap {
    const adv = this.advanceOf(cp, style);
    const w = 14;
    const h = 14;
    const fg = new Uint8Array(w * h * 4);
    if (cp <= 32 || cp >= this.count) {
      return { w, h, dx: -1, dy: -1, advance: adv, fgPixels: fg, bgPixels: null };
    }

    const gOff = this.glyphBase + cp * this.recordSize;
    if (gOff + this.recordSize <= this.buf.length) {
      // Unpack 12x12 MSB-first into (1..12, 1..12) of the 14x14 cell
      for (let bitIdx = 0; bitIdx < 144; bitIdx++) {
        const byteVal = this.buf[gOff + 1 + (bitIdx >>> 3)]!;
        const on = (byteVal & (0x80 >>> (bitIdx & 7))) !== 0;
        if (!on) continue;
        const gx = 1 + (bitIdx % 12);
        const gy = 1 + Math.floor(bitIdx / 12);
        const p = (gy * w + gx) * 4;
        fg[p] = 255;
        fg[p + 1] = 255;
        fg[p + 2] = 255;
        fg[p + 3] = 255;
        if (style === 3 && gx + 1 < w) {
          const p2 = (gy * w + gx + 1) * 4;
          fg[p2] = 255;
          fg[p2 + 1] = 255;
          fg[p2 + 2] = 255;
          fg[p2 + 3] = 255;
        }
      }
    }

    let bg: Uint8Array | null = null;
    if (style === 1) {
      // Drop-shadow shifted (+1, +1)
      bg = new Uint8Array(w * h * 4);
      for (let gy = 1; gy <= 12; gy++) {
        for (let gx = 1; gx <= 12; gx++) {
          const srcA = fg[(gy * w + gx) * 4 + 3]!;
          if (srcA === 0) continue;
          const p = ((gy + 1) * w + (gx + 1)) * 4;
          bg[p] = 255;
          bg[p + 1] = 255;
          bg[p + 2] = 255;
          bg[p + 3] = 255;
        }
      }
    } else if (style === 2) {
      bg = new Uint8Array(w * h * 4);
      const oOff = this.outlineBase + cp * this.outlineRecordSize;
      if (this.hasOutline && oOff + this.outlineRecordSize <= this.buf.length) {
        // Native 14x14 outline bitmap from CxUni.fft!
        for (let bitIdx = 0; bitIdx < 196; bitIdx++) {
          const byteVal = this.buf[oOff + 1 + (bitIdx >>> 3)]!;
          const on = (byteVal & (0x80 >>> (bitIdx & 7))) !== 0;
          if (!on) continue;
          const p = bitIdx * 4;
          bg[p] = 255;
          bg[p + 1] = 255;
          bg[p + 2] = 255;
          bg[p + 3] = 255;
        }
      } else {
        // Synthesize 8-neighbor 1px outline if CxDefault.fft lacks outline section
        for (let gy = 1; gy <= 12; gy++) {
          for (let gx = 1; gx <= 12; gx++) {
            if (fg[(gy * w + gx) * 4 + 3] === 0) continue;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const p = ((gy + dy) * w + (gx + dx)) * 4;
                bg[p] = 255;
                bg[p + 1] = 255;
                bg[p + 2] = 255;
                bg[p + 3] = 255;
              }
            }
          }
        }
      }
    }

    return { w, h, dx: -1, dy: -1, advance: adv, fgPixels: fg, bgPixels: bg };
  }
}
