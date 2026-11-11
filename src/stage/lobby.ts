/**
 * Lobby stage — CLobbyStage.
 *
 * The art is `Channel/CAStage`, an 800x600 JPEG in Fx.idd: six room slots in a
 * 2x3 grid, the player list down the right, the chat panel and the button row
 * along the bottom.  The executable's own slot table corroborates the grid —
 * `CLobbyStage`'s constructor lays out exactly six session slots.
 *
 * Measured off the decoded JPEG (re-measured by tools/render-lobby.ts):
 *   room grid   x 24..302 / 305..583, y 102..182 / 183..263 / 264..344
 *               (278x80 per slot, 3px gutters)
 *   player list x 640..772, first row y 108, 23px rows
 *   chat panel  x 24..583, y 400..520
 *   button row  y 528..556
 *
 * The six slots are the retail count.  Rooms themselves are server state — the
 * retail protocol for them is not recoverable — so this stage draws the slots
 * it can see and leaves the occupancy to the gateway.
 */

import type { DrawQuad, SpriteRenderer } from '../gfx/renderer.ts';
import { drawText } from '../ui/text.ts';

export const SCREEN_W = 800;
export const SCREEN_H = 600;

/**
 * Six room slots, in screen coordinates.
 *
 * The hit boxes are the 278x80 cells the lobby art draws.  Each cell is
 * filled with `Channel/BtSessionSlot` (274x76, four frames: idle, pressed,
 * hover, selected-yellow), which carries the inner layout:
 *
 *   title bar  y 11..38   small tag  x 10..57   room name  x 58..263
 *   bottom row y 46..68   three wells: x 15..99, x 100..220, x 224..265
 */
export const SLOT_ORIGINS: readonly (readonly [number, number])[] = [
  [26, 104], [26, 185], [26, 266],
  [307, 104], [307, 185], [307, 266],
] as const;

export const SLOTS: { x: number; y: number; w: number; h: number }[] = SLOT_ORIGINS.map(
  ([x, y]) => ({ x, y, w: 274, h: 76 }),
);

/** Where text goes inside one `BtSessionSlot` (slot-local pixels). */
export const SLOT_FIELDS = {
  tag: { x: 10, y: 11, w: 47, h: 27 },
  name: { x: 58, y: 11, w: 205, h: 27 },
  field1: { x: 15, y: 46, w: 84, h: 22 },
  field2: { x: 100, y: 46, w: 120, h: 22 },
  field3: { x: 224, y: 46, w: 41, h: 22 },
} as const;

/** BtSessionSlot frames. */
export const SLOT_FRAME = { idle: 0, pressed: 1, hover: 2, selected: 3 } as const;

/**
 * Player list, right-hand column.  `PLAYER_ORIGINS` is the executable's own
 * table (dword_6158B0, sixteen pairs, x=643, y=111+23k) — the same array the
 * lobby's draw loop walks with `cmp ..., 10h`.
 *
 * Inside one row `sub_46A42E` places two things, both with offsets taken from
 * the code rather than measured off the art:
 *
 *   x+0x27, y+2   the player name, drawn as text (sub_56ADD0)
 *   x+0x14, y+1   the player's level, drawn as *numerals* by sub_4F6FF1 —
 *                 that routine clamps its value to 1..450 and indexes a
 *                 24-byte-stride glyph table at 0x625C00, so it is a number
 *                 renderer, not a text one.
 */
export const PLAYER_ORIGINS: readonly (readonly [number, number])[] = Array.from(
  { length: 16 },
  (_, i) => [643, 111 + 23 * i] as const,
);

export const PLAYERS = { x: 643, y: 111, w: 132, rowH: 23, rows: 16 } as const;
export const PLAYER_FIELDS = { level: { dx: 0x14, dy: 1 }, name: { dx: 0x27, dy: 2 } } as const;

/** sub_4F6FF1 clamps the value it draws to this range. */
export const LEVEL_RANGE = { min: 1, max: 450 } as const;
/** Chat panel. */
export const CHAT = { x: 24, y: 400, w: 559, h: 120 } as const;
/**
 * Two slots in the bottom bar.  The art draws exactly two wells there
 * (x 34..144 and x 147..572, y 529..553): the narrow one is the input line,
 * the wide one the button strip.
 */
export const BAR = { y: 529, h: 24, wells: [
  { x: 34, w: 110 },
  { x: 147, w: 425 },
] as const };

