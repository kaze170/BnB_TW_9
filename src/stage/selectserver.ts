/**
 * Server select stage — CSelectServerStage.
 *
 * The art is `MultiServer/CAStage`, a 510x496 JPEG stored in Cx.idd: the
 * "SELECT SERVER" panel with its list box, the two arrow buttons and the grey
 * explanation field.  Its companion sprites are in the same pack
 * (`MultiServer/BtJoin`, `BtExit`, `BtUp`, `BtDown`, `Icon`), which is what the
 * executable's string table pairs it with at 0x5CE5F0..0x5CE654.
 *
 * The rows are the realms from src/data/serverlist.ts: the two endpoints in
 * multisvr.ssd plus the four addresses CMultiServer's constructor bakes in.
 *
 * Measured off the decoded JPEG (re-measured by tools/render-server.ts):
 *   panel        510x496, placed at (145, 52) on the 800x600 screen
 *   list column  x 59..449 (interior), first row y 143, 23px rows, 6 visible
 *   info field   x 55..452, y 331..390
 *   arrow keys   at (215, 283) and (250, 283), from the art
 */

import type { DrawQuad, SpriteRenderer } from '../gfx/renderer.ts';
import { drawText } from '../ui/text.ts';

export const SCREEN_W = 800;
export const SCREEN_H = 600;

/** Where the 510x496 panel sits on the 800x600 screen. */
export const PANEL = { x: 145, y: 52, w: 510, h: 496 } as const;
/** List geometry, in panel-local coordinates. */
export const SROW = { x: 59, y: 143, w: 390, rowH: 23, rows: 6 } as const;
/** Grey explanation field, panel-local. */
export const INFO = { x: 55, y: 331, w: 397, h: 59 } as const;
/** The two arrow buttons under the list, panel-local. */
export const ARROW = { y: 283, w: 34, h: 18, x: [215, 250] as const };

export interface RealmRow {
  address: string;
  port: number;
  /** label shown in the list */
  label: string;
}

export class SelectServerStage {
  private readonly renderer: SpriteRenderer;
  private texture: GPUTexture | null = null;
  private rows: RealmRow[] = [];
  private selected = 0;
  private scroll = 0;
  private onPick: ((row: RealmRow) => void) | null = null;
  private onBack: (() => void) | null = null;
  /** mirrors CMultiServer's list: the client keeps its own entry too */
  private builtin = 0;

  constructor(renderer: SpriteRenderer) {
    this.renderer = renderer;
  }

  setBackground(bitmap: ImageBitmap): void {
    this.texture = this.renderer.createTexture(bitmap);
  }

  setRows(rows: RealmRow[], preferIndex = 0): void {
    this.rows = rows.slice();
    this.selected = Math.min(Math.max(preferIndex, 0), Math.max(0, rows.length - 1));
    this.scroll = 0;
  }

  setHandlers(onPick: (row: RealmRow) => void, onBack: () => void): void {
    this.onPick = onPick;
    this.onBack = onBack;
  }

  render(): void {
    const r = this.renderer;
    r.begin();
    if (this.texture) {
      r.draw({
        texture: this.texture,
        sx: 0,
        sy: 0,
        sw: PANEL.w,
        sh: PANEL.h,
        dx: PANEL.x,
        dy: PANEL.y,
        dw: PANEL.w,
        dh: PANEL.h,
      } satisfies DrawQuad);
    }
    r.end();
  }

  renderOverlay(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < SROW.rows; i++) {
      const index = this.scroll + i;
      const row = this.rows[index];
      if (!row) break;
      const x = PANEL.x + SROW.x;
      const y = PANEL.y + SROW.y + i * SROW.rowH;
      if (index === this.selected) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, SROW.w, SROW.rowH - 1);
        ctx.restore();
      }
      drawText(ctx, row.label, x + 4, y + 5, { size: 12, colour: '#ffffff' });
      // The panel's right-hand column carries the port; the address is already
      // the label, so repeating it there would say the same thing twice.
      drawText(ctx, `:${row.port}`, x + SROW.w - 4, y + 5, { size: 11, colour: '#cfe6ff', align: 'right' });
    }

    // The grey field explains the highlighted realm; the executable's own
    // caption for this stage is the plain address+port pair.
    const row = this.rows[this.selected];
    if (row) {
      drawText(ctx, row.address, PANEL.x + INFO.x + 6, PANEL.y + INFO.y + 8, { size: 12, colour: '#ffffff' });
      drawText(ctx, `port ${row.port}`, PANEL.x + INFO.x + 6, PANEL.y + INFO.y + 26, {
        size: 12,
        colour: '#d8d8d8',
      });
    }
    if (this.rows.length === 0) {
      drawText(ctx, 'no realms', PANEL.x + SROW.x + 4, PANEL.y + SROW.y + 5, {
        size: 12,
        colour: '#cfe6ff',
      });
    }
    void this.builtin;
  }

  private hitRow(x: number, y: number): number {
    const lx = x - PANEL.x;
    const ly = y - PANEL.y;
    if (lx < SROW.x || lx >= SROW.x + SROW.w) return -1;
    if (ly < SROW.y) return -1;
    const i = Math.floor((ly - SROW.y) / SROW.rowH);
    if (i < 0 || i >= SROW.rows) return -1;
    const index = this.scroll + i;
    return index < this.rows.length ? index : -1;
  }

  private hitArrow(x: number, y: number): number {
    const lx = x - PANEL.x;
    const ly = y - PANEL.y;
    if (ly < ARROW.y || ly >= ARROW.y + ARROW.h) return -1;
    for (let i = 0; i < ARROW.x.length; i++) {
      if (lx >= ARROW.x[i]! && lx < ARROW.x[i]! + ARROW.w) return i;
    }
    return -1;
  }

  /** Hover is only used to keep the key handler and the pointer in sync; the
   *  retail panel has no hover art of its own. */
  handlePointerMove(x: number, y: number): void {
    const row = this.hitRow(x, y);
    if (row >= 0) this.selected = row;
  }

  handleClick(x: number, y: number): void {
    const row = this.hitRow(x, y);
    if (row >= 0) {
      this.selected = row;
      return;
    }
    const arrow = this.hitArrow(x, y);
    if (arrow === 0) {
      this.scrollBy(-1);
      return;
    }
    if (arrow === 1) {
      this.scrollBy(1);
      return;
    }
    // Anywhere else on the panel is not a control; the buttons (join / exit)
    // live in the MultiServer sprite set and are wired by the caller.
  }

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.rows.length - SROW.rows);
    this.scroll = Math.min(Math.max(this.scroll + delta, 0), maxScroll);
    if (this.selected < this.scroll) this.selected = this.scroll;
    if (this.selected >= this.scroll + SROW.rows) this.selected = this.scroll + SROW.rows - 1;
  }

  handleKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown') {
      if (this.selected < this.rows.length - 1) {
        this.selected++;
        if (this.selected >= this.scroll + SROW.rows) this.scroll++;
      }
      ev.preventDefault();
      return;
    }
    if (ev.key === 'ArrowUp') {
      if (this.selected > 0) {
        this.selected--;
        if (this.selected < this.scroll) this.scroll--;
      }
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter') {
      const row = this.rows[this.selected];
      if (row) this.onPick?.(row);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      this.onBack?.();
      ev.preventDefault();
    }
  }

  /** The realm the arrows/Enter would pick. */
  get chosen(): RealmRow | null {
    return this.rows[this.selected] ?? null;
  }
}
