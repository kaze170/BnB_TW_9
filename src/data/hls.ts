/**
 * Retail HLS team-color transform & `CDataI16Character` compositor.
 *
 * Reversed directly from `CA.exe`:
 *   - `sub_578BA0`..`sub_578EA0` (RGB <-> HLS with H in 0..360, L & S in 0..1)
 *   - `dbl_6184D0` (VA `0x6184D0`): 8 team color `(dH, dL, dS)` presets used
 *     when compositing `LayerStatic` + `LayerAdjust` (`CDataI16Character::sub_4E1ADF`).
 */

import type { SpriteSheet } from './sprite.ts';

export interface TeamHlsDelta {
  readonly dH: number;
  readonly dL: number;
  readonly dS: number;
  readonly label: string;
  readonly hex: string;
}

/** Exact `dbl_6184D0[0..7]` from `CA.exe` `.rdata` VA `0x6184D0`. */
export const TEAM_HLS: readonly TeamHlsDelta[] = [
  { dH: 0, dL: 0, dS: 0, label: '紅隊', hex: '#ff3b30' },
  { dH: 45, dL: 0, dS: 0, label: '橘隊', hex: '#ff9500' },
  { dH: 27, dL: 0.03, dS: 0.45, label: '黃隊', hex: '#ffcc00' },
  { dH: 128, dL: -0.01, dS: -0.55, label: '綠隊', hex: '#34c759' },
  { dH: -175, dL: 0, dS: -0.33, label: '水藍', hex: '#32ade6' },
  { dH: -155, dL: 0, dS: 0, label: '藍隊', hex: '#2e7cf6' },
  { dH: -77, dL: 0, dS: -0.16, label: '紫隊', hex: '#af52de' },
  { dH: 0, dL: 0.05, dS: -1, label: '灰白', hex: '#d1d1d6' },
] as const;

function hueToRgb(m1: number, m2: number, h: number): number {
  let hh = h;
  if (hh < 0) hh += 360;
  if (hh > 360) hh -= 360;
  if (hh < 60) return m1 + ((m2 - m1) * hh) / 60;
  if (hh < 180) return m2;
  if (hh < 240) return m1 + ((m2 - m1) * (240 - hh)) / 60;
  return m1;
}

/** Apply `(dH, dL, dS)` to packed `0xAABBGGRR` pixel (`sub_578D20..0x578EA0`). */
export function shiftPixelHls(abgr: number, dH: number, dL: number, dS: number): number {
  const a = (abgr >>> 24) & 0xff;
  if (a === 0) return 0;
  if (dH === 0 && dL === 0 && dS === 0) return abgr;

  const r = (abgr & 0xff) / 255;
  const g = ((abgr >>> 8) & 0xff) / 255;
  const b = ((abgr >>> 16) & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) * 0.5;
  let s = 0;
  let h = 0;

  if (max !== min) {
    const d = max - min;
    s = l <= 0.5 ? d / (max + min) : d / (2 - max - min);
    if (r === max) h = (g - b) / d;
    else if (g === max) h = 2 + (b - r) / d;
    else h = 4 + (r - g) / d;
    h *= 60;
    if (h < 0) h += 360;
  }

  h = (h + dH) % 360;
  if (h < 0) h += 360;
  l = Math.max(0, Math.min(1, l + dL));
  s = Math.max(0, Math.min(1, s + dS));

  let nr: number;
  let ng: number;
  let nb: number;
  if (s === 0) {
    nr = l;
    ng = l;
    nb = l;
  } else {
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const m1 = 2 * l - m2;
    nr = hueToRgb(m1, m2, h + 120);
    ng = hueToRgb(m1, m2, h);
    nb = hueToRgb(m1, m2, h - 120);
  }

  const ri = Math.max(0, Math.min(255, Math.round(nr * 255)));
  const gi = Math.max(0, Math.min(255, Math.round(ng * 255)));
  const bi = Math.max(0, Math.min(255, Math.round(nb * 255)));
  return ((a << 24) | (bi << 16) | (gi << 8) | ri) >>> 0;
}

