/**
 * Runtime retail asset manager (`src/data/assets.ts`).
 *
 * Streams unmodified retail Taiwan BnB v9 archives (`.idx/.idd`), `ssi1` tables
 * (`.ssd/.ini`), `CxUni.fft` bitmap/outline font, and `nm.bik` Bink intro video,
 * decoding every format (`decryptIndex`, `decryptPayload`, `CDataI16`,
 * `CDataI16Character`, `TEAM_HLS`, `FftFont`, `BikVideo`) in pure client TypeScript.
 *
 * Supports both full-pack `.idd` loading AND coalesced byte-range slice loading
 * (`/api/pack-slices` / HTTP `Range`) so initial boot over WAN is < 2 MB while
 * every sprite, WAV, MP3, map, cosmetic (`CharTE`), and emotion (`EmoTE`) loads
 * seamlessly on demand.
 */

import {
  Pack,
  decryptPayload,
  normalizeName,
  parseIndex,
  type IdxEntry,
} from "./pack.ts";
import {
  decodeCDataI16,
  decodeCDataI16Character,
  inflateBnbZlib,
  sheetToRGBA,
  type SpriteRect,
  type SpriteSheet,
} from "./sprite.ts";
import {
  decodeStringTable,
  decodeSystemStrings,
  readSsi,
  type StringRow,
  type SystemStringRow,
} from "./ssi.ts";
import { CosmeticCatalog } from "./cosmetics.ts";
import { includeArchiveMaps, parseMapInfo, type MapInfo, type MapInfoEntry, type MapInfoFile } from "./mapinfo.ts";
import { readChannelFile, type Channel, type ChannelFile } from "./channel.ts";
import { readServerList, type ServerList } from "./serverlist.ts";
import { FftFont } from "./fft.ts";
import {
  AVATAR_DECO_ACTION_MAP,
  compositeAvatarLayers,
  compositeTwoLayerCharacter,
  tintRgbaByTeam,
  type AvatarPartLayer,
} from "./hls.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import {
  ObjectTable,
  parseBomberAttr,
  parseFxStock,
  parseItemAttr,
  parseMapBinary,
  parseMapGroup,
  parsePackageMap,
  parseStringTable,
  parseSysStrings,
  parseTileInfo,
  type BomberSpec,
  type ItemAttrTable,
  type ParsedMapData,
  type StockItem,
  type TileSpec,
} from "./tables.ts";

export type PackName = "SkinRsc" | "SkinDsc" | "Cx" | "Fx" | "CharTE" | "EmoTE";

/**
 * Retail `BomberAttr` selectable roster order (`0..7`) -> `BomberSpec.code` (`C00..C07`):
 * `0:藍寶(C00), 1:睏寶(C01), 2:痞子妹(C03), 3:工頭(C05), 4:栗子(C04), 5:藍妹妹(C06), 6:囡囡(C02), 7:胖墩(C07)`.
 * (`CA.exe.c` `L373837..373851`, `CBomberSelectWnd` `L109883..110088`).
 */
export const CHAR_MAIN_MAP = [0, 1, 3, 5, 4, 6, 2, 7] as const;

export interface DecodedRgbaSheet {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly rects: readonly SpriteRect[];
}

export interface LoadedSheet {
  readonly tex: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly sheet: { readonly rects: readonly SpriteRect[] } | null;
}

