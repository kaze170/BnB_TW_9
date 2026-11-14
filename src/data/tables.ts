// Complete binary parsers for retail Taiwan BnB v9 tables inside Fx.idd and .ssd/.ini:
//   - ObjectTable/ObjectTable  (897 / 967 indexed objects, multi-action step timelines)
//   - Attr/BomberAttr          (11 characters: Bazzi..Super/Lodumani speed/bomb/power bounds)
//   - Attr/ItemAttr            (11 rides/ships + 84 field/active items + drop weights)
//   - TileInfo/TileInfo        (769 tile definitions: ground, static WxH, push/fixed box, bush/house)
//   - Map/*                    (289 retail map grids, spawn slots, team/mode metadata)
//   - fxstock.ini              (1,461 retail Taiwan shop items: Big5 name, Cash/Lucci price, icon)
//   - packagemap.ini           (988 retail shop bundle -> constituent item mappings)
//   - csysstr.ssd              (5,335 retail Big5 UI/system message strings)
//   - stringtable.ini          (114 retail Big5 shop item tooltip descriptions)

import { decodeBig5 } from "./big5.ts";
import { readSsi } from "./ssi.ts";

export interface ObjectStep {
  readonly frame: number;
  readonly ticks: number; // -1 = hold forever
}

export interface ObjectAction {
  readonly name: string;
  readonly sprite: string;
  readonly steps: readonly ObjectStep[];
  readonly totalTicks: number; // sum of positive step ticks (0 if single held frame)
}

export interface ObjectDef {
  readonly index: number;
  readonly name: string;
  readonly actions: ReadonlyMap<string, ObjectAction>;
  readonly actionList: readonly ObjectAction[];
  readonly defaultAction: ObjectAction | null;
}

export class ObjectTable {
  readonly byIndex: readonly (ObjectDef | null)[];
  readonly byName: ReadonlyMap<string, ObjectDef>;

  constructor(buf: Uint8Array) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let p = 0;
    const count = dv.getUint32(p, true);
    p += 4;

    const headers: { name: string; off: number }[] = [];
    for (let i = 0; i < count; i++) {
      const len = dv.getUint32(p, true);
      p += 4;
      const name = len > 0 ? decodeBig5(buf.subarray(p, p + len)) : "";
      p += len;
      const off = dv.getInt32(p, true);
      p += 4;
      headers.push({ name, off });
    }

    const byIndex: (ObjectDef | null)[] = new Array(count).fill(null);
    const byName = new Map<string, ObjectDef>();

    for (let i = 0; i < count; i++) {
      const h = headers[i]!;
      if (h.off < 0 || h.off >= buf.byteLength) continue;
      let q = h.off;
      const actCount = dv.getUint32(q, true);
      q += 4;
      const actions = new Map<string, ObjectAction>();
      const actionList: ObjectAction[] = [];
      let defaultAction: ObjectAction | null = null;
      for (let a = 0; a < actCount; a++) {
        const al = dv.getUint32(q, true);
        q += 4;
        const actName = decodeBig5(buf.subarray(q, q + al));
        q += al;
        const sl = dv.getUint32(q, true);
        q += 4;
        const sprite = decodeBig5(buf.subarray(q, q + sl));
        q += sl;
        const stepCount = dv.getUint32(q, true);
        q += 4;
        const steps: ObjectStep[] = [];
        let totalTicks = 0;
        for (let s = 0; s < stepCount; s++) {
          const frame = dv.getInt32(q, true);
          const ticks = dv.getInt32(q + 4, true);
          q += 8;
          steps.push({ frame, ticks });
          if (ticks > 0) totalTicks += ticks;
        }
        const action: ObjectAction = { name: actName, sprite, steps, totalTicks };
        actions.set(actName, action);
        actionList.push(action);
        if (!defaultAction) defaultAction = action;
      }
      const def: ObjectDef = { index: i, name: h.name, actions, actionList, defaultAction };
      byIndex[i] = def;
      if (h.name) byName.set(h.name, def);
    }

    this.byIndex = byIndex;
    this.byName = byName;
  }

  /** Sample the frame index for an action at `elapsedTicks` (30ms ticks). */
  sampleFrame(objName: string, actName: string, elapsedTicks: number, loop = true): { sprite: string; frame: number } | null {
    const obj = this.byName.get(objName);
    if (!obj) return null;
    const act = obj.actions.get(actName) ?? obj.defaultAction;
    if (!act || act.steps.length === 0) return null;
    return sampleAction(act, elapsedTicks, loop);
  }
}

