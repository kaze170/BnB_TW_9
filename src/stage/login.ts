/**
 * Login stage — CLoginStage.
 *
 * The layout comes verbatim from SkinDsc's LoginStage.xml pane:
 *
 *   Image_Back  LoginStageBack.jpg   (0, 0)
 *   Button_New      BtLoginNewId.bmp (240, 560)
 *   Button_OK       BtLoginOK.bmp    (350, 560)
 *   Button_Cancel   BtLoginCancel.bmp(460, 560)
 *   Button_Credit   BtLoginCredit.bmp(0,   562)
 *   Inner_1P        pane Login_1P    (197, 395)
 *   Inner_2P        pane Login_2P    (154, 395)
 *
 * The inner panes carry the ID/password edits and the 1P/2P + multiserver
 * selectors (Login_1P.xml: Edit_ID at 205,96 and Edit_Passwd at 205,122,
 * Button_1P at 10,39, Button_2P at 337,39, Sel_Multiserver at 108,31).
 *
 * Nothing here is a re-invention: the rects are the XML attributes, the sprites
 * are the SkinRsc entries, and the button images are sliced with the 48-byte
 * frame records that came out of sub_578660.
 */

import type { GameAssets } from '../data/assets.ts';
import type { SpriteRenderer, DrawQuad } from '../gfx/renderer.ts';
import { SKIN, loadSkinImage, type SkinImage } from '../ui/skinrsc.ts';
import { parseSkinDsc, PANE, type SkinPane, type SkinElement } from '../ui/skindsc.ts';
import { drawEdit, drawText } from '../ui/text.ts';

/**
 * The rects of the wells painted into the pane art, measured off the decoded
 * SkinRsc bitmaps (tools/check-formats.ts and the white-run scan):
 *
 *   LoginTable00.bmp 407x156   ID well 201..295 y 92..115
 *                              PW well 201..295 y 118..141
 *   LoginTable01.bmp 495x156   ID wells 196..290 and 294..388, same rows
 *
 * The XML's `x`/`width` (205/84) sit inside those wells; the art wins because
 * it is what the player sees.
 */
export const EDIT_WELLS: Record<number, Record<string, { x: number; y: number; w: number; h: number }>> = {
  1: {
    Edit_ID: { x: 202, y: 93, w: 93, h: 22 },
    Edit_Passwd: { x: 202, y: 119, w: 93, h: 22 },
  },
  2: {
    Edit_ID0: { x: 197, y: 93, w: 93, h: 22 },
    Edit_Passwd0: { x: 197, y: 119, w: 93, h: 22 },
    Edit_ID1: { x: 295, y: 93, w: 93, h: 22 },
    Edit_Passwd1: { x: 295, y: 119, w: 93, h: 22 },
  },
};

export const SCREEN_W = 800;
export const SCREEN_H = 600;

interface Button {
  id: string;
  /** destination rect, from the XML */
  x: number;
  y: number;
  /** source rect inside the sheet (frame 0 of the CDataI16) */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  image: SkinImage;
  /**
   * Which frame the skin shows.  Every button sheet carries five identical-size
   * frames; the client's CCtrlButton paints frame 0 normally and frame 1 while
   * the button is pressed or hovered (the rest are the disabled/highlight
   * variants used by the dialog controls).
   */
  frame: number;
  kind: 'menu' | 'player' | 'server';
  /** which inner pane owns it, for the 1P/2P and server selectors */
  pane?: number;
  player?: number;
  visible: boolean;
}

interface EditField {
  id: string;
  /** rect of the white well painted into the pane art, screen space */
  x: number;
  y: number;
  w: number;
  h: number;
  password: boolean;
  value: string;
  maxLength: number;
  /** which inner pane (1 or 2) this field belongs to */
  player: number;
  visible: boolean;
}

