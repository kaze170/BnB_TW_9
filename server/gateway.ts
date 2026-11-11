/**
 * Server behaviour: the one half of this project we are allowed to invent.
 *
 * The *envelope* is not invented: every message goes through
 * src/net/protocol.ts, which is a direct port of CSendPacket::sub_57E6A0 /
 * sub_57EBC0, and the handshake reproduces CClientSocket::sub_580580 /
 * sub_5805F0.  Only the opcode numbers and payloads below are ours.
 *
 * The *channel list* is not invented either: it is read out of the shipped
 * `channel2_000.ssd` (see src/data/channel.ts, reversed from sub_50A091) and
 * sent as-is, so the client shows the retail channel names ("BnB初級-1",
 * "BnB高手-4", …) with the user counts the file was shipped with.
 *
 * Opcode map (all ours — the original's opcodes live in .rdata dispatch
 * tables that are not recoverable without the retail server):
 *   0x01  S -> C  key confirmation,        [u8 keyByte]
 *   0x10  C -> S  login,                   str16(id), str16(pass)
 *   0x11  S -> C  login result,            u8 ok, str16(message)
 *   0x12  S -> C  channel list,            u16 count, count * channel record
 *   0x13  C -> S  join channel,            u16 channel index
 *   0x14  S -> C  join result,             u8 ok, u16 channelId, str16(message)
 *   0x15  S -> C  room list,               u16 count, count * room record
 *   0x16  C -> S  enter room,              u16 slot
 *   0x17  S -> C  enter result,            u8 ok, u16 slot, str16(message)
 *
 * Room record:
 *   u16 slot, str16 name, u16 players, u16 capacity, u8 state, u16 map index
 *
 * EnterResult and JoinResult carry a *key* into the client's csysstr.ssd, not
 * a human sentence: the retail client looks the message up itself, and those
 * keys are the ones the lobby's own failure paths reference.
 *
 * Channel record on the wire (ours, but it carries every field of the file
 * record so the UI needs nothing else):
 *   str16 name (the Big5 bytes from channel2_000.ssd, verbatim),
 *   u16 maxUsers, u16 users, u8 kind, u16 group, u8 index
 *
 * The name is forwarded as the file's own bytes: this runtime has a Big5
 * decoder but no encoder, so re-encoding a decoded name would corrupt it.
 */

import { PacketReader, PacketWriter } from '../src/net/packet.ts';
import type { Lobby, PeerSocket } from '../src/net/lobby.ts';
import { readChannelFile, type Channel } from '../src/data/channel.ts';
import { readServerList, mergeWithBuiltins, type ServerEndpoint } from '../src/data/serverlist.ts';

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
} as const;

export function roomCount(): number {
  return ROOMS.length;
}

export interface Account {
  id: string;
  pass: string;
}

/** Single in-memory account store; the original authenticated against Nexon. */
const accounts = new Map<string, Account>();

/** Which channel each peer ended up in, keyed by the peer object. */
const peerChannel = new WeakMap<PeerSocket, number>();
/** Which room slot each peer occupies. */
const peerRoom = new WeakMap<PeerSocket, number>();

/**
 * Room slots.  The retail client lays out six of them (CLobbyStage's slot
 * table), so the gateway keeps six.  The contents are server state — the retail
 * room protocol is not recoverable — but the *shape* is the client's.
 */
export type RoomState = 0 | 1 | 2; // waiting | playing | locked

export interface Room {
  slot: number;
  name: string;
  players: number;
  capacity: number;
  state: RoomState;
  map: number;
}

export const SLOT_COUNT = 6;

/**
 * Rooms carry a map *index* into fxdynmapinfo.ssd, not a map name.
 *
 * The client already has all 240 map records (see src/data/mapinfo.ts), so
 * sending the index keeps the localised name ("藏寶地圖00") and the thumbnail
 * exactly as shipped, and sidesteps the fact that this runtime can decode Big5
 * but not encode it.  Indices below are the first playable map of six of the
 * shipped families: Bula, Cemetery, Desert, Forest, Ice, Tomb.
 */
const MAP_INDEX = [3, 25, 44, 79, 98, 193];

function blankRooms(): Room[] {
  return Array.from({ length: SLOT_COUNT }, (_, slot) => ({
    slot,
    name: `Room ${slot + 1}`,
    players: slot < 3 ? 1 + (slot % 2) : 0,
    capacity: 8,
    state: (slot < 3 ? 0 : 1) as RoomState,
    map: MAP_INDEX[slot % MAP_INDEX.length]!,
  }));
}

let ROOMS: Room[] = blankRooms();

const ROOT = new URL('..', import.meta.url).pathname;
/**
 * Messages are ASCII on purpose: the wire carries Big5 for the retail strings
 * (the channel names, forwarded as raw bytes) but this runtime cannot *encode*
 * Big5, so server-authored text stays inside ASCII.  The retail client's own
 * messages live in csysstr.ssd and are shown by the client, not sent by us.
 */
