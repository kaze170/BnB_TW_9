/**
 * Server list — `multisvr.ssd`.
 *
 * Reversed from `sub_50C1CB` (the parser) and its caller `sub_50C58E`, which
 * loads `multisvr.ssd` through `sub_5800C0` (the `ssi1` reader) and falls back
 * to `multisvrn.ssd` when the first file is missing (`aMultisvrnSsd`
 * @0x5D9DE0).
 *
 * Layout of the decoded payload (verified byte exact on the shipped file: the
 * walk consumes all 43 bytes):
 *
 *   u8  count                              // sub_580220
 *   count * {
 *     str  name                            // sub_580280, CISmartStream::DecodeStr
 *     str  description                     // sub_580280
 *     u32  unknown                         // sub_580260 (0 in the shipped file)
 *   }
 *   u16 endpointCount                      // 2
 *   endpointCount * {
 *     u32 address                          // network order, 211.20.189.170
 *     u16 port                             // 3838
 *     u8  flag                             // 1
 *   }
 *   u8  trailer                            // 1
 *
 * The endpoints are the real retail servers: 211.20.189.170 and
 * 211.20.177.140 on port 3838, both in HiNet's range, which matches the
 * "BnB-HiNet" channel name in channel2_000.ssd.
 */

import { readSsi, decodeBig5 } from './ssi.ts';

export interface ServerEndpoint {
  /** dotted quad as written in the file (network byte order) */
  address: string;
  port: number;
  flag: number;
}

export interface ServerEntry {
  name: string;
  description: string;
  /** `sub_580260` field; 0 in the shipped file, meaning not established */
  unknown: number;
  endpoints: ServerEndpoint[];
}

export interface ServerList {
  servers: ServerEntry[];
}

/**
 * The addresses CMultiServer's constructor bakes in
 * (`CMultiServer::possible_ctor_or_dtor_0` + `sub_50C0FC`): four HiNet hosts on
 * port 0xEFE = 3838, added with the index bytes 1, 2, 3, 4.  The shipped
 * `multisvr.ssd` carries only two of them (170 and 140), so a client that only
 * reads the file sees a subset of the retail realm list.
 *
 * These are data from the executable, not invented: the port and the four
 * dotted quads are literal string constants at 0x5D9D50..0x5D9D80 plus
 * `mov [ebp+var_14], 0EFEh`.
 */
export const BUILTIN_SERVERS: readonly ServerEndpoint[] = [
  { address: '211.20.189.170', port: 3838, flag: 1 },
  { address: '211.20.177.139', port: 3838, flag: 2 },
  { address: '211.20.177.140', port: 3838, flag: 3 },
  { address: '211.20.177.141', port: 3838, flag: 4 },
] as const;

/**
 * The realm list the client actually ends up with: the file's endpoints first
 * (they carry the file's own flags), then any built-in address the file did not
 * mention.
 */
export function mergeWithBuiltins(list: ServerList | null): ServerEndpoint[] {
  const out: ServerEndpoint[] = [];
  const seen = new Set<string>();
  const push = (ep: ServerEndpoint): void => {
    const key = `${ep.address}:${ep.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ep);
  };
  for (const s of list?.servers ?? []) for (const ep of s.endpoints) push(ep);
  for (const ep of BUILTIN_SERVERS) push(ep);
  return out;
}

/** Read a Big5 string the way `DecodeStr` does, NUL terminated. */
function readString(payload: Uint8Array, off: number, len: number): string {
  const raw = payload.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return decodeBig5(nul >= 0 ? raw.subarray(0, nul) : raw);
}

export function parseServerList(payload: Uint8Array): ServerList | null {
  if (payload.length < 1) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = payload[0]!;
  if (count > 64) return null;

  const servers: ServerEntry[] = [];
  let off = 1;
  for (let i = 0; i < count; i++) {
    if (off + 4 > payload.length) return null;
    const nameLen = dv.getUint32(off, true);
    off += 4;
    if (nameLen > payload.length - off) return null;
    const name = readString(payload, off, nameLen);
    off += nameLen;

    if (off + 4 > payload.length) return null;
    const descLen = dv.getUint32(off, true);
    off += 4;
    if (descLen > payload.length - off) return null;
    const description = readString(payload, off, descLen);
    off += descLen;

    if (off + 4 > payload.length) return null;
    const unknown = dv.getUint32(off, true);
    off += 4;

    // Endpoints follow the server records, but the shipped file has a single
    // server, so attach them to it.  With more servers the endpoints cannot be
    // attributed without the retail file, so they are left empty.
    servers.push({ name, description, unknown, endpoints: [] });
  }

  if (off + 2 <= payload.length) {
    const endpointCount = dv.getUint16(off, true);
    off += 2;
    const endpoints: ServerEndpoint[] = [];
    for (let i = 0; i < endpointCount; i++) {
      if (off + 7 > payload.length) return null;
      const a = payload[off]!;
      const b = payload[off + 1]!;
      const c = payload[off + 2]!;
      const d = payload[off + 3]!;
      const port = dv.getUint16(off + 4, true);
      const flag = payload[off + 6]!;
      off += 7;
      endpoints.push({ address: `${a}.${b}.${c}.${d}`, port, flag });
    }
    // One trailing byte closes the payload in the shipped file.
    if (off === payload.length - 1) off++;
    if (off !== payload.length) return null;
    if (servers.length === 1) servers[0]!.endpoints = endpoints;
    else if (endpoints.length) servers[0]!.endpoints = endpoints;
  }

  return { servers };
}

export function readServerList(bytes: Uint8Array): ServerList | null {
  const ssi = readSsi(bytes);
  if (!ssi) return null;
  return parseServerList(ssi.payload);
}