/** Return a copy of `sheet` with `TEAM_HLS[colorIdx]` applied to every non-transparent texel. */
export function tintSheetByTeam(sheet: SpriteSheet, colorIdx: number): SpriteSheet {
  const delta = TEAM_HLS[((colorIdx % 8) + 8) % 8]!;
  if (delta.dH === 0 && delta.dL === 0 && delta.dS === 0) return sheet;
  const tinted = new Uint32Array(sheet.pixels.length);
  for (let i = 0; i < sheet.pixels.length; i++) {
    const p = sheet.pixels[i]!;
    tinted[i] = p === 0 ? 0 : shiftPixelHls(p, delta.dH, delta.dL, delta.dS);
  }
  return {
    ...sheet,
    pixels: tinted,
  };
}

/** Map game team number (`0=FFA, 1=Red, 2=Blue, 3=Yellow, 4=Green, 5=Orange, 6=Purple, 7=Cyan, 8=Grey`) to `TEAM_HLS` index. */
export function teamNumberToHlsIndex(team: number): number {
  switch (team) {
    case 1:
      return 0; // Red
    case 2:
      return 5; // Blue
    case 3:
      return 2; // Yellow
    case 4:
      return 3; // Green
    case 5:
      return 1; // Orange
    case 6:
      return 6; // Purple
    case 7:
      return 4; // Cyan
    case 8:
      return 7; // Grey
    default:
      return 0; // Red default
  }
}

export function tintRgbaByTeam(rgba: Uint8Array, team: number): Uint8Array {
  const hlsIdx = teamNumberToHlsIndex(team);
  const delta = TEAM_HLS[hlsIdx]!;
  if (delta.dH === 0 && delta.dL === 0 && delta.dS === 0) return rgba;
  const out = new Uint8Array(rgba.length);
  const src32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2);
  const dst32 = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >>> 2);
  for (let i = 0; i < src32.length; i++) {
    const p = src32[i]!;
    dst32[i] = p === 0 ? 0 : shiftPixelHls(p, delta.dH, delta.dL, delta.dS);
  }
  return out;
}

export interface AvatarPartLayer {
  readonly staticSheet: SpriteSheet | null;
  readonly adjustSheet: SpriteSheet | null;
  /** Optional starting frame offset within `staticSheet` / `adjustSheet` (used for `CharTE:AvatarDeco` sheets). */
  readonly frameOffset?: number;
}

/**
 * Exact `sub_5C532B` (`CA.exe.c` `L373985..374041`) + `.rdata` `0x005C9B90..0x005C9CE8`
 * action-to-`(sheetIndex, frameOffset)` table for `CharTE:AvatarDeco/Axx_yy_zzzz_{0|1}`:
 *   - `sheet 0` (`_0`, 44 frames `0..43`): Walk & Slide & Ride actions
 *   - `sheet 1` (`_1`, 47 frames `0..46`, global `44..90`): Blink, Hurrah, Dril, Start, Throw, Portrait, PortraitDie
 */
export const AVATAR_DECO_ACTION_MAP: Readonly<Record<string, { sheet: 0 | 1; offset: number; frames: number }>> = {
  WalkDown: { sheet: 0, offset: 0, frames: 5 },
  WalkRight: { sheet: 0, offset: 5, frames: 5 },
  WalkUp: { sheet: 0, offset: 10, frames: 5 },
  WalkLeft: { sheet: 0, offset: 15, frames: 5 },
  SlideJump: { sheet: 0, offset: 20, frames: 4 },
  SlideRide: { sheet: 0, offset: 24, frames: 4 },
  RideDown: { sheet: 0, offset: 28, frames: 4 },
  RideRight: { sheet: 0, offset: 32, frames: 4 },
  RideUp: { sheet: 0, offset: 36, frames: 4 },
  RideLeft: { sheet: 0, offset: 40, frames: 4 },
  Blink: { sheet: 1, offset: 0, frames: 3 },
  Hurrah: { sheet: 1, offset: 3, frames: 4 },
  Dril: { sheet: 1, offset: 7, frames: 8 },
  Start: { sheet: 1, offset: 15, frames: 10 },
  Throw: { sheet: 1, offset: 25, frames: 16 },
  Portrait: { sheet: 1, offset: 41, frames: 2 },
  PortraitDie: { sheet: 1, offset: 43, frames: 4 },
};