const encoder = new TextEncoder();

/** Loaded once at startup from the shipped data files. */
let CHANNELS: Channel[] = [];
let ENDPOINTS: ServerEndpoint[] = [];

/**
 * Load the retail channel table and realm list.  Both files are optional: if
 * they are missing the server still runs, it just has no channels to offer.
 */
export async function loadRetailData(): Promise<void> {
  try {
    const chBytes = new Uint8Array(await Bun.file(`${ROOT}channel2_000.ssd`).arrayBuffer());
    CHANNELS = readChannelFile(chBytes, 'channel2_000.ssd')?.channels ?? [];
  } catch {
    CHANNELS = [];
  }
  try {
    const svBytes = new Uint8Array(await Bun.file(`${ROOT}multisvr.ssd`).arrayBuffer());
    ENDPOINTS = mergeWithBuiltins(readServerList(svBytes));
  } catch {
    ENDPOINTS = mergeWithBuiltins(null);
  }
}

export function retailChannels(): readonly Channel[] {
  return CHANNELS;
}

export function retailEndpoints(): readonly ServerEndpoint[] {
  return ENDPOINTS;
}

function str(w: PacketWriter, text: string): void {
  w.str(encoder.encode(text));
}

export function attachGateway(lobby: Lobby): void {
  lobby.handler = (peer: PeerSocket, op: number, body: Uint8Array) => {
    switch (op) {
      case OP.Login: {
        const r = new PacketReader(body);
        const id = new TextDecoder('big5').decode(r.str16());
        const pass = new TextDecoder('big5').decode(r.str16());
        const existing = accounts.get(id);
        if (!existing) {
          accounts.set(id, { id, pass });
        } else if (existing.pass !== pass) {
          sendLoginResult(peer, false, 'wrong password');
          return;
        }
        sendLoginResult(peer, true, '');
        sendChannels(peer);
        return;
      }
      case OP.JoinChannel: {
        const r = new PacketReader(body);
        const idx = r.u16();
        if (idx >= CHANNELS.length) {
          sendJoinResult(peer, false, 0xffff, 'no such channel');
          return;
        }
        peerChannel.set(peer, idx);
        sendJoinResult(peer, true, idx, '');
        sendRooms(peer);
        return;
      }
      case OP.EnterRoom: {
        const r = new PacketReader(body);
        const slot = r.u16();
        const room = ROOMS[slot];
        if (!room) {
          // csysstr.ssd key, resolved by the client's own string table.
          sendEnterResult(peer, false, slot, 'NotValidRoomInfo');
          return;
        }
        if (room.players >= room.capacity) {
          sendEnterResult(peer, false, slot, 'NoEmptySlot');
          return;
        }
        peerRoom.set(peer, slot);
        room.players = Math.min(room.capacity, room.players + 1);
        sendEnterResult(peer, true, slot, '');
        sendRooms(peer);
        return;
      }
      case OP.LeaveRoom: {
        const slot = peerRoom.get(peer);
        if (slot !== undefined) {
          const room = ROOMS[slot];
          if (room) room.players = Math.max(0, room.players - 1);
          peerRoom.delete(peer);
        }
        sendRooms(peer);
        return;
      }
      case 0x7f: {
        // keepalive, mirrors the client's periodic ping
        peer.send(0x7f, body);
        return;
      }
      default:
        return;
    }
  };
}

function sendLoginResult(peer: PeerSocket, ok: boolean, message: string): void {
  const w = new PacketWriter();
  w.u8(ok ? 1 : 0);
  str(w, message);
  peer.send(OP.LoginResult, w.finish());
}

function sendEnterResult(peer: PeerSocket, ok: boolean, slot: number, message: string): void {
  const w = new PacketWriter();
  w.u8(ok ? 1 : 0);
  w.u16(slot);
  str(w, message);
  peer.send(OP.EnterResult, w.finish());
}

/** Rooms are announced after a channel join, the way the client expects. */
export function sendRooms(peer: PeerSocket): void {
  const w = new PacketWriter();
  w.u16(ROOMS.length);
  for (const r of ROOMS) {
    w.u16(r.slot);
    str(w, r.name);
    w.u16(r.players);
    w.u16(r.capacity);
    w.u8(r.state);
    w.u16(r.map);
  }
  peer.send(OP.RoomList, w.finish());
}

function sendJoinResult(peer: PeerSocket, ok: boolean, channelId: number, message: string): void {
  const w = new PacketWriter();
  w.u8(ok ? 1 : 0);
  w.u16(channelId);
  str(w, message);
  peer.send(OP.JoinResult, w.finish());
}

function sendChannels(peer: PeerSocket): void {
  const w = new PacketWriter();
  w.u16(CHANNELS.length);
  for (const c of CHANNELS) {
    w.str(c.nameBytes);
    w.u16(c.maxUsers);
    w.u16(c.users);
    w.u8(c.kind);
    w.u16(c.group);
    w.u8(c.index);
  }
  peer.send(OP.ChannelList, w.finish());
}