export class LoginStage {
  private assets: GameAssets;
  private renderer: SpriteRenderer;
  private panes: SkinPane[] = [];
  private images = new Map<string, SkinImage>();
  private textures = new Map<string, GPUTexture>();
  private buttons: Button[] = [];
  private edits: EditField[] = [];
  private focus = -1;
  private player = 1;
  private inners: { id: string; player: number; x: number; y: number; pane: number }[] = [];
  private innerBacks: { inner: SkinElement; element: SkinElement }[] = [];
  private back: SkinImage | null = null;
  private onLogin: ((id: string, pass: string) => void) | null = null;
  private hovered: Button | null = null;

  constructor(assets: GameAssets, renderer: SpriteRenderer) {
    this.assets = assets;
    this.renderer = renderer;
  }

  setLoginHandler(fn: (id: string, pass: string) => void): void {
    this.onLogin = fn;
  }

  async load(progress?: (msg: string) => void): Promise<void> {
    const dsc = await this.assets.pack('SkinDsc');
    // The whole .idd is one XML stream (see ui/skindsc.ts); the per-entry
    // offsets in the index are one byte off, so parse the file as a whole.
    this.panes = parseSkinDsc(new TextDecoder('latin1').decode(dsc.allPayload()));
    progress?.(`SkinDsc panes: ${this.panes.length}`);

    const rsc = await this.assets.pack('SkinRsc');
    for (const [key, entry] of Object.entries(SKIN)) {
      progress?.(`skin ${entry}`);
      const img = await loadSkinImage(rsc, entry);
      if (!img.bitmap) continue;
      this.images.set(key, img);
      this.textures.set(key, this.renderer.createTexture(img.bitmap));
    }

    this.buildStage();
  }

  private buildStage(): void {
    const stage = this.panes[PANE.LoginStage];
    if (!stage) return;
    this.back = this.images.get('loginStageBack') ?? null;

    /** imgpath -> loaded SkinRsc image (both the stage and the inner panes). */
    const imageFor = (element: SkinElement): SkinImage | null => {
      const file = element.imgPath?.at(-1)?.toLowerCase() ?? '';
      for (const [key, entry] of Object.entries(SKIN)) {
        if (entry.split('\\').at(-1)!.toLowerCase() === file) return this.images.get(key) ?? null;
      }
      return null;
    };

    for (const el of stage.elements) {
      if (!el.visible) continue;
      if (el.kind === 'button') {
        const image = imageFor(el);
        if (!image?.sheet) continue;
        const r = image.sheet.rects[0]!;
        this.buttons.push({
          id: el.id,
          x: el.x,
          y: el.y,
          sx: r.x0,
          sy: r.y0,
          sw: r.x1 - r.x0,
          sh: r.y1 - r.y0,
          image,
          frame: 0,
          kind: 'menu',
          visible: true,
        });
      }
    }

    // Inner_1P / Inner_2P host the login forms; only one is shown at a time.
    // The screen-space origin of a pane is its <inner> element.
    const innerSpecs = [
      { id: 'Inner_1P', pane: PANE.Login1P, serverPane: PANE.Login1PMultiserver, player: 1 },
      { id: 'Inner_2P', pane: PANE.Login2P, serverPane: PANE.Login2PMultiserver, player: 2 },
    ] as const;

    for (const spec of innerSpecs) {
      const inner = stage.elements.find((e) => e.id === spec.id);
      const form = this.panes[spec.pane];
      if (!inner || !form) continue;
      this.inners.push({ id: spec.id, player: spec.player, x: inner.x, y: inner.y, pane: spec.pane });

      const bg = form.elements.find((e) => e.id === 'Image_Back');
      if (bg) this.innerBacks.push({ inner, element: bg });

      for (const el of form.elements) {
        if (!el.visible) continue;
        if (el.kind === 'edit') {
          // The XML rect and the well painted into the pane art differ: the
          // art is authoritative for where the text goes.  `editWells` holds
          // the measured rects (LoginTable00: 201..295 x 92..115 and 118..141;
          // LoginTable01: the same rows at 196..290 and 294..388).
          const well = EDIT_WELLS[spec.player]?.[el.id];
          const x = inner.x + (well?.x ?? el.x);
          const y = inner.y + (well?.y ?? el.y);
          this.edits.push({
            id: el.id,
            x,
            y,
            w: well?.w ?? Number(el.attrs.width ?? 84),
            h: well?.h ?? Number(el.attrs.height ?? 12),
            password: el.attrs.password === '1',
            value: '',
            maxLength: Number(el.attrs.max_length ?? 20),
            player: spec.player,
            visible: true,
          });
        } else if (el.kind === 'button') {
          const image = imageFor(el);
          if (!image?.sheet) continue;
          const r = image.sheet.rects[0]!;
          this.buttons.push({
            id: el.id,
            x: inner.x + el.x,
            y: inner.y + el.y,
            sx: r.x0,
            sy: r.y0,
            sw: r.x1 - r.x0,
            sh: r.y1 - r.y0,
            image,
            frame: 0,
            kind: 'player',
            pane: spec.pane,
            player: spec.player,
            visible: true,
          });
        } else if (el.kind === 'sel') {
          const mp = this.panes[spec.serverPane];
          if (!mp) continue;
          for (const se of mp.elements) {
            if (!se.visible || se.kind !== 'button') continue;
            const image = imageFor(se);
            if (!image?.sheet) continue;
            const r = image.sheet.rects[0]!;
            this.buttons.push({
              id: se.id,
              x: inner.x + el.x + se.x,
              y: inner.y + el.y + se.y,
              sx: r.x0,
              sy: r.y0,
              sw: r.x1 - r.x0,
              sh: r.y1 - r.y0,
              image,
              frame: se.id === 'Button_Dream' ? 1 : 0,
              kind: 'server',
              pane: spec.serverPane,
              player: spec.player,
              visible: true,
            });
          }
        }
      }
    }

    // Only the selected player pane is on screen; 1P is the default.
    this.selectPlayer(1);
  }

