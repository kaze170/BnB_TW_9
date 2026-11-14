// Hidden IME Bridge & Pure-WebGPU Edit Control (`src/ui/ime.ts`).
// Uses a single off-screen `<input>` element solely to receive native browser
// keyboard / Traditional Chinese IME (Zhuyin/Cangjie/Pinyin) input, while 100%
// of text, selection, password masking, and the 500ms blinking caret render
// inside WebGPU via `CxUni.fft`.

import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { FftStyle } from "../data/fft.ts";

export interface EditBoxOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  maxLength?: number;
  password?: boolean;
  placeholder?: string;
  textColor?: readonly [number, number, number, number];
  bgColor?: readonly [number, number, number, number] | null;
  borderColor?: readonly [number, number, number, number] | null;
  fontStyle?: FftStyle;
  numericOnly?: boolean;
  onEnter?: (value: string) => void;
  onTab?: () => void;
}

class HiddenImeHost {
  private input: HTMLInputElement | null = null;
  private activeOwner: WebGpuEditBox | null = null;
  private composingText = "";
  private lastMode: 0 | 1 | 2 = 0;

  private ensureDom(): HTMLInputElement {
    if (this.input) return this.input;
    const el = document.createElement("input");
    el.type = "text";
    el.autocomplete = "off";
    el.autocapitalize = "off";
    el.spellcheck = false;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0px";
    el.style.width = "1px";
    el.style.height = "1px";
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    document.body.appendChild(el);

    el.addEventListener("compositionstart", () => {
      this.lastMode = 1;
    });
    el.addEventListener("compositionupdate", (e) => {
      this.composingText = e.data ?? "";
      this.lastMode = 1;
    });
    el.addEventListener("compositionend", () => {
      this.composingText = "";
      this.syncToOwner();
    });
    el.addEventListener("input", () => {
      const tail = el.value.slice(-1);
      if (tail) {
        const cp = tail.codePointAt(0) ?? 0;
        if (cp >= 0xff01 && cp <= 0xff5e) this.lastMode = 2;
        else if (cp > 0x007f) this.lastMode = 1;
        else this.lastMode = 0;
      }
      this.syncToOwner();
    });
    el.addEventListener("keydown", (e) => {
      if (!this.activeOwner) return;
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.activeOwner.triggerEnter();
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        this.activeOwner.triggerTab();
      }
    });

    this.input = el;
    return el;
  }

  private syncToOwner(): void {
    const owner = this.activeOwner;
    const el = this.input;
    if (!owner || !el) return;
    let v = el.value;
    if (owner.numericOnly) {
      v = v.replace(/[^0-9]/g, "");
    }
    if (v.length > owner.maxLength) {
      v = v.slice(0, owner.maxLength);
    }
    if (el.value !== v) el.value = v;
    owner.value = v;
  }

  focus(box: WebGpuEditBox): void {
    const el = this.ensureDom();
    this.activeOwner = box;
    this.composingText = "";
    el.maxLength = box.maxLength;
    el.value = box.value;
    el.focus({ preventScroll: true });
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
  }

  blur(box?: WebGpuEditBox): void {
    if (box && this.activeOwner !== box) return;
    this.activeOwner = null;
    this.composingText = "";
    this.input?.blur();
  }

  syncValueFromBox(box: WebGpuEditBox): void {
    if (this.activeOwner === box && this.input) {
      this.input.value = box.value;
    }
  }

  isFocused(box: WebGpuEditBox): boolean {
    return this.activeOwner === box;
  }

  hasActiveFocus(): boolean {
    return this.activeOwner !== null;
  }

  /** `CImeStatusWnd` (`CA.exe.c:362135..362220`) frame `0` (Alpha), `1` (Native/CJK), `2` (Full-width). */
  imeStatusFrame(): 0 | 1 | 2 {
    if (this.activeOwner?.numericOnly || this.activeOwner?.password) return 0;
    if (this.composingText.length > 0) return 1;
    return this.lastMode;
  }

  compositionFor(box: WebGpuEditBox): string {
    return this.activeOwner === box ? this.composingText : "";
  }
}

