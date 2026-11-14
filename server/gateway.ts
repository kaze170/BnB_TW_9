// Authoritative Retail BnB v9 Server Gateway (`server/gateway.ts`)
// Speaks `CClientSocket` encrypted binary framing (`src/net/protocol.ts`),
// preserving legacy opcodes `0x10..0x18` AND powering full `OP_RPC = 0x40`
// multiplayer rooms, 30ms authoritative `GameSimulation`, `/bot` AI, 1,461-item
// SQLite Shop/MyItem economy, Rankings, Friends, SMS, and 1-on-1 Item/Lucci Exchange.

import { join } from "node:path";
import { PacketReader, PacketWriter } from "../src/net/packet.ts";
import type { Lobby, PeerSocket } from "../src/net/lobby.ts";
import { readChannelFile, type Channel } from "../src/data/channel.ts";
import { readServerList, mergeWithBuiltins, type ServerEndpoint } from "../src/data/serverlist.ts";
import { Pack } from "../src/data/pack.ts";
import { readSsi } from "../src/data/ssi.ts";
import { includeArchiveMaps, parseMapInfo, type MapInfo } from "../src/data/mapinfo.ts";
import {
  ObjectTable,
  parseBomberAttr,
  parseFxStock,
  parseItemAttr,
  parseMapBinary,
  parsePackageMap,
  parseTileInfo,
  type BomberSpec,
  type ItemAttrTable,
  type ParsedMapData,
  type StockItem,
  type TileSpec,
} from "../src/data/tables.ts";
import {
  ACTIVE_CAN,
  ACTIVE_DART,
  ACTIVE_NEEDLE,
  ACTIVE_RADAR,
  ACTIVE_REMOTE,
  ACTIVE_SHIELD,
  ACTIVE_SPRING,
  GameSimulation,
  TICK_MS,
  type GameModeId,
  type MatchParticipantInit,
  type PlayerInput,
} from "../src/sim/engine.ts";
import { computeAiInput } from "../src/sim/ai.ts";
import {
  OP_RPC,
  type ClientMsg,
  type ExchangeState,
  type LobbyUserSummary,
  type MatchRewardRow,
  type RoomDetail,
  type RoomKind,
  type RoomSlotInfo,
  type RoomSummary,
  type ServerMsg,
} from "../src/net/messages.ts";
import { GameDatabase } from "./db.ts";

export const OP = {
  Confirm: 0x01,
  Login: 0x10,
  LoginResult: 0x11,
  ChannelList: 0x12,
  JoinChannel: 0x13,
  JoinResult: 0x14,
  RoomList: 0x15,
  EnterRoom: 0x16,
  EnterResult: 0x17,
  LeaveRoom: 0x18,
  Rpc: OP_RPC,
} as const;

const ROOT = new URL("..", import.meta.url).pathname;
const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

let CHANNELS: Channel[] = [];
let ENDPOINTS: ServerEndpoint[] = [];
let FX_PACK: Pack | null = null;
let OBJECT_TABLE: ObjectTable | null = null;
let BOMBER_BY_CODE = new Map<number, BomberSpec>();
let ITEM_ATTR: ItemAttrTable | null = null;
let TILE_INFO = new Map<string, TileSpec>();
let ALL_MAPS: MapInfo[] = [];
let PLAYABLE_MAPS: MapInfo[] = [];
const PARSED_MAP_CACHE = new Map<string, ParsedMapData>();
let DB: GameDatabase | null = null;

export async function loadRetailData(): Promise<void> {
  const [chBytes, svBytes, fxIdx, fxIdd, mapSsd, stockIni, pkgIni] = await Promise.all([
    Bun.file(join(ROOT, "channel2_000.ssd")).bytes(),
    Bun.file(join(ROOT, "multisvr.ssd")).bytes(),
    Bun.file(join(ROOT, "Fx.idx")).bytes(),
    Bun.file(join(ROOT, "Fx.idd")).bytes(),
    Bun.file(join(ROOT, "fxdynmapinfo.ssd")).bytes(),
    Bun.file(join(ROOT, "fxstock.ini")).bytes(),
    Bun.file(join(ROOT, "packagemap.ini")).bytes(),
  ]);

  CHANNELS = readChannelFile(chBytes, "channel2_000.ssd")?.channels ?? [];
  ENDPOINTS = mergeWithBuiltins(readServerList(svBytes));

  FX_PACK = new Pack("Fx", fxIdx, fxIdd);
  OBJECT_TABLE = new ObjectTable(FX_PACK.payload("ObjectTable/ObjectTable")!);
  const bombers = parseBomberAttr(FX_PACK.payload("Attr/BomberAttr")!);
  BOMBER_BY_CODE = new Map(bombers.map((b) => [b.code, b]));
  ITEM_ATTR = parseItemAttr(FX_PACK.payload("Attr/ItemAttr")!);
  TILE_INFO = parseTileInfo(FX_PACK.payload("TileInfo/TileInfo")!);

  const mapSsi = readSsi(mapSsd);
  ALL_MAPS = includeArchiveMaps(
    (mapSsi ? parseMapInfo(mapSsi.payload) : null) ?? { count: 0, maps: [] },
    FX_PACK.entries.map(e => e.name),
  ).maps;
  PLAYABLE_MAPS = ALL_MAPS.filter((m) => !m.random && FX_PACK!.has(`Map/${m.name}`));

  const fxStock: StockItem[] = parseFxStock(stockIni);
  const stockById = new Map(fxStock.map((s) => [s.id, s]));
  const packageMap = parsePackageMap(pkgIni);

  DB = new GameDatabase(join(ROOT, "bnb_tw9.sqlite"), stockById, packageMap);
}

export function retailChannels(): readonly Channel[] {
  return CHANNELS;
}

export function retailEndpoints(): readonly ServerEndpoint[] {
  return ENDPOINTS;
}

function getParsedMap(mapName: string): ParsedMapData | null {
  let cached = PARSED_MAP_CACHE.get(mapName);
  if (cached) return cached;
  const raw = FX_PACK?.payload(`Map/${mapName}`);
  if (!raw) return null;
  cached = parseMapBinary(mapName, raw);
  PARSED_MAP_CACHE.set(mapName, cached);
  return cached;
}

function resolvePlayableMap(mapIndex: number): MapInfo {
  if (mapIndex < 0 && PLAYABLE_MAPS.length > 0) {
    return PLAYABLE_MAPS[Math.floor(Math.random() * PLAYABLE_MAPS.length)]!;
  }
  const found = ALL_MAPS.find((m) => m.index === mapIndex);
  if (found && !found.random && FX_PACK?.has(`Map/${found.name}`)) {
    return found;
  }
  if (found && found.random) {
    const fam = PLAYABLE_MAPS.filter(
      (m) => found.family === "Random" || m.family.toLowerCase() === found.family.toLowerCase(),
    );
    if (fam.length > 0) return fam[Math.floor(Math.random() * fam.length)]!;
  }
  const patrit = PLAYABLE_MAPS.find((m) => m.name === "Patrit00" || m.name === "Camp01");
  return patrit ?? PLAYABLE_MAPS[0]!;
}

// --- Connected Session & Room State ---

interface ClientSession {
  peer: PeerSocket;
  accountId: number;
  username: string;
  nickname: string;
  dual2P: boolean;
  channelIdx: number; // -1 = server select
  roomId: number;     // 0 = lobby
  slot: number;       // primary slot 0..7 in room
  slot2P: number;     // -1 or guest 2P slot 0..7 in room
  pendingQuestionMarks?: number;
}

interface ServerRoom {
  id: number;
  channelIdx: number;
  title: string;
  password: string;
  manner: boolean;
  kind: RoomKind;
  guildType?: 0 | 1;
  mode: GameModeId;
  mapIndex: number;
  mapName: string;
  playing: boolean;
  createdAtMs: number;
  startedAtMs: number;
  hostSlot: number;
  slots: RoomSlotInfo[];
  peersBySlot: (ClientSession | null)[];
  sim: GameSimulation | null;
  simTimer: ReturnType<typeof setInterval> | null;
  initialNeedlesBySlot: number[];
  // Exchange room state (for kind === "exchange")
  exInvIds: [number[], number[]];
  exLucci: [number, number];
  exLocked: [boolean, boolean];
  exConfirmed: [boolean, boolean];
}

const sessionsByPeer = new Map<PeerSocket, ClientSession>();
const sessionsByUser = new Map<string, ClientSession>(); // lowercase username -> session
const roomsById = new Map<number, ServerRoom>();
let nextRoomId = 1;

function sendRpc(peer: PeerSocket, msg: ServerMsg): void {
  peer.send(OP_RPC, utf8Enc.encode(JSON.stringify(msg)));
}

function broadcastChannel(channelIdx: number, msg: ServerMsg): void {
  for (const s of sessionsByPeer.values()) {
    if (s.channelIdx === channelIdx) {
      sendRpc(s.peer, msg);
    }
  }
}