/**
 * The buttons that go in the wide well.  These are the retail art buttons:
 * their labels are painted into the sprites, so the stage draws the sprite
 * and never writes text over it.  Frames are idle/pressed/disabled/hover/…
 * and `BtExit` is 144x34 while the others are 68 tall — the row is anchored
 * to the well's left edge in this order, which is the order the channel
 * screen uses for the same three actions.
 */
export const LOBBY_BUTTONS = [
  { name: 'Channel/BtCreate', w: 111, h: 68, action: 'create' as const },
  { name: 'Channel/BtQuickJoin', w: 215, h: 68, action: 'quickjoin' as const },
  { name: 'Channel/BtChannel', w: 111, h: 68, action: 'channel' as const },
  { name: 'Channel/BtExit', w: 144, h: 34, action: 'exit' as const },
];

export interface RoomSlot {
  id: number;
  name: string;
  /** occupied players / capacity */
  players: number;
  capacity: number;
  /** locked / playing / waiting — server-defined */
  state: 'waiting' | 'playing' | 'locked';
  map: string;
}

export interface LobbyPlayer {
  name: string;
  level: number;
}

/**
 * The retail bar's buttons are drawn art plus a string table we have not
 * recovered, so no labels are invented here: the stage reports intent
 * (`exit`, `channel`) and leaves the bar's text to the string pass.
 */
export type LobbyAction = 'exit' | 'channel';

export class LobbyStage {
  private readonly renderer: SpriteRenderer;
  private texture: GPUTexture | null = null;
  private slotTex: GPUTexture | null = null;
  private slotFrames: { sx: number; sy: number; sw: number; sh: number }[] = [];
  private slots: (RoomSlot | null)[] = [];
  private players: LobbyPlayer[] = [];
  private selected = 0;
  private hovered: number | null = null;
  private chat: string[] = [];
  private input = '';
  private onAction: ((action: LobbyAction, slot: RoomSlot | null) => void) | null = null;
  private onJoin: ((slot: RoomSlot) => void) | null = null;

  constructor(renderer: SpriteRenderer) {
    this.renderer = renderer;
  }

  setBackground(bitmap: ImageBitmap): void {
    this.texture = this.renderer.createTexture(bitmap);
  }

  /**
   * `Channel/BtSessionSlot`: 274x76, four frames.  Frames 0 and 2 share the
   * same sheet rectangle, so the sheet offsets are passed in rather than
   * derived from the frame index.
   */
  setSlotArt(
    bitmap: ImageBitmap,
    frames: { sx: number; sy: number; sw: number; sh: number }[],
  ): void {
    this.slotTex = this.renderer.createTexture(bitmap);
    this.slotFrames = frames;
  }

  /** Six slots, in the retail order (row-major through the 2x3 grid). */
  setSlots(slots: (RoomSlot | null)[]): void {
    this.slots = slots.slice(0, SLOTS.length);
    while (this.slots.length < SLOTS.length) this.slots.push(null);
    if (this.selected >= this.slots.length) this.selected = 0;
  }

  setPlayers(players: LobbyPlayer[]): void {
    this.players = players.slice();
  }

  setChat(lines: string[]): void {
    this.chat = lines.slice(-6);
  }

  setHandlers(
    onAction: (action: LobbyAction, slot: RoomSlot | null) => void,
    onJoin: (slot: RoomSlot) => void,
  ): void {
    this.onAction = onAction;
    this.onJoin = onJoin;
  }

  get selectedSlot(): RoomSlot | null {
    return this.slots[this.selected] ?? null;
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
    if (this.slotTex) {
      for (let i = 0; i < SLOTS.length; i++) {
        const s = SLOTS[i]!;
        const f =
          this.slotFrames[
            i === this.selected ? SLOT_FRAME.selected : i === this.hovered ? SLOT_FRAME.hover : SLOT_FRAME.idle
          ];
        if (!f) continue;
        r.draw({
          texture: this.slotTex,
          sx: f.sx,
          sy: f.sy,
          sw: f.sw,
          sh: f.sh,
          dx: s.x,
          dy: s.y,
          dw: f.sw,
          dh: f.sh,
        } satisfies DrawQuad);
      }
    }
    r.end();
  }

  renderOverlay(ctx: CanvasRenderingContext2D): void {
    // Room slots.  The art draws the frames; the text is ours.
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i]!;
      const room = this.slots[i] ?? null;
      const o = { x: s.x, y: s.y };
      if (!room) continue;

