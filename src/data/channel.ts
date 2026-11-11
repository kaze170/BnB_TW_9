/**
 * Channel list — `channel2_NNN.ssd`.
 *
 * Reversed from `CLoginStage`'s loader chain:
 *
 *   sub_50A185  builds the file name with `wsprintf("channel2_%03d%s.ssd", n, s)`
 *               (`aChannel203dSSs` @0x5D9CDC) and loads it through sub_5800C0.
 *   sub_50A091  parses the record body, one iteration per channel.
 *
 * Layout of the decoded `ssi1` payload (verified byte exact on the shipped
 * `channel2_000.ssd`: the walk consumes all 119 bytes):
 *
 *   u16 count
 *   count * {
 *     u32 nameLen                   // sub_580280, CISmartStream::DecodeStr
 *     u8  name[nameLen]             // Big5, NUL padded
 *     u16 maxUsers                  // 400 in every shipped record
 *     u8  users
 *     u8  0                         // padding
 *     u8  kind                      // 1 / 0 / 41 / 99 / 76 in the shipped set
 *     u16 group                     // 10 for every record
 *     u8  flag                      // 1
 *     u8  0                         // padding
 *     u8  index                     // per-realm channel ordinal
 *   }
 *
 * The field widths come from the code: `sub_580240` is a little-endian u16
 * (it calls `sub_57FE10` with a size of 2), `sub_580220` is a u8 and
 * `sub_580280` is `DecodeStr` (u32 length + bytes).
 */

import { readSsi, decodeBig5 } from './ssi.ts';

export interface Channel {
  /** Big5 name as stored, e.g. "BnB初級-1" */
  name: string;
  /**
   * The name exactly as stored (Big5, NUL stripped).
   *
   * Needed because no runtime here has a Big5 *encoder*: the browser has a
   * `TextDecoder('big5')` but no matching `TextEncoder`, so a decoded name
   * cannot be put back on the wire unchanged.  Keeping the file bytes means the
   * server forwards what the retail client would have sent.
   */
  nameBytes: Uint8Array;
  /** advertised capacity */
  maxUsers: number;
  /** user count at the time the file was written */
  users: number;
  /**
   * Channel class.  The shipped set uses 1 (beginner), 0, 41 (unrestricted),
   * 99 (free) and 76 (high-rank).  The client picks the channel's icon art
   * from this value, but the icon table itself lives in the retail server.
   */
  kind: number;
  /** channel group, 10 in every shipped record */
  group: number;
  /** ordinal inside the group */
  index: number;
}

export interface ChannelFile {
  channels: Channel[];
  /** realm number parsed from the file name (`channel2_000.ssd` -> 0) */
  realm: number;
  /** the suffix in the file name, "" for the shipped file */
  suffix: string;
}

const CHANNEL_FILE_RE = /channel2_(\d{3})(.*)\.ssd$/i;

/**
 * Parse a `channel2_NNN.ssd` payload.
 *
 * Returns `null` when the walk does not land exactly on the end of the buffer,
 * which is the same discipline `sub_50A091` relies on: `[edi+4]` is the record
 * count from the stream, and the loop is bounded by the stream length.
 */
export function parseChannelFile(payload: Uint8Array, fileName = 'channel2_000.ssd'): ChannelFile | null {
  if (payload.length < 2) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = dv.getUint16(0, true);
  if (count < 1 || count > 4096) return null;

  const channels: Channel[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    if (off + 4 > payload.length) return null;
    const nameLen = dv.getUint32(off, true);
    off += 4;
    if (nameLen > payload.length - off) return null;
    const rawName = payload.subarray(off, off + nameLen);
    off += nameLen;
    const nul = rawName.indexOf(0);
    const nameBytes = (nul >= 0 ? rawName.subarray(0, nul) : rawName).slice();
    const name = decodeBig5(nameBytes);

    // The ten trailing bytes of a record; see the layout comment above.
    if (off + 10 > payload.length) return null;
    const maxUsers = dv.getUint16(off, true);
    const users = payload[off + 2]!;
    const kind = payload[off + 4]!;
    const group = dv.getUint16(off + 5, true);
    const index = payload[off + 9]!;
    off += 10;

    channels.push({ name, nameBytes, maxUsers, users, kind, group, index });
  }
  if (off !== payload.length) return null;

  const m = CHANNEL_FILE_RE.exec(fileName);
  return {
    channels,
    realm: m ? Number(m[1]) : 0,
    suffix: m ? (m[2] ?? '') : '',
  };
}

/** Read and parse a `channel2_NNN.ssd` file (an `ssi1` container). */
export function readChannelFile(bytes: Uint8Array, fileName: string): ChannelFile | null {
  const ssi = readSsi(bytes);
  if (!ssi) return null;
  return parseChannelFile(ssi.payload, fileName);
}
