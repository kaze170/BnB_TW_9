// Retail Taiwan Crazy Arcade BnB v9 — Authentic `CA.exe` UI Controls (`src/ui/widgets.ts`).
// Strictly implements the original C++ control hierarchy (`CA.exe.c` / `CA.exe.lst`):
//   - `CCtrlButton` (`n=5`: 0=normal, 1=pressed, 2=hover, 3=disabled, 4=checked/focus)
//   - `CButtonList` tabs (`n=4`: 0=normal, 1=selected, 2=hover, 3=disabled, anchored via `px/py`)
//   - `CCtrlCheckBox` (`Fx:Dialog/BtCheckBox` 15x15 / `Fx:Dialog/BtcircleCheckBox` 11x11)
//   - `CCtrlScrollBar` (`Cx:Etc/VScroll_BtUp`, `VScroll_BtDown`, `VScroll_Ball`)
//   - `CCtrlBar` (`Cx:Etc/HScroll_BtLeft`, `HScroll_BtRight`, `HScroll_Ball`)
//   - `CCtrlMsgView` (scrollable Big5/`CxUni.fft` message view over retail stage chat wells)
//   - `CInventoryWndNew` (`sub_4CBFF0` 8-slot `4x2` bag grid + `Shop/BtMyBag_Left`/`Right`)
//   - `CGlobalButtonDlg` `(0, 566, 800, 34)` + `CGlobalButtonMenuDlg` `(0, 344, 109, 222)` + `Glob_ToolTip`
//   - `ChatBalloon` (`Cx:Etc/ChatBalloon` / `Fx:Game/ChatBalloon` 16-part speech bubble)

import { encodeBig5, decodeBig5 } from "../data/big5.ts";
import type { GameAssets, LoadedSheet, PackName } from "../data/assets.ts";
import { sampleAction, type ObjectAction, type ObjectTable, type StockItem } from "../data/tables.ts";
import type { ResolvedStockVisual } from "../data/cosmetics.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { SoundManager } from "../audio/sound.ts";
import type { ClientHub } from "../net/hub.ts";
import type { ChatLine } from "../net/hub.ts";

/** Original CGameCardWnd uses inventory/account hours, never stock duration. */
export function formatRemainingHours(hours: number | undefined): string {
  if (hours === undefined || !Number.isFinite(hours) || hours < 0) return "期限未提供";
  const n = Math.floor(hours);
  if (n >= 240000) return "無限";
  if (n >= 8760) return "365天以上";
  return `${Math.floor(n / 24)}天 ${n % 24}小時`;
}

/** Inventory tooltip name truncation in sub_4CC31C uses Big5 byte lengths. */
export function inventoryTooltipName(name: string): string {
  const bytes = encodeBig5(name);
  if (bytes.length <= 18) return name;
  let pos = 0, asciiCount = 0;
  while (pos < 13) {
    if (bytes[pos]! >= 0x81 && bytes[pos]! <= 0xfe) pos += 2;
    else { pos++; asciiCount++; }
  }
  return decodeBig5(bytes.subarray(0, 14 - (asciiCount % 2))) + "...";
}

/** Inventory hover suppresses the period for zero, unknown or unlimited hours. */
export function inventoryTooltipPeriod(hours: number | undefined, strings?: ReadonlyMap<string, string>): string | null {
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0 || hours >= 240000) return null;
  const n = Math.floor(hours);
  if (n >= 8760) return strings?.get("ItemRemainsOver365days") ?? "365天以上";
  const template = strings?.get("ItemRemainsPeriod") ?? "期限 : %d天 %d小時";
  return template.replace("%d", String(Math.floor(n / 24))).replace("%d", String(n % 24));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/** Look up a retail string from `csysstr.ssd` with fallback. */
export function sysStr(assets: GameAssets, key: string, fallback = ""): string {
  return assets.tables?.sysStrings.get(key) ?? fallback;
}

/** Step an `ObjectAction` at `elapsedTicks` (`loop = true` wraps, `false` clamps to final step). */
export function sampleActionFrame(act: ObjectAction, elapsedTicks: number, loop = true): number {
  if (act.steps.length === 0) return 0;
  // Use the object-table timeline semantics: a negative duration holds that
  // frame indefinitely, even for callers requesting a looping action.
  return sampleAction(act, Math.max(0, Math.floor(elapsedTicks)), loop).frame;
}

/** Draw one frame of a `LoadedSheet`, optionally anchored by its `SpriteRect` `(px, py)`. */
export function drawSheetFrame(
  r: SpriteRenderer,
  sheet: LoadedSheet | null,
  frameIdx: number,
  x: number,
  y: number,
  opts?: {
    anchor?: boolean;
    tint?: readonly [number, number, number, number];
    flipX?: boolean;
    w?: number;
    h?: number;
  },
): { w: number; h: number } {
  if (!sheet) return { w: 0, h: 0 };
  if (!sheet.sheet) {
    const dw = opts?.w ?? sheet.width;
    const dh = opts?.h ?? sheet.height;
    r.drawSprite({
      tex: sheet.tex,
      x,
      y,
      w: dw,
      h: dh,
      tint: opts?.tint,
      flipX: opts?.flipX,
    });
    return { w: dw, h: dh };
  }
  const rects = sheet.sheet.rects;
  // sub_56E300 ignores an out-of-range frame instead of drawing the nearest one.
  if (!Number.isInteger(frameIdx) || frameIdx < 0 || frameIdx >= rects.length) return { w: 0, h: 0 };
  const rc = rects[frameIdx]!;
  const rw = rc.x1 - rc.x0;
  const rh = rc.y1 - rc.y0;
  if (rw <= 0 || rh <= 0) return { w: 0, h: 0 };
  const dw = opts?.w ?? rw;
  const dh = opts?.h ?? rh;
  const dx = opts?.anchor ? x - rc.px : x;
  const dy = opts?.anchor ? y - rc.py : y;
  r.drawSprite({
    tex: sheet.tex,
    x: dx,
    y: dy,
    w: dw,
    h: dh,
    src: [rc.x0, rc.y0, rw, rh],
    tint: opts?.tint,
    flipX: opts?.flipX,
  });
  return { w: dw, h: dh };
}

/**
 * Retail `CA.exe` `sub_56EA40` (`0056EA40`) right-to-left sprite number renderer.
 * Supports fixed-width zero-padded numbers (`suppressLeadingZeros = false`) as well as
 * right-aligned numbers with optional 3-digit comma frames (`baseFrame + 10`).
 */
export function drawSpriteNumber(
  r: SpriteRenderer,
  sheet: LoadedSheet | null,
  x: number,
  y: number,
  stepX: number,
  maxDigits: number,
  value: number,
  suppressLeadingZeros: boolean,
  baseFrame: number,
  drawComma = false,
  commaWidth = 0,
): void {
  if (!sheet || maxDigits <= 0) return;
  let v = Math.max(0, Math.floor(value));
  const commaTotal = commaWidth * Math.floor((maxDigits - 1) / 3);
  let curX = x + stepX * (maxDigits - 1) + commaTotal;
  for (let d = 0; d < maxDigits; d++) {
    if (suppressLeadingZeros && v === 0 && d > 0) break;
    if (d !== 0 && d % 3 === 0) {
      curX -= commaWidth;
      if (drawComma) {
        drawSheetFrame(r, sheet, baseFrame + 10, curX + stepX, y, { anchor: true });
      }
    }
    const digit = v % 10;
    v = Math.floor(v / 10);
    drawSheetFrame(r, sheet, baseFrame + digit, curX, y, { anchor: true });
    curX -= stepX;
  }
}

/** Retail `CA.exe` `sub_56F5A0` (`0056F5A0`) zero-padded fixed-width sprite digits. */
export function drawSpriteDigits(
  r: SpriteRenderer,
  sheet: LoadedSheet | null,
  x: number,
  y: number,
  stepX: number,
  digits: number,
  value: number,
  baseFrame = 0,
): void {
  drawSpriteNumber(r, sheet, x, y, stepX, digits, value, false, baseFrame, false, 0);
}

export interface LevelIconParts {
  /** Retail internal rank `1..450` (`CA.exe` `sub_4F6FF1` `a5`). */
  readonly rank450: number;
  /** Layer 0 (`v7[0]`): Ribbon (`3..7`) or Trophy Base (`26..30`). */
  readonly ribbonFrame: number;
  /** Layer 1 (`v7[1]`): 1/2/3 Pips (`0..2` or `23..25`). */
  readonly pipFrame: number;
  /** Layer 2 (`v7[2]`): Static Medal (`8..22`) or Trophy/Star/Crown (`31..45`). */
  readonly emblemFrame: number;
  /** `v7[3]`: Tier `0` (Medal) or `1` (Trophy/Star/Crown). */
  readonly tier: 0 | 1;
  /** `v7[4]`: 30-variant index `0..29` for `Fx:Level/Rotate000` (`30 * 8 = 240` frames). */
  readonly medal30: number;
  /** `v7[5]`: 10-silhouette index `0..9` for `Fx:Level/Twinkle002..007` (`10 * k` frames). */
  readonly silhouette10: number;
}

/**
 * Retail `CA.exe` `CLevelIconEffector` lookup table (`unk_625E5C`,
 * `CA.exe.c:222055..222078`). The original uses the level directly, clamped
 * to 1..450 (sub_4F6FF1); it does not rescale the server's EXP curve.
 */
export function computeLevelIconParts(level: number): LevelIconParts {
  const rank450 = Math.max(1, Math.min(450, Math.floor(level)));
  const v6 = rank450 - 1;
  const v5 = Math.floor(v6 / 15); // 0..29
  const tier = (v5 >= 15 ? 1 : 0) as 0 | 1;
  const v4 = 23 * tier;
  const ribbonFrame = v4 + (Math.floor(v6 / 3) % 5) + 3;
  const pipFrame = v4 + (v6 % 3);
  const emblemFrame = v4 + (v5 % 15) + 8;
  const medal30 = 5 * (3 * tier + (v5 % 3)) + (Math.floor(v5 / 3) % 5);
  const silhouette10 = 5 * tier + (Math.floor(v5 / 3) % 5);
  return {
    rank450,
    ribbonFrame,
    pipFrame,
    emblemFrame,
    tier,
    medal30,
    silhouette10,
  };
}

/**
 * Authentic 3-layer `CA.exe` `sub_4F6FF1` (`CA.exe.c:221939..222014`) rank badge renderer:
 *   - Layer 0 (`v7[0]`): Ribbon / Trophy Base (`Etc/LevelIcons`)
 *   - Layer 1 (`v7[1]`): 1/2/3 Pips (`Etc/LevelIcons`)
 *   - Layer 2 (`v7[2]` or `Fx:Level/Rotate000` `240`f): Medal/Trophy body or 3D-spinning medal
 *   - Layer 3 (`Fx:Level/Twinkle000..007`): Silhouette-matched sparkle (`sub_4F6F1B` + `sub_5682E0`)
 */
/**
 * Shared animation frame used by retail sub_4F6F4C. Rotation and twinkle
 * advance together, using the smaller of their per-variant frame counts.
 * Retail pauses for a random 60–90 updates after three loops; until each UI
 * icon has its own effector state, use a deterministic 75-update pause and
 * the caller's global tick rather than pretending to reproduce the RNG.
 */
export function levelEffectFrame(tick: number, rotateFrames: number, twinkleFrames: number): number | null {
  const rotateCount = rotateFrames > 0 ? (rotateFrames % 30 === 0 ? rotateFrames / 30 : Math.floor(rotateFrames / 2)) : 0;
  const twinkleCount = twinkleFrames > 0 ? (twinkleFrames % 10 === 0 ? twinkleFrames / 10 : Math.floor(twinkleFrames / 2)) : 0;
  const count = rotateCount && twinkleCount ? Math.min(rotateCount, twinkleCount) : rotateCount || twinkleCount;
  if (count <= 1) return null;
  const pause = 75;
  const pos = Math.max(0, Math.floor(tick)) % (pause + count * 4 * 3);
  return pos < pause ? null : Math.floor((pos - pause) / 4) % count;
}

export function drawLevelIcon(
  r: SpriteRenderer,
  levelSheet: LoadedSheet | null,
  level: number,
  x: number,
  y: number,
  twinkleSheet?: LoadedSheet | null,
  tick = 0,
  rotateSheet?: LoadedSheet | null,
): void {
  if (!levelSheet || !levelSheet.sheet) return;
  const n = levelSheet.sheet.rects.length;
  if (n === 0) return;
  if (n < 46) {
    const clamped = Math.max(1, Math.min(450, level));
    const idx = Math.min(n - 1, Math.floor(((clamped - 1) * n) / 450));
    drawSheetFrame(r, levelSheet, idx, x, y);
    return;
  }

  const parts = computeLevelIconParts(level);
  const safeTick = Math.max(0, Math.floor(tick));
  // Layer 0: Ribbon / Trophy Base (`v7[0]`)
  drawSheetFrame(r, levelSheet, parts.ribbonFrame, x, y, { anchor: true });
  // Layer 1: 1/2/3 Pips (`v7[1]`)
  drawSheetFrame(r, levelSheet, parts.pipFrame, x, y, { anchor: true });

  const rotFrames = rotateSheet?.sheet?.rects.length ?? 0;
  const tn = twinkleSheet?.sheet?.rects.length ?? 0;
  const frame = levelEffectFrame(safeTick, rotFrames, tn);
  if (frame !== null && rotateSheet && rotFrames > 0) {
    const groupedByMedal = rotFrames % 30 === 0;
    const stride = groupedByMedal ? rotFrames / 30 : Math.floor(rotFrames / 2);
    drawSheetFrame(r, rotateSheet, (groupedByMedal ? parts.medal30 : parts.tier) * stride + frame, x, y, { anchor: true });
  } else {
    drawSheetFrame(r, levelSheet, parts.emblemFrame, x, y, { anchor: true });
  }

  // Retail draws neither twinkle nor rotation during the pause (sub_4F6FF1).
  if (frame !== null && twinkleSheet?.sheet && tn > 0) {
    const groupedBySilhouette = tn % 10 === 0;
    const stride = groupedBySilhouette ? tn / 10 : Math.floor(tn / 2);
    const f = (groupedBySilhouette ? parts.silhouette10 : parts.tier) * stride + frame;
    const rc = twinkleSheet.sheet.rects[f]!;
    drawSheetFrame(r, twinkleSheet, f, x - rc.anchorX, y - rc.anchorY, { anchor: true });
  }
}

/** Retail team palette RGB values (1=Red, 2=Blue, 3=Yellow, 4=Green, 5=Orange, 6=Purple, 7=Cyan, 8=Grey). */
export const TEAM_RGB: Record<number, readonly [number, number, number, number]> = {
  0: [0.95, 0.32, 0.30, 1],
  1: [0.95, 0.25, 0.25, 1],
  2: [0.22, 0.52, 0.98, 1],
  3: [0.98, 0.82, 0.16, 1],
  4: [0.22, 0.82, 0.36, 1],
  5: [0.98, 0.55, 0.15, 1],
  6: [0.72, 0.32, 0.95, 1],
  7: [0.20, 0.85, 0.90, 1],
  8: [0.68, 0.72, 0.78, 1],
};

/**
 * Draw an overhead speech balloon using the retail 16-part `Cx:Etc/ChatBalloon`
 * or `Fx:Game/ChatBalloon` sprite sheet.
 */