      // BtSessionSlot's inner fields, measured off the sheet.
      drawText(ctx, room.name, o.x + SLOT_FIELDS.name.x + 6, o.y + SLOT_FIELDS.name.y + 7, {
        size: 13,
        colour: '#ffffff',
      });
      drawText(ctx, room.map, o.x + SLOT_FIELDS.field1.x + 6, o.y + SLOT_FIELDS.field1.y + 5, {
        size: 11,
        colour: '#dff0ff',
      });
      const stateText =
        room.state === 'playing' ? '遊戲中' : room.state === 'locked' ? '密碼' : '等待中';
      drawText(ctx, stateText, o.x + SLOT_FIELDS.field2.x + 6, o.y + SLOT_FIELDS.field2.y + 5, {
        size: 11,
        colour: '#dff0ff',
      });
      drawText(ctx, `${room.players}/${room.capacity}`, o.x + SLOT_FIELDS.field3.x + 20, o.y + SLOT_FIELDS.field3.y + 5, {
        size: 11,
        colour: room.players >= room.capacity ? '#ffb0b0' : '#ffffff',
        align: 'center',
      });
    }

    // Player list, at the executable's row origins and inner offsets.
    for (let i = 0; i < Math.min(this.players.length, PLAYER_ORIGINS.length); i++) {
      const p = this.players[i]!;
      const [rx, ry] = PLAYER_ORIGINS[i]!;
      drawText(ctx, p.name, rx + PLAYER_FIELDS.name.dx, ry + PLAYER_FIELDS.name.dy, {
        size: 12,
        colour: '#ffffff',
      });
      const level = Math.min(LEVEL_RANGE.max, Math.max(LEVEL_RANGE.min, p.level));
      drawText(ctx, String(level), rx + PLAYER_FIELDS.level.dx, ry + PLAYER_FIELDS.level.dy, {
        size: 11,
        colour: '#bfe0ff',
      });
    }

    // Chat lines.
    for (let i = 0; i < this.chat.length; i++) {
      drawText(ctx, this.chat[i]!, CHAT.x + 10, CHAT.y + 10 + i * 17, { size: 12, colour: '#dff0ff' });
    }

    // The empty input line in the bar's first well.
    drawText(ctx, this.input, BAR.wells[0]!.x + 6, BAR.y + 5, { size: 12, colour: '#ffffff' });
    if (this.input === '') {
      drawText(ctx, '_', BAR.wells[0]!.x + 6, BAR.y + 5, { size: 12, colour: '#9dc4e8' });
    }
  }

  private hitSlot(x: number, y: number): number {
    return SLOTS.findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  }

  /** The second well holds the retail button strip; until its hit boxes are
   *  recovered, only the keyboard drives it. */
  private hitButton(x: number, y: number): LobbyAction | null {
    if (y < BAR.y || y >= BAR.y + BAR.h) return null;
    if (x >= BAR.wells[1]!.x && x < BAR.wells[1]!.x + BAR.wells[1]!.w) return 'channel';
    return null;
  }

  handlePointerMove(x: number, y: number): void {
    const i = this.hitSlot(x, y);
    this.hovered = i >= 0 ? i : null;
  }

  handleClick(x: number, y: number): void {
    const action = this.hitButton(x, y);
    if (action) {
      this.onAction?.(action, this.selectedSlot);
      return;
    }
    const slot = this.hitSlot(x, y);
    if (slot < 0) return;
    // Clicking a slot selects it; clicking it again (or double-click) joins.
    if (slot === this.selected) {
      const room = this.slots[slot];
      if (room) this.onJoin?.(room);
      return;
    }
    this.selected = slot;
  }

  handleKey(ev: KeyboardEvent): void {
    const cols = 2;
    if (ev.key === 'Backspace') {
      this.input = this.input.slice(0, -1);
      ev.preventDefault();
      return;
    }
    if (ev.key.length === 1 && this.input.length < 60) {
      this.input += ev.key;
      ev.preventDefault();
      return;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const d = ev.key === 'ArrowRight' ? 1 : -1;
      this.selected = Math.min(Math.max(this.selected + d, 0), SLOTS.length - 1);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const d = (ev.key === 'ArrowDown' ? 1 : -1) * cols;
      const next = this.selected + d;
      if (next >= 0 && next < SLOTS.length) this.selected = next;
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter') {
      const room = this.slots[this.selected];
      if (room) this.onJoin?.(room);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Escape') {
      this.onAction?.('exit', null);
      ev.preventDefault();
    }
  }
}