  private selectPlayer(player: number): void {
    this.player = player;
    for (const e of this.edits) e.visible = e.player === player;
    for (const b of this.buttons) {
      if (b.kind === 'player') b.visible = b.player === player;
      if (b.kind === 'server') b.visible = b.player === player;
    }
    // Focus the ID field of the pane we just selected.
    const first = this.edits.find((e) => e.visible && !e.password);
    this.focus = first ? this.edits.indexOf(first) : -1;
  }

  render(): void {
    const r = this.renderer;
    r.begin();

    if (this.back?.bitmap) {
      const tex = this.textures.get('loginStageBack');
      if (tex) {
        r.draw({
          texture: tex,
          sx: 0,
          sy: 0,
          sw: this.back.bitmap.width,
          sh: this.back.bitmap.height,
          dx: 0,
          dy: 0,
          dw: SCREEN_W,
          dh: SCREEN_H,
        } satisfies DrawQuad);
      }
    }

    // Inner panes first (their art carries the edit wells), then the buttons
    // that sit on top of them, then the stage's own bottom row.
    for (const ib of this.innerBacks) {
      if (ib.inner.id !== `Inner_${this.player}P`) continue;
      const img = this.imageForElement(ib.element);
      if (!img?.bitmap) continue;
      const tex = this.textures.get(this.keyOf(img));
      if (!tex) continue;
      r.draw({
        texture: tex,
        sx: 0,
        sy: 0,
        sw: img.bitmap.width,
        sh: img.bitmap.height,
        dx: ib.inner.x + ib.element.x,
        dy: ib.inner.y + ib.element.y,
        dw: img.bitmap.width,
        dh: img.bitmap.height,
      });
    }

    for (const b of this.buttons) {
      if (!b.visible) continue;
      const tex = this.textures.get(this.keyOf(b.image));
      if (!tex) continue;
      const frameRect = b.image.sheet?.rects[b.frame] ?? b.image.sheet?.rects[0];
      if (!frameRect) continue;
      r.draw({
        texture: tex,
        sx: frameRect.x0,
        sy: frameRect.y0,
        sw: frameRect.x1 - frameRect.x0,
        sh: frameRect.y1 - frameRect.y0,
        dx: b.x,
        dy: b.y,
        dw: b.sw,
        dh: b.sh,
      });
    }

    // The edits sit on top of the inner pane's art; text is drawn by the 2D
    // overlay pass in main.ts (WebGPU cannot render the system font).
    r.end();
  }