export function sampleAction(act: ObjectAction, elapsedTicks: number, loop = true): { sprite: string; frame: number } {
  const steps = act.steps;
  if (steps.length === 1 || act.totalTicks <= 0) {
    return { sprite: act.sprite, frame: steps[0]!.frame };
  }
  // Check if last step is a hold (-1)
  const last = steps[steps.length - 1]!;
  if (last.ticks < 0 && !loop && elapsedTicks >= act.totalTicks) {
    return { sprite: act.sprite, frame: last.frame };
  }
  let t = loop && last.ticks >= 0 ? ((elapsedTicks % act.totalTicks) + act.totalTicks) % act.totalTicks : Math.max(0, elapsedTicks);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.ticks < 0) return { sprite: act.sprite, frame: st.frame };
    if (t < st.ticks) return { sprite: act.sprite, frame: st.frame };
    t -= st.ticks;
  }
  return { sprite: act.sprite, frame: last.frame };
}

export interface BomberSpec {
  readonly index: number;      // 0..10 in BomberAttr order
  readonly code: number;       // 0..10 character C00..C10 numeric code
  readonly prefix: string;     // e.g. "Character/C00"
  readonly nameZh: string;     // Traditional Chinese retail display name
  readonly hiddenKind: number; // 0 = selectable, 1 = random-only super (C08/C09), 2 = NPC/hidden
  readonly speedMin: number;   // px per 30ms tick (4..6)
  readonly speedMax: number;   // px per 30ms tick (7..9)
  readonly bombMin: number;    // initial water balloons (1..3)
  readonly bombMax: number;    // max water balloons (6..10)
  readonly powerMin: number;   // initial flame range (1..3)
  readonly powerMax: number;   // max flame range (5..9)
}

const CHAR_CODE_NAMES_ZH: Record<number, string> = {
  0: "藍寶",
  1: "睏寶",
  2: "囡囡",
  3: "痞子妹",
  4: "栗子",
  5: "工頭",
  6: "藍妹妹",
  7: "胖墩",
  8: "海盜船長",
  9: "神秘超人",
  10: "聖誕老人",
};

export function parseBomberAttr(buf: Uint8Array): BomberSpec[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const out: BomberSpec[] = [];
  let idx = 0;
  while (p < buf.byteLength) {
    const l = dv.getUint32(p, true);
    p += 4;
    const prefix = decodeBig5(buf.subarray(p, p + l));
    p += l;
    const hiddenKind = dv.getInt32(p, true);
    const speedMin = dv.getInt32(p + 4, true);
    const speedMax = dv.getInt32(p + 8, true);
    const bombMin = dv.getInt32(p + 12, true);
    const bombMax = dv.getInt32(p + 16, true);
    const powerMin = dv.getInt32(p + 20, true);
    const powerMax = dv.getInt32(p + 24, true);
    p += 40;
    const m = /C(\d+)$/i.exec(prefix);
    const code = m ? parseInt(m[1]!, 10) : idx;
    out.push({
      index: idx++,
      code,
      prefix,
      nameZh: CHAR_CODE_NAMES_ZH[code] ?? prefix,
      hiddenKind,
      speedMin,
      speedMax,
      bombMin,
      bombMax,
      powerMin,
      powerMax,
    });
  }
  return out;
}

export interface RideSpec {
  readonly id: number;        // 1..11
  readonly objectName: string; // e.g. "Ship/Airship", "Ship/Owl", "Ship/Turtle0"
  readonly flyLevel: number;  // 2 = flies over boxes/bombs (Airship), 1 = ground ride
  readonly speed: number;     // override speed in px/tick (2 = slow turtle, 5 = owl, 9 = fast turtle, 10 = UFO)
  readonly extra0: number;
  readonly extra1: number;
}

export interface FieldItemSpec {
  readonly index: number;
  readonly objectName: string; // e.g. "Item/ItemBomb"
  readonly iconSprite: string; // e.g. "Item/Bomb"
  readonly dropWeight: number; // e.g. 3650, 2800, 2000, 300, 200, 150
  readonly activeSlotFlag: number; // >0 if stored in 1..6 active item bar
  readonly pickupFlag: number;
  readonly effectId: number;   // 1=Bomb, 2=Fire, 3=Roller, 4=Shoe, 5=Punch, 6=MaxPower, 7..12=Rides/Devils, etc.
}

export interface ItemAttrTable {
  readonly ships: ReadonlyMap<number, RideSpec>;
  readonly items: readonly FieldItemSpec[];
  readonly weightedPool: readonly FieldItemSpec[];
  readonly totalDropWeight: number;
}

