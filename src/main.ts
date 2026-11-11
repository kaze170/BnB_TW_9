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
import { SelectServerStage, type RealmRow } from './stage/selectserver.ts';
import { LobbyStage, type LobbyAction, type RoomSlot } from './stage/lobby.ts';
import { readServerList, mergeWithBuiltins } from './data/serverlist.ts';
import { GameSocket, OP, decodeChannelList, decodeRoomList } from './net/client.ts';

const logEl = document.getElementById('log');
function log(msg: string): void {
  if (!logEl) return;
  logEl.textContent = `${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

type Stage = 'login' | 'server' | 'channel' | 'lobby';

/**
 * The `str16` at `off` (u16 length, then bytes), as latin1.
 *
 * The gateway puts csysstr.ssd *keys* on the wire, and those keys are ASCII by
 * construction (`SameRoomExist`, `NoEmptySlot`, …), so latin1 round-trips them
 * exactly and no Big5 encoder is needed.
 */
function str16At(bytes: Uint8Array, off: number): string {
  if (off + 2 > bytes.length) return '';
  const n = (bytes[off]! << 8) | bytes[off + 1]!;
  const s = off + 2;
  if (s + n > bytes.length) return '';
  return new TextDecoder('latin1').decode(bytes.subarray(s, s + n));
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

  const login = new LoginStage(assets, renderer);
  await login.load((m) => log(m));
  log('login stage ready');

  const channel = new ChannelStage(renderer);
  const server = new SelectServerStage(renderer);
  const lobby = new LobbyStage(renderer);
  let stage: Stage = 'login';
  let lobbyReady = false;
  const lobbyChat: string[] = [];
  let channelsReady = false;
  let serverReady = false;
  let realms: RealmRow[] = [];

  /** The retail realm list: multisvr.ssd plus the addresses in the EXE. */
  const loadRealms = async (): Promise<RealmRow[]> => {
    try {
      const res = await fetch('/game/multisvr.ssd');
      if (!res.ok) throw new Error(String(res.status));
      const bytes = new Uint8Array(await res.arrayBuffer());
      const eps = mergeWithBuiltins(readServerList(bytes));
      return eps.map((e) => ({ address: e.address, port: e.port, label: e.address }));
    } catch {
      return [];
    }
  };

  const showServers = async (): Promise<void> => {
    if (!serverReady) {
      const art = await assets.image('Cx', 'MultiServer/CAStage');
      if (art) server.setBackground(art);
      realms = await loadRealms();
      server.setRows(realms, 0);
      server.setHandlers(
        (row) => {
          log(`realm ${row.address}:${row.port}`);
          // Picking a realm moves on to the channel list, the way
          // CSelectServerStage hands the connection to CStageChannel.
          void showChannels();
        },
        () => {
          stage = 'login';
        },
      );
      serverReady = true;
    }
    stage = 'server';
    log(`server stage ready (${realms.length} realms)`);
  };

  const showChannels = async (): Promise<void> => {
    if (channelsReady) return;
    const art = await assets.image('Cx', 'StageChannel/CAStage');
    if (art) channel.setBackground(art);
    channelsReady = true;
    stage = 'channel';
    log('channel stage ready');
  };

  const showLobby = async (): Promise<void> => {
    if (!lobbyReady) {
      const art = await assets.image('Fx', 'Channel/CAStage');
      if (art) lobby.setBackground(art);
      // The room slots name their map from the shipped table, not the wire.
      const mapFile = await assets.mapInfo();
      if (mapFile) lobby.setMaps(mapFile.maps);
      const slotSheet = await assets.sheet('Fx', 'Channel/BtSessionSlot');
      const slotTex = await assets.texture('Fx', 'Channel/BtSessionSlot');
      if (slotSheet && slotTex) {
        lobby.setSlotArt(
          slotTex,
          slotSheet.rects.map((r) => ({
            sx: r.x0,
            sy: r.y0,
            sw: r.x1 - r.x0,
            sh: r.y1 - r.y0,
          })),
        );
      }
      lobby.setHandlers(
        (action: LobbyAction, slot: RoomSlot | null) => {
          if (action === 'exit') {
            socket.leaveRoom();
            void showChannels();
            return;
          }
          if (action === 'channel') {
            socket.leaveRoom();
            void showChannels();
            return;
          }
          if (action === 'quickjoin' && slot) {
            socket.enterRoom(slot.id);
            return;
          }
          log(`lobby action ${action}${slot ? ` on ${slot.name}` : ''}`);
        },
        (slot: RoomSlot) => socket.enterRoom(slot.id),
      );
      lobbyReady = true;
    }
    stage = 'lobby';
    log('lobby stage ready');
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
        if (ok) void showServers();
        return;
      }
      if (op === OP.ChannelList) {
        const list = decodeChannelList(body);
        log(`channels: ${list.map((c) => c.name).join(', ')}`);
        channel.setChannels(list);
        // The retail text for each channel's kind, straight from csysstr.ssd.
        void Promise.all(list.map((c, i) => assets.channelDescription(i, c.kind))).then((d) =>
          channel.setDescriptions(d),
        );
        return;
      }
      if (op === OP.JoinResult) {
        const ok = body[0] === 1;
        const channelId = (body[1]! << 8) | body[2]!;
        log(`join ${ok ? 'ok' : 'failed'} (channel ${channelId})`);
        if (ok) void showLobby();
        return;
      }
      if (op === OP.RoomList) {
        const rooms = decodeRoomList(body);
        log(`rooms: ${rooms.map((r) => `${r.name} ${r.players}/${r.capacity}`).join(', ')}`);
        lobby.setSlots(rooms.map((r) => ({
          id: r.slot,
          name: r.name,
          players: r.players,
          capacity: r.capacity,
          state: r.state === 1 ? 'playing' : r.state === 2 ? 'locked' : 'waiting',
          map: r.map,
        })));
        return;
      }
      if (op === OP.EnterResult) {
        const ok = body[0] === 1;
        const slot = (body[1]! << 8) | body[2]!;
        // The message is a csysstr.ssd key; resolve it against the client's own
        // string table instead of showing a server-authored sentence.
        const key = str16At(body, 3);
        void assets.systemString(key || '-').then((text) => {
          const shown = text ?? key;
          log(`enter room ${slot}: ${ok ? 'ok' : `failed (${shown})`}`);
          if (!ok) {
            lobbyChat.push(`[系統] ${shown}`);
            lobby.setChat(lobbyChat.slice(-6));
          }
        });
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
    else if (stage === 'server') server.handlePointerMove(p.x, p.y);
    else if (stage === 'channel') channel.handlePointerMove(p.x, p.y);
    else lobby.handlePointerMove(p.x, p.y);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const p = toLogical(ev);
    if (stage === 'login') login.handleClick(p.x, p.y);
    else if (stage === 'server') server.handleClick(p.x, p.y);
    else if (stage === 'channel') channel.handleClick(p.x, p.y);
    else lobby.handleClick(p.x, p.y);
  });
  window.addEventListener('keydown', (ev) => {
    if (stage === 'login') login.handleKey(ev);
    else if (stage === 'server') server.handleKey(ev);
    else if (stage === 'channel') channel.handleKey(ev);
    else lobby.handleKey(ev);
  });

  const frame = (): void => {
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    if (stage === 'login') {
      login.render();
      login.renderOverlay(ctx);
    } else if (stage === 'server') {
      server.render();
      server.renderOverlay(ctx);
    } else if (stage === 'channel') {
      channel.render();
      channel.renderOverlay(ctx);
    } else {
      lobby.render();
      lobby.renderOverlay(ctx);
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