function broadcastLobby(channelIdx: number): void {
  const rooms: RoomSummary[] = [];
  for (const r of roomsById.values()) {
    if (r.channelIdx !== channelIdx) continue;
    const occupied = r.slots.filter((s) => s.occupied).length;
    const cap = r.slots.filter((s) => s.open).length;
    const host = r.slots[r.hostSlot]?.nickname || "室長";
    const occupants = r.slots
      .filter((s) => s.occupied)
      .map((s) => ({
        slot: s.slot,
        username: s.username,
        nickname: s.nickname,
        level: s.level,
        isHost: s.isHost,
        ready: s.ready,
        isAi: s.isAi,
      }));
    rooms.push({
      id: r.id,
      title: r.title,
      hasPassword: r.password.length > 0,
      manner: r.manner,
      kind: r.kind,
      mode: r.mode,
      mapIndex: r.mapIndex,
      mapName: r.mapName,
      players: occupied,
      capacity: cap,
      playing: r.playing,
      hostName: host,
      createdAtMs: r.createdAtMs,
      startedAtMs: r.startedAtMs,
      occupants,
    });
  }
  const users: LobbyUserSummary[] = [];
  for (const s of sessionsByPeer.values()) {
    if (s.channelIdx !== channelIdx || !DB) continue;
    const prof = DB.getProfileById(s.accountId);
    const dispLv = Math.max(1, Math.min(450, (prof?.level ?? 1) + (prof?.equipped.levelDisguiseDelta ?? 0)));
    users.push({
      username: s.username,
      nickname: s.nickname,
      level: dispLv,
      roomId: s.roomId,
      levelEffectIdx: prof?.equipped.levelEffectIdx,
    });
  }
  const sync: ServerMsg = { type: "lobby_sync", rooms, users };
  for (const s of sessionsByPeer.values()) {
    if (s.channelIdx === channelIdx && s.roomId === 0) {
      sendRpc(s.peer, sync);
    }
  }
}

function roomToDetail(r: ServerRoom): RoomDetail {
  return {
    id: r.id,
    channelIdx: r.channelIdx,
    title: r.title,
    hasPassword: r.password.length > 0,
    manner: r.manner,
    kind: r.kind,
    guildType: r.guildType,
    mode: r.mode,
    mapIndex: r.mapIndex,
    mapName: r.mapName,
    playing: r.playing,
    hostSlot: r.hostSlot,
    slots: r.slots.map((s) => ({ ...s })),
  };
}

function broadcastRoom(r: ServerRoom, msg: ServerMsg): void {
  const sent = new Set<PeerSocket>();
  for (const sess of r.peersBySlot) {
    if (sess && !sent.has(sess.peer)) {
      sent.add(sess.peer);
      sendRpc(sess.peer, msg);
    }
  }
}

function syncRoom(r: ServerRoom): void {
  broadcastRoom(r, { type: "room_sync", room: roomToDetail(r) });
}

function syncExchange(r: ServerRoom): void {
  if (r.kind !== "exchange" || !DB) return;
  const s0 = r.peersBySlot[0];
  const s1 = r.peersBySlot[1];
  const names: [string, string] = [s0?.nickname ?? "等待中...", s1?.nickname ?? "等待中..."];

  const resolveItems = (sess: ClientSession | null, ids: number[]) => {
    if (!sess || !DB) return [];
    const inv = DB.getInventory(sess.accountId);
    return ids
      .map((id) => inv.find((x) => x.invId === id))
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .map((x) => ({ invId: x.invId, stockId: x.stockId, qty: 1 }));
  };

  const stocks: ExchangeState["offeredStocks"] = [
    resolveItems(s0, r.exInvIds[0]),
    resolveItems(s1, r.exInvIds[1]),
  ];

  for (const side of [0, 1] as const) {
    const sess = r.peersBySlot[side];
    if (!sess) continue;
    sendRpc(sess.peer, {
      type: "exchange_sync",
      state: {
        roomId: r.id,
        mySide: side,
        users: names,
        offeredInvIds: [[...r.exInvIds[0]], [...r.exInvIds[1]]],
        offeredStocks: stocks,
        offeredLucci: [r.exLucci[0], r.exLucci[1]],
        locked: [r.exLocked[0], r.exLocked[1]],
        confirmed: [r.exConfirmed[0], r.exConfirmed[1]],
      },
    });
  }
}

function buildFriendsPayload(accountId: number): { username: string; online: boolean; channelIdx: number }[] {
  if (!DB) return [];
  return DB.getFriends(accountId).map((u) => {
    const on = sessionsByUser.get(u.toLowerCase());
    return {
      username: u,
      online: Boolean(on),
      channelIdx: on ? on.channelIdx : -1,
    };
  });
}

function emptySlot(slot: number, open = true): RoomSlotInfo {
  return {
    slot,
    open,
    occupied: false,
    isAi: false,
    aiLevel: 2,
    username: "",
    nickname: "",
    level: 1,
    charCode: 0,
    team: slot % 2,
    ready: false,
    isHost: false,
    slotDecoStockId: 0,
    hatStockId: 0,
    emotionPose: 0,
  };
}

function leaveCurrentRoom(sess: ClientSession, notifySelf = true): void {
  if (sess.roomId === 0) return;
  const r = roomsById.get(sess.roomId);
  sess.roomId = 0;
  const oldSlot = sess.slot;
  const oldSlot2P = sess.slot2P;
  sess.slot = -1;
  sess.slot2P = -1;
  if (notifySelf) sendRpc(sess.peer, { type: "room_left" });
  if (!r) return;

  for (const sl of [oldSlot, oldSlot2P]) {
    if (sl >= 0 && sl < 8 && r.peersBySlot[sl] === sess) {
      r.peersBySlot[sl] = null;
      r.slots[sl] = emptySlot(sl, true);
    }
  }

  // Reset exchange locks if anyone leaves an exchange room
  if (r.kind === "exchange") {
    r.exInvIds = [[], []];
    r.exLucci = [0, 0];
    r.exLocked = [false, false];
    r.exConfirmed = [false, false];
  }

  // Find remaining human peers
  const remainingHumanSlot = r.peersBySlot.findIndex((p) => p !== null);
  if (remainingHumanSlot === -1) {
    if (r.simTimer) clearInterval(r.simTimer);
    r.simTimer = null;
    r.sim = null;
    roomsById.delete(r.id);
    broadcastLobby(r.channelIdx);
    return;
  }

  if (r.hostSlot === oldSlot) {
    r.hostSlot = remainingHumanSlot;
    for (const s of r.slots) s.isHost = s.slot === r.hostSlot;
    r.slots[r.hostSlot]!.ready = true;
  }

  syncRoom(r);
  if (r.kind === "exchange") syncExchange(r);
  broadcastLobby(r.channelIdx);
}

