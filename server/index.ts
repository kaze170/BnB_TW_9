/**
 * Retail Taiwan BnB v9 Bun Server (`server/index.ts`).
 *
 *  - Bound to `0.0.0.0:3000` for Arena Live Preview & LAN/WAN multiplayer.
 *  - Serves `public/` (`index.html`, `public/build/main.js`).
 *  - Streams unmodified retail client files under `/game/*` with full HTTP
 *    `Range: bytes=start-end` (`206 Partial Content`) and gzip compression for `.fft`.
 *  - Serves `POST /api/pack-slices` to coalesce raw `.idd` byte-range reads into
 *    a single HTTP round-trip so stages load in `< 40 ms` over WAN.
 *  - Upgrades `/ws` to the `CClientSocket` encrypted binary WebSocket gateway.
 */

import { join } from "node:path";
import { existsSync, openSync, readSync } from "node:fs";
import { Lobby } from "../src/net/lobby.ts";
import { attachGateway, loadRetailData, retailChannels, retailEndpoints } from "./gateway.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC = join(ROOT, "public");

const GAME_FILES = new Set([
  "SkinRsc.idx",
  "SkinRsc.idd",
  "SkinDsc.idx",
  "SkinDsc.idd",
  "Cx.idx",
  "Cx.idd",
  "Fx.idx",
  "Fx.idd",
  "CharTE.idx",
  "CharTE.idd",
  "EmoTE.idx",
  "EmoTE.idd",
  "CxUni.fft",
  "CxDefault.fft",
  "nm.bik",
  "stringtable.ini",
  "csysstr.ssd",
  "fxstock.ini",
  "packagemap.ini",
  "fxdynmapinfo.ssd",
  "channel2_000.ssd",
  "multisvr.ssd",
]);

const ALLOWED_PACKS = new Set(["SkinRsc", "SkinDsc", "Cx", "Fx", "CharTE", "EmoTE"]);
const packFds = new Map<string, { fd: number; size: number }>();

function getPackFd(pack: string): { fd: number; size: number } | null {
  if (!ALLOWED_PACKS.has(pack)) return null;
  let entry = packFds.get(pack);
  if (!entry) {
    const p = join(ROOT, `${pack}.idd`);
    if (!existsSync(p)) return null;
    const size = Bun.file(p).size;
    const fd = openSync(p, "r");
    entry = { fd, size };
    packFds.set(pack, entry);
  }
  return entry;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

function mimeOf(path: string): string {
  const i = path.lastIndexOf(".");
  return (i >= 0 && MIME[path.slice(i)]) || "application/octet-stream";
}

// Cache gzipped CxUni.fft (2.9MB -> ~680KB!) in memory for instant WAN boot
let fftGzipCache: Uint8Array | null = null;

const lobby = new Lobby();
attachGateway(lobby);
await loadRetailData();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    }

    // Coalesced raw .idd byte-range reader (returns unmodified encrypted .idd slices)
    if (url.pathname === "/api/pack-slices" && req.method === "POST") {
      try {
        const body = (await req.json()) as { pack?: string; ranges?: [number, number][] };
        const info = body.pack ? getPackFd(body.pack) : null;
        if (!info || !Array.isArray(body.ranges)) {
          return new Response("bad request", { status: 400 });
        }
        let total = 0;
        for (const [off, len] of body.ranges) {
          if (off < 0 || len < 0 || off + len > info.size) {
            return new Response("range out of bounds", { status: 400 });
          }
          total += len;
        }
        if (total > 32 * 1024 * 1024) {
          return new Response("batch too large", { status: 413 });
        }
        const out = new Uint8Array(total);
        let pos = 0;
        for (const [off, len] of body.ranges) {
          if (len > 0) {
            readSync(info.fd, out, pos, len, off);
            pos += len;
          }
        }
        return new Response(out as unknown as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": "public, max-age=3600",
          },
        });
      } catch {
        return new Response("bad json", { status: 400 });
      }
    }

    // Unmodified retail client data files under /game/*
    if (url.pathname.startsWith("/game/")) {
      const name = url.pathname.slice("/game/".length);
      if (!GAME_FILES.has(name)) return new Response("not found", { status: 404 });
      const file = Bun.file(join(ROOT, name));
      if (!(await file.exists())) return new Response("not found", { status: 404 });

      // Gzip fast-path for CxUni.fft (~4.3x smaller over WAN!)
      const acceptEnc = req.headers.get("accept-encoding") ?? "";
      if (name === "CxUni.fft" && acceptEnc.includes("gzip") && !req.headers.has("range")) {
        if (!fftGzipCache) {
          fftGzipCache = Bun.gzipSync(await file.bytes());
        }
        return new Response(fftGzipCache as unknown as BodyInit, {
          headers: {
            "content-type": "application/octet-stream",
            "content-encoding": "gzip",
            "cache-control": "public, max-age=86400",
          },
        });
      }

      // HTTP Range support (`206 Partial Content`)
      const rangeHdr = req.headers.get("range");
      if (rangeHdr) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHdr.trim());
        if (m) {
          const total = file.size;
          const start = parseInt(m[1]!, 10);
          const end = m[2] ? Math.min(total - 1, parseInt(m[2], 10)) : total - 1;
          if (start >= 0 && start <= end && start < total) {
            return new Response(file.slice(start, end + 1), {
              status: 206,
              headers: {
                "content-type": mimeOf(name),
                "content-range": `bytes ${start}-${end}/${total}`,
                "accept-ranges": "bytes",
                "cache-control": "public, max-age=3600",
              },
            });
          }
        }
      }

      return new Response(file, {
        headers: {
          "content-type": mimeOf(name),
          "accept-ranges": "bytes",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // Static frontend (`public/`)
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    let file = Bun.file(join(PUBLIC, path));
    if (!(await file.exists())) {
      file = Bun.file(join(PUBLIC, "index.html"));
      if (!(await file.exists())) {
        return new Response("build the client first: bun run build", { status: 404 });
      }
    }
    return new Response(file, {
      headers: {
        "content-type": mimeOf(path),
        "cache-control": "no-store, no-cache, must-revalidate",
      },
    });
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

console.log(`BnB Taiwan v9 server listening on http://0.0.0.0:${server.port} (public=${existsSync(PUBLIC) ? "ok" : "missing"})`);
console.log(
  `Retail data mounted: ${retailChannels().length} channels (${retailChannels().map((c) => c.name).join(", ")}), ${retailEndpoints().length} realm endpoints`,
);
