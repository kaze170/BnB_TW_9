/**
 * Browser/runtime asset layer.
 *
 * The whole point of this project is to *not* re-bake the game's art: the
 * client streams `<Pack>.idx` + `<Pack>.idd` and decodes them on the fly with
 * the same algorithms the executable uses (src/data/*).
 *
 * Layout served by server/index.ts:
 *   /game/SkinRsc.idx, /game/SkinRsc.idd, ...
 *   /game/stringtable.ini, /game/csysstr.ssd, ...
 */
import { Pack } from './pack.ts';
import {
  decodeCDataI16,
  decodeCDataI16Character,
  sheetToRGBA,
  type SpriteSheet,
} from './sprite.ts';
import { readSsi, decodeStringTable, decodeSystemStrings, type StringRow, type SystemStringRow } from './ssi.ts';

export type PackName = 'SkinRsc' | 'SkinDsc' | 'Cx' | 'Fx' | 'CharTE' | 'EmoTE';

/** Lazily fetched raw bytes; a pack's .idd is only pulled when first needed. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[assets] ${url} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export class GameAssets {
  private readonly base: string;
  private readonly packs = new Map<PackName, Promise<Pack>>();
  private readonly sheets = new Map<string, Promise<SpriteSheet | null>>();
  private readonly textures = new Map<string, Promise<ImageBitmap | null>>();
  private configs?: Promise<{
    stringTable: StringRow[];
    systemStrings: SystemStringRow[];
    raw: Map<string, Uint8Array>;
  }>;

  constructor(base = '/game') {
    this.base = base;
  }

  pack(name: PackName): Promise<Pack> {
    let p = this.packs.get(name);
    if (!p) {
      p = (async () => {
        const [idx, idd] = await Promise.all([
          fetchBytes(`${this.base}/${name}.idx`),
          fetchBytes(`${this.base}/${name}.idd`),
        ]);
        return new Pack(name, idx, idd);
      })();
      this.packs.set(name, p);
    }
    return p;
  }

  /** Decode one sprite sheet (cached). */
  sheet(pack: PackName, name: string): Promise<SpriteSheet | null> {
    const key = `${pack}:${name}`;
    let s = this.sheets.get(key);
    if (!s) {
      s = (async () => {
        const p = await this.pack(pack);
        const payload = p.payload(name);
        if (!payload) return null;
        return decodeCDataI16(payload) ?? decodeCDataI16Character(payload);
      })();
      this.sheets.set(key, s);
    }
    return s;
  }

  /** Decode one sheet straight to an uploadable ImageBitmap (cached). */
  texture(pack: PackName, name: string): Promise<ImageBitmap | null> {
    const key = `${pack}:${name}`;
    let t = this.textures.get(key);
    if (!t) {
      t = (async () => {
        const sheet = await this.sheet(pack, name);
        if (!sheet) return null;
        const rgba = sheetToRGBA(sheet);
        // ImageData insists on a non-shared ArrayBuffer; copy into one.
        const pixels = new Uint8ClampedArray(rgba.length);
        pixels.set(rgba);
        const data = new ImageData(pixels, sheet.sheetW, sheet.sheetH);
        return createImageBitmap(data, {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  /**
   * A pack entry that is a whole image rather than a CDataI16 sheet.  Several
   * screens ship as JPEGs inside the packs (`Cx`'s `StageChannel/CAStage` is
   * the 800x600 channel screen, SkinRsc's `LoginStageBack.jpg` the login one);
   * the client hands them straight to the JPEG decoder, and so do we.
   */
  async image(pack: PackName, name: string): Promise<ImageBitmap | null> {
    const key = `img:${pack}:${name}`;
    let t = this.textures.get(key);
    if (!t) {
      t = (async () => {
        const p = await this.pack(pack);
        const payload = p.payload(name);
        if (!payload || payload.length < 4) return null;
        // SOI marker: the pack never compresses these, they are stored as-is.
        if (payload[0] !== 0xff || payload[1] !== 0xd8) return null;
        const blob = new Blob([payload as unknown as BlobPart], { type: 'image/jpeg' });
        return createImageBitmap(blob);
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  /** Decoded string tables and the raw config payloads. */
  config(): Promise<{
    stringTable: StringRow[];
    systemStrings: SystemStringRow[];
    raw: Map<string, Uint8Array>;
  }> {
    if (!this.configs) {
      this.configs = (async () => {
        const files = [
          'stringtable.ini',
          'csysstr.ssd',
          'fxstock.ini',
          'packagemap.ini',
          'fxdynmapinfo.ssd',
          'channel2_000.ssd',
          'multisvr.ssd',
        ];
        const raw = new Map<string, Uint8Array>();
        let stringTable: StringRow[] = [];
        let systemStrings: SystemStringRow[] = [];
        await Promise.all(
          files.map(async (f) => {
            try {
              const bytes = await fetchBytes(`${this.base}/${f}`);
              const ssi = readSsi(bytes);
              if (!ssi) return;
              raw.set(f, ssi.payload);
              stringTable = decodeStringTable(ssi.payload) ?? stringTable;
              systemStrings = decodeSystemStrings(ssi.payload) ?? systemStrings;
            } catch {
              /* missing config is not fatal */
            }
          }),
        );
        return { stringTable, systemStrings, raw };
      })();
    }
    return this.configs;
  }
}