export const imeHost = new HiddenImeHost();

export class WebGpuEditBox {
  x: number;
  y: number;
  w: number;
  h: number;
  maxLength: number;
  password: boolean;
  placeholder: string;
  textColor: readonly [number, number, number, number];
  bgColor: readonly [number, number, number, number] | null;
  borderColor: readonly [number, number, number, number] | null;
  fontStyle: FftStyle;
  numericOnly: boolean;
  onEnter?: (value: string) => void;
  onTab?: () => void;

  private _value = "";

  constructor(opts: EditBoxOptions) {
    this.x = opts.x;
    this.y = opts.y;
    this.w = opts.w;
    this.h = opts.h;
    this.maxLength = opts.maxLength ?? 40;
    this.password = opts.password ?? false;
    this.placeholder = opts.placeholder ?? "";
    this.textColor = opts.textColor ?? [0.05, 0.05, 0.08, 1];
    this.bgColor = opts.bgColor !== undefined ? opts.bgColor : null;
    this.borderColor = opts.borderColor !== undefined ? opts.borderColor : null;
    this.fontStyle = opts.fontStyle ?? 0;
    this.numericOnly = opts.numericOnly ?? false;
    this.onEnter = opts.onEnter;
    this.onTab = opts.onTab;
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = v.slice(0, this.maxLength);
    imeHost.syncValueFromBox(this);
  }

  get focused(): boolean {
    return imeHost.isFocused(this);
  }

  focus(): void {
    imeHost.focus(this);
  }

  blur(): void {
    imeHost.blur(this);
  }

  contains(mx: number, my: number): boolean {
    return mx >= this.x && mx < this.x + this.w && my >= this.y && my < this.y + this.h;
  }

  handleMouseDown(mx: number, my: number): boolean {
    if (this.contains(mx, my)) {
      this.focus();
      return true;
    }
    return false;
  }

  triggerEnter(): void {
    this.onEnter?.(this._value);
  }

  triggerTab(): void {
    this.onTab?.();
  }

  render(r: SpriteRenderer, nowMs: number): void {
    if (this.bgColor) {
      r.fillRect(this.x, this.y, this.w, this.h, this.bgColor);
    }
    if (this.borderColor) {
      const col = this.focused ? [0.25, 0.65, 1.0, 1] as const : this.borderColor;
      r.strokeRect(this.x, this.y, this.w, this.h, col, 1);
    }

    r.pushClip(this.x + 1, this.y - 1, Math.max(1, this.w - 2), Math.max(14, this.h + 2));

    const comp = imeHost.compositionFor(this);
    const rawShown = this.password ? "*".repeat(this._value.length) : this._value + comp;
    const textY = Math.round(this.y + (this.h - 12) * 0.5);

    if (!rawShown && !this.focused && this.placeholder) {
      r.drawText(this.placeholder, this.x + 2, textY, {
        color: [0.45, 0.48, 0.54, 0.85],
        style: 0,
      });
    } else {
      // Scroll left if typed string exceeds box width
      const fullW = r.measureText(rawShown, this.fontStyle);
      const availW = this.w - 4;
      const scrollX = fullW > availW ? availW - fullW : 0;
      const drawX = this.x + 2 + scrollX;
      r.drawText(rawShown, drawX, textY, {
        color: this.textColor,
        style: this.fontStyle,
      });

      // Retail 500ms caret blink (`CA.exe` 0x4F321A)
      if (this.focused && Math.floor(nowMs / 500) % 2 === 0) {
        const caretX = drawX + fullW + 1;
        r.fillRect(caretX, textY, 1, 12, this.textColor);
      }
    }

    r.popClip();
  }
}
