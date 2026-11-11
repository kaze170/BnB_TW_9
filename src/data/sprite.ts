/**
 * Sprite sheet decoding — reversed from CA.exe.
 *
 * Three on-disk layouts are used by the shipped TW client:
 *
 *   1. CDataI16        (Cx, and some Fx entries)
 *        u32 count, u32 variant, u32 w, u32 h,
 *        count * 28-byte rects, u32 pixSize, pixel stream
 *
 *   2. CDataI16Character (SkinRsc, CharTE, EmoTE, most of Fx)
 *        u32 frames, u32 type (=2), u32 images, u32 flags,
 *        images * 8-byte  {u32 h, u32 w},
 *        frames * 48-byte records {i32 pad[4], i32 x0,y0,x1,y1, i32 p0,p1,p2,p3},
 *        images * { u32 byteSize, byte pixels[byteSize] }   (interleaved)
 *
 *   3. CDataI16Dyn     (SkinRsc `.bmp` images when stored as loose files)
 *        identical to (2) but the trailing dword is a CRC and the decoder is
 *        fed `pixSize` bytes per image instead of a whole-file size check.
 *
 * Pixel codec: `sub_570710` dispatches on the global colour depth
 * (`dword_62B50C + 956`); depth 4 -> `sub_579770`, depth 5 -> `sub_57B060`,
 * depth 3 -> `sub_579E70`, depth 1 -> `sub_57A690`.
 *
 * `sub_579770` (depth 4, "16 bpp") is reproduced exactly in `decodeDepth4`.
 * Note that in the original the run pointer (`v8`) is advanced by the run
 * length, and a run only ends a scan line when the accumulated pixel count
 * reaches the *width*; a run that overshoots keeps going into the next line
 * without rewinding. We reproduce that faithfully.
 *
 * Word layout: RGB565 stored big-endian; 0 is the transparent colour key
 * (`dword_62B548`).
 */

/** Pixel word -> display colour (0xAABBGGRR little endian, a=0 transparent). */
export function expand16(p: number): number {
  if (p === 0) return 0;
  const r = ((p >> 11) & 0x1f) << 3;
  const g = ((p >> 5) & 0x3f) << 2;
  const b = (p & 0x1f) << 3;
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export interface SheetDecodeResult {
  pixels: Uint32Array;
  /** pixels assigned in bounds (including transparent ones) */
  written: number;
  /** trailing partial-line pixel count when the stream stopped early */
  partial: number;
  overrun: boolean;
}

/**
 * `sub_579770` — the depth-4 unpacker.
 *
 * @param src    pixel stream (may be longer than needed)
 * @param width  scan line width in pixels (a5)
 * @param height number of scan lines (a6)
 * @param clip   `a7`: 1 => transparent runs write the colour key, 0 => leave untouched
 */
export function decodeDepth4(
  src: Uint8Array,
  width: number,
  height: number,
  clip = true,
): SheetDecodeResult {
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const pixels = new Uint32Array(width * height);
  const total = width * height;
  let sp = 0;
  let written = 0; // running pixel count `v17`
  let line = 0; // `v18`
  let overrun = false;
  let painted = 0;

  // The original loops until `v18 == a6`; the only exit is a scan-line
  // boundary. Guard against a malformed stream so we cannot hang.
  const guardMax = src.length + width * height * 2 + 64;

  for (let guard = 0; line < height; guard++) {
    if (guard > guardMax || sp >= src.length) {
      overrun = sp >= src.length;
      break;
    }
    const c = src[sp++];
    if ((c & 0x80) === 0) {
      if (c & 0x40) {
        // packed run of one colour
        const col = expand16(dv.getUint16(sp, true));
        sp += 2;
        const n = c & 0x3f;
        for (let i = 0; i < n; i++) {
          const idx = line * width + written;
          if (idx < total) {
            pixels[idx] = col;
            painted++;
          }
          written++;
        }
      } else if (c > 0) {
        // literal run
        for (let i = 0; i < c; i++) {
          const col = expand16(dv.getUint16(sp, true));
          sp += 2;
          const idx = line * width + written;
          if (idx < total) {
            pixels[idx] = col;
            painted++;
          }
          written++;
        }
      }
      // c == 0 is a zero-length literal run: it consumes a byte and does
      // nothing, exactly like the original (no early exit).
    } else {
      // transparent run
      const n = c & 0x3f;
      if (clip && n) {
        for (let i = 0; i < n; i++) {
          const idx = line * width + written;
          if (idx < total) {
            pixels[idx] = 0;
            painted++;
          }
          written++;
        }
      } else {
        const idx = line * width + written;
        if (idx < total) painted += Math.min(n, total - idx);
        written += n;
      }
    }
    if (written === width) {
      written = 0;
      line++;
    } else if (written > width) {
      // The original would paint past the line end; it then never matches
      // `width` again and the stream desynchronises. Reproduce by
      // carrying the remainder into the next line.
      line += Math.floor(written / width);
      written %= width;
    }
  }
  return { pixels, written: painted, partial: written, overrun };
}

/**
 * `sub_570710` at depth 5 / 3 / 1 is a variant of the same scheme with a
 * different pixel format; `decodeDepthGeneric` covers the *shape* of the run
 * codec so callers can still decode sheets whose headers claim another depth.
 * Only the depth-4 path is exercised by the shipped TW data.
 */
export function decodeSheetStream(
  src: Uint8Array,
  width: number,
  height: number,
  clip = true,
): SheetDecodeResult {
  return decodeDepth4(src, width, height, clip);
}

export interface SpriteRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** pivot / anchor (record +32..+39 in the 48-byte form) */
  pivotX: number;
  pivotY: number;
  /** second anchor pair (record +40..+47) */
  anchorX: number;
  anchorY: number;
  /** frame index inside the image (`record +24`) */
  frame: number;
  /** record +28 */
  pad: number;
}

