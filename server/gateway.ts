/**
 * Server behaviour: the one half of this project we are allowed to invent.
 *
 * The *envelope* is not invented: every message goes through
 * src/net/protocol.ts, which is a direct port of CSendPacket::sub_57E6A0 /
 * sub_57EBC0, and the handshake reproduces CClientSocket::sub_580580 /
 * sub_5805F0.  Only the opcode numbers and payloads below are ours.
 *
 * Opcode map (all ours — the original's opcodes live in .rdata dispatch
 * tables that are not recoverable without the retail server):
 *   0x01  S -> C  key confirmation,        [u8 keyByte]
 *   0x10  C -> S  login,                   str16(id), str16(pass)
 *   0x11  S -> C  login result,            u8 ok, str16(message)
 *   0x12  S -> C  channel list,            u16 count, count * str16(name)
 */

import { PacketReader, PacketWriter } from '../src/net/packet.ts';
import type { Lobby, PeerSocket } from '../src/net/lobby.ts';

export const OP = {
  Confirm: 0x01,
  Login: 0x10,
  LoginResult: 0x11,
  ChannelList: 0x12,
} as const;

export interface Account {
  id: string;
  pass: string;
}

/** Single in-memory account store; the original authenticated against Nexon. */
const accounts = new Map<string, Account>();

/** Channel names, taken from channel2_000.ssd (1 channel, 95-byte payload). */
export const DEFAULT_CHANNELS = ['ch00'];

const encoder = new TextEncoder();

function str(w: PacketWriter, text: string): void {
  w.str(encoder.encode(text));
}

export function attachGateway(lobby: Lobby): void {
  lobby.handler = (peer: PeerSocket, op: number, body: Uint8Array) => {
    switch (op) {
      case OP.Login: {
        const r = new PacketReader(body);
        const id = new TextDecoder('euc-kr').decode(r.str16());
        const pass = new TextDecoder('euc-kr').decode(r.str16());
        const existing = accounts.get(id);
        if (!existing) {
          accounts.set(id, { id, pass });
        } else if (existing.pass !== pass) {
          sendLoginResult(peer, false, '비밀번호가 틀립니다.');
          return;
        }
        sendLoginResult(peer, true, '');
        sendChannels(peer);
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

function sendChannels(peer: PeerSocket): void {
  const w = new PacketWriter();
  w.u16(DEFAULT_CHANNELS.length);
  for (const c of DEFAULT_CHANNELS) str(w, c);
  peer.send(OP.ChannelList, w.finish());
}
