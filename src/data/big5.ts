/**
 * Bidirectional Big5 <-> UTF-16 codec.
 *
 * Built once at startup from the runtime's standard `TextDecoder('big5')` table
 * (`0x81..0xFE` lead bytes × `0x40..0x7E, 0xA1..0xFE` trail bytes), so both
 * Bun (server) and Web browsers encode and decode every Traditional Chinese
 * string identically to `CA.exe` (codepage 950 / Big5) with zero dependencies.
 */

const big5Decoder = new TextDecoder('big5');
let charToBig5: Map<number, number> | null = null;

function ensureEncodeTable(): Map<number, number> {
  if (charToBig5) return charToBig5;
  const map = new Map<number, number>();
  const pair = new Uint8Array(2);
  for (let b1 = 0x81; b1 <= 0xfe; b1++) {
    pair[0] = b1;
    for (let b2 = 0x40; b2 <= 0xfe; b2++) {
      if (b2 > 0x7e && b2 < 0xa1) continue;
      pair[1] = b2;
      const decoded = big5Decoder.decode(pair);
      if (decoded.length === 1) {
        const cp = decoded.charCodeAt(0);
        if (cp !== 0xfffd && !map.has(cp)) {
          map.set(cp, (b1 << 8) | b2);
        }
      }
    }
  }
  charToBig5 = map;
  return map;
}

export function decodeBig5(bytes: Uint8Array): string {
  // Trim trailing NUL if present
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return '';
  return big5Decoder.decode(bytes.subarray(0, end));
}

export function encodeBig5(text: string): Uint8Array {
  if (!text) return new Uint8Array(0);
  const table = ensureEncodeTable();
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const dbcs = table.get(cp);
    if (dbcs !== undefined) {
      out.push((dbcs >>> 8) & 0xff, dbcs & 0xff);
    } else {
      // Fallback question mark for unmappable codepoints
      out.push(0x3f);
    }
  }
  return new Uint8Array(out);
}