export function parseItemAttr(buf: Uint8Array): ItemAttrTable {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const shipCount = dv.getInt32(p + 8, true);
  p += 12;

  const ships = new Map<number, RideSpec>();
  for (let i = 0; i < shipCount; i++) {
    const id = dv.getInt32(p, true);
    p += 4;
    const l = dv.getUint32(p, true);
    p += 4;
    const objectName = decodeBig5(buf.subarray(p, p + l));
    p += l;
    const flyLevel = dv.getInt32(p, true);
    const speed = dv.getInt32(p + 4, true);
    const extra0 = dv.getInt32(p + 8, true);
    const extra1 = dv.getInt32(p + 12, true);
    p += 32;
    ships.set(id, { id, objectName, flyLevel, speed, extra0, extra1 });
  }

  const items: FieldItemSpec[] = [];
  let idx = 0;
  while (p < buf.byteLength) {
    const l1 = dv.getUint32(p, true);
    p += 4;
    const objectName = decodeBig5(buf.subarray(p, p + l1));
    p += l1;
    const l2 = dv.getUint32(p, true);
    p += 4;
    const iconSprite = decodeBig5(buf.subarray(p, p + l2));
    p += l2;
    const dropWeight = dv.getInt32(p, true);
    const activeSlotFlag = dv.getInt32(p + 4, true);
    const pickupFlag = dv.getInt32(p + 8, true);
    const effectId = dv.getInt32(p + 12, true);
    p += 32;
    items.push({
      index: idx++,
      objectName,
      iconSprite,
      dropWeight,
      activeSlotFlag,
      pickupFlag,
      effectId,
    });
  }

  const weightedPool = items.filter((it) => it.dropWeight > 0);
  const totalDropWeight = weightedPool.reduce((acc, it) => acc + it.dropWeight, 0);
  return { ships, items, weightedPool, totalDropWeight };
}

export type TileKind = 0 | 1 | 2 | 3; // 0=ground, 1=static, 2=box, 3=passable bush/roof

export interface TileSpec {
  readonly objectName: string;
  readonly kind: TileKind;
  readonly width: number;       // multi-cell footprint width (cols, anchored bottom-left)
  readonly height: number;      // multi-cell footprint height (rows, anchored bottom-left)
  readonly hp: number;          // CGOTileFixedBox/MovableBox hit points (`kind==2 ? max(1, i1) : 1`)
  readonly blocksWalk: boolean; // sub_4827CB: kind==1 || kind==2 || (kind==0 && i32[6]!=0)
  readonly pushable: boolean;   // kind==2 && i32[2]!=0 (CGOTileMovableBox vs CGOTileFixedBox)
  readonly indestructible: boolean; // kind==1 || (kind==3 && i32[5]!=0)
  readonly hidesUnit: boolean;  // kind==3 (bush/roof hides unit & items underneath)
  readonly burnsInFlame: boolean; // kind==3 && i32[5]==0 (destructible bush/vine vs permanent tent/bunker/roof)
  readonly slipFlag: number;    // ice/conveyor ground modifier
  readonly conveyorDir: -1 | 0 | 1 | 2 | 3; // TileConv/* output direction (0=L,1=U,2=R,3=D)
  readonly conveyorAlignMask: number; // Ground flow alignment flags, CA.exe.c:29100
  readonly conveyorSpeed: number;
  readonly isIce: boolean;      // Tile02_Ground/Ice* slippery surface
  // CGOTilePassable (`CA.exe` `0x0041F53B..0x0041F658`) directional edge flags (0=Left, 1=Up, 2=Right, 3=Down)
  readonly passPlayerDir: readonly [boolean, boolean, boolean, boolean];
  readonly passBombDir: readonly [boolean, boolean, boolean, boolean];
  readonly passFlameDir: readonly [boolean, boolean, boolean, boolean];
  readonly noBombPlace: boolean; // kind==3 && i5!=0 (Tent/Igloo/Bunker/GasStation/Shower/Line) or PinGround01
  readonly isPinHazard: boolean; // Tile16_Passble/PinTile01 or Tile16_Ground/PinGround01 (`w21 >= 10000`)
  readonly blockEdgePinDir: readonly [boolean, boolean, boolean, boolean]; // Tile16_Static/PinPillar01..05 (`sub_482806`)
  readonly isPitStop: boolean;   // Tile12_Passable/GasRight00|01 (`i7 == 100`, Kart refuel station)
  readonly isWaterPuddle: boolean; // Tile03_Ground/Tile07 (`i7 != 0`, Ocean shallow water)
  readonly isTrackRoad: boolean; // Tile08_Ground/Rail* & Tile12_Ground/Race*|LapTile*|Start_* (`i8 != 0`)
  readonly hasFootprints: boolean; // Tile07_Ground/Tile00..01 & Tile03_Ground/Tile07 (`i9 != 0 || i7 != 0`)
  readonly bulaPattern: number; // Ground metadata word used by CBulaComponent (sub_4998CE).
  readonly bulaHouseEligible: boolean; // TileInfo i4 10001..10199 is counted as a house (sub_4998CE).
  readonly bulaHouseVariant: number; // TileInfo i4 10101..10199 selects Aft01..99 (sub_49B632).
  readonly isLapTile: boolean;   // CGOTileLap (`b40 != 0`)
  readonly lapCheckpoint: number; // 0 = Start_*, 1..4 = LapTile01..04_*, -1 = not a lap tile
}