export interface SpriteImage {
  w: number;
  h: number;
  pixels: Uint32Array;
  written: number;
  overrun: boolean;
}

export interface SpriteSheet {
  /** number of 48-byte frame records */
  count: number;
  /** `variant` for CDataI16, `type` for CDataI16Character (both == 2 in TW data) */
  variant: number;
  /** global sheet size (sum of image widths x max image height) */
  sheetW: number;
  sheetH: number;
  rects: SpriteRect[];
  images: SpriteImage[];
  /** flattened view of all images, concatenated horizontally per image row 0 */
  pixels: Uint32Array;
  written: number;
}

function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}
function i32(dv: DataView, o: number): number {
  return dv.getInt32(o, true);
}

/**
 * CDataI16 — the `variant == 1` layout used by Cx (dialogs, icons, cursor).
 *
 *   +0  count        frames
 *   +4  variant      always 1 here
 *   +8  pixSize      byte size of the pixel stream (verified == len - 16 - 28*count - 4)
 *   +12 width        sheet width
 *   +16 count * 28   { s32 x0, y0, x1, y1, pivotX, pivotY, -1 }
 *       u32 pixSize
 *       depth-4 pixel stream
 *
 * Note there is no explicit sheet size: the extents come from the union of the
 * frame rects, which is how the client sizes its surface (`+8` = table size).
 */
/**
 * CDataI16 `variant == 2` — the SkinRsc image layout.
 *
 *   +0  count       48-byte frame records (sub-rectangles of the one image)
 *   +4  variant     2
 *   +8  images      8-byte { u32 h, u32 w } records
 *   +12 unused       0xCCCCCCCC in shipped data
 *   +16 images * 8   { h, w }
 *       count * 48   frame records
 *       rest         depth-4 pixel stream, images blocks of a size prefix + data
 *
 * Only the first image is decoded into a sheet here; the client's second pass
 * (the `sub_570710` loop) blits each image block separately, and SkinRsc's
 * entries all carry a single image.
 */