export function drawSpeechBubble(
  r: SpriteRenderer,
  balloonSheet: LoadedSheet | null,
  text: string,
  cx: number,
  bottomY: number,
): void {
  if (!text) return;
  const shown = text.length > 24 ? text.slice(0, 23) + "…" : text;
  const tw = r.measureText(shown, 0);
  const innerW = Math.max(20, tw + 4);
  const w = innerW + 20;
  const h = 24;
  const x = Math.round(Math.max(4, Math.min(796 - w, cx - w * 0.5)));
  const y = Math.round(Math.max(4, bottomY - h - 8));

  if (balloonSheet && balloonSheet.sheet && balloonSheet.sheet.rects.length >= 16) {
    // Corners: 0=TL(10x10), 1=TR(10x10), 2=BL(10x10), 3=BR(10x10)
    // Edges: 4=T(12x10), 5=B(12x10), 8=L(10x13), 9=R(10x13), 10=Center(12x13), 14=Tail(10x12)
    drawSheetFrame(r, balloonSheet, 10, x + 10, y + 10, { w: w - 20, h: h - 20 });
    drawSheetFrame(r, balloonSheet, 4, x + 10, y, { w: w - 20, h: 10 });
    drawSheetFrame(r, balloonSheet, 5, x + 10, y + h - 10, { w: w - 20, h: 10 });
    drawSheetFrame(r, balloonSheet, 8, x, y + 10, { w: 10, h: h - 20 });
    drawSheetFrame(r, balloonSheet, 9, x + w - 10, y + 10, { w: 10, h: h - 20 });
    drawSheetFrame(r, balloonSheet, 0, x, y);
    drawSheetFrame(r, balloonSheet, 1, x + w - 10, y);
    drawSheetFrame(r, balloonSheet, 2, x, y + h - 10);
    drawSheetFrame(r, balloonSheet, 3, x + w - 10, y + h - 10);
    const tailX = Math.max(x + 8, Math.min(x + w - 18, Math.round(cx - 5)));
    drawSheetFrame(r, balloonSheet, 14, tailX, y + h - 3);
  }
  r.drawText(shown, x + 10, y + 6, { color: [0.05, 0.07, 0.12, 1] });
}

/** Game-world CGOChatBalloon (sub_416104 / sub_416A0A): 12x13 tiles,
 * no tail, 128/255 background opacity, and text wrapped to 20 half-width
 * cells. Screen clipping and font advances follow the web renderer. */
export function drawGameSpeechBubble(
  r: SpriteRenderer,
  sheet: LoadedSheet | null,
  text: string,
  cx: number,
  bottomY: number,
): void {
  if (!text || !sheet?.sheet || sheet.sheet.rects.length < 13) return;
  const limit = 120; // 20 half-width cells at six pixels each
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ch === "\r") continue;
    if (ch === "\n") { lines.push(line); line = ""; continue; }
    if (line && r.measureText(line + ch, 0) > limit) { lines.push(line); line = ""; }
    line += ch;
  }
  if (line) lines.push(line);
  if (!lines.length) return;
  const innerW = lines.length === 1 ? Math.ceil(r.measureText(lines[0]!, 0)) : limit;
  const innerH = lines.length * 13;
  const left = Math.max(0, Math.min(800 - innerW - 20, Math.round(cx - Math.floor(innerW / 2) - 10)));
  const top = Math.max(0, Math.round(bottomY - 8 - innerH - 20));
  const innerX = left + 10;
  const innerY = top + 10;
  const right = innerX + 2 * Math.floor(innerW / 2);
  const bottom = innerY + innerH;
  const tint = [1, 1, 1, 128 / 255] as const;
  const draw = (frame: number, x: number, y: number) => drawSheetFrame(r, sheet, frame, x, y, { tint });
  draw(0, left, top); draw(1, right, top);
  draw(2, left, bottom); draw(3, right, bottom);
  for (let x = 0; x < Math.floor(innerW / 12); x++) {
    draw(4, innerX + x * 12, top); draw(5, innerX + x * 12, bottom);
  }
  if (innerW % 12) { draw(6, right - 6, top); draw(7, right - 6, bottom); }
  for (let y = 0; y < lines.length; y++) {
    const ty = innerY + y * 13;
    draw(8, left, ty); draw(9, right, ty);
    for (let x = 0; x < Math.floor(innerW / 12); x++) draw(10, innerX + x * 12, ty);
    if (innerW % 12) draw(12, right - 6, ty);
    r.drawText(lines[y]!, innerX, innerY + y * 12 + 1, { color: [0.05, 0.07, 0.12, 1] });
  }
}

/**
 * Draw a 9-slice panel from a 9-rect sprite sheet (such as `Fx:Game/PatResultDlg`
 * where rects `0..8` are TL, T, TR, L, C, R, BL, B, BR).
 */
export function drawPat9Slice(
  r: SpriteRenderer,
  sheet: LoadedSheet | null,
  x: number,
  y: number,
  w: number,
  h: number,
  tint?: readonly [number, number, number, number],
): void {
  if (!sheet || !sheet.sheet || sheet.sheet.rects.length < 9) return;
  const rc = sheet.sheet.rects;
  const cw = rc[0]!.x1 - rc[0]!.x0;
  const ch = rc[0]!.y1 - rc[0]!.y0;
  const rw = rc[2]!.x1 - rc[2]!.x0;
  const bh = rc[6]!.y1 - rc[6]!.y0;
  const midW = Math.max(0, w - cw - rw);
  const midH = Math.max(0, h - ch - bh);

  drawSheetFrame(r, sheet, 4, x + cw, y + ch, { w: midW, h: midH, tint });
  drawSheetFrame(r, sheet, 1, x + cw, y, { w: midW, h: ch, tint });
  drawSheetFrame(r, sheet, 7, x + cw, y + h - bh, { w: midW, h: bh, tint });
  drawSheetFrame(r, sheet, 3, x, y + ch, { w: cw, h: midH, tint });
  drawSheetFrame(r, sheet, 5, x + w - rw, y + ch, { w: rw, h: midH, tint });
  drawSheetFrame(r, sheet, 0, x, y, { tint });
  drawSheetFrame(r, sheet, 2, x + w - rw, y, { tint });
  drawSheetFrame(r, sheet, 6, x, y + h - bh, { tint });
  drawSheetFrame(r, sheet, 8, x + w - rw, y + h - bh, { tint });
}

/**
 * Draw the retail `Fx:GlobalUI/Glob_ToolTip` 9-part bubble (`dy = -18` above button).
 * `Glob_ToolTip` rects:
 *   0=TL(15x5), 1=T(1x5), 2=TR(15x5), 3=L(15x1), 4=R(15x1),
 *   5=BL(15x5), 6=B(1x5), 7=BR(15x5), 8=Tail(9x10).
 */
export function drawGlobToolTip(
  r: SpriteRenderer,
  tipSheet: LoadedSheet | null,
  text: string,
  anchorX: number,
  anchorY: number,
): void {
  if (!text || !tipSheet || !tipSheet.sheet || tipSheet.sheet.rects.length < 9) return;
  const tw = r.measureText(text, 0);
  const w = Math.max(36, tw + 18);
  const h = 20;
  const x = Math.round(Math.max(4, Math.min(796 - w, anchorX - w * 0.5)));
  const y = Math.round(Math.max(4, anchorY - h - 7));
  const midW = Math.max(0, w - 30);
  const midH = Math.max(0, h - 10);

  // Inner fill stretched from center pixel (15, 5, 1, 1) of Glob_ToolTip
  r.drawSprite({
    tex: tipSheet.tex,
    x: x + 15,
    y: y + 5,
    w: midW,
    h: midH,
    src: [15, 5, 1, 1],
  });
  drawSheetFrame(r, tipSheet, 1, x + 15, y, { w: midW, h: 5 });
  drawSheetFrame(r, tipSheet, 6, x + 15, y + h - 5, { w: midW, h: 5 });
  drawSheetFrame(r, tipSheet, 3, x, y + 5, { w: 15, h: midH });
  drawSheetFrame(r, tipSheet, 4, x + w - 15, y + 5, { w: 15, h: midH });
  drawSheetFrame(r, tipSheet, 0, x, y);
  drawSheetFrame(r, tipSheet, 2, x + w - 15, y);
  drawSheetFrame(r, tipSheet, 5, x, y + h - 5);
  drawSheetFrame(r, tipSheet, 7, x + w - 15, y + h - 5);
  const tailX = Math.max(x + 8, Math.min(x + w - 17, Math.round(anchorX - 4)));
  drawSheetFrame(r, tipSheet, 8, tailX, y + h - 2);
  r.drawText(text, x + Math.round((w - tw) * 0.5), y + 4, { color: [0.02, 0.10, 0.24, 1] });
}

/**
 * Retail `CCtrlButton` / `CButtonList` tab control (`CA.exe.c` `0x5862A0` / `0x5864D0`).
 *
 * Ordinary CCtrlButton (sub_589CC0, flag 0x10 clear): frame 0 normal,
 * 1 pressed, 2 disabled; hover cycles frames 3 onward every six updates.
 * Tab/toggle controls have different state rules and remain handled separately.
 */
export type ButtonHoverSfx = "MouseMove_0" | "MouseMove_1" | "MouseMove_2";

/**
 * Exact `CA.exe` `off_6180B4` (`CA.exe.c:179108`) Emotion shop-icon fallback table (`Fx:Shop/Emot*`).
 */
export const EMOT_SHOP_FALLBACK_ICONS: readonly string[] = [
  "Shop/EmotSmile",
  "Shop/EmotAngry",
  "Shop/EmotLove",
  "Shop/EmotSad",
  "Shop/EmotGreet",
  "Shop/EmotShy",
  "Shop/EmotDance",
  "Shop/EmotSpecial",
];

export class SpriteButton {
  x: number;
  y: number;
  w = 0;
  h = 0;
  hitW = 0;
  hitH = 0;
  sheet: LoadedSheet | null = null;
  enabled = true;
  visible = true;
  toggled = false;
  isTab = false;
  anchor = false;
  tooltip = "";
  hoverSfx: ButtonHoverSfx = "MouseMove_0";
  hovered = false;
  pressed = false;
  private hoverStartedMs = 0;
  onClick?: () => void;

  constructor(
    x: number,
    y: number,
    onClick?: () => void,
    opts?: {
      isTab?: boolean;
      anchor?: boolean;
      tooltip?: string;
      hitW?: number;
      hitH?: number;
      hoverSfx?: ButtonHoverSfx;
    },
  ) {
    this.x = x;
    this.y = y;
    this.onClick = onClick;
    if (opts?.isTab) {
      this.isTab = true;
      this.hoverSfx = "MouseMove_1";
    }
    if (opts?.anchor) this.anchor = true;
    if (opts?.tooltip) this.tooltip = opts.tooltip;
    if (opts?.hitW) this.hitW = opts.hitW;
    if (opts?.hitH) this.hitH = opts.hitH;
    if (opts?.hoverSfx) this.hoverSfx = opts.hoverSfx;
  }

  setHitSize(w: number, h: number): void {
    this.hitW = w;
    this.hitH = h;
  }

  bindSheet(sheet: LoadedSheet | null, fallbackW = 0, fallbackH = 0): void {
    this.sheet = sheet;
    const rects = sheet?.sheet?.rects;
    if (rects && rects.length > 0) {
      // Pick max non-empty rect for visual size (handles tabs where frame 1 is taller)
      let bw = 0;
      let bh = 0;
      for (const rc of rects) {
        bw = Math.max(bw, rc.x1 - rc.x0);
        bh = Math.max(bh, rc.y1 - rc.y0);
      }
      this.w = bw || fallbackW;
      this.h = bh || fallbackH;
    } else if (sheet) {
      this.w = sheet.width || fallbackW;
      this.h = sheet.height || fallbackH;
    } else {
      this.w = fallbackW;
      this.h = fallbackH;
    }
  }

  contains(mx: number, my: number): boolean {
    const cw = this.hitW > 0 ? this.hitW : this.w;
    const ch = this.hitH > 0 ? this.hitH : this.h;
    return this.visible && cw > 0 && ch > 0 && mx >= this.x && mx < this.x + cw && my >= this.y && my < this.y + ch;
  }

  onMouseMove(mx: number, my: number, sound?: SoundManager): void {
    if (!this.visible || !this.enabled) {
      this.hovered = false;
      return;
    }
    const now = this.contains(mx, my);
    if (now && !this.hovered) {
      this.hoverStartedMs = performance.now();
      sound?.playSfx(`Wave/${this.hoverSfx}`, 0.45);
    }
    this.hovered = now;
  }

  onMouseDown(mx: number, my: number): boolean {
    if (!this.visible || !this.enabled) return false;
    if (this.contains(mx, my)) {
      this.pressed = true;
      return true;
    }
    return false;
  }

  onMouseUp(mx: number, my: number, sound?: SoundManager): boolean {
    const was = this.pressed;
    this.pressed = false;
    if (was && this.visible && this.enabled && this.contains(mx, my)) {
      sound?.playSfx("ButtonDown_0", 0.7);
      this.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, offsetX = 0, offsetY = 0): void {
    if (!this.visible || !this.sheet) return;
    const rects = this.sheet.sheet?.rects;
    const n = rects ? rects.length : 1;
    let frame = 0;
    if (this.isTab) {
      if (!this.enabled) frame = Math.min(n - 1, 3);
      else if (this.toggled || this.pressed) frame = Math.min(n - 1, 1);
      else if (this.hovered) frame = Math.min(n - 1, 2);
    } else if (!this.enabled) {
      frame = Math.min(n - 1, 2);
    } else if (this.toggled) {
      // Some callers use ordinary buttons as persistent selection controls;
      // their retail control flags have not yet been established.
      frame = Math.min(n - 1, n >= 5 ? 4 : 1);
    } else if (this.pressed) {
      frame = Math.min(n - 1, 1);
    } else if (this.hovered && n > 3) {
      // Six original update calls per frame; 30 ms is the web UI's tick approximation.
      frame = 3 + Math.floor(Math.max(0, performance.now() - this.hoverStartedMs) / 180) % (n - 3);
    }
    drawSheetFrame(r, this.sheet, frame, this.x + offsetX, this.y + offsetY, {
      anchor: this.anchor || this.isTab,
    });
  }
}

/**
 * Retail `CCtrlCheckBox` (`Fx:Dialog/BtCheckBox` 15x15 or `Fx:Dialog/BtcircleCheckBox` 11x11).
 * Uses `n=5` states: `0=unchecked`, `1=pressed`, `2=hover`, `3=disabled`, `4=checked`.
 */
export class SpriteCheckBox {
  x: number;
  y: number;
  w = 15;
  h = 15;
  checked = false;
  enabled = true;
  visible = true;
  sheet: LoadedSheet | null = null;
  hovered = false;
  pressed = false;
  onChange?: (checked: boolean) => void;

  constructor(x: number, y: number, checked = false, onChange?: (checked: boolean) => void) {
    this.x = x;
    this.y = y;
    this.checked = checked;
    this.onChange = onChange;
  }

  bindSheet(sheet: LoadedSheet | null): void {
    this.sheet = sheet;
    const r0 = sheet?.sheet?.rects[0];
    if (r0) {
      this.w = r0.x1 - r0.x0;
      this.h = r0.y1 - r0.y0;
    }
  }

  contains(mx: number, my: number): boolean {
    return this.visible && mx >= this.x && mx < this.x + this.w && my >= this.y && my < this.y + this.h;
  }

  onMouseMove(mx: number, my: number): void {
    this.hovered = this.visible && this.enabled && this.contains(mx, my);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (!this.visible || !this.enabled) return false;
    if (this.contains(mx, my)) {
      this.pressed = true;
      return true;
    }
    return false;
  }

  onMouseUp(mx: number, my: number, sound?: SoundManager): boolean {
    const was = this.pressed;
    this.pressed = false;
    if (was && this.visible && this.enabled && this.contains(mx, my)) {
      sound?.playSfx("ButtonDown_0", 0.65);
      this.checked = !this.checked;
      this.onChange?.(this.checked);
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, offsetX = 0, offsetY = 0): void {
    if (!this.visible || !this.sheet) return;
    let frame = 0;
    if (!this.enabled) frame = 3;
    else if (this.pressed) frame = 1;
    else if (this.checked) frame = 4;
    else if (this.hovered) frame = 2;
    drawSheetFrame(r, this.sheet, frame, this.x + offsetX, this.y + offsetY);
  }
}

/**
 * Retail `CCtrlScrollBar` vertical scrollbar (`CA.exe` `0x58A600`).
 * Uses `Cx:Etc/VScroll_BtUp` (18x17), `Cx:Etc/VScroll_BtDown` (18x17), `Cx:Etc/VScroll_Ball` (18x17).
 */
export class SpriteScrollBar {
  x: number;
  y: number;
  w: number;
  h: number;
  max = 0;
  value = 0;
  visible = true;

