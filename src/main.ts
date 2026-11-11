/**
 * Web client entry point.
 *
 * Boot order mirrors the original EXE:
 *   CMainWnd creates the stages, the first stage is CLoginStage
 *   (see the stage table in CMainWnd::possible_ctor_or_dtor), which loads
 *   SkinDsc + SkinRsc and paints LoginStage.  A successful login goes to
 *   CStageChannel, whose art is `Cx`'s StageChannel/CAStage JPEG and whose rows
 *   come from the retail channel table.
 */

import { GameAssets } from './data/assets.ts';
import { SpriteRenderer, requestDevice } from './gfx/renderer.ts';
import { LoginStage, SCREEN_H, SCREEN_W } from './stage/login.ts';
import { ChannelStage } from './stage/channel.ts';
import { GameSocket, OP, decodeChannelList } from './net/client.ts';

const logEl = document.getElementById('log');
function log(msg: string): void {
  if (!logEl) return;
  logEl.textContent = `${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

type Stage = 'login' | 'channel';

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

  const login = new LoginStage(assets, renderer);
  await login.load((m) => log(m));
  log('login stage ready');

  const channel = new ChannelStage(renderer);
  let stage: Stage = 'login';
  let channelsReady = false;

  const showChannels = async (): Promise<void> => {
    if (channelsReady) return;
    const art = await assets.image('Cx', 'StageChannel/CAStage');
    if (art) channel.setBackground(art);
    channelsReady = true;
    stage = 'channel';
    log('channel stage ready');
  };

  const socket = new GameSocket({
    open: () => log('socket connected'),
    close: (code) => log(`socket closed (${code})`),
    error: () => log('socket error'),
    packet: (op, body) => {
      if (op === OP.Confirm) {
        log(`handshake: key 0x${(body[0] ?? 0).toString(16)}`);
        return;
      }
      if (op === OP.LoginResult) {
        const ok = body[0] === 1;
        const msg = new TextDecoder('big5').decode(body.subarray(3, 3 + ((body[1]! << 8) | body[2]!)));
        log(`login ${ok ? 'ok' : 'failed'}${msg ? `: ${msg}` : ''}`);
        if (ok) void showChannels();
        return;
      }
      if (op === OP.ChannelList) {
        const list = decodeChannelList(body);
        log(`channels: ${list.map((c) => c.name).join(', ')}`);
        channel.setChannels(list);
        return;
      }
      if (op === OP.JoinResult) {
        const ok = body[0] === 1;
        const channelId = (body[1]! << 8) | body[2]!;
        log(`join ${ok ? 'ok' : 'failed'} (channel ${channelId})`);
        return;
      }
      log(`packet 0x${op.toString(16)} (${body.length}B)`);
    },
  });
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket.connect(wsUrl).catch(() => log('server not reachable'));
  login.setLoginHandler((id, pass) => {
    log(`login ${id}`);
    socket.login(id, pass);
  });

  channel.setActionHandler((action, ch, index) => {
    if (action === 'enter' && ch) {
      log(`enter ${ch.name}`);
      socket.joinChannel(index);
      return;
    }
    if (action === 'exit') {
      stage = 'login';
      return;
    }
    log(`action ${action}${ch ? ` on ${ch.name}` : ''}`);
  });

  const toLogical = (ev: PointerEvent | MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * SCREEN_W,
      y: ((ev.clientY - r.top) / r.height) * SCREEN_H,
    };
  };

  canvas.addEventListener('pointermove', (ev) => {
    const p = toLogical(ev);
    if (stage === 'login') login.handlePointerMove(p.x, p.y);
    else channel.handlePointerMove(p.x, p.y);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const p = toLogical(ev);
    if (stage === 'login') login.handleClick(p.x, p.y);
    else channel.handleClick(p.x, p.y);
  });
  window.addEventListener('keydown', (ev) => {
    if (stage === 'login') login.handleKey(ev);
    else channel.handleKey(ev);
  });

  const frame = (): void => {
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    if (stage === 'login') {
      login.render();
      login.renderOverlay(ctx);
    } else {
      channel.render();
      channel.renderOverlay(ctx);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  log(msg);
  console.error(err);
});