function startRoomMatch(r: ServerRoom): void {
  if (r.playing || !OBJECT_TABLE || !ITEM_ATTR || !DB) return;

  const chosenMap = resolvePlayableMap(r.mapIndex);
  const mapData = getParsedMap(chosenMap.name);
  if (!mapData) return;

  const occupied = r.slots.filter((s) => s.occupied);
  if (occupied.length === 0) return;

  // Check if all occupied slots share one team -> switch to individual FFA teams (0..7) so solo/FFA works!
  const distinctTeams = new Set(occupied.map((s) => s.team));
  const forceFfa = occupied.length > 1 && distinctTeams.size === 1;

  const participants: MatchParticipantInit[] = [];
  r.initialNeedlesBySlot = new Array(8).fill(0);

  for (const sl of occupied) {
    const sess = r.peersBySlot[sl.slot];
    let needles = 1;
    let shields = 0;
    let initialSpeedBonus = 0;
    let initialPowerBonus = 0;
    let initialRadarTicks = 0;
    let activeSlotCap = 4;
    let hasSpanner = false;
    const activeItems: number[] = [];
    if (sess && !sl.is2P && !sl.isAi) {
      const inv = DB.getInventory(sess.accountId);
      // `cat=13` ItemBag (`1208` -> 5 slots) / ItemBag2 (`1212` -> 6 slots)!
      if (inv.some((i) => i.category === 13 && DB!.stockById.get(i.stockId)?.avatarCode === 10016 && i.quantity > 0)) {
        activeSlotCap = 6;
      } else if (inv.some((i) => i.category === 13 && i.quantity > 0)) {
        activeSlotCap = 5;
      }
      const needleQty = inv
        .filter((i) => i.category === 1 && DB!.stockById.get(i.stockId)?.avatarCode === 1)
        .reduce((a, b) => a + b.quantity, 0);
      needles = Math.max(1, Math.min(2, needleQty));
      r.initialNeedlesBySlot[sl.slot] = needles;
      const equippedBattle = inv.find((i) => i.category === 1 && i.equipped && i.quantity > 0);
      if (equippedBattle) {
        const av = DB.stockById.get(equippedBattle.stockId)?.avatarCode ?? 0;
        if (av === 77) {
          shields = 1; // 藥水: +2 starting Water Power + Shield!
          initialPowerBonus = 2;
        } else if (av === 2) {
          activeItems.push(ACTIVE_DART, ACTIVE_DART); // 飛鏢
        } else if (av === 75 || av === 654 || av === 655) {
          activeItems.push(ACTIVE_CAN); // 罐頭 / 機油 / 汽油
        } else if (av === 78) {
          activeItems.push(ACTIVE_RADAR); // 透視鏡: immediate 18s X-Ray + Radar charge!
          initialRadarTicks = 600;
        } else if (av === 173) {
          activeItems.push(ACTIVE_SPRING, ACTIVE_SPRING); // 彈簧鞋
        } else if (av === 10009) {
          activeItems.push(ACTIVE_REMOTE); // 無線深水炸彈
        } else if (av === 74) {
          shields = 1; // 扳手: Kart fuel regen + Shield!
          hasSpanner = true;
        } else if (av === 76) {
          initialSpeedBonus = 2; // 馬達: +2 starting Roller Speed!
        }
        if (av !== 1) {
          DB.consumeStock(sess.accountId, equippedBattle.stockId, 1);
        }
      }
    }
    participants.push({
      slot: sl.slot,
      name: sl.nickname,
      charCode: sl.charCode,
      team: forceFfa ? sl.slot : sl.team,
      isAi: sl.isAi,
      aiLevel: sl.aiLevel,
      initialNeedles: needles,
      initialShields: shields,
      initialActiveItems: activeItems.length > 0 ? activeItems : undefined,
      initialSpeedBonus: initialSpeedBonus > 0 ? initialSpeedBonus : undefined,
      initialPowerBonus: initialPowerBonus > 0 ? initialPowerBonus : undefined,
      initialRadarTicks: initialRadarTicks > 0 ? initialRadarTicks : undefined,
      activeSlotCap,
      hasSpanner: hasSpanner || undefined,
      hatCode: sl.hatStockId,
      charDecoCodes: sl.charDecoStockIds ? [...sl.charDecoStockIds] : undefined,
      bombSkinCode: sl.bombStockId ?? 0,
      idDecoCode: sl.idDecoStockId ?? 0,
    });
  }

  const sim = new GameSimulation({
    mapData,
    mode: r.mode,
    participants,
    objectTable: OBJECT_TABLE,
    bomberByCode: BOMBER_BY_CODE,
    itemAttr: ITEM_ATTR,
    tileInfo: TILE_INFO,
  });

  r.playing = true;
  r.startedAtMs = Date.now();
  r.sim = sim;
  broadcastLobby(r.channelIdx);

  const initSnap = sim.toSnapshot();
  const sent = new Set<PeerSocket>();
  for (const sess of r.peersBySlot) {
    if (sess && !sent.has(sess.peer)) {
      sent.add(sess.peer);
      sendRpc(sess.peer, {
        type: "match_start",
        snapshot: initSnap,
        mySlot: sess.slot,
        slot2P: sess.slot2P,
      });
    }
  }

  r.simTimer = setInterval(() => {
    if (!r.sim) return;
    // Drive server-side AI bots
    for (const p of r.sim.players) {
      if (p.isAi) {
        r.sim.setInput(p.slot, computeAiInput(r.sim, p));
      }
    }
    r.sim.step();
    broadcastRoom(r, { type: "match_state", snapshot: r.sim.toSnapshot() });

    if (r.sim.finished && r.sim.finishCooldownTicks === 67) {
      awardRoomMatch(r);
    }
    // Leave the results visible after rewards arrive rather than immediately
    // switching back to the room in the same network batch.
    if (r.sim.finished && r.sim.finishCooldownTicks >= 180) {
      finishRoomMatch(r);
    }
  }, TICK_MS);
}

function awardRoomMatch(r: ServerRoom): void {
  const sim = r.sim;
  if (sim && DB) {
    // Check host room privileges (`貴賓包廂券 RoomTicket` `avatarCode=10005` +15% room EXP; `超級室長券 SuperChief` `avatarCode=72` +20% host Lucci)
    const hostSess = r.hostSlot >= 0 ? r.peersBySlot[r.hostSlot] : null;
    const hostInv = hostSess ? DB.getInventory(hostSess.accountId) : [];
    const hasRoomTicket = hostInv.some(
      (i) => i.category === 2 && DB!.stockById.get(i.stockId)?.avatarCode === 10005 && i.quantity > 0,
    );
    const hostHasSuperChief = hostInv.some(
      (i) => i.category === 2 && DB!.stockById.get(i.stockId)?.avatarCode === 72 && i.quantity > 0,
    );
    const rewards: MatchRewardRow[] = [];
    for (const p of sim.players) {
      const won = sim.winnerTeam >= 0 && p.team === sim.winnerTeam;
      const outcome: "win" | "loss" | "draw" =
        sim.winnerTeam < 0 ? "draw" : won ? "win" : "loss";
      const sess = r.peersBySlot[p.slot];
      if (sess && !p.isAi && sess.slot === p.slot) {
        const remainingNeedles = p.activeSlots.filter((x) => x === ACTIVE_NEEDLE).length;
        const usedNeedles = Math.max(0, (r.initialNeedlesBySlot[p.slot] ?? 0) - remainingNeedles);
        const roomExpMult = hasRoomTicket ? 1.15 : 1;
        const hostLucciMult = p.slot === r.hostSlot && hostHasSuperChief ? 1.2 : 1;
        const rec = DB.recordMatchOutcome(
          sess.accountId,
          outcome,
          p.kills,
          p.saves,
          usedNeedles,
          p.bonusLucci,
          roomExpMult,
          hostLucciMult,
        );
        const sl = r.slots[p.slot];
        if (sl) sl.level = rec.newLevel;
        const qmEarned = p.questionMarks ?? 0;
        if (qmEarned > 0) {
          sess.pendingQuestionMarks = (sess.pendingQuestionMarks ?? 0) + qmEarned;
        }
        rewards.push({
          slot: p.slot,
          name: p.name,
          team: p.team,
          won,
          kills: p.kills,
          deaths: p.deaths,
          maxCombo: p.maxCombo ?? 0,
          saves: p.saves,
          expGain: rec.expGain,
          expProgressTenths: rec.expProgressTenths,
          lucciGain: rec.lucciGain,
          newLevel: rec.newLevel,
          leveledUp: rec.leveledUp,
          questionMarks: qmEarned > 0 ? qmEarned : undefined,
          goldFlags: (p.goldFlags ?? 0) > 0 ? p.goldFlags : undefined,
        });
        const prof = DB.getProfileById(sess.accountId);
        if (prof) {
          sendRpc(sess.peer, {
            type: "inventory_sync",
            inventory: DB.getInventory(sess.accountId),
            profile: prof,
          });
        }
      } else {
        rewards.push({
          slot: p.slot,
          name: p.name,
          team: p.team,
          won,
          kills: p.kills,
          deaths: p.deaths,
          maxCombo: p.maxCombo ?? 0,
          saves: p.saves,
          expGain: won ? 100 : 40,
          lucciGain: (won ? 200 : 60) + Math.max(0, p.bonusLucci),
          newLevel: r.slots[p.slot]?.level ?? 1,
          leveledUp: false,
        });
      }
    }
    broadcastRoom(r, { type: "match_result", rewards, winnerTeam: sim.winnerTeam });
  }
}

function finishRoomMatch(r: ServerRoom): void {
  if (r.simTimer) clearInterval(r.simTimer);
  r.simTimer = null;
  r.sim = null;
  r.playing = false;

  // Reset non-host human ready flags for next round
  for (const sl of r.slots) {
    if (sl.occupied && !sl.isHost && !sl.isAi && !sl.is2P) {
      sl.ready = false;
    }
  }
  syncRoom(r);
  broadcastLobby(r.channelIdx);
}

