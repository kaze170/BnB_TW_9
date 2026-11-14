// Stage 3: `CCreditStage` (`src/stage/credit.ts`, `CA.exe.c:79905..80275`).
// Strictly follows `CA.exe` `CCreditStage`:
//   - `Fx:StageCredit/CAStage` (`800x600` JPEG)
//   - Viewport clip `aT` (`0x6155D4`): `(84, 153, 630, 350)`
//   - Initial `scrollY = 300`, `16 px` line stride, `1 px / 30 ms` step (`BtREW=-3`, `BtPlay=+1`, `BtPause=0`, `BtFF=+3`),
//     clamped to `[300 - 16 * lineCount, 10]`
//   - `!idx` `Fx:StageCredit/CreditImg` at `(84 + 90, 153 + y)`
//   - `Role : Name` split at `:`: prefix in `#ChangeColor` (default `#FFFF00`) with `#003E70` outline at `x=84`,
//     name suffix in `#FFFFFF` at `x = 84 + 6 * (colonIdx + 1)`
//   - `BtREW (330, 535)`, `BtPlay`/`BtPause (378, 535)`, `BtFF (426, 535)`, `BtExit (660, 568)`

import type { LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { SpriteButton, drawSheetFrame } from "../ui/widgets.ts";
import type { AppContext, Stage } from "./types.ts";

interface CreditLine {
  kind: "text" | "logo";
  text: string;
  logoIdx: number;
  color: readonly [number, number, number, number];
}

const CREDIT_WHITE: readonly [number, number, number, number] = [1, 1, 1, 1];
const CREDIT_NAVY_OUTLINE: readonly [number, number, number, number] = [0, 62 / 255, 112 / 255, 1];

export class CreditStage implements Stage {
  readonly id = "credit" as const;
  private bg: LoadedSheet | null = null;
  private logos: LoadedSheet | null = null;
  private lines: CreditLine[] = [];
  private scrollY = 300;
  private stepAccumMs = 0;
  private rate = 1; // +1 play, 0 pause, -3 rew, +3 ff (`*(this + 2344)`)

  private readonly btRew: SpriteButton;
  private readonly btPlay: SpriteButton;
  private readonly btPause: SpriteButton;
  private readonly btFF: SpriteButton;
  private readonly btExit: SpriteButton;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.btRew = new SpriteButton(330, 535, () => {
      this.rate = -3;
    });
    this.btPlay = new SpriteButton(378, 535, () => {
      this.rate = 1;
    });
    this.btPause = new SpriteButton(378, 535, () => {
      this.rate = 0;
    });
    this.btFF = new SpriteButton(426, 535, () => {
      this.rate = 3;
    });
    this.btExit = new SpriteButton(660, 568, () => {
      void this.ctx.goto("login");
    });
  }

  async enter(): Promise<void> {
    this.scrollY = 300;
    this.stepAccumMs = 0;
    this.rate = 1;

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      await assets.fx.prefetch([
        "StageCredit/CAStage",
        "StageCredit/Credit",
        "StageCredit/CreditImg",
        "StageCredit/BtPlay",
        "StageCredit/BtPause",
        "StageCredit/BtFF",
        "StageCredit/BtREW",
        "StageCredit/BtExit",
      ]);
      const [bg, lg, pl, pa, ff, rw, ex, rawCred] = await Promise.all([
        assets.loadSheet("Fx", "StageCredit/CAStage"),
        assets.loadSheet("Fx", "StageCredit/CreditImg"),
        assets.loadSheet("Fx", "StageCredit/BtPlay"),
        assets.loadSheet("Fx", "StageCredit/BtPause"),
        assets.loadSheet("Fx", "StageCredit/BtFF"),
        assets.loadSheet("Fx", "StageCredit/BtREW"),
        assets.loadSheet("Fx", "StageCredit/BtExit"),
        assets.fx.getPayload("StageCredit/Credit"),
      ]);
      this.bg = bg;
      this.logos = lg;
      this.btPlay.bindSheet(pl, 43, 24);
      this.btPause.bindSheet(pa, 43, 24);
      this.btFF.bindSheet(ff, 43, 24);
      this.btRew.bindSheet(rw, 43, 24);
      this.btExit.bindSheet(ex, 92, 23);

      if (rawCred) {
        let text = "";
        try {
          text = new TextDecoder("euc-kr").decode(rawCred);
        } catch {
          text = new TextDecoder("utf-8").decode(rawCred);
        }
        // `CA.exe.c:80200`: initial `this[579]` = `rgb(255, 255, 0)`
        let col: readonly [number, number, number, number] = [1, 1, 0, 1];
        for (const rawLine of text.split(/\r?\n/)) {
          if (rawLine.startsWith("#ChangeColor ")) {
            const v = Number(rawLine.slice(13).trim() || "16776960");
            col = [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, 1];
            continue;
          }
          const bangIdx = rawLine.indexOf("!");
          if (bangIdx >= 0 && /^\s*!\d+/.test(rawLine)) {
            const idx = parseInt(rawLine.slice(bangIdx + 1), 10) || 0;
            this.lines.push({ kind: "logo", text: "", logoIdx: idx, color: col });
          } else {
            this.lines.push({
              kind: "text",
              text: rawLine.replace(/\t/g, "    "),
              logoIdx: 0,
              color: col,
            });
          }
        }
      }
    }
  }

  tick(dtSec: number): void {
    const paused = this.rate === 0;
    this.btPlay.visible = paused;
    this.btPause.visible = !paused;
    if (this.rate !== 0) {
      const intervalMs = 30 / Math.abs(this.rate);
      this.stepAccumMs += dtSec * 1000;
      const minY = 300 - 16 * this.lines.length;
      while (this.stepAccumMs >= intervalMs) {
        this.stepAccumMs -= intervalMs;
        this.scrollY -= this.rate > 0 ? 1 : -1;
        if (this.scrollY > 10) this.scrollY = 10;
        if (this.scrollY < minY) this.scrollY = minY;
      }
    } else {
      this.stepAccumMs = 0;
    }
  }

  private activeButtons(): SpriteButton[] {
    const paused = this.rate === 0;
    return [this.btRew, paused ? this.btPlay : this.btPause, this.btFF, this.btExit];
  }

  onMouseMove(mx: number, my: number): void {
    for (const b of this.activeButtons()) b.onMouseMove(mx, my, this.ctx.sound);
  }

  onMouseDown(mx: number, my: number): void {
    for (const b of this.activeButtons()) {
      if (b.onMouseDown(mx, my)) return;
    }
  }

  onMouseUp(mx: number, my: number): void {
    for (const b of this.activeButtons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") void this.ctx.goto("login");
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, 0, 0, { w: 800, h: 600 });

    // Exact `CA.exe` `aT` clip rect `(84, 153, 630, 350)` (`0x6155D4..0x6155E0`)
    const vx = 84;
    const vy = 153;
    r.pushClip(vx, vy, 630, 350);
    for (let i = 0; i < this.lines.length; i++) {
      const relY = Math.round(this.scrollY + i * 16);
      if (relY < -16 || relY > 350) continue;
      const ln = this.lines[i]!;
      if (ln.kind === "logo" && this.logos) {
        drawSheetFrame(r, this.logos, ln.logoIdx, vx + 90, vy + relY);
      } else if (ln.text.length > 0) {
        const colonIdx = ln.text.indexOf(":");
        if (colonIdx < 0) {
          r.drawText(ln.text, vx, vy + relY, {
            color: CREDIT_WHITE,
            outlineColor: [0, 0, 0, 0.85],
          });
        } else {
          const rolePart = ln.text.slice(0, colonIdx + 1);
          const namePart = ln.text.slice(colonIdx + 1);
          r.drawText(rolePart, vx, vy + relY, {
            color: ln.color,
            outlineColor: CREDIT_NAVY_OUTLINE,
          });
          if (namePart.trim().length > 0) {
            r.drawText(namePart, vx + 6 * (colonIdx + 1), vy + relY, {
              color: CREDIT_WHITE,
              outlineColor: [0, 0, 0, 0.85],
            });
          }
        }
      }
    }
    r.popClip();

    for (const b of this.activeButtons()) b.render(r);
  }
}