export function parseTileInfo(buf: Uint8Array): Map<string, TileSpec> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint32(p, true);
  p += 4;
  const out = new Map<string, TileSpec>();
  for (let i = 0; i < count; i++) {
    const l = dv.getUint32(p, true);
    p += 4;
    const objectName = decodeBig5(buf.subarray(p, p + l));
    p += l;
    const kindRaw = dv.getInt32(p, true);
    const kind = (kindRaw >= 0 && kindRaw <= 3 ? kindRaw : 0) as TileKind;
    const i1 = dv.getInt32(p + 4, true);
    const i2 = dv.getInt32(p + 8, true);
    const i3 = dv.getInt32(p + 12, true);
    const i4 = dv.getInt32(p + 16, true);
    const i5 = dv.getInt32(p + 20, true);
    const i6 = dv.getInt32(p + 24, true);
    const i7 = dv.getInt32(p + 28, true);
    const i8 = dv.getInt32(p + 32, true);
    const i9 = dv.getInt32(p + 36, true);
    const b40 = buf[p + 40]!;
    const w21 = dv.getInt16(p + 42, true);

    const passPlayerDir: [boolean, boolean, boolean, boolean] =
      kind === 3
        ? [buf[p + 4] !== 0, buf[p + 5] !== 0, buf[p + 6] !== 0, buf[p + 7] !== 0]
        : [true, true, true, true];
    const passBombDir: [boolean, boolean, boolean, boolean] =
      kind === 3
        ? [buf[p + 8] !== 0, buf[p + 9] !== 0, buf[p + 10] !== 0, buf[p + 11] !== 0]
        : [true, true, true, true];
    const passFlameDir: [boolean, boolean, boolean, boolean] =
      kind === 3
        ? [buf[p + 12] !== 0, buf[p + 13] !== 0, buf[p + 14] !== 0, buf[p + 15] !== 0]
        : [kind !== 1, kind !== 1, kind !== 1, kind !== 1];
    const blockEdgePinDir: [boolean, boolean, boolean, boolean] =
      kind === 1
        ? [buf[p + 20] !== 0, buf[p + 21] !== 0, buf[p + 22] !== 0, buf[p + 23] !== 0]
        : [false, false, false, false];
    p += 44;

    const width = kind < 2 ? Math.max(1, i1) : 1;
    const height = kind < 2 ? Math.max(1, i2) : 1;
    const hp = kind === 2 ? Math.max(1, i1) : 1;
    const blocksWalk = kind === 1 || kind === 2 || (kind === 0 && i6 !== 0);
    const pushable = kind === 2 && i2 !== 0;
    const indestructible = kind === 1 || (kind === 3 && i5 !== 0);
    const hidesUnit = kind === 3;
    const burnsInFlame = kind === 3 && i5 === 0;
    const noBombPlace = (kind === 3 && i5 !== 0) || (kind === 0 && w21 >= 10000);
    const isPinHazard = (kind === 3 && i4 > 1) || (kind === 0 && w21 >= 10000);
    const isPitStop = kind === 3 && i7 === 100;
    const isWaterPuddle = kind === 0 && i7 !== 0;
    const isTrackRoad = kind === 0 && i8 !== 0;
    const hasFootprints = kind === 0 && (i9 !== 0 || i7 !== 0);
    const isLapTile = kind === 0 && b40 !== 0;
    const lapCheckpoint = isLapTile ? w21 : -1;
    const slipFlag = kind === 0 ? i4 : 0;
    // Ground record: speed at +12, directional alignment mask at +16,
    // output direction at +20 (CGOTileGround::sub_41EECE / sub_41EFB3).
    const isConveyor = kind === 0 && /^TileConv\//i.test(objectName) && i3 > 0;
    const conveyorDir: -1 | 0 | 1 | 2 | 3 =
      isConveyor && i5 >= 0 && i5 <= 3 ? i5 as 0 | 1 | 2 | 3 : -1;
    const conveyorAlignMask = isConveyor ? i4 & 15 : 0;
    const conveyorSpeed = isConveyor ? i3 : 0;
    const isIce = kind === 0 && /\/Ice\d+/i.test(objectName);

    out.set(objectName, {
      objectName,
      kind,
      width,
      height,
      hp,
      blocksWalk,
      pushable,
      indestructible,
      hidesUnit,
      burnsInFlame,
      slipFlag,
      conveyorDir,
      conveyorAlignMask,
      conveyorSpeed,
      isIce,
      passPlayerDir,
      passBombDir,
      passFlameDir,
      noBombPlace,
      isPinHazard,
      blockEdgePinDir,
      isPitStop,
      isWaterPuddle,
      isTrackRoad,
      hasFootprints,
      bulaPattern: kind === 0 ? w21 : 0,
      bulaHouseEligible: i4 >= 10001 && i4 <= 10199,
      bulaHouseVariant: i4 >= 10101 && i4 <= 10199 ? i4 - 10100 : 0,
      isLapTile,
      lapCheckpoint,
    });
  }
  return out;
}