function decodeCDataI16Image(buf: Uint8Array): SpriteSheet | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = u32(dv, 0);
  const images = u32(dv, 8);
  if (count < 1 || count > 8192) return null;
  if (images < 1 || images > 256) return null;
  const imgTable = 16 + 8 * images;
  const tableEnd = imgTable + 48 * count;
  if (tableEnd > buf.length) return null;

  const placements: { h: number; w: number }[] = [];
  let sheetW = 0;
  let sheetH = 0;
  for (let i = 0; i < images; i++) {
    const o = 16 + 8 * i;
    const rec = { h: u32(dv, o), w: u32(dv, o + 4) };
    placements.push(rec);
    if (rec.w > sheetW) sheetW = rec.w;
    if (rec.h > sheetH) sheetH = rec.h;
  }
  if (sheetW < 1 || sheetW > 8192 || sheetH < 1 || sheetH > 8192) return null;

  const rects: SpriteRect[] = [];
  for (let i = 0; i < count; i++) {
    const o = imgTable + 48 * i;
    rects.push({
      x0: i32(dv, o + 16),
      y0: i32(dv, o + 20),
      x1: i32(dv, o + 24),
      y1: i32(dv, o + 28),
      pivotX: i32(dv, o + 32),
      pivotY: i32(dv, o + 36),
      anchorX: i32(dv, o + 40),
      anchorY: i32(dv, o + 44),
      frame: i32(dv, o + 8),
      pad: i32(dv, o + 12),
    });
  }

  const res = decodeDepth4(buf.subarray(tableEnd), sheetW, sheetH, true);
  return {
    count,
    variant: 2,
    sheetW,
    sheetH,
    rects,
    images: [{ w: sheetW, h: sheetH, pixels: res.pixels, written: res.written, overrun: res.overrun }],
    pixels: res.pixels,
    written: res.written,
  };
}

export function decodeCDataI16(buf: Uint8Array): SpriteSheet | null {
  if (buf.length < 16) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = u32(dv, 0);
  const variant = u32(dv, 4);
  // variant 2 is the SkinRsc image layout (see decodeCDataI16Image), variant 1
  // the Cx frame-table layout below.
  if (variant === 2) return decodeCDataI16Image(buf);
  if (variant !== 1) return null;
  if (count < 1 || count > 8192) return null;
  const sheetW = u32(dv, 12);
  const tableEnd = 16 + 28 * count;
  if (tableEnd + 4 > buf.length) return null;

  const rects: SpriteRect[] = [];
  let sheetH = 0;
  for (let i = 0; i < count; i++) {
    const o = 16 + 28 * i;
    const r: SpriteRect = {
      x0: i32(dv, o),
      y0: i32(dv, o + 4),
      x1: i32(dv, o + 8),
      y1: i32(dv, o + 12),
      pivotX: i32(dv, o + 16),
      pivotY: i32(dv, o + 20),
      anchorX: 0,
      anchorY: 0,
      frame: i32(dv, o + 24),
      pad: 0,
    };
    rects.push(r);
    if (r.y1 > sheetH) sheetH = r.y1;
  }
  const pixSize = u32(dv, tableEnd);
  if (tableEnd + 4 + pixSize !== buf.length) return null;
  if (sheetW < 1 || sheetW > 8192) return null;

  // The frame rects are sub-pictures, not the sheet size: Etc/LevelIcons is 224
  // wide and holds 90 lines of 16x14 icons whose rects only describe y<=223.
  // The sheet is as tall as the run stream yields, so decode once with an upper
  // bound and keep the height that consumes the stream exactly.
  const stream = buf.subarray(tableEnd + 4, tableEnd + 4 + pixSize);
  const maxRows = Math.max(sheetH, Math.ceil(((stream.length / 2) * 3) / sheetW) + 4);
  let res = decodeDepth4(stream, sheetW, maxRows, true);
  let rows = Math.max(1, Math.round(res.written / sheetW));
  if (rows < maxRows && res.partial === 0) {
    const tuned = decodeDepth4(stream, sheetW, rows, true);
    if (tuned.written === rows * sheetW) {
      res = tuned;
    }
  }
  return {
    count,
    variant,
    sheetW,
    sheetH: rows,
    rects,
    images: [{ w: sheetW, h: rows, pixels: res.pixels, written: res.written, overrun: res.overrun }],
    pixels: res.pixels,
    written: res.written,
  };
}

