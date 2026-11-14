// Deterministic Retail Simulation Engine (`src/sim/engine.ts`)
// Shared identically between Client (Practice, 2P Local, Online interpolation)
// and Bun Game Server (authoritative 30ms room simulation).
//
// Constants verified from CA.exe:
//   - Tick dt = 30 ms (33.333 Hz)
//   - Cell = 40x40 px; standard grid 15x13; origin (20+40*(15-w)/2, 41+40*(13-h)/2)
//   - Bomber speed = 4..9 px/tick (Turtle0=2, Owl=5, Turtle1=9, UFO=10), 24px corner-slide
//   - Bomb fuse = 96 ticks (2.88s), kick = 20 px/tick, throw arc = 12 ticks (3 cells)
//   - Flame center = 16 ticks, rays = 19 ticks, chain detonation immediate
//   - Bubble grace = 16 ticks, crawl = 1 px/tick, warn = 150..200 ticks, self-pop = 200 ticks (6.0s)

import type {
  BomberSpec,
  FieldItemSpec,
  ItemAttrTable,
  ObjectTable,
  ParsedMapData,
  RideSpec,
  TileSpec,
} from "../data/tables.ts";
import { bulaLoopCandidates, bulaNativeDotState, traceBulaLoopsAt } from "./bula.ts";

export const TICK_MS = 30;
export const CELL_PX = 40;
export const BOMB_FUSE_TICKS = 96;
export const BOMB_KICK_SPEED = 20;
export const FLAME_TICKS = 19;
export const BOX_CRUMBLE_TICKS = 16;
export const BUBBLE_GRACE_TICKS = 16;
export const BUBBLE_WARN_TICKS = 150;
export const BUBBLE_POP_TICKS = 200;
export const MATCH_DURATION_TICKS = 3600 * 1 + 2400; // 180s = 6000 ticks
export const HURRY_UP_TICKS = 1166; // ~35s remaining
export const START_BANNER_TICKS = 55; // ~1.65s "Game Start!" intro freeze

// Retail direction indices: 0=Left, 1=Up, 2=Right, 3=Down
export type Dir4 = 0 | 1 | 2 | 3;
export const DIR_DX = [-1, 0, 1, 0] as const;
export const DIR_DY = [0, -1, 0, 1] as const;

export type GameModeId = 0 | 1 | 2 | 3 | 4;
// 0 = Basic/Survival, 1 = Captain, 2 = Timebomb, 3 = Hedgehog, 4 = KillCount/Respawn

// Active usable items (keys 1..6 / Ctrl)
export const ACTIVE_NONE = 0;
export const ACTIVE_NEEDLE = 1;
export const ACTIVE_SHIELD = 2;
export const ACTIVE_CAN = 3;      // temporary max speed+power boost
export const ACTIVE_RADAR = 4;    // reveals hidden items under boxes
export const ACTIVE_BANANA = 5;   // slip trap (`Item/BananaGround`)
export const ACTIVE_MINE = 6;     // proximity water trap (`Item/TrapGround`)
export const ACTIVE_DART = 7;     // flying dart projectile (`Item/ThrownDart`)
export const ACTIVE_SPRING = 8;   // 2-cell hop spring (`Item/Spring`)
export const ACTIVE_REMOTE = 9;   // remote bomb detonator (`Item/RadioBomb` -> `Bomb/BombRadio`)
export const ACTIVE_BLIND = 10;   // stealth bomb buff (`Item/Blind` -> `Bomb/BombBlind` + `Flame/FlameBlind`)
export const ACTIVE_DRILL = 11;   // drills box directly ahead (`Item/Drill`)
export const ACTIVE_GUM = 12;     // superglue slow trap (`Item/Bond` -> `Item/BondGround`)
export const ACTIVE_PIN = 13;     // thumbtack pop/dismount trap (`Item/Pushpin` -> `Item/PushpinGround`)
export const ACTIVE_WATERTIGHT = 14; // waterproof suit (`Waterproof` -> `Item/Watertight`, extended water immunity)

export interface PlayerInput {
  dir: Dir4 | -1;
  placeBomb: boolean;
  useActive: boolean;
  slotUse?: number; // 0..5 for quick item slots 1..6
}

interface BulaDotEffect {
  startTick: number;
  hideAfter: boolean;
}

export interface SimCell {
  groundObjName: string;
  blockObjName: string; // "" if empty
  blockKind: 0 | 1 | 2 | 3; // 0=none, 1=static, 2=box, 3=bush/house
  hp: number;
  maxHp: number;
  shakeTicks: number;
  blocksWalk: boolean;
  pushable: boolean;
  indestructible: boolean;
  hidesUnit: boolean;
  burnsInFlame: boolean;
  conveyorDir: -1 | 0 | 1 | 2 | 3;
  conveyorAlignMask: number;
  conveyorSpeed: number;
  isIce: boolean;
  passPlayerDir: [boolean, boolean, boolean, boolean];
  passBombDir: [boolean, boolean, boolean, boolean];
  passFlameDir: [boolean, boolean, boolean, boolean];
  noBombPlace: boolean;
  isPinHazard: boolean;
  bombPinHazard: boolean; // Ground spike flag (retail sub_482843), distinct from passable spikes.
  blockEdgePinDir: [boolean, boolean, boolean, boolean];
  isPitStop: boolean;
  isTrackRoad: boolean;
  hasFootprints: boolean;
  lapCheckpoint: number; // -1 or 0..4
  isBulaVault: boolean;
  bulaVaultVariant: number; // TileInfo i4 selects Tile15_Static/AftNN
  bulaHouseTeam: number; // -1 unclaimed block, 0..7 captured team
  bulaDots: number[]; // -2 hidden, -1 absent, 0 unclaimed, 1..8 owner team
  bulaDotEffects: (BulaDotEffect | null)[];
  crumbleTicks: number; // >0 while box/bush is disintegrating
  pendingDrop: SimGroundItem | null;
  dropRolled?: boolean;
}

export interface SimGroundItem {
  id: number;
  cx: number;
  cy: number;
  objectName: string;
  iconSprite: string;
  pickupFlag: number;
  effectId: number;
  activeSlotFlag?: number;
  spawnTick: number;
}

export interface SimDart {
  id: number;
  ownerSlot: number;
  px: number;
  py: number;
  dir: Dir4;
}

export interface SimHazard {
  id: number;
  ownerSlot: number;
  kind: "banana" | "trap" | "gum" | "pin";
  cx: number;
  cy: number;
  armTicks: number;
}

export interface SimBomb {
  id: number;
  ownerSlot: number;
  power: number;
  pierce?: boolean;
  style?: "normal" | "remote" | "blind";
  cx: number;
  cy: number;
  px: number; // pixel center in map coords (cx*40+20 when stationary)
  py: number;
  fuseTicks: number;
  slidingDir: Dir4 | -1;
  thrownTicks: number;    // >0 while flying in parabolic arc
  thrownTotalTicks: number;
  throwStartX: number;
  throwStartY: number;
  throwDestCx: number;
  throwDestCy: number;
  passThroughSlots: number[]; // slots still standing on the cell where bomb was placed
}

export interface SimFlame {
  cx: number;
  cy: number;
  part: "C" | "L" | "U" | "R" | "D" | "LE" | "UE" | "RE" | "DE";
  ticksLeft: number;
  ownerSlot: number;
  blind?: boolean;
}

/** sub_499EA9 uses a 32x15 soul rectangle and requires two-thirds flame coverage.
 * Flames can span adjacent tiles; multiple flame parts in one tile count only once. */
