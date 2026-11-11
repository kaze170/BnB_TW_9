/**
 * Wire protocol of the original client, reverse engineered from CA.exe.
 *
 * ---- framing (CClientSocket, cipher mode 0) -------------------------------
 *   [0]     key byte       = plain ^ (socketKey + 40)          sub_57E6A0(mode 0)
 *   [1..2]  u16 BE         = bodyLen ^ 0xA569
 *   [3..]   body           body[0] is the opcode byte (sub_466EBC reads it first)
 *   (no trailer)
 * Total = bodyLen + 3.  Cipher mode 1 appends one crc16 byte (total +4) and
 * mode 2 a four byte crc32 (total +7); see sub_57E6A0, which is handed
 * a3-3 / a3-4 / a3-7 as the body length for the three modes.
 *
 * Every integer on the wire is big endian: sub_5652E0 / sub_5652F0 store the
 * high byte first, sub_565390 / sub_5653A0 read the same way.
 *
 * ---- cipher (sub_57E3E0 encrypt, sub_57E480 decrypt) ----------------------
 * A 4-byte chained XOR over little-endian dwords, seeded from the opcode:
 *   k0 = key ^ 0x53351D9C
 *   out0 = in0 ^ k0
 *   k1 = k0 - 0x63CAACE3
 *   out1 = in1 ^ in0 ^ k1          (in0 = plaintext word 0)
 *   k2 = k1 - 0x63CAACE3
 *   out2 = in2 ^ in1 ^ k2
 *   ...
 * The odd 1..3 trailing bytes are XORed with the bytes of the *last* key
 * word, least significant first:  out[i] = in[i] ^ ((kLast >> (8*i)) & 0xFF).
 * Decryption (sub_57E480) uses the recovered word as the chain input instead.
 *
 * Before that chained XOR, every body byte except the first is replaced by
 * byte_61E880[opcode * 256 + b]  (sub_57E6A0 encrypt -> sub_580980).
 * Decryption uses byte_61F880 (sub_57EBC0 -> sub_5809A0), which I verified is
 * the exact inverse permutation of byte_61E880 for all 16 rows.
 *
 * ---- checksums -----------------------------------------------------------
 * sub_566620: table driven CRC-32, polynomial 0x4C11DB7, no final xor, seeded
 * with the socket key.  sub_566730/566690 is a byte-wide variant of the same
 * idea (see the table comment below); it is what the original checks, so it is
 * what we reproduce.
 */

import { SBOX_DEC, SBOX_ENC } from "./sbox.ts";

export const CIPHER_NONE = 0;
export const CIPHER_BYTE = 1;
export const CIPHER_INT = 2;

/** sub_566580 table: CRC-32 with polynomial 0x4C11DB7, no xorout, no reflection. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x4c11db7) >>> 0 : (r << 1) >>> 0;
    }
    t[i] = r;
  }
  return t;
})();

/**
 * sub_566690 table.  Note it shifts in 8 bits, not 16: sub_566690 starts from
 * 2*i and applies "if bit7 then xor 0x107", eight times, so every entry stays
 * below 0x100.  That is why sub_566730's byte-sized crc looks unlike a real
 * CRC-16; it is what the client computes, so it is what we compute.
 */
const CRC16_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let r = 2 * i;
    if ((i & 0x80) !== 0) r ^= 0x107;
    for (let j = 0; j < 7; j++) {
      r = (r & 0x80) !== 0 ? ((2 * r) ^ 0x107) : 2 * r;
    }
    t[i] = r & 0xff;
  }
  return t;
})();

/** sub_566620(seed, buf, len) */
export function crc32Bnb(seed: number, buf: Uint8Array, start = 0, end = buf.length): number {
  let v = seed >>> 0;
  for (let i = start; i < end; i++) {
    v = (CRC32_TABLE[(buf[i]! ^ (v >>> 24)) & 0xff]! ^ (v << 8)) >>> 0;
  }
  return v >>> 0;
}

/** sub_566730(seed, buf, len) */
export function crc16Bnb(seed: number, buf: Uint8Array, start = 0, end = buf.length): number {
  let v = seed & 0xff;
  for (let i = start; i < end; i++) {
    v = CRC16_TABLE[(v ^ buf[i]!) & 0xff]!;
  }
  return v & 0xff;
}

/**
 * sub_580980(row, col) / sub_5809A0(row, col).
 *
 * Both tables are addressed `byte_61E880[row*256 + col]` in source, which the
 * compiler turns into `byte_61E880[eax+ecx]` with only AL live, so the index is
 * (row & 0xFF) * 256 + col — 256 rows of 256 bytes.  The difference matters:
 * IDA declares both as 4096 bytes, i.e. 16 rows, so the row is `key & 0x0F` in
 * both directions; the bytes just past byte_61E880 that also look like
 * permutations belong to the next object, not to this table.
 */
export function sboxEnc(row: number, col: number): number {
  return SBOX_ENC[(((row & 0x0f) << 8) | (col & 0xff)) & 0xfff]!;
}

