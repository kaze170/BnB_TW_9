/**
 * Browser-side socket, mirroring CClientSocket.
 *
 * The framing, key derivation and opcode obfuscation are the ones reversed
 * from CA.exe (see ./protocol.ts).  What the *server* answers is ours to
 * decide, so the opcode numbers below are the only invented part of this file
 * and they live in one place.
 */

import {
  CIPHER_NONE,
  decodeFrame,
  encodeFrame,
  frameLength,
  type SocketCipher,
} from './protocol.ts';
import { PacketReader, PacketWriter } from './packet.ts';

/** Server-defined opcodes (the client side of the handshake is original). */
export const OP = {
  /** server -> client: key confirmation, body = [keyByte] */
  Confirm: 0x01,
  /** client -> server: login, body = str16(id), str16(pass) */
  Login: 0x10,
  /** server -> client: login result, body = u8 ok, str16(message) */
  LoginResult: 0x11,
  /** server -> client: channel list, body = u16 count, count * str16(name) */
  ChannelList: 0x12,
} as const;

export interface SocketEvents {
  open?: () => void;
  close?: (code: number, reason: string) => void;
  error?: (err: unknown) => void;
  packet?: (op: number, body: Uint8Array) => void;
}

export class GameSocket {
  readonly cipher: SocketCipher = { key: 0, mode: CIPHER_NONE, cryptKey: false };
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private events: SocketEvents;

  constructor(events: SocketEvents = {}) {
    this.events = events;
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.events.open?.();
        resolve();
      };
      ws.onerror = (ev) => {
        this.events.error?.(ev);
        reject(ev);
      };
      ws.onclose = (ev) => this.events.close?.(ev.code, ev.reason);
      ws.onmessage = (ev) => {
        const data = ev.data;
        if (!(data instanceof ArrayBuffer)) return;
        this.push(new Uint8Array(data));
      };
    });
  }

  private push(chunk: Uint8Array): void {
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
      if (body && body.length > 0) this.dispatch(body[0]!, body.subarray(1));
    }
  }

  private confirmed = false;

  private dispatch(op: number, body: Uint8Array): void {
    // sub_580580: the first packet carries the socket key; until then the
    // opcode byte is obfuscated and the cipher is not active.
    if (!this.confirmed && op === OP.Confirm) {
      // sub_580580 sets the socket key from this packet; from here on the
      // opcode byte is obfuscated (this+12 becomes non-zero).
      this.cipher.key = body[0] ?? 0;
      this.cipher.cryptKey = true;
      this.confirmed = true;
      this.events.packet?.(op, body);
      return;
    }
    this.events.packet?.(op, body);
  }

  setKey(nonce: number): void {
    this.cipher.key = nonce;
  }

  send(op: number, body: Uint8Array = new Uint8Array(0)): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(op, body, this.cipher));
  }

  login(id: string, pass: string): void {
    const text = new TextEncoder();
    const w = new PacketWriter();
    w.str(text.encode(id));
    w.str(text.encode(pass));
    this.send(OP.Login, w.finish());
  }

  close(): void {
    this.ws?.close();
  }
}

export { PacketReader, PacketWriter };