export interface MapCellData {
  readonly groundObjIdx: number; // ObjectTable index or -1
  readonly blockObjIdx: number;  // ObjectTable index or -1
}

export interface MapPreplacedItem {
  readonly itemName: string;
  readonly row: number;
  readonly col: number;
  readonly probPct: number;
}

export interface MapSoulSpawn {
  readonly kind: "InnerSoul" | "OuterSoul";
  readonly col: number;
  readonly row: number;
  readonly waypointOrDir: number;
  readonly speed: number;
  readonly pathIndex: number; // 1-based index into `soulPaths` (0 = free patrol)
}

export interface ParsedMapData {
  readonly name: string;
  readonly version: number;
  readonly maxTeams: number;
  readonly modeFlag: number;
  readonly width: number;   // typically 15 (some maps 13 or 11)
  readonly height: number;  // typically 13
  readonly originX: number; // retail pixel origin: 20 + 40 * ((15 - width) >> 1)
  readonly originY: number; // retail pixel origin: 41 + 40 * ((13 - height) >> 1)
  readonly batIntervalSec: number; // `this + 26` (`10..50`s on Cemetery/Tomb -> `CGOBatGroup`)
  readonly componentMode: number;  // `*(this + 25488)`: 0=Normal, 1=Kart, 2=Bula, 3=Event2004
  readonly modeParam0: number;     // `*(this + 25489)`: Kart checkpointCount (4) / Bula maxSpeed
  readonly modeParam1: number;     // `*(this + 25490)`: Kart totalLaps (3) / Bula param
  readonly spawns: readonly (readonly [number, number])[]; // [col, row] pairs
  readonly portals: readonly (readonly [number, number, number, number])[]; // [colA, rowA, colB, rowB]
  readonly cells: readonly MapCellData[]; // row-major [row * width + col]
  readonly itemQuotas: ReadonlyMap<string, number>; // sub_4D33EC per-map drop weight overrides
  readonly dropRatePct: number; // sub_4D33EC box item drop probability (0..100)
  readonly preplacedItems: readonly MapPreplacedItem[]; // sub_4D33EC pre-placed coins & guaranteed box items
  readonly soulPaths: readonly (readonly (readonly [number, number])[])[]; // sub_4C9263 [col, row] waypoint loops
  readonly soulSpawns: readonly MapSoulSpawn[]; // sub_4C9263 InnerSoul (Mummy) & OuterSoul (BulaBat)
}

