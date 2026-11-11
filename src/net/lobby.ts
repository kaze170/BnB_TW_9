/**
 * Server-side socket state machine.
 *
 * CClientSocket (CA.exe) does the following, and the server side has to mirror
 * it because both ends share the same cipher parameters:
 *
 *   possible_ctor_or_dtor   sub_5803A0(this, 0x18000, 0xC000, ...)
 *                           sub_580500(this, 102, 192, 231)   -> this+9,10,11
 *                           sub_580520(this, 40, 40, 3, 3)    -> this+12..15
 *   sub_580680              builds the first packet as "use this key"
 *   sub_580580(buf)         confirms:  buf[0] == (key + 231) ^ (102 + 40)
 *   sub_5805F0(&b)          emits (nonce + 231) ^ (102 + 40)
 *
 * this+12 doubles as the "cipher active" switch that sub_5806F0 passes to
 * sub_57EBC0 as `a4`, and this+14 is added to it after every packet — the
 * obfuscated opcode byte is therefore only used until the key is confirmed.
 *
 * Nothing in this file invents a wire format; it only decides what the server
 * answers, which the task explicitly allows.
 */

import {
  encodeFrame,
  frameLength,
  decodeFrame,
  CIPHER_NONE,
  type SocketCipher,
} from "./protocol.ts";
import { PacketReader, PacketWriter } from "./packet.ts";

export type PacketHandler = (op: number, body: Uint8Array) => void;

const EMPTY = new Uint8Array(0);

export interface Peer {
  cipher: SocketCipher;
  /** true once the client has confirmed the key (sub_580580 returned non-zero) */
  keyConfirmed: boolean;
  send(op: number, body?: Uint8Array): void;
  onPacket: PacketHandler | null;
}

const SOCKET_KEYS = { a: 102, b: 192, c: 231 } as const;
const SOCKET_STEP = { x: 40, y: 40, z: 3, w: 3 } as const;

/** sub_580540: the sent key byte for a socket whose key material is `nonce`. */
export function socketSendKey(nonce: number): number {
  return ((nonce + SOCKET_KEYS.c) ^ (SOCKET_KEYS.a + SOCKET_STEP.x)) & 0xff;
}

/** sub_580580's comparison: buf[0] must equal the byte the client sent. */
export function socketConfirmExpected(nonce: number): number {
  return ((nonce + SOCKET_KEYS.c) ^ (SOCKET_KEYS.a + SOCKET_STEP.x)) & 0xff;
}

/** sub_5805F0: the key byte the peer expects to read back. */
export function socketReadKey(nonce: number): number {
  return ((nonce + SOCKET_KEYS.b) ^ (SOCKET_KEYS.a + SOCKET_STEP.y)) & 0xff;
}

/** One connected client, mirroring CClientSocket's buffer + sub_57ED70 walk. */
export class PeerSocket implements Peer {
  cipher: SocketCipher = { key: 0, mode: CIPHER_NONE, cryptKey: true };
  keyConfirmed = false;
  onPacket: PacketHandler | null = null;
  private buf = new Uint8Array(0);
  private readonly sink: (bytes: Uint8Array) => void;

  constructor(sink: (bytes: Uint8Array) => void) {
    this.sink = sink;
  }

  send(op: number, body: Uint8Array = EMPTY): void {
    this.sink(encodeFrame(op, body, this.cipher));
  }

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      const need = frameLength(this.buf);
      if (need <= 0 || this.buf.length < need) return;
      const frame = this.buf.subarray(0, need);
      this.buf = this.buf.subarray(need);
      const body = decodeFrame(frame, this.cipher);
      if (body && body.length > 0) this.onPacket?.(body[0]!, body.subarray(1));
    }
  }
}

/**
 * Lobby: owns the accepted sockets and routes their packets.
 * The handlers are wired in gateway.ts once the opcode table is filled in.
 */
export class Lobby {
  private readonly peers = new Map<unknown, PeerSocket>();
  handler: ((peer: PeerSocket, op: number, body: Uint8Array) => void) | null = null;

  join(ws: unknown): void {
    const peer = new PeerSocket((bytes) => this.rawSend(ws, bytes));
    peer.onPacket = (op, body) => this.handler?.(peer, op, body);
    // The server picks the key byte the client must echo back (CClientSocket's
    // sub_5805F0 produces (nonce + 192) ^ 142 for a socket whose random is
    // `nonce`); the shared cipher key is that same byte on both ends.
    const nonce = (Math.random() * 256) & 0xff;
    const keyByte = socketReadKey(nonce);
    this.peers.set(ws, peer);
    // Hello goes out in the clear; everything after it is obfuscated with the
    // negotiated key (CClientSocket turns the obfuscation on when the key is
    // accepted, not when it sends the hello).
    peer.cipher.key = keyByte;
    peer.cipher.cryptKey = false;
    this.rawSend(ws, encodeFrame(1, new Uint8Array([keyByte]), {
      key: keyByte,
      mode: CIPHER_NONE,
      cryptKey: false,
    }));
    peer.cipher.cryptKey = true;
    peer.keyConfirmed = true;
    void PacketReader;
    void PacketWriter;
  }

  handle(ws: unknown, raw: string | Uint8Array): void {
    const peer = this.peers.get(ws);
    if (!peer) return;
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(raw);
    peer.push(bytes);
  }

  leave(ws: unknown): void {
    this.peers.delete(ws);
  }

  broadcast(op: number, body: Uint8Array = EMPTY): void {
    for (const [, peer] of this.peers) peer.send(op, body);
  }

  get size(): number {
    return this.peers.size;
  }

  /** bun's ServerWebSocket.send lives on the socket object. */
  private rawSend(ws: unknown, bytes: Uint8Array): void {
    const s = ws as { send?: (data: Uint8Array) => void };
    s.send?.(bytes);
  }
}