  /** 2D overlay: edit contents, drawn after the sprite pass. */
  renderOverlay(ctx: CanvasRenderingContext2D): void {
    this.edits.forEach((e, i) => {
      if (!e.visible) return;
      drawEdit(ctx, e.value, e.x, e.y, e.w, e.h, e.password, this.focus === i);
    });
    if (this.buttons.length === 0) drawText(ctx, 'loading skin…', 12, 12);
  }

  private imageForElement(el: SkinElement): SkinImage | null {
    const file = el.imgPath?.at(-1)?.toLowerCase() ?? '';
    for (const [key, entry] of Object.entries(SKIN)) {
      if (entry.split('\\').at(-1)!.toLowerCase() === file) return this.images.get(key) ?? null;
    }
    return null;
  }

  /** Hit-testing in logical 800x600 space. */
  private hit(x: number, y: number): Button | null {
    for (const b of this.buttons) {
      if (!b.visible) continue;
      if (x >= b.x && x < b.x + b.sw && y >= b.y && y < b.y + b.sh) return b;
    }
    return null;
  }

  handlePointerMove(x: number, y: number): void {
    const b = this.hit(x, y);
    if (b !== this.hovered) {
      if (this.hovered && this.hovered.kind === 'menu') this.hovered.frame = 0;
      this.hovered = b;
      if (b && b.kind === 'menu') b.frame = 1;
    }
  }

  handleClick(x: number, y: number): void {
    for (let i = 0; i < this.edits.length; i++) {
      const e = this.edits[i]!;
      if (!e.visible) continue;
      if (x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) {
        this.focus = i;
        return;
      }
    }
    const b = this.hit(x, y);
    if (!b) return;
    if (b.kind === 'player') {
      // The button belongs to the pane it is drawn in, but its *id* names the
      // pane it selects: Inner_1P carries Button_1P and Button_2P, and clicking
      // Button_2P has to move to the 2P pane.
      this.selectPlayer(b.id === 'Button_2P' ? 2 : 1);
      return;
    }
    if (b.kind === 'server') {
      for (const other of this.buttons) {
        if (other.kind === 'server' && other.player === b.player) other.frame = 0;
      }
      b.frame = 1;
      return;
    }
    if (b.id === 'Button_OK' && this.onLogin) {
      const id = this.edits.find((e) => e.visible && !e.password)?.value ?? '';
      const pass = this.edits.find((e) => e.visible && e.password)?.value ?? '';
      this.onLogin(id, pass);
    }
    if (b.id === 'Button_Cancel') {
      for (const e of this.edits) e.value = '';
    }
  }

  handleKey(ev: KeyboardEvent): void {
    if (ev.key === 'Tab') {
      const shown = this.edits.map((e, i) => (e.visible ? i : -1)).filter((i) => i >= 0);
      if (shown.length) {
        const at = shown.indexOf(this.focus);
        this.focus = shown[(at + 1) % shown.length]!;
      }
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && this.onLogin) {
      const id = this.edits.find((e) => e.visible && !e.password)?.value ?? '';
      const pass = this.edits.find((e) => e.visible && e.password)?.value ?? '';
      this.onLogin(id, pass);
      return;
    }
    const e = this.edits[this.focus];
    if (!e || !e.visible) return;
    if (ev.key === 'Backspace') {
      e.value = e.value.slice(0, -1);
      ev.preventDefault();
      return;
    }
    if (ev.key.length === 1 && e.value.length < e.maxLength) {
      e.value += ev.key;
      ev.preventDefault();
    }
  }

  private keyOf(image: SkinImage): string {
    for (const [k, v] of this.images) if (v === image) return k;
    return '';
  }
}