export function soulFlameHit(px: number, py: number, flames: readonly SimFlame[]): SimFlame | undefined {
  const left = px - 16, top = py + 4;
  let area = 0;
  let first: SimFlame | undefined;
  const seen = new Set<string>();
  for (const flame of flames) {
    const key = `${flame.cx},${flame.cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x = flame.cx * CELL_PX, y = flame.cy * CELL_PX;
    const w = Math.max(0, Math.min(left + 32, x + CELL_PX) - Math.max(left, x));
    const h = Math.max(0, Math.min(top + 15, y + CELL_PX) - Math.max(top, y));
    if (w && h) { area += w * h; first ??= flame; }
  }
  return area >= 320 ? first : undefined;
}

export interface SimPushBox {
  fromCx: number;
  fromCy: number;
  toCx: number;
  toCy: number;
  dir: Dir4;
  ticksLeft: number;
  totalTicks: number;
  objName: string;
  hp: number;
  maxHp: number;
  pendingDrop: SimGroundItem | null;
  dropRolled?: boolean;
}

export interface SimSoul {
  id: number;
  kind: "InnerSoul" | "OuterSoul"; // InnerSoul = Game/Mummy, OuterSoul = Game/BulaBat
  px: number;
  py: number;
  dir: Dir4;
  speed: number;
  angry: boolean;
  state: "spawn" | "walk" | "dying";
  stateTicks: number;
  pathIndex: number; // 1-based into `soulPaths`, or 0 for free patrol
  waypointIdx: number;
}

export interface SimFootprint {
  id: number;
  px: number;
  py: number;
  dir: Dir4;
  alt: 0 | 1;
  ticksLeft: number;
}

export interface SimAirPlane {
  px: number;
  py: number;
  row: number;
  drops: { col: number; dropped: boolean }[];
}

export interface SimGhost {
  id: number;
  px: number;
  py: number;
  dir: Dir4;
  state: "in" | "walk" | "trans" | "rush" | "stun";
  stateTicks: number;
}

export type BomberState = "ready" | "alive" | "trapped" | "hedgehog" | "dying" | "dead";

export interface SimPlayer {
  slot: number;          // 0..7
  name: string;
  charCode: number;      // 0..10 (C00..C10)
  team: number;          // 0..7 (0=Red, 1=Blue, 2=Green, 3=Yellow, etc. or solo 0..7)
  isAi: boolean;
  aiLevel: 1 | 2 | 3;
  isCaptain: boolean;

  state: BomberState;
  stateTicks: number;
  px: number;            // map-local pixel X (0 .. width*40)
  py: number;            // map-local pixel Y (0 .. height*40)
  facing: Dir4;
  moving: boolean;
  walkTicks: number;

  // Stats
  speed: number;
  speedMax: number;
  bombsMax: number;
  bombsPlaced: number;
  power: number;
  powerMax: number;
  hasKick: boolean;
  hasThrow: boolean;
  hasPierceBomb: boolean;
  hasRemoteBomb: boolean;
  hasIceSkate: boolean;
  hasOxygen: boolean;

  // Mount / Ride
  rideId: number;        // 0 = none, 1..11 (`Fx:Attr/ItemAttr` `ships` IDs)
  rideSpeed: number;
  rideFly: boolean;
  hopInvulnTicks: number; // invulnerable dismount/spring hop ticks

  // Status & action timers
  shieldTicks: number;
  invulnTicks: number;
  curseTicks: number;    // Devil / Skeleton / MoonWalk curse timer
  curseKind?: number;    // 8=Skeleton0(fast+autobomb), 9=Skeleton1(crawl), 10=MoonWalk(reverse), 12=GreenDevil(contagious reverse+autobomb)
  goggleTicks?: number;  // Goggle (`Item/Swimming`, eff=17): reveals bushes, stealth bombs & camouflaged enemies
  camoTicks?: number;    // Camouflage (`Item/Mask`, eff=19): stealth invisibility against enemies without Goggle
  alphabetMask?: number; // 11-bit `CRAZY ARCADE` (`Item/Alphabet_01..11`) collection mask (`0..0x7ff`)
  boostTicks: number;    // Can / SuperMan boost
  blindTicks: number;    // Blind stealth bomb buff
  radarTicks: number;    // Scanner (`ACTIVE_RADAR`) X-ray box item vision
  glueTicks: number;     // Superglue (`Item/BondGround`) slow
  throwTicks: number;    // `16..19 Throw *` animation
  drillTicks: number;    // `35..38 Drill *` animation
  jumpTicks: number;     // `31..34 Jump *` parabolic hop animation
  jumpStartX: number;
  jumpStartY: number;
  shootTicks: number;    // `Ship/Tank` `08..11 Shoot *` recoil animation
  hedgehogSuper: boolean;
  hedgehogSpinTicks: number;
  hedgehogStruggleTicks: number;
  slipDir: Dir4 | -1;
  slipTicks: number;
  portalCooldownTicks: number;
  pushChargeDir: Dir4 | -1;
  pushChargeTicks: number;
  hasTimebomb: boolean;
  timebombTicks: number;

  // Active item inventory (6 quick slots)
  activeSlots: [number, number, number, number, number, number];

  // Match scoreboard
  kills: number;
  deaths: number;
  saves: number;
  bonusLucci: number;
  trappedBySlot: number;

  // Cosmetics (optional CharTE / BombDeco / IDDeco codes)
  hatCode?: number;
  charDecoCodes?: number[];
  bombSkinCode?: number;
  idDecoCode?: number;
  activeSlotCap?: number;
  hasSpanner?: boolean;
  comboKills?: number;
  maxCombo?: number;
  comboWindowTicks?: number;
  reviveCx?: number;
  reviveCy?: number;
  noRevive?: boolean;

  // Kart Racing (`CKartComponent` / `CGOTileLap`), Bula (`CBulaComponent`), Event2004 & Footprint state
  kartLap?: number;
  kartCheckpoint?: number;
  kartFuel?: number;
  kartLowFuelWarned?: boolean;
  isFinalLap?: boolean;
  isFirstPlace?: boolean;
  offRoadSand?: boolean;
  wetTicks?: number;
  lastFootprintTick?: number;
  footprintAlt?: 0 | 1;
  bulaHouses?: number;
  goldFlags?: number;
  questionMarks?: number;
  questionEffTicks?: number;
  niceTicks?: number;
  xmasItems?: [number, number, number];
}

export type SimSoundEvent =
  | "GameStart_0"
  | "BonusStageEffect"
  | "BonusStageVocal"
  | "BombIgnite"
  | "BombExplode"
  | "BlockDown"
  | "ItemEaten"
  | "ItemPop"
  | "ItemShip00"
  | "ItemShip01"
  | "ItemRelease"
  | "Banana"
  | "MineSet"
  | "Spring"
  | "SpringShort"
  | "UseMotor"
  | "Drill"
  | "TankFire"
  | "KartAccel"
  | "KartNitro"
  | "RallyPoint"
  | "Refuel"
  | "FuelWarning"
  | "SuperMan"
  | "GreenDevil"
  | "HedgehogRebirth"
  | "HedgehogStruggle"
  | "BulaBatCreate"
  | "BulaBatDie"
  | "BulaMummyCreate"
  | "BulaMummyDie"
  | "BulaGhostWarning2"
  | "BulaColoring"
  | "BulaTookHouse"
  | "BulaPlayerDie"
  | "Ghost"
  | "GhostTrans"
  | "LockedIn"
  | "Release"
  | "Revive"
  | "Die"
  | "HurryUp"
  | "Win"
  | "Lose"
  | "Draw"
  | "TimebombRoulette"
  | "TimebombTouch"
  | "TimebombCaution"
  | "TimebombExplode"
  | "real_timpani_roll"
  | "brass";

export interface SimCoinPopup {
  id: number;
  px: number;
  py: number;
  amount: number;
  ticksLeft: number;
}

export interface MatchParticipantInit {
  slot: number;
  name: string;
  charCode: number; // -1 = random (can roll C08/C09 hidden super bombers!)
  team: number;
  isAi?: boolean;
  aiLevel?: 1 | 2 | 3;
  initialNeedles?: number;
  initialShields?: number;
  initialActiveItems?: number[];
  initialSpeedBonus?: number;
  initialPowerBonus?: number;
  initialRadarTicks?: number;
  activeSlotCap?: number;
  hasSpanner?: boolean;
  hatCode?: number;
  charDecoCodes?: number[];
  bombSkinCode?: number;
  idDecoCode?: number;
}

export interface SimMatchConfig {
  mapData: ParsedMapData;
  mode: GameModeId;
  seed?: number;
  bulaCompetitive?: boolean;
  participants: readonly MatchParticipantInit[];
  objectTable: ObjectTable;
  bomberByCode: ReadonlyMap<number, BomberSpec>;
  itemAttr: ItemAttrTable;
  tileInfo: ReadonlyMap<string, TileSpec>;
}

export interface SimSnapshot {
  tick: number;
  ticksRemaining: number;
  mode: GameModeId;
  componentMode?: number;
  kartTotalLaps?: number;
  kartCheckpoints?: number;
  batSwarmTick?: number;
  timebombRouletteTicks?: number;
  timebombRouletteSlot?: number;
  bonusCoinsTotal?: number;
  bonusCoinsCollected?: number;
  mapName: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  finished: boolean;
  winnerTeam: number; // -1 = draw, >=0 winning team (or slot+100 if FFA)
  winnerSlots: number[];
  perfectWin?: boolean;
  hurryUp: boolean;
  cells: {
    ground: string;
    block: string;
    kind: 0 | 1 | 2 | 3;
    hp: number;
    maxHp: number;
    shake: number;
    hides: boolean;
    crumble: number;
    lapCp?: number;
    dropIcon?: string;
    bulaHouseTeam?: number;
    bulaHouseEligible?: boolean;
    bulaHouseVar?: number;
    bulaDots?: number[];
    bulaDotEffects?: (BulaDotEffect | null)[];
  }[];
  items: SimGroundItem[];
  bombs: SimBomb[];
  flames: SimFlame[];
  pushBoxes: SimPushBox[];
  darts?: SimDart[];
  hazards?: SimHazard[];
  souls?: SimSoul[];
  footprints?: SimFootprint[];
  coinPopups?: SimCoinPopup[];
  airplane?: { px: number; py: number } | null;
  ghost?: SimGhost | null;
  players: SimPlayer[];
  sounds: SimSoundEvent[];
}

/** Fast deterministic Mulberry32 PRNG so client & server stay reproducible. */
export class Rng {
  private state: number;
  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0 || 1;
  }
  nextU32(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }
  nextInt(maxExclusive: number): number {
    return maxExclusive <= 1 ? 0 : this.nextU32() % maxExclusive;
  }
}

export class GameSimulation {
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
  readonly mapName: string;
  readonly mode: GameModeId;
  readonly componentMode: number;
  readonly kartCheckpoints: number;
  readonly kartTotalLaps: number;
  readonly batIntervalTicks: number;
  readonly rng: Rng;

  private readonly itemAttr: ItemAttrTable;
  private readonly bomberByCode: ReadonlyMap<number, BomberSpec>;
  private readonly tileInfo: ReadonlyMap<string, TileSpec>;
  private readonly soulPaths: readonly (readonly (readonly [number, number])[])[];
  private readonly soulSpawnDefs: readonly { kind: "InnerSoul" | "OuterSoul"; col: number; row: number; waypointOrDir: number; speed: number; pathIndex: number }[];
  private readonly initialSoulCount: number;
  private readonly bulaDotEatenTicks: number;
  private readonly soulActionTicks: Record<"InnerSoul" | "OuterSoul", { spawn: number; dying: number }>;
  readonly bulaCompetitive: boolean;
  private readonly eventTargetFlags: number;

  tick = 0;
  ticksRemaining = MATCH_DURATION_TICKS;
  finished = false;
  finishCooldownTicks = 0;
  winnerTeam = -1;
  winnerSlots: number[] = [];
  hurryUp = false;
  batSwarmTick = -9999;
  timebombRouletteTicks = 0;
  timebombRouletteSlot = -1;
  private suddenDeathCursor = 0;
  private bonusCoinsTotal = 0;
  private bonusCoinsCollected = 0;
  private readonly pendingSoulRespawns: { defIdx: number; ticksLeft: number }[] = [];

  readonly cells: SimCell[];
  readonly items: SimGroundItem[] = [];
  readonly bombs: SimBomb[] = [];
  readonly flames: SimFlame[] = [];
  readonly pushBoxes: SimPushBox[] = [];
  readonly darts: SimDart[] = [];
  readonly hazards: SimHazard[] = [];
  readonly souls: SimSoul[] = [];
  readonly footprints: SimFootprint[] = [];
  readonly coinPopups: SimCoinPopup[] = [];
  airplane: SimAirPlane | null = null;
  ghost: SimGhost | null = null;
  readonly players: SimPlayer[] = [];
  readonly sounds: SimSoundEvent[] = [];

  private readonly portals = new Map<string, [number, number]>();
  private readonly mapDropPool: { spec: FieldItemSpec; weight: number }[] = [];
  private readonly mapTotalDropWeight: number = 0;
  private readonly mapDropRatePct: number = 62;

  private nextEntityId = 1;
  private readonly inputs = new Map<number, PlayerInput>();
  // Network input can press and release between simulation ticks. Preserve
  // those edges once while keeping the latest direction/held state.
  private readonly pendingInputEdges = new Map<number, { bomb: boolean; active: boolean; slotUse?: number }>();
  private readonly prevPlaceBomb = new Set<number>();
  private readonly prevUseActive = new Set<number>();

  constructor(cfg: SimMatchConfig) {
    const { mapData, objectTable, tileInfo, itemAttr, bomberByCode } = cfg;
    this.width = mapData.width;
    this.height = mapData.height;
    this.originX = mapData.originX;
    this.originY = mapData.originY;
    this.mapName = mapData.name;
    this.mode = cfg.mode;
    this.componentMode = /^bonus\d/i.test(mapData.name) ? 4 : (mapData.componentMode ?? 0);
    if (this.componentMode === 4) {
      this.ticksRemaining = 1500; // Retail `CBonusComponent` 45s Coin Rush timer!
    }
    this.kartCheckpoints = this.componentMode === 1 ? Math.max(1, mapData.modeParam0 || 4) : 0;
    this.kartTotalLaps = this.componentMode === 1 ? Math.max(1, mapData.modeParam1 || 3) : 0;
    this.bulaCompetitive = Boolean(cfg.bulaCompetitive || (this.componentMode === 2 && cfg.mode !== 0));
    this.eventTargetFlags = this.componentMode === 3 ? Math.max(1, mapData.modeParam1 || 3) : 0;
    this.batIntervalTicks = (mapData.batIntervalSec ?? 0) > 0 ? Math.round((mapData.batIntervalSec ?? 0) * (1000 / TICK_MS)) : 0;
    // CGOInnerSoul/CGOOuterSoul leave In/Out states when their object action ends.
    const soulTimes = (name: string, spawn: number, dying: number) => {
      const actions = objectTable.byName.get(name)?.actionList;
      return { spawn: actions?.[0]?.totalTicks || spawn, dying: actions?.[1]?.totalTicks || dying };
    };
    this.soulActionTicks = {
      InnerSoul: soulTimes("Game/Mummy", 30, 20),
      OuterSoul: soulTimes("Game/BulaBat", 24, 24),
    };
    this.bulaDotEatenTicks = objectTable.byName.get("Character/Bula")?.actionList[2]?.totalTicks || 14;
    this.soulPaths = mapData.soulPaths ?? [];
    this.soulSpawnDefs = mapData.soulSpawns ?? [];
    this.rng = new Rng(cfg.seed ?? ((Date.now() ^ 0x5bf03635) >>> 0));
    this.itemAttr = itemAttr;
    this.bomberByCode = bomberByCode;
    this.tileInfo = tileInfo;
    this.mapDropRatePct = mapData.dropRatePct;

    // Build bidirectional warp/LapTile links (`sub_4854E3` `v75`)
    for (const [cA, rA, cB, rB] of mapData.portals) {
      this.portals.set(`${cA},${rA}`, [cB, rB]);
      this.portals.set(`${cB},${rB}`, [cA, rA]);
    }

    // Build retail per-map item drop table (`sub_4D33EC`: `ItemAttr` defaults overridden by `mapData.itemQuotas`)
    let totalW = 0;
    for (const spec of itemAttr.items) {
      const low = spec.objectName.toLowerCase();
      const bare = low.replace(/^item\/(item)?/, "");
      let w = spec.dropWeight;
      if (mapData.itemQuotas.has(low)) w = mapData.itemQuotas.get(low)!;
      else if (mapData.itemQuotas.has(`item/${bare}`)) w = mapData.itemQuotas.get(`item/${bare}`)!;
      else if (mapData.itemQuotas.has(`item/item${bare}`)) w = mapData.itemQuotas.get(`item/item${bare}`)!;
      else if (mapData.itemQuotas.has(bare)) w = mapData.itemQuotas.get(bare)!;
      if (w > 0) {
        this.mapDropPool.push({ spec, weight: w });
        totalW += w;
      }
    }
    this.mapTotalDropWeight = totalW;

    // Initialize grid cells from MapData + ObjectTable + TileInfo
    this.cells = new Array(this.width * this.height);
    let defaultGround = "";
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const mc = mapData.cells[y * this.width + x]!;
        const gObj = mc.groundObjIdx >= 0 ? objectTable.byIndex[mc.groundObjIdx]?.name ?? "" : "";
        if (!defaultGround && gObj) defaultGround = gObj;
        const bObj = mc.blockObjIdx >= 0 ? objectTable.byIndex[mc.blockObjIdx]?.name ?? "" : "";
        const gSpec = gObj ? tileInfo.get(gObj) : undefined;
        const bSpec = bObj ? tileInfo.get(bObj) : undefined;
        const blockKind = (bSpec ? bSpec.kind : 0) as 0 | 1 | 2 | 3;
        const boxHp = blockKind === 2 ? (bSpec?.hp ?? 1) : 1;
        const blocksWalk =
          Boolean(gSpec?.blocksWalk) ||
          blockKind === 1 ||
          blockKind === 2;
        const passPlayerDir: [boolean, boolean, boolean, boolean] =
          blockKind === 3 && bSpec
            ? [...bSpec.passPlayerDir]
            : [true, true, true, true];
        const passBombDir: [boolean, boolean, boolean, boolean] =
          blockKind === 3 && bSpec
            ? [...bSpec.passBombDir]
            : [true, true, true, true];
        const passFlameDir: [boolean, boolean, boolean, boolean] =
          blockKind === 3 && bSpec
            ? [...bSpec.passFlameDir]
            : [true, true, true, true];
        this.cells[y * this.width + x] = {
          groundObjName: gObj,
          blockObjName: bObj,
          blockKind,
          hp: boxHp,
          maxHp: boxHp,
          shakeTicks: 0,
          blocksWalk,
          pushable: Boolean(bSpec?.pushable),
          indestructible: Boolean(bSpec?.indestructible),
          hidesUnit: Boolean(bSpec?.hidesUnit),
          burnsInFlame: Boolean(bSpec?.burnsInFlame),
          conveyorDir: gSpec?.conveyorDir ?? -1,
          conveyorAlignMask: gSpec?.conveyorAlignMask ?? 0,
          conveyorSpeed: gSpec?.conveyorSpeed ?? 0,
          isIce: Boolean(gSpec?.isIce),
          passPlayerDir,
          passBombDir,
          passFlameDir,
          noBombPlace: Boolean(bSpec?.noBombPlace || gSpec?.noBombPlace),
          isPinHazard: Boolean(bSpec?.isPinHazard || gSpec?.isPinHazard),
          bombPinHazard: Boolean(gSpec?.isPinHazard),
          blockEdgePinDir: bSpec ? [...bSpec.blockEdgePinDir] : [false, false, false, false],
          isPitStop: Boolean(bSpec?.isPitStop),
          isTrackRoad: Boolean(gSpec?.isTrackRoad),
          hasFootprints: Boolean(gSpec?.hasFootprints),
          lapCheckpoint: gSpec?.lapCheckpoint ?? -1,
          isBulaVault: Boolean(bSpec?.bulaHouseEligible),
          bulaVaultVariant: bSpec?.bulaHouseVariant ?? 0,
          bulaHouseTeam: -1,
          // 0x616398 / 0x6163A8: four possible dots at (1,0), (0,1), (1,1), (2,1).
          bulaDots: (() => {
            const dots = [-1, -1, -1, -1, -1, -1];
            if (this.componentMode !== 2) return dots;
            const mask = (gSpec?.bulaPattern ?? 0) % 100;
            for (const [bit, idx] of [[1, 1], [2, 3], [4, 4], [8, 5]] as const) {
              if ((mask & bit) === bit) dots[idx] = 0;
            }
            return dots;
          })(),
          bulaDotEffects: [null, null, null, null, null, null],
          crumbleTicks: 0,
          pendingDrop: null,
        };
      }
    }

    // Fill any empty ground cells with defaultGround AND apply multi-cell static footprints (anchored bottom-left!)
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[y * this.width + x]!;
        if (!c.groundObjName && defaultGround) {
          c.groundObjName = defaultGround;
          const dg = tileInfo.get(defaultGround);
          if (dg) {
            c.isTrackRoad = dg.isTrackRoad;
            c.hasFootprints = dg.hasFootprints;
            c.lapCheckpoint = dg.lapCheckpoint;
          }
        }
        if (c.blockObjName) {
          const bSpec = tileInfo.get(c.blockObjName);
          if (bSpec && bSpec.kind === 1 && (bSpec.width > 1 || bSpec.height > 1)) {
            for (let fy = y - bSpec.height + 1; fy <= y; fy++) {
              for (let fx = x; fx < x + bSpec.width; fx++) {
                if (fx >= 0 && fx < this.width && fy >= 0 && fy < this.height) {
                  const foot = this.cells[fy * this.width + fx]!;
                  foot.blocksWalk = true;
                  if (foot.blockKind === 0) {
                    foot.blockKind = 1;
                    foot.indestructible = true;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Spawn participants at map's retail spawn slots
    const spawns = mapData.spawns.length > 0
      ? [...mapData.spawns]
      : [
          [1, 1],
          [this.width - 2, 1],
          [1, this.height - 2],
          [this.width - 2, this.height - 2],
          [7, 1],
          [7, this.height - 2],
          [1, 6],
          [this.width - 2, 6],
        ] as [number, number][];

    // Shuffle spawn indices deterministically (except Kart starting grid where lanes are ordered!)
    if (this.componentMode !== 1) {
      for (let i = spawns.length - 1; i > 0; i--) {
        const j = this.rng.nextInt(i + 1);
        const tmp = spawns[i]!;
        spawns[i] = spawns[j]!;
        spawns[j] = tmp;
      }
    }

    // Locate Start_* checkpoint (`lapCheckpoint === 0`) for Kart racer initial facing
    let startCpCol = -1;
    let startCpRow = -1;
    if (this.componentMode === 1) {
      for (let y = 0; y < this.height && startCpCol < 0; y++) {
        for (let x = 0; x < this.width; x++) {
          if (this.cells[y * this.width + x]!.lapCheckpoint === 0) {
            startCpCol = x;
            startCpRow = y;
            break;
          }
        }
      }
    }

    const captainAssigned = new Set<number>();

    cfg.participants.forEach((p, idx) => {
      let code = p.charCode;
      if (code < 0) {
        // Retail Random (`?`) character: can roll hidden secret bombers C08 (紀念超人), C09 (海盜船長), or C10 (聖誕老人)!
        const roll = this.rng.nextInt(100);
        if (roll < 5) code = 8;
        else if (roll < 10) code = 9;
        else if (roll < 15) code = 10;
        else code = this.rng.nextInt(8);
      }
      code = Math.max(0, Math.min(10, code));
      const spec = bomberByCode.get(code) ?? bomberByCode.get(0)!;
      const sp = spawns[idx % spawns.length]!;
      const sx = Math.max(0, Math.min(this.width - 1, sp[0]));
      const sy = Math.max(0, Math.min(this.height - 1, sp[1]));

      // Ensure spawn cell + at least 1 neighbor is clear of destructible boxes so nobody spawns boxed-in
      this.clearSpawnSafeZone(sx, sy);

      // On Bula (`componentMode === 2`): cooperative Team 0 in default Co-op (`mode === 0 && !bulaCompetitive`),
      // or competitive per-team Territory War when `bulaCompetitive` / Team modes are selected!
      const effectiveTeam =
        this.componentMode === 2
          ? this.bulaCompetitive
            ? p.team
            : 0
          : this.componentMode === 1
            ? p.slot
            : p.team;

      const isCaptain = this.mode === 1 && this.componentMode === 0 && !captainAssigned.has(effectiveTeam);
      if (isCaptain) captainAssigned.add(effectiveTeam);

      const slots: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
      let sPtr = 0;
      const slotCap = Math.max(1, Math.min(6, p.activeSlotCap ?? 4));
      for (let n = 0; n < Math.min(2, p.initialNeedles ?? 1) && sPtr < slotCap; n++) {
        slots[sPtr++] = ACTIVE_NEEDLE;
      }
      for (let n = 0; n < Math.min(2, p.initialShields ?? 0) && sPtr < slotCap; n++) {
        slots[sPtr++] = ACTIVE_SHIELD;
      }
      if (this.componentMode === 1) {
        // Kart Racers start with 2 Nitro boosts (`ACTIVE_CAN`)!
        if (sPtr < slotCap) slots[sPtr++] = ACTIVE_CAN;
        if (sPtr < slotCap) slots[sPtr++] = ACTIVE_CAN;
      }
      let startHasRemote = false;
      if (p.initialActiveItems) {
        for (const act of p.initialActiveItems) {
          if (sPtr >= slotCap) break;
          if (act > 0) {
            slots[sPtr++] = act;
            if (act === ACTIVE_REMOTE) startHasRemote = true;
          }
        }
      }

      let initialFacing: Dir4 = 3;
      if (this.componentMode === 1 && startCpCol >= 0) {
        const dx = startCpCol - sx;
        const dy = startCpRow - sy;
        if (Math.abs(dx) >= Math.abs(dy)) initialFacing = dx < 0 ? 0 : 2;
        else initialFacing = dy < 0 ? 1 : 3;
      }

      const startRideId = this.componentMode === 1 ? (idx % 2 === 0 ? 9 : 10) : 0;
      const startRideSpec = startRideId > 0 ? itemAttr.ships.get(startRideId) : undefined;
      const maxSpd = spec?.speedMax ?? 7;
      const maxPwr = spec?.powerMax ?? 7;

      this.players.push({
        slot: p.slot,
        name: p.name,
        charCode: code,
        team: effectiveTeam,
        isAi: Boolean(p.isAi),
        aiLevel: p.aiLevel ?? 2,
        isCaptain,
        state: "alive",
        stateTicks: 0,
        px: sx * CELL_PX + 20,
        py: sy * CELL_PX + 20,
        facing: initialFacing,
        moving: false,
        walkTicks: 0,
        speed: Math.min(maxSpd, (spec?.speedMin ?? 5) + (p.initialSpeedBonus ?? 0)),
        speedMax: maxSpd,
        bombsMax: spec?.bombMin ?? 1,
        bombsPlaced: 0,
        power: Math.min(maxPwr, (spec?.powerMin ?? 1) + (p.initialPowerBonus ?? 0)),
        powerMax: maxPwr,
        hasKick: false,
        hasThrow: false,
        hasPierceBomb: false,
        hasRemoteBomb: startHasRemote,
        hasIceSkate: false,
        hasOxygen: false,
        rideId: startRideId,
        rideSpeed: startRideSpec?.speed ?? (startRideId > 0 ? 9 : 0),
        rideFly: false,
        hopInvulnTicks: 0,
        shieldTicks: 0,
        invulnTicks: START_BANNER_TICKS,
        curseTicks: 0,
        boostTicks: 0,
        blindTicks: 0,
        radarTicks: p.initialRadarTicks ?? 0,
        glueTicks: 0,
        throwTicks: 0,
        drillTicks: 0,
        jumpTicks: 0,
        jumpStartX: sx * CELL_PX + 20,
        jumpStartY: sy * CELL_PX + 20,
        shootTicks: 0,
        hedgehogSuper: false,
        hedgehogSpinTicks: 0,
        hedgehogStruggleTicks: 0,
        slipDir: -1,
        slipTicks: 0,
        portalCooldownTicks: 0,
        pushChargeDir: -1,
        pushChargeTicks: 0,
        hasTimebomb: false,
        timebombTicks: 0,
        activeSlots: slots,
        kills: 0,
        deaths: 0,
        saves: 0,
        bonusLucci: 0,
        trappedBySlot: -1,
        hatCode: p.hatCode,
        charDecoCodes: p.charDecoCodes ? [...p.charDecoCodes] : undefined,
        bombSkinCode: p.bombSkinCode,
        idDecoCode: p.idDecoCode,
        activeSlotCap: slotCap,
        hasSpanner: Boolean(p.hasSpanner),
        comboKills: 0,
        maxCombo: 0,
        comboWindowTicks: 0,
        kartLap: 0,
        kartCheckpoint: -1,
        kartFuel: 100,
        kartLowFuelWarned: false,
        isFinalLap: false,
        isFirstPlace: false,
        offRoadSand: false,
        lastFootprintTick: -999,
        footprintAlt: 0,
        bulaHouses: 0,
        goldFlags: 0,
        questionMarks: 0,
        questionEffTicks: 0,
        niceTicks: 0,
      });
    });

    // Spawn retail `sub_4C9263` `CGOInnerSoul` (`Game/Mummy`) & `CGOOuterSoul` (`Game/BulaBat`) patrols!
    for (const sp of mapData.soulSpawns ?? []) {
      const scx = Math.max(0, Math.min(this.width - 1, sp.col));
      const scy = Math.max(0, Math.min(this.height - 1, sp.row));
      let px = scx * CELL_PX + 20;
      let py = scy * CELL_PX + 20;
      let wpIdx = 0;
      let dir: Dir4 = ((sp.waypointOrDir & 3) as Dir4);
      if (sp.pathIndex > 0 && this.soulPaths[sp.pathIndex - 1]?.length) {
        const path = this.soulPaths[sp.pathIndex - 1]!;
        wpIdx = sp.waypointOrDir >= 0 && sp.waypointOrDir < path.length ? sp.waypointOrDir : 0;
        const pt = path[wpIdx]!;
        px = Math.max(0, Math.min(this.width - 1, pt[0])) * CELL_PX + 20;
        py = Math.max(0, Math.min(this.height - 1, pt[1])) * CELL_PX + 20;
        const next = path[(wpIdx + 1) % path.length]!;
        dir = next[0] === pt[0] ? (next[1] > pt[1] ? 3 : 1) : (next[0] > pt[0] ? 2 : 0);
      }
      const baseSpeed = Math.max(2, Math.min(6, sp.speed || 2));
      this.souls.push({
        id: this.nextEntityId++,
        kind: sp.kind,
        px,
        py,
        dir,
        speed: baseSpeed,
        angry: baseSpeed >= 4,
        state: "spawn",
        stateTicks: 0,
        pathIndex: sp.pathIndex,
        waypointIdx: (wpIdx + 1) % Math.max(1, this.soulPaths[sp.pathIndex - 1]?.length ?? 1),
      });
    }
    this.initialSoulCount = this.souls.length;

    // Spawn retail `sub_4D33EC` pre-placed ground items (`Bonus01..07` Lucci coins!) & guaranteed box items!
    for (const pre of mapData.preplacedItems) {
      if (pre.col >= this.width || pre.row >= this.height) continue;
      if (pre.probPct < 100 && this.rng.nextInt(100) >= pre.probPct) continue;
      const spec = this.findItemSpecByName(pre.itemName);
      if (!spec) continue;
      const cell = this.cellAt(pre.col, pre.row);
      if (!cell) continue;
      const groundItem: SimGroundItem = {
        id: this.nextEntityId++,
        cx: pre.col,
        cy: pre.row,
        objectName: spec.objectName,
        iconSprite: spec.iconSprite,
        pickupFlag: spec.pickupFlag,
        effectId: spec.effectId,
        activeSlotFlag: spec.activeSlotFlag,
        spawnTick: 0,
      };
      if (cell.blockKind === 2 && !cell.indestructible) {
        cell.pendingDrop = groundItem;
        cell.dropRolled = true;
      } else if (!cell.blocksWalk) {
        this.items.push(groundItem);
        if (this.componentMode === 4 && groundItem.pickupFlag === 99 && groundItem.effectId > 0) {
          this.bonusCoinsTotal++;
        }
      }
    }

    // Pre-roll hidden items inside remaining destructible boxes so `Scanner` (`ACTIVE_RADAR`)
    // reveals the exact real drop inside every box!
    const boxCoords: [number, number][] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y * this.width + x]!;
        if (cell.blockKind === 2 && !cell.indestructible && !cell.dropRolled) {
          cell.pendingDrop = this.rollItemDrop(x, y);
          cell.dropRolled = true;
          boxCoords.push([x, y]);
        }
      }
    }

    // `CEvent2004Component` (`componentMode === 3`, `EventCamp00..EventPatrit00`):
    // Hide `eventTargetFlags` Golden Flags (`Game/Event2004ResultFlag`) inside destructible boxes,
    // or spawn on open ground when the map is an open Soul maze (`EventForest00` / `EventPatrit00`)!
    if (this.componentMode === 3) {
      for (let i = boxCoords.length - 1; i > 0; i--) {
        const j = this.rng.nextInt(i + 1);
        const tmp = boxCoords[i]!;
        boxCoords[i] = boxCoords[j]!;
        boxCoords[j] = tmp;
      }
      let placedFlags = 0;
      for (const [bx, by] of boxCoords) {
        if (placedFlags >= this.eventTargetFlags) break;
        const bc = this.cellAt(bx, by);
        if (bc) {
          bc.pendingDrop = {
            id: this.nextEntityId++,
            cx: bx,
            cy: by,
            objectName: "GoldFlag",
            iconSprite: "Item/ItemGoldFlag",
            pickupFlag: 98,
            effectId: 100,
            spawnTick: 0,
          };
          placedFlags++;
        }
      }
      if (placedFlags === 0) {
        this.spawnEventGoldFlagOnOpenCell();
      }
    }

    // Retail `CQuestionMarkCouponMan`: seed 1 rare `Item/QuestionMark` (`樂爆卡`) in a random box on maps with >= 10 boxes!
    if (boxCoords.length >= 10 && !/^bonus/i.test(this.mapName)) {
      const [qx, qy] = boxCoords[boxCoords.length - 1]!;
      const qc = this.cellAt(qx, qy);
      if (qc && qc.pendingDrop?.pickupFlag !== 98) {
        qc.pendingDrop = {
          id: this.nextEntityId++,
          cx: qx,
          cy: qy,
          objectName: "Item/QuestionMark",
          iconSprite: "Item/QuestionMark",
          pickupFlag: 1,
          effectId: 21,
          spawnTick: 0,
        };
      }
    }

    // Retail seasonal festival collectibles (`CXMas2004EventDlg` `Christmas00..02`, `IceCon00..02`, `ChuseokBam|Gam`):
    if (boxCoords.length >= 14 && !/^bonus/i.test(this.mapName) && this.componentMode !== 3) {
      const seasonalPool: [string, string][] = /^snow|^ice/i.test(this.mapName)
        ? [
            ["Item/Christmas00", "Item/ChristmasCandy"],
            ["Item/Christmas01", "Item/ChristmasWreeth"],
            ["Item/Christmas02", "Item/ChristmasTree"],
          ]
        : /^beach|^ocean|^patrit/i.test(this.mapName)
          ? [
              ["Item/IceCon00", "Item/IceCon00"],
              ["Item/IceCon01", "Item/IceCon01"],
              ["Item/IceCon02", "Item/IceCon02"],
            ]
          : /^forest|^village|^camp/i.test(this.mapName)
            ? [
                ["ChuseokBam", "Item/ChuseokBam"],
                ["ChuseokGam", "Item/ChuseokGam"],
                ["Item/Doll01", "Item/Doll01"],
                ["Item/Doll02", "Item/Doll02"],
                ["Item/Doll03", "Item/Doll03"],
              ]
            : [
                ["Item/Doll01", "Item/Doll01"],
                ["Item/Doll02", "Item/Doll02"],
                ["Item/Doll03", "Item/Doll03"],
              ];
      if (seasonalPool.length > 0) {
        const [sx, sy] = boxCoords[boxCoords.length - 2]!;
        const sc = this.cellAt(sx, sy);
        const pick = seasonalPool[this.rng.nextInt(seasonalPool.length)]!;
        if (sc && sc.pendingDrop?.pickupFlag !== 98) {
          sc.pendingDrop = {
            id: this.nextEntityId++,
            cx: sx,
            cy: sy,
            objectName: pick[0],
            iconSprite: pick[1],
            pickupFlag: 1,
            effectId: 99,
            spawnTick: 0,
          };
        }
      }
    }

    // Mode 2 (`定時炸彈` `CTimebombRoulette`): start the 36-tick HUD & overhead roulette spin!
    if (this.mode === 2 && this.players.length > 0) {
      this.startTimebombRoulette(START_BANNER_TICKS + 36);
    }

    if (/^bonus/i.test(this.mapName)) {
      this.sounds.push("BonusStageEffect");
      this.sounds.push("BonusStageVocal");
    } else {
      this.sounds.push("GameStart_0");
    }
  }

  private findItemSpecByName(raw: string): FieldItemSpec | undefined {
    const low = raw.toLowerCase();
    const bare = low.replace(/^item\/(item)?/, "");
    return this.itemAttr.items.find((it) => {
      const il = it.objectName.toLowerCase();
      const ib = il.replace(/^item\/(item)?/, "");
      return il === low || ib === bare || it.iconSprite.toLowerCase() === low;
    });
  }

  private clearSpawnSafeZone(cx: number, cy: number): void {
    const coords: [number, number][] = [
      [cx, cy],
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];
    for (const [x, y] of coords) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
      const c = this.cells[y * this.width + x]!;
      if (c.blockKind === 2 && !c.indestructible) {
        c.blockObjName = "";
        c.blockKind = 0;
        c.blocksWalk = false;
        c.pushable = false;
      }
    }
  }

  setInput(slot: number, input: PlayerInput): void {
    const previous = this.inputs.get(slot);
    const edges = this.pendingInputEdges.get(slot) ?? { bomb: false, active: false, slotUse: undefined };
    if (input.placeBomb && !previous?.placeBomb) edges.bomb = true;
    if (input.useActive && !previous?.useActive) edges.active = true;
    if (input.slotUse !== undefined) edges.slotUse = input.slotUse;
    this.pendingInputEdges.set(slot, edges);
    this.inputs.set(slot, { ...input, slotUse: undefined });
  }

  cellAt(cx: number, cy: number): SimCell | null {
    if (cx < 0 || cx >= this.width || cy < 0 || cy >= this.height) return null;
    return this.cells[cy * this.width + cx]!;
  }

  bombAt(cx: number, cy: number): SimBomb | undefined {
    return this.bombs.find((b) => b.thrownTicks === 0 && b.cx === cx && b.cy === cy);
  }

  isCellWalkableFor(p: SimPlayer, cx: number, cy: number): boolean {
    const c = this.cellAt(cx, cy);
    if (!c) return false;
    if (p.rideFly) {
      // Airship/UFO flies over destructible boxes and bombs, blocked only by solid static walls!
      return c.blockKind !== 1;
    }
    if (c.blocksWalk) return false;
    // Check active push-box target cells
    for (const pb of this.pushBoxes) {
      if ((pb.toCx === cx && pb.toCy === cy) || (pb.fromCx === cx && pb.fromCy === cy)) {
        return false;
      }
    }
    const b = this.bombAt(cx, cy);
    if (b) {
      return b.passThroughSlots.includes(p.slot);
    }
    return true;
  }

  /**
   * Directional walk check (`CGOTilePassable` `passPlayerDir` for `BombProof01..04`, `Line01..04`, `Tent*`, `GasRight*`).
   * Moving from `(fromCx, fromCy)` in `dir` requires exiting `from.passPlayerDir[dir]` AND entering `to.passPlayerDir[dir ^ 2]`.
   */
  canWalkStep(p: SimPlayer, fromCx: number, fromCy: number, dir: Dir4): boolean {
    const toCx = fromCx + DIR_DX[dir]!;
    const toCy = fromCy + DIR_DY[dir]!;
    if (!this.isCellWalkableFor(p, toCx, toCy)) return false;
    if (p.rideFly) return true;
    const fromCell = this.cellAt(fromCx, fromCy);
    const toCell = this.cellAt(toCx, toCy);
    if (!toCell) return false;
    const oppDir = (dir ^ 2) as Dir4;
    if (fromCell && fromCell.blockKind === 3 && !fromCell.passPlayerDir[dir]) return false;
    if (toCell.blockKind === 3 && !toCell.passPlayerDir[oppDir]) return false;
    return true;
  }

  /** Directional bomb slide/kick check (`CGOTilePassable` `passBombDir` for `Line01..04` etc.). */
  canBombStep(fromCx: number, fromCy: number, dir: Dir4, ignoreBomb?: SimBomb): boolean {
    const toCx = fromCx + DIR_DX[dir]!;
    const toCy = fromCy + DIR_DY[dir]!;
    const fromCell = this.cellAt(fromCx, fromCy);
    const toCell = this.cellAt(toCx, toCy);
    if (!toCell || toCell.blocksWalk) return false;
    const oppDir = (dir ^ 2) as Dir4;
    if (fromCell && fromCell.blockKind === 3 && !fromCell.passBombDir[dir]) return false;
    if (toCell.blockKind === 3 && !toCell.passBombDir[oppDir]) return false;
    if (this.bombs.some((o) => o !== ignoreBomb && o.thrownTicks === 0 && o.cx === toCx && o.cy === toCy)) {
      return false;
    }
    if (
      this.players.some(
        (pl) =>
          pl.state !== "dead" &&
          pl.state !== "dying" &&
          Math.floor(pl.px / CELL_PX) === toCx &&
          Math.floor(pl.py / CELL_PX) === toCy,
      )
    ) {
      return false;
    }
    return true;
  }

  /** Advance the match by exactly ONE 30ms tick. */
  step(): SimSoundEvent[] {
    this.sounds.length = 0;
    this.tick++;

    if (this.finished) {
      this.finishCooldownTicks++;
      return this.sounds;
    }

    if (this.componentMode === 2) this.updateBulaDotEffects();

    // Match countdown, HurryUp sudden death, Ambient Bat Swarm (`CGOBatGroup`), & Supply AirPlane (`CGOItemBird`)
    if (this.tick > START_BANNER_TICKS) {
      this.ticksRemaining = Math.max(0, this.ticksRemaining - 1);
      // Skip perimeter sudden-death walls on Kart circuits so racetracks remain passable!
      if (!this.hurryUp && this.ticksRemaining === HURRY_UP_TICKS) {
        this.hurryUp = true;
        this.sounds.push("HurryUp");
        // Enrage surviving Bula souls during HurryUp!
        for (const s of this.souls) {
          s.angry = true;
          s.speed = Math.max(s.speed, 4);
        }
        // Spawn retail `CGOGhost` (`Game/Ghost` -> `Game/Ghost Big`) stalker on Classic/Event maps!
        if (
          this.componentMode !== 1 &&
          this.componentMode !== 2 &&
          this.mode !== 2 &&
          !/^bonus/i.test(this.mapName) &&
          !this.ghost
        ) {
          this.spawnHurryGhost();
        }
      }
      if (this.hurryUp && this.componentMode !== 1 && this.ticksRemaining > 0 && this.ticksRemaining % 14 === 0) {
        this.stepSuddenDeathBlock();
      }
      const matchTicks = this.tick - START_BANNER_TICKS;
      if (this.batIntervalTicks > 0 && matchTicks > 0 && matchTicks % this.batIntervalTicks === 0) {
        this.batSwarmTick = this.tick;
      }
      // Spawn `Game/AirPlane1` supply drop on normal/Bula maps at ~45s and ~100s!
      if (
        this.componentMode !== 1 &&
        !this.airplane &&
        !/^bonus/i.test(this.mapName) &&
        (matchTicks === 1500 || matchTicks === 3300)
      ) {
        this.spawnSupplyAirPlane();
      }
    }

    // 1. Update crumbling & shaken boxes -> spawn ground items
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[y * this.width + x]!;
        if (c.shakeTicks > 0) c.shakeTicks--;
        if (c.crumbleTicks > 0) {
          c.crumbleTicks--;
          if (c.crumbleTicks === 0) {
            const wasBush = c.blockKind === 3;
            c.blockObjName = "";
            c.blockKind = 0;
            c.hp = 0;
            c.maxHp = 0;
            c.shakeTicks = 0;
            c.blocksWalk = false;
            c.pushable = false;
            c.hidesUnit = false;
            c.burnsInFlame = false;
            c.passPlayerDir = [true, true, true, true];
            c.passBombDir = [true, true, true, true];
            c.passFlameDir = [true, true, true, true];
            if (!wasBush && c.pendingDrop) {
              c.pendingDrop.spawnTick = this.tick;
              this.items.push(c.pendingDrop);
              c.pendingDrop = null;
            }
          }
        }
      }
    }

    // 2. Update sliding pushable boxes
    for (let i = this.pushBoxes.length - 1; i >= 0; i--) {
      const pb = this.pushBoxes[i]!;
      pb.ticksLeft--;
      if (pb.ticksLeft <= 0) {
        const dst = this.cellAt(pb.toCx, pb.toCy);
        if (dst) {
          dst.blockObjName = pb.objName;
          dst.blockKind = 2;
          dst.hp = pb.hp;
          dst.maxHp = pb.maxHp;
          dst.blocksWalk = true;
          dst.pushable = true;
          dst.indestructible = false;
          dst.pendingDrop = pb.pendingDrop
            ? { ...pb.pendingDrop, cx: pb.toCx, cy: pb.toCy }
            : null;
          dst.dropRolled = pb.dropRolled;
          // Squash any exposed item on destination cell
          for (let k = this.items.length - 1; k >= 0; k--) {
            if (this.items[k]!.cx === pb.toCx && this.items[k]!.cy === pb.toCy) {
              this.items.splice(k, 1);
            }
          }
        }
        this.pushBoxes.splice(i, 1);
      }
    }

    // 3. Update active flames & flying darts & planted hazards
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i]!;
      f.ticksLeft--;
      if (f.ticksLeft <= 0) {
        this.flames.splice(i, 1);
      }
    }
    this.updateDartsAndHazards();

    // 4. Update bombs (thrown arc, kicked slide, fuse & chain detonation)
    this.updateBombs();

    // 5. Update players (timers, movement, bomb placement, active items, item pickups, rescues/pops)
    if (this.tick > START_BANNER_TICKS) {
      this.updateTimebombRoulette();
      this.updatePlayers();
      this.updateSouls();
      this.updateHurryGhost();
      this.updateAirPlane();
    } else {
      this.updateTimebombRoulette();
      for (const p of this.players) {
        if (p.invulnTicks > 0) p.invulnTicks--;
      }
      for (const s of this.souls) {
        if (s.state !== "spawn") continue;
        s.stateTicks++;
        if (s.stateTicks === 1) {
          this.sounds.push(s.kind === "InnerSoul" ? "BulaMummyCreate" : "BulaBatCreate");
        }
        if (s.stateTicks >= this.soulActionTicks[s.kind].spawn) {
          s.state = "walk";
          s.stateTicks = 0;
        }
      }
    }
    this.updateFootprints();

    // 6. Flame vs alive bombers & Bula souls check (runs every tick while flames linger!)
    this.applyFlameHits();

    // 7. Player vs player interactions (teammate rescue, enemy bubble execution, timebomb pass)
    this.applyPlayerContacts();

    // 8. Check win / draw condition
    this.evaluateVictory();

    return this.sounds;
  }

  private stepSuddenDeathBlock(): void {
    // Spiral inward perimeter blocks during final 35s HurryUp
    const total = this.width * this.height;
    if (this.suddenDeathCursor >= total) return;
    const coord = this.spiralCoord(this.suddenDeathCursor++);
    if (!coord) return;
    const [cx, cy] = coord;
    const c = this.cellAt(cx, cy);
    if (!c) return;
    c.blockObjName = "Tile08_Box/Box01";
    c.blockKind = 1;
    c.blocksWalk = true;
    c.indestructible = true;
    c.pushable = false;
    c.crumbleTicks = 0;
    // Eliminate any player crushed under sudden-death wall
    for (const p of this.players) {
      if (p.state === "dead" || p.state === "dying") continue;
      const pcx = Math.floor(p.px / CELL_PX);
      const pcy = Math.floor(p.py / CELL_PX);
      if (pcx === cx && pcy === cy) {
        this.killPlayer(p, -1);
      }
    }
  }

  private spiralCoord(n: number): [number, number] | null {
    let left = 0;
    let right = this.width - 1;
    let top = 0;
    let bottom = this.height - 1;
    let idx = 0;
    while (left <= right && top <= bottom) {
      for (let x = left; x <= right; x++) if (idx++ === n) return [x, top];
      top++;
      for (let y = top; y <= bottom; y++) if (idx++ === n) return [right, y];
      right--;
      if (top <= bottom) {
        for (let x = right; x >= left; x--) if (idx++ === n) return [x, bottom];
        bottom--;
      }
      if (left <= right) {
        for (let y = bottom; y >= top; y--) if (idx++ === n) return [left, y];
        left++;
      }
    }
    return null;
  }

  private updateBombs(): void {
    const toDetonate: SimBomb[] = [];

    for (const b of this.bombs) {
      // Prune passThroughSlots once bomber leaves the cell
      if (b.passThroughSlots.length > 0) {
        b.passThroughSlots = b.passThroughSlots.filter((slot) => {
          const pl = this.players.find((p) => p.slot === slot);
          if (!pl || pl.state === "dead") return false;
          const pcx = Math.floor(pl.px / CELL_PX);
          const pcy = Math.floor(pl.py / CELL_PX);
          return pcx === b.cx && pcy === b.cy;
        });
      }

      // Thrown bomb parabolic arc
      if (b.thrownTicks > 0) {
        b.thrownTicks--;
        const t = 1 - b.thrownTicks / b.thrownTotalTicks;
        const destPx = b.throwDestCx * CELL_PX + 20;
        const destPy = b.throwDestCy * CELL_PX + 20;
        b.px = b.throwStartX + (destPx - b.throwStartX) * t;
        b.py = b.throwStartY + (destPy - b.throwStartY) * t;
        if (b.thrownTicks === 0) {
          // If landing cell is blocked, bounce 1 cell further (wrapping around map!)
          let lx = ((b.throwDestCx % this.width) + this.width) % this.width;
          let ly = ((b.throwDestCy % this.height) + this.height) % this.height;
          for (let tries = 0; tries < 15; tries++) {
            const lc = this.cellAt(lx, ly);
            const occ = this.bombAt(lx, ly);
            if (lc && !lc.blocksWalk && !occ) break;
            const dx = Math.sign(destPx - b.throwStartX) || 1;
            const dy = Math.sign(destPy - b.throwStartY);
            lx = (lx + dx + this.width) % this.width;
            ly = (ly + dy + this.height) % this.height;
          }
          b.cx = lx;
          b.cy = ly;
          b.px = lx * CELL_PX + 20;
          b.py = ly * CELL_PX + 20;
          if (this.cellAt(lx, ly)?.bombPinHazard) toDetonate.push(b);
        }
        continue;
      }

      // Kicked bomb sliding at 20 px/tick
      if (b.slidingDir !== -1) {
        const dx = DIR_DX[b.slidingDir]!;
        const dy = DIR_DY[b.slidingDir]!;
        const nextPx = b.px + dx * BOMB_KICK_SPEED;
        const nextPy = b.py + dy * BOMB_KICK_SPEED;
        const lookCx = Math.floor((nextPx + dx * 19) / CELL_PX);
        const lookCy = Math.floor((nextPy + dy * 19) / CELL_PX);
        let blocked = false;
        if (lookCx !== b.cx || lookCy !== b.cy) {
          if (!this.canBombStep(b.cx, b.cy, b.slidingDir, b)) {
            blocked = true;
          }
        }
        if (blocked) {
          // sub_4084A1 reads the destination pillar flag using the travel
          // direction (not its opposite); sub_408EFF then detonates the bomb.
          const target = this.cellAt(b.cx + dx, b.cy + dy);
          if (target?.blockEdgePinDir[b.slidingDir]) toDetonate.push(b);
          b.slidingDir = -1;
          b.px = b.cx * CELL_PX + 20;
          b.py = b.cy * CELL_PX + 20;
        } else {
          b.px = nextPx;
          b.py = nextPy;
          b.cx = Math.floor(b.px / CELL_PX);
          b.cy = Math.floor(b.py / CELL_PX);
        }
      }
      // Retail CGOTileGround::sub_41EFB3 is called from the bomber update,
      // not CGOBomb::sub_408EFF: an idle bomb is not carried by the belt.

      if (this.cellAt(b.cx, b.cy)?.bombPinHazard) toDetonate.push(b);
      if (b.style !== "remote") {
        b.fuseTicks--;
        if (b.fuseTicks <= 0) {
          toDetonate.push(b);
        }
      }
    }

    if (toDetonate.length > 0) {
      this.detonateChain(toDetonate);
    }
  }

  private detonateChain(initial: SimBomb[]): void {
    const queue = [...initial];
    const explodedIds = new Set<number>();
    let playedSound = false;

    while (queue.length > 0) {
      const b = queue.shift()!;
      if (explodedIds.has(b.id)) continue;
      explodedIds.add(b.id);

      const idx = this.bombs.indexOf(b);
      if (idx >= 0) this.bombs.splice(idx, 1);

      const owner = this.players.find((p) => p.slot === b.ownerSlot);
      if (owner && owner.bombsPlaced > 0) owner.bombsPlaced--;

      if (!playedSound) {
        this.sounds.push("BombExplode");
        playedSound = true;
      }

      const isBlind = b.style === "blind";
      this.spawnFlameCell(b.cx, b.cy, "C", b.ownerSlot, queue, explodedIds, isBlind);

      const dirs: { dir: Dir4; mid: "L" | "U" | "R" | "D"; end: "LE" | "UE" | "RE" | "DE" }[] = [
        { dir: 0, mid: "L", end: "LE" },
        { dir: 1, mid: "U", end: "UE" },
        { dir: 2, mid: "R", end: "RE" },
        { dir: 3, mid: "D", end: "DE" },
      ];

      const bCell = this.cellAt(b.cx, b.cy);
      for (const { dir, mid, end } of dirs) {
        // If bomb was placed inside a directional shelter (`BombProof`, `Tent`, etc.), respect exit face!
        if (bCell && bCell.blockKind === 3 && !bCell.passFlameDir[dir]) continue;
        const dx = DIR_DX[dir]!;
        const dy = DIR_DY[dir]!;
        const oppDir = (dir ^ 2) as Dir4;
        for (let step = 1; step <= b.power; step++) {
          const tx = b.cx + dx * step;
          const ty = b.cy + dy * step;
          const cell = this.cellAt(tx, ty);
          if (!cell) break;

          // Solid static wall or armored entry face (`BombProof01..04`) stops flame BEFORE entering cell!
          if (cell.blockKind === 1 || (cell.blockKind === 3 && !cell.passFlameDir[oppDir])) break;

          // Destructible or multi-HP box (`CGOTileFixedBox` / `CGOTileMovableBox`)
          if (cell.blockKind === 2) {
            let pierced = false;
            if (!cell.indestructible && cell.crumbleTicks === 0) {
              if (cell.hp > 1) {
                cell.hp--;
                cell.shakeTicks = 14;
              } else {
                cell.hp = 0;
                cell.crumbleTicks = BOX_CRUMBLE_TICKS;
                if (!cell.dropRolled) {
                  cell.pendingDrop = cell.pendingDrop ?? this.rollItemDrop(tx, ty);
                  cell.dropRolled = true;
                }
                this.sounds.push("BlockDown");
                if (b.pierce) pierced = true;
              }
            }
            if (!pierced) break;
          }

          // Bush (`kind === 3 && burnsInFlame`) burns away on flame hit; permanent `i5 != 0` shelters do not!
          if (cell.blockKind === 3 && cell.burnsInFlame && cell.crumbleTicks === 0) {
            cell.crumbleTicks = 10;
          }

          const blockedExit = cell.blockKind === 3 && !cell.passFlameDir[dir];
          const part = step === b.power || blockedExit ? end : mid;
          this.spawnFlameCell(tx, ty, part, b.ownerSlot, queue, explodedIds, isBlind);
          if (blockedExit) break;
        }
      }
    }
  }

  private spawnFlameCell(
    cx: number,
    cy: number,
    part: SimFlame["part"],
    ownerSlot: number,
    chainQueue: SimBomb[],
    explodedIds: Set<number>,
    blind = false,
  ): void {
    // Replace older flame on same cell if center or longer
    const existing = this.flames.find((f) => f.cx === cx && f.cy === cy);
    if (existing) {
      existing.ticksLeft = FLAME_TICKS;
      if (part === "C") existing.part = "C";
      if (!blind) existing.blind = false;
    } else {
      this.flames.push({ cx, cy, part, ticksLeft: FLAME_TICKS, ownerSlot, blind });
    }

    // Vaporize ground items & planted hazards (except items spawned this very tick)
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      if (it.cx === cx && it.cy === cy && it.spawnTick < this.tick) {
        this.items.splice(i, 1);
        this.sounds.push("ItemPop");
      }
    }
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      if (this.hazards[i]!.cx === cx && this.hazards[i]!.cy === cy) {
        this.hazards.splice(i, 1);
      }
    }

    // Trigger immediate chain explosion of any bomb on (cx, cy)
    for (const other of this.bombs) {
      if (other.thrownTicks === 0 && other.cx === cx && other.cy === cy && !explodedIds.has(other.id)) {
        chainQueue.push(other);
      }
    }
  }

  private rollItemDrop(cx: number, cy: number): SimGroundItem | null {
    if (this.rng.nextInt(100) >= this.mapDropRatePct) return null;
    if (this.mapDropPool.length === 0 || this.mapTotalDropWeight <= 0) return null;
    let pick = this.rng.nextInt(this.mapTotalDropWeight);
    let chosen: FieldItemSpec = this.mapDropPool[0]!.spec;
    for (const entry of this.mapDropPool) {
      if (pick < entry.weight) {
        chosen = entry.spec;
        break;
      }
      pick -= entry.weight;
    }
    return {
      id: this.nextEntityId++,
      cx,
      cy,
      objectName: chosen.objectName,
      iconSprite: chosen.iconSprite,
      pickupFlag: chosen.pickupFlag,
      effectId: chosen.effectId,
      activeSlotFlag: chosen.activeSlotFlag,
      spawnTick: this.tick,
    };
  }

  private updateDartsAndHazards(): void {
    const toDetonate: SimBomb[] = [];
    for (let i = this.darts.length - 1; i >= 0; i--) {
      const d = this.darts[i]!;
      d.px += DIR_DX[d.dir]! * 16;
      d.py += DIR_DY[d.dir]! * 16;
      const cx = Math.floor(d.px / CELL_PX);
      const cy = Math.floor(d.py / CELL_PX);
      const cell = this.cellAt(cx, cy);
      if (!cell || cell.blocksWalk) {
        this.darts.splice(i, 1);
        continue;
      }
      const hitBomb = this.bombAt(cx, cy);
      if (hitBomb) {
        toDetonate.push(hitBomb);
        this.darts.splice(i, 1);
        continue;
      }
      const hitTrapped = this.players.find(
        (pl) =>
          pl.slot !== d.ownerSlot &&
          pl.state === "trapped" &&
          Math.floor(pl.px / CELL_PX) === cx &&
          Math.floor(pl.py / CELL_PX) === cy,
      );
      if (hitTrapped) {
        const shooter = this.players.find((pl) => pl.slot === d.ownerSlot);
        if (shooter && shooter.team === hitTrapped.team) {
          hitTrapped.state = "alive";
          hitTrapped.stateTicks = 0;
          hitTrapped.invulnTicks = 30;
          hitTrapped.trappedBySlot = -1;
          shooter.saves++;
          this.sounds.push("Revive");
        } else {
          this.killPlayer(hitTrapped, d.ownerSlot);
        }
        this.darts.splice(i, 1);
      }
    }
    if (toDetonate.length > 0) this.detonateChain(toDetonate);

    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i]!;
      if (h.armTicks > 0) {
        h.armTicks--;
        continue;
      }
      if (h.kind === "pin") {
        // Thumbtack (`Item/PushpinGround`): pops any trapped victim OR dismounts a mounted victim!
        const trappedVictim = this.players.find(
          (pl) =>
            pl.state === "trapped" &&
            Math.floor(pl.px / CELL_PX) === h.cx &&
            Math.floor(pl.py / CELL_PX) === h.cy,
        );
        if (trappedVictim) {
          this.killPlayer(trappedVictim, h.ownerSlot);
          this.hazards.splice(i, 1);
          continue;
        }
        const mountedVictim = this.players.find(
          (pl) =>
            pl.state === "alive" &&
            !pl.rideFly &&
            pl.rideId > 0 &&
            Math.floor(pl.px / CELL_PX) === h.cx &&
            Math.floor(pl.py / CELL_PX) === h.cy,
        );
        if (mountedVictim) {
          mountedVictim.rideId = 0;
          mountedVictim.rideSpeed = 0;
          mountedVictim.rideFly = false;
          mountedVictim.hopInvulnTicks = 24;
          this.sounds.push("ItemPop");
          this.hazards.splice(i, 1);
        }
        continue;
      }

      const victim = this.players.find(
        (pl) =>
          pl.state === "alive" &&
          !pl.rideFly &&
          Math.floor(pl.px / CELL_PX) === h.cx &&
          Math.floor(pl.py / CELL_PX) === h.cy,
      );
      if (!victim) continue;
      if (h.kind === "banana") {
        victim.slipDir = victim.facing;
        victim.slipTicks = 16;
        this.sounds.push("Banana");
        this.hazards.splice(i, 1);
      } else if (h.kind === "gum") {
        victim.glueTicks = 95;
        this.sounds.push("ItemPop");
        this.hazards.splice(i, 1);
      } else if (h.kind === "trap" && victim.shieldTicks === 0 && victim.invulnTicks === 0) {
        if (victim.rideId > 0) {
          victim.rideId = 0;
          victim.rideSpeed = 0;
          victim.rideFly = false;
          victim.hopInvulnTicks = 24;
          this.sounds.push("ItemPop");
        } else {
          victim.state = "trapped";
          victim.stateTicks = 0;
          victim.trappedBySlot = h.ownerSlot;
          this.sounds.push("LockedIn");
        }
        this.hazards.splice(i, 1);
      }
    }
  }

  private updatePlayers(): void {
    for (const p of this.players) {
      p.stateTicks++;
      if (p.shieldTicks > 0) p.shieldTicks--;
      if (p.invulnTicks > 0) p.invulnTicks--;
      if (p.hopInvulnTicks > 0) p.hopInvulnTicks--;
      if (p.curseTicks > 0) {
        p.curseTicks--;
        if (p.curseTicks === 0) p.curseKind = 0;
      }
      if ((p.goggleTicks ?? 0) > 0) p.goggleTicks!--;
      if ((p.camoTicks ?? 0) > 0) p.camoTicks!--;
      if ((p.wetTicks ?? 0) > 0) p.wetTicks!--;
      if (p.boostTicks > 0) p.boostTicks--;
      if (p.blindTicks > 0) p.blindTicks--;
      if (p.radarTicks > 0) p.radarTicks--;
      if (p.glueTicks > 0) p.glueTicks--;
      if (p.throwTicks > 0) p.throwTicks--;
      if (p.drillTicks > 0) p.drillTicks--;
      if (p.jumpTicks > 0) p.jumpTicks--;
      if (p.shootTicks > 0) p.shootTicks--;
      if (p.hedgehogSpinTicks > 0) p.hedgehogSpinTicks--;
      if (p.hedgehogStruggleTicks > 0) p.hedgehogStruggleTicks--;
      if (p.portalCooldownTicks > 0) p.portalCooldownTicks--;
      if ((p.questionEffTicks ?? 0) > 0) p.questionEffTicks!--;
      if ((p.niceTicks ?? 0) > 0) p.niceTicks!--;
      if ((p.comboWindowTicks ?? 0) > 0) {
        p.comboWindowTicks!--;
        if (p.comboWindowTicks === 0) p.comboKills = 0;
      }
      // `扳手 Spanner` (`cat=1`, `avatarCode=74`): passive Kart fuel regen & mount shock-absorber!
      if (p.hasSpanner && this.componentMode === 1 && (p.kartFuel ?? 100) < 100 && this.tick % 10 === 0) {
        p.kartFuel = Math.min(100, (p.kartFuel ?? 100) + 1);
      }

      // Timebomb mode countdown
      if (this.mode === 2 && p.hasTimebomb && p.state === "alive") {
        p.timebombTicks--;
        if (p.timebombTicks === 30) {
          this.sounds.push("TimebombCaution");
        } else if (p.timebombTicks <= 0) {
          p.hasTimebomb = false;
          this.sounds.push("TimebombExplode");
          this.killPlayer(p, -1);
          // Spin `CTimebombRoulette` to choose next Timebomb carrier if match continues!
          const aliveOthers = this.players.filter((o) => o !== p && o.state === "alive");
          if (aliveOthers.length > 1) {
            this.startTimebombRoulette(36);
          }
          continue;
        }
      }

      if (p.state === "dead") {
        this.pendingInputEdges.delete(p.slot);
        this.prevPlaceBomb.delete(p.slot);
        this.prevUseActive.delete(p.slot);
        // Mode 4 (`CSurvivalComponent` 生死戰): revive after 90 ticks (2.7s) unless Hurry-Up No-Revive is active!
        if (this.mode === 4) {
          if (this.hurryUp) {
            p.noRevive = true;
          } else if (!p.noRevive && p.stateTicks >= 90) {
            if (p.reviveCx !== undefined && p.reviveCy !== undefined) {
              p.px = p.reviveCx * CELL_PX + 20;
              p.py = p.reviveCy * CELL_PX + 20;
            }
            p.reviveCx = undefined;
            p.reviveCy = undefined;
            p.state = "alive";
            p.stateTicks = 0;
            p.invulnTicks = 65;
            this.sounds.push("Revive");
            continue;
          }
        }
        // Non-respawn modes (`0..3`) or Hurry-Up No-Revive: after angel soul finishes rising (`stateTicks >= 64`),
        // dead players become translucent floating Ghosts (`Character/C0x-Ghost*`)!
        if ((this.mode !== 4 || p.noRevive) && this.players.length >= 2) {
          if (p.stateTicks === 64) {
            this.sounds.push("GhostTrans");
          }
          if (p.stateTicks >= 64) {
            const gInp = this.inputs.get(p.slot);
            if (gInp && gInp.dir !== -1) {
              p.facing = gInp.dir;
              p.moving = true;
              p.walkTicks++;
              p.px = Math.max(20, Math.min(this.width * CELL_PX - 20, p.px + DIR_DX[gInp.dir]! * 4));
              p.py = Math.max(20, Math.min(this.height * CELL_PX - 20, p.py + DIR_DY[gInp.dir]! * 4));
            } else {
              p.moving = false;
            }
          }
        }
        continue;
      }

      if (p.state === "dying") {
        this.pendingInputEdges.delete(p.slot);
        this.prevPlaceBomb.delete(p.slot);
        this.prevUseActive.delete(p.slot);
        if (p.stateTicks >= 28) {
          p.state = "dead";
          p.stateTicks = 0;
          if (this.mode === 4) {
            if (this.hurryUp) {
              p.noRevive = true;
            } else {
              const [rcx, rcy] = this.pickSafeRespawnCell(p);
              p.reviveCx = rcx;
              p.reviveCy = rcy;
            }
          }
        }
        continue;
      }

      const inp = this.inputs.get(p.slot) ?? { dir: -1, placeBomb: false, useActive: false };
      const pending = this.pendingInputEdges.get(p.slot);
      this.pendingInputEdges.delete(p.slot);
      const bombEdge = Boolean(pending?.bomb) || (inp.placeBomb && !this.prevPlaceBomb.has(p.slot));
      if (inp.placeBomb) this.prevPlaceBomb.add(p.slot);
      else this.prevPlaceBomb.delete(p.slot);

      const useEdge = Boolean(pending?.active) || (inp.useActive && !this.prevUseActive.has(p.slot));
      if (inp.useActive) this.prevUseActive.add(p.slot);
      else this.prevUseActive.delete(p.slot);

      // Item slot is an edge, not a held command: consume it once.
      if (useEdge || pending?.slotUse !== undefined) {
        this.tryUseActiveItem(p, pending?.slotUse);
      }

      // Trapped inside water bubble!
      if (p.state === "trapped") {
        if (this.mode === 3 && p.stateTicks === 90) {
          // Hedgehog mode: transform into Hedgehog!
          p.state = "hedgehog";
          p.stateTicks = 0;
          p.hedgehogSuper = false;
          this.sounds.push("HedgehogRebirth");
          continue;
        }
        const popLimit = p.hasOxygen ? BUBBLE_POP_TICKS * 2 : BUBBLE_POP_TICKS;
        if (p.stateTicks >= popLimit) {
          this.killPlayer(p, p.trappedBySlot);
          continue;
        }
        // Trapped bomber crawls at 1 px/tick!
        if (inp.dir !== -1) {
          this.moveBomber(p, inp.dir, 1);
        } else {
          p.moving = false;
        }
        const tCx = Math.floor(p.px / CELL_PX);
        const tCy = Math.floor(p.py / CELL_PX);
        const tCell = this.cellAt(tCx, tCy);
        if (
          tCell?.isPinHazard &&
          Math.abs(p.px - (tCx * CELL_PX + 20)) <= 12 &&
          Math.abs(p.py - (tCy * CELL_PX + 20)) <= 12
        ) {
          this.killPlayer(p, p.trappedBySlot);
        }
        continue;
      }

      if (p.state === "hedgehog") {
        if (p.hedgehogSuper && (bombEdge || useEdge) && p.hedgehogSpinTicks === 0) {
          p.hedgehogSpinTicks = 18;
          this.sounds.push("HedgehogStruggle");
        } else if (!p.hedgehogSuper && bombEdge) {
          p.stateTicks += 24;
          p.hedgehogStruggleTicks = 8;
          this.sounds.push("HedgehogStruggle");
        }
        if (p.stateTicks >= 220) {
          p.state = "alive";
          p.stateTicks = 0;
          p.hedgehogSuper = false;
          p.hedgehogSpinTicks = 0;
          p.invulnTicks = 30;
          this.sounds.push("Release");
          continue;
        }
        if (inp.dir !== -1) {
          this.moveBomber(p, inp.dir, p.hedgehogSpinTicks > 0 ? 9 : 6);
        } else {
          p.moving = false;
        }
        continue;
      }

      // Alive bomber!
      const curseKind = p.curseTicks > 0 ? (p.curseKind ?? 12) : 0;
      let moveDir: Dir4 | -1 = inp.dir;
      if (moveDir !== -1 && (curseKind === 10 || curseKind === 12)) {
        // MoonWalk (`eff=10`) & GreenDevil (`eff=12`) reverse controls!
        moveDir = ((moveDir + 2) & 3) as Dir4;
      }

      const footCx = Math.floor(p.px / CELL_PX);
      const footCy = Math.floor(p.py / CELL_PX);
      const footCell = this.cellAt(footCx, footCy);
      const isKartMount = p.rideId === 9 || p.rideId === 10;
      const outOfFuel = this.componentMode === 1 && (p.kartFuel ?? 100) <= 0;
      const offRoad = this.componentMode === 1 && isKartMount && Boolean(footCell && !footCell.isTrackRoad);

      const baseEffSpeed =
        p.rideId > 0
          ? isKartMount
            ? outOfFuel
              ? 3
              : p.boostTicks > 0
                ? 11
                : offRoad
                  ? Math.max(4, p.rideSpeed - 3)
                  : p.rideSpeed
            : p.rideSpeed
          : p.boostTicks > 0 || curseKind === 8
            ? p.speedMax + 1
            : curseKind === 9
              ? 2
              : curseKind === 12
                ? Math.max(3, p.speed - 1)
                : p.speed;
      const effSpeed = p.glueTicks > 0 && !p.rideFly ? 2 : baseEffSpeed;

      if (p.slipTicks > 0 && p.slipDir !== -1) {
        // Banana peel OR ice momentum glide!
        p.slipTicks--;
        this.moveBomber(p, p.slipDir, Math.max(effSpeed, 7));
        if (p.slipTicks === 0) p.slipDir = -1;
      } else if (moveDir !== -1) {
        this.moveBomber(p, moveDir, effSpeed);
        if (footCell?.isIce && !p.hasIceSkate && !p.rideFly) {
          p.slipDir = moveDir;
          p.slipTicks = 5;
        }
      } else {
        p.moving = false;
        p.pushChargeDir = -1;
        p.pushChargeTicks = 0;
      }
      p.offRoadSand = Boolean(offRoad && p.moving);

      // Kart fuel drain & `GasRight00/01` pit-stop refueling (`CKartComponent`)!
      if (this.componentMode === 1) {
        const curCell = this.cellAt(Math.floor(p.px / CELL_PX), Math.floor(p.py / CELL_PX));
        if (curCell?.isPitStop && (p.kartFuel ?? 100) < 100) {
          p.kartFuel = Math.min(100, (p.kartFuel ?? 0) + 2.5);
          p.kartLowFuelWarned = false;
          if (this.tick % 12 === 0) this.sounds.push("Refuel");
        } else if (p.moving && isKartMount) {
          p.kartFuel = Math.max(0, (p.kartFuel ?? 100) - (p.boostTicks > 0 ? 0.09 : 0.04));
          if ((p.kartFuel ?? 100) <= 22 && !p.kartLowFuelWarned) {
            p.kartLowFuelWarned = true;
            this.sounds.push("FuelWarning");
          }
        }
        this.updateKartProgress(p);
      }

      // `CBulaComponent`: contact with the 3 x 2-per-tile dot grid.
      if (this.componentMode === 2 && !p.rideFly) {
        this.updateBulaCellStep(p);
      }

      // Shore / sand OR post-bubble wet footprints (`Game/Footprint00..03` -> `Game/Footprint_Water_*`)!
      if (p.moving && !p.rideFly && p.rideId === 0) {
        const curCx = Math.floor(p.px / CELL_PX);
        const curCy = Math.floor(p.py / CELL_PX);
        const curCell = this.cellAt(curCx, curCy);
        if ((curCell?.hasFootprints || (p.wetTicks ?? 0) > 0) && this.tick - (p.lastFootprintTick ?? -999) >= 8) {
          p.lastFootprintTick = this.tick;
          const alt: 0 | 1 = p.footprintAlt === 1 ? 0 : 1;
          p.footprintAlt = alt;
          this.footprints.push({
            id: this.nextEntityId++,
            px: p.px,
            py: p.py + 8,
            dir: p.facing,
            alt,
            ticksLeft: 66,
          });
        }
      }

      // Ground spike hazard (`PinGround01` / `PinTile01`) dismounts ground mounts!
      {
        const curCx = Math.floor(p.px / CELL_PX);
        const curCy = Math.floor(p.py / CELL_PX);
        const curCell = this.cellAt(curCx, curCy);
        if (
          curCell?.isPinHazard &&
          Math.abs(p.px - (curCx * CELL_PX + 20)) <= 12 &&
          Math.abs(p.py - (curCy * CELL_PX + 20)) <= 12
        ) {
          this.applyPinPoke(p);
        }
      }

      // CGOTileGround::sub_41EFB3 aligns toward the tile anchor first,
      // then follows its separate output direction on subsequent updates.
      const beltCx = Math.floor(p.px / CELL_PX);
      const beltCy = Math.floor(p.py / CELL_PX);
      const belt = this.cellAt(beltCx, beltCy);
      if (!p.rideFly && belt && belt.conveyorDir !== -1 && belt.conveyorSpeed > 0) {
        const speed = belt.conveyorSpeed;
        const mask = belt.conveyorAlignMask;
        const centerX = beltCx * CELL_PX + 20;
        const centerY = beltCy * CELL_PX + 20;
        let remaining = speed;
        for (const [dir, distance] of [
          [0, p.px - centerX], [1, p.py - centerY],
          [2, centerX - p.px], [3, centerY - p.py],
        ] as const) {
          if ((mask & (1 << dir)) && distance > 0 && remaining > 0) {
            const oldX = p.px, oldY = p.py;
            this.moveBomber(p, dir, Math.min(remaining, distance), true);
            remaining -= Math.abs(p.px - oldX) + Math.abs(p.py - oldY);
          }
        }
        if (remaining === speed) this.moveBomber(p, belt.conveyorDir, speed, true);
      }

      // Bidirectional Warp / LapTile portals (`Map/Village00` etc.)
      if (p.portalCooldownTicks === 0) {
        const curCx = Math.floor(p.px / CELL_PX);
        const curCy = Math.floor(p.py / CELL_PX);
        const dest = this.portals.get(`${curCx},${curCy}`);
        if (dest) {
          const [dx, dy] = dest;
          if (Math.abs(p.px - (curCx * CELL_PX + 20)) <= 10 && Math.abs(p.py - (curCy * CELL_PX + 20)) <= 10) {
            p.px = dx * CELL_PX + 20;
            p.py = dy * CELL_PX + 20;
            p.portalCooldownTicks = 28;
          }
        }
      }

      // Bomb placement OR Throw (Punch)
      // Skeleton0 (`eff=8`) & GreenDevil (`eff=12`) trigger involuntary auto-bombs; Skeleton1 (`eff=9`) & MoonWalk (`eff=10`) do not!
      const autoBombCurse = curseKind === 8 || curseKind === 12;
      const wantBomb = bombEdge || (autoBombCurse && this.tick % 24 === 0);
      if (wantBomb) {
        this.tryPlaceOrThrowBomb(p);
      }

      // Ground item pickup (when not flying on UFO!)
      if (!p.rideFly) {
        const pcx = Math.floor(p.px / CELL_PX);
        const pcy = Math.floor(p.py / CELL_PX);
        for (let i = this.items.length - 1; i >= 0; i--) {
          const it = this.items[i]!;
          if (it.cx === pcx && it.cy === pcy) {
            this.applyItemPickup(p, it);
            this.items.splice(i, 1);
          }
        }
      }
    }
    if (this.componentMode === 1) {
      this.refreshKartRankings();
    }
  }

  private moveBomber(p: SimPlayer, dir: Dir4, speedPx: number, forced = false): void {
    if (!forced) {
      p.facing = dir;
      p.moving = true;
      p.walkTicks++;
    }

    const dx = DIR_DX[dir]!;
    const dy = DIR_DY[dir]!;
    const curCx = Math.floor(p.px / CELL_PX);
    const curCy = Math.floor(p.py / CELL_PX);
    const centerPx = curCx * CELL_PX + 20;
    const centerPy = curCy * CELL_PX + 20;

    let nx = p.px + dx * speedPx;
    let ny = p.py + dy * speedPx;

    // Clamp to outer map pixel bounds (20 .. width*40-20)
    const minX = 20;
    const maxX = this.width * CELL_PX - 20;
    const minY = 20;
    const maxY = this.height * CELL_PX - 20;
    if (nx < minX) nx = minX;
    if (nx > maxX) nx = maxX;
    if (ny < minY) ny = minY;
    if (ny > maxY) ny = maxY;

    // Check if crossing past current cell center toward neighbor cell (curCx + dx, curCy + dy)
    const crossingIntoNeighbor =
      (dx < 0 && nx < centerPx) ||
      (dx > 0 && nx > centerPx) ||
      (dy < 0 && ny < centerPy) ||
      (dy > 0 && ny > centerPy);

    const adjCx = curCx + dx;
    const adjCy = curCy + dy;

    if (crossingIntoNeighbor && !this.canWalkStep(p, curCx, curCy, dir)) {
      // Blocked ahead! Check:
      // (0) Directional spike wall (`PinPillar01..05` `blockEdgePinDir`) pops water bubbles & ground mounts!
      const adjCell = this.cellAt(adjCx, adjCy);
      if (adjCell && adjCell.blockEdgePinDir[(dir ^ 2) as Dir4]) {
        if (p.state === "trapped") {
          this.killPlayer(p, p.trappedBySlot);
          return;
        }
        this.applyPinPoke(p);
      }

      // (a) Kickable stationary bomb (`hasKick`)
      if (!forced && p.state === "alive" && p.hasKick && !p.rideFly) {
        const b = this.bombAt(adjCx, adjCy);
        if (b && b.slidingDir === -1 && !b.passThroughSlots.includes(p.slot)) {
          if (this.canBombStep(adjCx, adjCy, dir, b)) {
            b.slidingDir = dir;
          } else if (this.cellAt(adjCx + dx, adjCy + dy)?.blockEdgePinDir[dir]) {
            // Kicking a stationary bomb directly against a spike (sub_48D43C).
            this.detonateChain([b]);
          }
        }
      }

      // (b) Pushable movable box (`CGOTileMovableBox`, 10 ticks push charge)
      if (
        !forced &&
        p.state === "alive" &&
        !p.rideFly &&
        adjCell &&
        adjCell.blockKind === 2 &&
        adjCell.pushable &&
        adjCell.crumbleTicks === 0
      ) {
        if (p.pushChargeDir === dir) {
          p.pushChargeTicks++;
          if (p.pushChargeTicks >= 10) {
            p.pushChargeTicks = 0;
            this.tryStartPushBox(adjCx, adjCy, dir);
          }
        } else {
          p.pushChargeDir = dir;
          p.pushChargeTicks = 1;
        }
      } else {
        p.pushChargeDir = -1;
        p.pushChargeTicks = 0;
      }

      // (c) Retail 24px perpendicular Corner-Slide!
      if (dx !== 0) {
        nx = centerPx;
        const offY = p.py - centerPy;
        if (Math.abs(offY) > 0 && Math.abs(offY) <= 24) {
          const slideSign = offY < 0 ? -1 : 1;
          const perpDir: Dir4 = slideSign < 0 ? 1 : 3;
          if (this.canWalkStep(p, curCx, curCy, perpDir) && this.canWalkStep(p, curCx, curCy + slideSign, dir)) {
            ny = p.py + slideSign * speedPx;
          }
        }
      } else {
        ny = centerPy;
        const offX = p.px - centerPx;
        if (Math.abs(offX) > 0 && Math.abs(offX) <= 24) {
          const slideSign = offX < 0 ? -1 : 1;
          const perpDir: Dir4 = slideSign < 0 ? 0 : 2;
          if (this.canWalkStep(p, curCx, curCy, perpDir) && this.canWalkStep(p, curCx + slideSign, curCy, dir)) {
            nx = p.px + slideSign * speedPx;
          }
        }
      }
    } else if (!forced) {
      p.pushChargeDir = -1;
      p.pushChargeTicks = 0;
      // Gently center along perpendicular axis when walking down an open corridor!
      if (dx !== 0) {
        const diffY = centerPy - p.py;
        if (Math.abs(diffY) <= speedPx) ny = centerPy;
        else ny = p.py + Math.sign(diffY) * Math.min(speedPx, Math.abs(diffY));
      } else if (dy !== 0) {
        const diffX = centerPx - p.px;
        if (Math.abs(diffX) <= speedPx) nx = centerPx;
        else nx = p.px + Math.sign(diffX) * Math.min(speedPx, Math.abs(diffX));
      }
    }

    p.px = nx;
    p.py = ny;
  }

  private tryStartPushBox(boxCx: number, boxCy: number, dir: Dir4): void {
    const toCx = boxCx + DIR_DX[dir]!;
    const toCy = boxCy + DIR_DY[dir]!;
    const src = this.cellAt(boxCx, boxCy);
    const dst = this.cellAt(toCx, toCy);
    if (!src || !dst || dst.blocksWalk || dst.blockKind !== 0) return;
    if (this.pushBoxes.some(pb => (pb.fromCx === toCx && pb.fromCy === toCy) || (pb.toCx === toCx && pb.toCy === toCy))) return;
    if (this.bombAt(toCx, toCy)) return;
    if (
      this.players.some(
        (pl) =>
          pl.state !== "dead" &&
          Math.floor(pl.px / CELL_PX) === toCx &&
          Math.floor(pl.py / CELL_PX) === toCy,
      )
    ) {
      return;
    }
    const objName = src.blockObjName;
    const savedHp = src.hp;
    const savedMaxHp = src.maxHp;
    const savedDrop = src.pendingDrop;
    const savedDropRolled = src.dropRolled;
    src.dropRolled = false;
    src.blockObjName = "";
    src.blockKind = 0;
    src.hp = 0;
    src.maxHp = 0;
    src.shakeTicks = 0;
    src.blocksWalk = false;
    src.pushable = false;
    src.pendingDrop = null;
    this.pushBoxes.push({
      fromCx: boxCx,
      fromCy: boxCy,
      toCx,
      toCy,
      dir,
      ticksLeft: 10,
      totalTicks: 10,
      objName,
      hp: savedHp,
      maxHp: savedMaxHp,
      pendingDrop: savedDrop,
      dropRolled: savedDropRolled,
    });
    // The retail move packet removes an exposed item at the destination as
    // soon as the destination is reserved (sub_48BAB4).
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.cx === toCx && this.items[i]!.cy === toCy) this.items.splice(i, 1);
    }
  }

  private tryPlaceOrThrowBomb(p: SimPlayer): void {
    const cx = Math.floor(p.px / CELL_PX);
    const cy = Math.floor(p.py / CELL_PX);
    const existing = this.bombAt(cx, cy);

    // `Ship/Tank` (`rideId === 11`): fires cannon water bomb 3 cells ahead!
    if (p.rideId === 11 && p.bombsPlaced < p.bombsMax) {
      p.bombsPlaced++;
      p.shootTicks = 12;
      this.bombs.push({
        id: this.nextEntityId++,
        ownerSlot: p.slot,
        power: p.boostTicks > 0 ? p.powerMax : p.power,
        pierce: p.hasPierceBomb,
        style: p.hasRemoteBomb ? "remote" : p.blindTicks > 0 ? "blind" : "normal",
        cx,
        cy,
        px: cx * CELL_PX + 20,
        py: cy * CELL_PX + 20,
        fuseTicks: p.hasRemoteBomb ? 999999 : BOMB_FUSE_TICKS,
        slidingDir: -1,
        thrownTicks: 12,
        thrownTotalTicks: 12,
        throwStartX: p.px,
        throwStartY: p.py,
        throwDestCx: (cx + DIR_DX[p.facing]! * 3 + this.width) % this.width,
        throwDestCy: (cy + DIR_DY[p.facing]! * 3 + this.height) % this.height,
        passThroughSlots: [],
      });
      this.sounds.push("TankFire");
      return;
    }

    // If standing on a bomb AND player has Punch (`hasThrow`), throw it 3 cells ahead!
    if (existing) {
      if (p.hasThrow && existing.slidingDir === -1) {
        existing.thrownTotalTicks = 12;
        existing.thrownTicks = 12;
        existing.throwStartX = existing.px;
        existing.throwStartY = existing.py;
        existing.throwDestCx = (cx + DIR_DX[p.facing]! * 3 + this.width) % this.width;
        existing.throwDestCy = (cy + DIR_DY[p.facing]! * 3 + this.height) % this.height;
        existing.passThroughSlots.length = 0;
        p.throwTicks = 12;
        this.sounds.push("BombIgnite");
      }
      return;
    }

    const cell = this.cellAt(cx, cy);
    if (!cell || cell.blocksWalk || cell.noBombPlace) return;
    if (p.bombsPlaced >= p.bombsMax) return;

    // Collect all bombers currently overlapping (cx, cy) so they can walk off cleanly
    const overlapping = this.players
      .filter(
        (pl) =>
          pl.state !== "dead" &&
          pl.state !== "dying" &&
          Math.floor(pl.px / CELL_PX) === cx &&
          Math.floor(pl.py / CELL_PX) === cy,
      )
      .map((pl) => pl.slot);

    const style = p.hasRemoteBomb ? "remote" : p.blindTicks > 0 ? "blind" : "normal";
    p.bombsPlaced++;
    this.bombs.push({
      id: this.nextEntityId++,
      ownerSlot: p.slot,
      power: p.boostTicks > 0 ? p.powerMax : p.power,
      pierce: p.hasPierceBomb,
      style,
      cx,
      cy,
      px: cx * CELL_PX + 20,
      py: cy * CELL_PX + 20,
      fuseTicks: style === "remote" ? 999999 : BOMB_FUSE_TICKS,
      slidingDir: -1,
      thrownTicks: 0,
      thrownTotalTicks: 0,
      throwStartX: 0,
      throwStartY: 0,
      throwDestCx: cx,
      throwDestCy: cy,
      passThroughSlots: overlapping,
    });
    this.sounds.push("BombIgnite");
  }

  private tryUseActiveItem(p: SimPlayer, requestedSlot?: number): void {
    // Also allow stopping own kicked bomb with Ctrl when alive
    for (const b of this.bombs) {
      if (b.ownerSlot === p.slot && b.slidingDir !== -1) {
        b.slidingDir = -1;
        b.px = b.cx * CELL_PX + 20;
        b.py = b.cy * CELL_PX + 20;
      }
    }

    let idx = requestedSlot !== undefined ? requestedSlot : -1;
    if (idx < 0 || idx > 5 || p.activeSlots[idx] === ACTIVE_NONE) {
      // Find Needle first if trapped, otherwise first available active item
      if (p.state === "trapped") {
        idx = p.activeSlots.indexOf(ACTIVE_NEEDLE);
      } else {
        idx = p.activeSlots.findIndex((v) => v !== ACTIVE_NONE && v !== ACTIVE_NEEDLE);
      }
    }
    if (idx < 0 || idx > 5) return;
    const item = p.activeSlots[idx]!;
    if (item === ACTIVE_NONE) return;

    if (item === ACTIVE_NEEDLE) {
      if (p.state !== "trapped") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      p.state = "alive";
      p.stateTicks = 0;
      p.invulnTicks = 30;
      p.wetTicks = 135;
      p.trappedBySlot = -1;
      this.sounds.push("Release");
    } else if (item === ACTIVE_SHIELD || item === ACTIVE_WATERTIGHT) {
      if (p.state !== "alive") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      p.shieldTicks = item === ACTIVE_WATERTIGHT ? 180 : 95;
      this.sounds.push("ItemEaten");
    } else if (item === ACTIVE_CAN) {
      if (p.state !== "alive") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      p.boostTicks = 330; // ~10s turbo speed + max flame (or Kart Nitro boost!)
      this.sounds.push(
        p.rideId === 9 || p.rideId === 10
          ? this.componentMode === 1
            ? "KartNitro"
            : "KartAccel"
          : "UseMotor",
      );
    } else if (item === ACTIVE_DART) {
      if (p.state !== "alive") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      this.darts.push({
        id: this.nextEntityId++,
        ownerSlot: p.slot,
        px: p.px + DIR_DX[p.facing]! * 14,
        py: p.py + DIR_DY[p.facing]! * 14,
        dir: p.facing,
      });
      this.sounds.push("BombIgnite");
    } else if (
      item === ACTIVE_BANANA ||
      item === ACTIVE_MINE ||
      item === ACTIVE_GUM ||
      item === ACTIVE_PIN
    ) {
      if (p.state !== "alive") return;
      const cx = Math.floor(p.px / CELL_PX);
      const cy = Math.floor(p.py / CELL_PX);
      if (this.hazards.some((h) => h.cx === cx && h.cy === cy)) return;
      p.activeSlots[idx] = ACTIVE_NONE;
      const kind: SimHazard["kind"] =
        item === ACTIVE_BANANA
          ? "banana"
          : item === ACTIVE_GUM
            ? "gum"
            : item === ACTIVE_PIN
              ? "pin"
              : "trap";
      this.hazards.push({
        id: this.nextEntityId++,
        ownerSlot: p.slot,
        cx,
        cy,
        kind,
        armTicks: 22,
      });
      this.sounds.push(kind === "banana" ? "Banana" : "MineSet");
    } else if (item === ACTIVE_SPRING) {
      if (p.state !== "alive") return;
      const curCx = Math.floor(p.px / CELL_PX);
      const curCy = Math.floor(p.py / CELL_PX);
      let dstCx = curCx + DIR_DX[p.facing]! * 2;
      let dstCy = curCy + DIR_DY[p.facing]! * 2;
      let dstCell = this.cellAt(dstCx, dstCy);
      let shortHop = false;
      if (!dstCell || dstCell.blocksWalk || this.bombAt(dstCx, dstCy)) {
        // Fallback to 1-cell hop (`Wave/SpringShort`) when 2-cell landing is obstructed!
        dstCx = curCx + DIR_DX[p.facing]!;
        dstCy = curCy + DIR_DY[p.facing]!;
        dstCell = this.cellAt(dstCx, dstCy);
        if (!dstCell || dstCell.blocksWalk || this.bombAt(dstCx, dstCy)) return;
        shortHop = true;
      }
      p.activeSlots[idx] = ACTIVE_NONE;
      p.jumpStartX = p.px;
      p.jumpStartY = p.py;
      p.jumpTicks = shortHop ? 10 : 14;
      p.px = dstCx * CELL_PX + 20;
      p.py = dstCy * CELL_PX + 20;
      p.hopInvulnTicks = 16;
      this.sounds.push(shortHop ? "SpringShort" : "Spring");
    } else if (item === ACTIVE_REMOTE) {
      if (p.state !== "alive") return;
      const remoteBombs = this.bombs.filter(
        (b) => b.ownerSlot === p.slot && b.style === "remote" && b.thrownTicks === 0,
      );
      if (remoteBombs.length > 0) {
        this.detonateChain(remoteBombs);
      }
    } else if (item === ACTIVE_RADAR) {
      if (p.state !== "alive") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      p.radarTicks = 330; // ~10s Scanner X-ray vision over destructible boxes
      this.sounds.push("ItemEaten");
    } else if (item === ACTIVE_BLIND) {
      if (p.state !== "alive") return;
      p.activeSlots[idx] = ACTIVE_NONE;
      p.blindTicks = 360;
      this.sounds.push("ItemEaten");
    } else if (item === ACTIVE_DRILL) {
      if (p.state !== "alive") return;
      const curCx = Math.floor(p.px / CELL_PX);
      const curCy = Math.floor(p.py / CELL_PX);
      const tx = curCx + DIR_DX[p.facing]!;
      const ty = curCy + DIR_DY[p.facing]!;
      const target = this.cellAt(tx, ty);
      p.drillTicks = 14;
      this.sounds.push("Drill");
      p.activeSlots[idx] = ACTIVE_NONE;
      if (target && target.blockKind === 2 && !target.indestructible && target.crumbleTicks === 0) {
        target.hp = 0;
        target.crumbleTicks = BOX_CRUMBLE_TICKS;
        if (!target.dropRolled) {
          target.pendingDrop = target.pendingDrop ?? this.rollItemDrop(tx, ty);
          target.dropRolled = true;
        }
        this.sounds.push("BlockDown");
      }
    }
  }

  private pushActiveSlot(p: SimPlayer, activeId: number, charges = 1): void {
    const cap = Math.max(1, Math.min(6, p.activeSlotCap ?? 4));
    let left = Math.max(1, Math.min(cap, charges));
    for (let i = 0; i < cap && left > 0; i++) {
      if (p.activeSlots[i] === ACTIVE_NONE) {
        p.activeSlots[i] = activeId;
        left--;
      }
    }
  }

  private spawnCoinPopup(px: number, py: number, amount: number): void {
    if (amount === 0) return;
    this.coinPopups.push({
      id: this.nextEntityId++,
      px,
      py,
      amount,
      ticksLeft: 25,
    });
  }

  private pickSafeRespawnCell(p: SimPlayer): [number, number] {
    const curCx = Math.floor(p.px / CELL_PX);
    const curCy = Math.floor(p.py / CELL_PX);
    const candidates: [number, number][] = [];
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        const c = this.cellAt(x, y);
        if (!c || c.blocksWalk || c.isPinHazard) continue;
        if (this.flames.some((f) => f.cx === x && f.cy === y)) continue;
        if (this.bombs.some((b) => Math.abs(b.cx - x) + Math.abs(b.cy - y) <= 2)) continue;
        candidates.push([x, y]);
      }
    }
    if (candidates.length === 0) return [curCx, curCy];
    return candidates[this.rng.nextInt(candidates.length)]!;
  }

  private applyItemPickup(p: SimPlayer, it: SimGroundItem): void {
    const flag = it.pickupFlag;
    const eff = it.effectId;
    const name = it.objectName.toLowerCase();

    // 1. Mounts (`pickupFlag === 2`, `ItemAttr.ships` 1..11: UFO, Owl, Turtle, Kart, Tank, Octopus, RailCar!)
    if (flag === 2) {
      let rideId = eff;
      // Retail Turtle (`Item/Turtle`, `eff === 3`): 30% chance to spawn as Super Fast Turtle (`4`)!
      if (rideId === 3 && this.rng.nextInt(10) < 3) rideId = 4;
      else if (rideId === 6 && this.rng.nextInt(10) < 3) rideId = 7;
      this.mountPlayer(p, rideId);
      return;
    }

    // 2. Bonus Lucci coins / money bags (`pickupFlag === 99`, `Bonus01..07`, `GoldBag`, `LucciPocket0/1`),
    //    `Alphabet01..11` (`pickupFlag === 98, eff === 1..11`, `CRAZY ARCADE` 11-letter collection),
    //    & Event2004 Golden Flag (`pickupFlag === 98, eff === 100`, `Game/Event2004ResultFlag`!)
    if (flag === 98) {
      if (eff >= 1 && eff <= 11) {
        const prevMask = (p.alphabetMask ?? 0) === 0x7ff ? 0 : (p.alphabetMask ?? 0);
        const bit = 1 << (eff - 1);
        const isNew = (prevMask & bit) === 0;
        const nextMask = prevMask | bit;
        p.alphabetMask = nextMask;
        const reward = nextMask === 0x7ff ? 500 : isNew ? 30 : 10;
        p.bonusLucci = Math.max(0, p.bonusLucci + reward);
        if (nextMask === 0x7ff) p.niceTicks = 60;
        this.spawnCoinPopup(p.px, p.py, reward);
        this.sounds.push("BonusStageEffect");
        return;
      }
      p.goldFlags = (p.goldFlags ?? 0) + 1;
      p.bonusLucci = Math.max(0, p.bonusLucci + eff);
      p.niceTicks = 42;
      this.spawnCoinPopup(p.px, p.py, eff);
      this.sounds.push("BonusStageEffect");
      return;
    }
    if (flag === 99) {
      if (this.componentMode === 4 && eff > 0) {
        this.bonusCoinsCollected++;
      }
      p.bonusLucci = Math.max(0, p.bonusLucci + eff);
      this.spawnCoinPopup(p.px, p.py, eff);
      this.sounds.push("ItemEaten");
      return;
    }

    // 3. Active inventory items & special bomb modifiers (`Fx:Attr/ItemAttr` exact `(pickupFlag, effectId)`)
    if (flag === 22 || name.includes("oxygen")) {
      p.hasOxygen = true;
      this.sounds.push("ItemEaten");
      return;
    }
    const charges = Math.max(1, it.activeSlotFlag ?? 1);
    if (flag === 23 || name.includes("niddle") || name.includes("needle")) {
      this.pushActiveSlot(p, ACTIVE_NEEDLE, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 24 || name.includes("scanner")) {
      this.pushActiveSlot(p, ACTIVE_RADAR, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 21 || name.includes("dart")) {
      this.pushActiveSlot(p, ACTIVE_DART, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 41 || name.includes("fakehedgehog")) {
      p.rideId = 0;
      p.rideSpeed = 0;
      p.rideFly = false;
      p.state = "hedgehog";
      p.stateTicks = 0;
      p.hedgehogSuper = false;
      p.hedgehogSpinTicks = 0;
      this.sounds.push("HedgehogRebirth");
      return;
    }
    if (flag === 42 || name.includes("superhedgehog")) {
      p.rideId = 0;
      p.rideSpeed = 0;
      p.rideFly = false;
      p.state = "hedgehog";
      p.stateTicks = 0;
      p.hedgehogSuper = true;
      p.hedgehogSpinTicks = 18;
      this.sounds.push("HedgehogRebirth");
      return;
    }
    if (flag === 30 || name.includes("waterproof") || name.includes("watertight")) {
      this.pushActiveSlot(p, ACTIVE_WATERTIGHT, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 25 || name.includes("shield") || name.includes("potion")) {
      this.pushActiveSlot(p, ACTIVE_SHIELD, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 11) {
      if (eff === 1 || name.includes("bond")) this.pushActiveSlot(p, ACTIVE_GUM, charges);
      else if (eff === 3 || name.includes("banana")) this.pushActiveSlot(p, ACTIVE_BANANA, charges);
      else if (eff === 4 || name === "pin") this.pushActiveSlot(p, ACTIVE_PIN, charges);
      else this.pushActiveSlot(p, ACTIVE_MINE, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 26 || name.includes("spring")) {
      this.pushActiveSlot(p, ACTIVE_SPRING, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 27 || name === "drill") {
      this.pushActiveSlot(p, ACTIVE_DRILL, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 28 || name.includes("remotebomb")) {
      p.hasRemoteBomb = true;
      if (!p.activeSlots.includes(ACTIVE_REMOTE)) {
        this.pushActiveSlot(p, ACTIVE_REMOTE, charges);
      }
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 29 || name === "blind") {
      this.pushActiveSlot(p, ACTIVE_BLIND, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 12 || flag === 13 || flag === 31 || flag === 32 || name.includes("can") || name.includes("nitro") || name.includes("itemfuel")) {
      if (flag === 32 || name.includes("itemfuel") || name.includes("energy")) {
        p.kartFuel = 100;
      }
      this.pushActiveSlot(p, ACTIVE_CAN, charges);
      this.sounds.push("ItemEaten");
      return;
    }
    if (flag === 33 || name.includes("hollowbomb")) {
      // Piercing Spiked Water Bomb (`HollowBomb`)!
      p.hasPierceBomb = true;
      this.sounds.push("ItemEaten");
      return;
    }

    // 4. Stat upgrades, QuestionMark mystery roulette (`樂爆卡`), & curses (`pickupFlag === 1`)
    if (eff === 21 || name.includes("questionmark")) {
      p.questionMarks = (p.questionMarks ?? 0) + 1;
      p.questionEffTicks = 36;
      const roll = this.rng.nextInt(7);
      if (roll === 0) p.bombsMax = Math.min(p.bombsMax + 2, 10);
      else if (roll === 1) p.power = p.powerMax;
      else if (roll === 2) p.speed = p.speedMax;
      else if (roll === 3) p.hasKick = true;
      else if (roll === 4) p.hasThrow = true;
      else if (roll === 5) this.mountPlayer(p, this.rng.nextInt(2) === 0 ? 2 : 10);
      else p.curseTicks = 240;
      this.sounds.push("ItemEaten");
    } else if (eff === 1 || name.includes("itembomb")) {
      p.bombsMax = Math.min(p.bombsMax + 1, 10);
      this.sounds.push("ItemEaten");
    } else if (eff === 2 || name.includes("itemfire")) {
      p.power = Math.min(p.power + 1, p.powerMax);
      this.sounds.push("ItemEaten");
    } else if (eff === 3 || name.includes("itemroller")) {
      p.speed = Math.min(p.speed + 1, p.speedMax);
      this.sounds.push("ItemEaten");
    } else if (eff === 4) {
      if (name.includes("reddevil")) {
        // Red Devil (`RedDevil`): max roller speed!
        p.speed = p.speedMax;
      } else {
        // Kick Shoe (`Item/ItemShoe`)
        p.hasKick = true;
      }
      this.sounds.push("ItemEaten");
    } else if (eff === 5 || name.includes("itempunch")) {
      p.hasThrow = true;
      this.sounds.push("ItemEaten");
    } else if (eff === 6 || name.includes("maxpower")) {
      p.power = p.powerMax;
      this.sounds.push("ItemEaten");
    } else if (eff === 7) {
      // `Item/ItemHollow`: temporary invulnerability / ghost speed boost
      p.hopInvulnTicks = Math.max(p.hopInvulnTicks, 180);
      this.sounds.push("ItemEaten");
    } else if (eff === 11 || name.includes("superman")) {
      p.speed = p.speedMax;
      p.power = p.powerMax;
      p.bombsMax = 10;
      p.boostTicks = 400;
      this.sounds.push("SuperMan");
    } else if (eff === 15 || name.includes("skate")) {
      p.hasIceSkate = true;
      p.speed = Math.min(p.speed + 1, p.speedMax);
      this.sounds.push("ItemEaten");
    } else if (eff === 17 || name.includes("swimming") || name.includes("goggle")) {
      // `Goggle` (`Item/Swimming`, `eff=17`): reveals bush-hidden enemies, stealth `BombBlind` bombs & camouflaged bombers!
      p.goggleTicks = 400;
      this.sounds.push("ItemEaten");
    } else if (eff === 19 || name === "mask" || name.includes("camouflage")) {
      // `Camouflage` (`Item/Mask`, `eff=19`): stealth invisibility against enemies without Goggle!
      p.camoTicks = 330;
      this.sounds.push("ItemEaten");
    } else if (eff === 99 || name.includes("goldflag") || name.includes("icecon") || name.includes("chuseok") || name.includes("doll") || name.includes("christmas")) {
      // `Fx:Attr/ItemAttr` `effectId === 99` (`GoldFlag` `Item/ItemGoldFlag`, `IceCon00..02`, `Candy00..02`, `Christmas00..02`, `ChuseokBam|Gam`, `Doll01..03`)
      if (name.includes("goldflag")) {
        p.goldFlags = (p.goldFlags ?? 0) + 1;
        p.bonusLucci = Math.max(0, p.bonusLucci + 100);
        p.niceTicks = 42;
        this.spawnCoinPopup(p.px, p.py, 100);
        this.sounds.push("BonusStageEffect");
      } else {
        if (name.includes("christmas")) {
          const xm: [number, number, number] = p.xmasItems ? [...p.xmasItems] : [0, 0, 0];
          const xi = name.endsWith("02") || name.includes("tree") ? 2 : name.endsWith("01") || name.includes("wreeth") ? 1 : 0;
          xm[xi]++;
          p.xmasItems = xm;
        }
        const tierReward = /02$|03$|gam$|tree$/i.test(name) ? 100 : /01$|bam$|wreeth$/i.test(name) ? 50 : 30;
        p.bonusLucci = Math.max(0, p.bonusLucci + tierReward);
        this.spawnCoinPopup(p.px, p.py, tierReward);
        this.sounds.push("BonusStageEffect");
      }
    } else if (eff === 8 || eff === 9 || eff === 10 || eff === 12 || name.includes("devil") || name.includes("skeleton")) {
      p.curseTicks = 300; // 9s Devil / Skeleton / MoonWalk curse!
      p.curseKind = eff === 8 || eff === 9 || eff === 10 || eff === 12 ? eff : name.includes("skeleton0") ? 8 : name.includes("skeleton1") ? 9 : name.includes("moon") ? 10 : 12;
      this.sounds.push("GreenDevil");
    } else {
      // Remaining festival / event items (`Candy`, `Event`, etc.) -> +1 bomb or boost
      p.bombsMax = Math.min(p.bombsMax + 1, 10);
      this.sounds.push("ItemEaten");
    }
  }

  private mountPlayer(p: SimPlayer, rideId: number): void {
    if (p.rideId > 0) return; // Already mounted
    const r: RideSpec | undefined = this.itemAttr.ships.get(rideId);
    p.rideId = rideId;
    p.rideSpeed = r?.speed ?? 5;
    p.rideFly = (r?.flyLevel ?? 1) >= 2;
    this.sounds.push("ItemShip00");
  }

  private applyPinPoke(p: SimPlayer): void {
    if (this.componentMode === 1) return; // Permanent Kart mount on race circuits
    if (p.rideId > 0 && !p.rideFly && p.hopInvulnTicks === 0 && p.shieldTicks === 0 && p.invulnTicks === 0) {
      p.rideId = 0;
      p.rideSpeed = 0;
      p.rideFly = false;
      p.hopInvulnTicks = 24;
      this.sounds.push("ItemPop");
    }
  }

  private updateKartProgress(p: SimPlayer): void {
    if (this.finished) return;
    const cx = Math.floor(p.px / CELL_PX);
    const cy = Math.floor(p.py / CELL_PX);
    const cell = this.cellAt(cx, cy);
    if (!cell || cell.lapCheckpoint < 0) return;
    const cp = cell.lapCheckpoint;
    const lastCp = p.kartCheckpoint ?? -1;
    let laps = p.kartLap ?? 0;
    if (cp === lastCp + 1) {
      if (cp === 0) {
        if (laps >= this.kartTotalLaps) {
          // Crossed finish line after completing all `kartTotalLaps`!
          p.kartCheckpoint = 0;
          this.finished = true;
          this.winnerTeam = p.team;
          this.winnerSlots = this.players.filter((pl) => pl.team === p.team).map((pl) => pl.slot);
          this.sounds.push("Win");
          return;
        }
        if (this.kartTotalLaps - laps === 1) {
          p.isFinalLap = true;
        }
      }
      if (cp >= this.kartCheckpoints) {
        laps++;
        p.kartLap = laps;
        p.kartCheckpoint = -1;
      } else {
        p.kartCheckpoint = cp;
      }
      this.sounds.push("RallyPoint");
    }
  }

  private refreshKartRankings(): void {
    let bestScore = -999;
    let bestSlot = -1;
    for (const p of this.players) {
      if (p.state === "dead" || p.state === "dying") {
        p.isFirstPlace = false;
        continue;
      }
      const score = (p.kartLap ?? 0) * 100 + ((p.kartCheckpoint ?? -1) + 1) * 10;
      if (score > bestScore) {
        bestScore = score;
        bestSlot = p.slot;
      }
    }
    for (const p of this.players) {
      p.isFirstPlace = bestSlot >= 0 && bestScore > 0 && p.slot === bestSlot;
    }
  }

  private spawnSupplyAirPlane(): void {
    const candidates: number[] = [];
    for (let y = 1; y < this.height - 1; y++) {
      let openCount = 0;
      for (let x = 1; x < this.width - 1; x++) {
        const c = this.cellAt(x, y);
        if (c && !c.blocksWalk && c.blockKind === 0) openCount++;
      }
      if (openCount >= 3) candidates.push(y);
    }
    const row = candidates.length > 0 ? candidates[this.rng.nextInt(candidates.length)]! : Math.floor(this.height / 2);
    const openCols: number[] = [];
    for (let x = 1; x < this.width - 1; x++) {
      const c = this.cellAt(x, row);
      if (c && !c.blocksWalk && c.blockKind === 0 && !this.bombAt(x, row)) {
        openCols.push(x);
      }
    }
    // Pick up to 3 open columns for supply crate drops
    for (let i = openCols.length - 1; i > 0; i--) {
      const j = this.rng.nextInt(i + 1);
      const t = openCols[i]!;
      openCols[i] = openCols[j]!;
      openCols[j] = t;
    }
    const drops = openCols.slice(0, 3).map((col) => ({ col, dropped: false }));
    this.airplane = {
      px: this.width * CELL_PX + 80,
      py: row * CELL_PX + 20,
      row,
      drops,
    };
    this.sounds.push("ItemShip01");
  }

  private updateAirPlane(): void {
    if (!this.airplane) return;
    const ap = this.airplane;
    ap.px -= 8;
    for (const d of ap.drops) {
      const targetPx = d.col * CELL_PX + 20;
      if (!d.dropped && ap.px <= targetPx) {
        d.dropped = true;
        const c = this.cellAt(d.col, ap.row);
        if (c && !c.blocksWalk && !this.bombAt(d.col, ap.row) && !this.items.some((it) => it.cx === d.col && it.cy === ap.row)) {
          const item = this.rollGuaranteedSupplyDrop(d.col, ap.row);
          if (item) {
            this.items.push(item);
            this.sounds.push("ItemRelease");
          }
        }
      }
    }
    if (ap.px < -100) {
      this.airplane = null;
    }
  }

  private rollGuaranteedSupplyDrop(cx: number, cy: number): SimGroundItem | null {
    if (this.mapTotalDropWeight <= 0 || this.mapDropPool.length === 0) return null;
    let pick = this.rng.nextInt(this.mapTotalDropWeight);
    for (const entry of this.mapDropPool) {
      if (pick < entry.weight) {
        return {
          id: this.nextEntityId++,
          cx,
          cy,
          objectName: entry.spec.objectName,
          iconSprite: entry.spec.iconSprite,
          pickupFlag: entry.spec.pickupFlag,
          effectId: entry.spec.effectId,
          activeSlotFlag: entry.spec.activeSlotFlag,
          spawnTick: this.tick,
        };
      }
      pick -= entry.weight;
    }
    return null;
  }

  private updateFootprints(): void {
    for (let i = this.footprints.length - 1; i >= 0; i--) {
      const fp = this.footprints[i]!;
      fp.ticksLeft--;
      if (fp.ticksLeft <= 0) {
        this.footprints.splice(i, 1);
      }
    }
    for (let i = this.coinPopups.length - 1; i >= 0; i--) {
      const cp = this.coinPopups[i]!;
      cp.ticksLeft--;
      if (cp.ticksLeft <= 0) {
        this.coinPopups.splice(i, 1);
      }
    }
  }

  private canSoulEnter(s: SimSoul, cx: number, cy: number): boolean {
    const c = this.cellAt(cx, cy);
    if (!c) return false;
    if (s.kind === "OuterSoul") {
      // `Game/BulaBat` flies over boxes/bushes along perimeter/waypoints, blocked only by solid static walls if inside!
      return true;
    }
    if (c.blocksWalk) return false;
    if (this.bombAt(cx, cy)) return false;
    return true;
  }

  private updateSouls(): void {
    // Process queued Soul respawns (`CA.exe.c:136380` — keeps Mummies & Bats coming in competitive Bula / Event2004!)
    for (let r = this.pendingSoulRespawns.length - 1; r >= 0; r--) {
      const entry = this.pendingSoulRespawns[r]!;
      entry.ticksLeft--;
      if (entry.ticksLeft <= 0) {
        this.pendingSoulRespawns.splice(r, 1);
        const sp = this.soulSpawnDefs[entry.defIdx];
        if (sp) {
          let px = Math.max(0, Math.min(this.width - 1, sp.col)) * CELL_PX + 20;
          let py = Math.max(0, Math.min(this.height - 1, sp.row)) * CELL_PX + 20;
          let wpIdx = 0;
          let dir: Dir4 = (sp.waypointOrDir & 3) as Dir4;
          if (sp.pathIndex > 0 && this.soulPaths[sp.pathIndex - 1]?.length) {
            const path = this.soulPaths[sp.pathIndex - 1]!;
            wpIdx = sp.waypointOrDir >= 0 && sp.waypointOrDir < path.length ? sp.waypointOrDir : 0;
            const pt = path[wpIdx]!;
            px = Math.max(0, Math.min(this.width - 1, pt[0])) * CELL_PX + 20;
            py = Math.max(0, Math.min(this.height - 1, pt[1])) * CELL_PX + 20;
            const next = path[(wpIdx + 1) % path.length]!;
            dir = next[0] === pt[0] ? (next[1] > pt[1] ? 3 : 1) : (next[0] > pt[0] ? 2 : 0);
          }
          const baseSpeed = Math.max(2, Math.min(6, sp.speed || 2));
          this.souls.push({
            id: this.nextEntityId++,
            kind: sp.kind,
            px,
            py,
            dir,
            speed: this.hurryUp ? Math.max(baseSpeed, 4) : baseSpeed,
            angry: this.hurryUp || baseSpeed >= 4,
            state: "spawn",
            stateTicks: 0,
            pathIndex: sp.pathIndex,
            waypointIdx: (wpIdx + 1) % Math.max(1, this.soulPaths[sp.pathIndex - 1]?.length ?? 1),
          });
          this.sounds.push(sp.kind === "InnerSoul" ? "BulaMummyCreate" : "BulaBatCreate");
        }
      }
    }

    for (let i = this.souls.length - 1; i >= 0; i--) {
      const s = this.souls[i]!;
      s.stateTicks++;
      if (s.state === "spawn") {
        if (s.stateTicks >= this.soulActionTicks[s.kind].spawn) {
          s.state = "walk";
          s.stateTicks = 0;
        }
        continue;
      }
      if (s.state === "dying") {
        if (s.stateTicks >= this.soulActionTicks[s.kind].dying) {
          this.souls.splice(i, 1);
        }
        continue;
      }

      // Active `walk` patrol: either follow `soulPaths[pathIndex - 1]` waypoints or grid patrol!
      const path = s.pathIndex > 0 ? this.soulPaths[s.pathIndex - 1] : undefined;
      if (path && path.length > 0) {
        const wp = path[s.waypointIdx % path.length]!;
        const tx = Math.max(0, Math.min(this.width - 1, wp[0])) * CELL_PX + 20;
        const ty = Math.max(0, Math.min(this.height - 1, wp[1])) * CELL_PX + 20;
        const dx = tx - s.px;
        const dy = ty - s.py;
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
          s.dir = dx < 0 ? 0 : 2;
          s.px += Math.sign(dx) * Math.min(s.speed, Math.abs(dx));
        } else if (dy !== 0) {
          s.dir = dy < 0 ? 1 : 3;
          s.py += Math.sign(dy) * Math.min(s.speed, Math.abs(dy));
        }
        if (s.px === tx && s.py === ty) {
          s.waypointIdx = (s.waypointIdx + 1) % path.length;
          const next = path[s.waypointIdx]!;
          if (next[0] !== wp[0]) s.dir = next[0] < wp[0] ? 0 : 2;
          else if (next[1] !== wp[1]) s.dir = next[1] < wp[1] ? 1 : 3;
        }
      } else {
        const curCx = Math.floor(s.px / CELL_PX);
        const curCy = Math.floor(s.py / CELL_PX);
        const centerPx = curCx * CELL_PX + 20;
        const centerPy = curCy * CELL_PX + 20;
        const atCenter = Math.abs(s.px - centerPx) <= s.speed && Math.abs(s.py - centerPy) <= s.speed;

        if (atCenter) {
          const openDirs: Dir4[] = [];
          for (const d of [0, 1, 2, 3] as Dir4[]) {
            if (this.canSoulEnter(s, curCx + DIR_DX[d]!, curCy + DIR_DY[d]!)) {
              openDirs.push(d);
            }
          }
          const forwardOk = openDirs.includes(s.dir);
          // At intersections or dead-ends, pick a fresh corridor (preferring non-reverse or toward nearest alive player)
          if (!forwardOk || (openDirs.length >= 3 && this.rng.nextInt(5) === 0)) {
            const nonRev = openDirs.filter((d) => d !== ((s.dir ^ 2) as Dir4));
            const pool = nonRev.length > 0 ? nonRev : openDirs;
            if (pool.length > 0) {
              s.px = centerPx;
              s.py = centerPy;
              s.dir = pool[this.rng.nextInt(pool.length)]!;
            }
          }
        }

        const nx = s.px + DIR_DX[s.dir]! * s.speed;
        const ny = s.py + DIR_DY[s.dir]! * s.speed;
        const adjCx = curCx + DIR_DX[s.dir]!;
        const adjCy = curCy + DIR_DY[s.dir]!;
        const crossing =
          (DIR_DX[s.dir]! < 0 && nx < centerPx) ||
          (DIR_DX[s.dir]! > 0 && nx > centerPx) ||
          (DIR_DY[s.dir]! < 0 && ny < centerPy) ||
          (DIR_DY[s.dir]! > 0 && ny > centerPy);
        if (crossing && !this.canSoulEnter(s, adjCx, adjCy)) {
          s.px = centerPx;
          s.py = centerPy;
          s.dir = ((s.dir + 1 + this.rng.nextInt(3)) & 3) as Dir4;
        } else {
          s.px = Math.max(20, Math.min(this.width * CELL_PX - 20, nx));
          s.py = Math.max(20, Math.min(this.height * CELL_PX - 20, ny));
        }
      }

      // Soul contact against bombers: pops mounts OR traps/kills bombers!
      for (const p of this.players) {
        if (p.state === "dead" || p.state === "dying") continue;
        // sub_40E770 and sub_49D2BB use overlapping 20 x 20 rectangles
        // for ordinary bombers and souls, rather than a circular radius.
        if (Math.abs(p.px - s.px) >= 20 || Math.abs(p.py - s.py) >= 20) continue;
        if (p.state === "trapped" && p.stateTicks >= BUBBLE_GRACE_TICKS) {
          this.killPlayer(p, -1);
          continue;
        }
        if (p.state !== "alive") continue;
        if (p.invulnTicks > 0 || p.hopInvulnTicks > 0 || p.shieldTicks > 0) continue;
        if (p.rideId > 0) {
          p.rideId = 0;
          p.rideSpeed = 0;
          p.rideFly = false;
          p.hopInvulnTicks = 24;
          this.sounds.push("ItemPop");
        } else {
          p.state = "trapped";
          p.stateTicks = 0;
          p.trappedBySlot = -1;
          p.curseTicks = 0;
          this.sounds.push("BulaGhostWarning2");
          this.sounds.push("LockedIn");
        }
      }
    }
  }

  private applyFlameHits(): void {
    if (this.flames.length === 0) return;

    // 1. Flame vs Bula / Event2004 Souls (`InnerSoul` Mummy & `OuterSoul` BulaBat)!
    for (const s of this.souls) {
      if (s.state !== "walk") continue;
      const scx = Math.floor(s.px / CELL_PX);
      const scy = Math.floor(s.py / CELL_PX);
      const hit = soulFlameHit(s.px, s.py, this.flames);
      if (!hit) continue;
      s.state = "dying";
      s.stateTicks = 0;
      this.sounds.push(s.kind === "InnerSoul" ? "BulaMummyDie" : "BulaBatDie");
      const killer = this.players.find((pl) => pl.slot === hit.ownerSlot);
      if (killer) {
        killer.kills++;
        killer.bonusLucci += 25;
        killer.niceTicks = 42;
      }
      // In competitive Bula or Event2004, defeated Souls respawn after ~7.2s (`CA.exe.c:136380`)!
      if ((this.bulaCompetitive || this.componentMode === 3) && this.soulSpawnDefs.length > 0) {
        this.pendingSoulRespawns.push({
          defIdx: this.rng.nextInt(this.soulSpawnDefs.length),
          ticksLeft: 240,
        });
      }
      // On `CEvent2004Component` Soul mazes (`EventForest00` / `EventPatrit00`), defeated Souls can drop Golden Flags!
      const totalFlagsClaimedOrLive =
        this.players.reduce((acc, pl) => acc + (pl.goldFlags ?? 0), 0) +
        this.items.filter((it) => it.pickupFlag === 98).length;
      if (this.componentMode === 3 && totalFlagsClaimedOrLive < this.eventTargetFlags) {
        this.items.push({
          id: this.nextEntityId++,
          cx: scx,
          cy: scy,
          objectName: "GoldFlag",
          iconSprite: "Item/ItemGoldFlag",
          pickupFlag: 98,
          effectId: 100,
          spawnTick: this.tick,
        });
      } else if (this.rng.nextInt(2) === 0) {
        // 50% chance for defeated Soul to drop a helpful field item!
        const drop = this.rollGuaranteedSupplyDrop(scx, scy);
        if (drop) {
          drop.spawnTick = this.tick;
          this.items.push(drop);
        }
      }
    }

    // 2. Flame vs alive bombers!
    for (const p of this.players) {
      if (p.state !== "alive") continue;
      if (p.invulnTicks > 0 || p.hopInvulnTicks > 0 || p.shieldTicks > 0) continue;

      const pcx = Math.floor(p.px / CELL_PX);
      const pcy = Math.floor(p.py / CELL_PX);
      const hitFlame = this.flames.find((f) => f.cx === pcx && f.cy === pcy);
      if (!hitFlame) continue;

      // On Kart Racing circuits (`componentMode === 1`), Kart mounts never dismount: flames spin/slow the racer!
      if (this.componentMode === 1 && (p.rideId === 9 || p.rideId === 10)) {
        p.glueTicks = 38;
        p.boostTicks = 0;
        p.hopInvulnTicks = 38;
        this.sounds.push("ItemPop");
        continue;
      }

      // Mounted bomber: mount takes the hit and pops with 24-tick dismount invulnerability!
      if (p.rideId > 0) {
        p.rideId = 0;
        p.rideSpeed = 0;
        p.rideFly = false;
        p.hopInvulnTicks = 24;
        this.sounds.push("ItemPop");
        continue;
      }

      // Trap bomber in water bubble!
      p.state = "trapped";
      p.stateTicks = 0;
      p.trappedBySlot = hitFlame.ownerSlot;
      p.curseTicks = 0;
      this.sounds.push("LockedIn");
    }
  }

  private applyPlayerContacts(): void {
    for (let i = 0; i < this.players.length; i++) {
      const a = this.players[i]!;
      if (a.state === "dead" || a.state === "dying") continue;
      for (let j = i + 1; j < this.players.length; j++) {
        const b = this.players[j]!;
        if (b.state === "dead" || b.state === "dying") continue;

        const distSq = (a.px - b.px) * (a.px - b.px) + (a.py - b.py) * (a.py - b.py);
        if (distSq > 28 * 28) continue;

        // Contagious GreenDevil (`eff=12`) curse transfer on body contact (`CA.exe` GreenDevil tag)!
        if (a.state === "alive" && b.state === "alive") {
          const aGreen = a.curseTicks > 0 && (a.curseKind ?? 12) === 12;
          const bGreen = b.curseTicks > 0 && (b.curseKind ?? 12) === 12;
          if (aGreen && !bGreen && b.curseTicks === 0 && a.invulnTicks === 0 && b.invulnTicks === 0 && b.shieldTicks === 0) {
            b.curseTicks = a.curseTicks;
            b.curseKind = 12;
            a.curseTicks = 0;
            a.curseKind = 0;
            a.invulnTicks = 18;
            b.invulnTicks = 18;
            this.sounds.push("GreenDevil");
          } else if (bGreen && !aGreen && a.curseTicks === 0 && b.invulnTicks === 0 && a.invulnTicks === 0 && a.shieldTicks === 0) {
            a.curseTicks = b.curseTicks;
            a.curseKind = 12;
            b.curseTicks = 0;
            b.curseKind = 0;
            a.invulnTicks = 18;
            b.invulnTicks = 18;
            this.sounds.push("GreenDevil");
          }
        }

        // Timebomb transfer on contact!
        if (this.mode === 2 && a.state === "alive" && b.state === "alive") {
          if (a.hasTimebomb && a.invulnTicks === 0) {
            a.hasTimebomb = false;
            a.invulnTicks = 18;
            b.hasTimebomb = true;
            b.timebombTicks = a.timebombTicks;
            b.invulnTicks = 18;
            this.sounds.push("TimebombTouch");
          } else if (b.hasTimebomb && b.invulnTicks === 0) {
            b.hasTimebomb = false;
            b.invulnTicks = 18;
            a.hasTimebomb = true;
            a.timebombTicks = b.timebombTicks;
            a.invulnTicks = 18;
            this.sounds.push("TimebombTouch");
          }
        }

        // SuperHedgehog rolling spin knocks enemy riders off their mounts!
        if (
          a.state === "hedgehog" &&
          a.hedgehogSpinTicks > 0 &&
          b.state === "alive" &&
          b.team !== a.team &&
          b.rideId > 0 &&
          b.hopInvulnTicks === 0
        ) {
          b.rideId = 0;
          b.rideSpeed = 0;
          b.rideFly = false;
          b.hopInvulnTicks = 24;
          this.sounds.push("ItemPop");
        }
        if (
          b.state === "hedgehog" &&
          b.hedgehogSpinTicks > 0 &&
          a.state === "alive" &&
          a.team !== b.team &&
          a.rideId > 0 &&
          a.hopInvulnTicks === 0
        ) {
          a.rideId = 0;
          a.rideSpeed = 0;
          a.rideFly = false;
          a.hopInvulnTicks = 24;
          this.sounds.push("ItemPop");
        }

        // Bubble rescue vs execution
        this.resolveBubbleTouch(a, b);
        this.resolveBubbleTouch(b, a);
      }
    }
  }

  private resolveBubbleTouch(trapped: SimPlayer, toucher: SimPlayer): void {
    if (trapped.state !== "trapped") return;
    if (toucher.state !== "alive" && toucher.state !== "hedgehog") return;

    const sameTeam = trapped.team === toucher.team;
    if (sameTeam) {
      // Teammate rescue!
      trapped.state = "alive";
      trapped.stateTicks = 0;
      trapped.invulnTicks = 30;
      trapped.wetTicks = 135;
      trapped.trappedBySlot = -1;
      toucher.saves++;
      this.sounds.push("Revive");
    } else if (trapped.stateTicks >= BUBBLE_GRACE_TICKS) {
      // Enemy pop execution!
      this.killPlayer(trapped, toucher.slot);
    }
  }

  private killPlayer(victim: SimPlayer, killerSlot: number): void {
    if (victim.state === "dying" || victim.state === "dead") return;
    victim.state = "dying";
    victim.stateTicks = 0;
    victim.deaths++;
    victim.rideId = 0;
    victim.rideFly = false;
    victim.hasRemoteBomb = false;
    // Any unexploded remote bombs owned by `victim` revert to short 30-tick fuse on death
    for (const b of this.bombs) {
      if (b.ownerSlot === victim.slot && b.style === "remote") {
        b.style = "normal";
        b.fuseTicks = Math.min(b.fuseTicks, 30);
      }
    }
    this.sounds.push(this.componentMode === 2 ? "BulaPlayerDie" : "Die");

    if (killerSlot >= 0 && killerSlot !== victim.slot) {
      const killer = this.players.find((p) => p.slot === killerSlot);
      if (killer && killer.team !== victim.team) {
        killer.kills++;
        killer.niceTicks = 42;
        killer.comboKills = (killer.comboKills ?? 0) + 1;
        killer.maxCombo = Math.max(killer.maxCombo ?? 0, killer.comboKills);
        killer.comboWindowTicks = 135;
      }
    }
  }

  /**
   * Retail `CTimebombRoulette` (`CA.exe.c:146210..146570`):
   * Spins `Game/TimebombSlot` across living player HUD slots (`(623, 43 * slot + 51)`)
   * with `Wave/TimebombRoulette` before assigning `hasTimebomb`.
   */
  startTimebombRoulette(durationTicks = 36): void {
    const alive = this.players.filter((p) => p.state === "alive");
    if (alive.length === 0) return;
    this.timebombRouletteTicks = Math.max(6, durationTicks);
    this.timebombRouletteSlot = alive[this.rng.nextInt(alive.length)]!.slot;
  }

  private updateTimebombRoulette(): void {
    if (this.timebombRouletteTicks <= 0) return;
    this.timebombRouletteTicks--;
    const alive = this.players.filter((p) => p.state === "alive");
    if (alive.length === 0) {
      this.timebombRouletteTicks = 0;
      this.timebombRouletteSlot = -1;
      return;
    }
    if (this.timebombRouletteTicks === 0) {
      const lucky = alive[this.rng.nextInt(alive.length)]!;
      lucky.hasTimebomb = true;
      lucky.timebombTicks = 270; // ~8s fuse
      this.timebombRouletteSlot = -1;
      this.sounds.push("TimebombTouch");
      return;
    }
    const stepModulo = this.timebombRouletteTicks <= 12 ? 6 : 4;
    if (this.tick > START_BANNER_TICKS && this.timebombRouletteTicks % stepModulo === 0) {
      const curIdx = alive.findIndex((p) => p.slot === this.timebombRouletteSlot);
      const next = alive[(curIdx + 1) % alive.length]!;
      this.timebombRouletteSlot = next.slot;
      this.sounds.push("TimebombRoulette");
    }
  }

  /**
   * Retail `CGOGhost` (`CA.exe.c:24055..24450`, `Game/Ghost` -> `Game/Ghost Big`):
   * Materializes at Hurry-Up near the center of the arena (`Wave/Ghost`), glides down corridors,
   * and transforms into `Game/Ghost Big` (`Wave/GhostTrans`) to rush aligned bombers!
   */
  spawnHurryGhost(forceCx?: number, forceCy?: number): SimGhost {
    let gx = forceCx ?? Math.floor(this.width / 2);
    let gy = forceCy ?? Math.floor(this.height / 2);
    if (forceCx === undefined || forceCy === undefined) {
      let bestDist = 9999;
      for (let y = 1; y < this.height - 1; y++) {
        for (let x = 1; x < this.width - 1; x++) {
          const c = this.cellAt(x, y);
          if (!c || c.blocksWalk) continue;
          const d = Math.abs(x - Math.floor(this.width / 2)) + Math.abs(y - Math.floor(this.height / 2));
          if (d < bestDist) {
            bestDist = d;
            gx = x;
            gy = y;
          }
        }
      }
    }
    const g: SimGhost = {
      id: this.nextEntityId++,
      px: gx * CELL_PX + 20,
      py: gy * CELL_PX + 20,
      dir: 3,
      state: "in",
      stateTicks: 0,
    };
    this.ghost = g;
    this.sounds.push("Ghost");
    return g;
  }

  private canGhostEnter(cx: number, cy: number): boolean {
    const c = this.cellAt(cx, cy);
    if (!c) return false;
    return !c.blocksWalk;
  }

  private updateHurryGhost(): void {
    const g = this.ghost;
    if (!g) return;
    g.stateTicks++;

    if (g.state === "in") {
      if (g.stateTicks >= 18) {
        g.state = "walk";
        g.stateTicks = 0;
      }
      return;
    }
    if (g.state === "stun") {
      if (g.stateTicks >= 30) {
        g.state = "walk";
        g.stateTicks = 0;
      }
      return;
    }
    const gCxNow = Math.floor(g.px / CELL_PX);
    const gCyNow = Math.floor(g.py / CELL_PX);
    if (this.flames.some((f) => f.cx === gCxNow && f.cy === gCyNow)) {
      g.state = "stun";
      g.stateTicks = 0;
      return;
    }
    if (g.state === "trans") {
      if (g.stateTicks >= 8) {
        g.state = "rush";
        g.stateTicks = 0;
      }
      return;
    }

    const curCx = Math.floor(g.px / CELL_PX);
    const curCy = Math.floor(g.py / CELL_PX);
    const centerPx = curCx * CELL_PX + 20;
    const centerPy = curCy * CELL_PX + 20;
    const speed = g.state === "rush" ? 4.5 : 2.5;
    const atCenter = Math.abs(g.px - centerPx) <= speed && Math.abs(g.py - centerPy) <= speed;

    if (g.state === "walk" && atCenter) {
      // Check 4 cardinal corridors up to 6 cells for aligned bomber (`CA.exe.c:24340..24425`)
      let spottedDir: Dir4 | -1 = -1;
      let bestSteps = 99;
      for (const d of [0, 1, 2, 3] as Dir4[]) {
        for (let step = 1; step <= 6; step++) {
          const tx = curCx + DIR_DX[d]! * step;
          const ty = curCy + DIR_DY[d]! * step;
          if (!this.canGhostEnter(tx, ty)) break;
          const hasTarget = this.players.some(
            (pl) =>
              (pl.state === "alive" || pl.state === "trapped") &&
              Math.floor(pl.px / CELL_PX) === tx &&
              Math.floor(pl.py / CELL_PX) === ty,
          );
          if (hasTarget && step < bestSteps) {
            bestSteps = step;
            spottedDir = d;
            break;
          }
        }
      }
      if (spottedDir !== -1) {
        g.px = centerPx;
        g.py = centerPy;
        g.dir = spottedDir;
        g.state = "trans";
        g.stateTicks = 0;
        this.sounds.push("GhostTrans");
        return;
      }

      const openDirs = ([0, 1, 2, 3] as Dir4[]).filter((d) =>
        this.canGhostEnter(curCx + DIR_DX[d]!, curCy + DIR_DY[d]!),
      );
      if (!openDirs.includes(g.dir) || (openDirs.length >= 3 && this.rng.nextInt(4) === 0)) {
        const nonRev = openDirs.filter((d) => d !== ((g.dir ^ 2) as Dir4));
        const pool = nonRev.length > 0 ? nonRev : openDirs;
        if (pool.length > 0) {
          g.px = centerPx;
          g.py = centerPy;
          g.dir = pool[this.rng.nextInt(pool.length)]!;
        }
      }
    }

    const nx = g.px + DIR_DX[g.dir]! * speed;
    const ny = g.py + DIR_DY[g.dir]! * speed;
    const adjCx = curCx + DIR_DX[g.dir]!;
    const adjCy = curCy + DIR_DY[g.dir]!;
    const crossing =
      (DIR_DX[g.dir]! < 0 && nx < centerPx) ||
      (DIR_DX[g.dir]! > 0 && nx > centerPx) ||
      (DIR_DY[g.dir]! < 0 && ny < centerPy) ||
      (DIR_DY[g.dir]! > 0 && ny > centerPy);
    if (crossing && !this.canGhostEnter(adjCx, adjCy)) {
      g.px = centerPx;
      g.py = centerPy;
      if (g.state === "rush") {
        g.state = "walk";
        g.stateTicks = 0;
      }
      g.dir = ((g.dir + 1 + this.rng.nextInt(3)) & 3) as Dir4;
    } else {
      g.px = Math.max(20, Math.min(this.width * CELL_PX - 20, nx));
      g.py = Math.max(20, Math.min(this.height * CELL_PX - 20, ny));
      if (g.state === "rush" && g.stateTicks >= 64) {
        g.state = "walk";
        g.stateTicks = 0;
      }
    }

    // Contact vs players!
    for (const p of this.players) {
      if (p.state === "dead" || p.state === "dying") continue;
      const distSq = (p.px - g.px) * (p.px - g.px) + (p.py - g.py) * (p.py - g.py);
      if (distSq > 24 * 24) continue;
      if (p.state === "trapped" && p.stateTicks >= BUBBLE_GRACE_TICKS) {
        this.killPlayer(p, -1);
        continue;
      }
      if (p.state !== "alive") continue;
      if (p.invulnTicks > 0 || p.hopInvulnTicks > 0) continue;
      if (p.shieldTicks > 0) {
        p.shieldTicks = 0;
        p.hopInvulnTicks = 20;
        g.state = "stun";
        g.stateTicks = 0;
        this.sounds.push("ItemPop");
        continue;
      }
      if (p.rideId > 0) {
        p.rideId = 0;
        p.rideSpeed = 0;
        p.rideFly = false;
        p.hopInvulnTicks = 24;
        this.sounds.push("ItemPop");
      } else {
        p.state = "trapped";
        p.stateTicks = 0;
        p.trappedBySlot = -1;
        p.curseTicks = 0;
        this.sounds.push("Ghost");
        this.sounds.push("LockedIn");
      }
    }
  }

  /** Dot contact and native loop request; the local server accepts requests immediately. */
  private updateBulaCellStep(p: SimPlayer): void {
    const nativeX = p.px - 20;
    const nativeY = p.py + 19;
    const dotX = Math.trunc(nativeX / CELL_PX) * 3 + Math.trunc((nativeX % CELL_PX) / 13) + 1;
    const dotY = Math.trunc((nativeY - 34) / 20) + 1;
    if (dotX < 0 || dotX >= this.width * 3 || dotY < 0 || dotY >= this.height * 2) return;
    const cell = this.cellAt(Math.floor(dotX / 3), Math.floor(dotY / 2));
    const index = (dotY % 2) * 3 + dotX % 3;
    if (!cell || cell.bulaDots[index]! < 0 || cell.bulaDotEffects[index] || cell.bulaDots[index] === p.team + 1) return;
    cell.bulaDots[index] = p.team + 1;
    this.tryCaptureBulaLoop(dotY, dotX, p);
  }

  private tryCaptureBulaLoop(row: number, col: number, p: SimPlayer): void {
    const width = this.width * 3;
    const height = this.height * 2;
    const states = new Array<number>(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = this.cells[Math.floor(y / 2) * this.width + Math.floor(x / 3)]!;
        const dotIndex = (y % 2) * 3 + x % 3;
        states[y * width + x] = bulaNativeDotState(cell.bulaDots[dotIndex]!, cell.bulaDotEffects[dotIndex]);
      }
    }
    const paths = traceBulaLoopsAt({ width, height, states }, row, col, p.team + 3);
    for (const path of paths) {
      const candidates = bulaLoopCandidates(path, width, height, (y, x) => {
        const block = this.cellAt(x, y);
        // sub_40B1F5 returns active CGOTileStatic (kind 1), not boxes,
        // passable objects, or footprint-only collision cells.
        return Boolean(block?.blockObjName && block.blockKind === 1 && block.bulaHouseTeam === -1);
      });
      if (candidates.length === 0) continue;
      // Native sub_49BF75 sends candidates to the server. The original server
      // is unavailable: our authoritative simulation accepts them immediately,
      // without inventing its score multiplier or random item response.
      const captured = new Set<number>();
      for (const [y, x] of candidates) {
        this.cells[y * this.width + x]!.bulaHouseTeam = p.team;
        captured.add(y * this.width + x);
      }
      p.bulaHouses = (p.bulaHouses ?? 0) + captured.size;
      this.sounds.push("BulaTookHouse");
      this.updateBulaDotsAfterCapture(captured);
    }
  }

  // sub_49AE87 / sub_49A986 / sub_49AA25 use the eight neighbour offsets
  // stored at PE 0x616430. Called after a house capture, not at map init.
  private updateBulaDotsAfterCapture(captured: ReadonlySet<number>): void {
    const offsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y * this.width + x]!;
        for (let i = 0; i < 6; i++) {
          const owner = cell.bulaDots[i]!;
          if (owner < 0) continue;
          const row = y * 2 + Math.floor(i / 3);
          const col = x * 3 + i % 3;
          let adjacentCaptured = false;
          let adjacentUnclaimed = false;
          for (const [dy, dx] of offsets) {
            const houseY = Math.trunc((row + (row % 2 + 1) * dy) / 2);
            const houseX = Math.trunc((col + 2 * dx) / 3);
            if (houseX < 0 || houseX >= this.width || houseY < 0 || houseY >= this.height) continue;
            const houseIndex = houseY * this.width + houseX;
            const house = this.cells[houseIndex]!;
            if (captured.has(houseIndex)) adjacentCaptured = true;
            if (house.isBulaVault && house.bulaHouseTeam < 0) adjacentUnclaimed = true;
          }
          let effect = cell.bulaDotEffects[i];
          if (owner > 0 && adjacentCaptured && !effect) {
            effect = { startTick: this.tick, hideAfter: false };
            cell.bulaDotEffects[i] = effect;
          }
          if (!adjacentUnclaimed) {
            if (effect) effect.hideAfter = true;
            else cell.bulaDots[i] = -2;
          }
        }
      }
    }
  }

  private updateBulaDotEffects(): void {
    for (const cell of this.cells) {
      for (let i = 0; i < cell.bulaDotEffects.length; i++) {
        const effect = cell.bulaDotEffects[i];
        if (!effect || this.tick - effect.startTick < this.bulaDotEatenTicks) continue;
        if (effect.hideAfter) cell.bulaDots[i] = -2;
        cell.bulaDotEffects[i] = null;
      }
    }
  }

  // Local fallback for results: owned block count, not the unknown server multiplier.
  computeBulaTeamScore(team: number): number {
    return this.cells.filter(c => c.bulaHouseTeam === team).length;
  }

  private spawnEventGoldFlagOnOpenCell(): void {
    const open: [number, number][] = [];
    for (let y = 1; y < this.height - 1; y++) {
      for (let x = 1; x < this.width - 1; x++) {
        const c = this.cellAt(x, y);
        if (c && !c.blocksWalk && c.blockKind === 0) {
          const nearSpawn = this.players.some(
            (p) => Math.abs(Math.floor(p.px / CELL_PX) - x) + Math.abs(Math.floor(p.py / CELL_PX) - y) <= 2,
          );
          if (!nearSpawn) open.push([x, y]);
        }
      }
    }
    if (open.length === 0) return;
    const [fx, fy] = open[this.rng.nextInt(open.length)]!;
    this.items.push({
      id: this.nextEntityId++,
      cx: fx,
      cy: fy,
      objectName: "GoldFlag",
      iconSprite: "Item/ItemGoldFlag",
      pickupFlag: 98,
      effectId: 100,
      spawnTick: this.tick,
    });
  }

  private evaluateVictory(): void {
    if (this.finished) return;

    // 0. Bonus Coin Rush Stage (`CBonusComponent`, `componentMode === 4`, `Map/Bonus01..07`):
    if (this.componentMode === 4) {
      if (this.players.some((p) => p.state === "dying")) return;
      const initialTeams = new Set(this.players.map((p) => p.team));
      const aliveTeams = new Set(this.players.filter((p) => p.state !== "dead").map((p) => p.team));
      const allCoinsSwept = this.bonusCoinsTotal > 0 && this.bonusCoinsCollected >= this.bonusCoinsTotal;
      const lastTeamStanding = initialTeams.size >= 2 && aliveTeams.size <= 1;
      const allDead = aliveTeams.size === 0;

      if (allCoinsSwept || lastTeamStanding || allDead || this.ticksRemaining === 0) {
        this.finished = true;
        if (allDead) {
          this.winnerTeam = -1;
          this.winnerSlots = [];
          this.sounds.push("Lose");
        } else if (initialTeams.size === 1) {
          const soloTeam = [...initialTeams][0]!;
          this.winnerTeam = soloTeam;
          this.winnerSlots = this.players.map((p) => p.slot);
          this.sounds.push("Win");
        } else if (lastTeamStanding && !allCoinsSwept && this.ticksRemaining > 0) {
          const winTeam = [...aliveTeams][0]!;
          this.winnerTeam = winTeam;
          this.winnerSlots = this.players.filter((p) => p.team === winTeam).map((p) => p.slot);
          this.sounds.push("Win");
        } else {
          // Rank teams by collected `bonusLucci`!
          const teamLucci = new Map<number, number>();
          for (const p of this.players) {
            teamLucci.set(p.team, (teamLucci.get(p.team) ?? 0) + p.bonusLucci);
          }
          let topTeam = -1;
          let topAmt = -1;
          let tied = false;
          for (const [tm, amt] of teamLucci) {
            if (amt > topAmt) {
              topAmt = amt;
              topTeam = tm;
              tied = false;
            } else if (amt === topAmt) {
              tied = true;
            }
          }
          this.winnerTeam = tied || topAmt <= 0 ? -1 : topTeam;
          this.winnerSlots =
            this.winnerTeam < 0 ? [] : this.players.filter((p) => p.team === this.winnerTeam).map((p) => p.slot);
          this.sounds.push(this.winnerTeam < 0 ? "Draw" : "Win");
        }
      }
      return;
    }

    // 1. Bula Treasure Island (`CBulaComponent`, `componentMode === 2`):
    if (this.componentMode === 2) {
      if (this.players.some((p) => p.state === "dying")) return;
      const totalVaults = this.cells.filter((c) => c.isBulaVault).length;
      const unopenedVaults = this.cells.filter((c) => c.isBulaVault && c.bulaHouseTeam === -1).length;

      if (this.bulaCompetitive) {
        const aliveTeams = new Set(this.players.filter((p) => p.state !== "dead").map((p) => p.team));
        const allClaimed = totalVaults > 0 && unopenedVaults === 0;

        if (aliveTeams.size <= 1 || this.ticksRemaining === 0 || allClaimed) {
          this.finished = true;
          if (aliveTeams.size === 1 && this.ticksRemaining > 0 && !allClaimed) {
            const winTeam = [...aliveTeams][0]!;
            this.winnerTeam = winTeam;
            this.winnerSlots = this.players.filter((p) => p.team === winTeam).map((p) => p.slot);
            this.sounds.push("Win");
            return;
          }
          const teams = new Set(this.players.map((p) => p.team));
          let bestTeam = -1;
          let bestScore = -1;
          let tied = false;
          for (const t of teams) {
            const sc = this.computeBulaTeamScore(t);
            if (sc > bestScore) {
              bestScore = sc;
              bestTeam = t;
              tied = false;
            } else if (sc === bestScore) {
              tied = true;
            }
          }
          this.winnerTeam = tied || bestScore <= 0 ? -1 : bestTeam;
          this.winnerSlots =
            this.winnerTeam < 0 ? [] : this.players.filter((p) => p.team === this.winnerTeam).map((p) => p.slot);
          this.sounds.push(this.winnerTeam < 0 ? "Draw" : "Win");
        }
        return;
      }

      // Co-op Bula (`mode === 0 && !bulaCompetitive`): win when all Souls are cleared OR all `Bf*` treasure vaults opened!
      const anyAlive = this.players.some((p) => p.state !== "dead");
      const allSoulsCleared = this.initialSoulCount > 0 && this.souls.length === 0;
      const allVaultsOpened = totalVaults > 0 && unopenedVaults === 0;
      if ((allSoulsCleared || allVaultsOpened) && anyAlive) {
        this.finished = true;
        this.winnerTeam = 0;
        this.winnerSlots = this.players.map((p) => p.slot);
        this.sounds.push("Win");
        return;
      }
      if (!anyAlive || this.ticksRemaining === 0) {
        this.finished = true;
        this.winnerTeam = -1;
        this.winnerSlots = [];
        this.sounds.push("Lose");
      }
      return;
    }

    // 1b. Event2004 Golden Flag (`CEvent2004Component`, `componentMode === 3`):
    // If a player/team collects all `eventTargetFlags` Golden Flags, immediate Event Victory!
    if (this.componentMode === 3 && this.eventTargetFlags > 0) {
      const teamFlags = new Map<number, number>();
      for (const p of this.players) {
        if ((p.goldFlags ?? 0) > 0) {
          teamFlags.set(p.team, (teamFlags.get(p.team) ?? 0) + (p.goldFlags ?? 0));
        }
      }
      for (const [team, cnt] of teamFlags) {
        if (cnt >= this.eventTargetFlags) {
          this.finished = true;
          this.winnerTeam = team;
          this.winnerSlots = this.players.filter((p) => p.team === team).map((p) => p.slot);
          this.sounds.push("Win");
          return;
        }
      }
    }

    // 2. Kart Racing (`CKartComponent`, `componentMode === 1`):
    // Race finishes immediately in `updateKartProgress` when a racer crosses `Start_*` after `kartTotalLaps`,
    // or here if all racers are eliminated or the match timer expires!
    if (this.componentMode === 1) {
      if (this.players.some((p) => p.state === "dying")) return;
      const alive = this.players.filter((p) => p.state !== "dead");
      if (alive.length === 0 || this.ticksRemaining === 0) {
        this.finished = true;
        const leader = alive.find((p) => p.isFirstPlace) ?? (this.players.length === 1 ? alive[0] : undefined);
        if (leader && (leader.kartLap ?? 0) > 0) {
          this.winnerTeam = leader.team;
          this.winnerSlots = this.players.filter((p) => p.team === leader.team).map((p) => p.slot);
          this.sounds.push("Win");
        } else {
          this.winnerTeam = -1;
          this.winnerSlots = [];
          this.sounds.push("Draw");
        }
      }
      return;
    }

    if (this.players.length <= 1) {
      // Solo practice exploration: finish only if player died or timer expired
      const solo = this.players[0];
      if (!solo || solo.state === "dead" || this.ticksRemaining === 0) {
        this.finished = true;
        this.winnerTeam = solo && solo.state !== "dead" ? solo.team : -1;
        this.winnerSlots = solo && solo.state !== "dead" ? [solo.slot] : [];
        this.sounds.push(this.winnerTeam >= 0 ? "Win" : "Lose");
      }
      return;
    }

    // Mode 4 (KillCount / Respawn): finishes on target kills (10) or timer = 0
    if (this.mode === 4) {
      const teamKills = new Map<number, number>();
      for (const p of this.players) {
        teamKills.set(p.team, (teamKills.get(p.team) ?? 0) + p.kills);
      }
      let topTeam = -1;
      let topScore = -1;
      let tied = false;
      for (const [team, k] of teamKills) {
        if (k > topScore) {
          topScore = k;
          topTeam = team;
          tied = false;
        } else if (k === topScore) {
          tied = true;
        }
      }
      const aliveSurvivalTeams = new Set(
        this.players.filter((p) => p.state !== "dead").map((p) => p.team),
      );
      const suddenEliminated =
        this.hurryUp &&
        !this.players.some((p) => p.state === "dying") &&
        aliveSurvivalTeams.size <= 1;
      if (topScore >= 10 || this.ticksRemaining === 0 || suddenEliminated) {
        this.finished = true;
        if (suddenEliminated && aliveSurvivalTeams.size === 1) {
          const lastTeam = [...aliveSurvivalTeams][0]!;
          this.winnerTeam = lastTeam;
          this.winnerSlots = this.players.filter((p) => p.team === lastTeam).map((p) => p.slot);
          this.sounds.push("Win");
        } else {
          this.winnerTeam = tied ? -1 : topTeam;
          this.winnerSlots = tied ? [] : this.players.filter((p) => p.team === topTeam).map((p) => p.slot);
          this.sounds.push(tied ? "Draw" : "Win");
        }
      }
      return;
    }

    // Mode 1 (Captain): if a team's Captain is dead, wipe out remaining members of that team
    if (this.mode === 1) {
      const deadCaptainTeams = new Set<number>();
      for (const p of this.players) {
        if (p.isCaptain && p.state === "dead") {
          deadCaptainTeams.add(p.team);
        }
      }
      if (deadCaptainTeams.size > 0) {
        for (const p of this.players) {
          if (deadCaptainTeams.has(p.team) && p.state !== "dead" && p.state !== "dying") {
            this.killPlayer(p, -1);
          }
        }
      }
    }

    // Wait until any "dying" animation completes before declaring final result so double-KOs register as Draw!
    if (this.players.some((p) => p.state === "dying")) return;

    const aliveTeams = new Set<number>();
    for (const p of this.players) {
      if (p.state !== "dead") aliveTeams.add(p.team);
    }

    if (aliveTeams.size <= 1 || this.ticksRemaining === 0) {
      this.finished = true;
      if (aliveTeams.size === 1) {
        const winTeam = [...aliveTeams][0]!;
        this.winnerTeam = winTeam;
        this.winnerSlots = this.players.filter((p) => p.team === winTeam).map((p) => p.slot);
        this.sounds.push("Win");
      } else {
        this.winnerTeam = -1;
        this.winnerSlots = [];
        this.sounds.push("Draw");
      }
    }
  }

  toSnapshot(): SimSnapshot {
    const anyRadar = this.players.some((p) => p.radarTicks > 0);
    const distinctTeams = new Set(this.players.map((p) => p.team));
    const perfectWin =
      this.finished &&
      this.winnerTeam >= 0 &&
      (distinctTeams.size >= 2 || this.componentMode === 2) &&
      this.players.filter((p) => p.team === this.winnerTeam).every((p) => p.deaths === 0);

    return {
      tick: this.tick,
      ticksRemaining: this.ticksRemaining,
      mode: this.mode,
      componentMode: this.componentMode,
      kartTotalLaps: this.kartTotalLaps,
      kartCheckpoints: this.kartCheckpoints,
      batSwarmTick: this.batSwarmTick,
      timebombRouletteTicks: this.timebombRouletteTicks > 0 ? this.timebombRouletteTicks : undefined,
      timebombRouletteSlot: this.timebombRouletteSlot >= 0 ? this.timebombRouletteSlot : undefined,
      bonusCoinsTotal: this.componentMode === 4 ? this.bonusCoinsTotal : undefined,
      bonusCoinsCollected: this.componentMode === 4 ? this.bonusCoinsCollected : undefined,
      mapName: this.mapName,
      width: this.width,
      height: this.height,
      originX: this.originX,
      originY: this.originY,
      finished: this.finished,
      winnerTeam: this.winnerTeam,
      winnerSlots: [...this.winnerSlots],
      perfectWin,
      hurryUp: this.hurryUp,
      cells: this.cells.map((c) => ({
        ground: c.groundObjName,
        block: c.blockObjName,
        kind: c.blockKind,
        hp: c.hp,
        maxHp: c.maxHp,
        shake: c.shakeTicks,
        hides: c.hidesUnit,
        crumble: c.crumbleTicks,
        lapCp: c.lapCheckpoint >= 0 ? c.lapCheckpoint : undefined,
        dropIcon: anyRadar && c.blockKind !== 3 && c.pendingDrop ? c.pendingDrop.iconSprite : undefined,
        bulaHouseTeam: c.bulaHouseTeam >= 0 ? c.bulaHouseTeam : undefined,
        bulaHouseEligible: this.componentMode === 2 && c.isBulaVault ? true : undefined,
        bulaHouseVar: c.isBulaVault ? c.bulaVaultVariant : undefined,
        bulaDots: this.componentMode === 2 ? [...c.bulaDots] : undefined,
        bulaDotEffects: this.componentMode === 2 ? c.bulaDotEffects.map(effect => effect ? { ...effect } : null) : undefined,
      })),
      items: this.items.map((i) => ({ ...i })),
      bombs: this.bombs.map((b) => ({ ...b, passThroughSlots: [...b.passThroughSlots] })),
      flames: this.flames.map((f) => ({ ...f })),
      pushBoxes: this.pushBoxes.map((pb) => ({ ...pb })),
      darts: this.darts.map((d) => ({ ...d })),
      hazards: this.hazards.map((h) => ({ ...h })),
      souls: this.souls.map((s) => ({ ...s })),
      footprints: this.footprints.map((fp) => ({ ...fp })),
      coinPopups: this.coinPopups.length > 0 ? this.coinPopups.map((cp) => ({ ...cp })) : undefined,
      airplane: this.airplane ? { px: this.airplane.px, py: this.airplane.py } : null,
      ghost: this.ghost ? { ...this.ghost } : null,
      players: this.players.map((p) => ({
        ...p,
        activeSlots: [...p.activeSlots] as [number, number, number, number, number, number],
        charDecoCodes: p.charDecoCodes ? [...p.charDecoCodes] : undefined,
      })),
      sounds: [...this.sounds],
    };
  }
}