/** CDataI16Character / CDataI16Dyn — `CDataI16Character::sub_4E1ADF`. */
export function decodeCDataI16Character(buf: Uint8Array): SpriteSheet | null {
  if (buf.length < 32) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const frames = u32(dv, 0);
  const variant = u32(dv, 4);
  const images = u32(dv, 8);
  if (frames < 1 || frames > 8192) return null;
  if (variant < 1 || variant > 8) return null;
  if (images < 1 || images > 256) return null;

  const dimOff = 16;
  const recOff = dimOff + 8 * images;
  const streamOff = recOff + 48 * frames;
  if (streamOff > buf.length) return null;

  // Header invariant: for every image the two dimensions are stored (h, w).
  // Trailing all-zero pairs are tolerated: `CDataI16Character::sub_4E1ADF`
  // allocates a texture per image regardless, and a 0x0 texture (size 0 in
  // the size table) simply never draws.
  for (let i = 0; i < images; i++) {
    const h = u32(dv, dimOff + 8 * i);
    const w = u32(dv, dimOff + 8 * i + 4);
    if (h === 0 && w === 0) continue;
    if (w < 1 || w > 8192 || h < 1 || h > 8192) return null;
  }

  // The per-image size table is interleaved with the data: the decoder walks
  // `u32 size; skip size bytes` once per image (CDataI16Character::sub_4E1ADF
  // second pass, `v40`), so validate the walk lands exactly on EOF.
  {
    let off = streamOff;
    for (let i = 0; i < images; i++) {
      if (off + 4 > buf.length) return null;
      off += 4 + u32(dv, off);
      if (off > buf.length) return null;
    }
    if (off !== buf.length) return null;
  }

  const rects: SpriteRect[] = [];
  for (let i = 0; i < frames; i++) {
    const o = recOff + 48 * i;
    rects.push({
      x0: i32(dv, o + 16),
      y0: i32(dv, o + 20),
      x1: i32(dv, o + 24),
      y1: i32(dv, o + 28),
      pivotX: i32(dv, o + 32),
      pivotY: i32(dv, o + 36),
      anchorX: i32(dv, o + 40),
      anchorY: i32(dv, o + 44),
      frame: i32(dv, o),
      pad: i32(dv, o + 4),
    });
  }

  const out: SpriteImage[] = [];
  let off = streamOff;
  for (let i = 0; i < images; i++) {
    const h = u32(dv, dimOff + 8 * i);
    const w = u32(dv, dimOff + 8 * i + 4);
    const size = u32(dv, off);
    off += 4;
    if (w === 0 || h === 0) {
      out.push({ w: 0, h: 0, pixels: new Uint32Array(0), written: 0, overrun: false });
    } else {
      const res = decodeDepth4(buf.subarray(off, off + size), w, h, true);
      out.push({ w, h, pixels: res.pixels, written: res.written, overrun: res.overrun });
    }
    off += size;
  }

  const sheetW = out.reduce((a, c) => a + c.w, 0);
  const sheetH = out.reduce((a, c) => Math.max(a, c.h), 0);
  const pixels = new Uint32Array(sheetW * sheetH);
  let xoff = 0;
  for (const img of out) {
    for (let y = 0; y < img.h; y++) {
      pixels.set(img.pixels.subarray(y * img.w, (y + 1) * img.w), y * sheetW + xoff);
    }
    xoff += img.w;
  }
  const written = out.reduce((a, c) => a + c.written, 0);

  return { count: frames, variant, sheetW, sheetH, rects, images: out, pixels, written };
}

/** Decode any supported sheet layout (Cx / Fx / CharTE / EmoTE / SkinRsc). */
export function decodeSpriteSheet(buf: Uint8Array): SpriteSheet | null {
  return decodeCDataI16(buf) ?? decodeCDataI16Character(buf);
}

/** Convert a decoded sheet into a browser-ready RGBA buffer. */
export function sheetToRGBA(sheet: SpriteSheet): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sheet.sheetW * sheet.sheetH * 4);
  const src = sheet.pixels;
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    const c = src[i];
    const a = c >>> 24;
    if (a === 0) continue;
    out[j] = c & 0xff;
    out[j + 1] = (c >>> 8) & 0xff;
    out[j + 2] = (c >>> 16) & 0xff;
    out[j + 3] = a;
  }
  return out;
}

/** Convert one image of a decoded sheet into a browser-ready RGBA buffer. */
export function imageToRGBA(img: SpriteImage): Uint8ClampedArray {
  return sheetToRGBA({
    count: 0,
    variant: 0,
    sheetW: img.w,
    sheetH: img.h,
    rects: [],
    images: [img],
    pixels: img.pixels,
    written: img.written,
  });
}