  private btUp: LoadedSheet | null = null;
  private btDown: LoadedSheet | null = null;
  private ball: LoadedSheet | null = null;
  private pattern: LoadedSheet | null = null;
  private btnH = 17;
  private ballH = 17;
  private upHover = false;
  private upDown = false;
  private dnHover = false;
  private dnDown = false;
  private dragging = false;
  private dragOffsetY = 0;
  onChange?: (val: number) => void;

  constructor(x: number, y: number, w: number, h: number, onChange?: (val: number) => void) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.onChange = onChange;
  }

  async load(assets: GameAssets): Promise<void> {
    const [u, d, b] = await Promise.all([
      assets.loadSheet("Cx", "Etc/VScroll_BtUp"),
      assets.loadSheet("Cx", "Etc/VScroll_BtDown"),
      assets.loadSheet("Cx", "Etc/VScroll_Ball"),
    ]);
    this.btUp = u;
    this.btDown = d;
    this.ball = b;
  }

  /**
   * Retail `CSMSDlg` custom 23px scrollbar (`CA.exe.c:48397`):
   * `Fx:Dialog/SMSScroll_BtUp` (`23x21`), `SMSScroll_BtDown` (`23x21`), `SMSScroll_Ball` (`23x19`), `SMSScroll_Pattern` (`23x1`).
   */
  async loadSmsTheme(assets: GameAssets): Promise<void> {
    const [u, d, b, p] = await Promise.all([
      assets.loadSheet("Fx", "Dialog/SMSScroll_BtUp"),
      assets.loadSheet("Fx", "Dialog/SMSScroll_BtDown"),
      assets.loadSheet("Fx", "Dialog/SMSScroll_Ball"),
      assets.loadSheet("Fx", "Dialog/SMSScroll_Pattern"),
    ]);
    this.btUp = u;
    this.btDown = d;
    this.ball = b;
    this.pattern = p;
    this.btnH = 21;
    this.ballH = 19;
  }

  /**
   * Retail Nexon Messenger (`CNMListBox` / `BnbMessengerDlg`) custom 18px scrollbar:
   * `Fx:NM/VScroll_BtUp` (`18x17`), `NM/VScroll_BtDown` (`18x17`), `NM/VScroll_Ball` (`18x17`), `NM/Scroll_Pattern` (`18x13`).
   */
  async loadNmTheme(assets: GameAssets): Promise<void> {
    const [u, d, b, p] = await Promise.all([
      assets.loadSheet("Fx", "NM/VScroll_BtUp"),
      assets.loadSheet("Fx", "NM/VScroll_BtDown"),
      assets.loadSheet("Fx", "NM/VScroll_Ball"),
      assets.loadSheet("Fx", "NM/Scroll_Pattern"),
    ]);
    this.btUp = u;
    this.btDown = d;
    this.ball = b;
    this.pattern = p;
    this.btnH = 17;
    this.ballH = 17;
  }

  setRange(maxVal: number, stickBottom = false): void {
    const prevAtBottom = this.value >= this.max;
    this.max = Math.max(0, Math.floor(maxVal));
    if (stickBottom && prevAtBottom) {
      this.value = this.max;
    } else {
      this.value = Math.max(0, Math.min(this.max, this.value));
    }
  }

  scrollBy(delta: number): void {
    const next = Math.max(0, Math.min(this.max, this.value + delta));
    if (next !== this.value) {
      this.value = next;
      this.onChange?.(this.value);
    }
  }

  private thumbRect(): Rect {
    const btnH = this.btnH;
    const ballH = this.ballH;
    const trackY = this.y + btnH;
    const trackH = Math.max(ballH, this.h - btnH * 2);
    const ratio = this.max > 0 ? this.value / this.max : 0;
    const ty = Math.round(trackY + ratio * (trackH - ballH));
    return { x: this.x, y: ty, w: this.w, h: ballH };
  }

  onMouseMove(mx: number, my: number): void {
    if (!this.visible) return;
    if (this.dragging && this.max > 0) {
      const btnH = this.btnH;
      const ballH = this.ballH;
      const trackY = this.y + btnH;
      const span = Math.max(1, this.h - btnH * 2 - ballH);
      const ratio = Math.max(0, Math.min(1, (my - this.dragOffsetY - trackY) / span));
      const next = Math.round(ratio * this.max);
      if (next !== this.value) {
        this.value = next;
        this.onChange?.(this.value);
      }
      return;
    }
    this.upHover = pointInRect(mx, my, { x: this.x, y: this.y, w: this.w, h: this.btnH });
    this.dnHover = pointInRect(mx, my, { x: this.x, y: this.y + this.h - this.btnH, w: this.w, h: this.btnH });
  }

  onMouseDown(mx: number, my: number): boolean {
    if (!this.visible || !pointInRect(mx, my, { x: this.x, y: this.y, w: this.w, h: this.h })) {
      return false;
    }
    if (pointInRect(mx, my, { x: this.x, y: this.y, w: this.w, h: this.btnH })) {
      this.upDown = true;
      this.scrollBy(-1);
      return true;
    }
    if (pointInRect(mx, my, { x: this.x, y: this.y + this.h - this.btnH, w: this.w, h: this.btnH })) {
      this.dnDown = true;
      this.scrollBy(1);
      return true;
    }
    const tr = this.thumbRect();
    if (pointInRect(mx, my, tr)) {
      this.dragging = true;
      this.dragOffsetY = my - tr.y;
      return true;
    }
    if (my < tr.y) this.scrollBy(-4);
    else this.scrollBy(4);
    return true;
  }

  onMouseUp(_mx: number, _my: number, sound?: SoundManager): boolean {
    const acted = this.upDown || this.dnDown || this.dragging;
    if (this.upDown || this.dnDown) sound?.playSfx("ButtonDown_0", 0.5);
    this.upDown = false;
    this.dnDown = false;
    this.dragging = false;
    return acted;
  }

  render(r: SpriteRenderer, offsetX = 0, offsetY = 0): void {
    if (!this.visible) return;
    if (this.pattern) {
      const y0 = this.y + this.btnH;
      const y1 = this.y + this.h - this.btnH;
      for (let py = y0; py < y1; py += 2) {
        drawSheetFrame(r, this.pattern, 0, this.x + offsetX, py + offsetY);
      }
    }
    const upFrame = this.max <= 0 ? 3 : this.upDown ? 1 : this.upHover ? 2 : 0;
    const dnFrame = this.max <= 0 ? 3 : this.dnDown ? 1 : this.dnHover ? 2 : 0;
    drawSheetFrame(r, this.btUp, upFrame, this.x + offsetX, this.y + offsetY);
    drawSheetFrame(r, this.btDown, dnFrame, this.x + offsetX, this.y + this.h - this.btnH + offsetY);
    if (this.max > 0) {
      const tr = this.thumbRect();
      const ballFrame = this.dragging && (this.ball?.sheet?.rects.length ?? 0) > 1 ? 1 : 0;
      drawSheetFrame(r, this.ball, ballFrame, tr.x + offsetX, tr.y + offsetY);
    }
  }
}

/**
 * Retail `CCtrlBar` horizontal slider (`CA.exe` `L352541`, used by `CGameOptionDlg`
 * for MP3 & WAV volume at `(125, 118, 220, 17)` and `(125, 145, 220, 17)`).
 * Supports both `Cx:Etc/HScroll_*` and `COptionDlg`'s 6-stop `Fx:Dialog/OPTION_ball` (`13x9`, `CA.exe.c:352672`).
 */
export class SpriteHSlider {
  x: number;
  y: number;
  w: number;
  h: number;
  max = 100;
  value = 80;

  private btLeft: LoadedSheet | null = null;
  private btRight: LoadedSheet | null = null;
  private ball: LoadedSheet | null = null;
  private optionBallMode = false;
  private dragging = false;
  onChange?: (val: number) => void;

  constructor(x: number, y: number, w: number, h: number, value = 80, onChange?: (val: number) => void) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.value = value;
    this.onChange = onChange;
  }

  async load(assets: GameAssets): Promise<void> {
    const [l, ri, b] = await Promise.all([
      assets.loadSheet("Cx", "Etc/HScroll_BtLeft"),
      assets.loadSheet("Cx", "Etc/HScroll_BtRight"),
      assets.loadSheet("Cx", "Etc/HScroll_Ball"),
    ]);
    this.btLeft = l;
    this.btRight = ri;
    this.ball = b;
  }

  /**
   * Retail `COptionDlg` 6-stop (`0..5` -> `0, 20, 40, 60, 80, 100`) `Dialog/OPTION_ball` (`13x9`) slider (`CA.exe.c:352672`).
   */
  async loadOptionBall(assets: GameAssets): Promise<void> {
    this.optionBallMode = true;
    this.ball = await assets.loadSheet("Fx", "Dialog/OPTION_ball");
  }

  private setFromX(mx: number): void {
    if (this.optionBallMode) {
      const ballW = 13;
      const span = Math.max(1, this.w - ballW + 1);
      const ratio = Math.max(0, Math.min(1, (mx - (this.x + ballW * 0.5)) / span));
      const stopIdx = Math.max(0, Math.min(5, Math.round(ratio * 5)));
      const next = Math.round((stopIdx / 5) * this.max);
      if (next !== this.value) {
        this.value = next;
        this.onChange?.(this.value);
      }
      return;
    }
    const btnW = 17;
    const ballW = 17;
    const span = Math.max(1, this.w - btnW * 2 - ballW);
    const ratio = Math.max(0, Math.min(1, (mx - (this.x + btnW + ballW * 0.5)) / span));
    const next = Math.round(ratio * this.max);
    if (next !== this.value) {
      this.value = next;
      this.onChange?.(this.value);
    }
  }

  onMouseMove(mx: number, _my: number): void {
    if (this.dragging) this.setFromX(mx);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (!pointInRect(mx, my, { x: this.x, y: this.y, w: this.w, h: this.h })) return false;
    if (!this.optionBallMode) {
      if (mx < this.x + 17) {
        this.value = Math.max(0, this.value - 5);
        this.onChange?.(this.value);
        return true;
      }
      if (mx >= this.x + this.w - 17) {
        this.value = Math.min(this.max, this.value + 5);
        this.onChange?.(this.value);
        return true;
      }
    }
    this.dragging = true;
    this.setFromX(mx);
    return true;
  }

  onMouseUp(): boolean {
    const was = this.dragging;
    this.dragging = false;
    return was;
  }

  render(r: SpriteRenderer, offsetX = 0, offsetY = 0): void {
    if (this.optionBallMode) {
      const ballW = 13;
      const stopIdx = Math.max(0, Math.min(5, Math.round((this.value / Math.max(1, this.max)) * 5)));
      const bx = Math.round(this.x + (stopIdx * (this.w - ballW + 1)) * 0.2);
      const by = this.y + Math.floor((this.h - 9) / 2);
      drawSheetFrame(r, this.ball, 0, bx + offsetX, by + offsetY);
      return;
    }
    const btnW = 17;
    const ballW = 17;
    drawSheetFrame(r, this.btLeft, 0, this.x + offsetX, this.y + offsetY);
    drawSheetFrame(r, this.btRight, 0, this.x + this.w - btnW + offsetX, this.y + offsetY);
    const span = Math.max(1, this.w - btnW * 2 - ballW);
    const bx = Math.round(this.x + btnW + (this.value / Math.max(1, this.max)) * span);
    drawSheetFrame(r, this.ball, this.dragging ? 1 : 0, bx + offsetX, this.y + offsetY);
  }
}

/**
 * Retail `CCtrlMsgView` (`CA.exe` `0x58EE00`): renders wrapped text / chat log
 * lines directly inside a stage or dialog's baked message region, paired with `SpriteScrollBar`.
 */
export interface MsgViewLine {
  text: string;
  color: readonly [number, number, number, number];
}

export class SpriteMsgView {
  x: number;
  y: number;
  w: number;
  h: number;
  lineHeight = 15;
  readonly scroll: SpriteScrollBar | null;
  private wrapped: MsgViewLine[] = [];
  private lastHash = "";

  constructor(x: number, y: number, w: number, h: number, scroll: SpriteScrollBar | null = null) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.scroll = scroll;
  }

  private wrapLines(r: SpriteRenderer, rawLines: MsgViewLine[]): MsgViewLine[] {
    const out: MsgViewLine[] = [];
    const maxW = Math.max(40, this.w - 4);
    for (const ln of rawLines) {
      const parts = ln.text.split(/\r?\n/);
      for (const part of parts) {
        if (!part) {
          out.push({ text: "", color: ln.color });
          continue;
        }
        let cur = "";
        for (const ch of part) {
          const test = cur + ch;
          if (cur && r.measureText(test, 0) > maxW) {
            out.push({ text: cur, color: ln.color });
            cur = ch;
          } else {
            cur = test;
          }
        }
        if (cur) out.push({ text: cur, color: ln.color });
      }
    }
    return out;
  }

  setStaticText(r: SpriteRenderer, text: string, color: readonly [number, number, number, number] = [0.06, 0.12, 0.24, 1]): void {
    this.wrapped = this.wrapLines(r, [{ text, color }]);
    const visRows = Math.max(1, Math.floor(this.h / this.lineHeight));
    this.scroll?.setRange(Math.max(0, this.wrapped.length - visRows), false);
  }

  syncChatLog(r: SpriteRenderer, chatLog: readonly ChatLine[], darkBg = false): void {
    const tail = chatLog.slice(-60);
    const h = `${tail.length}:${tail[tail.length - 1]?.timeMs ?? 0}:${darkBg ? 1 : 0}`;
    if (h === this.lastHash) return;
    this.lastHash = h;
    const raw: MsgViewLine[] = tail.map((c) => {
      if (c.kind === "whisper") {
        return {
          text: c.to ? `[悄悄話->${c.to}] ${c.text}` : `[${c.from}的悄悄話] ${c.text}`,
          color: darkBg ? ([0.55, 0.98, 0.65, 1] as const) : ([0.04, 0.46, 0.18, 1] as const),
        };
      }
      if (c.kind === "speaker") {
        return {
          text: `[擴音器] ${c.from}: ${c.text}`,
          color: darkBg ? ([1, 0.9, 0.38, 1] as const) : ([0.68, 0.22, 0.04, 1] as const),
        };
      }
      if (c.kind === "system") {
        return {
          text: `${c.text}`,
          color: darkBg ? ([1, 0.92, 0.45, 1] as const) : ([0.62, 0.16, 0.12, 1] as const),
        };
      }
      if (c.color && /^#[0-9a-fA-F]{6}$/.test(c.color)) {
        const cr = parseInt(c.color.slice(1, 3), 16) / 255;
        const cg = parseInt(c.color.slice(3, 5), 16) / 255;
        const cb = parseInt(c.color.slice(5, 7), 16) / 255;
        return {
          text: `[${c.from}] ${c.text}`,
          color: darkBg
            ? ([Math.min(1, cr + 0.12), Math.min(1, cg + 0.12), Math.min(1, cb + 0.12), 1] as const)
            : ([cr * 0.82, cg * 0.55, cb * 0.72, 1] as const),
        };
      }
      return {
        text: `[${c.from}] ${c.text}`,
        color: darkBg ? ([1, 1, 1, 1] as const) : ([0.06, 0.1, 0.18, 1] as const),
      };
    });
    this.wrapped = this.wrapLines(r, raw);
    const visRows = Math.max(1, Math.floor(this.h / this.lineHeight));
    if (this.scroll) {
      this.scroll.setRange(Math.max(0, this.wrapped.length - visRows), true);
    }
  }

  render(r: SpriteRenderer, offsetX = 0, offsetY = 0, outline = false): void {
    const visRows = Math.max(1, Math.floor(this.h / this.lineHeight));
    const start = this.scroll
      ? Math.min(this.scroll.value, Math.max(0, this.wrapped.length - visRows))
      : Math.max(0, this.wrapped.length - visRows);
    r.pushClip(this.x + offsetX, this.y + offsetY, this.w, this.h);
    for (let i = 0; i < visRows; i++) {
      const ln = this.wrapped[start + i];
      if (!ln) break;
      r.drawText(ln.text, this.x + offsetX + 2, this.y + offsetY + i * this.lineHeight + 1, {
        color: ln.color,
        outlineColor: outline ? [0, 0, 0, 0.9] : undefined,
      });
    }
    r.popClip();
    this.scroll?.render(r, offsetX, offsetY);
  }
}

