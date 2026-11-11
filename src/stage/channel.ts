/**
 * Channel select stage — CStageChannel.
 *
 * The art is the retail one: `Cx` carries `StageChannel/CAStage`, an 800x600
 * JPEG of the whole screen (title "頻道選擇", the announcement panel on the
 * left, the channel list on the right, three button wells along the bottom,
 * the advert banner).  Nothing about the layout below is invented except the
 * measurement of where the art's own rows are.
 *
 * Measured off the decoded JPEG (tools/render-channel.ts re-measures them):
 *   list column   x 581..751
 *   first row     y 80, every row 23px tall, 13 rows visible
 *   button wells  y 421..457 (37 tall), three 100-wide boxes at x 123/228/333
 *
 * The rows are filled from the server's ChannelList, which carries the records
 * of the shipped `channel2_000.ssd` verbatim, so the names and user counts are
 * the retail ones.
 */

import type { DrawQuad, SpriteRenderer } from '../gfx/renderer.ts';
import type { ChannelInfo } from '../net/client.ts';
import { drawText } from '../ui/text.ts';

export const SCREEN_W = 800;
export const SCREEN_H = 600;

/** Measured geometry of the retail screen; tools/render-channel.ts re-uses it. */
export const LIST_RECT = { x: 581, y: 80, w: 170, rowH: 23, rows: 13 } as const;
export const WELL_RECT = { y: 421, h: 37, w: 100, x: [123, 228, 333] as const };
const LIST = LIST_RECT;
const WELL = WELL_RECT;

export type ChannelAction = 'enter' | 'bbs' | 'exit';

export class ChannelStage {
  private readonly renderer: SpriteRenderer;
  private texture: GPUTexture | null = null;
  private channels: ChannelInfo[] = [];
  private selected = 0;
  private hovered = -1;
  private onAction: ((action: ChannelAction, channel: ChannelInfo | null, index: number) => void) | null = null;

  constructor(renderer: SpriteRenderer) {
    this.renderer = renderer;
  }

  /** Upload the 800x600 screen art (the JPEG stored in the Cx pack). */
  setBackground(bitmap: ImageBitmap): void {
    this.texture = this.renderer.createTexture(bitmap);
  }

  setChannels(channels: ChannelInfo[]): void {
    this.channels = channels.slice();
    this.selected = 0;
  }

  get selectedChannel(): ChannelInfo | null {
    return this.channels[this.selected] ?? null;
  }

  setActionHandler(fn: (action: ChannelAction, channel: ChannelInfo | null, index: number) => void): void {
    this.onAction = fn;
  }

  render(): void {
    const r = this.renderer;
    r.begin();
    if (this.texture) {
      r.draw({
        texture: this.texture,
        sx: 0,
        sy: 0,
        sw: SCREEN_W,
        sh: SCREEN_H,
        dx: 0,
        dy: 0,
        dw: SCREEN_W,
        dh: SCREEN_H,
      } satisfies DrawQuad);
    }
    r.end();
  }

  /** Channel rows, the selection highlight and the labels go through canvas 2D. */
  renderOverlay(ctx: CanvasRenderingContext2D): void {
    // Rows.  The art already draws empty slots; we only paint the text.
    for (let i = 0; i < Math.min(this.channels.length, LIST.rows); i++) {
      const c = this.channels[i]!;
      const y = LIST.y + i * LIST.rowH;
      if (i === this.selected) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(LIST.x, y, LIST.w, LIST.rowH - 1);
        ctx.restore();
      } else if (i === this.hovered) {
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(LIST.x, y, LIST.w, LIST.rowH - 1);
        ctx.restore();
      }
      drawText(ctx, c.name, LIST.x + 4, y + 5, { size: 12, colour: '#ffffff' });
      // user count on the right, the way the retail list shows it
      const count = `${c.users}/${c.maxUsers}`;
      drawText(ctx, count, LIST.x + LIST.w - 4, y + 5, { size: 11, colour: '#c8e4ff', align: 'right' });
    }

    if (this.channels.length === 0) {
      drawText(ctx, '頻道清單載入中…', LIST.x + 4, LIST.y + 5, { size: 12, colour: '#c8e4ff' });
    }

    // The three wells are painted empty by the art; label them the way the
    // retail screen does.
    const labels = ['進入', '佈告欄', '離開'] as const;
    for (let i = 0; i < WELL.x.length; i++) {
      drawText(ctx, labels[i]!, WELL.x[i]! + WELL.w / 2, WELL.y + 11, {
        size: 12,
        colour: '#ffffff',
        align: 'center',
      });
    }
  }

  private hitRow(x: number, y: number): number {
    if (x < LIST.x || x >= LIST.x + LIST.w) return -1;
    const i = Math.floor((y - LIST.y) / LIST.rowH);
    if (i < 0 || i >= Math.min(this.channels.length, LIST.rows)) return -1;
    return i;
  }

  private hitWell(x: number, y: number): number {
    if (y < WELL.y || y >= WELL.y + WELL.h) return -1;
    for (let i = 0; i < WELL.x.length; i++) {
      if (x >= WELL.x[i]! && x < WELL.x[i]! + WELL.w) return i;
    }
    return -1;
  }

  handlePointerMove(x: number, y: number): void {
    this.hovered = this.hitRow(x, y);
  }

  handleClick(x: number, y: number): void {
    const row = this.hitRow(x, y);
    if (row >= 0) {
      this.selected = row;
      return;
    }
    const well = this.hitWell(x, y);
    if (well < 0) return;
    const action: ChannelAction = well === 0 ? 'enter' : well === 1 ? 'bbs' : 'exit';
    this.onAction?.(action, this.selectedChannel, this.selected);
  }

  handleKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown') {
      if (this.channels.length) this.selected = Math.min(this.selected + 1, this.channels.length - 1);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'ArrowUp') {
      this.selected = Math.max(this.selected - 1, 0);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter') {
      this.onAction?.('enter', this.selectedChannel, this.selected);
      ev.preventDefault();
    }
  }
}
