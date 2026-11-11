/**
 * Packet reader/writer, ported from the CSendPacket / CPacket accessors so the
 * field order on the wire cannot drift from the original.
 *
 * Every accessor is big endian (sub_5652E0 / sub_5652F0 / sub_565390 /
 * sub_5653A0).  Strings are length prefixed with a u16 (sub_565340 /
 * sub_565520: strlen, then high byte, low byte, then the bytes) and are read
 * back with a u16 length by CPacket::ReadString.
 */

export class PacketWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity);
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(64, (this.len + n + 63) & ~63));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    this.reserve(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.reserve(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u32(v: number): this {
    this.reserve(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  i32(v: number): this {
    return this.u32(v >>> 0);
  }

  s8(v: number): this {
    return this.u8(v < 0 ? 256 + v : v);
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  bytes(data: Uint8Array): this {
    this.reserve(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
    return this;
  }

  /** sub_565340: u16 length + cp949 bytes (caller encodes). */
  str(v: Uint8Array): this {
    this.u16(v.length);
    return this.bytes(v);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }
}

export class PacketReader {
  readonly buf: Uint8Array;
  pos = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(): number {
    return this.buf[this.pos++] ?? 0;
  }

  u16(): number {
    const v = ((this.buf[this.pos] ?? 0) << 8) | (this.buf[this.pos + 1] ?? 0);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v =
      (((this.buf[this.pos] ?? 0) << 24) |
        ((this.buf[this.pos + 1] ?? 0) << 16) |
        ((this.buf[this.pos + 2] ?? 0) << 8) |
        (this.buf[this.pos + 3] ?? 0)) >>>
      0;
    this.pos += 4;
    return v;
  }

  i32(): number {
    return this.u32() | 0;
  }

  s8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  bytes(n: number): Uint8Array {
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** ReadStringByte: u8 length prefix. */
  str8(): Uint8Array {
    return this.bytes(this.u8());
  }

  /** ReadString: u16 length prefix. */
  str16(): Uint8Array {
    return this.bytes(this.u16());
  }

  skip(n: number): void {
    this.pos += n;
  }
}