/** Recent world positions for the basic MotionBlur effect. Retail keeps an
 * 18-position ring and draws three past poses at alpha 76/102/128 (sub_41D5F7).
 * Tick sampling and interpolation here are approximations of the original loop. */
export class MotionBlurTrail {
  private points: { tick: number; x: number; y: number }[] = [];

  update(tick: number, x: number, y: number, enabled: boolean): readonly { x: number; y: number; alpha: number }[] {
    if (!enabled || !Number.isFinite(tick)) { this.points = []; return []; }
    const last = this.points[this.points.length - 1];
    if (last && (tick < last.tick || tick - last.tick > 10 || Math.hypot(x - last.x, y - last.y) > 80)) this.points = [];
    const current = this.points[this.points.length - 1];
    if (!current || current.tick !== tick) {
      this.points.push({ tick, x, y });
      if (this.points.length > 18) this.points.shift();
    } else {
      current.x = x; current.y = y;
    }
    if (this.points.length < 2 || this.points.every(p => p.x === x && p.y === y)) return [];
    const result: { x: number; y: number; alpha: number }[] = [];
    const weights = [76, 102, 128];
    for (let age = 3; age >= 1; age--) {
      const point = this.points[this.points.length - 1 - age];
      if (point) result.push({ x: point.x, y: point.y, alpha: weights[3 - age]! / 255 });
    }
    return result;
  }
}

/**
 * Helper cache that streams and renders animated `Character/C0x_Display_A` /
 * `Character/C0x_A` tinted by team color, plus `Shadow/Shadow` and `StockItem` icons.
 */
export class CharacterPreviewCache {
  private readonly pending = new Set<string>();
  private readonly loaded = new Map<string, LoadedSheet | null>();

  getSheet(
    assets: GameAssets,
    pack: PackName,
    path: string,
    team = 0,
    avatarDecoCodes?: readonly string[],
  ): LoadedSheet | null {
    if (!path) return null;
    const decoSuffix = avatarDecoCodes && avatarDecoCodes.length > 0 ? `:${avatarDecoCodes.join("+")}` : "";
    const key = `${pack}:${path}#${team}${decoSuffix}`;
    if (this.loaded.has(key)) return this.loaded.get(key) ?? null;
    if (!this.pending.has(key)) {
      this.pending.add(key);
      const loader =
        pack === "Fx" && avatarDecoCodes && avatarDecoCodes.length > 0
          ? assets.loadTeamSheet(path, team, avatarDecoCodes)
          : team >= 1 && team <= 8 && (pack === "Fx" || pack === "CharTE")
            ? assets.loadTeamPackSheet(pack, path, team)
            : assets.loadSheet(pack, path);
      loader.then((s) => {
        this.loaded.set(key, s);
        this.pending.delete(key);
      });
    }
    return null;
  }

  getTwinkleSheet(assets: GameAssets, twinkleIdx?: number): LoadedSheet | null {
    if (twinkleIdx === undefined || twinkleIdx < 0 || twinkleIdx > 7) return null;
    const pad = String(twinkleIdx).padStart(3, "0");
    return this.getSheet(assets, "Fx", `Level/Twinkle${pad}`, 0);
  }

  /**
   * Retail `CLevelIconEffector` (`CA.exe.c:222147`, `sub_4F7285`) 240-frame 3D rotating medal sheet
   * (`Fx:Level/Rotate000`), active whenever a player equips/previews a `cat 5` Level Icon Effect (`0..7`).
   */
  getRotateSheet(assets: GameAssets, twinkleIdx?: number): LoadedSheet | null {
    if (twinkleIdx === undefined || twinkleIdx < 0 || twinkleIdx > 7) return null;
    return this.getSheet(assets, "Fx", "Level/Rotate000", 0);
  }

  /**
   * Retail `CGOExtensionShadow` (`CA.exe.c:15389..15395, 22007..22045`):
   * Checks if bomber uses `Character/ExtensionShadow` (`Fx:"ExtensionShadow/GourdBottleEffect "`, 11f)
   * — currently used for Super Characters (`charIdx >= 8`) or `G` aura decorations.
   */
  hasExtensionShadow(
    assets: GameAssets,
    charIdx: number,
    stockIds?: readonly (number | undefined)[],
  ): boolean {
    if (charIdx >= 8) return true;
    if (!stockIds || stockIds.length === 0) return false;
    const cos = assets.tables?.cosmetics;
    for (const sid of stockIds) {
      if (!sid || sid <= 0) continue;
      if (cos) {
        for (const v of cos.expandVisuals(sid)) {
          if (v.liveKind === "charDeco" && v.subSlot === "G") {
            return true;
          }
        }
      }
    }
    return false;
  }

  drawExtensionShadow(
    r: SpriteRenderer,
    assets: GameAssets,
    tileX: number,
    footY: number,
    tick: number,
    alpha = 128 / 255,
  ): boolean {
    const extObj = assets.objects.byName.get("Character/ExtensionShadow");
    const act = extObj?.defaultAction;
    const spriteName = act?.sprite ?? "ExtensionShadow/GourdBottleEffect ";
    const sh = this.getSheet(assets, "Fx", spriteName, 0);
    if (!sh) return false;
    const frame = act
      ? sampleActionFrame(act, tick, true)
      : Math.floor(Math.max(0, tick) / 3) % Math.max(1, sh.sheet?.rects.length ?? 1);
    drawSheetFrame(r, sh, frame, tileX, footY, {
      anchor: true,
      tint: [1, 1, 1, alpha],
    });
    return true;
  }

  resolveFanfareIndexForStocks(
    assets: GameAssets,
    stockIds?: readonly (number | undefined)[],
  ): number | null {
    if (!stockIds || stockIds.length === 0) return null;
    const cos = assets.tables?.cosmetics;
    if (!cos) return null;
    for (const sid of stockIds) {
      if (!sid || sid <= 0) continue;
      for (const v of cos.expandVisuals(sid)) {
        if (v.liveKind === "fanfare" && v.skinIndex !== undefined) {
          return v.skinIndex;
        }
      }
    }
    return null;
  }

