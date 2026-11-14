/**
 * `fxdynmapinfo.ssd` — the map table.
 *
 * Reversed from `CMapInfo::sub_480B1C`, which reads the file with the CISmartStream
 * primitives: `sub_580240` is a u16, `sub_580220` a u8, `sub_580260` a u32, and
 * `sub_580280` a `u32 length` followed by that many bytes.  The record order in
 * that function is
 *
 *   u32 index
 *   u8  …
 *   str name
 *   str description
 *   u8  …, u8 …
 *   str family
 *   str art
 *   u8  …, u8 …
 *   u32 packed colour
 *   u8  …, u8 …, u8 …
 *   u32 theme
 *
 * and the payload is `u16 count` followed by the records.  All lengths are
 * little-endian u32 and the strings are Big5.
 *
 * The parse is self-checking: it consumes all 240 records of the shipped file
 * and lands exactly on the last byte.
 */

const BIG5 = new TextDecoder('big5');
const LATIN1 = new TextDecoder('latin1');

export interface MapInfo {
  /** 1-based index as stored in the file. */
  index: number;
  /** Internal name, e.g. `Bula00`. */
  name: string;
  /** Localised name, e.g. 藏寶地圖00. */
  description: string;
  /** Map family, e.g. `Bula`.  `Random` entries pick within their family. */
  family: string;
  /** Fx `Theme/<art>` sheet: frame 0 is the thumbnail, frame 1 the game HUD icon. */
  art: string;
  /** Packed colour as stored (0xRRGGBB). */
  colour: number;
  /** Theme id; 0xFFFFFFFF when the map has none. */
  theme: number;
  /** `Random`/`…Random` entries are random-choice placeholders, not playable maps. */
  random: boolean;
  /** Minimum level to select (`*(entry + 60)` `sub_47FD8A`). */
  minLevel?: number;
  /** Retail NEW map flag (`*(entry + 68) == 1` `sub_47FBC9` -> `Theme/Newmap_Icon`). */
  isNew?: boolean;
}

export interface MapInfoEntry {
  readonly code: string;
  readonly displayName: string;
  readonly maxPlayers: number;
  readonly description: string;
}

export interface MapInfoFile {
  count: number;
  maps: MapInfo[];
}

function readU32(p: Uint8Array, off: number): number {
  return (
    (p[off]! | (p[off + 1]! << 8) | (p[off + 2]! << 16) | (p[off + 3]! << 24)) >>> 0
  );
}

export function parseMapInfo(payload: Uint8Array): MapInfoFile | null {
  if (payload.length < 4) return null;
  const count = payload[0]! | (payload[1]! << 8);
  if (count === 0) return null;

  let off = 2;
  const need = (n: number): boolean => off + n <= payload.length;
  const u8 = (): number => payload[off++]!;
  const str = (): string => {
    if (!need(4)) throw new RangeError('mapinfo: truncated length');
    const n = readU32(payload, off);
    off += 4;
    if (!need(n)) throw new RangeError('mapinfo: truncated string');
    const bytes = payload.subarray(off, off + n);
    off += n;
    // Names are ASCII, descriptions Big5; latin1 is a safe superset for ASCII
    // and Big5 always decodes without error.
    return BIG5.decode(bytes);
  };

  const maps: MapInfo[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const index = readU32(payload, off);
      off += 4;
      u8();
      const name = str();
      const description = str();
      u8();
      u8();
      const family = str();
      const art = str();
      const minLevel = u8();
      u8();
      const colour = readU32(payload, off);
      off += 4;
      const flagNew = u8();
      u8();
      u8();
      const theme = readU32(payload, off);
      off += 4;
      maps.push({
        index,
        name,
        description,
        family,
        art,
        colour,
        theme,
        random: /Random$/i.test(name),
        minLevel,
        isNew: flagNew === 1,
      });
    }
  } catch {
    return null;
  }
  // The shipped file has no trailing bytes; anything left over means we lost
  // alignment and the parse is not trustworthy.
  if (off !== payload.length) return null;
  return { count, maps };
}

/** Add archive maps omitted from the retail selection table. Both server and
 * client must derive identical stable IDs from the same index. These extra IDs
 * and labels are web additions, not original fxdynmapinfo records. */
export function includeArchiveMaps(info: MapInfoFile, archiveNames: readonly string[]): MapInfoFile {
  const maps = [...info.maps];
  const seen = new Set(maps.map(m => m.name.toLowerCase()));
  const extra = archiveNames
    .map(name => /^Map[\\/](.+)$/i.exec(name)?.[1])
    .filter((name): name is string => !!name && !name.includes("/") && !name.includes("\\"))
    .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  let next = Math.max(0, ...maps.map(m => m.index)) + 1;
  for (const name of extra) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const family = name.replace(/\d+$/, "") || name;
    maps.push({ index: next++, name, description: name, family, art: family, colour: 0, theme: 0xffffffff, random: false });
  }
  return { count: maps.length, maps };
}

/** ASCII helper used by the tooling, kept here so both sides agree. */
export function mapInfoName(m: MapInfo): string {
  return LATIN1.decode(new TextEncoder().encode(m.description));
}