function handleRpcMessage(peer: PeerSocket, msg: ClientMsg): void {
  if (!DB) return;

  if (msg.type === "auth_check_id") {
    const avail = DB.isUsernameAvailable(msg.username);
    sendRpc(peer, {
      type: "auth_check_res",
      available: avail,
      message: avail ? `帳號「${msg.username.trim()}」可以使用！` : "此帳號已被使用或長度不符 (2~16字)",
    });
    return;
  }

  if (msg.type === "auth_register") {
    const res = DB.registerAccount(msg.username, msg.password, msg.nickname, msg.gender);
    if (!res.ok) {
      sendRpc(peer, { type: "auth_err", message: res.message });
      return;
    }
    completeAuth(peer, res.profile.id, false);
    return;
  }

  if (msg.type === "auth_login") {
    const res = DB.loginOrCreate(msg.username, msg.password);
    if (!res.ok) {
      sendRpc(peer, { type: "auth_err", message: res.message });
      return;
    }
    completeAuth(peer, res.profile.id, Boolean(msg.dual2P));
    return;
  }

  const sess = sessionsByPeer.get(peer);
  if (!sess) {
    sendRpc(peer, { type: "auth_err", message: "請先登入帳號" });
    return;
  }

  switch (msg.type) {
    case "join_channel": {
      leaveCurrentRoom(sess, false);
      const idx = Math.max(0, Math.min(CHANNELS.length - 1, msg.channelIdx));
      sess.channelIdx = idx;
      const ch = CHANNELS[idx];
      sendRpc(peer, { type: "channel_joined", channelIdx: idx, channelName: ch?.name ?? "BnB自由頻道" });
      broadcastLobby(idx);
      return;
    }

    case "lobby_refresh": {
      if (sess.channelIdx >= 0) broadcastLobby(sess.channelIdx);
      return;
    }

    case "create_room": {
      leaveCurrentRoom(sess, false);
      const id = nextRoomId++;
      const kind = msg.kind;
      const slotCount = kind === "chat" ? 12 : 8;
      const maxOpen = kind === "exchange" ? 2 : Math.max(2, Math.min(slotCount, msg.capacity || slotCount));
      const foundMap = msg.mapIndex >= 0 ? ALL_MAPS.find((m) => m.index === msg.mapIndex) : undefined;
      const initialMapIndex = msg.mapIndex < 0 ? -1 : (foundMap?.index ?? resolvePlayableMap(msg.mapIndex).index);
      const initialMapName =
        msg.mapIndex < 0 ? "Random" : (foundMap?.name ?? resolvePlayableMap(msg.mapIndex).name);
      const prof = DB.getProfileById(sess.accountId)!;

      const slots: RoomSlotInfo[] = Array.from({ length: slotCount }, (_, i) => emptySlot(i, i < maxOpen));
      slots[0] = {
        slot: 0,
        open: true,
        occupied: true,
        isAi: false,
        aiLevel: 2,
        username: sess.username,
        nickname: sess.nickname,
        level: Math.max(1, Math.min(450, prof.level + (prof.equipped.levelDisguiseDelta ?? 0))),
        charCode: prof.selectedChar,
        team: 0,
        ready: true,
        isHost: true,
        slotDecoStockId: prof.equipped.slotDecoStockId,
        slotDecoStockIds: prof.equipped.slotDecoStockIds ? [...prof.equipped.slotDecoStockIds] : undefined,
        hatStockId: prof.equipped.hatStockId,
        charDecoStockIds: prof.equipped.charDecoStockIds ? [...prof.equipped.charDecoStockIds] : undefined,
        bombStockId: prof.equipped.bombStockId,
        fanfareStockId: prof.equipped.fanfareStockId,
        idDecoStockId: prof.equipped.idDecoStockId,
        levelEffectIdx: prof.equipped.levelEffectIdx,
        emotionPose: 0,
      };

      const peersBySlot: (ClientSession | null)[] = new Array(slotCount).fill(null);
      peersBySlot[0] = sess;
      sess.roomId = id;
      sess.slot = 0;
      sess.slot2P = -1;

      // Auto-attach 2P guest if user logged in with 2P mode!
      if (sess.dual2P && (kind === "game" || kind === "guild") && maxOpen >= 2) {
        slots[1] = {
          slot: 1,
          open: true,
          occupied: true,
          isAi: false,
          aiLevel: 2,
          username: `${sess.username}_2P`,
          nickname: `${sess.nickname}(2P)`,
          level: prof.level,
          charCode: (prof.selectedChar + 1) % 8,
          team: 1,
          ready: true,
          isHost: false,
          is2P: true,
          slotDecoStockId: prof.equipped.slotDecoStockId,
          hatStockId: 0,
          emotionPose: 0,
        };
        peersBySlot[1] = sess;
        sess.slot2P = 1;
      }

      const room: ServerRoom = {
        id,
        channelIdx: Math.max(0, sess.channelIdx),
        title: (msg.title.trim() || "一起來玩水球吧！").slice(0, 24),
        password: msg.password.trim().slice(0, 12),
        manner: msg.manner !== false,
        kind,
        guildType: kind === "guild" ? (msg.guildType ?? 0) : undefined,
        mode: msg.mode,
        mapIndex: initialMapIndex,
        mapName: initialMapName,
        playing: false,
        createdAtMs: Date.now(),
        startedAtMs: 0,
        hostSlot: 0,
        slots,
        peersBySlot,
        sim: null,
        simTimer: null,
        initialNeedlesBySlot: new Array(slotCount).fill(0),
        exInvIds: [[], []],
        exLucci: [0, 0],
        exLocked: [false, false],
        exConfirmed: [false, false],
      };
      roomsById.set(id, room);

      sendRpc(peer, { type: "room_joined", room: roomToDetail(room), mySlot: sess.slot, slot2P: sess.slot2P });
      if (kind === "exchange") syncExchange(room);
      broadcastLobby(room.channelIdx);
      return;
    }

    case "join_room": {
      const r = roomsById.get(msg.roomId);
      if (!r || r.channelIdx !== sess.channelIdx) {
        sendRpc(peer, { type: "room_err", message: "無效的房間，無法確認房間資料" });
        return;
      }
      if (r.playing) {
        sendRpc(peer, { type: "room_err", message: "該房間正在對戰中，請稍候再進入" });
        return;
      }
      if (r.password && r.password !== (msg.password ?? "")) {
        sendRpc(peer, { type: "room_err", message: "房間密碼不正確！" });
        return;
      }
      const openIdx = r.slots.findIndex((s) => s.open && !s.occupied);
      if (openIdx === -1) {
        sendRpc(peer, { type: "room_err", message: "房間人數已滿，無法進入" });
        return;
      }
      leaveCurrentRoom(sess, false);
      const prof = DB.getProfileById(sess.accountId)!;
      r.slots[openIdx] = {
        slot: openIdx,
        open: true,
        occupied: true,
        isAi: false,
        aiLevel: 2,
        username: sess.username,
        nickname: sess.nickname,
        level: Math.max(1, Math.min(450, prof.level + (prof.equipped.levelDisguiseDelta ?? 0))),
        charCode: prof.selectedChar,
        team: openIdx % 2,
        ready: false,
        isHost: false,
        slotDecoStockId: prof.equipped.slotDecoStockId,
        slotDecoStockIds: prof.equipped.slotDecoStockIds ? [...prof.equipped.slotDecoStockIds] : undefined,
        hatStockId: prof.equipped.hatStockId,
        charDecoStockIds: prof.equipped.charDecoStockIds ? [...prof.equipped.charDecoStockIds] : undefined,
        bombStockId: prof.equipped.bombStockId,
        fanfareStockId: prof.equipped.fanfareStockId,
        idDecoStockId: prof.equipped.idDecoStockId,
        levelEffectIdx: prof.equipped.levelEffectIdx,
        emotionPose: 0,
      };
      r.peersBySlot[openIdx] = sess;
      sess.roomId = r.id;
      sess.slot = openIdx;
      sess.slot2P = -1;

      sendRpc(peer, { type: "room_joined", room: roomToDetail(r), mySlot: sess.slot, slot2P: sess.slot2P });
      syncRoom(r);
      if (r.kind === "exchange") syncExchange(r);
      broadcastLobby(r.channelIdx);
      return;
    }

    case "quick_join": {
      const candidates = [...roomsById.values()].filter(
        (r) =>
          r.channelIdx === sess.channelIdx &&
          !r.playing &&
          !r.password &&
          (r.kind === "game" || r.kind === "guild") &&
          r.slots.some((s) => s.open && !s.occupied),
      );
      if (candidates.length > 0) {
        handleRpcMessage(peer, { type: "join_room", roomId: candidates[0]!.id });
      } else {
        handleRpcMessage(peer, {
          type: "create_room",
          title: "快速對戰房間！歡迎加入",
          password: "",
          kind: "game",
          mode: 0,
          mapIndex: PLAYABLE_MAPS[0]?.index ?? 3,
          capacity: 8,
        });
      }
      return;
    }

    case "leave_room": {
      leaveCurrentRoom(sess, true);
      if (sess.channelIdx >= 0) broadcastLobby(sess.channelIdx);
      return;
    }

    case "room_set_map": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || r.hostSlot !== sess.slot) return;
      if (msg.mapIndex < 0) {
        r.mapIndex = -1;
        r.mapName = "Random";
        syncRoom(r);
        broadcastLobby(r.channelIdx);
        return;
      }
      const m = ALL_MAPS.find((x) => x.index === msg.mapIndex);
      if (m) {
        r.mapIndex = m.index;
        r.mapName = m.name;
        syncRoom(r);
        broadcastLobby(r.channelIdx);
      }
      return;
    }

    case "room_set_mode": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || r.hostSlot !== sess.slot) return;
      r.mode = msg.mode;
      syncRoom(r);
      broadcastLobby(r.channelIdx);
      return;
    }

    case "room_set_char": {
      const r = roomsById.get(sess.roomId);
      const targetSlot = msg.for2P ? sess.slot2P : sess.slot;
      if (!r || r.playing || targetSlot < 0) return;
      const code = Math.max(-1, Math.min(10, msg.charCode));
      r.slots[targetSlot]!.charCode = code;
      if (!msg.for2P) DB.setSelectedChar(sess.accountId, code);
      syncRoom(r);
      return;
    }

    case "room_set_team": {
      const r = roomsById.get(sess.roomId);
      const targetSlot = msg.for2P ? sess.slot2P : sess.slot;
      if (!r || r.playing || targetSlot < 0) return;
      r.slots[targetSlot]!.team = msg.team & 7;
      syncRoom(r);
      return;
    }

    case "room_toggle_slot": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || r.hostSlot !== sess.slot) return;
      const s = r.slots[msg.slot];
      if (!s || msg.slot === r.hostSlot) return;
      if (s.occupied && s.isAi) {
        r.slots[msg.slot] = emptySlot(msg.slot, true);
      } else if (!s.occupied) {
        s.open = !s.open;
      }
      syncRoom(r);
      broadcastLobby(r.channelIdx);
      return;
    }

    case "room_toggle_2p": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || (r.kind !== "game" && r.kind !== "guild")) return;
      if (msg.enable && sess.slot2P === -1) {
        const free = r.slots.findIndex((s) => s.open && !s.occupied);
        if (free !== -1) {
          const prof = DB.getProfileById(sess.accountId)!;
          r.slots[free] = {
            slot: free,
            open: true,
            occupied: true,
            isAi: false,
            aiLevel: 2,
            username: `${sess.username}_2P`,
            nickname: `${sess.nickname}(2P)`,
            level: prof.level,
            charCode: 1,
            team: (r.slots[sess.slot]!.team + 1) & 1,
            ready: true,
            isHost: false,
            is2P: true,
            slotDecoStockId: prof.equipped.slotDecoStockId,
            hatStockId: 0,
            emotionPose: 0,
          };
          r.peersBySlot[free] = sess;
          sess.slot2P = free;
          sendRpc(peer, { type: "room_joined", room: roomToDetail(r), mySlot: sess.slot, slot2P: sess.slot2P });
          syncRoom(r);
          broadcastLobby(r.channelIdx);
        }
      } else if (!msg.enable && sess.slot2P !== -1) {
        const s2 = sess.slot2P;
        r.peersBySlot[s2] = null;
        r.slots[s2] = emptySlot(s2, true);
        sess.slot2P = -1;
        sendRpc(peer, { type: "room_joined", room: roomToDetail(r), mySlot: sess.slot, slot2P: -1 });
        syncRoom(r);
        broadcastLobby(r.channelIdx);
      }
      return;
    }

    case "room_kick": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || r.hostSlot !== sess.slot || msg.slot === sess.slot) return;
      const target = r.slots[msg.slot];
      if (!target || !target.occupied) return;
      if (target.isAi) {
        r.slots[msg.slot] = emptySlot(msg.slot, true);
        syncRoom(r);
        broadcastLobby(r.channelIdx);
      } else {
        const kickedSess = r.peersBySlot[msg.slot];
        if (kickedSess && kickedSess !== sess) {
          // Retail `CA.exe.c:77103` (`BannedBySuperChief`): `超級室長券 SuperChief` (`avatarCode=72`) pierces `反制踢出券 BanReflex`!
          const hostInv = DB.getInventory(sess.accountId);
          const superChief = hostInv.find(
            (i) => i.category === 2 && DB!.stockById.get(i.stockId)?.avatarCode === 72 && i.quantity > 0,
          );
          const kInv = DB.getInventory(kickedSess.accountId);
          const banReflex = kInv.find(
            (i) => i.category === 2 && DB!.stockById.get(i.stockId)?.avatarCode === 73 && i.quantity > 0,
          );
          if (banReflex && !superChief) {
            DB.consumeStock(kickedSess.accountId, banReflex.stockId, 1);
            sendRpc(kickedSess.peer, {
              type: "inventory_sync",
              inventory: DB.getInventory(kickedSess.accountId),
              profile: DB.getProfileById(kickedSess.accountId)!,
            });
            broadcastRoom(r, {
              type: "chat_recv",
              from: "系統",
              text: `「${kickedSess.nickname}」發動了【反制踢出券】，成功免疫強制踢出！`,
              system: true,
            });
            return;
          }
          if (superChief && banReflex) {
            broadcastRoom(r, {
              type: "chat_recv",
              from: "系統",
              text: `室長「${sess.nickname}」持有【超級室長券】，貫穿了反制踢出券！`,
              system: true,
            });
          }
          leaveCurrentRoom(kickedSess, true);
        }
      }
      return;
    }

    case "room_toggle_ready": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || sess.slot < 0 || sess.slot === r.hostSlot) return;
      const sl = r.slots[sess.slot]!;
      sl.ready = !sl.ready;
      syncRoom(r);
      return;
    }

    case "room_emotion": {
      const r = roomsById.get(sess.roomId);
      if (!r || sess.slot < 0) return;
      r.slots[sess.slot]!.emotionPose = msg.pose;
      syncRoom(r);
      return;
    }

    case "room_start": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.playing || r.hostSlot !== sess.slot || (r.kind !== "game" && r.kind !== "guild")) return;
      const occupied = r.slots.filter((s) => s.occupied);
      if (occupied.length < 2) {
        sendRpc(peer, {
          type: "chat_recv",
          from: "系統",
          text: "對戰至少需要 2 名玩家（可輸入 /bot 加入電腦AI，或開啟雙人2P同機對戰！）",
          system: true,
        });
        return;
      }
      const unready = occupied.find((s) => !s.isHost && !s.ready && !s.isAi && !s.is2P);
      if (unready) {
        sendRpc(peer, {
          type: "chat_recv",
          from: "系統",
          text: `尚有玩家「${unready.nickname}」未準備完成！`,
          system: true,
        });
        return;
      }
      startRoomMatch(r);
      return;
    }

    case "match_input": {
      const r = roomsById.get(sess.roomId);
      if (!r || !r.sim) return;
      if (sess.slot >= 0) r.sim.setInput(sess.slot, msg.input);
      if (sess.slot2P >= 0 && msg.input2P) r.sim.setInput(sess.slot2P, msg.input2P);
      return;
    }

    case "chat_send": {
      const rawText = msg.text.trim().slice(0, 120);
      if (!rawText) return;

      // Support `/community <0|1|2|4|5|6>` (`CLogoMan` `Cx:Etc/CommunityLogo01..06`, `CA.exe.c:203445`)!
      const commMatch = /^\/community\s+(\d+)\s*$/i.exec(rawText);
      if (commMatch) {
        const logoNum = Number(commMatch[1]);
        const validLogos = new Set([0, 1, 2, 4, 5, 6]);
        if (!validLogos.has(logoNum)) {
          sendRpc(peer, {
            type: "chat_recv",
            from: "系統",
            text: "用法：/community <0|1|2|4|5|6>（0=無徽章，1/2/4/5/6=社群學園徽章）",
            system: true,
          });
          return;
        }
        const curProf = DB.getProfileById(sess.accountId);
        DB.updateMemo(sess.accountId, curProf?.memo ?? "", { communityLogo: logoNum });
        const nextProf = DB.getProfileById(sess.accountId);
        if (nextProf) sendRpc(peer, { type: "profile_sync", profile: nextProf });
        sendRpc(peer, {
          type: "chat_recv",
          from: "系統",
          text: logoNum === 0 ? "已卸下社群學園徽章" : `已換上社群學園徽章 #0${logoNum}！`,
          system: true,
        });
        return;
      }

      // Support `/to a <msg>` team-only chat (`Fx:Help/Help`: `只跟同隊的人對話`)!
      if (/^\/to\s+a\s+/i.test(rawText)) {
        const body = rawText.replace(/^\/to\s+a\s+/i, "").trim();
        const r = sess.roomId > 0 ? roomsById.get(sess.roomId) : undefined;
        if (r && body && sess.slot >= 0) {
          const myTeam = r.slots[sess.slot]?.team ?? 0;
          const sent = new Set<PeerSocket>();
          for (let si = 0; si < r.slots.length; si++) {
            const sl = r.slots[si];
            const pSess = r.peersBySlot[si];
            if (sl?.occupied && sl.team === myTeam && pSess && !sent.has(pSess.peer)) {
              sent.add(pSess.peer);
              sendRpc(pSess.peer, {
                type: "chat_recv",
                from: `[隊伍] ${sess.nickname}`,
                text: body,
                slot: sess.slot,
              });
            }
          }
        }
        return;
      }

      // Support `/w <user> <msg>` / `/to <user> <msg>` / `/whisper <user> <msg>` (`CA.exe.c:75025`)
      if (/^\/(w|to|whisper)\s+/i.test(rawText)) {
        const rest = rawText.replace(/^\/(w|to|whisper)\s+/i, "").trim();
        const parts = rest.split(/\s+/);
        const to = parts[0] ?? "";
        const body = parts.slice(1).join(" ");
        if (to && body) {
          handleRpcMessage(peer, { type: "whisper_send", to, text: body });
        }
        return;
      }

      // Retail `/in <ID>` (`Fx:Help/Help`: `輸入玩家的ID，便可以邀請該玩家進入自己的遊戲房`)
      if (/^\/in\s+/i.test(rawText)) {
        const q = rawText.replace(/^\/in\s+/i, "").trim();
        const r = sess.roomId > 0 ? roomsById.get(sess.roomId) : undefined;
        if (!r || r.playing) {
          sendRpc(peer, { type: "chat_recv", from: "系統", text: "請先進入等候室再使用 /in 邀請玩家。", system: true });
          return;
        }
        const found =
          sessionsByUser.get(q.toLowerCase()) ??
          [...sessionsByPeer.values()].find((s) => s.nickname.toLowerCase() === q.toLowerCase());
        if (!found) {
          sendRpc(peer, { type: "chat_recv", from: "系統", text: `玩家「${q}」目前不在線上。`, system: true });
        } else {
          sendRpc(found.peer, {
            type: "chat_recv",
            from: "系統",
            text: `[房間邀請] ${sess.nickname} 邀請您加入第 ${String(r.id).padStart(3, "0")} 房「${r.title}」（輸入 /join ${r.id} 即可加入！）`,
            system: true,
          });
          sendRpc(peer, {
            type: "chat_recv",
            from: "系統",
            text: `已向「${found.nickname}」發送第 ${String(r.id).padStart(3, "0")} 房邀請！`,
            system: true,
          });
        }
        return;
      }

      // Retail `/rt <房間名稱>`, `/ready`, `/start` (`Fx:Help/Help`)
      if (/^\/rt\s+/i.test(rawText) && sess.roomId > 0) {
        const newTitle = rawText.replace(/^\/rt\s+/i, "").trim().slice(0, 24);
        const r = roomsById.get(sess.roomId);
        if (r && !r.playing && r.hostSlot === sess.slot && newTitle) {
          r.title = newTitle;
          syncRoom(r);
          broadcastLobby(r.channelIdx);
          broadcastRoom(r, {
            type: "chat_recv",
            from: "系統",
            text: `室長已將房間名稱變更為「${newTitle}」。`,
            system: true,
          });
        }
        return;
      }
      if (/^\/ready$/i.test(rawText) && sess.roomId > 0) {
        handleRpcMessage(peer, { type: "room_toggle_ready" });
        return;
      }
      if (/^\/start$/i.test(rawText) && sess.roomId > 0) {
        handleRpcMessage(peer, { type: "room_start" });
        return;
      }

      // Retail `/where <user>` (`CA.exe.c:74941`): locate online player's channel & room!
      if (/^\/where\s+/i.test(rawText)) {
        const q = rawText.replace(/^\/where\s+/i, "").trim();
        const found =
          sessionsByUser.get(q.toLowerCase()) ??
          [...sessionsByPeer.values()].find((s) => s.nickname.toLowerCase() === q.toLowerCase());
        if (!found) {
          sendRpc(peer, { type: "chat_recv", from: "系統", text: `玩家「${q}」目前不在線上。`, system: true });
        } else {
          const chName = found.channelIdx >= 0 ? (CHANNELS[found.channelIdx]?.name ?? "大廳") : "伺服器選擇";
          const rm = found.roomId > 0 ? roomsById.get(found.roomId) : undefined;
          const loc = rm ? `${chName} — 第 ${String(rm.id).padStart(3, "0")} 房「${rm.title}」` : `${chName} — 頻道等候室`;
          sendRpc(peer, {
            type: "chat_recv",
            from: "系統",
            text: `[位置查詢] ${found.nickname} (${found.username}) 目前位於：${loc}`,
            system: true,
          });
        }
        return;
      }

      // Retail `/kickoff <user>` (`CA.exe.c:74795`): host kicks player by ID or nickname
      if (/^\/(kickoff|ban)\s+/i.test(rawText) && sess.roomId > 0) {
        const q = rawText.replace(/^\/(kickoff|ban)\s+/i, "").trim().toLowerCase();
        const r = roomsById.get(sess.roomId);
        if (r && !r.playing && r.hostSlot === sess.slot) {
          const targetSlot = r.slots.findIndex(
            (s) => s.occupied && s.slot !== sess.slot && (s.username.toLowerCase() === q || s.nickname.toLowerCase() === q),
          );
          if (targetSlot >= 0) {
            handleRpcMessage(peer, { type: "room_kick", slot: targetSlot });
          }
        }
        return;
      }

      // Support `/bot [1|2|3]` and `/nobot` inside waiting game rooms (`strict_plus_cmd_bot`)!
      if (sess.roomId > 0) {
        const r = roomsById.get(sess.roomId);
        if (r && !r.playing && (r.kind === "game" || r.kind === "guild")) {
          if (/^\/bot(\s+[123])?$/i.test(rawText)) {
            if (r.hostSlot !== sess.slot) {
              sendRpc(peer, { type: "chat_recv", from: "系統", text: "只有室長可以使用 /bot 指令", system: true });
              return;
            }
            const lvNum = parseInt(rawText.split(/\s+/)[1] ?? "2", 10);
            const aiLv = (lvNum === 1 || lvNum === 3 ? lvNum : 2) as 1 | 2 | 3;
            const free = r.slots.findIndex((s) => s.open && !s.occupied);
            if (free === -1) {
              sendRpc(peer, { type: "chat_recv", from: "系統", text: "沒有空位可新增電腦 AI", system: true });
              return;
            }
            const botNames = ["藍寶BOT", "睏寶BOT", "囡囡BOT", "痞子妹BOT", "工頭BOT", "藍妹妹BOT", "胖墩BOT", "栗子BOT"];
            r.slots[free] = {
              slot: free,
              open: true,
              occupied: true,
              isAi: true,
              aiLevel: aiLv,
              username: `BOT_${free}`,
              nickname: `${botNames[free % 8]}[Lv${aiLv}]`,
              level: aiLv * 12,
              charCode: free % 8,
              team: (r.slots[sess.slot]!.team + 1 + (free & 1)) % 4,
              ready: true,
              isHost: false,
              slotDecoStockId: 0,
              hatStockId: 0,
              emotionPose: 0,
            };
            syncRoom(r);
            broadcastRoom(r, {
              type: "chat_recv",
              from: "系統",
              text: `已新增電腦對手 ${r.slots[free]!.nickname}（輸入 /nobot 可移除全部 AI）`,
              system: true,
            });
            broadcastLobby(r.channelIdx);
            return;
          }
          if (/^\/nobot$/i.test(rawText) && r.hostSlot === sess.slot) {
            for (let i = 0; i < 8; i++) {
              if (r.slots[i]!.isAi) r.slots[i] = emptySlot(i, true);
            }
            syncRoom(r);
            broadcastLobby(r.channelIdx);
            return;
          }
        }
        if (r) {
          const chatProf = DB.getProfileById(sess.accountId);
          broadcastRoom(r, {
            type: "chat_recv",
            from: sess.nickname,
            text: rawText,
            slot: sess.slot,
            color: chatProf?.equipped.crayonColor,
          });
          return;
        }
      }

      // Lobby chat
      const lobbyChatProf = DB.getProfileById(sess.accountId);
      for (const s of sessionsByPeer.values()) {
        if (s.channelIdx === sess.channelIdx && s.roomId === 0) {
          sendRpc(s.peer, {
            type: "chat_recv",
            from: sess.nickname,
            text: rawText,
            color: lobbyChatProf?.equipped.crayonColor,
          });
        }
      }
      return;
    }

    case "whisper_send": {
      const target = sessionsByUser.get(msg.to.trim().toLowerCase());
      const clean = msg.text.trim().slice(0, 120);
      if (!clean) return;
      if (!target) {
        sendRpc(peer, { type: "chat_recv", from: "系統", text: `玩家「${msg.to}」目前不在線上`, system: true });
        return;
      }
      const pkt: ServerMsg = { type: "whisper_recv", from: sess.nickname, to: target.nickname, text: clean };
      sendRpc(peer, pkt);
      if (target.peer !== peer) sendRpc(target.peer, pkt);
      return;
    }

    case "speaker_send": {
      const clean = msg.text.trim().slice(0, 80);
      if (!clean) return;
      const db = DB;
      // Consume loudspeaker (`1209`/`1210` or any owned speaker item); if none owned, notify `no_speaker` (`CNoSpeakDlg`)!
      let consumed = db.consumeStock(sess.accountId, 1209, 1) || db.consumeStock(sess.accountId, 1210, 1);
      if (!consumed) {
        const inv = db.getInventory(sess.accountId);
        const speakerRow = inv.find((r) => {
          const sp = db.stockById.get(r.stockId);
          return sp && /擴音|大聲公|喇叭|speaker/i.test(`${sp.name} ${sp.iconPath}`);
        });
        if (speakerRow) {
          consumed = db.consumeStock(sess.accountId, speakerRow.stockId, 1);
        }
      }
      if (!consumed) {
        sendRpc(peer, { type: "no_speaker", kind: "speaker" });
        return;
      }
      const colorIdx = Math.max(0, Math.min(4, Math.floor(msg.colorIdx ?? 0)));
      broadcastChannel(sess.channelIdx, {
        type: "speaker_recv",
        from: sess.nickname,
        text: clean,
        colorIdx,
      });
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      return;
    }

    case "shop_buy": {
      const res = DB.buyStock(
        sess.accountId,
        msg.stockId,
        msg.currency,
        undefined,
        undefined,
        msg.qty ?? 1,
        msg.couponId,
      );
      sendRpc(peer, { type: "shop_res", ok: res.ok, message: res.message, requestId: msg.requestId });
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      if (msg.couponId) {
        sendRpc(peer, { type: "coupons_sync", coupons: DB.getCoupons(sess.accountId) });
      }
      return;
    }

    case "shop_buy_batch": {
      const res = DB.buyStockBatch(sess.accountId, msg.items ?? []);
      sendRpc(peer, { type: "shop_res", ok: res.ok, message: res.message, requestId: msg.requestId });
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      return;
    }

    case "shop_gift": {
      const res = DB.buyStock(sess.accountId, msg.stockId, msg.currency, msg.toUsername, msg.message);
      sendRpc(peer, { type: "shop_res", ok: res.ok, message: res.message });
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      const recvSess = sessionsByUser.get(msg.toUsername.trim().toLowerCase());
      if (res.ok && recvSess) {
        const rProf = DB.getProfileById(recvSess.accountId)!;
        sendRpc(recvSess.peer, {
          type: "inventory_sync",
          inventory: DB.getInventory(recvSess.accountId),
          profile: rProf,
        });
        sendRpc(recvSess.peer, {
          type: "sms_sync",
          sms: DB.getSms(recvSess.username),
          toast: `收到來自 ${sess.nickname} 的商城禮物！`,
        });
      }
      return;
    }

    case "charge_cash": {
      const prof = DB.chargeCash(sess.accountId, msg.amount);
      if (prof) {
        sendRpc(peer, { type: "profile_sync", profile: prof });
        sendRpc(peer, { type: "shop_res", ok: true, message: `儲值成功！獲得 +${msg.amount} 點數與 +${msg.amount * 2} LUCCI！` });
      }
      return;
    }

    case "gachapon_spin": {
      const freeLeft = sess.pendingQuestionMarks ?? 0;
      if (freeLeft > 0) {
        sess.pendingQuestionMarks = freeLeft - 1;
      } else {
        if (!DB.adjustLucci(sess.accountId, -500)) {
          sendRpc(peer, {
            type: "gachapon_res",
            ok: false,
            stockId: 0,
            lucciJackpot: 0,
            freeTicketsLeft: 0,
            message: "LUCCI 不足（需 500 LUCCI 或拾獲問號樂爆卡）！",
          });
          return;
        }
      }

      const pool = [...DB.stockById.values()].filter(
        (s) => [1, 3, 4, 5, 10, 12, 18, 19].includes(s.category) && s.iconPath.length > 0,
      );
      const rollJackpot = msg.preferredStockId === 0 || (msg.preferredStockId === undefined && Math.random() < 0.16);
      let wonStockId = 0;
      let lucciJackpot = 0;
      let message = "";

      if (rollJackpot || pool.length === 0) {
        lucciJackpot = 3000;
        DB.adjustLucci(sess.accountId, lucciJackpot);
        message = `恭喜抽中黃金錢袋頭獎 +${lucciJackpot} LUCCI！`;
      } else {
        const chosen =
          (msg.preferredStockId ? DB.stockById.get(msg.preferredStockId) : undefined) ??
          pool[Math.floor(Math.random() * pool.length)]!;
        wonStockId = chosen.id;
        DB.grantStock(sess.accountId, chosen.id, 1);
        message = `恭喜樂爆卡抽中「${chosen.name || `#${chosen.id}`}」！已放入我的物品欄！`;
      }
      if (pool.length > 0) {
        const couponTarget = pool[Math.floor(Math.random() * pool.length)]!;
        const dcPct = Math.random() < 0.35 ? 50 : 30;
        DB.grantCoupon(sess.accountId, couponTarget.id, dcPct, 1);
      }

      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, {
        type: "inventory_sync",
        inventory: DB.getInventory(sess.accountId),
        profile: prof,
      });
      sendRpc(peer, {
        type: "coupons_sync",
        coupons: DB.getCoupons(sess.accountId),
      });
      sendRpc(peer, {
        type: "gachapon_res",
        ok: true,
        stockId: wonStockId,
        lucciJackpot,
        freeTicketsLeft: sess.pendingQuestionMarks ?? 0,
        message,
      });
      return;
    }

    case "item_equip": {
      DB.setEquipped(sess.accountId, msg.invId, msg.equip);
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      if (sess.roomId > 0 && sess.slot >= 0) {
        const r = roomsById.get(sess.roomId);
        const sl = r?.slots[sess.slot];
        if (r && sl && sl.occupied && !sl.isAi) {
          sl.level = Math.max(1, Math.min(450, prof.level + (prof.equipped.levelDisguiseDelta ?? 0)));
          sl.slotDecoStockId = prof.equipped.slotDecoStockId;
          sl.slotDecoStockIds = prof.equipped.slotDecoStockIds ? [...prof.equipped.slotDecoStockIds] : undefined;
          sl.hatStockId = prof.equipped.hatStockId;
          sl.charDecoStockIds = prof.equipped.charDecoStockIds ? [...prof.equipped.charDecoStockIds] : undefined;
          sl.bombStockId = prof.equipped.bombStockId;
          sl.fanfareStockId = prof.equipped.fanfareStockId;
          sl.idDecoStockId = prof.equipped.idDecoStockId;
          sl.levelEffectIdx = prof.equipped.levelEffectIdx;
          syncRoom(r);
        }
      }
      broadcastLobby(sess.channelIdx);
      return;
    }

    case "select_char": {
      const code = Math.max(-1, Math.min(10, Math.floor(msg.charCode)));
      DB.setSelectedChar(sess.accountId, code);
      const prof = DB.getProfileById(sess.accountId);
      if (prof) {
        sendRpc(peer, { type: "profile_sync", profile: prof });
      }
      if (sess.roomId > 0 && sess.slot >= 0) {
        const r = roomsById.get(sess.roomId);
        if (r && !r.playing && r.slots[sess.slot]) {
          r.slots[sess.slot]!.charCode = code;
          syncRoom(r);
        }
      }
      return;
    }

    case "inventory_sell": {
      const res = DB.sellInventoryItem(sess.accountId, msg.invId);
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      sendRpc(peer, { type: "shop_res", ok: res.ok, message: res.message });
      return;
    }

    case "inventory_delete": {
      const res = DB.deleteInventoryItem(sess.accountId, msg.invId);
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, { type: "inventory_sync", inventory: DB.getInventory(sess.accountId), profile: prof });
      sendRpc(peer, { type: "shop_res", ok: res.ok, message: res.message });
      return;
    }

    case "rankings_req": {
      sendRpc(peer, { type: "rankings_res", rows: DB.getRankings(msg.sortBy ?? "exp") });
      return;
    }

    case "user_info_req": {
      sendRpc(peer, { type: "user_info_res", profile: DB.getProfileByUsername(msg.username) });
      return;
    }

    case "update_memo": {
      // RPC payloads are untrusted JSON; validate every field before writing any of
      // them so a malformed optional field cannot leave a partially updated profile.
      if (
        typeof msg.memo !== "string" ||
        (msg.nickname !== undefined && typeof msg.nickname !== "string") ||
        (msg.school !== undefined && typeof msg.school !== "string") ||
        (msg.gender !== undefined && (typeof msg.gender !== "number" || !Number.isInteger(msg.gender))) ||
        (msg.communityLogo !== undefined && (typeof msg.communityLogo !== "number" || !Number.isInteger(msg.communityLogo)))
      ) return;
      DB.updateMemo(sess.accountId, msg.memo, {
        nickname: msg.nickname,
        gender: msg.gender,
        school: msg.school,
        communityLogo: msg.communityLogo,
      });
      const prof = DB.getProfileById(sess.accountId);
      if (prof) {
        sess.nickname = prof.nickname;
        sendRpc(peer, { type: "profile_sync", profile: prof });
      }
      return;
    }

    case "friend_add": {
      const res = DB.addFriend(sess.accountId, msg.username);
      sendRpc(peer, { type: "friends_sync", friends: buildFriendsPayload(sess.accountId) });
      sendRpc(peer, { type: "chat_recv", from: "系統", text: res.message, system: true });
      return;
    }

    case "friend_remove": {
      DB.removeFriend(sess.accountId, msg.username);
      sendRpc(peer, { type: "friends_sync", friends: buildFriendsPayload(sess.accountId) });
      return;
    }

    case "sms_send": {
      const ok = DB.sendSms(sess.nickname, msg.to, msg.body);
      if (!ok) {
        sendRpc(peer, { type: "sms_sync", sms: DB.getSms(sess.username), toast: `找不到收件人「${msg.to}」` });
        return;
      }
      sendRpc(peer, { type: "sms_sync", sms: DB.getSms(sess.username), toast: "簡訊已成功寄出！" });
      const recv = sessionsByUser.get(msg.to.trim().toLowerCase());
      if (recv) {
        sendRpc(recv.peer, {
          type: "sms_sync",
          sms: DB.getSms(recv.username),
          toast: `收到來自 ${sess.nickname} 的新簡訊！`,
        });
      }
      return;
    }

    case "sms_delete": {
      DB.deleteSms(sess.username, msg.smsId, msg.deleteAll);
      sendRpc(peer, { type: "sms_sync", sms: DB.getSms(sess.username) });
      return;
    }

    case "exchange_offer": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.kind !== "exchange" || (sess.slot !== 0 && sess.slot !== 1)) return;
      const side = sess.slot as 0 | 1;
      if (r.exLocked[side]) return;
      r.exInvIds[side] = msg.invIds.slice(0, 6);
      r.exLucci[side] = Math.max(0, Math.floor(msg.lucci));
      r.exConfirmed = [false, false];
      syncExchange(r);
      return;
    }

    case "exchange_lock": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.kind !== "exchange" || (sess.slot !== 0 && sess.slot !== 1)) return;
      const side = sess.slot as 0 | 1;
      r.exLocked[side] = msg.locked;
      if (!msg.locked) r.exConfirmed = [false, false];
      syncExchange(r);
      return;
    }

    case "exchange_confirm": {
      const r = roomsById.get(sess.roomId);
      if (!r || r.kind !== "exchange" || (sess.slot !== 0 && sess.slot !== 1)) return;
      if (!r.exLocked[0] || !r.exLocked[1]) return;
      const s0 = r.peersBySlot[0];
      const s1 = r.peersBySlot[1];
      if (!s0 || !s1) return;
      r.exConfirmed[sess.slot as 0 | 1] = true;
      syncExchange(r);

      if (r.exConfirmed[0] && r.exConfirmed[1]) {
        const res = DB.executeExchange(
          s0.accountId,
          r.exInvIds[0],
          r.exLucci[0],
          s1.accountId,
          r.exInvIds[1],
          r.exLucci[1],
        );
        r.exInvIds = [[], []];
        r.exLucci = [0, 0];
        r.exLocked = [false, false];
        r.exConfirmed = [false, false];
        for (const p of [s0, s1]) {
          const prof = DB.getProfileById(p.accountId)!;
          sendRpc(p.peer, { type: "inventory_sync", inventory: DB.getInventory(p.accountId), profile: prof });
          sendRpc(p.peer, { type: "exchange_done", message: res.message });
        }
        syncExchange(r);
      }
      return;
    }

    case "coupon_use": {
      const res = DB.useCoupon(sess.accountId, msg.couponId);
      if (!res.ok) {
        sendRpc(peer, { type: "shop_res", ok: false, message: res.message });
        return;
      }
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, {
        type: "inventory_sync",
        inventory: DB.getInventory(sess.accountId),
        profile: prof,
      });
      sendRpc(peer, {
        type: "coupons_sync",
        coupons: DB.getCoupons(sess.accountId),
        message: `已使用 ${res.discountPct}% 優惠券購買「${res.itemName}」！`,
      });
      sendRpc(peer, {
        type: "shop_res",
        ok: true,
        message: `成功使用 ${res.discountPct}% 優惠券購入「${res.itemName}」！`,
      });
      return;
    }

    case "coupon_delete": {
      DB.deleteCoupon(sess.accountId, msg.couponId);
      sendRpc(peer, {
        type: "coupons_sync",
        coupons: DB.getCoupons(sess.accountId),
        message: "已刪除優惠券。",
      });
      return;
    }

    case "coupon_redeem": {
      const res = DB.redeemSerialCode(sess.accountId, msg.code);
      if (!res.ok) {
        sendRpc(peer, { type: "shop_res", ok: false, message: res.message });
        return;
      }
      const prof = DB.getProfileById(sess.accountId)!;
      sendRpc(peer, {
        type: "inventory_sync",
        inventory: DB.getInventory(sess.accountId),
        profile: prof,
      });
      sendRpc(peer, {
        type: "coupons_sync",
        coupons: DB.getCoupons(sess.accountId),
        message: res.message,
      });
      sendRpc(peer, { type: "shop_res", ok: true, message: res.message });
      return;
    }
  }
}