  /**
   * Retail `CGOFanfareActor` (`CA.exe.c:22072..22370`, `EmoTE:Fanfare/Fanfare000..006`):
   * Renders the equipped victory celebration fanfare centered on a winning bomber in `CGameStage`!
   */
  drawFanfareForStocks(
    r: SpriteRenderer,
    assets: GameAssets,
    stockIds: readonly (number | undefined)[] | undefined,
    tileX: number,
    footY: number,
    tick: number,
    alpha = 1,
  ): boolean {
    if (!stockIds || stockIds.length === 0) return false;
    const cos = assets.tables?.cosmetics;
    const emoTable = assets.tables?.emoObjectTable;
    if (!cos || !emoTable) return false;
    for (const sid of stockIds) {
      if (!sid || sid <= 0) continue;
      for (const v of cos.expandVisuals(sid)) {
        if (v.liveKind === "fanfare" && v.liveObject) {
          if (
            this.drawCosmeticObject(
              r,
              assets,
              "EmoTE",
              emoTable,
              v.liveObject,
              ["Default", "default"],
              tileX + 20,
              footY - 12,
              tick,
              { alpha },
            )
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  drawStockIcon(
    r: SpriteRenderer,
    assets: GameAssets,
    stock: StockItem | undefined,
    cx: number,
    cy: number,
    maxW = 48,
    maxH = 44,
  ): void {
    if (!stock) return;
    const vis = assets.tables?.cosmetics.resolve(stock.id);
    const pack: PackName = vis ? vis.iconPack : "Fx";
    const iconName = vis ? vis.iconName : stock.iconPath;
    let sh = iconName ? this.getSheet(assets, pack, iconName, 0) : null;
    if (!sh && stock.category === 3) {
      // Retail `sub_4CAA6B` (`CA.exe.c:179108`) Emotion fallback (`off_6180B4` -> `Shop/Emot*`)
      const fbIdx = Math.max(0, Math.min(EMOT_SHOP_FALLBACK_ICONS.length - 1, stock.subType % 8));
      sh = this.getSheet(assets, "Fx", EMOT_SHOP_FALLBACK_ICONS[fbIdx]!, 0);
    }
    if (!sh) return;
    const rc = sh.sheet?.rects[0];
    const iw = rc ? rc.x1 - rc.x0 : sh.width;
    const ih = rc ? rc.y1 - rc.y0 : sh.height;
    if (iw <= 0 || ih <= 0) return;
    const scale = Math.min(1, maxW / iw, maxH / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    drawSheetFrame(r, sh, 0, Math.round(cx - dw * 0.5), Math.round(cy - dh * 0.5), { w: dw, h: dh });
  }

  /** Draw a stock icon at its native sprite anchor, as used by the retail shop. */
  drawStockIconAnchored(r: SpriteRenderer, assets: GameAssets, stock: StockItem, x: number, y: number): void {
    const vis = assets.tables?.cosmetics.resolve(stock.id);
    let sh = (vis ? vis.iconName : stock.iconPath)
      ? this.getSheet(assets, vis ? vis.iconPack : "Fx", vis ? vis.iconName : stock.iconPath, 0)
      : null;
    if (!sh && stock.category === 3) {
      const idx = Math.max(0, Math.min(EMOT_SHOP_FALLBACK_ICONS.length - 1, stock.subType % 8));
      sh = this.getSheet(assets, "Fx", EMOT_SHOP_FALLBACK_ICONS[idx]!, 0);
    }
    drawSheetFrame(r, sh, 0, x, y, { anchor: true });
  }

  /**
   * Draw an `ObjectTable` entry (`Fx`, `CharTE`, or `EmoTE`) by preferred action names
   * (with case-insensitive fallback) at retail sprite anchor `(anchorX, anchorY)`.
   */
  drawCosmeticObject(
    r: SpriteRenderer,
    assets: GameAssets,
    pack: PackName,
    table: ObjectTable,
    objName: string,
    actionPrefs: readonly string[],
    anchorX: number,
    anchorY: number,
    tick: number,
    opts?: { team?: number; alpha?: number; loop?: boolean },
  ): boolean {
    const obj = table.byName.get(objName);
    if (!obj) return false;
    let act: ObjectAction | undefined;
    for (const cand of actionPrefs) {
      act = obj.actions.get(cand);
      if (act) break;
      const low = cand.toLowerCase();
      for (const [k, v] of obj.actions) {
        if (k.toLowerCase() === low) {
          act = v;
          break;
        }
      }
      if (act) break;
    }
    if (!act) act = obj.defaultAction ?? undefined;
    if (!act) return false;
    const sh = this.getSheet(assets, pack, act.sprite, opts?.team ?? 0);
    if (!sh) return false;
    const frame = sampleActionFrame(act, tick, opts?.loop ?? true);
    const a = opts?.alpha ?? 1;
    drawSheetFrame(r, sh, frame, Math.round(anchorX), Math.round(anchorY), {
      anchor: true,
      tint: a < 1 ? [1, 1, 1, a] : undefined,
    });
    return true;
  }

  /**
   * Render `CGOCharDecorator` (`0x00415609`) & `CGOCharDecoratorFollower` (`0x004156FF`):
   * - `"back"`: `D` (wing/backpack) & `G` (aura)
   * - `"front"`: `A` (hat/hair), `B` (face/glasses), plus `E` (pet) unless `excludeFollowerFromFront` is set
   * - `"follower"`: `E` (trailing pet companion following the bomber's walk path in `CGameStage`)
   */
  drawCharDecoForStocks(
    r: SpriteRenderer,
    assets: GameAssets,
    stockIds: readonly number[],
    pass: "back" | "front" | "follower",
    dir: 0 | 1 | 2 | 3,
    tileX: number,
    footY: number,
    tick: number,
    team = 0,
    alpha = 1,
    excludeFollowerFromFront = false,
  ): void {
    const cos = assets.tables?.cosmetics;
    const charTable = assets.tables?.charObjectTable;
    if (!cos || !charTable || stockIds.length === 0) return;
    const dirAction = (["00 Left", "01 Up", "02 Right", "03 Down"] as const)[dir]!;
    for (const sid of stockIds) {
      if (!sid || sid <= 0) continue;
      for (const v of cos.expandVisuals(sid)) {
        if (v.liveKind !== "charDeco" || !v.liveObject) continue;
        const isBack = v.subSlot === "D" || v.subSlot === "G";
        const isFollower = v.subSlot === "E";
        if (pass === "back" && !isBack) continue;
        if (pass === "follower" && !isFollower) continue;
        if (pass === "front" && (isBack || (excludeFollowerFromFront && isFollower))) continue;
        this.drawCosmeticObject(
          r,
          assets,
          "CharTE",
          charTable,
          v.liveObject,
          [dirAction, "Default", "default"],
          tileX,
          footY,
          tick,
          { team, alpha },
        );
      }
    }
  }

  /**
   * Render `CIDDecoEffector` (`EmoTE:IDDeco/IDDeco_C001G..008G`, action `"02 Game"` / `"01 Lobby"`)
   * behind/over a player's nickname in `CGameStage` HUD, `CGOGameResult`, or `LobbyStage`!
   */
  drawGameIdDeco(
    r: SpriteRenderer,
    assets: GameAssets,
    idDecoStockId: number | undefined,
    x: number,
    y: number,
    tick: number,
  ): boolean {
    if (!idDecoStockId || idDecoStockId <= 0) return false;
    const cos = assets.tables?.cosmetics;
    const emoTable = assets.tables?.emoObjectTable;
    if (!cos || !emoTable) return false;
    for (const v of cos.expandVisuals(idDecoStockId)) {
      if (v.liveKind === "idDeco" && v.liveObject) {
        if (
          this.drawCosmeticObject(
            r,
            assets,
            "EmoTE",
            emoTable,
            v.liveObject,
            ["02 Game", "01 Lobby", "Default"],
            x,
            y,
            tick,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Render `CGOSlotDecorator` (`0x00444CC0`) back (`Slot01`, `Slot04`, `Slot06` or `Fanfare`)
   * or front (`Slot07` fence/foreground) layers inside a `98x98` `CGameSlot` at `(slotX, slotY)`.
   */
  drawSlotCosmeticsForStocks(
    r: SpriteRenderer,
    assets: GameAssets,
    stockIds: readonly number[],
    pass: "back" | "front" | "idDeco",
    slotX: number,
    slotY: number,
    tick: number,
  ): boolean {
    const cos = assets.tables?.cosmetics;
    const emoTable = assets.tables?.emoObjectTable;
    if (!cos || !emoTable || stockIds.length === 0) return false;
    const visuals: ResolvedStockVisual[] = [];
    for (const sid of stockIds) {
      if (!sid || sid <= 0) continue;
      for (const v of cos.expandVisuals(sid)) visuals.push(v);
    }
    let drewAny = false;
    if (pass === "idDeco") {
      for (const v of visuals) {
        if (v.liveKind === "idDeco" && v.liveObject) {
          if (
            this.drawCosmeticObject(
              r,
              assets,
              "EmoTE",
              emoTable,
              v.liveObject,
              ["03 Preview", "02 Game", "01 Lobby", "Default"],
              slotX - 11,
              slotY + 8,
              tick,
            )
          ) {
            drewAny = true;
          }
        }
      }
      return drewAny;
    }

    if (pass === "back") {
      for (const v of visuals) {
        if (v.liveKind === "fanfare" && v.liveObject) {
          if (this.drawCosmeticObject(r, assets, "EmoTE", emoTable, v.liveObject, ["Default"], slotX, slotY, tick)) {
            drewAny = true;
          }
        }
      }
      for (const layer of ["Slot01", "Slot04", "Slot06"] as const) {
        for (const v of visuals) {
          if (v.liveKind === "slotDeco" && v.subSlot === layer && v.liveObject) {
            if (this.drawCosmeticObject(r, assets, "EmoTE", emoTable, v.liveObject, ["Default"], slotX, slotY, tick)) {
              drewAny = true;
            }
          }
        }
      }
      return drewAny;
    }

    for (const v of visuals) {
      if (v.liveKind === "slotDeco" && v.subSlot === "Slot07" && v.liveObject) {
        if (this.drawCosmeticObject(r, assets, "EmoTE", emoTable, v.liveObject, ["Default"], slotX, slotY, tick)) {
          drewAny = true;
        }
      }
    }
    return drewAny;
  }

  /**
   * Render equipped or previewed `CharTE:BombDeco/Bomb001..010` water-balloon skin at `(tileX, footY)`.
   */
  drawBombSkinForStock(
    r: SpriteRenderer,
    assets: GameAssets,
    stockId: number,
    tileX: number,
    footY: number,
    tick: number,
    alpha = 1,
  ): boolean {
    if (!stockId || stockId <= 0) return false;
    const cos = assets.tables?.cosmetics;
    const charTable = assets.tables?.charObjectTable;
    if (!cos || !charTable) return false;
    for (const v of cos.expandVisuals(stockId)) {
      if (v.liveKind === "bombSkin" && v.liveObject) {
        return this.drawCosmeticObject(
          r,
          assets,
          "CharTE",
          charTable,
          v.liveObject,
          ["Default", "default"],
          tileX,
          footY,
          tick,
          { alpha },
        );
      }
    }
    return false;
  }

  drawDisplayBomber(
    r: SpriteRenderer,
    assets: GameAssets,
    charIdx: number,
    team: number,
    anchorX: number,
    anchorY: number,
    tick: number,
    small = false,
    decoStockIds?: readonly number[],
    emotion?: { pose?: number; stockId?: number },
    walk?: { dir: 0 | 1 | 2 | 3; moving: boolean },
  ): void {
    // Retail `C00..C10` & `Shadow/Shadow` sprites use `pivotX=56, anchorX=8` (`center = tileLeft + 20`),
    // matching `CA.exe` `dword_615F60 = 27 = 47 - 20`. Convert caller's horizontal center `anchorX` to `tileLeft`.
    const tileX = Math.round(anchorX - 20);
    const dir: 0 | 1 | 2 | 3 = walk?.dir ?? 3;
    if (decoStockIds && decoStockIds.length > 0) {
      this.drawCharDecoForStocks(r, assets, decoStockIds, "back", dir, tileX, anchorY, tick, team);
    }
    const c = charIdx < 0 ? 0 : Math.max(0, Math.min(10, charIdx));
    if (!small && this.hasExtensionShadow(assets, c, decoStockIds)) {
      if (!this.drawExtensionShadow(r, assets, tileX, anchorY, tick, 128 / 255)) {
        const shadow = this.getSheet(assets, "Fx", "Shadow/Shadow", 0);
        if (shadow) drawSheetFrame(r, shadow, 0, tileX, anchorY, { anchor: true, tint: [1, 1, 1, 0.72] });
      }
    } else {
      const shadow = this.getSheet(assets, "Fx", "Shadow/Shadow", 0);
      if (shadow) drawSheetFrame(r, shadow, 0, tileX, anchorY, { anchor: true, tint: [1, 1, 1, 0.72] });
    }

    let drewChar = false;

    // Retail `CGOEmotionActor` (`EmoTE:Character/C0x_Emotion*` two-layer team-HLS sprite)
    if (!small && !walk?.moving && emotion && ((emotion.pose && emotion.pose > 0) || (emotion.stockId && emotion.stockId > 0))) {
      const cos = assets.tables?.cosmetics;
      const emoTab = assets.tables?.emoObjectTable;
      const emoObjName = cos?.resolveEmotionObject(c, emotion.pose ?? 0, emotion.stockId ?? 0);
      const emoAct = emoObjName ? emoTab?.byName.get(emoObjName)?.defaultAction : undefined;
      if (emoAct) {
        const sh = this.getSheet(assets, "EmoTE", emoAct.sprite, team);
        if (sh) {
          const frame = sampleActionFrame(emoAct, tick, true);
          drawSheetFrame(r, sh, frame, tileX, anchorY, { anchor: true });
          drewChar = true;
        }
      }
    }

    const code = `C${String(c).padStart(2, "0")}`;
    const avatarDecoCodes: string[] = [];
    if ((c === 6 || c === 10) && decoStockIds && decoStockIds.length > 0) {
      const cos = assets.tables?.cosmetics;
      if (cos) {
        for (const sid of decoStockIds) {
          if (!sid || sid <= 0) continue;
          for (const v of cos.expandVisuals(sid)) {
            if (v.liveKind === "avatarDeco" && v.liveObject) {
              avatarDecoCodes.push(v.liveObject.replace(/^AvatarDeco\//i, ""));
            }
          }
        }
      }
    }
    if (!drewChar && walk && (walk.moving || walk.dir !== 3)) {
      const gameObj = assets.objects.byName.get(`Character/${code}_A`);
      const walkKey = walk.moving
        ? (["20 Walk Left", "21 Walk Up", "22 Walk Right", "23 Walk Down"] as const)[walk.dir]!
        : (["12 Stop Left", "13 Stop Up", "14 Stop Right", "15 Stop Down"] as const)[walk.dir]!;
      const wAct = gameObj?.actions.get(walkKey);
      if (wAct) {
        const sh = this.getSheet(assets, "Fx", wAct.sprite, team, avatarDecoCodes);
        const frame = sampleActionFrame(wAct, tick, true);
        if (sh) {
          drawSheetFrame(r, sh, frame, tileX, anchorY, { anchor: true });
          drewChar = true;
        }
      }
    }
    if (!drewChar) {
      const dispObj = assets.objects.byName.get(`Character/${code}_Display_A`);
      const act = dispObj?.actions.get(small ? "BlinkSmall" : "Blink") ?? dispObj?.actions.get("Blink");
      if (act) {
        const sh = this.getSheet(assets, "Fx", act.sprite, team, avatarDecoCodes);
        const frame = sampleActionFrame(act, tick, true);
        if (sh) {
          drawSheetFrame(r, sh, frame, tileX, anchorY, { anchor: true });
          drewChar = true;
        }
      }
    }

    if (!drewChar) {
      const gameObj = assets.objects.byName.get(`Character/${code}_A`);
      const gAct = gameObj?.actions.get("00 Blink") ?? gameObj?.actions.get("15 Stop Down");
      if (gAct) {
        const sh = this.getSheet(assets, "Fx", gAct.sprite, team, avatarDecoCodes);
        const frame = sampleActionFrame(gAct, tick, true);
        if (sh) drawSheetFrame(r, sh, frame, tileX, anchorY, { anchor: true });
      }
    }

    if (decoStockIds && decoStockIds.length > 0) {
      this.drawCharDecoForStocks(r, assets, decoStockIds, "front", dir, tileX, anchorY, tick, team);
    }
  }
}

/**
 * Map retail chat slash-commands & Traditional Chinese emotion keywords to `pose` `1..8` (`A..H`).
 */
export function inferChatEmotionPose(text: string): number {
  const s = text.trim().toLowerCase();
  if (!s) return 0;
  if (/^\/(1|hi|hello|bye|哈囉|你好|嗨|安安)/.test(s) || /哈囉|你好|嗨嗨|安安|掰掰|^881?$|^bye$/.test(s)) return 1; // A: Greet
  if (/^\/(2|haha|lol|smile|笑|哈哈)/.test(s) || /哈哈|呵呵|嘿嘿|XD/i.test(s)) return 2; // B: Smile
  if (/^\/(3|cry|sad|哭|嗚)/.test(s) || /嗚嗚|哭哭|QQ|T_T/i.test(s)) return 3; // C: Sad
  if (/^\/(4|angry|mad|怒|氣)/.test(s) || /可惡|生氣|氣死/.test(s)) return 4; // D: Angry
  if (/^\/(5|shy|羞|石化)/.test(s) || /害羞|不好意思/.test(s)) return 5; // E: Shy
  if (/^\/(6|dance|cheer|加油|跳)/.test(s) || /加油|衝啊|萬歲/.test(s)) return 6; // F: Dance/Cheer
  if (/^\/(7|love|heart|愛|親)/.test(s) || /愛你|愛心|喜歡|<3/.test(s)) return 7; // G: Love
  if (/^\/(8|special|cool|耍帥|特)/.test(s)) return 8; // H: Special
  return 0;
}

/**
 * Retail `CInventoryWndNew` (`CA.exe` `sub_4CBFF0` `L180210..180350`):
 *   - 8 item slots in a `4x2` grid (`slotW = 61, slotH = 54, stepX = 63, stepY = 57`)
 *   - `Shop/BtMyBag_Left` at `(baseX + 6, baseY + 118)`
 *   - `Shop/BtMyBag_Right` at `(baseX + 141, baseY + 118)`
 *   - Used at `(34, 383)` in `CMyPageDialog`, `(510, 408)` in `CChattingStage`, `(505, 406)` in `CExchangeStage`.
 */
export class InventoryWndNew {
  readonly baseX: number;
  readonly baseY: number;
  readonly mode: 0 | 1 | 2;
  readonly btLeft: SpriteButton;
  readonly btRight: SpriteButton;
  readonly btAccessory: SpriteButton | null = null;
  readonly btEmotion: SpriteButton | null = null;
  private selBoxSheet: LoadedSheet | null = null;
  private shopImgSheet: LoadedSheet | null = null;
  private timeIconSheet: LoadedSheet | null = null;
  private timeTable01Sheet: LoadedSheet | null = null;
  private timeTable02Sheet: LoadedSheet | null = null;
  private hoveredSlot = -1;
  page = 0;
  selectedInvId = -1;
  /** `0` = Accessory/Cosmetics (`category !== 3`), `1` = Emotions (`category === 3`) in `mode = 1 | 2`. */
  tabFilter: 0 | 1 = 0;
  private readonly cache: CharacterPreviewCache;
  onSlotClick?: (invId: number) => void;
  /** Optional view ordering; it must contain the same inventory rows as the server. */
  rowsProvider?: (hub: ClientHub) => ClientHub["inventory"];
  isPriorityRow?: (row: ClientHub["inventory"][number]) => boolean;

  constructor(baseX: number, baseY: number, cache: CharacterPreviewCache, mode: 0 | 1 | 2 = 0, onSlotClick?: (invId: number) => void) {
    this.baseX = baseX;
    this.baseY = baseY;
    this.mode = mode;
    this.cache = cache;
    this.onSlotClick = onSlotClick;
    const btnY = baseY + (mode === 0 ? 118 : 119);
    this.btLeft = new SpriteButton(baseX + 6, btnY, () => {
      this.page = Math.max(0, this.page - 1);
    });
    this.btRight = new SpriteButton(baseX + 141, btnY, () => {
      this.page++;
    });
    if (mode === 1 || mode === 2) {
      this.btAccessory = new SpriteButton(baseX, baseY - 26, () => {
        this.tabFilter = 0;
        this.page = 0;
      });
      this.btEmotion = new SpriteButton(baseX + 64, baseY - 26, () => {
        this.tabFilter = 1;
        this.page = 0;
      });
    }
  }

  async load(assets: GameAssets): Promise<void> {
    const prefix = this.mode === 1 ? "Chatting" : this.mode === 2 ? "Exchange" : null;
    const [l, ri, sel, shopImg, accSh, emoSh, timeIcon, timeTable01, timeTable02] = await Promise.all([
      assets.loadSheet("Fx", "Shop/BtMyBag_Left"),
      assets.loadSheet("Fx", "Shop/BtMyBag_Right"),
      assets.loadSheet("Fx", "MyInfo/BtSpecialItemClicked"),
      assets.loadSheet("Fx", "Shop/ShopImg"),
      prefix ? assets.loadSheet("Fx", `${prefix}/BtAccessory`) : Promise.resolve(null),
      prefix ? assets.loadSheet("Fx", `${prefix}/BtEmotion`) : Promise.resolve(null),
      assets.loadSheet("Fx", "Shop/IconTime"),
      assets.loadSheet("Fx", "Shop/TimeTable_01"),
      assets.loadSheet("Fx", "Shop/TimeTable_02"),
    ]);
    this.btLeft.bindSheet(l, 30, 23);
    this.btRight.bindSheet(ri, 30, 23);
    if (this.btAccessory && accSh) this.btAccessory.bindSheet(accSh, 63, 21);
    if (this.btEmotion && emoSh) this.btEmotion.bindSheet(emoSh, 63, 21);
    this.selBoxSheet = sel;
    this.shopImgSheet = shopImg;
    this.timeIconSheet = timeIcon;
    this.timeTable01Sheet = timeTable01;
    this.timeTable02Sheet = timeTable02;
  }

  clearHover(): void { this.hoveredSlot = -1; }

  private effectiveFilter(filterCat?: number[] | null): ((cat: number) => boolean) | null {
    if (filterCat) return (cat) => filterCat.includes(cat);
    if (this.mode === 1 || this.mode === 2) {
      return this.tabFilter === 1 ? (cat) => cat === 3 : (cat) => cat !== 3;
    }
    return null;
  }

  slotRect(idx: number, offsetX = 0, offsetY = 0): Rect {
    return {
      x: offsetX + this.baseX + 63 * (idx % 4),
      y: offsetY + this.baseY + 57 * Math.floor(idx / 4),
      w: 61,
      h: 54,
    };
  }

  onMouseMove(mx: number, my: number, sound: SoundManager, offsetX = 0, offsetY = 0): void {
    this.btLeft.onMouseMove(mx - offsetX, my - offsetY, sound);
    this.btRight.onMouseMove(mx - offsetX, my - offsetY, sound);
    this.btAccessory?.onMouseMove(mx - offsetX, my - offsetY, sound);
    this.btEmotion?.onMouseMove(mx - offsetX, my - offsetY, sound);
    this.hoveredSlot = -1;
    for (let i = 0; i < 8; i++) {
      if (pointInRect(mx, my, this.slotRect(i, offsetX, offsetY))) {
        this.hoveredSlot = i;
        break;
      }
    }
  }

  onMouseDown(mx: number, my: number, hub: ClientHub, sound: SoundManager, offsetX = 0, offsetY = 0, filterCat?: number[] | null): boolean {
    if (this.btLeft.onMouseDown(mx - offsetX, my - offsetY)) return true;
    if (this.btRight.onMouseDown(mx - offsetX, my - offsetY)) return true;
    if (this.btAccessory?.onMouseDown(mx - offsetX, my - offsetY)) return true;
    if (this.btEmotion?.onMouseDown(mx - offsetX, my - offsetY)) return true;
    const pred = this.effectiveFilter(filterCat);
    const rows = this.rowsProvider ? this.rowsProvider(hub) : hub.inventory;
    const items = pred ? rows.filter((it) => pred(it.category)) : rows;
    for (let i = 0; i < 8; i++) {
      const rc = this.slotRect(i, offsetX, offsetY);
      if (pointInRect(mx, my, rc)) {
        const row = items[this.page * 8 + i];
        if (row) {
          this.selectedInvId = row.invId;
          sound.playSfx("ButtonDown_0", 0.6);
          this.onSlotClick?.(row.invId);
        }
        return true;
      }
    }
    return false;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager, offsetX = 0, offsetY = 0): boolean {
    if (this.btLeft.onMouseUp(mx - offsetX, my - offsetY, sound)) return true;
    if (this.btRight.onMouseUp(mx - offsetX, my - offsetY, sound)) return true;
    if (this.btAccessory?.onMouseUp(mx - offsetX, my - offsetY, sound)) return true;
    if (this.btEmotion?.onMouseUp(mx - offsetX, my - offsetY, sound)) return true;
    return false;
  }

  render(r: SpriteRenderer, assets: GameAssets, hub: ClientHub, offsetX = 0, offsetY = 0, filterCat?: number[] | null): void {
    if (this.btAccessory && this.btEmotion) {
      this.btAccessory.toggled = this.tabFilter === 0;
      this.btEmotion.toggled = this.tabFilter === 1;
      this.btAccessory.render(r, offsetX, offsetY);
      this.btEmotion.render(r, offsetX, offsetY);
    }
    const pred = this.effectiveFilter(filterCat);
    const rows = this.rowsProvider ? this.rowsProvider(hub) : hub.inventory;
    const items = pred ? rows.filter((it) => pred(it.category)) : rows;
    const maxPage = Math.max(0, Math.ceil(items.length / 8) - 1);
    if (this.page > maxPage) this.page = maxPage;
    this.btLeft.enabled = this.page > 0;
    this.btRight.enabled = this.page < maxPage;

    for (let i = 0; i < 8; i++) {
      const row = items[this.page * 8 + i];
      if (!row) continue;
      const rc = this.slotRect(i, offsetX, offsetY);
      const stock = assets.tables?.stockById.get(row.stockId);
      // 4CB6A6 draws the bag marker and icon at native sprite anchors.
      if (row.invId === this.selectedInvId) {
        drawSheetFrame(r, this.shopImgSheet, 7, rc.x, rc.y + 55, { anchor: true });
      } else if (this.isPriorityRow?.(row)) {
        drawSheetFrame(r, this.shopImgSheet, 8 + ((Date.now() & 0x200) !== 0 ? 1 : 0), rc.x, rc.y + 55, { anchor: true });
      }
      if (stock) this.cache.drawStockIconAnchored(r, assets, stock, rc.x + (row.category === 10 ? 10 : 11), rc.y + 67);
      if (row.remainingHours !== undefined && row.remainingHours > 0 && row.remainingHours < 8760) {
        drawSheetFrame(r, this.timeIconSheet, 0, rc.x + 15, rc.y + 75, { anchor: true });
      }
      // sub_4DFCEC: quantity is shown for user-item categories 1, 13, 15,
      // including a quantity of one; cosmetics do not display stack counts.
      if (row.category === 1 || row.category === 13 || row.category === 15) {
        r.drawText(`${row.quantity}`, rc.x + 40, rc.y + 38, {
          align: "right",
          color: [0.08, 0.14, 0.28, 1],
        });
      }
    }

    // sub_4CBA2F: tooltip is anchored above the hovered slot. Unknown
    // remaining hours do not imply either a duration or permanent ownership.
    const hovered = this.hoveredSlot >= 0 ? items[this.page * 8 + this.hoveredSlot] : undefined;
    const hoveredStock = hovered ? assets.tables?.stockById.get(hovered.stockId) : undefined;
    if (hovered && hoveredStock) {
      const rc = this.slotRect(this.hoveredSlot, offsetX, offsetY);
      const period = inventoryTooltipPeriod(hovered.remainingHours, assets.tables?.sysStrings);
      const sheet = period ? this.timeTable02Sheet : this.timeTable01Sheet;
      const centerX = rc.x + Math.floor(rc.w / 2) + 1;
      if (sheet) drawSheetFrame(r, sheet, 0, centerX - Math.floor(117 / 2), rc.y, {
        anchor: true, tint: [1, 1, 1, 200 / 255],
      });
      r.drawText(inventoryTooltipName(hoveredStock.name), centerX, rc.y - (period ? 35 : 20), {
        align: "center", color: [1, 1, 1, 1],
      });
      if (period) r.drawText(period, centerX, rc.y - 21, { align: "center", color: [1, 1, 1, 1] });
    }

    this.btLeft.render(r, offsetX, offsetY);
    this.btRight.render(r, offsetX, offsetY);
    const px = offsetX + this.baseX + 43;
    const py = offsetY + this.baseY + 124;
    if (this.shopImgSheet) {
      drawSpriteDigits(r, this.shopImgSheet, px, py, 13, 3, this.page + 1, 46);
      drawSheetFrame(r, this.shopImgSheet, 56, px + 39, py, { anchor: true });
      drawSpriteDigits(r, this.shopImgSheet, px + 52, py, 13, 3, maxPage + 1, 46);
    } else {
      r.drawText(`${this.page + 1}/${maxPage + 1}`, offsetX + this.baseX + 88, py, {
        align: "center",
        color: [0.08, 0.16, 0.32, 1],
      });
    }
  }
}

export interface InventoryPopupActions {
  onToggleEquip?: (invId: number, equip: boolean) => void;
  onShowDetail?: (stockId: number, invId: number) => void;
  onSell?: (invId: number) => void;
  onDelete?: (invId: number) => void;
}

/**
 * Retail `CShopInventoryPopupDlg` (`CA.exe.c:54800..55005`):
 *   - Frame shells (`86px` wide):
 *     - 1 row: `Fx:Shop/SelectBox_Single` (`86x23`)
 *     - 2 rows: `Fx:Shop/SelectBox` (`86x42`)
 *     - 3 rows: `Fx:Shop/SelectBox_Three` (`86x62`)
 *   - Action buttons (`81x15`, 4f) at `(x + 2, y + 3 + 19 * rowIdx)`:
 *     - `Fx:Shop/SelectBox_Deco` (穿戴裝備)
 *     - `Fx:Shop/SelectBox_DecoCancel` (卸下裝備)
 *     - `Fx:Shop/SelectBox_Dialog` (商品詳細說明 -> `CShopTextDlg`)
 *     - `Fx:Shop/SelectBox_Sell` (販售退回 LUCCI)
 *     - `Fx:Shop/SelectBox_Delete` (丟棄道具)
 */
export class ShopInventoryPopupMenu {
  active = false;
  private x = 0;
  private y = 0;
  private bgSingle: LoadedSheet | null = null;
  private bgTwo: LoadedSheet | null = null;
  private bgThree: LoadedSheet | null = null;
  private shDeco: LoadedSheet | null = null;
  private shDecoCancel: LoadedSheet | null = null;
  private shDialog: LoadedSheet | null = null;
  private shSell: LoadedSheet | null = null;
  private shDelete: LoadedSheet | null = null;
  private buttons: SpriteButton[] = [];

  async load(assets: GameAssets): Promise<void> {
    const [b1, b2, b3, dc, dcc, dlg, sl, dl] = await Promise.all([
      assets.loadSheet("Fx", "Shop/SelectBox_Single"),
      assets.loadSheet("Fx", "Shop/SelectBox"),
      assets.loadSheet("Fx", "Shop/SelectBox_Three"),
      assets.loadSheet("Fx", "Shop/SelectBox_Deco"),
      assets.loadSheet("Fx", "Shop/SelectBox_DecoCancel"),
      assets.loadSheet("Fx", "Shop/SelectBox_Dialog"),
      assets.loadSheet("Fx", "Shop/SelectBox_Sell"),
      assets.loadSheet("Fx", "Shop/SelectBox_Delete"),
    ]);
    this.bgSingle = b1;
    this.bgTwo = b2;
    this.bgThree = b3;
    this.shDeco = dc;
    this.shDecoCancel = dcc;
    this.shDialog = dlg;
    this.shSell = sl;
    this.shDelete = dl;
  }

  open(
    mx: number,
    my: number,
    item: { invId: number; stockId: number; category: number; equipped: boolean },
    actions: InventoryPopupActions,
  ): void {
    const rows: { sheet: LoadedSheet | null; run: () => void }[] = [];
    const equippable = [3, 4, 5, 6, 10, 12, 14, 15, 18, 19].includes(item.category);
    if (equippable && actions.onToggleEquip) {
      rows.push({
        sheet: item.equipped ? this.shDecoCancel : this.shDeco,
        run: () => actions.onToggleEquip!(item.invId, !item.equipped),
      });
    }
    if (actions.onShowDetail) {
      rows.push({
        sheet: this.shDialog,
        run: () => actions.onShowDetail!(item.stockId, item.invId),
      });
    }
    if (actions.onSell && rows.length < 3) {
      rows.push({
        sheet: this.shSell,
        run: () => actions.onSell!(item.invId),
      });
    }
    if (actions.onDelete && rows.length < 3) {
      rows.push({
        sheet: this.shDelete,
        run: () => actions.onDelete!(item.invId),
      });
    }
    this.bindRows(mx, my, rows);
  }

  /** MyInfo strategy supplies Deco unless category 15/27, and Delete, never Sell (4CCD51). */
  openMyInfo(mx: number, my: number, item: { invId: number; category: number },
    actions: { onDecorate: (invId: number) => void; onDelete: (invId: number) => void }): void {
    const rows: { sheet: LoadedSheet | null; run: () => void }[] = [];
    if (item.category !== 15 && item.category !== 27) {
      rows.push({ sheet: this.shDeco, run: () => actions.onDecorate(item.invId) });
    }
    rows.push({ sheet: this.shDelete, run: () => actions.onDelete(item.invId) });
    this.bindRows(mx, my, rows);
  }

  /**
   * Retail `CCartSlotPopupDlg` (`CA.exe.c:54665..54750`):
   * `Shop/SelectBox` (`2` rows: `Shop/SelectBox_Dialog` at `(2,2)` + `Shop/SelectBox_Delete` at `(2,22)`).
   */
  openCartSlot(
    mx: number,
    my: number,
    actions: { onShowDetail: () => void; onDelete: () => void },
  ): void {
    this.bindRows(mx, my, [
      { sheet: this.shDialog, run: actions.onShowDetail },
      { sheet: this.shDelete, run: actions.onDelete },
    ]);
  }

  /**
   * Retail `CShopItemPopupDlg` (`CA.exe.c:54752..54848`):
   * `Shop/SelectBox` (`2` rows: `Shop/SelectBox_Dialog` + `Shop/SelectBox_DecoCancel` / `SelectBox_Deco`).
   */
  openShopCard(
    mx: number,
    my: number,
    previewing: boolean,
    actions: { onShowDetail: () => void; onTogglePreview: () => void },
  ): void {
    this.bindRows(mx, my, [
      { sheet: this.shDialog, run: actions.onShowDetail },
      { sheet: previewing ? this.shDecoCancel : this.shDeco, run: actions.onTogglePreview },
    ]);
  }

  private bindRows(
    mx: number,
    my: number,
    rows: { sheet: LoadedSheet | null; run: () => void }[],
  ): void {
    if (rows.length === 0) return;

    const boxH = rows.length === 1 ? 23 : rows.length === 2 ? 42 : 62;
    this.x = Math.max(4, Math.min(800 - 90, mx));
    this.y = Math.max(4, Math.min(600 - boxH - 4, my));
    this.buttons = rows.map((row, idx) => {
      const btn = new SpriteButton(this.x + 2, this.y + 3 + idx * 19, () => {
        this.active = false;
        row.run();
      });
      btn.bindSheet(row.sheet, 81, 15);
      return btn;
    });
    this.active = true;
  }

  close(): void {
    this.active = false;
  }

  private bounds(): Rect {
    const h = this.buttons.length <= 1 ? 23 : this.buttons.length === 2 ? 42 : 62;
    return { x: this.x, y: this.y, w: 86, h };
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): boolean {
    if (!this.active) return false;
    for (const b of this.buttons) b.onMouseMove(mx, my, sound);
    return pointInRect(mx, my, this.bounds());
  }

  onMouseDown(mx: number, my: number): boolean {
    if (!this.active) return false;
    for (const b of this.buttons) {
      if (b.onMouseDown(mx, my)) return true;
    }
    this.active = false;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (!this.active) return false;
    for (const b of this.buttons) {
      if (b.onMouseUp(mx, my, sound)) return true;
    }
    return pointInRect(mx, my, this.bounds());
  }

  render(r: SpriteRenderer): void {
    if (!this.active || this.buttons.length === 0) return;
    const bg =
      this.buttons.length === 1 ? this.bgSingle : this.buttons.length === 2 ? this.bgTwo : this.bgThree;
    drawSheetFrame(r, bg, 0, this.x, this.y);
    for (const b of this.buttons) b.render(r);
  }
}

export interface GlobalNavCallbacks {
  onBack: () => void;
  onShop: () => void;
  onMyItem: () => void;
  onMyInfo: () => void;
  onMessenger: () => void;
  onOption: () => void;
  onHelp: () => void;
  onExit: () => void;
}

/**
 * Retail `CGlobalButtonDlg` `(0, 566, 800, 34)` + `CGlobalButtonMenuDlg` `(0, 344, 109, 222)`
 * (`CA.exe.c` `L81075..81360`).
 *
 * Strictly renders ONLY the original `Fx:GlobalUI/*` sprites and coordinates:
 *   - `GlobalUI/Dlg_Back` `(0, 566, 800, 34)`
 *   - `BtMenu (18, 574)`, `BtBack (99, 574)`, `BtShop (136, 574)`, `BtMyitem (611, 574)`,
 *     `BtMyInfo (690, 574)`, `BtMessenger (720, 574)`, `BtExit (757, 574)`
 *   - `GlobalUI/Glob_ToolTip` hover tooltip (`dy = -18`) with `csysstr.ssd` strings
 *   - `GlobalUI/MenuDlg_Back` `(0, 344, 109, 222)`:
 *       `MenuBtShop (0, 344)`, `MenuBtMyItem (0, 377)`,
 *       `MenuBtText` + `MenuIcon` rows at `y = 344 + 64, 89, 114, 139, 168, 193`
 *       (MyInfo, Messenger, Option, Help, Back/Channel, Exit)
 */
export class GlobalButtonBar {
  private backSheet: LoadedSheet | null = null;
  private tipSheet: LoadedSheet | null = null;
  private menuBackSheet: LoadedSheet | null = null;
  private menuBtTextSheet: LoadedSheet | null = null;
  private menuIconSheet: LoadedSheet | null = null;
  private menuIconDisableSheet: LoadedSheet | null = null;
  private btMessengerArrvSheet: LoadedSheet | null = null;
  private speakerIconSheet: LoadedSheet | null = null;
  private menuOpen = false;

  readonly btMenu: SpriteButton;
  readonly btBack: SpriteButton;
  readonly btShop: SpriteButton;
  readonly btMyItem: SpriteButton;
  readonly btMyInfo: SpriteButton;
  readonly btMessenger: SpriteButton;
  readonly btExit: SpriteButton;

  private readonly menuBtShop: SpriteButton;
  private readonly menuBtMyItem: SpriteButton;
  private readonly menuRows: { y: number; iconIdx: number; labelKey: string; fallback: string; hovered: boolean; pressed: boolean; action: () => void }[] = [];

  private loaded = false;
  private assetsRef: GameAssets | null = null;
  private readonly cb: GlobalNavCallbacks;

  constructor(cb: GlobalNavCallbacks) {
    this.cb = cb;
    this.btMenu = new SpriteButton(18, 574, () => {
      this.menuOpen = !this.menuOpen;
    });
    this.btBack = new SpriteButton(99, 574, () => {
      this.menuOpen = false;
      this.cb.onBack();
    });
    this.btShop = new SpriteButton(136, 574, () => {
      this.menuOpen = false;
      this.cb.onShop();
    });
    this.btMyItem = new SpriteButton(611, 574, () => {
      this.menuOpen = false;
      this.cb.onMyItem();
    });
    this.btMyInfo = new SpriteButton(690, 574, () => {
      this.menuOpen = false;
      this.cb.onMyInfo();
    });
    this.btMessenger = new SpriteButton(720, 574, () => {
      this.menuOpen = false;
      this.cb.onMessenger();
    });
    this.btExit = new SpriteButton(757, 574, () => {
      this.menuOpen = false;
      this.cb.onExit();
    });

    this.menuBtShop = new SpriteButton(0, 344, () => {
      this.menuOpen = false;
      this.cb.onShop();
    });
    this.menuBtMyItem = new SpriteButton(0, 344 + 33, () => {
      this.menuOpen = false;
      this.cb.onMyItem();
    });

    const rowDefs: [number, number, string, string, () => void][] = [
      [64, 0, "GlobalUIMyInfo", "我的資料", () => this.cb.onMyInfo()],
      [89, 1, "GlobalUIMessenger", "傳訊系統", () => this.cb.onMessenger()],
      [114, 2, "GlobalUIOption", "選項", () => this.cb.onOption()],
      [139, 3, "GlobalUIHelp", "小幫手", () => this.cb.onHelp()],
      [168, 4, "GlobalUIBack", "退回", () => this.cb.onBack()],
      [193, 5, "GlobalUIExit", "離開", () => this.cb.onExit()],
    ];
    for (const [ry, iconIdx, labelKey, fallback, fn] of rowDefs) {
      this.menuRows.push({
        y: 344 + ry,
        iconIdx,
        labelKey,
        fallback,
        hovered: false,
        pressed: false,
        action: () => {
          this.menuOpen = false;
          fn();
        },
      });
    }
  }

  async load(assets: GameAssets): Promise<void> {
    this.assetsRef = assets;
    if (this.loaded) return;
    this.loaded = true;
    await assets.fx.prefetch([
      "GlobalUI/Dlg_Back",
      "GlobalUI/BtMenu",
      "GlobalUI/BtBack",
      "GlobalUI/BtShop",
      "GlobalUI/BtMyitem",
      "GlobalUI/BtMyInfo",
      "GlobalUI/BtMessenger",
      "GlobalUI/BtMessengerArrv",
      "GlobalUI/BtExit",
      "GlobalUI/Glob_ToolTip",
      "GlobalUI/MenuDlg_Back",
      "GlobalUI/MenuBtShop",
      "GlobalUI/MenuBtMyItem",
      "GlobalUI/MenuBtText",
      "GlobalUI/MenuIcon",
      "GlobalUI/MenuIconDisable",
      "Dialog/Icon_SMS",
    ]);
    const [bg, m, bk, sh, mi, inf, msg, msgArrv, ex, tip, mbg, msh, mmi, mtxt, mico, micoDis, smsIco] = await Promise.all([
      assets.loadSheet("Fx", "GlobalUI/Dlg_Back"),
      assets.loadSheet("Fx", "GlobalUI/BtMenu"),
      assets.loadSheet("Fx", "GlobalUI/BtBack"),
      assets.loadSheet("Fx", "GlobalUI/BtShop"),
      assets.loadSheet("Fx", "GlobalUI/BtMyitem"),
      assets.loadSheet("Fx", "GlobalUI/BtMyInfo"),
      assets.loadSheet("Fx", "GlobalUI/BtMessenger"),
      assets.loadSheet("Fx", "GlobalUI/BtMessengerArrv"),
      assets.loadSheet("Fx", "GlobalUI/BtExit"),
      assets.loadSheet("Fx", "GlobalUI/Glob_ToolTip"),
      assets.loadSheet("Fx", "GlobalUI/MenuDlg_Back"),
      assets.loadSheet("Fx", "GlobalUI/MenuBtShop"),
      assets.loadSheet("Fx", "GlobalUI/MenuBtMyItem"),
      assets.loadSheet("Fx", "GlobalUI/MenuBtText"),
      assets.loadSheet("Fx", "GlobalUI/MenuIcon"),
      assets.loadSheet("Fx", "GlobalUI/MenuIconDisable"),
      assets.loadSheet("Fx", "Dialog/Icon_SMS"),
    ]);
    this.backSheet = bg;
    this.tipSheet = tip;
    this.menuBackSheet = mbg;
    this.menuBtTextSheet = mtxt;
    this.menuIconSheet = mico;
    this.menuIconDisableSheet = micoDis;
    this.btMessengerArrvSheet = msgArrv;
    this.speakerIconSheet = smsIco;

    this.btMenu.bindSheet(m, 69, 22);
    this.btBack.bindSheet(bk, 25, 22);
    this.btBack.tooltip = sysStr(assets, "GlobalUIBack", "退回");
    this.btShop.bindSheet(sh, 69, 22);
    this.btShop.tooltip = sysStr(assets, "GBShop", "購物商場");
    this.btMyItem.bindSheet(mi, 69, 22);
    this.btMyInfo.bindSheet(inf, 25, 22);
    this.btMyInfo.tooltip = sysStr(assets, "GlobalUIMyInfo", "我的資料");
    this.btMessenger.bindSheet(msg, 25, 22);
    this.btMessenger.tooltip = sysStr(assets, "GlobalUIMessenger", "傳訊系統");
    this.btExit.bindSheet(ex, 25, 22);
    this.btExit.tooltip = sysStr(assets, "GlobalUIExit", "離開");

    this.menuBtShop.bindSheet(msh, 109, 33);
    this.menuBtMyItem.bindSheet(mmi, 109, 31);
  }

  private barButtons(): SpriteButton[] {
    return [this.btMenu, this.btBack, this.btShop, this.btMyItem, this.btMyInfo, this.btMessenger, this.btExit];
  }

  closeMenu(): void {
    this.menuOpen = false;
  }

  private isMenuRowEnabled(iconIdx: number): boolean {
    if (iconIdx === 0) return this.btMyInfo.enabled;
    if (iconIdx === 1) return this.btMessenger.enabled;
    if (iconIdx === 4) return this.btBack.enabled;
    if (iconIdx === 5) return this.btExit.enabled;
    return true;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    for (const b of this.barButtons()) b.onMouseMove(mx, my, sound);
    if (this.menuOpen) {
      this.menuBtShop.enabled = this.btShop.enabled;
      this.menuBtMyItem.enabled = this.btMyItem.enabled;
      this.menuBtShop.onMouseMove(mx, my, sound);
      this.menuBtMyItem.onMouseMove(mx, my, sound);
      for (const row of this.menuRows) {
        if (!this.isMenuRowEnabled(row.iconIdx)) {
          row.hovered = false;
          continue;
        }
        const hit = mx >= 0 && mx < 109 && my >= row.y && my < row.y + 25;
        if (hit && !row.hovered) sound.playSfx("MouseMove_0", 0.35);
        row.hovered = hit;
      }
    }
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.menuOpen) {
      this.menuBtShop.enabled = this.btShop.enabled;
      this.menuBtMyItem.enabled = this.btMyItem.enabled;
      if (this.menuBtShop.onMouseDown(mx, my) || this.menuBtMyItem.onMouseDown(mx, my)) return true;
      for (const row of this.menuRows) {
        if (mx >= 0 && mx < 109 && my >= row.y && my < row.y + 25) {
          if (this.isMenuRowEnabled(row.iconIdx)) row.pressed = true;
          return true;
        }
      }
      if (pointInRect(mx, my, { x: 0, y: 344, w: 109, h: 222 })) return true;
    }
    for (const b of this.barButtons()) {
      if (b.onMouseDown(mx, my)) return true;
    }
    if (this.menuOpen && my < 566) {
      this.menuOpen = false;
    }
    return my >= 566;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.menuOpen) {
      if (this.menuBtShop.onMouseUp(mx, my, sound) || this.menuBtMyItem.onMouseUp(mx, my, sound)) return true;
      for (const row of this.menuRows) {
        const was = row.pressed;
        row.pressed = false;
        if (was && this.isMenuRowEnabled(row.iconIdx) && mx >= 0 && mx < 109 && my >= row.y && my < row.y + 25) {
          sound.playSfx("ButtonDown_0", 0.65);
          row.action();
          return true;
        }
      }
    }
    for (const b of this.barButtons()) {
      if (b.onMouseUp(mx, my, sound)) return true;
    }
    return false;
  }

  render(r: SpriteRenderer, hub: ClientHub): void {
    drawSheetFrame(r, this.backSheet, 0, 0, 566);

    const unread = hub.sms.some((s) => !s.read);
    for (const b of this.barButtons()) {
      // Retail `CGlobalButtonDlg` (`CA.exe.c:129753`): `GlobalUI/BtMessengerArrv` (`25x22`, 5 frames)
      if (b === this.btMessenger && unread && b.enabled && this.btMessengerArrvSheet) {
        const arrvFrame = b.pressed ? 1 : b.hovered ? 2 : Math.floor(performance.now() / 350) % 2 === 0 ? 4 : 0;
        drawSheetFrame(r, this.btMessengerArrvSheet, arrvFrame, b.x, b.y);
      } else {
        b.render(r);
      }
    }
    if (unread && this.speakerIconSheet && Math.floor(performance.now() / 400) % 2 === 0) {
      drawSheetFrame(r, this.speakerIconSheet, 0, 724, 566);
    }

    // Retail `CGlobalButtonMenuDlg` (`CA.exe` `0x6144C0`, `(0, 344, 109, 222)`)
    if (this.menuOpen) {
      this.menuBtShop.enabled = this.btShop.enabled;
      this.menuBtMyItem.enabled = this.btMyItem.enabled;
      // `GlobalUI/MenuDlg_Back`: frame 2 = 109x2 body fill, frame 1 = 109x2 divider (at y=344+164..168), frame 3 = 109x4 bottom cap
      drawSheetFrame(r, this.menuBackSheet, 2, 0, 408, { w: 109, h: 154 });
      drawSheetFrame(r, this.menuBackSheet, 1, 0, 508, { w: 109, h: 4 });
      drawSheetFrame(r, this.menuBackSheet, 3, 0, 562, { w: 109, h: 4 });
      this.menuBtShop.render(r);
      this.menuBtMyItem.render(r);
      for (const row of this.menuRows) {
        const enabled = this.isMenuRowEnabled(row.iconIdx);
        const frame = !enabled ? 3 : row.pressed ? 1 : row.hovered ? 2 : 0;
        drawSheetFrame(r, this.menuBtTextSheet, frame, 0, row.y);
        // Retail `CA.exe.c:36257..36275`: `GlobalUI/MenuIcon` vs `GlobalUI/MenuIconDisable` + dimmed RGB(0x24,0x69,0xC5)
        drawSheetFrame(r, enabled ? this.menuIconSheet : (this.menuIconDisableSheet ?? this.menuIconSheet), row.iconIdx, 18, row.y + 6);
        const label = this.assetsRef ? sysStr(this.assetsRef, row.labelKey, row.fallback) : row.fallback;
        if (enabled) {
          r.drawText(label, 43, row.y + 7, { color: [0, 0.13, 0.29, 1] });
        } else {
          r.drawText(label, 43, row.y + 7, {
            color: [0x24 / 255, 0x69 / 255, 0xc5 / 255, 1],
            outlineColor: [0, 0x21 / 255, 0x4b / 255, 1],
          });
        }
      }
    }

    // Retail `GlobalUI/Glob_ToolTip` hover tooltip (`dy = -18`)
    for (const b of this.barButtons()) {
      if (b.hovered && b.tooltip) {
        drawGlobToolTip(r, this.tipSheet, b.tooltip, b.x + b.w * 0.5, b.y);
        break;
      }
    }
  }
}

// ─── Retail `CWhisperLogWnd` (`CA.exe.c:218180..218310`, `0x615510/615930/615B20/617DC0`) ──
// Dropdown whisper target selector using `Fx:WhisperLog/BtWhisperLogArrow` (`27x24`)
// and `Fx:WhisperLog/BtWhisperLogTop|Middle|Bottom` (`111x21|20|22`, frame 3 = hover).

export class SpriteWhisperLog {
  readonly x: number;
  readonly y: number;
  readonly popupX: number;
  readonly popupBaseY: number;
  private readonly onSelect: (target: string) => void;
  private readonly btArrow: SpriteButton;
  private topSheet: LoadedSheet | null = null;
  private midSheet: LoadedSheet | null = null;
  private botSheet: LoadedSheet | null = null;
  open = false;
  private hoverIdx = -1;
  private pressIdx = -1;
  private entries: { label: string; value: string }[] = [];

  constructor(
    x: number,
    y: number,
    onSelect: (target: string) => void,
    opts?: { popupX?: number; popupBaseY?: number },
  ) {
    this.x = x;
    this.y = y;
    // Retail `CA.exe` `0x615510/615930/615B20/617DC0`: popup `x = edWhisper.x - 9 = btArrow.x - 83`, bottom item `y = btArrow.y - 22` (`507` or `506`)
    this.popupX = opts?.popupX ?? (x - 83);
    this.popupBaseY = opts?.popupBaseY ?? (y - 22);
    this.onSelect = onSelect;
    this.btArrow = new SpriteButton(x, y, () => {
      this.open = !this.open;
    });
  }

  async load(assets: GameAssets): Promise<void> {
    const [arrow, top, mid, bot] = await Promise.all([
      assets.loadSheet("Fx", "WhisperLog/BtWhisperLogArrow"),
      assets.loadSheet("Fx", "WhisperLog/BtWhisperLogTop"),
      assets.loadSheet("Fx", "WhisperLog/BtWhisperLogMiddle"),
      assets.loadSheet("Fx", "WhisperLog/BtWhisperLogBottom"),
    ]);
    this.btArrow.bindSheet(arrow, 27, 24);
    this.topSheet = top;
    this.midSheet = mid;
    this.botSheet = bot;
  }

  private syncEntries(hub: ClientHub, extraCandidates: string[] = []): void {
    const seen = new Set<string>();
    const list: { label: string; value: string }[] = [{ label: "全部對話 (公開)", value: "" }];
    const pushName = (raw: string) => {
      const clean = raw.trim();
      if (!clean || clean === hub.profile?.username || clean === hub.profile?.nickname) return;
      const key = clean.toLowerCase();
      if (seen.has(key) || list.length >= 7) return;
      seen.add(key);
      list.push({ label: clean, value: clean });
    };
    for (const w of hub.recentWhispers) pushName(w);
    for (const f of hub.friends) {
      if (f.online) pushName(f.username);
    }
    for (const c of extraCandidates) pushName(c);
    this.entries = list;
  }

  private menuMetrics(): { popupX: number; popupY: number; rowYs: number[]; rowHs: number[]; totalH: number } {
    const n = Math.max(2, this.entries.length);
    const rowHs: number[] = [];
    for (let i = 0; i < n; i++) {
      rowHs.push(i === 0 ? 21 : i === n - 1 ? 22 : 20);
    }
    const popupX = this.popupX;
    // Retail `CWhisperLogWnd` stacks items upward at `popupBaseY - 20 * k` (topmost row at `popupBaseY - 20 * (n - 1) - 1`)
    const popupY = this.popupBaseY - 20 * (n - 1);
    const rowYs: number[] = [];
    let cy = popupY;
    for (let i = 0; i < n; i++) {
      rowYs.push(cy);
      cy += 20;
    }
    const totalH = (n - 1) * 20 + 22;
    return { popupX, popupY, rowYs, rowHs, totalH };
  }

  onMouseMove(mx: number, my: number, hub: ClientHub, extraCandidates: string[] = []): void {
    this.btArrow.onMouseMove(mx, my);
    if (!this.open) {
      this.hoverIdx = -1;
      return;
    }
    this.syncEntries(hub, extraCandidates);
    const m = this.menuMetrics();
    this.hoverIdx = -1;
    if (mx >= m.popupX && mx < m.popupX + 111) {
      for (let i = 0; i < m.rowYs.length; i++) {
        if (my >= m.rowYs[i]! && my < m.rowYs[i]! + m.rowHs[i]!) {
          this.hoverIdx = i;
          break;
        }
      }
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager, hub: ClientHub, extraCandidates: string[] = []): boolean {
    if (this.btArrow.onMouseDown(mx, my)) {
      if (!this.open) this.syncEntries(hub, extraCandidates);
      return true;
    }
    if (!this.open) return false;
    this.syncEntries(hub, extraCandidates);
    const m = this.menuMetrics();
    if (mx >= m.popupX && mx < m.popupX + 111 && my >= m.popupY && my < m.popupY + m.totalH) {
      for (let i = 0; i < m.rowYs.length; i++) {
        if (my >= m.rowYs[i]! && my < m.rowYs[i]! + m.rowHs[i]!) {
          this.pressIdx = i;
          sound.playSfx("ButtonDown_0", 0.55);
          return true;
        }
      }
    }
    this.open = false;
    this.pressIdx = -1;
    return false;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager, hub: ClientHub, extraCandidates: string[] = []): boolean {
    if (this.btArrow.onMouseUp(mx, my, sound)) {
      if (this.open) this.syncEntries(hub, extraCandidates);
      return true;
    }
    if (!this.open) return false;
    const was = this.pressIdx;
    this.pressIdx = -1;
    if (was >= 0) {
      this.syncEntries(hub, extraCandidates);
      const m = this.menuMetrics();
      if (
        mx >= m.popupX &&
        mx < m.popupX + 111 &&
        was < m.rowYs.length &&
        my >= m.rowYs[was]! &&
        my < m.rowYs[was]! + m.rowHs[was]!
      ) {
        const chosen = this.entries[was];
        this.open = false;
        if (chosen) this.onSelect(chosen.value);
        return true;
      }
    }
    return false;
  }

  render(r: SpriteRenderer, hub: ClientHub, extraCandidates: string[] = []): void {
    this.btArrow.render(r);
    if (!this.open) return;
    this.syncEntries(hub, extraCandidates);
    const n = Math.max(2, this.entries.length);
    const m = this.menuMetrics();
    for (let i = 0; i < n; i++) {
      const sheet = i === 0 ? this.topSheet : i === n - 1 ? this.botSheet : this.midSheet;
      // In `BtWhisperLogTop/Middle/Bottom` (`n = 4`), frame 3 is the highlighted/hover row!
      const frame = this.pressIdx === i || this.hoverIdx === i ? 3 : 0;
      drawSheetFrame(r, sheet, frame, m.popupX, m.rowYs[i]!);
      const entry = this.entries[i];
      if (entry) {
        r.drawText(entry.label, m.popupX + 8, m.rowYs[i]! + 4, {
          color: this.hoverIdx === i ? [1, 1, 0.75, 1] : i === 0 ? [0.1, 0.25, 0.52, 1] : [0.06, 0.28, 0.14, 1],
          maxWidth: 96,
        });
      }
    }
  }
}

// ─── Retail `CGOItemBox` (`CA.exe.c:26747..27130`, PE `0x614088`) ────────────
// 5x5 translucent Emotion/Item radial wheel (`Fx:Etc/ItemBox` `110x110` at alpha `128/255`
// + `Fx:Etc/ItemBoxCursor` `20x20`), opened while holding `Alt` over the player's Bomber!

export const ITEM_BOX_RING_25: readonly number[] = [
  11, 10, 4, 14, 15,
  9, 8, 0, 12, 13,
  5, 1, -1, 3, 7,
  17, 16, 2, 20, 21,
  19, 18, 6, 22, 23,
];

export interface ItemBoxEntry {
  readonly pose: number;
  readonly stockId?: number;
  readonly label: string;
}

const DEFAULT_EMOTION_ENTRIES: readonly ItemBoxEntry[] = [
  { pose: 3, label: "打招呼" },
  { pose: 4, label: "大哭" },
  { pose: 5, label: "生氣" },
  { pose: 6, label: "跳舞" },
  { pose: 7, label: "坐下" },
  { pose: 8, label: "睡覺" },
  { pose: 9, label: "驚訝" },
  { pose: 10, label: "愛心" },
];

export class SpriteItemBoxWheel {
  private boxSheet: LoadedSheet | null = null;
  private cursorSheet: LoadedSheet | null = null;
  open = false;
  curX = 0; // -2..+2
  curY = 0; // -2..+2
  private lastAnchorX = 400;
  private lastAnchorY = 300;
  private readonly cache: CharacterPreviewCache;
  private readonly onTrigger: (entry: ItemBoxEntry) => void;

  constructor(cache: CharacterPreviewCache, onTrigger: (entry: ItemBoxEntry) => void) {
    this.cache = cache;
    this.onTrigger = onTrigger;
  }

  async load(assets: GameAssets): Promise<void> {
    const [bx, cur] = await Promise.all([
      assets.loadSheet("Fx", "Etc/ItemBox"),
      assets.loadSheet("Fx", "Etc/ItemBoxCursor"),
    ]);
    this.boxSheet = bx;
    this.cursorSheet = cur;
  }

  entries(assets: GameAssets, hub: ClientHub): ItemBoxEntry[] {
    const out: ItemBoxEntry[] = [];
    const seenStock = new Set<number>();
    for (const inv of hub.inventory) {
      if (inv.category !== 3 || seenStock.has(inv.stockId)) continue;
      seenStock.add(inv.stockId);
      const stock = assets.tables?.stockById.get(inv.stockId);
      out.push({
        pose: 3 + (out.length % 8),
        stockId: inv.stockId,
        label: stock?.name || `表情#${inv.stockId}`,
      });
      if (out.length >= 24) return out;
    }
    for (const def of DEFAULT_EMOTION_ENTRIES) {
      if (out.length >= 24) break;
      out.push(def);
    }
    return out;
  }

  selectedSlotIndex(): number {
    const idx = (this.curY + 2) * 5 + (this.curX + 2);
    return ITEM_BOX_RING_25[idx] ?? -1;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Alt") {
      if (!this.open) {
        this.open = true;
        this.curX = 0;
        this.curY = 0;
      }
      return true;
    }
    if (!this.open) return false;
    if (e.key === "ArrowLeft") {
      this.curX = Math.max(-2, this.curX - 1);
      return true;
    }
    if (e.key === "ArrowRight") {
      this.curX = Math.min(2, this.curX + 1);
      return true;
    }
    if (e.key === "ArrowUp") {
      this.curY = Math.max(-2, this.curY - 1);
      return true;
    }
    if (e.key === "ArrowDown") {
      this.curY = Math.min(2, this.curY + 1);
      return true;
    }
    if (e.key === "Escape") {
      this.open = false;
      return true;
    }
    return false;
  }

  onKeyUp(e: KeyboardEvent, assets: GameAssets, hub: ClientHub): boolean {
    if (e.key === "Alt" && this.open) {
      const slot = this.selectedSlotIndex();
      this.open = false;
      if (slot >= 0) {
        const chosen = this.entries(assets, hub)[slot];
        if (chosen) this.onTrigger(chosen);
      }
      return true;
    }
    return false;
  }

  onMouseMove(mx: number, my: number): boolean {
    if (!this.open) return false;
    const gx = this.lastAnchorX - 30;
    const gy = this.lastAnchorY - 43;
    if (mx >= gx && mx < gx + 100 && my >= gy && my < gy + 100) {
      this.curX = Math.max(-2, Math.min(2, Math.floor((mx - gx) / 20) - 2));
      this.curY = Math.max(-2, Math.min(2, Math.floor((my - gy) / 20) - 2));
      return true;
    }
    return false;
  }

  onMouseDown(mx: number, my: number, assets: GameAssets, hub: ClientHub): boolean {
    if (!this.open) return false;
    const gx = this.lastAnchorX - 30;
    const gy = this.lastAnchorY - 43;
    if (mx >= gx && mx < gx + 100 && my >= gy && my < gy + 100) {
      this.curX = Math.max(-2, Math.min(2, Math.floor((mx - gx) / 20) - 2));
      this.curY = Math.max(-2, Math.min(2, Math.floor((my - gy) / 20) - 2));
      const slot = this.selectedSlotIndex();
      this.open = false;
      if (slot >= 0) {
        const chosen = this.entries(assets, hub)[slot];
        if (chosen) this.onTrigger(chosen);
      }
      return true;
    }
    this.open = false;
    return false;
  }

  render(r: SpriteRenderer, assets: GameAssets, hub: ClientHub, anchorX: number, anchorY: number, frameVariant = 0): void {
    if (!this.open) return;
    const clampedX = Math.max(40, Math.min(720, Math.round(anchorX)));
    const clampedY = Math.max(55, Math.min(510, Math.round(anchorY)));
    this.lastAnchorX = clampedX;
    this.lastAnchorY = clampedY;

    // Exact `CA.exe.c:27029`: `sub_56EA90(v33, clampedX - 35, clampedY - 48, ItemBox, variant, 128)`
    drawSheetFrame(r, this.boxSheet, frameVariant, clampedX - 35, clampedY - 48, {
      tint: [1, 1, 1, 128 / 255],
    });

    const list = this.entries(assets, hub);
    const gx = clampedX - 30;
    const gy = clampedY - 43;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const slot = ITEM_BOX_RING_25[row * 5 + col]!;
        if (slot < 0 || slot >= list.length) continue;
        const item = list[slot]!;
        const cx = gx + col * 20;
        const cy = gy + row * 20;
        if (item.stockId !== undefined) {
          const stock = assets.tables?.stockById.get(item.stockId);
          this.cache.drawStockIcon(r, assets, stock, cx + 10, cy + 10, 18, 18);
        } else {
          r.drawText(item.label.slice(0, 1), cx + 10, cy + 4, {
            align: "center",
            color: [1, 0.96, 0.72, 1],
            outlineColor: [0.06, 0.14, 0.34, 1],
          });
        }
      }
    }

    // Exact `CA.exe.c:27115`: `Etc/ItemBoxCursor` (`20x20`, 2 frames) at `(gx + (curX+2)*20, gy + (curY+2)*20)`
    const curFrame = Math.floor(performance.now() / 220) % 2;
    drawSheetFrame(r, this.cursorSheet, curFrame, gx + (this.curX + 2) * 20, gy + (this.curY + 2) * 20);

    const activeSlot = this.selectedSlotIndex();
    const activeItem = activeSlot >= 0 ? list[activeSlot] : undefined;
    if (activeItem) {
      r.drawText(activeItem.label, clampedX + 20, gy - 14, {
        align: "center",
        color: [1, 0.98, 0.78, 1],
        outlineColor: [0.05, 0.12, 0.3, 1],
      });
    }
  }
}

/**
 * Exact `CA.exe.c:100064..100157` & `104224..104245` `Fx:Game/Kill_Image` mode emblem frame:
 *   - `mode === 0` (`Basic` 一般對戰): `null` (no mode badge drawn)
 *   - `mode === 4` (`KillCount` 搶分賽): frame `37` (`22x22`)
 *   - `mode === 1` (`King` 王者戰): frame `38` (`22x22`)
 *   - `mode === 3` (`Hedgehog` 刺蝟賽): frame `36` (`22x22`)
 *   - `mode === 2` (`Timebomb` 定時炸彈): frame `39` (`22x22`)
 */
export function gameKillModeIconFrame(mode: number): number | null {
  switch (mode) {
    case 4:
      return 37;
    case 1:
      return 38;
    case 3:
      return 36;
    case 2:
      return 39;
    default:
      return null;
  }
}

export interface SlashCommandHooks {
  onOpenUserInfo?: (username?: string) => void;
  onSetWhisperTarget?: (target: string) => void;
  onOpenShout?: (prefill?: string) => void;
  onOpenWebNotice?: () => void;
  onOpenMultiServer?: () => void;
}

/**
 * Authentic `CChatStage` client-side slash command dispatcher (`CA.exe.c:74724..75240`):
 *   - `/who <id>`, `/userinfo <id>` -> opens `UserInfoDlg` for `<id>`
 *   - `/whoami`                     -> opens `UserInfoDlg` for local player
 *   - `/ar`, `/autoready`           -> toggles Auto-Ready (`TurnOnAutoReady` / `TurnOffAutoReady`)
 *   - `/msn`                        -> toggles MSN buddy alerts (`TurnOnMSN` / `TurnOffMSN`)
 *   - `/m <id>` / `/u <id>`         -> adds/removes `<id>` in whisper refusal list (`IgnoreUserMsg`)
 *   - `/mute` / `/unmute`           -> toggles refuse-all whispers
 *   - `/w off` / `/w <id>`          -> clears or focuses whisper target box
 *   - `/qhfk [msg]`                 -> opens Loudspeaker `ShoutDlg`
 * Returns `true` if handled locally (caller should NOT send `chat_send`), `false` otherwise
 * (so server-side `/w <id> <msg>`, `/where <id>`, `/bot`, `/nobot`, `/kickoff <id>` pass through).
 */
export function handleRetailSlashCommand(
  rawInput: string,
  assets: GameAssets,
  hub: ClientHub,
  hooks: SlashCommandHooks = {},
): boolean {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("/")) return false;

  const pushSys = (text: string) => {
    hub.chatLog.push({
      kind: "system",
      from: "系統",
      text,
      timeMs: Date.now(),
    });
    if (hub.chatLog.length > 100) hub.chatLog.shift();
  };

  if (/^\/whoami$/i.test(trimmed)) {
    hooks.onOpenUserInfo?.(undefined);
    return true;
  }
  if (/^\/(notice|bbs|event)$/i.test(trimmed)) {
    if (hooks.onOpenWebNotice) {
      hooks.onOpenWebNotice();
      return true;
    }
  }
  if (/^\/(server|realm|multiserver)$/i.test(trimmed)) {
    if (hooks.onOpenMultiServer) {
      hooks.onOpenMultiServer();
      return true;
    }
  }
  if (/^\/(who|userinfo)\s+/i.test(trimmed)) {
    const target = trimmed.replace(/^\/(who|userinfo)\s+/i, "").trim();
    if (target) hooks.onOpenUserInfo?.(target);
    return true;
  }
  if (/^\/(ar|autoready)$/i.test(trimmed)) {
    hub.autoReady = !hub.autoReady;
    hub.savePrefs();
    const msg = hub.autoReady
      ? sysStr(assets, "TurnOnAutoReady", "已開啟自動準備 (Auto-Ready ON)。")
      : sysStr(assets, "TurnOffAutoReady", "已關閉自動準備 (Auto-Ready OFF)。");
    pushSys(msg);
    return true;
  }
  if (/^\/msn$/i.test(trimmed)) {
    if (hub.onOpenMessenger) {
      hub.onOpenMessenger();
      return true;
    }
    hub.msnEnabled = !hub.msnEnabled;
    hub.savePrefs();
    const msg = hub.msnEnabled
      ? sysStr(assets, "TurnOnMSN", "已開啟即時好友通知 (MSN ON)。")
      : sysStr(assets, "TurnOffMSN", "已關閉即時好友通知 (MSN OFF)。");
    pushSys(msg);
    return true;
  }
  if (/^\/mute$/i.test(trimmed)) {
    hub.refuseAllWhispers = true;
    pushSys("已開啟拒收所有密語。");
    return true;
  }
  if (/^\/unmute$/i.test(trimmed)) {
    hub.refuseAllWhispers = false;
    pushSys("已解除拒收所有密語。");
    return true;
  }
  if (/^\/m\s+/i.test(trimmed)) {
    const target = trimmed.slice(3).trim();
    if (!target) return true;
    if (hub.profile && target.toLowerCase() === hub.profile.username.toLowerCase()) {
      pushSys(sysStr(assets, "CanBeIgnored", "無法將自己加入拒收名單。"));
    } else if (hub.refusalList.has(target)) {
      pushSys(sysStr(assets, "AlreadyIgnoredUser", `「${target}」已在拒收密語名單中。`));
    } else if (hub.addRefusal(target)) {
      pushSys(sysStr(assets, "IgnoreUserMsg", `已將「${target}」加入拒收密語名單。`));
    }
    return true;
  }
  if (/^\/u\s+/i.test(trimmed)) {
    const target = trimmed.slice(3).trim();
    if (target) {
      hub.removeRefusal(target);
      pushSys(`已從拒收密語名單移除「${target}」。`);
    }
    return true;
  }
  if (/^\/(w|to|whisper)\s+/i.test(trimmed)) {
    const isTo = /^\/to\s+/i.test(trimmed);
    const rest = trimmed.replace(/^\/(w|to|whisper)\s+/i, "").trim();
    const parts = rest.split(/\s+/);
    if (parts.length === 1) {
      const tok = parts[0]!;
      if (tok.toLowerCase() === "off") {
        hub.teamChatOnly = false;
        hooks.onSetWhisperTarget?.("");
        pushSys("已解除密語／隊伍對話目標。");
      } else if (isTo && tok.toLowerCase() === "a") {
        hub.teamChatOnly = true;
        hooks.onSetWhisperTarget?.("a");
        pushSys("已切換為隊伍對話模式 (/to off 解除)。");
      } else {
        hub.teamChatOnly = false;
        hooks.onSetWhisperTarget?.(tok);
      }
      return true;
    }
    // 2+ tokens -> let `server/gateway.ts` handle `/w <target> <body>` or `/to a <body>`!
    return false;
  }
  if (/^\/qhfk(\s+.*)?$/i.test(trimmed)) {
    const prefill = trimmed.slice(5).trim();
    hooks.onOpenShout?.(prefill);
    return true;
  }
  return false;
}