/**
 * Composite one or more retail `CDataI16Avatar` parts (`sub_4E0F74` `CA.exe.c` `L201319..201414`
 * and `CGOAvatar` `sub_4238FA` `L33895..34185`) in exact slot order:
 *   - Within each part, `off_6184C8[0]` (`LayerStatic`) is blitted **first** (natural skin/eyes/outlines)
 *     and `off_6184C8[1]` (`LayerAdjust`, HLS-shifted by `teamNumberToHlsIndex(team)`) is blitted **second / on top**.
 *   - Across multi-part characters (`C06` Dizni: `_A -> _B -> A06_30_0001 -> _C`;
 *     `C10` Santa: `_A -> _B -> _C -> A10_60_0001`), parts are composited back-to-front in slot order.
 */
export function compositeAvatarLayers(
  layers: readonly AvatarPartLayer[],
  team: number,
  explicitFrameCount?: number,
): { width: number; height: number; rgba: Uint8Array; rects: SpriteSheet["rects"] } | null {
  const prepared = layers
    .filter((l) => l.staticSheet || l.adjustSheet)
    .map((l) => ({
      staticSheet: l.staticSheet,
      tintedAdjust: l.adjustSheet ? tintSheetByTeam(l.adjustSheet, teamNumberToHlsIndex(team)) : null,
      frameOffset: l.frameOffset ?? 0,
    }));
  if (prepared.length === 0) return null;

  let frameCount = explicitFrameCount ?? 0;
  if (frameCount <= 0) {
    for (const l of prepared) {
      if (l.frameOffset === 0) {
        frameCount = Math.max(
          frameCount,
          l.staticSheet?.rects.length ?? 0,
          l.tintedAdjust?.rects.length ?? 0,
        );
      }
    }
  }
  if (frameCount <= 0) return null;

  interface FrameBox {
    minX: number;
    minY: number;
    w: number;
    h: number;
    delay: number;
  }
  const boxes: FrameBox[] = [];
  let totalW = 0;

  for (let i = 0; i < frameCount; i++) {
    let minX = 1e9;
    let minY = 1e9;
    let maxX = -1e9;
    let maxY = -1e9;
    let delay = 1;
    let gotDelay = false;

    for (const l of prepared) {
      const idx = i + l.frameOffset;
      const rs = l.staticSheet?.rects[idx];
      const ra = l.tintedAdjust?.rects[idx];
      if (!gotDelay && l.frameOffset === 0) {
        if (ra && ra.delay > 0) {
          delay = ra.delay;
          gotDelay = true;
        } else if (rs && rs.delay > 0) {
          delay = rs.delay;
          gotDelay = true;
        }
      }
      if (rs && rs.x1 > rs.x0 && rs.y1 > rs.y0) {
        minX = Math.min(minX, -rs.px);
        minY = Math.min(minY, -rs.py);
        maxX = Math.max(maxX, -rs.px + (rs.x1 - rs.x0));
        maxY = Math.max(maxY, -rs.py + (rs.y1 - rs.y0));
      }
      if (ra && ra.x1 > ra.x0 && ra.y1 > ra.y0) {
        minX = Math.min(minX, -ra.px);
        minY = Math.min(minY, -ra.py);
        maxX = Math.max(maxX, -ra.px + (ra.x1 - ra.x0));
        maxY = Math.max(maxY, -ra.py + (ra.y1 - ra.y0));
      }
    }

    if (minX > maxX) {
      boxes.push({ minX: 0, minY: 0, w: 1, h: 1, delay });
      totalW += 1;
    } else {
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      boxes.push({ minX, minY, w, h, delay });
      totalW += w;
    }
  }

  // Wrap into rows if wider than 2048 so it stays well inside WebGPU 8192 limits
  const MAX_ROW_W = 2048;
  let atlasW = Math.min(MAX_ROW_W, Math.max(1, totalW));
  let curX = 0;
  let curY = 0;
  let rowH = 0;
  const placements: { x: number; y: number }[] = [];
  for (const b of boxes) {
    if (curX > 0 && curX + b.w > MAX_ROW_W) {
      curX = 0;
      curY += rowH;
      rowH = 0;
    }
    placements.push({ x: curX, y: curY });
    curX += b.w;
    if (curX > atlasW) atlasW = curX;
    if (b.h > rowH) rowH = b.h;
  }
  const atlasH = Math.max(1, curY + rowH);
  const out32 = new Uint32Array(atlasW * atlasH);
  const rects: SpriteSheet["rects"] = [];

  for (let i = 0; i < frameCount; i++) {
    const b = boxes[i]!;
    const pl = placements[i]!;

    const blit = (sh: SpriteSheet, rc: SpriteSheet["rects"][number]) => {
      const rw = rc.x1 - rc.x0;
      const rh = rc.y1 - rc.y0;
      if (rw <= 0 || rh <= 0) return;
      const ox = -rc.px - b.minX;
      const oy = -rc.py - b.minY;
      for (let y = 0; y < rh; y++) {
        const srcRow = (rc.y0 + y) * sh.sheetW + rc.x0;
        const dstRow = (pl.y + oy + y) * atlasW + (pl.x + ox);
        for (let x = 0; x < rw; x++) {
          const px = sh.pixels[srcRow + x]!;
          if ((px >>> 24) !== 0) {
            out32[dstRow + x] = px;
          }
        }
      }
    };

    // Exact `sub_4E0F74` (`v62 = 0` LayerStatic, then `v62 = 1` LayerAdjust) per slot in `0..11` order
    for (const l of prepared) {
      const idx = i + l.frameOffset;
      const rs = l.staticSheet?.rects[idx];
      const ra = l.tintedAdjust?.rects[idx];
      if (l.staticSheet && rs) blit(l.staticSheet, rs);
      if (l.tintedAdjust && ra) blit(l.tintedAdjust, ra);
    }

    rects.push({
      x0: pl.x,
      y0: pl.y,
      x1: pl.x + b.w,
      y1: pl.y + b.h,
      px: -b.minX,
      py: -b.minY,
      delay: b.delay,
      imgIdx: 0,
      pivotX: b.w,
      pivotY: b.h,
      anchorX: 0,
      anchorY: -b.minY,
      frame: i,
      pad: 0,
    });
  }

  return {
    width: atlasW,
    height: atlasH,
    rgba: new Uint8Array(out32.buffer),
    rects,
  };
}

/**
 * Composite a retail two-layer character sprite (`LayerStatic` + `LayerAdjust`)
 * into a single unified RGBA sprite strip where `LayerStatic` (`off_6184C8[0]`)
 * is blitted first and `LayerAdjust` (`off_6184C8[1]`, HLS-shifted by
 * `teamNumberToHlsIndex(team)`) is blitted on top (`sub_4E0F74`).
 */
export function compositeTwoLayerCharacter(
  staticSheet: SpriteSheet | null,
  adjustSheet: SpriteSheet | null,
  team: number,
): { width: number; height: number; rgba: Uint8Array; rects: SpriteSheet["rects"] } | null {
  return compositeAvatarLayers([{ staticSheet, adjustSheet }], team);
}
