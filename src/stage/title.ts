// Stage 0: `CTitleStage` (`src/stage/title.ts`).
// Streams and decodes the retail `nm.bik` (800x600 @ 30fps, 90 frames) intro
// video directly into a dynamic WebGPU RGBA texture, accompanied by `Wave/Title`,
// and transitions immediately to `CLoginStage` on completion or click/Escape/Enter/Space.

import { BikVideo } from "../data/bik.ts";
import type { DynamicTexture, SpriteRenderer } from "../gfx/renderer.ts";
import type { AppContext, Stage } from "./types.ts";

export class TitleStage implements Stage {
  readonly id = "title" as const;
  private video: BikVideo | null = null;
  private tex: DynamicTexture | null = null;
  private rgba = new Uint8Array(800 * 600 * 4);
  private frameIdx = -1;
  private elapsedSec = 0;
  private done = false;
  private loading = true;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async enter(): Promise<void> {
    this.done = false;
    this.elapsedSec = 0;
    this.frameIdx = -1;
    this.loading = true;

    try {
      let buf = this.ctx.assets.introVideoBytes;
      if (!buf) {
        const resp = await fetch("/game/nm.bik");
        if (resp.ok) buf = new Uint8Array(await resp.arrayBuffer());
      }
      if (buf && buf.byteLength > 64) {
        this.video = new BikVideo(buf);
        this.tex = this.ctx.renderer.createDynamicTexture(this.video.width, this.video.height);
        this.rgba = new Uint8Array(this.video.width * this.video.height * 4);
        this.ctx.sound.playSfx("Title", 0.9);
      } else {
        this.finish();
      }
    } catch {
      this.finish();
    } finally {
      this.loading = false;
    }
  }

  leave(): void {
    this.tex?.destroy();
    this.tex = null;
    this.video = null;
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    void this.ctx.goto("login");
  }

  tick(dtSec: number): void {
    if (this.loading || this.done) return;
    if (!this.video || !this.tex) {
      this.finish();
      return;
    }
    this.elapsedSec += dtSec;
    const targetFrame = Math.floor(this.elapsedSec * this.video.fps);
    if (targetFrame >= this.video.frameCount) {
      this.finish();
      return;
    }
    while (this.frameIdx < targetFrame) {
      if (!this.video.decodeNextFrame()) {
        this.finish();
        return;
      }
      this.frameIdx++;
      if (this.frameIdx === targetFrame) {
        this.video.writeRgba(this.rgba);
        this.tex.upload(this.rgba);
      }
    }
  }

  onMouseDown(): void {
    this.ctx.sound.unlock();
    this.finish();
  }

  onKeyDown(e: KeyboardEvent): void {
    this.ctx.sound.unlock();
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      this.finish();
    }
  }

  render(r: SpriteRenderer): void {
    r.fillRect(0, 0, 800, 600, [0, 0, 0, 1]);
    if (this.tex && this.frameIdx >= 0) {
      r.drawSprite({ tex: this.tex.tex, x: 0, y: 0, w: 800, h: 600 });
    }
  }
}