async function fetchBytes(url: string, init?: RequestInit): Promise<Uint8Array> {
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 206) {
    throw new Error(`[assets] ${url} -> ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Index-backed archive that can satisfy entry lookups either from a full `.idd`
 * buffer OR from coalesced byte-range slices fetched on demand and cached in RAM.
 */
export class StreamingPack {
  readonly name: PackName;
  readonly base: string;
  readonly entries: IdxEntry[];
  private readonly byNorm = new Map<string, IdxEntry>();
  private fullIdd: Uint8Array | null = null;
  private readonly rawSlices = new Map<string, Uint8Array>();
  private readonly decSlices = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<Uint8Array | null>>();

  constructor(name: PackName, base: string, idxBytes: Uint8Array, fullIdd?: Uint8Array) {
    this.name = name;
    this.base = base;
    const parsed = parseIndex(idxBytes);
    if (!parsed) throw new Error(`[StreamingPack] invalid index for ${name}`);
    this.entries = parsed.entries;
    for (const e of parsed.entries) {
      this.byNorm.set(normalizeName(e.name), e);
    }
    if (fullIdd) this.fullIdd = fullIdd;
  }

  attachFullIdd(idd: Uint8Array): void {
    this.fullIdd = idd;
  }

  has(name: string): boolean {
    return this.byNorm.has(normalizeName(name));
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  getPayload(name: string): Promise<Uint8Array | null> {
    return this.payload(name);
  }

  entry(name: string): IdxEntry | undefined {
    return this.byNorm.get(normalizeName(name));
  }

  entriesMatching(prefixOrPred: string | ((e: IdxEntry) => boolean)): IdxEntry[] {
    if (typeof prefixOrPred === "string") {
      const p = normalizeName(prefixOrPred);
      return this.entries.filter((e) => normalizeName(e.name).startsWith(p));
    }
    return this.entries.filter(prefixOrPred);
  }

  /** Synchronous raw lookup if already resident in fullIdd or slice cache. */
  rawSync(name: string): Uint8Array | null {
    const key = normalizeName(name);
    const cached = this.rawSlices.get(key);
    if (cached) return cached;
    const e = this.byNorm.get(key);
    if (!e || !this.fullIdd) return null;
    return this.fullIdd.subarray(e.offset, e.offset + e.size);
  }

  /** Synchronous decrypted payload lookup if already resident. */
  payloadSync(name: string): Uint8Array | null {
    const key = normalizeName(name);
    const dec = this.decSlices.get(key);
    if (dec) return dec;
    const e = this.byNorm.get(key);
    if (!e) return null;
    const raw = this.rawSync(name);
    if (!raw) return null;
    const out = e.key ? decryptPayload(raw, e.key) : raw;
    this.decSlices.set(key, out);
    return out;
  }

  /** Fetch & cache multiple entries in ONE coalesced HTTP call (`/api/pack-slices`). */
  async prefetch(names: readonly string[]): Promise<void> {
    if (this.fullIdd) return;
    const needed: IdxEntry[] = [];
    const waitList: Promise<Uint8Array | null>[] = [];
    const seen = new Set<string>();

    for (const n of names) {
      const key = normalizeName(n);
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.rawSlices.has(key) || this.decSlices.has(key)) continue;
      const inf = this.inflight.get(key);
      if (inf) {
        waitList.push(inf);
        continue;
      }
      const e = this.byNorm.get(key);
      if (e) needed.push(e);
    }

    if (needed.length > 0) {
      // Chunk into batches of <= 120 entries so responses stay snappy
      const BATCH = 120;
      for (let start = 0; start < needed.length; start += BATCH) {
        const batch = needed.slice(start, start + BATCH);
        let resolveBatch!: () => void;
        const gate = new Promise<void>((r) => {
          resolveBatch = r;
        });
        for (const e of batch) {
          const k = normalizeName(e.name);
          this.inflight.set(
            k,
            gate.then(() => this.payloadSync(e.name)),
          );
        }
        try {
          const res = await fetch("/api/pack-slices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pack: this.name,
              ranges: batch.map((e) => [e.offset, e.size]),
            }),
          });
          if (res.ok) {
            const concat = new Uint8Array(await res.arrayBuffer());
            let pos = 0;
            for (const e of batch) {
              const slice = concat.subarray(pos, pos + e.size);
              pos += e.size;
              this.rawSlices.set(normalizeName(e.name), slice);
            }
          } else {
            // Fallback to individual HTTP Range fetches
            await Promise.all(
              batch.map(async (e) => {
                const slice = await fetchBytes(`${this.base}/${this.name}.idd`, {
                  headers: { Range: `bytes=${e.offset}-${e.offset + e.size - 1}` },
                });
                this.rawSlices.set(normalizeName(e.name), slice);
              }),
            );
          }
        } finally {
          for (const e of batch) {
            this.inflight.delete(normalizeName(e.name));
          }
          resolveBatch();
        }
      }
    }

    if (waitList.length > 0) {
      await Promise.all(waitList);
    }
  }

  async prefetchPrefixes(prefixes: readonly string[]): Promise<void> {
    if (this.fullIdd) return;
    const names: string[] = [];
    for (const p of prefixes) {
      for (const e of this.entriesMatching(p)) {
        names.push(e.name);
      }
    }
    await this.prefetch(names);
  }

  async payload(name: string): Promise<Uint8Array | null> {
    const sync = this.payloadSync(name);
    if (sync) return sync;
    await this.prefetch([name]);
    return this.payloadSync(name);
  }
}

export interface CoreTables {
  readonly objectTable: ObjectTable;
  readonly bombers: readonly BomberSpec[];
  readonly bomberByCode: ReadonlyMap<number, BomberSpec>;
  readonly itemAttr: ItemAttrTable;
  readonly tileInfo: ReadonlyMap<string, TileSpec>;
  readonly fxStock: readonly StockItem[];
  readonly stockById: ReadonlyMap<number, StockItem>;
  readonly packageMap: ReadonlyMap<number, readonly number[]>;
  readonly sysStrings: ReadonlyMap<string, string>;
  readonly stringTable: ReadonlyMap<number, string>;
  readonly mapInfo: MapInfoFile;
  readonly playableMaps: readonly MapInfo[];
  readonly themeRandomMaps: readonly MapInfo[];
  readonly mapGroups: ReadonlyMap<string, readonly string[]>;
  readonly channels: ChannelFile | null;
  readonly servers: ServerList | null;
  readonly charObjectTable: ObjectTable;
  readonly emoObjectTable: ObjectTable;
  readonly cosmetics: CosmeticCatalog;
}

export class GameAssets {
  readonly base: string;
  private readonly packs = new Map<PackName, Promise<Pack>>();
  private readonly streamPacks = new Map<PackName, StreamingPack>();
  private readonly sheets = new Map<string, Promise<SpriteSheet | null>>();
  private readonly rgbaSheets = new Map<string, DecodedRgbaSheet | null>();
  private readonly rgbaSheetPromises = new Map<string, Promise<DecodedRgbaSheet | null>>();
  private readonly parsedMaps = new Map<string, ParsedMapData>();
  private readonly textures = new Map<string, Promise<ImageBitmap | null>>();
  private readonly gpuSheets = new Map<string, Promise<LoadedSheet | null>>();
  private rendererRef: SpriteRenderer | null = null;
  private cachedMapEntries: MapInfoEntry[] | null = null;

  font: FftFont | null = null;
  introVideoBytes: Uint8Array | null = null;
  tables: CoreTables | null = null;

  attachRenderer(r: SpriteRenderer): void {
    this.rendererRef = r;
  }

  get fx(): StreamingPack {
    return this.streamPack("Fx");
  }
  get cx(): StreamingPack {
    return this.streamPack("Cx");
  }
  get skinRsc(): StreamingPack {
    return this.streamPack("SkinRsc");
  }
  get skinDsc(): StreamingPack {
    return this.streamPack("SkinDsc");
  }
  get charTe(): StreamingPack {
    return this.streamPack("CharTE");
  }
  get emoTe(): StreamingPack {
    return this.streamPack("EmoTE");
  }
  get objects(): ObjectTable {
    if (!this.tables) throw new Error("[GameAssets] objects accessed before boot()");
    return this.tables.objectTable;
  }
  get charObjects(): ObjectTable {
    if (!this.tables) throw new Error("[GameAssets] charObjects accessed before boot()");
    return this.tables.charObjectTable;
  }
  get emoObjects(): ObjectTable {
    if (!this.tables) throw new Error("[GameAssets] emoObjects accessed before boot()");
    return this.tables.emoObjectTable;
  }
  get cosmetics(): CosmeticCatalog {
    if (!this.tables) throw new Error("[GameAssets] cosmetics accessed before boot()");
    return this.tables.cosmetics;
  }
  get maps(): MapInfoEntry[] {
    if (!this.cachedMapEntries) {
      const src = this.tables?.mapInfo.maps ?? [];
      this.cachedMapEntries = src.map((m) => ({
        code: m.name,
        displayName: m.description || m.name,
        maxPlayers: 8,
        description: `${m.family || "經典"}系列對戰地圖`,
      }));
    }
    return this.cachedMapEntries;
  }
  get channels(): Channel[] {
    return this.tables?.channels?.channels ?? [];
  }

  private bootPromise?: Promise<void>;
  private mapInfos?: Promise<MapInfoFile | null>;
  private configs?: Promise<{
    stringTable: StringRow[];
    systemStrings: SystemStringRow[];
    raw: Map<string, Uint8Array>;
  }>;

  constructor(base = "/game") {
    this.base = base;
  }

  /**
   * Fast boot loader: loads `CxUni.fft`, `nm.bik`, `SkinDsc`, `SkinRsc`, `Cx`,
   * all `.idx` headers (`Fx`, `CharTE`, `EmoTE`), `.ssd/.ini` configs, and the
   * 4 core simulation tables in `Fx` (`ObjectTable`, `BomberAttr`, `ItemAttr`, `TileInfo`).
   */
  boot(): Promise<void> {
    if (!this.bootPromise) {
      this.bootPromise = this.doBoot();
    }
    return this.bootPromise;
  }

  private async doBoot(): Promise<void> {
    const [
      fftBytes,
      bikBytes,
      skinDscIdx,
      skinDscIdd,
      skinRscIdx,
      skinRscIdd,
      cxIdx,
      cxIdd,
      fxIdx,
      charTeIdx,
      emoTeIdx,
      fxStockRaw,
      pkgMapRaw,
      sysStrRaw,
      strTabRaw,
      mapInfoRaw,
      chanRaw,
      svrRaw,
    ] = await Promise.all([
      fetchBytes(`${this.base}/CxUni.fft`),
      fetchBytes(`${this.base}/nm.bik`),
      fetchBytes(`${this.base}/SkinDsc.idx`),
      fetchBytes(`${this.base}/SkinDsc.idd`),
      fetchBytes(`${this.base}/SkinRsc.idx`),
      fetchBytes(`${this.base}/SkinRsc.idd`),
      fetchBytes(`${this.base}/Cx.idx`),
      fetchBytes(`${this.base}/Cx.idd`),
      fetchBytes(`${this.base}/Fx.idx`),
      fetchBytes(`${this.base}/CharTE.idx`),
      fetchBytes(`${this.base}/EmoTE.idx`),
      fetchBytes(`${this.base}/fxstock.ini`),
      fetchBytes(`${this.base}/packagemap.ini`),
      fetchBytes(`${this.base}/csysstr.ssd`),
      fetchBytes(`${this.base}/stringtable.ini`),
      fetchBytes(`${this.base}/fxdynmapinfo.ssd`),
      fetchBytes(`${this.base}/channel2_000.ssd`),
      fetchBytes(`${this.base}/multisvr.ssd`),
    ]);

    this.font = new FftFont(fftBytes);
    this.introVideoBytes = bikBytes;

    const skinDscPack = new Pack("SkinDsc", skinDscIdx, skinDscIdd);
    const skinRscPack = new Pack("SkinRsc", skinRscIdx, skinRscIdd);
    const cxPack = new Pack("Cx", cxIdx, cxIdd);
    this.packs.set("SkinDsc", Promise.resolve(skinDscPack));
    this.packs.set("SkinRsc", Promise.resolve(skinRscPack));
    this.packs.set("Cx", Promise.resolve(cxPack));

    this.streamPacks.set("SkinDsc", new StreamingPack("SkinDsc", this.base, skinDscIdx, skinDscIdd));
    this.streamPacks.set("SkinRsc", new StreamingPack("SkinRsc", this.base, skinRscIdx, skinRscIdd));
    this.streamPacks.set("Cx", new StreamingPack("Cx", this.base, cxIdx, cxIdd));

    const fxStream = new StreamingPack("Fx", this.base, fxIdx);
    const charTeStream = new StreamingPack("CharTE", this.base, charTeIdx);
    const emoTeStream = new StreamingPack("EmoTE", this.base, emoTeIdx);
    this.streamPacks.set("Fx", fxStream);
    this.streamPacks.set("CharTE", charTeStream);
    this.streamPacks.set("EmoTE", emoTeStream);

    // Prefetch core Fx/CharTE/EmoTE ObjectTables + global UI + cursor + button sounds in parallel!
    await Promise.all([
      fxStream.prefetch([
        "ObjectTable/ObjectTable",
        "Attr/BomberAttr",
        "Attr/ItemAttr",
        "Attr/MapGroup",
        "TileInfo/TileInfo",
        "Shadow/Shadow",
        "Slot/Slot",
        "Wave/ButtonDown_0",
        "Wave/ButtonDown_1",
        "Wave/ButtonDown_2",
        "Wave/MouseMove_0",
        "Wave/Close",
        "Wave/Connect",
        "Wave/Title",
        ...fxStream.entriesMatching("GlobalUI/").map((e) => e.name),
        ...fxStream.entriesMatching("Level/").map((e) => e.name),
      ]),
      charTeStream.prefetch(["ObjectTable/CharTEObjectTable"]),
      emoTeStream.prefetch(["ObjectTable/EmoTEObjectTable"]),
    ]);

    const objBuf = fxStream.payloadSync("ObjectTable/ObjectTable")!;
    const charObjBuf = charTeStream.payloadSync("ObjectTable/CharTEObjectTable")!;
    const emoObjBuf = emoTeStream.payloadSync("ObjectTable/EmoTEObjectTable")!;
    const bomberBuf = fxStream.payloadSync("Attr/BomberAttr")!;
    const itemBuf = fxStream.payloadSync("Attr/ItemAttr")!;
    const mapGroupBuf = fxStream.payloadSync("Attr/MapGroup");
    const tileBuf = fxStream.payloadSync("TileInfo/TileInfo")!;

    const objectTable = new ObjectTable(objBuf);
    const charObjectTable = new ObjectTable(charObjBuf);
    const emoObjectTable = new ObjectTable(emoObjBuf);
    const bombers = parseBomberAttr(bomberBuf);
    const bomberByCode = new Map<number, BomberSpec>();
    for (const b of bombers) bomberByCode.set(b.code, b);
    const itemAttr = parseItemAttr(itemBuf);
    const mapGroups = mapGroupBuf ? parseMapGroup(mapGroupBuf) : new Map<string, string[]>();
    const tileInfo = parseTileInfo(tileBuf);
    const fxStock = parseFxStock(fxStockRaw);
    const stockById = new Map<number, StockItem>();
    for (const s of fxStock) stockById.set(s.id, s);
    const packageMap = parsePackageMap(pkgMapRaw);
    const sysStrings = parseSysStrings(sysStrRaw);
    const stringTable = parseStringTable(strTabRaw);
    const mapSsi = readSsi(mapInfoRaw);
    const mapInfo = includeArchiveMaps(
      (mapSsi ? parseMapInfo(mapSsi.payload) : null) ?? { count: 0, maps: [] },
      fxStream.names(),
    );
    const playableMaps = mapInfo.maps.filter((m) => !m.random && fxStream.has(`Map/${m.name}`));
    const playableFamilies = new Set(playableMaps.map((m) => m.family.toLowerCase()));
    const themeRandomMaps = mapInfo.maps.filter(
      (m) => m.random && m.family !== "Random" && playableFamilies.has(m.family.toLowerCase()),
    );
    const channels = readChannelFile(chanRaw, "channel2_000.ssd");
    const servers = readServerList(svrRaw);
    const cxStream = this.streamPacks.get("Cx")!;
    const cosmetics = new CosmeticCatalog({
      stocks: fxStock,
      packageMap,
      fx: fxStream,
      charTe: charTeStream,
      emoTe: emoTeStream,
      cx: cxStream,
      charObjects: charObjectTable,
      emoObjects: emoObjectTable,
    });

    this.tables = {
      objectTable,
      bombers,
      bomberByCode,
      itemAttr,
      tileInfo,
      fxStock,
      stockById,
      packageMap,
      sysStrings,
      stringTable,
      mapInfo,
      playableMaps,
      themeRandomMaps,
      mapGroups,
      channels,
      servers,
      charObjectTable,
      emoObjectTable,
      cosmetics,
    };
  }

  streamPack(name: PackName): StreamingPack {
    const sp = this.streamPacks.get(name);
    if (!sp) throw new Error(`[GameAssets] streamPack(${name}) accessed before boot()`);
    return sp;
  }

  /** Decode a sprite sheet or embedded JPEG/BMP into RGBA8 + SpriteRect[] (sync if prefetched). */
  rgbaSheetSync(pack: PackName, name: string): DecodedRgbaSheet | null {
    const key = `${pack}:${normalizeName(name)}`;
    if (this.rgbaSheets.has(key)) return this.rgbaSheets.get(key)!;
    const sp = this.streamPacks.get(pack);
    if (!sp) return null;
    const payload = sp.payloadSync(name);
    if (!payload) return null;
    const sheet = decodeCDataI16(payload) ?? decodeCDataI16Character(payload);
    if (!sheet) {
      this.rgbaSheets.set(key, null);
      return null;
    }
    const rawRgba = sheetToRGBA(sheet);
    const decoded: DecodedRgbaSheet = {
      width: sheet.sheetW,
      height: sheet.sheetH,
      rgba: new Uint8Array(rawRgba.buffer, rawRgba.byteOffset, rawRgba.byteLength),
      rects: sheet.rects,
    };
    this.rgbaSheets.set(key, decoded);
    return decoded;
  }

  /** Async decode of a sprite sheet OR embedded JPEG (e.g. `CAStage` backgrounds!) into RGBA8. */
  async loadRgbaSheet(pack: PackName, name: string): Promise<DecodedRgbaSheet | null> {
    const key = `${pack}:${normalizeName(name)}`;
    if (this.rgbaSheets.has(key)) return this.rgbaSheets.get(key)!;
    let p = this.rgbaSheetPromises.get(key);
    if (!p) {
      p = (async () => {
        const sp = this.streamPacks.get(pack);
        if (!sp) return null;
        const payload = await sp.payload(name);
        if (!payload || payload.byteLength < 4) {
          this.rgbaSheets.set(key, null);
          return null;
        }
        // Check JPEG SOI marker (0xFF 0xD8) — several CAStage backgrounds & SkinRsc JPEGs!
        if (payload[0] === 0xff && payload[1] === 0xd8) {
          const blob = new Blob([payload as unknown as BlobPart], { type: "image/jpeg" });
          const bmp = await createImageBitmap(blob, {
            premultiplyAlpha: "none",
            colorSpaceConversion: "none",
          });
          const oc = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = oc.getContext("2d")!;
          ctx.drawImage(bmp, 0, 0);
          const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
          const rgba = new Uint8Array(img.data.length);
          rgba.set(img.data);
          bmp.close();
          const fullRect: SpriteRect = {
            x0: 0,
            y0: 0,
            x1: oc.width,
            y1: oc.height,
            px: 0,
            py: 0,
            delay: 1,
            imgIdx: 0,
            pivotX: 0,
            pivotY: 0,
            anchorX: 0,
            anchorY: 0,
            frame: 0,
            pad: 0,
          };
          const out: DecodedRgbaSheet = {
            width: oc.width,
            height: oc.height,
            rgba,
            rects: [fullRect],
          };
          this.rgbaSheets.set(key, out);
          return out;
        }

        const uncomp = await inflateBnbZlib(payload);
        const sheet = decodeCDataI16(uncomp) ?? decodeCDataI16Character(uncomp);
        if (!sheet) {
          this.rgbaSheets.set(key, null);
          return null;
        }
        const rawRgba = sheetToRGBA(sheet);
        const out: DecodedRgbaSheet = {
          width: sheet.sheetW,
          height: sheet.sheetH,
          rgba: new Uint8Array(rawRgba.buffer, rawRgba.byteOffset, rawRgba.byteLength),
          rects: sheet.rects,
        };
        this.rgbaSheets.set(key, out);
        return out;
      })();
      this.rgbaSheetPromises.set(key, p);
    }
    return p;
  }

  /** Team-tinted RGBA sprite sheet using retail `dbl_6184D0` HLS shift (`teamIdx` 0..7). */
  tintedRgbaSheetSync(pack: PackName, name: string, teamIdx: number): DecodedRgbaSheet | null {
    if (teamIdx <= 0) return this.rgbaSheetSync(pack, name);
    const tKey = `${pack}:${normalizeName(name)}#team${teamIdx & 7}`;
    if (this.rgbaSheets.has(tKey)) return this.rgbaSheets.get(tKey)!;
    const base = this.rgbaSheetSync(pack, name);
    if (!base) return null;
    const tinted: DecodedRgbaSheet = {
      width: base.width,
      height: base.height,
      rgba: tintRgbaByTeam(base.rgba, teamIdx),
      rects: base.rects,
    };
    this.rgbaSheets.set(tKey, tinted);
    return tinted;
  }

  /**
   * Load and upload a sprite sheet (or JPEG, or two-layer `LayerStatic` + `LayerAdjust`
   * character sprite) directly to a cached WebGPU `LoadedSheet`.
   */
  loadSheet(pack: PackName, name: string): Promise<LoadedSheet | null> {
    return this.loadSheetInternal(pack, name, 1);
  }

  /** Load and upload a team-colored character/unit sheet (`team` `0..8`, default `1 = Red`). */
  loadTeamSheet(name: string, team: number, avatarDecoCodes?: readonly string[]): Promise<LoadedSheet | null> {
    return this.loadSheetInternal("Fx", name, team, avatarDecoCodes);
  }

  /** Load and upload a team-colored sheet from any archive (`Fx`, `CharTE`, `EmoTE`). */
  loadTeamPackSheet(pack: PackName, name: string, team: number): Promise<LoadedSheet | null> {
    return this.loadSheetInternal(pack, name, team);
  }

  private loadSheetInternal(
    pack: PackName,
    name: string,
    team: number,
    avatarDecoCodes?: readonly string[],
  ): Promise<LoadedSheet | null> {
    const r = this.rendererRef;
    if (!r) return Promise.resolve(null);
    const sp = this.streamPacks.get(pack);
    if (!sp) return Promise.resolve(null);

    const multiMatch =
      pack === "Fx" ? /^Character\/(C06|C10)-([A-Za-z]+)_A$/.exec(name) : null;
    const isMultiAvatar = Boolean(multiMatch && multiMatch[2] !== "BlinkSmall");
    const avatarTag = multiMatch?.[1] === "C06" ? "A06_" : multiMatch?.[1] === "C10" ? "A10_" : "";
    const activeDecos =
      isMultiAvatar && avatarDecoCodes && avatarDecoCodes.length > 0
        ? [...new Set(avatarDecoCodes.filter((c) => c.startsWith(avatarTag)))].sort()
        : [];
    const decoKey = activeDecos.length > 0 ? `:${activeDecos.join("+")}` : "";

    const hasTwoLayer =
      !sp.has(name) && (sp.has(`${name}LayerStatic`) || sp.has(`${name}LayerAdjust`));
    const cacheKey = isMultiAvatar
      ? `${pack}:${normalizeName(name)}#MP:${team}${decoKey}`
      : hasTwoLayer
        ? `${pack}:${normalizeName(name)}#2L:${team}`
        : `${pack}:${normalizeName(name)}`;

    let prom = this.gpuSheets.get(cacheKey);
    if (!prom) {
      prom = (async () => {
        if (isMultiAvatar && multiMatch) {
          const charTag = multiMatch[1]!; // "C06" | "C10"
          const action = multiMatch[2]!;  // e.g. "WalkDown", "Blink", "Portrait", "PortraitDie"
          const basePrefix = `Character/${charTag}-${action}`;
          const fxWant: string[] = [];
          for (const part of ["_A", "_B", "_C"]) {
            for (const suffix of ["LayerStatic", "LayerAdjust"]) {
              const pName = `${basePrefix}${part}${suffix}`;
              if (sp.has(pName)) fxWant.push(pName);
            }
          }

          const charTe = this.streamPacks.get("CharTE");
          const decoSpec = AVATAR_DECO_ACTION_MAP[action];
          const bySubSlot = new Map<string, string>();
          if (decoSpec && charTe) {
            for (const code of activeDecos) {
              const slotNum = code.split("_")[1] ?? "";
              if (slotNum) bySubSlot.set(slotNum, code);
            }
          }
          // Exact `CGOAvatar::sub_407502` (`CA.exe.c:8470..8500`) 12-slot resolution:
          const slot1Code = bySubSlot.get("10") ?? null;
          const slot2Code = bySubSlot.get("21") ?? bySubSlot.get("20") ?? null;
          const slot3Code = bySubSlot.has("21")
            ? null
            : (bySubSlot.get("30") ?? (charTag === "C06" ? "A06_30_0001" : null));
          const slot4Code = bySubSlot.get("41") ?? bySubSlot.get("40") ?? null;
          const slot5Code = bySubSlot.get("50") ?? null;
          const slot6Code = bySubSlot.has("41")
            ? null
            : (bySubSlot.get("60") ?? (charTag === "C10" ? "A10_60_0001" : null));

          const charTeWant: string[] = [];
          if (decoSpec && charTe) {
            for (const code of [slot1Code, slot2Code, slot3Code, slot4Code, slot5Code, slot6Code]) {
              if (!code) continue;
              const decoBase = `AvatarDeco/${code}_${decoSpec.sheet}`;
              if (charTe.has(`${decoBase}LayerStatic`)) charTeWant.push(`${decoBase}LayerStatic`);
              if (charTe.has(`${decoBase}LayerAdjust`)) charTeWant.push(`${decoBase}LayerAdjust`);
            }
          }

          await Promise.all([
            fxWant.length > 0 ? sp.prefetch(fxWant) : Promise.resolve(),
            charTe && charTeWant.length > 0 ? charTe.prefetch(charTeWant) : Promise.resolve(),
          ]);

          const decodeFrom = (packStream: StreamingPack, entryName: string): SpriteSheet | null => {
            const raw = packStream.payloadSync(entryName);
            return raw ? (decodeCDataI16(raw) ?? decodeCDataI16Character(raw)) : null;
          };
          const fxPart = (part: "_A" | "_B" | "_C"): AvatarPartLayer => ({
            staticSheet: decodeFrom(sp, `${basePrefix}${part}LayerStatic`),
            adjustSheet: decodeFrom(sp, `${basePrefix}${part}LayerAdjust`),
          });
          const makeDecoPart = (code: string | null): AvatarPartLayer | null => {
            if (!code || !decoSpec || !charTe) return null;
            const decoBase = `AvatarDeco/${code}_${decoSpec.sheet}`;
            const st = decodeFrom(charTe, `${decoBase}LayerStatic`);
            const ad = decodeFrom(charTe, `${decoBase}LayerAdjust`);
            if (!st && !ad) return null;
            return {
              staticSheet: st,
              adjustSheet: ad,
              frameOffset: decoSpec.offset,
            };
          };

          // Exact `CGOAvatar` 12-slot compositing order (`CA.exe.c` `L8470..8547`):
          //   slot 0 (_A face/skin) -> slot 1 (10) -> slot 2 (21|20|_B body) -> slot 3 (30)
          //   -> slot 4 (41|40|_C hair/hat) -> slot 5 (50) -> slot 6 (60)
          const layers: AvatarPartLayer[] = [fxPart("_A")];
          const p1 = makeDecoPart(slot1Code);
          if (p1) layers.push(p1);
          const p2 = makeDecoPart(slot2Code);
          layers.push(p2 ?? fxPart("_B"));
          const p3 = makeDecoPart(slot3Code);
          if (p3) layers.push(p3);
          const p4 = makeDecoPart(slot4Code);
          layers.push(p4 ?? fxPart("_C"));
          const p5 = makeDecoPart(slot5Code);
          if (p5) layers.push(p5);
          const p6 = makeDecoPart(slot6Code);
          if (p6) layers.push(p6);

          const comp = compositeAvatarLayers(layers, team);
          if (!comp) return null;
          const tex = r.createRgbaTexture(comp.width, comp.height, comp.rgba);
          return {
            tex,
            width: comp.width,
            height: comp.height,
            sheet: { rects: comp.rects },
          };
        }

        if (hasTwoLayer) {
          const want: string[] = [];
          if (sp.has(`${name}LayerStatic`)) want.push(`${name}LayerStatic`);
          if (sp.has(`${name}LayerAdjust`)) want.push(`${name}LayerAdjust`);
          await sp.prefetch(want);
          const stRaw = sp.payloadSync(`${name}LayerStatic`);
          const adRaw = sp.payloadSync(`${name}LayerAdjust`);
          const stSheet = stRaw ? (decodeCDataI16(stRaw) ?? decodeCDataI16Character(stRaw)) : null;
          const adSheet = adRaw ? (decodeCDataI16(adRaw) ?? decodeCDataI16Character(adRaw)) : null;
          const comp = compositeTwoLayerCharacter(stSheet, adSheet, team);
          if (!comp) return null;
          const tex = r.createRgbaTexture(comp.width, comp.height, comp.rgba);
          return {
            tex,
            width: comp.width,
            height: comp.height,
            sheet: { rects: comp.rects },
          };
        }

        const decoded = await this.loadRgbaSheet(pack, name);
        if (!decoded) return null;
        const tex = r.sheetTexture(decoded);
        return {
          tex,
          width: decoded.width,
          height: decoded.height,
          sheet: { rects: decoded.rects },
        };
      })();
      this.gpuSheets.set(cacheKey, prom);
    }
    return prom;
  }

  /** Load & parse a retail `Map/<name>` binary from `Fx`. */
  async loadMapData(mapName: string): Promise<ParsedMapData | null> {
    const cached = this.parsedMaps.get(mapName);
    if (cached) return cached;
    const fx = this.streamPack("Fx");
    const payload = await fx.payload(`Map/${mapName}`);
    if (!payload) return null;
    const parsed = parseMapBinary(mapName, payload);
    this.parsedMaps.set(mapName, parsed);

    // Also prefetch all ground & block sprite sheets referenced by this map!
    const objTab = this.tables?.objectTable;
    if (objTab) {
      const spriteNames = new Set<string>();
      for (const cell of parsed.cells) {
        for (const idx of [cell.groundObjIdx, cell.blockObjIdx]) {
          if (idx < 0) continue;
          const obj = objTab.byIndex[idx];
          if (!obj) continue;
          for (const act of obj.actions.values()) {
            spriteNames.add(act.sprite);
          }
        }
      }
      await fx.prefetch([...spriteNames]);
      for (const spName of spriteNames) {
        await this.loadRgbaSheet("Fx", spName);
      }
    }
    return parsed;
  }

  // --- Legacy PR #1 compatibility methods ---

  pack(name: PackName): Promise<Pack> {
    let p = this.packs.get(name);
    if (!p) {
      p = (async () => {
        const [idx, idd] = await Promise.all([
          fetchBytes(`${this.base}/${name}.idx`),
          fetchBytes(`${this.base}/${name}.idd`),
        ]);
        const pk = new Pack(name, idx, idd);
        this.streamPacks.get(name)?.attachFullIdd(idd);
        return pk;
      })();
      this.packs.set(name, p);
    }
    return p;
  }

  sheet(pack: PackName, name: string): Promise<SpriteSheet | null> {
    const key = `${pack}:${name}`;
    let s = this.sheets.get(key);
    if (!s) {
      s = (async () => {
        const sp = this.streamPacks.get(pack);
        const payload = sp ? await sp.payload(name) : (await this.pack(pack)).payload(name);
        if (!payload) return null;
        return decodeCDataI16(payload) ?? decodeCDataI16Character(payload);
      })();
      this.sheets.set(key, s);
    }
    return s;
  }

  texture(pack: PackName, name: string): Promise<ImageBitmap | null> {
    const key = `${pack}:${name}`;
    let t = this.textures.get(key);
    if (!t) {
      t = (async () => {
        const sheet = await this.sheet(pack, name);
        if (!sheet) return null;
        const rgba = sheetToRGBA(sheet);
        const pixels = new Uint8ClampedArray(rgba.length);
        pixels.set(rgba);
        const data = new ImageData(pixels, sheet.sheetW, sheet.sheetH);
        return createImageBitmap(data, {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        });
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  async image(pack: PackName, name: string): Promise<ImageBitmap | null> {
    const key = `img:${pack}:${name}`;
    let t = this.textures.get(key);
    if (!t) {
      t = (async () => {
        const sp = this.streamPacks.get(pack);
        const payload = sp ? await sp.payload(name) : (await this.pack(pack)).payload(name);
        if (!payload || payload.length < 4) return null;
        if (payload[0] !== 0xff || payload[1] !== 0xd8) return null;
        const blob = new Blob([payload as unknown as BlobPart], { type: "image/jpeg" });
        return createImageBitmap(blob);
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  async channelDescription(position: number, kind: number): Promise<string | null> {
    const sys = this.tables?.sysStrings;
    if (sys) {
      return sys.get(`ChannelExplain${position}`) ?? sys.get(`ChannelDesc${kind}`) ?? null;
    }
    const { systemStrings } = await this.config();
    const find = (n: string): string | null => systemStrings.find((r) => r.name === n)?.text ?? null;
    return find(`ChannelExplain${position}`) ?? find(`ChannelDesc${kind}`);
  }

  async mapInfo(): Promise<MapInfoFile | null> {
    if (this.tables) return this.tables.mapInfo;
    if (!this.mapInfos) {
      this.mapInfos = (async () => {
        try {
          const bytes = await fetchBytes(`${this.base}/fxdynmapinfo.ssd`);
          const ssi = readSsi(bytes);
          return ssi ? parseMapInfo(ssi.payload) : null;
        } catch {
          return null;
        }
      })();
    }
    return this.mapInfos;
  }

  async systemString(name: string): Promise<string | null> {
    if (this.tables) return this.tables.sysStrings.get(name) ?? null;
    const { systemStrings } = await this.config();
    return systemStrings.find((r) => r.name === name)?.text ?? null;
  }

  config(): Promise<{
    stringTable: StringRow[];
    systemStrings: SystemStringRow[];
    raw: Map<string, Uint8Array>;
  }> {
    if (!this.configs) {
      this.configs = (async () => {
        const files = [
          "stringtable.ini",
          "csysstr.ssd",
          "fxstock.ini",
          "packagemap.ini",
          "fxdynmapinfo.ssd",
          "channel2_000.ssd",
          "multisvr.ssd",
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
              /* ignore */
            }
          }),
        );
        return { stringTable, systemStrings, raw };
      })();
    }
    return this.configs;
  }
}