/** sub_5809A0(row, col) */
export function sboxDec(row: number, col: number): number {
  return SBOX_DEC[(((row & 0x0f) << 8) | (col & 0xff)) & 0xfff]!;
}

/**
 * sub_57E3E0: encrypt.  out0 = in0 ^ k0; out_i = in_i ^ in_(i-1) ^ k_i
 * (the chain feeds back the previous *plaintext* word).
 */
export function cipherEncrypt(buf: Uint8Array, start: number, len: number, key: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const words = len >>> 2;
  const rest = len & 3;
  let k = (key ^ 0x53351d9c) >>> 0;
  let p = start;
  let prev = 0;
  for (let i = 0; i < words; i++) {
    const cur = view.getUint32(p, true);
    view.setUint32(p, (cur ^ prev ^ k) >>> 0, true);
    prev = cur;
    if (i + 1 < words || rest > 0) k = (k - 0x63caace3) >>> 0;
    p += 4;
  }
  const tailKey = words > 0 ? prev : k;
  for (let i = 0; i < rest; i++) {
    buf[p + i] = (buf[p + i]! ^ ((tailKey >>> (8 * i)) & 0xff)) & 0xff;
  }
}

/**
 * sub_57E480: decrypt.  out_i = in_i ^ out_(i-1) ^ k_i — the chain feeds back
 * the previous *plaintext* (already recovered) word, which is what makes it the
 * inverse of cipherEncrypt.  The 0..3 trailing bytes use the last recovered
 * word, matching the encrypt side.
 */
export function cipherDecrypt(buf: Uint8Array, start: number, len: number, key: number): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const words = len >>> 2;
  const rest = len & 3;
  let k = (key ^ 0x53351d9c) >>> 0;
  let p = start;
  let prev = 0;
  for (let i = 0; i < words; i++) {
    const cur = view.getUint32(p, true);
    const out = (cur ^ prev ^ k) >>> 0;
    view.setUint32(p, out, true);
    prev = out;
    if (i + 1 < words || rest > 0) k = (k - 0x63caace3) >>> 0;
    p += 4;
  }
  const tailKey = prev;
  for (let i = 0; i < rest; i++) {
    buf[p + i] = (buf[p + i]! ^ ((tailKey >>> (8 * i)) & 0xff)) & 0xff;
  }
}

/**
 * Byte-replacement step, in place, over buf[start+1 .. start+len).
 *
 * Encrypt (sub_57E6A0): after the cipher has been applied the key byte sits in
 * body[0], and every remaining byte goes through byte_61E880[key * 256 + b].
 * That table has 32 valid permutations, one per packet opcode.
 *
 * Decrypt (sub_57EBC0): the substitution is undone *before* the cipher, keyed
 * by the still-ciphered body[0]; byte_61F880 only has 16 permutations, so the
 * row is (cipherKeyByte & 0x0F).  This asymmetry is in the original.
 */
export function substitute(buf: Uint8Array, start: number, len: number, row: number, inverse: boolean): void {
  const table = inverse ? SBOX_DEC : SBOX_ENC;
  const base = ((row & 0x0f) << 8);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    buf[idx] = table[base | buf[idx]!]!;
  }
}

export interface SocketCipher {
  /** CClientSocket::this+8 — the value the server echoes back during the handshake */
  key: number;
  /** CClientSocket::this+7 — cipher mode, 0..2 */
  mode: number;
  /** CClientSocket::this+12 — substitute the opcode byte while the key is not confirmed */
  cryptKey: boolean;
}

/**
 * Serialise one packet exactly as CSendPacket::sub_57E6A0 does for cipher mode
 * 0, the only mode CClientSocket ever uses (sub_5804C0, which would change it,
 * has no call site in the binary).
 *
 * `body` excludes the opcode.
 */
export function encodeFrame(opcode: number, body: Uint8Array, sock: SocketCipher): Uint8Array<ArrayBuffer> {
  const bodyLen = 1 + body.length;
  const out = new Uint8Array(new ArrayBuffer(3 + bodyLen));
  out[0] = (opcode ^ ((sock.key + 40) & 0xff)) & 0xff;
  out[1] = ((bodyLen ^ 0xa569) >>> 8) & 0xff;
  out[2] = (bodyLen ^ 0xa569) & 0xff;
  out[3] = sock.cryptKey ? sboxEnc(sock.key, opcode) : opcode;
  out.set(body, 4);
  return out;
}

/** sub_57ED70 — total frame length, or -1 when the head is still short. */
export function frameLength(head: Uint8Array, _mode = CIPHER_NONE): number {
  if (head.length < 3) return -1;
  return ((((head[1]! << 8) | head[2]!) ^ 0xa569) + 3) >>> 0;
}

/** Inverse of encodeFrame (the mode 0 branch of sub_57EBC0). */
export function decodeFrame(frame: Uint8Array, sock: SocketCipher): Uint8Array | null {
  const bodyLen = frame.length - 3;
  if (bodyLen <= 0) return null;
  const body = frame.slice(3, 3 + bodyLen);
  if (sock.cryptKey) body[0] = sboxDec(sock.key, body[0]!);
  return body;
}
