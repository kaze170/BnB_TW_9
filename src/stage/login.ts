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
}

interface EditField {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  password: boolean;
  value: string;
  maxLength: number;
}

export class LoginStage {
  private assets: GameAssets;
  private renderer: SpriteRenderer;
  private panes: SkinPane[] = [];
  private images = new Map<string, SkinImage>();
  private textures = new Map<string, GPUTexture>();
  private buttons: Button[] = [];
  private edits: EditField[] = [];
  private focus = 0;
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

    // Frame 0 of each button sheet is the button itself; the remaining frames
    // are the pressed/disabled variants (the 5-record strips in the pack).
    const buttonImage = (element: SkinElement): SkinImage | null => {
      const file = element.imgPath?.at(-1)?.toLowerCase() ?? '';
      const map: Record<string, string> = {
        'btloginnewid.bmp': 'btLoginNewId',
        'btloginok.bmp': 'btLoginOk',
        'btlogincancel.bmp': 'btLoginCancel',
        'btlogincredit.bmp': 'btLoginCredit',
      };
      const key = map[file];
      return key ? (this.images.get(key) ?? null) : null;
    };

    for (const el of stage.elements) {
      if (!el.visible) continue;
      if (el.kind === 'button') {
        const image = buttonImage(el);
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
        });
      }
    }

    // Inner_1P / Inner_2P host the login forms; only one is shown at a time.
    const inner = stage.elements.find((e) => e.id === 'Inner_1P');
    if (inner) {
      const form = this.panes[PANE.Login1P];
      const ox = inner.x;
      const oy = inner.y;
      if (form) {
        for (const el of form.elements) {
          if (el.kind !== 'edit' || el.attrs.visible === '0') continue;
          this.edits.push({
            id: el.id,
            x: ox + el.x,
            y: oy + el.y,
            w: Number(el.attrs.width ?? 84),
            h: Number(el.attrs.height ?? 12),
            password: el.attrs.password === '1',
            value: '',
            maxLength: Number(el.attrs.max_length ?? 20),
          });
        }
      }
    }
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

    for (const b of this.buttons) {
      const tex = this.textures.get(this.keyOf(b.image));
      if (!tex) continue;
      r.draw({
        texture: tex,
        sx: b.sx,
        sy: b.sy,
        sw: b.sw,
        sh: b.sh,
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
      drawEdit(ctx, e.value, e.x, e.y, e.w, e.h, e.password, this.focus === i);
    });
    if (this.buttons.length === 0) drawText(ctx, 'loading skin…', 12, 12);
  }

  /** Hit-testing in logical 800x600 space. */
  private hit(x: number, y: number): Button | null {
    for (const b of this.buttons) {
      if (x >= b.x && x < b.x + b.sw && y >= b.y && y < b.y + b.sh) return b;
    }
    return null;
  }

  handlePointerMove(x: number, y: number): void {
    this.hovered = this.hit(x, y);
  }

  handleClick(x: number, y: number): void {
    for (let i = 0; i < this.edits.length; i++) {
      const e = this.edits[i]!;
      if (x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) {
        this.focus = i;
        return;
      }
    }
    const b = this.hit(x, y);
    if (!b) return;
    if (b.id === 'Button_OK' && this.onLogin) this.onLogin(this.editValue('Edit_ID'), this.editValue('Edit_Passwd'));
  }

  private editValue(id: string): string {
    return this.edits.find((e) => e.id === id)?.value ?? '';
  }

  handleKey(ev: KeyboardEvent): void {
    const e = this.edits[this.focus];
    if (!e) return;
    if (ev.key === 'Backspace') {
      e.value = e.value.slice(0, -1);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Tab') {
      this.focus = (this.focus + 1) % Math.max(1, this.edits.length);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && this.onLogin) {
      this.onLogin(this.editValue('Edit_ID'), this.editValue('Edit_Passwd'));
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