export function parseMapBinary(name: string, buf: Uint8Array): ParsedMapData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const first = dv.getInt32(p, true);
  p += 4;
  let version = first;
  let maxTeams = 8;
  let modeFlag = 1;
  let width = 15;
  if (first < 1000) {
    width = first;
    version = 232;
  } else {
    maxTeams = dv.getInt32(p, true);
    p += 4;
    modeFlag = dv.getInt32(p, true);
    p += 4;
    width = dv.getInt32(p, true);
    p += 4;
  }
  const height = dv.getInt32(p, true);
  p += 4;
  const spawnCount = Math.max(0, Math.min(16, dv.getInt32(p, true)));
  const batIntervalSec = p + 20 <= buf.byteLength ? Math.max(0, dv.getInt32(p + 20, true)) : 0;
  const componentMode = p + 36 <= buf.byteLength ? dv.getInt32(p + 32, true) : 0;
  const modeParam0 = p + 40 <= buf.byteLength ? dv.getInt32(p + 36, true) : 0;
  const modeParam1 = p + 44 <= buf.byteLength ? dv.getInt32(p + 40, true) : 0;
  p += 4 * 13; // exact header stride verified across all 289 retail maps

  const spawns: [number, number][] = [];
  for (let i = 0; i < spawnCount; i++) {
    const sx = dv.getInt32(p, true);
    const sy = dv.getInt32(p + 4, true);
    p += 8;
    spawns.push([sx, sy]);
  }

  const groupCount = Math.max(0, dv.getInt32(p, true));
  p += 4;
  const portals: [number, number, number, number][] = [];
  for (let i = 0; i < groupCount && p + 16 <= buf.byteLength; i++) {
    portals.push([
      dv.getInt32(p, true),
      dv.getInt32(p + 4, true),
      dv.getInt32(p + 8, true),
      dv.getInt32(p + 12, true),
    ]);
    p += 16;
  }

  const cells: MapCellData[] = new Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const groundObjIdx = p + 4 <= buf.byteLength ? dv.getInt32(p, true) : -1;
    const blockObjIdx = p + 8 <= buf.byteLength ? dv.getInt32(p + 4, true) : -1;
    p += 8;
    cells[i] = { groundObjIdx, blockObjIdx };
  }

  // Parse retail `sub_4D33EC` per-map item drop weights, dropRatePct, and pre-placed ground/box items!
  const itemQuotas = new Map<string, number>();
  let dropRatePct = 62;
  const preplacedItems: MapPreplacedItem[] = [];
  if (p + 12 <= buf.byteLength) {
    const quotaCount = Math.max(0, Math.min(256, dv.getInt32(p, true)));
    p += 4;
    for (let i = 0; i < quotaCount && p + 4 <= buf.byteLength; i++) {
      const l = dv.getUint32(p, true);
      p += 4;
      if (l <= 0 || l >= 256 || p + l + 4 > buf.byteLength) break;
      const itemName = decodeBig5(buf.subarray(p, p + l));
      p += l;
      const weight = dv.getInt32(p, true);
      p += 4;
      itemQuotas.set(itemName.toLowerCase(), Math.max(0, weight));
    }
    if (p + 8 <= buf.byteLength) {
      const rawRate = dv.getInt32(p, true);
      if (rawRate >= 0 && rawRate <= 100) dropRatePct = rawRate;
      const preCount = Math.max(0, Math.min(512, dv.getInt32(p + 4, true)));
      p += 8;
      for (let i = 0; i < preCount && p + 4 <= buf.byteLength; i++) {
        const l = dv.getUint32(p, true);
        p += 4;
        if (l <= 0 || l >= 256 || p + l + 3 > buf.byteLength) break;
        const itemName = decodeBig5(buf.subarray(p, p + l));
        p += l;
        const row = buf[p]!;
        const col = buf[p + 1]!;
        const probPct = buf[p + 2]!;
        p += 3;
        preplacedItems.push({ itemName, row, col, probPct });
      }
    }
  }

  // Parse retail `sub_4C9263` (`0x004C9263`) trailing Soul patrol paths & `InnerSoul`/`OuterSoul` spawns!
  const soulPaths: [number, number][][] = [];
  const soulSpawns: MapSoulSpawn[] = [];
  if (p + 4 <= buf.byteLength) {
    const pathCount = dv.getInt32(p, true);
    p += 4;
    if (pathCount > 0 && pathCount < 64) {
      for (let i = 0; i < pathCount && p + 4 <= buf.byteLength; i++) {
        const ptCount = dv.getInt32(p, true);
        p += 4;
        if (ptCount <= 0 || ptCount > 256 || p + ptCount * 8 > buf.byteLength) break;
        const pts: [number, number][] = [];
        for (let k = 0; k < ptCount; k++) {
          pts.push([dv.getInt32(p, true), dv.getInt32(p + 4, true)]);
          p += 8;
        }
        soulPaths.push(pts);
      }
    }
    if (p + 4 <= buf.byteLength) {
      const entCount = dv.getInt32(p, true);
      p += 4;
      if (entCount > 0 && entCount < 256) {
        for (let i = 0; i < entCount && p + 4 <= buf.byteLength; i++) {
          const l = dv.getUint32(p, true);
          p += 4;
          if (l <= 0 || l >= 256 || p + l + 14 > buf.byteLength) break;
          const kindRaw = decodeBig5(buf.subarray(p, p + l));
          p += l;
          const col = buf[p]!;
          const row = buf[p + 1]!;
          const waypointOrDir = dv.getInt32(p + 2, true);
          const speed = dv.getInt32(p + 6, true);
          const pathIndex = dv.getInt32(p + 10, true);
          p += 14;
          if (kindRaw === "InnerSoul" || kindRaw === "OuterSoul") {
            soulSpawns.push({ kind: kindRaw, col, row, waypointOrDir, speed, pathIndex });
          }
        }
      }
    }
  }

  const originX = 20 + 40 * Math.floor((15 - width) / 2);
  const originY = 41 + 40 * Math.floor((13 - height) / 2);

  return {
    name,
    version,
    maxTeams,
    modeFlag,
    width,
    height,
    originX,
    originY,
    batIntervalSec,
    componentMode,
    modeParam0,
    modeParam1,
    spawns,
    portals,
    cells,
    itemQuotas,
    dropRatePct,
    preplacedItems,
    soulPaths,
    soulSpawns,
  };
}