function completeAuth(peer: PeerSocket, accountId: number, dual2P: boolean): void {
  if (!DB) return;
  const prof = DB.getProfileById(accountId)!;

  // Disconnect older session on same username if any
  const old = sessionsByUser.get(prof.username.toLowerCase());
  if (old && old.peer !== peer) {
    leaveCurrentRoom(old, false);
    sessionsByPeer.delete(old.peer);
  }

  const sess: ClientSession = {
    peer,
    accountId,
    username: prof.username,
    nickname: prof.nickname,
    dual2P,
    channelIdx: -1,
    roomId: 0,
    slot: -1,
    slot2P: -1,
  };
  sessionsByPeer.set(peer, sess);
  sessionsByUser.set(prof.username.toLowerCase(), sess);

  // Dynamic channel user counts
  const channels = CHANNELS.map((c, idx) => {
    let live = 0;
    for (const s of sessionsByPeer.values()) if (s.channelIdx === idx) live++;
    return {
      name: c.name,
      maxUsers: c.maxUsers,
      users: c.users + live,
      kind: c.kind,
      index: idx,
    };
  });

  sendRpc(peer, {
    type: "auth_ok",
    profile: prof,
    inventory: DB.getInventory(accountId),
    coupons: DB.getCoupons(accountId),
    friends: buildFriendsPayload(accountId),
    sms: DB.getSms(prof.username),
    notices: DB.notices(),
    channels,
  });
}

