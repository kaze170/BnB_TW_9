/**
 * Web client entry point.
 *
 * Boot order mirrors the original EXE:
 *   CMainWnd creates the stages, the first stage is CLoginStage
 *   (see the stage table in CMainWnd::possible_ctor_or_dtor), which loads
 *   SkinDsc + SkinRsc and paints LoginStage.
 */

import { GameAssets } from './data/assets.ts';
import { SpriteRenderer, requestDevice } from './gfx/renderer.ts';
import { LoginStage, SCREEN_H, SCREEN_W } from './stage/login.ts';

const logEl = document.getElementById('log');
function log(msg: string): void {
  if (!logEl) return;
  logEl.textContent = `${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('screen') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#screen missing');

  const assets = new GameAssets('/game');
  const device = await requestDevice();
  log(`webgpu: ${device.adapterInfo?.description ?? 'adapter ready'}`);

  const renderer = new SpriteRenderer(device, canvas, SCREEN_W, SCREEN_H);

  // The 2D overlay is the stand-in for GDI text; the canvas is shared through
  // a second transparent canvas layered on top so WebGPU keeps its own
  // swapchain.
  const overlay = document.createElement('canvas');
  overlay.width = SCREEN_W;
  overlay.height = SCREEN_H;
  overlay.style.position = 'absolute';
  overlay.style.pointerEvents = 'none';
  canvas.parentElement?.style.setProperty('position', 'relative');
  canvas.after(overlay);
  const ctx = overlay.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');

  const stage = new LoginStage(assets, renderer);
  await stage.load((m) => log(m));
  log('login stage ready');

  const toLogical = (ev: PointerEvent | MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * SCREEN_W,
      y: ((ev.clientY - r.top) / r.height) * SCREEN_H,
    };
  };

  canvas.addEventListener('pointermove', (ev) => {
    const p = toLogical(ev);
    stage.handlePointerMove(p.x, p.y);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const p = toLogical(ev);
    stage.handleClick(p.x, p.y);
  });
  window.addEventListener('keydown', (ev) => stage.handleKey(ev));

  const frame = (): void => {
    stage.render();
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    stage.renderOverlay(ctx);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  log(msg);
  console.error(err);
});