export interface StockItem {
  readonly id: number;          // unique shop stock ID (e.g. 1101, 6172)
  readonly category: number;    // 1=active item, 2=pass, 3=emotion, 4=fanfare, 5=lvEffect, 10=slotDeco, 11=set, 12=charDeco, 14=bombSkin, 18=idDeco, 19=avatar
  readonly name: string;        // retail Traditional Chinese name
  readonly descriptionId: number; // ShopItem +52: stringtable.ini key (sub_4D8147)
  readonly subType: number;
  readonly avatarCode: number;  // CharTE / EmoTE / BombDeco item code
  readonly quantity: number;    // count or duration days
  readonly iconPath: string;    // Fx sprite path (trimmed)
  readonly priceCash: number;   // Cash / Gash price
  readonly priceLucci: number;  // Lucci price
  readonly minLevel: number;
  readonly gender: number;
  readonly durationDays?: number; // u16[1] after gender (`1`, `3`, `7` day timed items)
  readonly sortOrder: number; // signed ShopItem +196; also determines New/Hot
  readonly isNew: boolean;
  readonly isHot: boolean;
  readonly buyableLucci: boolean;
  /** Native ShopItem fields retained separately; +220 selects the currency. */
  readonly retailPrice?: number;
  readonly secondaryPrice?: number;
  readonly currencyType?: number;
  readonly stockType?: number;
  readonly timeFlag?: number;
  readonly extraFlag?: number;
  readonly flags?: number;      // trailing u32 bitmask (`0x02` limit, `0x10` soldOut, `0x80` impEnd)
}

/** Native +220 selects the currency even when the retail price is zero. */
export function stockCurrency(stock: StockItem): "cash" | "lucci" {
  return (stock.currencyType ?? (stock.buyableLucci ? 1 : 0)) === 1 ? "lucci" : "cash";
}

export function parseFxStock(ssiFileBytes: Uint8Array): StockItem[] {
  const ssi = readSsi(ssiFileBytes);
  if (!ssi) return [];
  const buf = ssi.payload;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint16(p, true);
  p += 2;
  const items: StockItem[] = [];
  for (let i = 0; i < count && p < buf.byteLength; i++) {
    const id = dv.getUint32(p, true);
    p += 4;
    const category = buf[p++]!;
    const nl = dv.getUint32(p, true);
    p += 4;
    const name = decodeBig5(buf.subarray(p, p + nl)).trim();
    p += nl;
    const descriptionId = dv.getUint16(p, true);
    p += 2;
    const subType = dv.getUint16(p, true);
    p += 2;
    const avatarCode = dv.getUint32(p, true);
    p += 4;
    const quantity = dv.getUint32(p, true);
    p += 4;
    const il = dv.getUint32(p, true);
    p += 4;
    const iconPath = decodeBig5(buf.subarray(p, p + il)).trim();
    p += il;
    // ShopItem::4D4F4C: +112 is the displayed/charged price; +124
    // is a separate stock field, not a second currency's selling price.
    const retailPrice = dv.getUint32(p, true);
    p += 4;
    const secondaryPrice = dv.getUint32(p, true);
    p += 4;
    const minLevel = dv.getUint16(p, true);
    p += 2;
    const gender = buf[p++]!;
    const durationDays = dv.getUint16(p + 2, true);
    p += 6; // 3 * u16
    const sortOrder = dv.getInt32(p, true);
    p += 4;
    const f1 = buf[p++]!;
    const currencyType = buf[p++]!;
    const f3 = dv.getUint32(p, true);
    p += 4;
    const f4 = buf[p++]!;
    const flags = dv.getUint32(p, true);
    p += 4; // extra u32
    items.push({
      id,
      category,
      name,
      descriptionId,
      subType,
      avatarCode,
      quantity,
      iconPath,
      priceCash: currencyType === 0 ? retailPrice : 0,
      priceLucci: currencyType === 1 ? retailPrice : 0,
      minLevel,
      gender,
      durationDays,
      sortOrder,
      // sub_4AA5C0/4AA5D8 classify the signed +196 value; v6[9]
      // is NewGlyph, v6[8] HotGlyph (4AAFxx / 4ABxxx).
      isNew: sortOrder <= -10000,
      isHot: sortOrder < 0 && sortOrder > -10000,
      buyableLucci: currencyType === 1,
      retailPrice,
      secondaryPrice,
      currencyType,
      stockType: f1,
      timeFlag: f3,
      extraFlag: f4,
      flags,
    });
  }
  return items;
}