export function attachGateway(lobby: Lobby): void {
  lobby.onLeave = (peer: PeerSocket) => {
    const sess = sessionsByPeer.get(peer);
    if (!sess) return;
    const ch = sess.channelIdx;
    leaveCurrentRoom(sess, false);
    sessionsByPeer.delete(peer);
    if (sessionsByUser.get(sess.username.toLowerCase()) === sess) {
      sessionsByUser.delete(sess.username.toLowerCase());
    }
    if (ch >= 0) broadcastLobby(ch);
  };

  lobby.handler = (peer: PeerSocket, op: number, body: Uint8Array) => {
    if (op === OP_RPC) {
      try {
        const msg = JSON.parse(utf8Dec.decode(body)) as ClientMsg;
        handleRpcMessage(peer, msg);
      } catch {
        /* ignore malformed rpc */
      }
      return;
    }

    // Legacy PR #1 opcodes (0x10..0x18, 0x7F)
    switch (op) {
      case OP.Login: {
        const r = new PacketReader(body);
        const id = new TextDecoder("big5").decode(r.str16());
        const pass = new TextDecoder("big5").decode(r.str16());
        const res = DB?.loginOrCreate(id, pass);
        const w = new PacketWriter();
        w.u8(res?.ok ? 1 : 0);
        w.str(utf8Enc.encode(res?.ok ? "" : res?.message ?? "error"));
        peer.send(OP.LoginResult, w.finish());
        if (res?.ok) {
          completeAuth(peer, res.profile.id, false);
          const cw = new PacketWriter();
          cw.u16(CHANNELS.length);
          for (const c of CHANNELS) {
            cw.str(c.nameBytes);
            cw.u16(c.maxUsers);
            cw.u16(c.users);
            cw.u8(c.kind);
            cw.u16(c.group);
            cw.u8(c.index);
          }
          peer.send(OP.ChannelList, cw.finish());
        }
        return;
      }
      case 0x7f: {
        peer.send(0x7f, body);
        return;
      }
      default:
        return;
    }
  };
}
