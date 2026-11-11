/**
 * Dev server for the web port.
 *
 *  - serves public/ (index.html, build output)
 *  - serves the original client data under /game/ (unmodified .idd/.idx/.ssd)
 *  - WebSocket endpoint /ws — this is the *invented* server half of the game;
 *    the protocol mirrors what CA.exe speaks (see src/net/protocol.ts)
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'public');
const GAME_FILES = new Set([
  'SkinRsc.idx',
  'SkinRsc.idd',
  'SkinDsc.idx',
  'SkinDsc.idd',
  'Cx.idx',
  'Cx.idd',
  'Fx.idx',
  'Fx.idd',
  'CharTE.idx',
  'CharTE.idd',
  'EmoTE.idx',
  'EmoTE.idd',
  'stringtable.ini',
  'csysstr.ssd',
  'fxstock.ini',
  'packagemap.ini',
  'fxdynmapinfo.ssd',
  'channel2_000.ssd',
  'multisvr.ssd',
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function mimeOf(path: string): string {
  const i = path.lastIndexOf('.');
  return (i >= 0 && MIME[path.slice(i)]) || 'application/octet-stream';
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: '0.0.0.0',
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      if (srv.upgrade(req)) return undefined;
      return new Response('expected websocket', { status: 400 });
    }

    // original client data, streamed as-is
    if (url.pathname.startsWith('/game/')) {
      const name = url.pathname.slice('/game/'.length);
      if (!GAME_FILES.has(name)) return new Response('not found', { status: 404 });
      const file = Bun.file(join(ROOT, name));
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      return new Response(file, {
        headers: {
          'content-type': mimeOf(name),
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    // static frontend
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (path.includes('..')) return new Response('bad path', { status: 400 });
    let file = Bun.file(join(PUBLIC, path));
    if (!(await file.exists())) {
      // SPA fallback
      file = Bun.file(join(PUBLIC, 'index.html'));
      if (!(await file.exists())) {
        return new Response('build the client first: bun run build', { status: 404 });
      }
    }
    return new Response(file, { headers: { 'content-type': mimeOf(path) } });
  },
  websocket: {
    open(ws) {
      lobby.join(ws);
    },
    message(ws, raw) {
      lobby.handle(ws, raw as string | Uint8Array);
    },
    close(ws) {
      lobby.leave(ws);
    },
  },
});

// --- lobby (wire format: src/net/protocol.ts; behaviour: server/gateway.ts) --
import { Lobby } from '../src/net/lobby.ts';
import { attachGateway, loadRetailData, retailChannels, retailEndpoints } from './gateway.ts';
const lobby = new Lobby();
attachGateway(lobby);
await loadRetailData();

console.log(`dev server on http://0.0.0.0:${server.port}  (public=${existsSync(PUBLIC) ? 'ok' : 'missing'})`);
console.log(
  `retail data: ${retailChannels().length} channels (${retailChannels().map((c) => c.name).join(', ')}), ` +
    `${retailEndpoints().length} realm endpoints`,
);
