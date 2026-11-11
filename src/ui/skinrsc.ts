/**
 * SkinRsc: the login skin art.
 *
 * Every entry is a CDataI16 block whose pixel stream is depth-4 indexed and
 * whose 48-byte frame records carry the sub-rectangles the UI slices out of
 * the one bitmap (a BMP in the original, decoded in place by the client).
 * The one true JPEG in the pack (LoginStageBack.jpg) is stored verbatim, as
 * the loader's `variant != 2` path shows: it is handed straight to the JPEG
 * decoder rather than unpacked as depth-4 data.
 */

import { decodeCDataI16, sheetToRGBA, type SpriteSheet } from '../data/sprite.ts';
import type { Pack } from '../data/pack.ts';

export interface SkinImage {
  name: string;
  /** raw CDataI16 sheet (frames + pixels) for depth-4 art */
  sheet: SpriteSheet | null;
  /** raw bytes for the JPEG entries */
  jpeg: Uint8Array | null;
  bitmap: ImageBitmap | null;
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function isJpeg(bytes: Uint8Array): boolean {
  return JPEG_MAGIC.every((b, i) => bytes[i] === b);
}

/** Decode one SkinRsc entry into something the renderer can upload. */
export async function loadSkinImage(pack: Pack, name: string): Promise<SkinImage> {
  const payload = pack.payload(name);
  if (!payload) return { name, sheet: null, jpeg: null, bitmap: null };

  if (isJpeg(payload)) {
    const blob = new Blob([payload as unknown as BlobPart], { type: 'image/jpeg' });
    return { name, sheet: null, jpeg: payload, bitmap: await createImageBitmap(blob) };
  }

  const sheet = decodeCDataI16(payload);
  if (!sheet) return { name, sheet: null, jpeg: null, bitmap: null };
  const rgba = sheetToRGBA(sheet);
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  const bitmap = await createImageBitmap(new ImageData(pixels, sheet.sheetW, sheet.sheetH), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  return { name, sheet, jpeg: null, bitmap };
}

/** SkinRsc entry names, as stored in the index (backslashes and all). */
export const SKIN = {
  bt1p: 'img\\Bt1P.bmp',
  bt2p: 'img\\Bt2P.bmp',
  btLoginCancel: 'img\\BtLoginCancel.bmp',
  btLoginCredit: 'img\\BtLoginCredit.bmp',
  btLoginNewId: 'img\\BtLoginNewId.bmp',
  btLoginOk: 'img\\BtLoginOK.bmp',
  loginTable00: 'img\\korea\\LoginTable00.bmp',
  loginTable01: 'img\\korea\\LoginTable01.bmp',
  serverDream: 'img\\korea\\ServerDream.bmp',
  serverDream2p: 'img\\korea\\ServerDream2P.bmp',
  serverHappy: 'img\\korea\\ServerHappy.bmp',
  serverHappy2p: 'img\\korea\\ServerHappy2P.bmp',
  loginStageBack: 'img\\LoginStageBack.jpg',
} as const;