export function parsePackageMap(ssiFileBytes: Uint8Array): Map<number, number[]> {
  const ssi = readSsi(ssiFileBytes);
  const out = new Map<number, number[]>();
  if (!ssi) return out;
  const buf = ssi.payload;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint16(p, true);
  p += 2;
  for (let i = 0; i < count && p + 16 <= buf.byteLength; i++) {
    const pkgId = dv.getUint32(p, true);
    const childId = dv.getUint32(p + 4, true);
    p += 16;
    let arr = out.get(pkgId);
    if (!arr) {
      arr = [];
      out.set(pkgId, arr);
    }
    arr.push(childId);
  }
  return out;
}

export function parseSysStrings(ssiFileBytes: Uint8Array): Map<string, string> {
  const ssi = readSsi(ssiFileBytes);
  const out = new Map<string, string>();
  if (!ssi) return out;
  const buf = ssi.payload;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint16(p, true);
  p += 2;
  for (let i = 0; i < count && p + 4 <= buf.byteLength; i++) {
    const kl = dv.getUint32(p, true);
    p += 4;
    if (p + kl + 4 > buf.byteLength) break;
    const key = decodeBig5(buf.subarray(p, p + kl));
    p += kl;
    const vl = dv.getUint32(p, true);
    p += 4;
    if (p + vl > buf.byteLength) break;
    const val = decodeBig5(buf.subarray(p, p + vl));
    p += vl;
    out.set(key, val);
  }
  return out;
}

export function parseStringTable(ssiFileBytes: Uint8Array): Map<number, string> {
  const ssi = readSsi(ssiFileBytes);
  const out = new Map<number, string>();
  if (!ssi) return out;
  const buf = ssi.payload;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const count = dv.getUint16(p, true);
  p += 2;
  for (let i = 0; i < count && p + 8 <= buf.byteLength; i++) {
    const id = dv.getUint32(p, true);
    const sl = dv.getUint32(p + 4, true);
    p += 8;
    if (p + sl > buf.byteLength) break;
    const text = decodeBig5(buf.subarray(p, p + sl)).trim();
    p += sl;
    out.set(id, text);
  }
  return out;
}

/**
 * Exact `Fx:Attr/MapGroup` binary parser (`CA.exe.c:118624..118677`):
 *   `u32 groupCount; repeat { u32 nameLen, char[nameLen] groupName, u32 mapCount; repeat { u32 mapLen, char[mapLen] mapName } }`
 * Groups in Taiwan retail v9 `Fx.idx`: `PraticeMapGroup` (45 maps), `LadderMapGroup` (6 maps), `ReBirthMapGroup` (2 patterns).
 */
export function parseMapGroup(payload: Uint8Array): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (payload.byteLength < 4) return out;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let off = 0;
  const groupCount = dv.getUint32(off, true);
  off += 4;
  for (let g = 0; g < groupCount && off + 4 <= payload.byteLength; g++) {
    const gLen = dv.getUint32(off, true);
    off += 4;
    if (gLen >= 0x80 || off + gLen + 4 > payload.byteLength) break;
    const gName = decodeBig5(payload.subarray(off, off + gLen)).trim();
    off += gLen;
    const mCount = dv.getUint32(off, true);
    off += 4;
    const maps: string[] = [];
    for (let m = 0; m < mCount && off + 4 <= payload.byteLength; m++) {
      const mLen = dv.getUint32(off, true);
      off += 4;
      if (mLen >= 0x80 || off + mLen > payload.byteLength) break;
      maps.push(decodeBig5(payload.subarray(off, off + mLen)).trim());
      off += mLen;
    }
    if (gName) out.set(gName, maps);
  }
  return out;
}
