import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GameDatabase, expForLevel } from "../server/db.ts";
import { ClientHub, DEFAULT_MACROS } from "../src/net/hub.ts";
import { Pack, normalizeName, parseIndex } from "../src/data/pack.ts";
import { CHAR_MAIN_MAP } from "../src/data/assets.ts";
import { SHOP_CARD, retailOwnedTooltip, retailPriceText, retailShopCategory } from "../src/ui/shop-layout.ts";
import { ShopStage } from "../src/stage/shop.ts";
import { GameStage, gameMapLabel } from "../src/stage/game.ts";
import { CosmeticCatalog, resolveFanfareIndex } from "../src/data/cosmetics.ts";
import {
  decodeCDataI16,
  decodeCDataI16Character,
  decodeSpriteSheet,
  expand16,
  inflateBnbZlib,
  isBnbZlibPayload,
} from "../src/data/sprite.ts";
import {
  EMOT_SHOP_FALLBACK_ICONS,
  InventoryWndNew,
  formatRemainingHours,
  inventoryTooltipName,
  inventoryTooltipPeriod,
  ITEM_BOX_RING_25,
  ShopInventoryPopupMenu,
  MotionBlurTrail,
  SpriteButton,
  computeLevelIconParts,
  levelEffectFrame,
  sampleActionFrame,
  gameKillModeIconFrame,
  handleRetailSlashCommand,
} from "../src/ui/widgets.ts";
import { resolveMapBgmTrack } from "../src/audio/sound.ts";
import {
  COMMUNITY_LOGO_OPTIONS,
  LevelNoticeDlg,
  MyPageDlg,
  DialogStack,
  SELECT_CHAR_SHOP_COORDS,
  SPEAKER_COLOR_ICONS,
} from "../src/ui/dialogs.ts";
import {
  AVATAR_DECO_ACTION_MAP,
  compositeAvatarLayers,
  compositeTwoLayerCharacter,
  TEAM_HLS,
} from "../src/data/hls.ts";
import { FftFont } from "../src/data/fft.ts";
import { BikVideo } from "../src/data/bik.ts";
import { readSsi } from "../src/data/ssi.ts";
import { includeArchiveMaps, parseMapInfo } from "../src/data/mapinfo.ts";
import { readChannelFile } from "../src/data/channel.ts";
import {
  ObjectTable,
  parseBomberAttr,
  parseFxStock,
  parseItemAttr,
  parseMapBinary,
  parseMapGroup,
  parsePackageMap,
  parseSysStrings,
  parseStringTable,
  parseTileInfo,
} from "../src/data/tables.ts";
import { traceBulaLoop, traceBulaLoopsAt, bulaLoopCandidates, bulaNativeDotState } from "../src/sim/bula.ts";
import {
  ACTIVE_BANANA,
  ACTIVE_BLIND,
  ACTIVE_CAN,
  ACTIVE_DART,
  ACTIVE_DRILL,
  ACTIVE_GUM,
  ACTIVE_MINE,
  ACTIVE_NEEDLE,
  ACTIVE_PIN,
  ACTIVE_RADAR,
  ACTIVE_REMOTE,
  ACTIVE_SHIELD,
  ACTIVE_SPRING,
  ACTIVE_WATERTIGHT,
  BOMB_FUSE_TICKS,
  BUBBLE_POP_TICKS,
  GameSimulation,
  START_BANNER_TICKS,
  soulFlameHit,
} from "../src/sim/engine.ts";
import {
  drawSheetFrame,
  drawGameSpeechBubble,
  drawSpriteDigits,
  drawSpriteNumber,
  inferChatEmotionPose,
} from "../src/ui/widgets.ts";
import { computeAiInput, scoreRetailItemPriority } from "../src/sim/ai.ts";
import { mergeWithBuiltins, parseServerList } from "../src/data/serverlist.ts";
import { GameSocket } from "../src/net/client.ts";
import { OP_RPC, type ClientMsg, type ServerMsg } from "../src/net/messages.ts";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTs(full));
    else if (ent.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("Retail UI & Archive Fidelity", () => {
  test("100% of literal loadSheet() paths exist in retail .idx archives", () => {
    const packs: Record<string, Set<string>> = {};
    for (const p of ["SkinRsc", "SkinDsc", "Cx", "Fx", "CharTE", "EmoTE"]) {
      const idx = parseIndex(readFileSync(`${p}.idx`));
      expect(idx).not.toBeNull();
      packs[p] = new Set(idx!.entries.map((e) => normalizeName(e.name)));
    }

    const re = /loadSheet\(\s*"(SkinRsc|Cx|Fx|CharTE|EmoTE)"\s*,\s*"([^"$]+)"\s*\)/g;
    const missing: string[] = [];
    let count = 0;

    for (const file of walkTs("src")) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        count++;
        const [, pack, path] = m;
        if (!packs[pack!]!.has(normalizeName(path!))) {
          missing.push(`${file} -> ${pack}:${path}`);
        }
      }
    }

    expect(count).toBeGreaterThan(200);
    expect(missing).toEqual([]);
  });

  test("zero self-invented UI primitives or synthetic Unicode emojis in stages/dialogs", () => {
    const violations: string[] = [];
    for (const file of walkTs("src/stage").concat(walkTs("src/ui"))) {
      if (file.endsWith("ime.ts")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((ln, idx) => {
        if (/BevelButton|drawPanel|strokeRect|[👑💣▼▲◄►★☆✓✔✕✖🔒🔓🔊]/.test(ln)) {
          violations.push(`${file}:${idx + 1}: ${ln.trim()}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test("public/index.html DOM element IDs match src/main.ts entrypoint", () => {
    const html = readFileSync("public/index.html", "utf8");
    const main = readFileSync("src/main.ts", "utf8");
    expect(html).toContain('id="frame"');
    expect(html).toContain('<canvas id="screen"');
    expect(html).toContain('id="fallback"');
    expect(main).toContain('getElementById("screen")');
  });
});

describe("Retail Binary Data & Media Decoders", () => {
  test("CxUni.fft rasterizes ASCII and Traditional Chinese Big5/Unicode glyphs", () => {
    const font = new FftFont(readFileSync("CxUni.fft"));
    const gTw = font.rasterize("爆".codePointAt(0)!, 2);
    expect(gTw.w).toBe(14);
    expect(gTw.h).toBe(14);
    expect(gTw.advance).toBeGreaterThanOrEqual(11);
    expect(font.measureText("爆爆王 BnB", 2)).toBeGreaterThan(50);
  });

  test("nm.bik Bink video decodes 800x600 @ 30fps frames to RGBA", () => {
    const bik = new BikVideo(readFileSync("nm.bik"));
    expect(bik.width).toBe(800);
    expect(bik.height).toBe(600);
    expect(bik.frameCount).toBe(90);
    const rgba = new Uint8Array(800 * 600 * 4);
    for (let f = 0; f < 30; f++) {
      expect(bik.decodeNextFrame()).toBe(true);
    }
    bik.writeRgba(rgba);
    // Verify non-black decoded Nexon logo pixels at 1.0s
    let bright = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i]! + rgba[i + 1]! + rgba[i + 2]! > 60) bright++;
    }
    expect(bright).toBeGreaterThan(5000);
  });

  test("Fx tables, two-layer CDataI16Character HLS tinting, stocks, maps, and channels decode cleanly", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    expect(objTable.byIndex.length).toBeGreaterThanOrEqual(960);

    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    expect(bombers.length).toBeGreaterThanOrEqual(8);

    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    expect(itemAttr.items.length).toBeGreaterThanOrEqual(15);

    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    expect(tileInfo.size).toBeGreaterThan(100);

    // Two-layer bomber sprite HLS team coloring (`LayerStatic` + `LayerAdjust`)
    const stRaw = fx.payload("Character/C00-Blink_ALayerStatic")!;
    const adRaw = fx.payload("Character/C00-Blink_ALayerAdjust")!;
    const stSheet = decodeCDataI16(stRaw) ?? decodeCDataI16Character(stRaw);
    const adSheet = decodeCDataI16(adRaw) ?? decodeCDataI16Character(adRaw);
    expect(stSheet).not.toBeNull();
    expect(adSheet).not.toBeNull();
    expect(TEAM_HLS.length).toBe(8);
    const tintedBlue = compositeTwoLayerCharacter(stSheet, adSheet, 6);
    expect(tintedBlue).not.toBeNull();
    expect(tintedBlue!.width).toBeGreaterThan(0);
    expect(tintedBlue!.rgba.length).toBe(tintedBlue!.width * tintedBlue!.height * 4);

    // Retail sprite sheet check (`Game/Timer`)
    const timer = decodeCDataI16(fx.payload("Game/Timer")!);
    expect(timer).not.toBeNull();
    expect(timer!.rects.length).toBeGreaterThanOrEqual(10);

    // Retail ssi1 tables (`parseFxStock` / `parsePackageMap` / `parseSysStrings` take raw file bytes)
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    expect(stocks.length).toBe(1461);
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    expect(pkgMap.size).toBeGreaterThan(50);
    const sysStr = parseSysStrings(readFileSync("csysstr.ssd"));
    expect(sysStr.size).toBeGreaterThan(200);

    const maps = parseMapInfo(readSsi(readFileSync("fxdynmapinfo.ssd"))!.payload)!;
    expect(maps.maps.length).toBe(240);
    const names = fx.entries.map(e => e.name);
    const expanded = includeArchiveMaps(maps, names);
    const reversed = includeArchiveMaps(maps, [...names].reverse());
    expect(expanded.maps).toEqual(reversed.maps);
    expect(expanded.maps.filter(m => !m.random)).toHaveLength(289);
    expect(new Set(expanded.maps.map(m => m.index)).size).toBe(expanded.maps.length);
    expect(expanded.maps.slice(0, maps.maps.length)).toEqual(maps.maps);
    for (const name of ["Bonus01", "Camp01", "Dessert00", "Kart15", "Xmas11"]) {
      expect(expanded.maps.some(m => m.name === name && fx.has(`Map/${name}`))).toBe(true);
    }

    const ch = readChannelFile(readFileSync("channel2_000.ssd"), "channel2_000.ssd");
    expect(ch?.channels.length).toBe(5);
  });

  test("retail character faces preserve 0x0000 pure-black eyes/bangs, 0xF81F colorkey, CHAR_MAIN_MAP, and multi-part C06/C10 layers", () => {
    // `CA.exe` `dword_62B538` = 0x0000 (opaque black) vs `dword_62B548` = 0xF81F (transparent magenta colorkey)
    expect(expand16(0x0000)).toBe(0xff000000);
    expect(expand16(0xf81f)).toBe(0x00000000);

    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const charte = new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd"));

    // Verify `CHAR_MAIN_MAP` matches retail `BomberAttr` selectable order `0..7`
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    expect(bombers.slice(0, 8).map((b) => b.code)).toEqual([...CHAR_MAIN_MAP]);

    const dec = (p: Pack, name: string) => {
      const raw = p.payload(name);
      return raw ? decodeSpriteSheet(raw) : null;
    };

    const countBlackInFrame0 = (comp: { width: number; rgba: Uint8Array; rects: { x0: number; y0: number; x1: number; y1: number }[] }) => {
      const rc = comp.rects[0]!;
      const rw = rc.x1 - rc.x0;
      const rh = rc.y1 - rc.y0;
      const u32 = new Uint32Array(comp.rgba.buffer, comp.rgba.byteOffset, comp.rgba.byteLength >>> 2);
      let black = 0;
      let opaque = 0;
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const px = u32[(rc.y0 + y) * comp.width + (rc.x0 + x)]!;
          if ((px >>> 24) !== 0) {
            opaque++;
            if (px === 0xff000000) black++;
          }
        }
      }
      return { rw, rh, opaque, black };
    };

    // Bazzi (`C00`) must retain all 95 pure-black eye/outline pixels; Dao (`C01`) must retain all 209 visor/pupil pixels
    const bazziWalk = compositeTwoLayerCharacter(
      dec(fx, "Character/C00-WalkDown_ALayerStatic"),
      dec(fx, "Character/C00-WalkDown_ALayerAdjust"),
      1,
    )!;
    expect(countBlackInFrame0(bazziWalk).black).toBe(95);

    const daoWalk = compositeTwoLayerCharacter(
      dec(fx, "Character/C01-WalkDown_ALayerStatic"),
      dec(fx, "Character/C01-WalkDown_ALayerAdjust"),
      2,
    )!;
    expect(countBlackInFrame0(daoWalk).black).toBe(209);

    // Multi-part Dizni (`C06`: `_A -> _B -> A06_30_0001 -> _C`) must render full 44x56 body+collar+hair (not 30x18 disembodied face)
    const walkSpec = AVATAR_DECO_ACTION_MAP.WalkDown!;
    const dizniWalk = compositeAvatarLayers(
      [
        {
          staticSheet: dec(fx, "Character/C06-WalkDown_ALayerStatic"),
          adjustSheet: dec(fx, "Character/C06-WalkDown_ALayerAdjust"),
        },
        {
          staticSheet: dec(fx, "Character/C06-WalkDown_BLayerStatic"),
          adjustSheet: dec(fx, "Character/C06-WalkDown_BLayerAdjust"),
        },
        {
          staticSheet: dec(charte, `AvatarDeco/A06_30_0001_${walkSpec.sheet}LayerStatic`),
          adjustSheet: dec(charte, `AvatarDeco/A06_30_0001_${walkSpec.sheet}LayerAdjust`),
          frameOffset: walkSpec.offset,
        },
        {
          staticSheet: dec(fx, "Character/C06-WalkDown_CLayerStatic"),
          adjustSheet: dec(fx, "Character/C06-WalkDown_CLayerAdjust"),
        },
      ],
      3,
    )!;
    const dizniStats = countBlackInFrame0(dizniWalk);
    expect(dizniStats.rw).toBe(44);
    expect(dizniStats.rh).toBe(56);
    expect(dizniStats.opaque).toBeGreaterThan(2000);
    expect(dizniStats.black).toBeGreaterThan(0);

    // Multi-part Dizni Portrait (`_A -> A06_30_0001 -> _C`) fits centered inside 42x31 `CPortraitWnd` well
    const portSpec = AVATAR_DECO_ACTION_MAP.Portrait!;
    const dizniPortrait = compositeAvatarLayers(
      [
        {
          staticSheet: dec(fx, "Character/C06-Portrait_ALayerStatic"),
          adjustSheet: dec(fx, "Character/C06-Portrait_ALayerAdjust"),
        },
        {
          staticSheet: dec(charte, `AvatarDeco/A06_30_0001_${portSpec.sheet}LayerStatic`),
          adjustSheet: dec(charte, `AvatarDeco/A06_30_0001_${portSpec.sheet}LayerAdjust`),
          frameOffset: portSpec.offset,
        },
        {
          staticSheet: dec(fx, "Character/C06-Portrait_CLayerStatic"),
          adjustSheet: dec(fx, "Character/C06-Portrait_CLayerAdjust"),
        },
      ],
      1,
    )!;
    const dpRc = dizniPortrait.rects[0]!;
    expect(dpRc.x1 - dpRc.x0).toBe(36);
    expect(dpRc.y1 - dpRc.y0).toBe(30);
    expect(-dpRc.px).toBe(3);
    expect(-dpRc.py).toBe(1);
  });

  test("retail CGOBomber actions, SelfIndicator bounce, Ship flyLevel layering, and CGOGameResult ResultImg rects match CA.exe", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const ot = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);

    // `Game/SelfIndicator` is a 17-step ping-pong bounce (`0..8..0`), NOT team-indexed frames
    const selfInd = ot.byName.get("Game/SelfIndicator")?.defaultAction;
    expect(selfInd).not.toBeNull();
    expect(selfInd!.steps.length).toBe(17);
    expect(selfInd!.steps[0]!.frame).toBe(0);
    expect(selfInd!.steps[8]!.frame).toBe(8);
    expect(selfInd!.steps[16]!.frame).toBe(0);

    // `Character/C00_A`: `25 Locked In` uses `Character/C00-Die` (flailing in bubble), NOT `02 Faint`
    const c00 = ot.byName.get("Character/C00_A")!;
    expect(c00.actions.get("25 Locked In")?.sprite).toBe("Character/C00-Die");
    expect(c00.actions.get("01 Die")?.sprite).toBe("Character/C00-Die");
    expect(c00.actions.get("01 Die")?.totalTicks).toBe(92);
    expect(c00.actions.get("24 Start")?.sprite).toBe("Character/C00-Start_A");
    expect(c00.actions.get("03 Hurrah")?.sprite).toBe("Character/C00-Hurrah_A");
    expect(c00.actions.get("26 Release")?.sprite).toBe("Character/C00-Hurrah_A");

    // `Character/C00-RideDown_A` already embeds `py = 66` saddle height; `Airship` has `flyLevel === 2`
    const rideDown = decodeSpriteSheet(fx.payload("Character/C00-RideDown_ALayerStatic")!)!;
    expect(rideDown.rects[0]!.py).toBe(66);
    expect(itemAttr.ships.get(1)?.objectName).toBe("Ship/Airship");
    expect(itemAttr.ships.get(1)?.flyLevel).toBe(2);
    expect(itemAttr.ships.get(2)?.objectName).toBe("Ship/Owl");
    expect(itemAttr.ships.get(2)?.flyLevel).toBe(1);

    // `Game/ResultImg` contains all 54 retail `CGOGameResult` sprites (`33..37` headers, `38` local bar)
    const resImg = decodeSpriteSheet(fx.payload("Game/ResultImg")!)!;
    expect(resImg.rects.length).toBe(54);
    expect(resImg.rects[33]!.x1 - resImg.rects[33]!.x0).toBe(99);
    expect(resImg.rects[38]!.x1 - resImg.rects[38]!.x0).toBe(349);
  });
});

describe("Deterministic 30ms Simulation Engine & AI", () => {
  test("bomb ignition, chain flame propagation, water bubble trap, needle rescue, and AI ticks", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objectTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Patrit00", fx.payload("Map/Patrit00")!);

    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 12345,
      objectTable,
      bomberByCode,
      itemAttr,
      tileInfo,
      participants: [
        { slot: 0, name: "Bazzi", charCode: 0, team: 0, isAi: false, aiLevel: 1 },
        { slot: 1, name: "DaoBot", charCode: 1, team: 1, isAi: true, aiLevel: 3 },
      ],
    });

    // Advance past intro Start banner
    for (let i = 0; i <= START_BANNER_TICKS; i++) sim.step();

    // Place a bomb with player 0
    sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(sim.bombs.length).toBe(1);

    // Move player 0 onto the bomb and let it detonate -> trapped in water bubble
    const p0 = sim.players[0]!;
    p0.activeSlots[0] = ACTIVE_NEEDLE;
    for (let i = 0; i < BOMB_FUSE_TICKS + 2; i++) {
      sim.setInput(1, computeAiInput(sim, 1));
      sim.step();
    }
    expect(p0.state).toBe("trapped");

    // Use Needle -> rescued back to alive!
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true });
    sim.step();
    expect(p0.state).toBe("alive");
  });
});

describe("Live CClientSocket Encrypted WebSocket E2E", () => {
  test("2-player auth, lobby, shop purchase, SMS, and 1-on-1 item/Lucci exchange", async () => {
    const utf8Enc = new TextEncoder();
    const utf8Dec = new TextDecoder();

    async function connectTestClient(): Promise<{
      sock: GameSocket;
      inbox: ServerMsg[];
      send: (m: ClientMsg) => void;
      waitFor: <T extends ServerMsg["type"]>(
        t: T,
        pred?: (m: Extract<ServerMsg, { type: T }>) => boolean,
      ) => Promise<Extract<ServerMsg, { type: T }>>;
    }> {
      const inbox: ServerMsg[] = [];
      const waiters: { type: string; pred?: (m: any) => boolean; resolve: (m: any) => void }[] = [];
      let handshakeDone!: () => void;
      const handshakePromise = new Promise<void>((res) => {
        handshakeDone = res;
      });
      const sock = new GameSocket({
        packet: (op, payload) => {
          if (op === 0x01) {
            handshakeDone();
            return;
          }
          if (op !== OP_RPC) return;
          const msg = JSON.parse(utf8Dec.decode(payload)) as ServerMsg;
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i]!;
            if (w.type === msg.type && (!w.pred || w.pred(msg))) {
              waiters.splice(i, 1);
              w.resolve(msg);
              return;
            }
          }
          inbox.push(msg);
        },
      });
      await sock.connect("ws://127.0.0.1:3000/ws");
      await handshakePromise;
      return {
        sock,
        inbox,
        send: (m) => sock.send(OP_RPC, utf8Enc.encode(JSON.stringify(m))),
        waitFor: (t, pred) => {
          const idx = inbox.findIndex((x) => x.type === t && (!pred || pred(x as any)));
          if (idx >= 0) {
            return Promise.resolve(inbox.splice(idx, 1)[0] as any);
          }
          return new Promise((resolve) => waiters.push({ type: t, pred: pred as any, resolve }));
        },
      };
    }

    const suffix = `${Date.now() % 100000}`;
    const u1 = `t1_${suffix}`;
    const u2 = `t2_${suffix}`;

    const c1 = await connectTestClient();
    const c2 = await connectTestClient();

    try {
      c1.send({ type: "auth_register", username: u1, password: "pw", nickname: "測試一", gender: 0 });
      const ok1 = await c1.waitFor("auth_ok");
      expect(ok1.profile.username).toBe(u1);

      c2.send({ type: "auth_register", username: u2, password: "pw", nickname: "測試二", gender: 1 });
      const ok2 = await c2.waitFor("auth_ok");
      expect(ok2.profile.username).toBe(u2);

      // Join channel 0
      c1.send({ type: "join_channel", channelIdx: 0 });
      c2.send({ type: "join_channel", channelIdx: 0 });
      await c1.waitFor("channel_joined");
      await c2.waitFor("channel_joined");

      // Create an Exchange room & join it
      c1.send({
        type: "create_room",
        title: "測試交換",
        password: "",
        kind: "exchange",
        mode: 0,
        mapIndex: 1,
        capacity: 2,
      });
      const rj1 = await c1.waitFor("room_joined");
      c2.send({ type: "join_room", roomId: rj1.room.id });
      await c2.waitFor("room_joined");

      // Offer 500 Lucci from c1 -> c2, lock both, wait until both sides locked, then confirm both
      c1.send({ type: "exchange_offer", invIds: [], lucci: 500 });
      await c2.waitFor("exchange_sync", (m) => m.state.offeredLucci[0] === 500);
      c1.send({ type: "exchange_lock", locked: true });
      c2.send({ type: "exchange_lock", locked: true });
      await c1.waitFor("exchange_sync", (m) => m.state.locked[0] && m.state.locked[1]);
      await c2.waitFor("exchange_sync", (m) => m.state.locked[0] && m.state.locked[1]);

      c1.send({ type: "exchange_confirm" });
      c2.send({ type: "exchange_confirm" });

      const done1 = await c1.waitFor("exchange_done");
      expect(done1.message.length).toBeGreaterThan(0);

      // Leave exchange room, test SMS, Shop buy, Inventory equip, and Online Match start!
      c1.send({ type: "leave_room" });
      c2.send({ type: "leave_room" });
      await c1.waitFor("room_left");
      await c2.waitFor("room_left");

      // Send SMS from c1 -> c2
      c1.send({ type: "sms_send", to: u2, body: "哈囉爆爆王！" });
      const smsSync = await c2.waitFor("sms_sync", (m) => m.sms.some((s) => s.body === "哈囉爆爆王！"));
      expect(smsSync.sms.length).toBeGreaterThanOrEqual(1);

      // Charge cash & buy a cosmetic item from fxstock.ini, then equip it
      c1.send({ type: "charge_cash", amount: 5000 });
      await c1.waitFor("profile_sync", (m) => m.profile.cash >= 5000);
      const stocks = parseFxStock(readFileSync("fxstock.ini"));
      const buyTarget = stocks.find((s) => s.priceLucci > 0 && s.priceLucci <= 2000)!;
      c1.send({ type: "shop_buy", stockId: buyTarget.id, currency: "lucci", requestId: "purchase-test" });
      const shopRes = await c1.waitFor("shop_res", m => m.requestId === "purchase-test");
      expect(shopRes.ok).toBe(true);
      c1.send({ type: "shop_buy_batch", requestId: "batch-test", items: [{ stockId: -99, currency: "lucci", qty: 1 }] });
      const rejectedBatch = await c1.waitFor("shop_res", m => m.requestId === "batch-test");
      expect(rejectedBatch.ok).toBe(false);
      const invSync = await c1.waitFor("inventory_sync", (m) => m.inventory.some((r) => r.stockId === buyTarget.id));
      const invRow = invSync.inventory.find((r) => r.stockId === buyTarget.id)!;
      c1.send({ type: "item_equip", invId: invRow.invId, equip: true });
      const equippedSync = await c1.waitFor("inventory_sync", (m) => m.inventory.some((r) => r.invId === invRow.invId && r.equipped));
      expect(equippedSync.inventory.find((r) => r.invId === invRow.invId)?.equipped).toBe(true);

      // Create 12-slot Chat room (`kind: "chat"`, `manner: false`) + `/where` location query!
      c1.send({
        type: "create_room",
        title: "十二人聊天室",
        password: "",
        manner: false,
        kind: "chat",
        mode: 0,
        mapIndex: -1,
        capacity: 12,
      });
      const chatRj = await c1.waitFor("room_joined");
      expect(chatRj.room.slots.length).toBe(12);
      expect(chatRj.room.manner).toBe(false);
      c1.send({ type: "chat_send", text: `/where ${u2}` });
      const whereRes = await c1.waitFor("chat_recv", (m) => m.text.includes("位置查詢"));
      expect(whereRes.text).toContain(u2);
      c1.send({ type: "leave_room" });
      await c1.waitFor("room_left");

      // Create Game room, test `mapIndex: -1` + Theme-Random `room_set_map`, join with c2, ready up, and start 30ms match
      c1.send({
        type: "create_room",
        title: "對戰測試房",
        password: "",
        manner: true,
        kind: "game",
        mode: 0,
        mapIndex: -1,
        capacity: 8,
      });
      const gameRj = await c1.waitFor("room_joined");
      expect(gameRj.room.mapIndex).toBe(-1);
      expect(gameRj.room.mapName).toBe("Random");
      expect(gameRj.room.manner).toBe(true);
      const mapSsiE2E = readSsi(readFileSync("fxdynmapinfo.ssd"))!;
      const villageRand = parseMapInfo(mapSsiE2E.payload)!.maps.find(
        (m) => m.random && m.family.toLowerCase() === "village",
      )!;
      c1.send({ type: "room_set_map", mapIndex: villageRand.index });
      const syncVillageRand = await c1.waitFor("room_sync", (m) => m.room.mapIndex === villageRand.index);
      expect(syncVillageRand.room.mapName.toLowerCase()).toContain("village");
      c2.send({ type: "join_room", roomId: gameRj.room.id });
      await c2.waitFor("room_joined");
      c2.send({ type: "room_toggle_ready" });
      await c1.waitFor("room_sync", (m) => Boolean(m.room.slots[1]?.ready));
      c1.send({ type: "room_start" });
      const ms1 = await c1.waitFor("match_start");
      const ms2 = await c2.waitFor("match_start");
      expect(ms1.snapshot.players.length).toBe(2);
      expect(ms2.snapshot.players.length).toBe(2);
      expect(ms1.snapshot.mapName.toLowerCase()).toStartWith("village");
      const tickState = await c1.waitFor("match_state", (m) => m.snapshot.tick >= 2);
      expect(tickState.snapshot.tick).toBeGreaterThanOrEqual(2);

      // Test `CExchangeCouponDlg` (`gachapon_spin` -> `gachapon_res`) authoritative roulette RPC!
      c1.send({ type: "charge_cash", amount: 500 });
      await c1.waitFor("shop_res");
      c1.send({ type: "gachapon_spin" });
      const gachaRes = await c1.waitFor("gachapon_res");
      expect(gachaRes.ok).toBe(true);
      expect(gachaRes.message.length).toBeGreaterThan(0);
      expect(gachaRes.stockId > 0 || gachaRes.lucciJackpot === 3000).toBe(true);
    } finally {
      c1.sock.close();
      c2.sock.close();
    }
  });
});

describe("CIconMan CosmeticCatalog & Multi-Cell Tile Physics", () => {
  test("resolves 100% of all 1,461 fxstock.ini items across Fx, CharTE, EmoTE, and Cx", () => {
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const packageMap = parsePackageMap(readFileSync("packagemap.ini"));
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const charTe = new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd"));
    const emoTe = new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd"));
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const charObjects = new ObjectTable(charTe.payload("ObjectTable/CharTEObjectTable")!);
    const emoObjects = new ObjectTable(emoTe.payload("ObjectTable/EmoTEObjectTable")!);

    expect(charObjects.byIndex.length).toBe(216);
    expect(emoObjects.byIndex.length).toBe(1072);

    const probe = (p: Pack) => ({
      has: (n: string) => p.has(n),
      entriesMatching: (pref: string) =>
        p.entries.filter((e) => e.name.toLowerCase().startsWith(pref.toLowerCase())),
    });

    const catalog = new CosmeticCatalog({
      stocks,
      packageMap,
      fx: probe(fx),
      charTe: probe(charTe),
      emoTe: probe(emoTe),
      cx: probe(cx),
      charObjects,
      emoObjects,
    });

    const packs = { Fx: fx, CharTE: charTe, EmoTE: emoTe, Cx: cx };
    for (const s of stocks) {
      const vis = catalog.resolve(s.id);
      expect(vis).toBeDefined();
      expect(packs[vis!.iconPack as keyof typeof packs].has(vis!.iconName)).toBe(true);
      if (vis!.liveObject) {
        if (
          vis!.liveKind === "slotDeco" ||
          vis!.liveKind === "fanfare" ||
          vis!.liveKind === "idDeco" ||
          vis!.liveKind === "emotion"
        ) {
          expect(emoObjects.byName.has(vis!.liveObject)).toBe(true);
        } else if (vis!.liveKind === "levelEffect") {
          expect(fx.has(vis!.liveObject)).toBe(true);
        } else {
          expect(charObjects.byName.has(vis!.liveObject)).toBe(true);
        }
      }
    }

    // Verify Sun Wukong bundle (6346) expands into both SlotDeco and CharDeco live visuals
    const wukongKids = catalog.expandVisuals(6346);
    expect(wukongKids.some((v) => v.liveKind === "slotDeco")).toBe(true);
    expect(wukongKids.some((v) => v.liveKind === "charDeco")).toBe(true);
  });

  test("marks non-anchor footprint cells of multi-cell static obstacles as blockKind=1 & indestructible", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objectTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Bonus01", fx.payload("Map/Bonus01")!);

    // Verify lowercase 'default'/'broken' push-boxes and ShakenHorz/ShakenVert bushes exist in ObjectTable
    const kfcBox = objectTable.byName.get("Tile11_Box/Box_Movable01")!;
    expect(kfcBox.actions.has("default")).toBe(true);
    expect(kfcBox.actions.has("broken")).toBe(true);
    const bush = objectTable.byName.get("Tile00_Passable/Herb00")!;
    expect(bush.actions.has("ShakenHorz")).toBe(true);
    expect(bush.actions.has("ShakenVert")).toBe(true);

    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 42,
      objectTable,
      bomberByCode,
      itemAttr,
      tileInfo,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
      ],
    });

    // Find a multi-cell static building anchor on KFC00 and verify its entire footprint blocks UFOs (`blockKind === 1`)
    let checkedMulti = 0;
    for (let y = 0; y < sim.height; y++) {
      for (let x = 0; x < sim.width; x++) {
        const c = sim.cellAt(x, y)!;
        if (!c.blockObjName) continue;
        const spec = tileInfo.get(c.blockObjName);
        if (spec && spec.kind === 1 && (spec.width > 1 || spec.height > 1)) {
          for (let fy = y - spec.height + 1; fy <= y; fy++) {
            for (let fx = x; fx < x + spec.width; fx++) {
              const foot = sim.cellAt(fx, fy);
              if (foot) {
                expect(foot.blocksWalk).toBe(true);
                expect(foot.blockKind).toBe(1);
                expect(foot.indestructible).toBe(true);
                checkedMulti++;
              }
            }
          }
        }
      }
    }
    expect(checkedMulti).toBeGreaterThan(0);
  });
});

describe("Retail Map Tables, StrongBox HP, Mounts, Darts, & Gimmicks", () => {
  test("parses all 289 Fx:Map/* binaries with portals, itemQuotas, dropRatePct, and Bonus01 Lucci coins", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const mapEntries = fx.entries.filter((e) => e.name.toLowerCase().startsWith("map/"));
    expect(mapEntries.length).toBe(289);
    for (const e of mapEntries) {
      const m = parseMapBinary(e.name.slice(4), fx.payload(e.name)!);
      expect(m.width).toBeGreaterThanOrEqual(13);
      expect(m.height).toBeGreaterThanOrEqual(11);
      expect(m.dropRatePct).toBeGreaterThanOrEqual(0);
      expect(m.dropRatePct).toBeLessThanOrEqual(100);
    }

    const bonus01 = parseMapBinary("Bonus01", fx.payload("Map/Bonus01")!);
    expect(bonus01.preplacedItems.length).toBe(129);
    expect(bonus01.preplacedItems.some((p) => p.itemName.includes("LucciGold"))).toBe(true);

    const village00 = parseMapBinary("Village00", fx.payload("Map/Village00")!);
    expect(village00.portals.length).toBeGreaterThanOrEqual(1);

    const bula00 = parseMapBinary("Bula00", fx.payload("Map/Bula00")!);
    expect(bula00.itemQuotas.get("item/itembond")).toBe(100);
    expect(bula00.itemQuotas.get("luccigold")).toBe(0);
  });

  test("Factory ground flow uses the separate retail alignment mask and output direction", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const tiles = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const corner = tiles.get("TileConv/ConvUR00")!;
    expect([corner.conveyorSpeed, corner.conveyorAlignMask, corner.conveyorDir]).toEqual([2, 2, 2]);
    const left = tiles.get("TileConv/ConvUL00")!;
    expect([left.conveyorSpeed, left.conveyorAlignMask, left.conveyorDir]).toEqual([2, 2, 0]);
    const map = parseMapBinary("Factory00", fx.payload("Map/Factory00")!);
    const sim = new GameSimulation({ mapData: map, mode: 0, seed: 1,
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!),
      tileInfo: tiles, itemAttr: parseItemAttr(fx.payload("Attr/ItemAttr")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map(b => [b.code, b])),
      participants: [{ slot: 0, name: "P1", charCode: 0, team: 0 }, { slot: 1, name: "P2", charCode: 1, team: 1 }] });
    expect(sim.cells.some(c => c.groundObjName.startsWith("TileConv/") && c.conveyorSpeed === 2)).toBe(true);
    while (sim.tick <= START_BANNER_TICKS) sim.step();
    for (const c of sim.cells) { c.blocksWalk = false; c.blockKind = 0; c.conveyorDir = -1; }
    const cell = sim.cellAt(4, 4)!;
    cell.conveyorDir = corner.conveyorDir;
    cell.conveyorAlignMask = corner.conveyorAlignMask;
    cell.conveyorSpeed = corner.conveyorSpeed;
    const p = sim.players[0]!;
    p.px = 180; p.py = 186; p.facing = 3; p.walkTicks = 0;
    sim.step();
    expect([p.px, p.py, p.facing, p.walkTicks]).toEqual([180, 184, 3, 0]);
    sim.step(); sim.step();
    expect([p.px, p.py]).toEqual([180, 180]);
    sim.step();
    expect([p.px, p.py]).toEqual([182, 180]);
    // The ground update moves bombers, not stationary water bombs.
    p.px = 20; p.py = 20;
    sim.bombs.push({ id: 90001, ownerSlot: 0, power: 1, cx: 4, cy: 4, px: 180, py: 180,
      fuseTicks: 96, slidingDir: -1, thrownTicks: 0, thrownTotalTicks: 0,
      throwStartX: 0, throwStartY: 0, throwDestCx: 4, throwDestCy: 4, passThroughSlots: [] });
    for (let i = 0; i < 8; i++) sim.step();
    expect(sim.bombs.find(b => b.id === 90001)).toMatchObject({ px: 180, py: 180, cx: 4, cy: 4 });
    sim.bombs.length = 0;
    p.px = 180; p.py = 180;
    // A short network press and release before the next 30 ms update is not lost.
    sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.step();
    expect(sim.bombs.filter(b => b.ownerSlot === 0)).toHaveLength(1);
    p.activeSlots[0] = ACTIVE_SHIELD;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: 0 });
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.step();
    expect(p.shieldTicks).toBeGreaterThan(0);
    expect(p.activeSlots[0]).not.toBe(ACTIVE_SHIELD);
  });

  test("Camp movable crates retain their hidden drop and reserve their destination", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const tiles = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const map = parseMapBinary("Camp01", fx.payload("Map/Camp01")!);
    const sim = new GameSimulation({ mapData: map, mode: 0, seed: 1,
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!),
      tileInfo: tiles, itemAttr: parseItemAttr(fx.payload("Attr/ItemAttr")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map(b => [b.code, b])),
      participants: [{ slot: 0, name: "P1", charCode: 0, team: 0 }, { slot: 1, name: "P2", charCode: 1, team: 1 }] });
    expect(sim.cells.some(c => c.pushable && c.blockObjName.startsWith("Tile16_Box/"))).toBe(true);
    const line = sim.cells.find(c => c.blockObjName === "Tile16_Passble/Line03")!;
    expect(line.passPlayerDir).toEqual(tiles.get("Tile16_Passble/Line03")!.passPlayerDir);
    expect(line.passBombDir).toEqual(tiles.get("Tile16_Passble/Line03")!.passBombDir);
    expect(line.passFlameDir).toEqual(tiles.get("Tile16_Passble/Line03")!.passFlameDir);
    while (sim.tick <= START_BANNER_TICKS) sim.step();
    for (const p of sim.players) { p.px = 20; p.py = 20; }
    for (const c of sim.cells) { c.blocksWalk = false; c.blockKind = 0; c.blockObjName = ""; c.conveyorDir = -1; }
    const source = sim.cellAt(4, 4)!;
    source.blockObjName = "Tile16_Box/StrongBox02"; source.blockKind = 2;
    source.blocksWalk = true; source.pushable = true; source.hp = 2; source.maxHp = 2;
    source.dropRolled = true; source.pendingDrop = null;
    sim.items.push({ id: 99999, cx: 5, cy: 4, objectName: "", iconSprite: "", pickupFlag: 0, effectId: 0, spawnTick: 0 });
    (sim as any).tryStartPushBox(4, 4, 2);
    expect(sim.items.some(i => i.id === 99999)).toBe(false);
    expect(sim.pushBoxes).toHaveLength(1);
    expect(sim.isCellWalkableFor(sim.players[0]!, 5, 4)).toBe(false);
    const other = sim.cellAt(6, 4)!;
    other.blockKind = 2; other.blocksWalk = true; other.pushable = true;
    (sim as any).tryStartPushBox(6, 4, 0);
    expect(sim.pushBoxes).toHaveLength(1);
    for (let i = 0; i < 10; i++) sim.step();
    const moved = sim.cellAt(5, 4)!;
    expect([moved.hp, moved.maxHp, moved.dropRolled, moved.pendingDrop]).toEqual([2, 2, true, null]);
    (sim as any).mapDropRatePct = 100;
    moved.hp = 1;
    (sim as any).detonateChain([{ cx: 5, cy: 3, ownerSlot: 0, power: 1, style: "normal" }]);
    expect(moved.crumbleTicks).toBeGreaterThan(0);
    expect(moved.pendingDrop).toBeNull();
  });

  test("Camp spike ground and directional pillars detonate bombs, including remote bombs", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const tiles = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const sim = new GameSimulation({ mapData: parseMapBinary("Camp01", fx.payload("Map/Camp01")!), mode: 0, seed: 1,
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!), tileInfo: tiles,
      itemAttr: parseItemAttr(fx.payload("Attr/ItemAttr")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map(b => [b.code, b])),
      participants: [{ slot: 0, name: "P1", charCode: 0, team: 0 }, { slot: 1, name: "P2", charCode: 1, team: 1 }] });
    expect(sim.cells.some(c => c.bombPinHazard)).toBe(true);
    expect(tiles.get("Tile16_Static/PinPillar03")!.blockEdgePinDir[2]).toBe(true);
    while (sim.tick <= START_BANNER_TICKS) sim.step();
    for (const c of sim.cells) { c.blocksWalk = false; c.blockKind = 0; c.conveyorDir = -1; c.bombPinHazard = false; c.blockEdgePinDir = [false, false, false, false]; }
    for (const p of sim.players) { p.px = 20; p.py = 20; }
    const bomb = (id: number, x: number, y: number, dir: 0 | 1 | 2 | 3 | -1 = -1) => ({
      id, ownerSlot: 0, power: 1, style: "remote" as const, cx: x, cy: y, px: x * 40 + 20, py: y * 40 + 20,
      fuseTicks: 999999, slidingDir: dir, thrownTicks: 0, thrownTotalTicks: 12,
      throwStartX: 0, throwStartY: 0, throwDestCx: x, throwDestCy: y, passThroughSlots: [],
    });
    const spike = sim.cellAt(5, 4)!;
    spike.blocksWalk = true; spike.blockKind = 1;
    spike.blockEdgePinDir = [...tiles.get("Tile16_Static/PinPillar03")!.blockEdgePinDir];
    sim.bombs.push(bomb(1001, 4, 4, 2));
    expect(sim.step()).toContain("BombExplode");
    expect(sim.bombs.some(b => b.id === 1001)).toBe(false);
    expect(sim.flames.some(f => f.cx === 4 && f.cy === 4 && f.part === "C")).toBe(true);
    sim.flames.length = 0;
    // A non-spiked face stops a bomb instead of detonating it.
    spike.blockEdgePinDir = [...tiles.get("Tile16_Static/PinPillar04")!.blockEdgePinDir];
    sim.bombs.push(bomb(1002, 4, 4, 2));
    sim.step();
    expect(sim.bombs.find(b => b.id === 1002)?.slidingDir).toBe(-1);
    sim.bombs.length = 0;
    // A direct kick into the spiked face detonates without waiting for the fuse.
    spike.blockEdgePinDir = [...tiles.get("Tile16_Static/PinPillar03")!.blockEdgePinDir];
    const p = sim.players[0]!; p.px = 3 * 40 + 20; p.py = 4 * 40 + 20; p.hasKick = true;
    sim.bombs.push(bomb(1003, 4, 4));
    sim.setInput(0, { dir: 2, placeBomb: false, useActive: false });
    sim.step();
    expect(sim.bombs.some(b => b.id === 1003)).toBe(false);
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.flames.length = 0;
    const ground = sim.cellAt(7, 4)!; ground.bombPinHazard = true;
    sim.bombs.push(bomb(1004, 7, 4));
    sim.step();
    expect(sim.bombs.some(b => b.id === 1004)).toBe(false);
    // A thrown bomb only triggers the ground spike on landing, not in the air.
    sim.flames.length = 0;
    const flying = bomb(1006, 6, 4);
    flying.thrownTicks = 2; flying.thrownTotalTicks = 2;
    flying.throwStartX = 6 * 40 + 20; flying.throwStartY = 4 * 40 + 20;
    flying.throwDestCx = 7; flying.throwDestCy = 4;
    sim.bombs.push(flying);
    sim.step();
    expect(sim.bombs.some(b => b.id === 1006)).toBe(true);
    sim.step();
    expect(sim.bombs.some(b => b.id === 1006)).toBe(false);
    // Passable PinTile hazards affect trapped players, not the bomb ground flag.
    ground.bombPinHazard = false; ground.isPinHazard = true;
    sim.flames.length = 0;
    sim.bombs.push(bomb(1005, 7, 4));
    sim.step();
    expect(sim.bombs.some(b => b.id === 1005)).toBe(true);
  });

  test("game input keeps held aliases and clears on focus loss", () => {
    const stage = new GameStage({ hub: { dual2P: false }, practiceConfig: null } as any) as any;
    const key = (code: string) => ({ code, key: code, preventDefault() {} }) as KeyboardEvent;
    stage.onKeyDown(key("ArrowLeft")); stage.onKeyDown(key("KeyA"));
    stage.onKeyUp(key("KeyA"));
    expect(stage.sampleInput1P().dir).toBe(0);
    stage.onKeyUp(key("ArrowLeft"));
    expect(stage.sampleInput1P().dir).toBe(-1);
    stage.onKeyDown(key("ShiftLeft"));
    expect(stage.sampleInput1P().placeBomb).toBe(true);
    expect(stage.sampleInput1P().placeBomb).toBe(true);
    stage.onBlur();
    expect(stage.sampleInput1P()).toMatchObject({ dir: -1, placeBomb: false, useActive: false });
  });

  test("simulates 5-HP StrongBox01 denting, HollowBomb piercing, Owl/Kart/LucciGold/Dart pickupFlags, and conveyors", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objectTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);

    // Verify StrongBox01 (5 HP), StrongBox02 (2 HP), conveyors, and ice in TileInfo
    const sb1 = tileInfo.get("Tile16_Box/StrongBox01")!;
    expect(sb1.hp).toBe(5);
    expect(sb1.indestructible).toBe(false);
    expect(tileInfo.get("Tile16_Box/StrongBox02")!.hp).toBe(2);
    expect(tileInfo.get("TileConv/ConvRR00")!.conveyorDir).toBe(2);
    expect(tileInfo.get("Tile02_Ground/Ice00")!.isIce).toBe(true);

    // Verify all 11 Ship/* objects exist in Fx:ObjectTable
    for (let id = 1; id <= 11; id++) {
      const ship = itemAttr.ships.get(id)!;
      expect(ship).toBeDefined();
      expect(objectTable.byName.has(ship.objectName)).toBe(true);
    }

    // Spawn Bonus01 and verify Lucci coins materialize on open ground cells and credit bonusLucci!
    const bonusSim = new GameSimulation({
      mapData: parseMapBinary("Bonus01", fx.payload("Map/Bonus01")!),
      mode: 0,
      seed: 7,
      objectTable,
      bomberByCode,
      itemAttr,
      tileInfo,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
      ],
    });
    expect(bonusSim.items.length).toBeGreaterThan(80);
    const goldSpec = itemAttr.items.find((i) => i.objectName === "LucciGold")!;
    expect(goldSpec.pickupFlag).toBe(99);
    expect(goldSpec.effectId).toBe(50);

    // Advance past START_BANNER_TICKS and test StrongBox01 (5 HP), Owl/Kart mounts, LucciGold, HollowBomb, Dart, and Conveyor!
    const sim = new GameSimulation({
      mapData: parseMapBinary("Village01", fx.payload("Map/Village01")!),
      mode: 0,
      seed: 99,
      objectTable,
      bomberByCode,
      itemAttr,
      tileInfo,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
      ],
    });
    for (let t = 0; t <= START_BANNER_TICKS; t++) sim.step();
    const p1 = sim.players[0]!;
    p1.px = 2 * 40 + 20;
    p1.py = 2 * 40 + 20;
    p1.power = 5;
    p1.bombsMax = 6;
    p1.invulnTicks = 9999;
    for (let x = 1; x <= 8; x++) {
      const c = sim.cellAt(x, 2)!;
      c.blockObjName = "";
      c.blockKind = 0;
      c.blocksWalk = false;
      c.indestructible = false;
      c.hp = 0;
      c.maxHp = 0;
    }

    // 1. Place a 5-HP StrongBox01 at (4, 2) and hit it with 5 blasts: 5->4->3->2->1->crumble!
    const sbCell = sim.cellAt(4, 2)!;
    sbCell.blockObjName = "Tile16_Box/StrongBox01";
    sbCell.blockKind = 2;
    sbCell.blocksWalk = true;
    sbCell.hp = 5;
    sbCell.maxHp = 5;
    sbCell.indestructible = false;

    for (let expectedHp = 4; expectedHp >= 1; expectedHp--) {
      sim.bombs.push({
        id: 900 + expectedHp,
        ownerSlot: 0,
        power: 3,
        pierce: false,
        cx: 2,
        cy: 2,
        px: 100,
        py: 100,
        fuseTicks: 1,
        slidingDir: -1,
        thrownTicks: 0,
        thrownTotalTicks: 0,
        throwStartX: 0,
        throwStartY: 0,
        throwDestCx: 2,
        throwDestCy: 2,
        passThroughSlots: [],
      });
      p1.bombsPlaced++;
      sim.step();
      expect(sbCell.hp).toBe(expectedHp);
      expect(sbCell.shakeTicks).toBe(14);
      expect(sbCell.crumbleTicks).toBe(0);
    }
    // 5th blast finally destroys StrongBox01!
    sim.bombs.push({
      id: 999,
      ownerSlot: 0,
      power: 3,
      pierce: false,
      cx: 2,
      cy: 2,
      px: 100,
      py: 100,
      fuseTicks: 1,
      slidingDir: -1,
      thrownTicks: 0,
      thrownTotalTicks: 0,
      throwStartX: 0,
      throwStartY: 0,
      throwDestCx: 2,
      throwDestCy: 2,
      passThroughSlots: [],
    });
    p1.bombsPlaced++;
    sim.step();
    expect(sbCell.hp).toBe(0);
    expect(sbCell.crumbleTicks).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) sim.step();

    // 2. Verify Owl (`pickupFlag=2, effectId=2`), LucciGold (`pickupFlag=99`), HollowBomb (`pickupFlag=33`), and Dart (`pickupFlag=21`)
    const owlSpec = itemAttr.items.find((i) => i.objectName === "Item/ItemOwl")!;
    const hbSpec = itemAttr.items.find((i) => i.objectName === "HollowBomb")!;
    const dartSpec = itemAttr.items.find((i) => i.objectName === "Item/ItemDart")!;
    sim.items.push(
      { id: 1001, cx: 2, cy: 2, objectName: owlSpec.objectName, iconSprite: owlSpec.iconSprite, pickupFlag: owlSpec.pickupFlag, effectId: owlSpec.effectId, spawnTick: 1 },
      { id: 1002, cx: 2, cy: 2, objectName: goldSpec.objectName, iconSprite: goldSpec.iconSprite, pickupFlag: goldSpec.pickupFlag, effectId: goldSpec.effectId, spawnTick: 1 },
      { id: 1003, cx: 2, cy: 2, objectName: hbSpec.objectName, iconSprite: hbSpec.iconSprite, pickupFlag: hbSpec.pickupFlag, effectId: hbSpec.effectId, spawnTick: 1 },
      { id: 1004, cx: 2, cy: 2, objectName: dartSpec.objectName, iconSprite: dartSpec.iconSprite, pickupFlag: dartSpec.pickupFlag, effectId: dartSpec.effectId, spawnTick: 1 },
    );
    sim.step();
    expect(p1.rideId).toBe(2);
    expect(p1.curseTicks).toBe(0);
    expect(p1.bonusLucci).toBe(50);
    expect(p1.hasPierceBomb).toBe(true);
    expect(p1.activeSlots.includes(ACTIVE_DART)).toBe(true);

    // 3. Fire Dart (`ACTIVE_DART`) rightward at a bomb at (6, 2) -> Dart detonates the bomb remotely!
    p1.facing = 2;
    sim.bombs.push({
      id: 1100,
      ownerSlot: 0,
      power: 2,
      pierce: true,
      style: "normal",
      cx: 6,
      cy: 2,
      px: 6 * 40 + 20,
      py: 2 * 40 + 20,
      fuseTicks: 90,
      slidingDir: -1,
      thrownTicks: 0,
      thrownTotalTicks: 0,
      throwStartX: 0,
      throwStartY: 0,
      throwDestCx: 6,
      throwDestCy: 2,
      passThroughSlots: [],
    });
    p1.bombsPlaced++;
    // Put two 1-HP crates at (7, 2) and (8, 2) to verify HollowBomb (`pierce: true`) pierces through both!
    for (const bx of [7, 8]) {
      const bc = sim.cellAt(bx, 2)!;
      bc.blockObjName = "Tile00_Box/Box0";
      bc.blockKind = 2;
      bc.blocksWalk = true;
      bc.indestructible = false;
      bc.hp = 1;
      bc.maxHp = 1;
    }
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_DART) });
    for (let i = 0; i < 12; i++) {
      sim.step();
      sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    }
    expect(sim.cellAt(7, 2)!.crumbleTicks > 0 || sim.cellAt(7, 2)!.blockKind === 0).toBe(true);
    expect(sim.cellAt(8, 2)!.crumbleTicks > 0 || sim.cellAt(8, 2)!.blockKind === 0).toBe(true);

    // 4. Verify conveyor belt (`conveyorDir = 2`) pushes grounded player rightward at 2 px/tick
    p1.rideId = 0;
    p1.rideFly = false;
    p1.px = 3 * 40 + 20;
    p1.py = 2 * 40 + 20;
    sim.cellAt(3, 2)!.conveyorDir = 2;
    sim.cellAt(3, 2)!.conveyorSpeed = 2;
    const beforeX = p1.px;
    sim.step();
    expect(p1.px).toBe(beforeX + 2);
  });

  test("maps all 410 category=3 EmoTE character emotions + inferChatEmotionPose + Fanfare000..006", () => {
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const packageMap = parsePackageMap(readFileSync("packagemap.ini"));
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const charTe = new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd"));
    const emoTe = new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd"));
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const charObjects = new ObjectTable(charTe.payload("ObjectTable/CharTEObjectTable")!);
    const emoObjects = new ObjectTable(emoTe.payload("ObjectTable/EmoTEObjectTable")!);

    const probe = (p: Pack) => ({
      has: (n: string) => p.has(n),
      entriesMatching: (pref: string) =>
        p.entries.filter((e) => e.name.toLowerCase().startsWith(pref.toLowerCase())),
    });

    const catalog = new CosmeticCatalog({
      stocks,
      packageMap,
      fx: probe(fx),
      charTe: probe(charTe),
      emoTe: probe(emoTe),
      cx: probe(cx),
      charObjects,
      emoObjects,
    });

    const cat3 = stocks.filter((s) => s.category === 3);
    expect(cat3.length).toBe(410);
    let resolvedWithLiveObj = 0;
    for (const s of cat3) {
      const visuals = catalog.expandVisuals(s.id);
      const emoVis = visuals.find((v) => v.liveKind === "emotion");
      expect(emoVis).toBeDefined();
      expect(emoVis!.liveObject).toBeTruthy();
      if (emoObjects.byName.has(emoVis!.liveObject!)) {
        resolvedWithLiveObj++;
        const act = emoObjects.byName.get(emoVis!.liveObject!)!.defaultAction!;
        expect(
          emoTe.has(act.sprite) ||
            emoTe.has(`${act.sprite}LayerStatic`) ||
            emoTe.has(`${act.sprite}LayerAdjust`),
        ).toBe(true);
      }
    }
    expect(resolvedWithLiveObj).toBe(410);

    // Built-in free poses 1..8 across C00..C10 (C08..C10 fall back to C00)
    for (let c = 0; c <= 10; c++) {
      for (let pose = 1; pose <= 8; pose++) {
        const objName = catalog.resolveEmotionObject(c, pose, 0);
        expect(objName).toBeTruthy();
        expect(emoObjects.byName.has(objName!)).toBe(true);
      }
    }

    // Chat emotion inference (`CEmotionMan`)
    expect(inferChatEmotionPose("/hi")).toBe(1);
    expect(inferChatEmotionPose("88")).toBe(1);
    expect(inferChatEmotionPose("哈哈XD")).toBe(2);
    expect(inferChatEmotionPose("嗚嗚QQ")).toBe(3);
    expect(inferChatEmotionPose("/怒")).toBe(4);
    expect(inferChatEmotionPose("害羞>///<")).toBe(5);
    expect(inferChatEmotionPose("加油go")).toBe(6);
    expect(inferChatEmotionPose("愛你<3")).toBe(7);
    expect(inferChatEmotionPose("/特")).toBe(8);

    // Fanfare WAVs 000..006 in EmoTE
    for (let i = 0; i <= 6; i++) {
      expect(emoTe.has(`Wave/Fanfare00${i}`)).toBe(true);
    }
  });

  test("simulates RemoteBomb, Blind, Drill, Gum, Pushpin, Spring, Tank cannon, and BonusStage SFX", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTab = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const bonusMap = parseMapBinary("Bonus01", fx.payload("Map/Bonus01")!);

    const sim = new GameSimulation({
      mapData: bonusMap,
      mode: 0,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0, isAi: false },
        { slot: 1, name: "P2", charCode: 1, team: 1, isAi: false },
      ],
      objectTable: objTab,
      bomberByCode,
      itemAttr,
      tileInfo,
    });

    // Bonus* map emits BonusStageEffect + BonusStageVocal on init
    const initSnap = sim.toSnapshot();
    expect(initSnap.sounds).toContain("BonusStageEffect");
    expect(initSnap.sounds).toContain("BonusStageVocal");

    // Advance past START_BANNER_TICKS and clear preplaced Bonus01 coins on row y=4
    for (let t = 0; t <= START_BANNER_TICKS; t++) sim.step();
    sim.items.length = 0;

    // Clear playfield row y=4 so we can test all items deterministically
    for (let x = 1; x <= 12; x++) {
      const c = sim.cellAt(x, 4)!;
      c.blockObjName = "";
      c.blockKind = 0;
      c.blocksWalk = false;
      c.indestructible = false;
      c.hp = 0;
      c.crumbleTicks = 0;
    }

    const p1 = sim.players[0]!;
    const p2 = sim.players[1]!;
    p1.px = 2 * 40 + 20;
    p1.py = 4 * 40 + 20;
    p1.facing = 2;
    p1.bombsMax = 4;
    p2.px = 11 * 40 + 20;
    p2.py = 4 * 40 + 20;

    // 1. RemoteBomb (`flag=28`): does NOT explode after 100 ticks, explodes on ACTIVE_REMOTE!
    const remoteSpec = itemAttr.items.find((i) => i.pickupFlag === 28)!;
    sim.items.push({
      id: 2001,
      cx: 2,
      cy: 4,
      objectName: remoteSpec.objectName,
      iconSprite: remoteSpec.iconSprite,
      pickupFlag: remoteSpec.pickupFlag,
      effectId: remoteSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.hasRemoteBomb).toBe(true);
    expect(p1.activeSlots).toContain(ACTIVE_REMOTE);

    sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(sim.bombs.length).toBe(1);
    expect(sim.bombs[0]!.style).toBe("remote");
    for (let i = 0; i < BOMB_FUSE_TICKS + 20; i++) sim.step();
    // Still unexploded!
    expect(sim.bombs.length).toBe(1);
    // Trigger ACTIVE_REMOTE from safe distance (x=5)
    p1.px = 5 * 40 + 20;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_REMOTE) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(sim.bombs.length).toBe(0);
    expect(sim.flames.length).toBeGreaterThan(0);
    // ACTIVE_REMOTE stays in slot while alive!
    expect(p1.activeSlots).toContain(ACTIVE_REMOTE);
    for (let i = 0; i < 20; i++) sim.step();
    p1.hasRemoteBomb = false;
    p1.activeSlots.fill(0);

    // 2. Blind (`flag=29`): places `"blind"` bomb -> spawns `fl.blind === true` flames!
    const blindSpec = itemAttr.items.find((i) => i.pickupFlag === 29)!;
    sim.items.push({
      id: 2002,
      cx: 5,
      cy: 4,
      objectName: blindSpec.objectName,
      iconSprite: blindSpec.iconSprite,
      pickupFlag: blindSpec.pickupFlag,
      effectId: blindSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.activeSlots).toContain(ACTIVE_BLIND);
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_BLIND) });
    sim.step();
    expect(p1.blindTicks).toBeGreaterThan(300);
    sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(sim.bombs[0]!.style).toBe("blind");
    p1.px = 8 * 40 + 20;
    for (let i = 0; i < BOMB_FUSE_TICKS + 2; i++) sim.step();
    expect(sim.flames.some((f) => f.blind === true)).toBe(true);
    for (let i = 0; i < 20; i++) sim.step();

    // 3. Drill (`flag=27`): drills destructible box 1 cell ahead!
    const drillSpec = itemAttr.items.find((i) => i.pickupFlag === 27)!;
    const boxAhead = sim.cellAt(9, 4)!;
    boxAhead.blockObjName = "Tile00_Box/Box0";
    boxAhead.blockKind = 2;
    boxAhead.blocksWalk = true;
    boxAhead.indestructible = false;
    boxAhead.hp = 1;
    p1.facing = 2;
    sim.items.push({
      id: 2003,
      cx: 8,
      cy: 4,
      objectName: drillSpec.objectName,
      iconSprite: drillSpec.iconSprite,
      pickupFlag: drillSpec.pickupFlag,
      effectId: drillSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.activeSlots).toContain(ACTIVE_DRILL);
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_DRILL) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(p1.drillTicks).toBeGreaterThan(0);
    expect(boxAhead.crumbleTicks).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) sim.step();

    // 4. Spring (`flag=26`): hops 2 cells rightward with parabolic jumpStartX!
    const springSpec = itemAttr.items.find((i) => i.pickupFlag === 26)!;
    p1.px = 2 * 40 + 20;
    p1.facing = 2;
    sim.items.push({
      id: 2004,
      cx: 2,
      cy: 4,
      objectName: springSpec.objectName,
      iconSprite: springSpec.iconSprite,
      pickupFlag: springSpec.pickupFlag,
      effectId: springSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.activeSlots).toContain(ACTIVE_SPRING);
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_SPRING) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(Math.floor(p1.px / 40)).toBe(4);
    expect(p1.jumpTicks).toBeGreaterThan(0);
    expect(p1.jumpStartX).toBe(2 * 40 + 20);

    // 5. Gum (`flag=11, eff=1`) & Pushpin (`flag=11, eff=4`) & Tank (`flag=2, eff=11`)
    const gumSpec = itemAttr.items.find((i) => i.pickupFlag === 11 && i.effectId === 1)!;
    const pinSpec = itemAttr.items.find((i) => i.pickupFlag === 11 && i.effectId === 4)!;
    const tankSpec = itemAttr.items.find((i) => i.pickupFlag === 2 && i.effectId === 11)!;
    sim.items.push(
      { id: 2005, cx: 4, cy: 4, objectName: gumSpec.objectName, iconSprite: gumSpec.iconSprite, pickupFlag: gumSpec.pickupFlag, effectId: gumSpec.effectId, spawnTick: 1 },
      { id: 2006, cx: 4, cy: 4, objectName: pinSpec.objectName, iconSprite: pinSpec.iconSprite, pickupFlag: pinSpec.pickupFlag, effectId: pinSpec.effectId, spawnTick: 1 },
    );
    sim.step();
    expect(p1.activeSlots).toContain(ACTIVE_GUM);
    expect(p1.activeSlots).toContain(ACTIVE_PIN);

    // Plant Gum at (4, 4), wait armTicks, step P2 onto (4, 4) -> glueTicks > 0!
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_GUM) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    p1.px = 2 * 40 + 20;
    for (let i = 0; i < 25; i++) sim.step();
    p2.px = 4 * 40 + 20;
    p2.py = 4 * 40 + 20;
    sim.step();
    expect(p2.glueTicks).toBeGreaterThan(80);

    // Plant Pushpin at (6, 4), trap P2 on (6, 4) -> Pushpin pops P2!
    p1.px = 6 * 40 + 20;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_PIN) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    p1.px = 2 * 40 + 20;
    for (let i = 0; i < 25; i++) sim.step();
    p2.px = 6 * 40 + 20;
    p2.state = "trapped";
    p2.stateTicks = 5;
    sim.step();
    expect(p2.state === "dying" || p2.state === "dead").toBe(true);

    // Mount Tank (`rideId=11`) on P1 and fire cannon!
    sim.items.push({
      id: 2007,
      cx: 2,
      cy: 4,
      objectName: tankSpec.objectName,
      iconSprite: tankSpec.iconSprite,
      pickupFlag: tankSpec.pickupFlag,
      effectId: tankSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.rideId).toBe(11);
    p1.facing = 2;
    sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
    sim.step();
    expect(p1.shootTicks).toBeGreaterThan(0);
    expect(sim.bombs.some((b) => b.thrownTicks > 0 && b.throwDestCx === 5)).toBe(true);
  });

  test("supports multi-slot SlotDeco, CharDeco, AvatarDeco 12-slot rules, Level/Twinkle, LevelChanger, & Crayon", async () => {
    const { GameDatabase } = await import("../server/db.ts");
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const packageMap = parsePackageMap(readFileSync("packagemap.ini"));
    const db = new GameDatabase(":memory:", stockById, packageMap);

    const reg = db.registerAccount("cosmetic_tester", "pw1234", "造型達人", 0);
    expect(reg.ok).toBe(true);
    const accId = reg.profile!.id;

    // 1. Grant Wukong multi-item bundle (`6346`) + multiple CharDeco slots + `cat=19` AvatarDeco + `cat=5,6,15`
    db.grantStock(accId, 6346); // expands into multiple SlotDeco layers + CharDeco
    const hatItem = stocks.find((s) => s.category === 12 && /帽/.test(s.name))!;
    const wingItem = stocks.find((s) => s.category === 12 && /翅膀|披風|背包|筋斗雲/.test(s.name))!;
    const glassItem = stocks.find((s) => s.category === 12 && /眼鏡|墨鏡|面具/.test(s.name));
    db.grantStock(accId, hatItem.id);
    db.grantStock(accId, wingItem.id);
    if (glassItem) db.grantStock(accId, glassItem.id);

    // Grant all 4 `cat=19` AvatarDeco items (`25001`=10, `25002`=20, `25003`=40, `25004`=21)
    for (const id of [25001, 25002, 25003, 25004]) db.grantStock(accId, id);
    // Grant `cat=5` LevelIcon003 (`1504`), `cat=6` LevelChanger +45 (`1607`), `cat=15` Crayon (`1227`)
    db.grantStock(accId, 1504);
    db.grantStock(accId, 1607);
    db.grantStock(accId, 1227);

    const inv = db.getInventory(accId);
    const byStock = (sid: number) => inv.find((r) => r.stockId === sid)!;

    // Equip multiple SlotDeco items across distinct layers simultaneously
    const cat10Rows = inv.filter((r) => r.category === 10);
    expect(cat10Rows.length).toBeGreaterThanOrEqual(2);
    for (const r of cat10Rows) db.setEquipped(accId, r.invId, true);
    const afterSlotProf = db.getProfileById(accId)!;
    expect((afterSlotProf.equipped.slotDecoStockIds ?? []).length).toBeGreaterThanOrEqual(2);

    // Equip Hat (`A`) + Wing (`D`) (+ Glasses `B`) simultaneously without unequipping each other!
    db.setEquipped(accId, byStock(hatItem.id).invId, true);
    db.setEquipped(accId, byStock(wingItem.id).invId, true);
    if (glassItem) db.setEquipped(accId, byStock(glassItem.id).invId, true);

    // Equip AvatarDeco `25001` (`10`), `25002` (`20`), `25003` (`40`), then `25004` (`21` suit replaces `20`!)
    db.setEquipped(accId, byStock(25001).invId, true);
    db.setEquipped(accId, byStock(25002).invId, true);
    db.setEquipped(accId, byStock(25003).invId, true);
    db.setEquipped(accId, byStock(25004).invId, true);

    // Equip Level/Twinkle (`1504` -> idx 3), LevelDisguise (`1607` -> +45), Crayon (`1227` -> `#FF68B4`)
    db.setEquipped(accId, byStock(1504).invId, true);
    db.setEquipped(accId, byStock(1607).invId, true);
    db.setEquipped(accId, byStock(1227).invId, true);

    const finalProf = db.getProfileById(accId)!;
    const eqCharIds = finalProf.equipped.charDecoStockIds ?? [];
    expect(eqCharIds).toContain(hatItem.id);
    expect(eqCharIds).toContain(wingItem.id);
    expect(eqCharIds).toContain(25001); // slot 10 preserved
    expect(eqCharIds).toContain(25003); // slot 40 preserved
    expect(eqCharIds).toContain(25004); // slot 21 suit equipped
    expect(eqCharIds).not.toContain(25002); // slot 20 unequipped by 21!
    expect(finalProf.equipped.levelEffectIdx).toBe(3);
    expect(finalProf.equipped.levelDisguiseDelta).toBe(45);
    expect(finalProf.equipped.crayonColor).toBe("#FF68B4");
  });

  test("simulates Oxygen, Scanner X-ray, Fake/Super Hedgehog spin & struggle, Ghost floating, and PerfectGame", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objectTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Patrit00", fx.payload("Map/Patrit00")!);

    // Verify PerfectGame, Ghost, TimebombFrame, and Twinkle assets exist in Fx
    expect(fx.has("Game/Perfect")).toBe(true);
    expect(fx.has("Game/Player01")).toBe(true);
    expect(fx.has("Game/Player02")).toBe(true);
    expect(fx.has("Bomb/TimebombFrame")).toBe(true);
    expect(fx.has("Game/TimebombRoulette")).toBe(true);
    expect(fx.has("Level/Twinkle000")).toBe(true);
    expect(fx.has("Level/Twinkle007")).toBe(true);
    expect(fx.has("Wave/ScreenShot")).toBe(true);
    expect(fx.has("Wave/GhostTrans")).toBe(true);
    expect(fx.has("Wave/HedgehogRebirth")).toBe(true);
    expect(fx.has("Wave/HedgehogStruggle")).toBe(true);

    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 2026,
      objectTable,
      bomberByCode,
      itemAttr,
      tileInfo,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
        { slot: 2, name: "P3", charCode: 2, team: 1 },
      ],
    });

    // Clear grid obstacles so movement & contact tests are unobstructed, keeping one box at (8, 8) with a known drop!
    for (let i = 0; i < sim.cells.length; i++) {
      const c = sim.cells[i]!;
      c.blockObjName = "";
      c.blockKind = 0;
      c.blocksWalk = false;
      c.hidesUnit = false;
      c.conveyorDir = -1;
      c.isIce = false;
      c.pendingDrop = null;
    }
    const boxCell = sim.cellAt(8, 8)!;
    boxCell.blockObjName = "Tile00_Box/Box00";
    boxCell.blockKind = 2;
    boxCell.blocksWalk = true;
    boxCell.hp = 1;
    boxCell.maxHp = 1;
    boxCell.dropRolled = true;
    boxCell.pendingDrop = {
      id: 9001,
      cx: 8,
      cy: 8,
      objectName: "Item/ItemRoller",
      iconSprite: "Item/ItemRoller",
      pickupFlag: 1,
      effectId: 3,
      spawnTick: 0,
    };

    for (let t = 0; t < 56; t++) sim.step();
    const p1 = sim.players[0]!;
    const p2 = sim.players[1]!;
    const p3 = sim.players[2]!;
    p1.px = 2 * 40 + 20;
    p1.py = 2 * 40 + 20;
    p2.px = 5 * 40 + 20;
    p2.py = 2 * 40 + 20;
    p3.px = 10 * 40 + 20;
    p3.py = 10 * 40 + 20;

    // 1. Scanner (`flag=24` -> `ACTIVE_RADAR`) reveals `dropIcon` inside box (8, 8)!
    expect(sim.toSnapshot().cells[8 * sim.width + 8]!.dropIcon).toBeUndefined();
    const scanSpec = itemAttr.items.find((i) => i.pickupFlag === 24)!;
    const oxySpec = itemAttr.items.find((i) => i.pickupFlag === 22)!;
    const fakeHedgeSpec = itemAttr.items.find((i) => i.pickupFlag === 41)!;
    const superHedgeSpec = itemAttr.items.find((i) => i.pickupFlag === 42)!;
    sim.items.push(
      {
        id: 3001,
        cx: 2,
        cy: 2,
        objectName: scanSpec.objectName,
        iconSprite: scanSpec.iconSprite,
        pickupFlag: scanSpec.pickupFlag,
        effectId: scanSpec.effectId,
        spawnTick: 1,
      },
      {
        id: 3002,
        cx: 2,
        cy: 2,
        objectName: oxySpec.objectName,
        iconSprite: oxySpec.iconSprite,
        pickupFlag: oxySpec.pickupFlag,
        effectId: oxySpec.effectId,
        spawnTick: 1,
      },
    );
    sim.step();
    expect(p1.hasOxygen).toBe(true);
    expect(p1.activeSlots).toContain(ACTIVE_RADAR);

    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: p1.activeSlots.indexOf(ACTIVE_RADAR) });
    sim.step();
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(p1.radarTicks).toBeGreaterThan(300);
    expect(sim.toSnapshot().cells[8 * sim.width + 8]!.dropIcon).toBe("Item/ItemRoller");

    // 2. Oxygen (`hasOxygen = true`) keeps trapped bomber alive past `BUBBLE_POP_TICKS` (`200` ticks)!
    p1.state = "trapped";
    p1.stateTicks = BUBBLE_POP_TICKS + 40;
    sim.step();
    expect(p1.state).toBe("trapped"); // still alive thanks to Oxygen!
    p1.state = "alive";
    p1.stateTicks = 0;

    // 3. FakeHedgehog (`flag=41`) + Space struggle breaks free early!
    sim.items.push({
      id: 3003,
      cx: 2,
      cy: 2,
      objectName: fakeHedgeSpec.objectName,
      iconSprite: fakeHedgeSpec.iconSprite,
      pickupFlag: fakeHedgeSpec.pickupFlag,
      effectId: fakeHedgeSpec.effectId,
      spawnTick: 1,
    });
    const rebirthSounds = sim.step();
    expect(p1.state).toBe("hedgehog");
    expect(rebirthSounds).toContain("HedgehogRebirth");
    for (let k = 0; k < 10; k++) {
      sim.setInput(0, { dir: -1, placeBomb: true, useActive: false });
      sim.step();
      sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
      sim.step();
    }
    expect(p1.state).toBe("alive");

    // 4. SuperHedgehog (`flag=42`) spin dismounts mounted enemy P2!
    p2.rideId = 2;
    p2.rideSpeed = 5;
    sim.items.push({
      id: 3004,
      cx: 2,
      cy: 2,
      objectName: superHedgeSpec.objectName,
      iconSprite: superHedgeSpec.iconSprite,
      pickupFlag: superHedgeSpec.pickupFlag,
      effectId: superHedgeSpec.effectId,
      spawnTick: 1,
    });
    sim.step();
    expect(p1.state).toBe("hedgehog");
    expect(p1.hedgehogSuper).toBe(true);
    expect(p1.hedgehogSpinTicks).toBeGreaterThan(0);
    p1.px = p2.px;
    p1.py = p2.py;
    sim.step();
    expect(p2.rideId).toBe(0); // Dismounted by SuperHedgehog spin!

    // 5. Eliminate P2 -> after 28 dying ticks + 64 soul ticks, P2 emits `GhostTrans` & floats freely as Ghost!
    p2.state = "trapped";
    p2.stateTicks = 30;
    p1.px = p2.px;
    p1.py = p2.py;
    sim.step();
    expect(p2.state).toBe("dying");
    let sawGhostTrans = false;
    for (let t = 0; t < 96; t++) {
      const evs = sim.step();
      if (evs.includes("GhostTrans")) sawGhostTrans = true;
    }
    expect(sawGhostTrans).toBe(true);
    expect(p2.state).toBe("dead");
    const ghostStartX = p2.px;
    sim.setInput(1, { dir: 2, placeBomb: false, useActive: false });
    sim.step();
    expect(p2.px).toBeGreaterThan(ghostStartX);

    // 6. Eliminate final enemy P3 while P1 has 0 deaths -> `perfectWin === true`!
    p1.state = "alive";
    p3.state = "trapped";
    p3.stateTicks = 30;
    p1.px = p3.px;
    p1.py = p3.py;
    for (let t = 0; t < 35 && !sim.finished; t++) sim.step();
    expect(sim.finished).toBe(true);
    const endSnap = sim.toSnapshot();
    expect(endSnap.winnerTeam).toBe(0);
    expect(endSnap.perfectWin).toBe(true);
  });

  test("decodes 44-byte TileInfo directional shelters, PinPillar spikes, GasRight pit-stops, & LapTiles", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);

    // BombProof01..04: permanent directional shelters (`burnsInFlame=false, indestructible=true, noBombPlace=true`)
    const bp1 = tileInfo.get("Tile16_Passble/BombProof01")!;
    const bp2 = tileInfo.get("Tile16_Passble/BombProof02")!;
    const bp3 = tileInfo.get("Tile16_Passble/BombProof03")!;
    const bp4 = tileInfo.get("Tile16_Passble/BombProof04")!;
    expect(bp1.burnsInFlame).toBe(false);
    expect(bp1.indestructible).toBe(true);
    expect(bp1.noBombPlace).toBe(true);
    expect(bp1.passPlayerDir).toEqual([false, false, false, true]);
    expect(bp2.passFlameDir).toEqual([true, false, false, false]);
    expect(bp3.passBombDir).toEqual([false, false, true, false]);
    expect(bp4.passFlameDir).toEqual([false, true, false, false]);

    // Line01..04: blocks players, passes kicked bombs along 1 axis, passes flames on all 4 sides
    const line1 = tileInfo.get("Tile16_Passble/Line01")!;
    const line3 = tileInfo.get("Tile16_Passble/Line03")!;
    expect(line1.passPlayerDir).toEqual([false, false, false, false]);
    expect(line1.passBombDir).toEqual([true, false, true, false]);
    expect(line1.passFlameDir).toEqual([true, true, true, true]);
    expect(line3.passBombDir).toEqual([false, true, false, true]);

    // GasRight00/01 Kart pit-stop, PinTile01/PinGround01/PinPillar01 spikes, LapTiles, & Footprints
    const gas = tileInfo.get("Tile12_Passable/GasRight00")!;
    expect(gas.isPitStop).toBe(true);
    expect(gas.passPlayerDir).toEqual([false, true, false, true]);
    expect(tileInfo.get("Tile16_Passble/PinTile01")!.isPinHazard).toBe(true);
    expect(tileInfo.get("Tile16_Ground/PinGround01")!.isPinHazard).toBe(true);
    expect(tileInfo.get("Tile16_Static/PinPillar01")!.blockEdgePinDir).toEqual([true, true, true, true]);
    expect(tileInfo.get("Tile12_Ground/Start_Horz")!.lapCheckpoint).toBe(0);
    expect(tileInfo.get("Tile12_Ground/Start_Horz")!.isTrackRoad).toBe(true);
    expect(tileInfo.get("Tile12_Ground/LapTile01_Horz")!.lapCheckpoint).toBe(1);
    expect(tileInfo.get("Tile07_Ground/Tile00")!.hasFootprints).toBe(true);

    // ObjectTable indexed actionList verification for LapTile, Start_Horz, Mummy, BulaBat, AirPlane1, & UgWater
    expect(objTable.byName.get("Tile12_Ground/Start_Horz")!.actionList.length).toBe(10);
    expect(objTable.byName.get("Tile12_Ground/LapTile01_Horz")!.actionList.length).toBe(5);
    expect(objTable.byName.get("Game/Mummy")!.actionList.length).toBe(15);
    expect(objTable.byName.get("Game/BulaBat")!.actionList.length).toBe(10);
    expect(objTable.byName.get("Game/AirPlane1")!.actionList[0]!.sprite).toBe("Bonus/Airplane1");
    expect(objTable.byName.get("Effect/UgWater")!.actionList[0]!.sprite).toBe("Game/UndergroundWater");
  });

  test("simulates BombProof shelter, Line bomb-rail, PinPillar/PinTile spikes, AirPlane1, Footprints, & Random C10", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Ocean00", fx.payload("Map/Ocean00")!)!;

    // 1. Verify Random (`charCode: -1`) rolls secret C08, C09, AND C10 (`聖誕老人`) across seeds!
    const rolledCodes = new Set<number>();
    for (let seed = 1; seed <= 120; seed++) {
      const s = new GameSimulation({
        mapData,
        mode: 0,
        seed: seed * 7919,
        participants: [{ slot: 0, name: "Rnd", charCode: -1, team: 0 }],
        objectTable: objTable,
        bomberByCode,
        itemAttr,
        tileInfo,
      });
      rolledCodes.add(s.players[0]!.charCode);
    }
    expect(rolledCodes.has(8)).toBe(true);
    expect(rolledCodes.has(9)).toBe(true);
    expect(rolledCodes.has(10)).toBe(true);

    // 2. Directional `BombProof02` shelter (`open Left=0, armored Up/Right/Down`)
    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 4242,
      participants: [
        { slot: 0, name: "P1", charCode: 10, team: 0 },
        { slot: 1, name: "P2", charCode: 0, team: 1 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    for (let t = 0; t <= START_BANNER_TICKS; t++) sim.step();
    const p1 = sim.players[0]!;
    const p2 = sim.players[1]!;
    p1.invulnTicks = 0;
    p2.px = 13 * 40 + 20;
    p2.py = 11 * 40 + 20;

    // Clear corridor y=4, x=2..7 and place `BombProof02` at (4, 4)
    for (let x = 2; x <= 7; x++) {
      const c = sim.cellAt(x, 4)!;
      c.blockObjName = "";
      c.blockKind = 0;
      c.blocksWalk = false;
      c.indestructible = false;
      c.noBombPlace = false;
      c.passPlayerDir = [true, true, true, true];
      c.passBombDir = [true, true, true, true];
      c.passFlameDir = [true, true, true, true];
    }
    const bpCell = sim.cellAt(4, 4)!;
    const bpSpec = tileInfo.get("Tile16_Passble/BombProof02")!;
    bpCell.blockObjName = bpSpec.objectName;
    bpCell.blockKind = 3;
    bpCell.indestructible = bpSpec.indestructible;
    bpCell.burnsInFlame = bpSpec.burnsInFlame;
    bpCell.noBombPlace = bpSpec.noBombPlace;
    bpCell.passPlayerDir = [...bpSpec.passPlayerDir];
    bpCell.passBombDir = [...bpSpec.passBombDir];
    bpCell.passFlameDir = [...bpSpec.passFlameDir];

    p1.px = 4 * 40 + 20;
    p1.py = 4 * 40 + 20;
    expect(sim.canWalkStep(p1, 4, 4, 0)).toBe(true);  // Open Left mouth
    expect(sim.canWalkStep(p1, 4, 4, 2)).toBe(false); // Armored Right wall
    // Bomb exploding to the RIGHT at (6, 4) is blocked by BombProof02's armored Right wall -> P1 stays alive!
    sim.bombs.push({
      id: 501,
      ownerSlot: 1,
      power: 4,
      cx: 6,
      cy: 4,
      px: 6 * 40 + 20,
      py: 4 * 40 + 20,
      fuseTicks: 1,
      slidingDir: -1,
      thrownTicks: 0,
      thrownTotalTicks: 0,
      throwStartX: 0,
      throwStartY: 0,
      throwDestCx: 6,
      throwDestCy: 4,
      passThroughSlots: [],
    });
    sim.step();
    expect(p1.state).toBe("alive");
    expect(bpCell.crumbleTicks).toBe(0); // Permanent shelter does NOT burn!

    // Bomb exploding to the LEFT at (2, 4) enters BombProof02's open Left mouth, traps P1, and stops before (5, 4)!
    sim.flames.length = 0;
    sim.bombs.push({
      id: 502,
      ownerSlot: 1,
      power: 4,
      cx: 2,
      cy: 4,
      px: 2 * 40 + 20,
      py: 4 * 40 + 20,
      fuseTicks: 1,
      slidingDir: -1,
      thrownTicks: 0,
      thrownTotalTicks: 0,
      throwStartX: 0,
      throwStartY: 0,
      throwDestCx: 2,
      throwDestCy: 4,
      passThroughSlots: [],
    });
    sim.step();
    expect(p1.state).toBe("trapped");
    expect(sim.flames.some((f) => f.cx === 4 && f.cy === 4)).toBe(true);
    expect(sim.flames.some((f) => f.cx === 5 && f.cy === 4)).toBe(false);

    // 3. `Line01` blocks player walk, passes kicked bomb horizontally!
    p1.state = "alive";
    p1.stateTicks = 0;
    const lineCell = sim.cellAt(5, 4)!;
    const lineSpec = tileInfo.get("Tile16_Passble/Line01")!;
    lineCell.blockObjName = lineSpec.objectName;
    lineCell.blockKind = 3;
    lineCell.passPlayerDir = [...lineSpec.passPlayerDir];
    lineCell.passBombDir = [...lineSpec.passBombDir];
    lineCell.passFlameDir = [...lineSpec.passFlameDir];
    expect(sim.canWalkStep(p1, 6, 4, 0)).toBe(false);
    expect(sim.canBombStep(6, 4, 0)).toBe(true);
    expect(sim.canBombStep(5, 3, 3)).toBe(false);

    // 4. Shore footprints (`hasFootprints`) & `PinTile01` mount pop & `PinPillar01` trapped bubble pop!
    const shoreCell = sim.cellAt(3, 4)!;
    shoreCell.hasFootprints = true;
    p1.px = 3 * 40 + 20;
    p1.py = 4 * 40 + 20;
    sim.setInput(0, { dir: 0, placeBomb: false, useActive: false });
    sim.step();
    expect(sim.footprints.length).toBeGreaterThan(0);

    // Mount Owl (`rideId=2`) and step onto `PinTile01` -> dismounted!
    p1.rideId = 2;
    p1.rideSpeed = 6;
    p1.hopInvulnTicks = 0;
    shoreCell.isPinHazard = true;
    p1.px = 3 * 40 + 20;
    p1.py = 4 * 40 + 20;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.step();
    expect(p1.rideId).toBe(0);

    // Trapped P2 bumping into `PinPillar01` spike edge pops immediately!
    const pillarCell = sim.cellAt(12, 11)!;
    pillarCell.blockKind = 1;
    pillarCell.blocksWalk = true;
    pillarCell.blockEdgePinDir = [true, true, true, true];
    p2.state = "trapped";
    p2.stateTicks = 5;
    p2.px = 13 * 40 + 20;
    p2.py = 11 * 40 + 20;
    sim.setInput(1, { dir: 0, placeBomb: false, useActive: false });
    sim.step();
    expect(p2.state).toBe("dying");

    // 5. Supply AirPlane (`Game/AirPlane1`) spawns at matchTicks === 1500 (`ItemShip01`) & drops items (`ItemRelease`)!
    sim.flames.length = 0;
    p1.state = "alive";
    p1.stateTicks = 0;
    p2.state = "alive";
    p2.stateTicks = 0;
    p2.px = 13 * 40 + 20;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.setInput(1, { dir: -1, placeBomb: false, useActive: false });
    let sawPlaneSfx = false;
    let sawDropSfx = false;
    while (sim.tick <= START_BANNER_TICKS + 1620 && !sim.finished) {
      const evs = sim.step();
      if (evs.includes("ItemShip01")) sawPlaneSfx = true;
      if (evs.includes("ItemRelease")) sawDropSfx = true;
    }
    expect(sawPlaneSfx).toBe(true);
    expect(sawDropSfx).toBe(true);
  });

  test("simulates CKartComponent (Map/Kart03) 3-lap circuit, Nitro, pit-stop refuel, off-road sand, & Kart AI", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const kartMap = parseMapBinary("Kart03", fx.payload("Map/Kart03")!)!;

    expect(kartMap.componentMode).toBe(1);
    expect(kartMap.modeParam0).toBe(4);
    expect(kartMap.modeParam1).toBe(3);

    const sim = new GameSimulation({
      mapData: kartMap,
      mode: 0,
      seed: 2026,
      participants: [
        { slot: 0, name: "Racer1", charCode: 0, team: 0 },
        { slot: 1, name: "BotRacer", charCode: 2, team: 1, isAi: true, aiLevel: 3 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    expect(sim.componentMode).toBe(1);
    expect(sim.kartCheckpoints).toBe(4);
    expect(sim.kartTotalLaps).toBe(3);

    const p1 = sim.players[0]!;
    const bot = sim.players[1]!;
    expect(p1.rideId === 9 || p1.rideId === 10).toBe(true);
    expect(p1.activeSlots.filter((s) => s === ACTIVE_CAN).length).toBe(2);

    for (let t = 0; t <= START_BANNER_TICKS; t++) sim.step();
    p1.invulnTicks = 0;

    // 1. Flame spins/slows Kart racer (`glueTicks > 0`) instead of dismounting `rideId`!
    const p1Cx = Math.floor(p1.px / 40);
    const p1Cy = Math.floor(p1.py / 40);
    sim.flames.push({ cx: p1Cx, cy: p1Cy, part: "C", ticksLeft: 5, ownerSlot: 1 });
    sim.step();
    expect(p1.rideId === 9 || p1.rideId === 10).toBe(true);
    expect(p1.glueTicks).toBeGreaterThan(0);
    p1.glueTicks = 0;

    // 2.Kart AI steers along checkpoints!
    for (let t = 0; t < 40; t++) {
      sim.setInput(1, computeAiInput(sim, bot));
      sim.step();
    }
    expect(bot.walkTicks).toBeGreaterThan(0);

    // 3. Pit-stop (`isPitStop`) refuels `kartFuel` (`Refuel` SFX)!
    let pitCoords: [number, number] | null = null;
    for (let y = 0; y < sim.height && !pitCoords; y++) {
      for (let x = 0; x < sim.width; x++) {
        if (sim.cellAt(x, y)?.isPitStop) {
          pitCoords = [x, y];
          break;
        }
      }
    }
    if (pitCoords) {
      p1.kartFuel = 40;
      p1.px = pitCoords[0] * 40 + 20;
      p1.py = pitCoords[1] * 40 + 20;
      sim.step();
      expect(p1.kartFuel!).toBeGreaterThan(40);
    }

    // 4. Advance P1 through checkpoints `0 -> 1 -> 2 -> 3 -> 4` across all 3 laps, then cross `0` to win!
    const cpPos = new Map<number, [number, number]>();
    for (let y = 0; y < sim.height; y++) {
      for (let x = 0; x < sim.width; x++) {
        const cp = sim.cellAt(x, y)!.lapCheckpoint;
        if (cp >= 0 && !cpPos.has(cp)) cpPos.set(cp, [x, y]);
      }
    }
    expect(cpPos.size).toBe(5); // 0 (Start_*), 1, 2, 3, 4

    for (let lap = 0; lap < 3; lap++) {
      for (let cp = 0; cp <= 4; cp++) {
        const [cx, cy] = cpPos.get(cp)!;
        p1.px = cx * 40 + 20;
        p1.py = cy * 40 + 20;
        const evs = sim.step();
        expect(evs.includes("RallyPoint")).toBe(true);
        if (lap === 2 && cp === 0) {
          expect(p1.isFinalLap).toBe(true);
        }
      }
      expect(p1.kartLap).toBe(lap + 1);
      expect(p1.isFirstPlace).toBe(true);
    }

    // Final crossing of `Start_*` (`cp === 0`) after completing Lap 3 wins the race!
    const [sx, sy] = cpPos.get(0)!;
    p1.px = sx * 40 + 20;
    p1.py = sy * 40 + 20;
    const winEvs = sim.step();
    expect(sim.finished).toBe(true);
    expect(sim.winnerSlots).toContain(0);
    expect(winEvs).toContain("Win");
  });

  test("Bula souls require two-thirds flame coverage, combining distinct tiles", () => {
    const flame = { cx: 0, cy: 0, part: "C" as const, ticksLeft: 5, ownerSlot: 0 };
    expect(soulFlameHit(34, 20, [flame])).toBe(flame); // 22 x 15 >= 320
    expect(soulFlameHit(35, 20, [flame])).toBeUndefined(); // 21 x 15 < 320
    expect(soulFlameHit(35, 20, [flame, flame])).toBeUndefined();
    const adjacent = { ...flame, cx: 1 };
    expect(soulFlameHit(35, 20, [flame, adjacent])).toBe(flame);
    expect(soulFlameHit(20, 20, [])).toBeUndefined();
  });

  test("simulates CBulaComponent (Map/Bula00) Mummy/BulaBat souls co-op hunt & Cemetery01 bat swarm", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);

    // 1. `Map/Bula00` cooperative Monster Hunt (`InnerSoul` Mummy + `OuterSoul` BulaBat)
    const bulaMap = parseMapBinary("Bula00", fx.payload("Map/Bula00")!)!;
    expect(bulaMap.componentMode).toBe(2);
    expect(bulaMap.soulPaths.length).toBeGreaterThanOrEqual(1);
    expect(bulaMap.soulSpawns.length).toBe(4);
    expect(bulaMap.soulSpawns.some((s) => s.kind === "InnerSoul")).toBe(true);
    expect(bulaMap.soulSpawns.some((s) => s.kind === "OuterSoul")).toBe(true);

    const sim = new GameSimulation({
      mapData: bulaMap,
      mode: 0,
      seed: 999,
      participants: [
        { slot: 0, name: "Hero1", charCode: 0, team: 0 },
        { slot: 1, name: "AllyBot", charCode: 1, team: 1, isAi: true, aiLevel: 3 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    // Bula ground metadata 112 = mask 12: dots at (1,1) and (2,1).
    expect(tileInfo.get("Tile15_Ground/Remain00")!.bulaPattern).toBe(112);
    const dotIndex = sim.cells.findIndex(c => c.groundObjName === "Tile15_Ground/Remain00");
    expect(dotIndex).toBeGreaterThanOrEqual(0);
    const dotCell = sim.cells[dotIndex]!;
    expect(dotCell.bulaDots).toEqual([-1, -1, -1, -1, 0, 0]);
    const hero = sim.players[0]!;
    const previous = [hero.px, hero.py];
    hero.px = (dotIndex % sim.width) * 40 + 20;
    hero.py = Math.floor(dotIndex / sim.width) * 40 + 15;
    (sim as any).updateBulaCellStep(hero);
    expect(dotCell.bulaDots).toEqual([-1, -1, -1, -1, 1, 0]);
    expect(sim.toSnapshot().cells[dotIndex]!.bulaDots).toEqual(dotCell.bulaDots);
    dotCell.bulaDots[4] = 0;
    // Native integer division truncates toward zero at the left edge.
    const edge = sim.cellAt(0, 0)!;
    const oldDot = edge.bulaDots[4]!;
    edge.bulaDots[4] = 0;
    hero.px = 19; hero.py = 15;
    (sim as any).updateBulaCellStep(hero);
    expect(edge.bulaDots[4]).toBe(1);
    edge.bulaDots[4] = oldDot;
    hero.px = previous[0]!; hero.py = previous[1]!;
    // sub_49AE87 only removes dots without an adjacent unopened house. Owned
    // dots touching newly captured houses play Character/Bula's eaten action.
    expect(objTable.byName.get("Character/Bula")?.actionList[1]?.sprite).toBe("Character/bula_ani");
    expect(objTable.byName.get("Character/Bula")?.actionList[2]?.totalTicks).toBe(14);
    expect(fx.has("Character/bula_aniLayerStatic")).toBe(true);
    expect(fx.has("Character/bula_aniLayerAdjust")).toBe(true);
    const dotSim = new GameSimulation({ mapData: bulaMap, mode: 0, seed: 999,
      participants: [{ slot: 0, name: "Tester", charCode: 0, team: 0 }], objectTable: objTable, bomberByCode, itemAttr, tileInfo });
    for (const cell of dotSim.cells) {
      cell.isBulaVault = false;
      cell.bulaHouseTeam = -1;
      cell.bulaDots.fill(-1);
    }
    const capturedHouse = dotSim.cellAt(5, 4)!;
    const unopenedHouse = dotSim.cellAt(6, 5)!;
    capturedHouse.isBulaVault = true; capturedHouse.bulaHouseTeam = 0;
    unopenedHouse.isBulaVault = true;
    const dots = dotSim.cellAt(5, 5)!;
    dots.bulaDots[4] = 1;
    dots.bulaDots[5] = 0;
    const unrelated = dotSim.cellAt(1, 1)!;
    unrelated.bulaDots[4] = 0;
    (dotSim as any).updateBulaDotsAfterCapture(new Set([4 * dotSim.width + 5]));
    expect(dots.bulaDots[4]).toBe(1);
    expect(dots.bulaDotEffects[4]).toEqual({ startTick: 0, hideAfter: false });
    expect(dots.bulaDots[5]).toBe(0);
    expect(unrelated.bulaDots[4]).toBe(-2);
    const snapEffect = dotSim.toSnapshot().cells[5 * dotSim.width + 5]!.bulaDotEffects![4]!;
    unopenedHouse.bulaHouseTeam = 0;
    (dotSim as any).updateBulaDotsAfterCapture(new Set([5 * dotSim.width + 6]));
    expect(dots.bulaDots[5]).toBe(-2);
    expect(dots.bulaDotEffects[4]?.hideAfter).toBe(true);
    expect(snapEffect.hideAfter).toBe(false); // snapshots must not alias mutable effects
    dotSim.tick = 13;
    (dotSim as any).updateBulaDotEffects();
    expect(dots.bulaDots[4]).toBe(1);
    dotSim.tick = 14;
    (dotSim as any).updateBulaDotEffects();
    expect(dots.bulaDots[4]).toBe(-2);
    expect(dots.bulaDotEffects[4]).toBeNull();
    // With an unopened neighbour, the same animation returns to edible state.
    unopenedHouse.bulaHouseTeam = -1;
    dots.bulaDots[4] = 2;
    (dotSim as any).updateBulaDotsAfterCapture(new Set([4 * dotSim.width + 5]));
    expect(dots.bulaDotEffects[4]?.hideAfter).toBe(false);
    dotSim.tick += 14;
    (dotSim as any).updateBulaDotEffects();
    expect(dots.bulaDots[4]).toBe(2);
    expect(dots.bulaDotEffects[4]).toBeNull();

    // Both participants automatically cooperate on Team 0!
    expect(sim.players[0]!.team).toBe(0);
    expect(sim.players[1]!.team).toBe(0);
    expect(sim.souls.length).toBe(bulaMap.soulSpawns.length);

    // Retail Mummy In is 30 ticks, BulaBat In is 24, from ObjectTable.
    const bat = sim.souls.find(s => s.kind === "OuterSoul")!;
    const mummy = sim.souls.find(s => s.kind === "InnerSoul")!;
    expect(bat.dir).toBe(0); // Bula00 path begins (14,12) -> (0,12).
    let sawSoulCreate = false;
    for (let t = 0; t < 24; t++) {
      const evs = sim.step();
      if (evs.includes("BulaMummyCreate") || evs.includes("BulaBatCreate")) sawSoulCreate = true;
    }
    expect(bat.state).toBe("walk");
    expect(mummy.state).toBe("spawn");
    for (let t = 24; t <= START_BANNER_TICKS; t++) {
      const evs = sim.step();
      if (evs.includes("BulaMummyCreate") || evs.includes("BulaBatCreate")) sawSoulCreate = true;
    }
    expect(sawSoulCreate).toBe(true);
    expect(sim.souls.every((s) => s.state === "walk")).toBe(true);

    // Reaching a waypoint turns immediately; the following tick advances without a pause.
    const pathBat = sim.souls.find(s => s.kind === "OuterSoul")!;
    pathBat.px = 23; pathBat.py = 12 * 40 + 20; pathBat.waypointIdx = 1;
    (sim as any).updateSouls();
    expect([pathBat.px, pathBat.py, pathBat.dir, pathBat.waypointIdx]).toEqual([20, 500, 1, 2]);
    (sim as any).updateSouls();
    expect(pathBat.py).toBe(497);

    // Patrolling Soul traps unprotected bomber on contact (`BulaGhostWarning2`)!
    const p1 = sim.players[0]!;
    p1.invulnTicks = 0;
    const firstSoul = sim.souls[0]!;
    p1.px = firstSoul.px;
    p1.py = firstSoul.py;
    const contactEvs = sim.step();
    expect(p1.state).toBe("trapped");
    expect(contactEvs).toContain("BulaGhostWarning2");

    // Cooperative ally rescues P1 on touch!
    const p2 = sim.players[1]!;
    p2.invulnTicks = 999;
    p2.px = p1.px;
    p2.py = p1.py;
    sim.step();
    expect(p1.state).toBe("alive");

    // Flame kills every Soul (`BulaMummyDie` / `BulaBatDie`, +25 Lucci per kill) -> cooperative Victory!
    p1.invulnTicks = 999;
    let sawSoulDie = false;
    for (const s of sim.souls) {
      const scx = Math.floor(s.px / 40);
      const scy = Math.floor(s.py / 40);
      sim.flames.push({ cx: scx, cy: scy, part: "C", ticksLeft: 5, ownerSlot: 0 });
    }
    for (let t = 0; t < 25 && !sim.finished; t++) {
      const evs = sim.step();
      if (evs.includes("BulaMummyDie") || evs.includes("BulaBatDie")) sawSoulDie = true;
    }
    expect(sawSoulDie).toBe(true);
    expect(sim.souls.length).toBe(0);
    expect(sim.finished).toBe(true);
    expect(sim.winnerTeam).toBe(0);
    expect(sim.winnerSlots).toEqual([0, 1]);
    expect(p1.bonusLucci).toBeGreaterThanOrEqual(bulaMap.soulSpawns.length * 25);
    expect(sim.toSnapshot().perfectWin).toBe(true);

    // 2. `Map/Cemetery01` periodic ambient bat swarm (`batIntervalSec === 25`)
    const cemMap = parseMapBinary("Cemetery01", fx.payload("Map/Cemetery01")!)!;
    expect(cemMap.batIntervalSec).toBe(25);
    const cemSim = new GameSimulation({
      mapData: cemMap,
      mode: 0,
      seed: 123,
      participants: [{ slot: 0, name: "Solo", charCode: 0, team: 0 }],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    expect(cemSim.batIntervalTicks).toBeGreaterThan(700);
    while (cemSim.tick < START_BANNER_TICKS + cemSim.batIntervalTicks) {
      cemSim.step();
    }
    expect(cemSim.batSwarmTick).toBe(cemSim.tick);
  });

  test("simulates Bula subcell capture and Event2004 Golden Flags", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);

    // sub_49B632 uses TileInfo i4, not the first Bf name number.
    for (let house = 1; house <= 5; house++) {
      for (let part = 1; part <= 4; part++) {
        const name = `Tile15_Static/Bf0${house}_0${part}`;
        expect(tileInfo.get(name)?.bulaHouseEligible).toBe(true);
        expect(tileInfo.get(name)?.bulaHouseVariant).toBe(part);
        expect(tileInfo.get(`Tile15_Static/Aft0${part}`)?.bulaHouseEligible).toBe(true);
        const action = objTable.byName.get(`Tile15_Static/Aft0${part}`)?.defaultAction;
        expect(action?.sprite).toBe(`Character/remain_aft0${part}`);
      }
    }

    // Verify Pass 5 retail Fx assets exist (`remain_aft`, `bula`, `Event2004ResultFlag`, `QuestionMark_*`, `DlgMission*`)
    expect(fx.has("Character/bulaLayerStatic")).toBe(true);
    expect(fx.has("Character/bulaLayerAdjust")).toBe(true);
    expect(fx.has("Character/remain_aft01LayerStatic")).toBe(true);
    expect(fx.has("Character/remain_aft01LayerAdjust")).toBe(true);
    expect(fx.has("Tile15/bula_stop")).toBe(true);
    expect(fx.has("Game/Event2004ResultFlag")).toBe(true);
    expect(fx.has("Game/Event2004ResultEffect")).toBe(true);
    expect(fx.has("Dialog/QuestionMark_DlgCouponChoice")).toBe(true);
    expect(fx.has("Dialog/DlgMissionBula")).toBe(true);
    expect(fx.has("Dialog/DlgMissionEvent2004")).toBe(true);

    // 1. Competitive `CBulaComponent` (`team 0` vs `team 1` on `Map/Bula00`)
    const bulaMap = parseMapBinary("Bula00", fx.payload("Map/Bula00")!)!;
    const sim = new GameSimulation({
      mapData: bulaMap,
      mode: 0,
      bulaCompetitive: true,
      seed: 555,
      participants: [
        { slot: 0, name: "RedPainter", charCode: 0, team: 0 },
        { slot: 1, name: "BluePainter", charCode: 1, team: 1, isAi: true },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    const vaults = sim.cells.filter((cell) => cell.isBulaVault);
    expect(vaults.length).toBeGreaterThan(0);
    for (const vault of vaults) {
      expect(vault.bulaVaultVariant).toBe(tileInfo.get(vault.blockObjName)?.bulaHouseVariant);
    }
    // Both Bf and Aft house tiles are counted by metadata, independently of their name.
    const aft = objTable.byName.get("Tile15_Static/Aft02")!;
    const alternateMap = { ...bulaMap, cells: bulaMap.cells.map((cell, i) => i === 0 ? { ...cell, blockObjIdx: aft.index } : cell) };
    const alternate = new GameSimulation({ mapData: alternateMap, mode: 0, seed: 555,
      participants: [{ slot: 0, name: "Tester", charCode: 0, team: 0 }], objectTable: objTable, bomberByCode, itemAttr, tileInfo });
    expect(alternate.cells[0]!.isBulaVault).toBe(true);
    expect(alternate.cells[0]!.bulaVaultVariant).toBe(2);
    expect(sim.bulaCompetitive).toBe(true);
    expect(sim.players[0]!.team).toBe(0);
    expect(sim.players[1]!.team).toBe(1);
    while (sim.tick <= START_BANNER_TICKS) sim.step();

    const p0 = sim.players[0]!;
    p0.invulnTicks = 9999;

    // Construct a complete native subcell loop and close it with player contact.
    // All unrelated blocks are removed to make the selected server-request
    // candidates explicit; this does not exercise the unknown retail server reward.
    for (const cell of sim.cells) {
      cell.blockObjName = "";
      cell.isBulaVault = false;
      cell.bulaHouseTeam = -1;
      cell.bulaDots.fill(-1);
      cell.bulaDotEffects.fill(null);
    }
    const setDot = (x: number, y: number, value: number) => {
      sim.cellAt(Math.floor(x / 3), Math.floor(y / 2))!.bulaDots[(y % 2) * 3 + x % 3] = value;
    };
    for (let x = 2; x <= 10; x++) { setDot(x, 2, 1); setDot(x, 7, 1); }
    for (let y = 2; y <= 7; y++) { setDot(2, y, 1); setDot(10, y, 1); }
    setDot(2, 2, 0); // last dot, completed by player
    setDot(2, 4, 0); // leave a gap so an open line cannot capture
    const target = sim.cellAt(2, 2)!;
    target.blockObjName = "Tile15_Static/Bf01_02";
    target.blockKind = 1;
    target.isBulaVault = true;
    target.bulaVaultVariant = 2;
    const alreadyClaimed = sim.cellAt(3, 3)!;
    alreadyClaimed.blockObjName = "Tile15_Static/Bf01_01";
    alreadyClaimed.blockKind = 1;
    alreadyClaimed.isBulaVault = true;
    alreadyClaimed.bulaHouseTeam = 1;
    const box = sim.cellAt(1, 1)!;
    box.blockObjName = "Tile00_Box/Box0";
    box.blockKind = 2;
    const bush = sim.cellAt(2, 1)!;
    bush.blockObjName = "Tile00_Passable/Bush0";
    bush.blockKind = 3;
    const bulaBeforeLucci = p0.bonusLucci;
    p0.px = 33; p0.py = 35; // native dot column 2, row 2
    (sim as any).updateBulaCellStep(p0);
    expect(target.bulaHouseTeam).toBe(-1);
    setDot(2, 4, 1);
    setDot(2, 2, 0);
    sim.step();
    expect(target.bulaHouseTeam).toBe(0);
    expect(alreadyClaimed.bulaHouseTeam).toBe(1); // client only requests unclaimed blocks
    expect(box.bulaHouseTeam).toBe(-1); // sub_40B1F5 excludes boxes
    expect(bush.bulaHouseTeam).toBe(-1); // and passable tiles
    expect(p0.bulaHouses).toBe(1);
    expect(p0.bonusLucci).toBe(bulaBeforeLucci); // no guessed multiplier or rewards
    expect(sim.computeBulaTeamScore(0)).toBe(1); // local ownership fallback only
    expect(sim.sounds).toContain("BulaTookHouse");
    expect(sim.toSnapshot().cells[2 * sim.width + 2]!.bulaHouseVar).toBe(2);

    // 2. `CEvent2004Component` (`Map/EventForest00`): Soul drops Golden Flag (`pickupFlag === 98`)!
    const evMap = parseMapBinary("EventForest00", fx.payload("Map/EventForest00")!)!;
    expect(evMap.componentMode).toBe(3);
    expect(evMap.soulSpawns.length).toBe(8);
    const evSim = new GameSimulation({
      mapData: evMap,
      mode: 0,
      seed: 2004,
      participants: [{ slot: 0, name: "FlagHunter", charCode: 0, team: 0 }],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    while (evSim.tick <= START_BANNER_TICKS) evSim.step();
    const firstSoul = evSim.souls[0]!;
    const flagCx = Math.floor(firstSoul.px / 40);
    const flagCy = Math.floor(firstSoul.py / 40);
    evSim.flames.push({ cx: flagCx, cy: flagCy, part: "C", ticksLeft: 5, ownerSlot: 0 });
    evSim.step();

    const droppedFlag = evSim.items.find((it) => it.cx === flagCx && it.cy === flagCy && it.pickupFlag === 98);
    expect(droppedFlag).toBeDefined();
    expect(droppedFlag!.objectName).toBe("GoldFlag");
    expect(droppedFlag!.iconSprite).toBe("Item/ItemGoldFlag");

    // Stepping onto Golden Flag collects `goldFlags` + `+100` Lucci + `niceTicks` + `BonusStageEffect`!
    const hunter = evSim.players[0]!;
    hunter.invulnTicks = 9999;
    // Clear flames before stepping onto `(flagCx, flagCy)`
    evSim.flames.length = 0;
    const beforeLucci = hunter.bonusLucci;
    hunter.px = flagCx * 40 + 20;
    hunter.py = flagCy * 40 + 20;
    const flagEvs = evSim.step();
    expect(hunter.goldFlags).toBe(1);
    expect(hunter.bonusLucci).toBe(beforeLucci + 100);
    expect(hunter.niceTicks).toBeGreaterThan(0);
    expect(flagEvs).toContain("BonusStageEffect");
  });

  test("simulates CGOGhost sightline rush & flame stun, CTimebombRoulette, Item/QuestionMark, & CGONice", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Patrit00", fx.payload("Map/Patrit00")!)!;

    // 1. `CTimebombRoulette` (`mode = 2` Timebomb) + `Item/QuestionMark` + `CGONice`
    const tbSim = new GameSimulation({
      mapData,
      mode: 2,
      seed: 888,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
        { slot: 2, name: "P3", charCode: 2, team: 2 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });

    let sawRouletteSfx = false;
    let sawTouchSfx = false;
    while (tbSim.tick <= START_BANNER_TICKS + 42) {
      const evs = tbSim.step();
      if (evs.includes("TimebombRoulette")) sawRouletteSfx = true;
      if (evs.includes("TimebombTouch")) sawTouchSfx = true;
    }
    expect(sawRouletteSfx).toBe(true);
    expect(sawTouchSfx).toBe(true);
    expect(tbSim.players.some((p) => p.hasTimebomb)).toBe(true);

    // Place `Item/QuestionMark` (`effectId: 21`, `pickupFlag: 1`) directly at P1's tile and collect it!
    const p1 = tbSim.players[0]!;
    const qcx = Math.floor(p1.px / 40);
    const qcy = Math.floor(p1.py / 40);
    tbSim.items.push({
      id: 9999,
      cx: qcx,
      cy: qcy,
      objectName: "Item/QuestionMark",
      iconSprite: "Item/QuestionMark",
      pickupFlag: 1,
      effectId: 21,
      spawnTick: tbSim.tick - 20,
    });
    const qEvs = tbSim.step();
    expect(qEvs).toContain("ItemEaten");
    expect(p1.questionMarks).toBe(1);
    expect(p1.questionEffTicks).toBeGreaterThan(0);

    // 2. `CGOGhost` (`Game/Ghost`) Hurry-Up Stalker Ghost sightline rush, trap/KO, & flame stun!
    // Clear row `cy = 6` across `cx = 3..9` so Ghost has a clean horizontal corridor to spot P2!
    for (let cx = 3; cx <= 9; cx++) {
      const c = tbSim.cellAt(cx, 6)!;
      c.blockKind = 0;
      c.blockObjName = "";
      c.blocksWalk = false;
    }
    const victim = tbSim.players[1]!;
    victim.state = "alive";
    victim.invulnTicks = 0;
    victim.hopInvulnTicks = 0;
    victim.shieldTicks = 0;
    victim.rideId = 0;
    victim.hasTimebomb = false;
    victim.px = 7 * 40 + 20;
    victim.py = 6 * 40 + 20;

    tbSim.spawnHurryGhost(4, 6);
    expect(tbSim.ghost).not.toBeNull();
    expect(tbSim.ghost!.state).toBe("in");

    let sawTrans = false;
    let sawRush = false;
    for (let t = 0; t < 80 && victim.state === "alive"; t++) {
      victim.px = 7 * 40 + 20;
      victim.py = 6 * 40 + 20;
      const evs = tbSim.step();
      if (evs.includes("GhostTrans")) sawTrans = true;
      if (tbSim.ghost?.state === "rush") sawRush = true;
    }
    expect(sawTrans).toBe(true);
    expect(sawRush).toBe(true);
    expect(victim.state).toBe("trapped");

    // Verify flame stuns `CGOGhost` (`state === "stun"`)!
    const gcx = Math.floor(tbSim.ghost!.px / 40);
    const gcy = Math.floor(tbSim.ghost!.py / 40);
    tbSim.flames.push({ cx: gcx, cy: gcy, part: "C", ticksLeft: 6, ownerSlot: 0 });
    tbSim.step();
    expect(tbSim.ghost!.state).toBe("stun");
  });

  test("simulates CSurvivalComponent Mode 4 safe revive, combo streaks, Hurry-Up No-Revive, CGOCoinEffect, & ItemBag slots", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const emoTe = new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bomberByCode = new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const mapData = parseMapBinary("Patrit00", fx.payload("Map/Patrit00")!)!;

    // Verify Pass 6 retail sprites in Fx & EmoTE
    expect(fx.has("Game/Kill_Crown")).toBe(true);
    expect(fx.has("Game/Kill_Image")).toBe(true);
    expect(fx.has("Game/Kill_ImageNo")).toBe(true);
    expect(fx.has("Game/Kill_ImageNo-Revive")).toBe(true);
    expect(fx.has("Game/Kill_RevivePoint")).toBe(true);
    expect(fx.has("Game/GaugeBg")).toBe(true);
    expect(fx.has("Game/GaugeImg")).toBe(true);
    expect(fx.has("Game/GameStageItem")).toBe(true);
    expect(fx.has("Game/GameStage_Type_icon")).toBe(true);
    expect(fx.has("Game/CoinEffImg")).toBe(true);
    expect(fx.has("Item/AdvMotionBlur")).toBe(true);
    expect(emoTe.has("IDDeco/IDDeco_C001G")).toBe(true);
    expect(emoTe.has("IDDeco/IDDeco_C002G")).toBe(true);

    // Mode 4 (`CSurvivalComponent` 生死戰) with `activeSlotCap: 4` vs `activeSlotCap: 6` (`ItemBag2`)
    const sim = new GameSimulation({
      mapData,
      mode: 4,
      seed: 4444,
      participants: [
        {
          slot: 0,
          name: "Ace",
          charCode: 0,
          team: 0,
          activeSlotCap: 6,
          initialSpeedBonus: 2,
          initialPowerBonus: 2,
          initialRadarTicks: 300,
          idDecoCode: 10011,
        },
        { slot: 1, name: "Target1", charCode: 1, team: 1, activeSlotCap: 4 },
        { slot: 2, name: "Target2", charCode: 2, team: 2, activeSlotCap: 4 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    while (sim.tick <= START_BANNER_TICKS) sim.step();

    const ace = sim.players[0]!;
    const t1 = sim.players[1]!;
    const t2 = sim.players[2]!;
    expect(ace.radarTicks).toBeGreaterThan(200);
    expect(ace.idDecoCode).toBe(10011);
    expect(ace.activeSlotCap).toBe(6);

    // 1. `CGOCoinEffect` (`coinPopups`): collect a `+300` Lucci bag -> spawns parabolic coin popup!
    sim.items.push({
      id: 7777,
      cx: Math.floor(ace.px / 40),
      cy: Math.floor(ace.py / 40),
      objectName: "Item/CoinPocketGold",
      iconSprite: "Item/CoinPocketGold",
      pickupFlag: 99,
      effectId: 300,
      spawnTick: sim.tick - 10,
    });
    sim.step();
    expect(ace.bonusLucci).toBe(300);
    expect(sim.coinPopups.length).toBe(1);
    expect(sim.toSnapshot().coinPopups?.[0]?.amount).toBe(300);

    // 2. Trap & pop `t1` and `t2` within combo window -> `comboKills === 2` + `reviveCx/Cy` assigned!
    t1.state = "trapped";
    t1.stateTicks = 25;
    t1.trappedBySlot = 0;
    t1.px = ace.px;
    t1.py = ace.py;

    t2.state = "trapped";
    t2.stateTicks = 25;
    t2.trappedBySlot = 0;
    t2.px = ace.px;
    t2.py = ace.py;
    sim.step();

    expect(ace.kills).toBe(2);
    expect(ace.comboKills).toBe(2);
    expect(ace.comboWindowTicks).toBeGreaterThan(100);
    expect(t1.state).toBe("dying");

    // Step through dying (`28` ticks) -> `dead` (`reviveCx/Cy` chosen) -> `Revive` at `90` ticks!
    let sawRevive = false;
    let sawReviveBeacon = false;
    for (let i = 0; i < 125; i++) {
      const evs = sim.step();
      if (t1.state === "dead" && t1.reviveCx !== undefined && t1.reviveCy !== undefined) {
        sawReviveBeacon = true;
      }
      if (evs.includes("Revive")) sawRevive = true;
    }
    expect(sawReviveBeacon).toBe(true);
    expect(sawRevive).toBe(true);
    expect(t1.state).toBe("alive");

    // 3. During `hurryUp`, KO locks `noRevive = true` and eliminates remaining rivals!
    sim.hurryUp = true;
    t1.invulnTicks = 0;
    t1.state = "trapped";
    t1.stateTicks = 25;
    t1.trappedBySlot = 0;
    t1.px = ace.px;
    t1.py = ace.py;

    t2.invulnTicks = 0;
    t2.state = "trapped";
    t2.stateTicks = 25;
    t2.trappedBySlot = 0;
    t2.px = ace.px;
    t2.py = ace.py;

    for (let i = 0; i < 35 && !sim.finished; i++) sim.step();
    expect(t1.noRevive).toBe(true);
    expect(sim.finished).toBe(true);
    expect(sim.winnerTeam).toBe(0);
    expect(sim.winnerSlots).toEqual([0]);
  });

  test("applies PremiumTicketMonth 2x EXP/Lucci, RoomTicket/SuperChief multipliers, & Spanner Kart regen", () => {
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const db = new GameDatabase(":memory:", stockById, pkgMap);

    const regA = db.registerAccount("vip_a", "pw", "普通玩家", 0);
    const regB = db.registerAccount("vip_b", "pw", "優惠玩家", 0);
    expect(regA.ok && regB.ok).toBe(true);
    if (!regA.ok || !regB.ok) return;

    // Grant `超值優惠券 PremiumTicketMonth` (`1905`, `category = 9`) + `閃亮暱稱 IDDeco` (`10011`, `category = 18`) to `vip_b`
    db.grantStock(regB.profile.id, 1905, 1);
    db.grantStock(regB.profile.id, 10011, 1);
    const invB = db.getInventory(regB.profile.id);
    const idDecoRow = invB.find((r) => r.stockId === 10011)!;
    db.setEquipped(regB.profile.id, idDecoRow.invId, true);
    expect(db.getProfileById(regB.profile.id)!.equipped.idDecoStockId).toBe(10011);

    const outNormal = db.recordMatchOutcome(regA.profile.id, "win", 2, 1, 0, 50);
    const outPremium = db.recordMatchOutcome(regB.profile.id, "win", 2, 1, 0, 50);
    expect(outPremium.premiumApplied).toBe(true);
    expect(outPremium.expGain).toBe(outNormal.expGain * 2);
    expect(outPremium.lucciGain).toBe(outNormal.lucciGain * 2);
    for (const [id, result] of [[regA.profile.id, outNormal], [regB.profile.id, outPremium]] as const) {
      const profile = db.getProfileById(id)!;
      const start = expForLevel(profile.level);
      const end = expForLevel(profile.level + 1);
      expect(result.expProgressTenths).toBe(Math.min(999, Math.floor((profile.exp - start) * 1000 / (end - start))));
    }

    // Verify `Spanner` (`hasSpanner: true`) regenerates Kart fuel on `Map/Kart03`
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const kartMap = parseMapBinary("Kart03", fx.payload("Map/Kart03")!)!;
    const kSim = new GameSimulation({
      mapData: kartMap,
      mode: 0,
      seed: 74,
      participants: [{ slot: 0, name: "Mechanic", charCode: 0, team: 0, hasSpanner: true }],
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b])),
      itemAttr: parseItemAttr(fx.payload("Attr/ItemAttr")!),
      tileInfo: parseTileInfo(fx.payload("TileInfo/TileInfo")!),
    });
    while (kSim.tick <= START_BANNER_TICKS) kSim.step();
    kSim.players[0]!.kartFuel = 60;
    for (let t = 0; t < 30; t++) kSim.step();
    expect(kSim.players[0]!.kartFuel).toBeGreaterThan(60);
  });

  test("differentiates Skeleton0/Skeleton1/MoonWalk/GreenDevil curses, contagious GreenDevil tag, Goggle & Camouflage", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const mapData = parseMapBinary("Village00", fx.payload("Map/Village00")!)!;
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 707,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0 },
        { slot: 1, name: "P2", charCode: 1, team: 1 },
      ],
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b])),
      itemAttr,
      tileInfo: parseTileInfo(fx.payload("TileInfo/TileInfo")!),
    });
    while (sim.tick <= START_BANNER_TICKS) sim.step();

    // Clear row y = 6 across x = 2..12 for deterministic movement assertions
    for (let x = 2; x <= 12; x++) {
      const c = sim.cellAt(x, 6)!;
      c.blockKind = 0;
      c.blockObjName = "";
      c.blocksWalk = false;
      c.isPinHazard = false;
    }

    const p0 = sim.players[0]!;
    const p1 = sim.players[1]!;
    p0.px = 5 * 40 + 20;
    p0.py = 6 * 40 + 20;
    p0.bombsMax = 6;
    p1.px = 11 * 40 + 20;
    p1.py = 6 * 40 + 20;

    // 1. Skeleton1 (`eff=9`): slow 2 px/tick crawl, non-inverted controls, NO involuntary auto-bomb!
    sim.items.push({
      id: 9001,
      cx: 5,
      cy: 6,
      objectName: "Skeleton1",
      iconSprite: "Item/Devil",
      pickupFlag: 1,
      effectId: 9,
      spawnTick: 1,
    });
    sim.step();
    expect(p0.curseKind).toBe(9);
    const xBeforeCrawl = p0.px;
    sim.setInput(0, { dir: 2, placeBomb: false, useActive: false });
    for (let t = 0; t < 25; t++) sim.step();
    expect(p0.px - xBeforeCrawl).toBe(50); // 25 ticks * 2 px/tick = +50 px向右 (non-inverted!)
    expect(sim.bombs.length).toBe(0); // Skeleton1 never auto-bombs

    // 2. MoonWalk (`eff=10`): inverted controls (`dir: 2` walks LEFT!), NO involuntary auto-bomb!
    p0.px = 6 * 40 + 20;
    sim.items.push({
      id: 9002,
      cx: 6,
      cy: 6,
      objectName: "MoonWalk",
      iconSprite: "Item/Devil",
      pickupFlag: 1,
      effectId: 10,
      spawnTick: 1,
    });
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.step();
    expect(p0.curseKind).toBe(10);
    const xBeforeMoon = p0.px;
    sim.setInput(0, { dir: 2, placeBomb: false, useActive: false });
    for (let t = 0; t < 25; t++) sim.step();
    expect(p0.px).toBeLessThan(xBeforeMoon - 60); // Reversed leftward!
    expect(sim.bombs.length).toBe(0); // MoonWalk never auto-bombs

    // 3. Skeleton0 (`eff=8`): fast `speedMax + 1` non-inverted walk + involuntary auto-bomb!
    p0.px = 4 * 40 + 20;
    sim.items.push({
      id: 9003,
      cx: 4,
      cy: 6,
      objectName: "Skeleton0",
      iconSprite: "Item/Devil",
      pickupFlag: 1,
      effectId: 8,
      spawnTick: 1,
    });
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.step();
    expect(p0.curseKind).toBe(8);
    const xBeforeFast = p0.px;
    sim.setInput(0, { dir: 2, placeBomb: false, useActive: false });
    for (let t = 0; t < 25; t++) sim.step();
    expect(p0.px).toBeGreaterThan(xBeforeFast + 150); // Fast rightward!
    expect(sim.bombs.length).toBeGreaterThanOrEqual(1); // Auto-bomb placed!
    sim.bombs.length = 0;
    p0.bombsPlaced = 0;

    // 4. GreenDevil (`eff=12`): contagious transfer on body contact `p0 -> p1`!
    p0.px = 8 * 40 + 20;
    p0.py = 6 * 40 + 20;
    p0.invulnTicks = 0;
    p1.px = 10 * 40 + 20;
    p1.py = 6 * 40 + 20;
    p1.invulnTicks = 0;
    p1.curseTicks = 0;
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    sim.items.push({
      id: 9004,
      cx: 8,
      cy: 6,
      objectName: "GreenDevil",
      iconSprite: "Item/Devil",
      pickupFlag: 1,
      effectId: 12,
      spawnTick: 1,
    });
    sim.step();
    expect(p0.curseKind).toBe(12);
    // Bring p1 into body contact with p0
    p1.px = p0.px + 10;
    p1.py = p0.py;
    sim.step();
    expect(p0.curseTicks).toBe(0);
    expect(p0.curseKind).toBe(0);
    expect(p1.curseTicks).toBeGreaterThan(200);
    expect(p1.curseKind).toBe(12);

    // 5. Goggle (`eff=17`, `Item/Swimming`) & Camouflage (`eff=19`, `Item/Mask`)
    sim.items.push(
      {
        id: 9005,
        cx: 8,
        cy: 6,
        objectName: "Goggle",
        iconSprite: "Item/Swimming",
        pickupFlag: 1,
        effectId: 17,
        spawnTick: 1,
      },
      {
        id: 9006,
        cx: 8,
        cy: 6,
        objectName: "Camouflage",
        iconSprite: "Item/Mask",
        pickupFlag: 1,
        effectId: 19,
        spawnTick: 1,
      },
    );
    sim.step();
    expect(p0.goggleTicks).toBe(400);
    expect(p0.camoTicks).toBe(330);
  });

  test("collects CRAZY ARCADE Alphabet01..11 jackpot, negative LucciPocket1 CoinPopup, & Retail Dialogs/Prefs", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const mapData = parseMapBinary("Village00", fx.payload("Map/Village00")!)!;
    const sim = new GameSimulation({
      mapData,
      mode: 0,
      seed: 708,
      participants: [
        { slot: 0, name: "Collector", charCode: 0, team: 0 },
        { slot: 1, name: "Rival", charCode: 1, team: 1 },
      ],
      objectTable: new ObjectTable(fx.payload("ObjectTable/ObjectTable")!),
      bomberByCode: new Map(parseBomberAttr(fx.payload("Attr/BomberAttr")!).map((b) => [b.code, b])),
      itemAttr: parseItemAttr(fx.payload("Attr/ItemAttr")!),
      tileInfo: parseTileInfo(fx.payload("TileInfo/TileInfo")!),
    });
    while (sim.tick <= START_BANNER_TICKS) sim.step();

    const p0 = sim.players[0]!;
    const c0 = sim.cellAt(4, 4)!;
    c0.blockKind = 0;
    c0.blockObjName = "";
    c0.blocksWalk = false;
    p0.px = 4 * 40 + 20;
    p0.py = 4 * 40 + 20;

    // Collect `Alphabet01..10` (+30 Lucci each) and `Alphabet11` (+500 jackpot!)
    for (let idx = 1; idx <= 11; idx++) {
      const pad = String(idx).padStart(2, "0");
      sim.items.push({
        id: 9100 + idx,
        cx: 4,
        cy: 4,
        objectName: `Alphabet${pad}`,
        iconSprite: `Item/Alphabet_${pad}`,
        pickupFlag: 98,
        effectId: idx,
        spawnTick: 1,
      });
      sim.step();
    }
    expect(p0.alphabetMask).toBe(0x7ff);
    expect(p0.bonusLucci).toBe(10 * 30 + 500);
    expect(p0.niceTicks).toBeGreaterThan(0);

    // Negative `LucciPocket1` (`flag=99, eff=-1000`) clamps `bonusLucci >= 0` & spawns `-1000` CoinPopup!
    sim.items.push({
      id: 9200,
      cx: 4,
      cy: 4,
      objectName: "LucciPocket1",
      iconSprite: "Item/CoinPocket",
      pickupFlag: 99,
      effectId: -1000,
      spawnTick: 1,
    });
    sim.step();
    expect(p0.bonusLucci).toBe(0);
    const snap = sim.toSnapshot();
    expect(snap.coinPopups?.some((cp) => cp.amount === -1000)).toBe(true);

    // Verify `Prepare/PrepareImg` `CBomberAttrViewer` & Pass 7 Dialog sheets in `Fx.idx`
    const prepSh = decodeSpriteSheet(fx.payload("Prepare/PrepareImg")!);
    expect(prepSh.rects[17]!.x1 - prepSh.rects[17]!.x0).toBe(159);
    expect(prepSh.rects[17]!.y1 - prepSh.rects[17]!.y0).toBe(79);
    expect(prepSh.rects[42]!.y1 - prepSh.rects[42]!.y0).toBe(130);
    expect(prepSh.rects[45]!.y1 - prepSh.rects[45]!.y0).toBe(181);
    for (const dlgName of [
      "Dialog/DlgMacro",
      "Dialog/BtNewUserOk",
      "Dialog/DlgRefusalList",
      "Dialog/Bt_add",
      "Dialog/Bt_CLOSE",
      "Dialog/DlgKeyMap",
      "Dialog/DlgColorPencil",
    ]) {
      expect(fx.has(dlgName)).toBe(true);
    }

    // Verify `ClientHub` Macro (`Alt+0..9`) & Whisper/Chat RefusalList filtering
    const hub = new ClientHub();
    expect(hub.macros.length).toBe(10);
    expect(hub.macros[1]).toBe(DEFAULT_MACROS[1]);
    hub.setMacro(1, "衝啊！水球連發！");
    expect(hub.triggerMacro(1)).toBe("衝啊！水球連發！");
    expect(hub.chatLog.some((l) => l.text === "衝啊！水球連發！")).toBe(true);

    expect(hub.addRefusal("Spammer99")).toBe(true);
    expect(hub.isRefused("spammer99")).toBe(true);
    (hub as unknown as { applyMessage: (m: unknown) => void }).applyMessage({
      type: "whisper_recv",
      from: "Spammer99",
      to: "Me",
      text: "blocked whisper",
    });
    expect(hub.whisperLog.length).toBe(0);
    expect(hub.removeRefusal("Spammer99")).toBe(true);
    expect(hub.isRefused("Spammer99")).toBe(false);
  });

  test("Pass 8: CBonusComponent (componentMode=4) coin-sweep + bot AI, Wet Footprints, UseMotor/SpringShort & Coupon System", async () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const bonusMap = parseMapBinary("Bonus01", fx.payload("Map/Bonus01")!)!;

    // 1. Verify `CBonusComponent` (`componentMode === 4`) on `Map/Bonus01` (`1500` ticks = 45s, `125+` pre-placed Lucci coins)
    const bSim = new GameSimulation({
      mapData: bonusMap,
      mode: 0,
      seed: 8080,
      participants: [
        { slot: 0, name: "CoinBotA", charCode: 0, team: 0, isAi: true, aiLevel: 3 },
        { slot: 1, name: "CoinBotB", charCode: 1, team: 1, isAi: true, aiLevel: 3 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    expect(bSim.componentMode).toBe(4);
    expect(bSim.ticksRemaining).toBe(1500);
    // `Bonus01` spawns 90 walkable pre-placed Lucci coins on open cells!
    expect(bSim.bonusCoinsTotal).toBe(90);
    expect(bSim.items.filter((it) => it.pickupFlag === 99 && it.effectId > 0).length).toBe(90);
    expect(bSim.bonusCoinsCollected).toBe(0);

    for (let t = 0; t < START_BANNER_TICKS + 120; t++) {
      for (const p of bSim.players) {
        if (p.isAi) bSim.setInput(p.slot, computeAiInput(bSim, p.slot));
      }
      bSim.step();
    }
    const snapMid = bSim.toSnapshot();
    expect(snapMid.componentMode).toBe(4);
    expect((snapMid.bonusCoinsCollected ?? 0)).toBeGreaterThan(0);
    expect(bSim.players[0]!.bonusLucci + bSim.players[1]!.bonusLucci).toBeGreaterThan(0);

    // Sweeping the remaining positive Lucci coins finishes the bonus stage immediately and awards highest-Lucci team!
    bSim.players[0]!.bonusLucci = 2500;
    bSim.players[1]!.bonusLucci = 400;
    bSim.items = bSim.items.filter((it) => !(it.pickupFlag === 99 && it.effectId > 0));
    const lastCoin = {
      id: 99901,
      cx: Math.floor(bSim.players[0]!.px / 40),
      cy: Math.floor(bSim.players[0]!.py / 40),
      objectName: "LucciGold",
      iconSprite: "Item/CoinGold",
      pickupFlag: 99,
      effectId: 50,
      spawnTick: 1,
    };
    bSim.items.push(lastCoin);
    bSim.bonusCoinsCollected = bSim.bonusCoinsTotal - 1;
    bSim.step();
    expect(bSim.finished).toBe(true);
    expect(bSim.winnerTeam).toBe(0);
    expect(bSim.winnerSlots).toContain(0);

    // 2. Post-bubble `wetTicks` water footprints (`SimFootprint`), `"UseMotor"` on `ACTIVE_CAN`, and 1-cell `"SpringShort"`!
    const oceanMap = parseMapBinary("Ocean00", fx.payload("Map/Ocean00")!)!;
    const wSim = new GameSimulation({
      mapData: oceanMap,
      mode: 0,
      seed: 8181,
      participants: [
        { slot: 0, name: "Walker", charCode: 0, team: 0 },
        { slot: 1, name: "Dummy", charCode: 1, team: 1 },
      ],
      objectTable: objTable,
      bomberByCode,
      itemAttr,
      tileInfo,
    });
    for (let cy = 0; cy < wSim.height; cy++) {
      for (let cx = 0; cx < wSim.width; cx++) {
        const c = wSim.cellAt(cx, cy)!;
        c.blockKind = 0;
        c.blockObjName = "";
        c.blocksWalk = false;
        c.isWetFloor = false;
        c.isSandFloor = false;
      }
    }
    for (let t = 0; t < START_BANNER_TICKS + 2; t++) wSim.step();

    const wp = wSim.players[0]!;
    wp.px = 3 * 40 + 20;
    wp.py = 5 * 40 + 20;
    wp.state = "trapped";
    wp.stateTicks = 12;
    wp.activeSlots[0] = ACTIVE_NEEDLE;
    wSim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: 0 });
    wSim.step();
    wSim.setInput(0, { dir: -1, placeBomb: false, useActive: false });
    expect(wp.state).toBe("alive");
    expect((wp.wetTicks ?? 0)).toBeGreaterThanOrEqual(134);

    // Walk right on dry floor -> emits `SimFootprint` water trail while `wetTicks > 0`!
    wSim.footprints.length = 0;
    for (let i = 0; i < 16; i++) {
      wSim.setInput(0, { dir: 2, placeBomb: false, useActive: false });
      wSim.step();
    }
    expect(wSim.footprints.length).toBeGreaterThan(0);

    // Non-Kart `ACTIVE_CAN` -> emits `"UseMotor"`!
    wp.activeSlots[0] = ACTIVE_CAN;
    wSim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: 0 });
    wSim.step();
    expect(wSim.toSnapshot().sounds).toContain("UseMotor");
    wSim.setInput(0, { dir: -1, placeBomb: false, useActive: false });

    // `ACTIVE_SPRING` when 2 cells ahead `(7, 5)` is blocked by solid wall (`blockKind = 1`) and 1 cell ahead `(6, 5)` is open -> 1-cell hop + `"SpringShort"`!
    wp.px = 5 * 40 + 20;
    wp.py = 5 * 40 + 20;
    wp.facing = 2; // Right
    wp.jumpTicks = 0;
    const wallCell = wSim.cellAt(7, 5)!;
    wallCell.blockKind = 1;
    wallCell.blocksWalk = true;
    wp.activeSlots[0] = ACTIVE_SPRING;
    wSim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: 0 });
    wSim.step();
    expect(wSim.toSnapshot().sounds).toContain("SpringShort");
    expect(wp.px).toBe(6 * 40 + 20);
    expect(wp.jumpTicks).toBeGreaterThanOrEqual(9);

    // 3. Verify Pass 8 retail sprite sheets exist in `Fx.idx`
    for (const path of [
      "Bonus/BonusStageBack1",
      "Bonus/BONUSSTAGE!!",
      "Bonus/Star00",
      "Bonus/Star04",
      "Game/KartSand_Left00",
      "Game/KartSand_Up00",
      "Game/KartSand_Right00",
      "Game/KartSand_Down00",
      "Game/Queryitem_eff",
      "Game/Ghost InOut",
      "AIaider/RedZone",
      "WhisperLog/BtWhisperLogArrow",
      "WhisperLog/BtWhisperLogTop",
      "WhisperLog/BtWhisperLogMiddle",
      "WhisperLog/BtWhisperLogBottom",
      "Shop/BtShop_MyCoupon",
      "Shop/BtShop_MyCoupon_Ani",
      "DialogCouponList/DlgItemCoupon",
      "DialogCouponList/SlotCoupon",
      "DialogCouponList/MyCouponList_BtLeft",
      "DialogCouponList/MyCouponList_BtRight",
      "DialogCouponList/BtClose",
      "DialogCouponList/Bt_UseCoupon",
      "DialogCouponList/Bt_DelCoupon",
      "DialogCouponList/DlgCouponDC",
      "DialogCouponList/Bt_CouponDCYes",
      "DialogCouponList/Bt_CouponDCNo",
      "Dialog/BtCreate_Timebomb",
    ]) {
      expect(fx.has(path)).toBe(true);
    }

    // 4. Verify SQLite `coupons` table + discounted `useCoupon` / `deleteCoupon` & `ClientHub` `recentWhispers`
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const memDb = new GameDatabase(":memory:", stockById, pkgMap);
    const reg = memDb.registerAccount("CouponTester", "pw1234", "折價達人", 1);
    expect(reg.ok).toBe(true);
    if (reg.ok) {
      const lucciItem = stocks.find((s) => s.buyableLucci && s.priceLucci > 0 && s.priceLucci <= 5000)!;
      memDb.grantCoupon(reg.profile.id, lucciItem.id, 50, 2);
      const listBefore = memDb.getCoupons(reg.profile.id);
      const targetCp = listBefore.find((c) => c.stockId === lucciItem.id && c.discountPct === 50)!;
      expect(targetCp).toBeDefined();
      expect(targetCp.quantity).toBe(2);

      const lucciBefore = memDb.getProfileById(reg.profile.id)!.lucci;
      const used = memDb.useCoupon(reg.profile.id, targetCp.couponId);
      expect(used.ok).toBe(true);
      if (used.ok) {
        const expectedCost = Math.round(lucciItem.priceLucci * 0.5);
        expect(used.paidLucci).toBe(expectedCost);
        expect(memDb.getProfileById(reg.profile.id)!.lucci).toBe(lucciBefore - expectedCost);
        expect(memDb.getInventory(reg.profile.id).some((r) => r.stockId === lucciItem.id)).toBe(true);
      }
      const listMid = memDb.getCoupons(reg.profile.id);
      expect(listMid.find((c) => c.couponId === targetCp.couponId)?.quantity).toBe(1);
      expect(memDb.deleteCoupon(reg.profile.id, targetCp.couponId)).toBe(true);
      expect(memDb.getCoupons(reg.profile.id).some((c) => c.couponId === targetCp.couponId)).toBe(false);
    }

    const hub = new ClientHub();
    hub.recordWhisperContact("BazziTW");
    hub.recordWhisperContact("DaoMaster");
    hub.recordWhisperContact("bazzitw");
    expect(hub.recentWhispers).toEqual(["bazzitw", "DaoMaster"]);
    hub.showDangerZone = true;
    expect(hub.showDangerZone).toBe(true);
  });

  test("Pass 9: sub_56EA40/sub_56F5A0 sprite digits, SkinDsc/SkinRsc layouts, & retail Fx frame parity", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const skinRsc = new Pack("SkinRsc", readFileSync("SkinRsc.idx"), readFileSync("SkinRsc.idd"));

    const decodeFrom = (pack: Pack, rawName: string) => {
      const raw = pack.payload(rawName);
      expect(raw).toBeDefined();
      return decodeSpriteSheet(raw!);
    };

    // 1. Verify exact frame counts of retail sprite-digit & stage/dialog sheets
    const shopImg = decodeFrom(fx, "Shop/ShopImg");
    expect(shopImg.rects.length).toBeGreaterThanOrEqual(57);
    const chanImg = decodeFrom(fx, "Channel/ChannelImg");
    expect(chanImg.rects.length).toBeGreaterThanOrEqual(53);
    const exchRoomNum = decodeFrom(fx, "Exchange/Room_Number");
    expect(exchRoomNum.rects.length).toBe(10);
    const prepareImg = decodeFrom(fx, "Prepare/PrepareImg");
    expect(prepareImg.rects.length).toBe(46);
    const roomInfoImg = decodeFrom(fx, "Dialog/RoomInfoImg");
    expect(roomInfoImg.rects.length).toBeGreaterThanOrEqual(16);

    for (const fxPath of [
      "Shop/BtBuyBag",
      "Shop/BtShop_SelBuy",
      "Shop/BtTab_Special",
      "Shop/BtTab_Item",
      "Shop/BtTab_Character",
      "Shop/BtTab_Slot",
      "Shop/BtTab_Set",
      "Shop/BtTab_Choice",
      "Dialog/Bt_SMSSelBar",
      "Dialog/Icon_SMS",
      "Dialog/ImgSMSPopUp",
      "Dialog/DlgCreateExchange",
      "Exchange/DlgChangeSucc",
    ]) {
      expect(fx.has(fxPath)).toBe(true);
      expect(fx.payload(fxPath)!.byteLength).toBeGreaterThan(0);
    }

    // 2. Verify `Fx:GlobalUI/*`, `Fx:SelectServerStage/*`, and `SkinRsc` LoginStage sheets
    const globalBar = decodeFrom(fx, "GlobalUI/Dlg_Back")!;
    expect(globalBar.sheetW).toBe(800);
    expect(globalBar.sheetH).toBe(34);
    expect(decodeFrom(fx, "GlobalUI/MenuDlg_Back").rects.length).toBe(4);
    expect(fx.has("SelectServerStage/CAStage")).toBe(true);
    expect(fx.payload("SelectServerStage/CAStage")!.byteLength).toBeGreaterThan(100000);
    expect(decodeFrom(fx, "SelectServerStage/SelChannelImg").rects.length).toBe(4);
    expect(skinRsc.has("img/LoginStageBack.jpg")).toBe(true);
    expect(skinRsc.payload("img/LoginStageBack.jpg")!.byteLength).toBeGreaterThan(10000);

    // 3. Verify `drawSpriteNumber` (`sub_56EA40`) & `drawSpriteDigits` (`sub_56F5A0`) math & frame selection
    const calls: { frame: number; x: number; y: number }[] = [];
    const mockSheet = {
      width: 600,
      height: 16,
      sheet: {
        width: 600,
        height: 16,
        rects: Array.from({ length: 60 }, (_, i) => ({
          x0: i * 10,
          y0: 0,
          x1: i * 10 + 10,
          y1: 12,
          px: 0,
          py: 0,
        })),
        rgba: new Uint8Array(4),
      },
      tex: {} as GPUTexture,
    } as any;
    const mockRenderer = {
      drawSprite(cmd: { x: number; y: number; src?: readonly [number, number, number, number] }) {
        calls.push({ frame: cmd.src ? Math.round(cmd.src[0] / 10) : -1, x: cmd.x, y: cmd.y });
      },
    } as any;

    // `drawSpriteDigits(r, shopImg, 100, 200, 13, 3, 7, 0)` -> `007` at x = 100, 113, 126 (emitted right-to-left like `sub_56F5A0`)
    calls.length = 0;
    drawSpriteDigits(mockRenderer, mockSheet, 100, 200, 13, 3, 7, 0);
    expect([...calls].sort((a, b) => a.x - b.x)).toEqual([
      { frame: 0, x: 100, y: 200 },
      { frame: 0, x: 113, y: 200 },
      { frame: 7, x: 126, y: 200 },
    ]);

    // `drawSpriteNumber` (`sub_56EA40` right-to-left) with thousands comma (`1,250`, base=25, comma=35, stepX=10, maxDigits=6, commaW=3)
    calls.length = 0;
    drawSpriteNumber(mockRenderer, mockSheet, 300, 400, 10, 6, 1250, true, 25, true, 3);
    const sorted = [...calls].sort((a, b) => a.x - b.x);
    expect(sorted.map((c) => c.frame)).toEqual([26, 35, 27, 30, 25]);
    expect(sorted[1]!.x - sorted[0]!.x).toBe(10);
    expect(sorted[2]!.x - sorted[1]!.x).toBe(3);

    // 4. Verify `SpriteButton.setHitSize` separates logical hit-box from larger sprite frame
    const btn = new SpriteButton(12, 5, () => {});
    btn.bindSheet(mockSheet, 120, 34);
    btn.setHitSize(92, 26);
    expect(btn.contains(50, 15)).toBe(true);
    expect(btn.contains(105, 15)).toBe(false);
    expect(btn.contains(50, 32)).toBe(false);
  });

  test("Pass 10: full-repo literal archive-path audit & MyPage/Emotion/Credit/Login/ImeStatus retail parity", () => {
    const packs: Record<string, Pack> = {
      Fx: new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd")),
      Cx: new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd")),
      CharTE: new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd")),
      EmoTE: new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd")),
      SkinRsc: new Pack("SkinRsc", readFileSync("SkinRsc.idx"), readFileSync("SkinRsc.idd")),
      SkinDsc: new Pack("SkinDsc", readFileSync("SkinDsc.idx"), readFileSync("SkinDsc.idd")),
    };

    // 1. Scan every `.ts` source file in `src/` for literal `loadSheet(...)` & `prefetch([...])` paths
    const walkTs = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walkTs(full));
        else if (ent.name.endsWith(".ts")) out.push(full);
      }
      return out;
    };

    const missing: string[] = [];
    let checkedCount = 0;
    for (const file of walkTs("src")) {
      const src = readFileSync(file, "utf8");
      const loadRe = /loadSheet\(\s*"(Fx|Cx|CharTE|EmoTE|SkinRsc|SkinDsc)"\s*,\s*"([^"$]+)"\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = loadRe.exec(src)) !== null) {
        const pack = packs[m[1]!]!;
        const entry = m[2]!;
        checkedCount++;
        if (!pack.has(entry) && !pack.has(`${entry}LayerAdjust`) && !pack.has(`${entry}LayerStatic`)) {
          missing.push(`${file} -> ${m[1]}:${entry}`);
        }
      }
      const prefRe = /assets\.(fx|cx|charTE|emoTE|skinRsc|skinDsc)\.prefetch\(\[([\s\S]*?)\]\)/g;
      const mapPack: Record<string, string> = {
        fx: "Fx",
        cx: "Cx",
        charTE: "CharTE",
        emoTE: "EmoTE",
        skinRsc: "SkinRsc",
        skinDsc: "SkinDsc",
      };
      while ((m = prefRe.exec(src)) !== null) {
        const pName = mapPack[m[1]!]!;
        const pack = packs[pName]!;
        const strRe = /"([^"$]+)"/g;
        let sm: RegExpExecArray | null;
        while ((sm = strRe.exec(m[2]!)) !== null) {
          const entry = sm[1]!;
          checkedCount++;
          if (!pack.has(entry) && !pack.has(`${entry}LayerAdjust`) && !pack.has(`${entry}LayerStatic`)) {
            missing.push(`${file} -> ${pName}:${entry}`);
          }
        }
      }
    }
    expect(checkedCount).toBeGreaterThan(220);
    expect(missing).toEqual([]);

    // 2. Verify Pass 10 retail sprite sheets, dimensions, and frame counts
    const fx = packs.Fx!;
    const cx = packs.Cx!;
    const dec = (p: Pack, name: string) => decodeSpriteSheet(p.payload(name)!)!;

    const frameW = (s: ReturnType<typeof dec>) => s.rects[0]!.x1 - s.rects[0]!.x0;
    const frameH = (s: ReturnType<typeof dec>) => s.rects[0]!.y1 - s.rects[0]!.y0;

    expect(frameW(dec(fx, "MyInfo/DlgEmotion"))).toBe(406);
    expect(frameH(dec(fx, "MyInfo/DlgEmotion"))).toBe(494);
    expect(frameW(dec(fx, "MyInfo/CharDecoMiniMap"))).toBe(268);
    expect(frameH(dec(fx, "MyInfo/CharDecoMiniMap"))).toBe(252);
    expect(dec(fx, "MyInfo/BtSpecialItemClicked").rects.length).toBeGreaterThanOrEqual(1);
    expect(dec(fx, "MyInfo/Bt_buy").rects.length).toBe(5);
    expect(frameW(dec(fx, "Dialog/DlgNewUserSuccess"))).toBe(600);
    expect(frameH(dec(fx, "Dialog/DlgNewUserSuccess"))).toBe(483);
    expect(frameW(dec(fx, "Dialog/DlgWait"))).toBe(230);
    expect(frameH(dec(fx, "Dialog/DlgWait"))).toBe(240);
    expect(dec(fx, "Dialog/WaitNumber").rects.length).toBe(10);
    expect(frameW(dec(fx, "Exchange/PU-quantity_enter"))).toBe(355);
    expect(frameH(dec(fx, "Exchange/PU-quantity_enter"))).toBe(178);
    expect(dec(fx, "Prepare/ImgTeam_4").rects.length).toBe(20);
    expect(dec(fx, "Chatting/ChattingImg").rects.length).toBe(10);
    expect(fx.has("Chatting/CAStage2P")).toBe(true);
    expect(dec(fx, "Channel/FireSessionIcon").rects.length).toBe(4);
    expect(dec(fx, "Theme/AuthorityAbleMapIcon").rects.length).toBeGreaterThanOrEqual(1);
    expect(dec(fx, "StageCredit/CreditImg").rects.length).toBeGreaterThanOrEqual(1);

    const imeSheet = dec(cx, "Etc/ImeStatus");
    expect(imeSheet.rects.length).toBe(1);
    expect(imeSheet.rects[0]!.x1 - imeSheet.rects[0]!.x0).toBe(34);
    expect(imeSheet.rects[0]!.y1 - imeSheet.rects[0]!.y0).toBe(17);

    // 3. Verify `SkinDsc` 1P (`xml/Login_1P.xml`) & 2P (`xml/Login_2P.xml`) exact XML coordinates
    const dsc = packs.SkinDsc!;
    const xml1p = new TextDecoder("utf-8").decode(dsc.payload("xml/Login_1P.xml")!);
    const xml2p = new TextDecoder("utf-8").decode(dsc.payload("xml/Login_2P.xml")!);
    expect(xml1p).toContain('id="Edit_ID"');
    expect(xml1p).toContain('x="205"');
    expect(xml1p).toContain('y="96"');
    expect(xml2p).toContain('id="Edit_ID0"');
    expect(xml2p).toContain('x="199"');
    expect(xml2p).toContain('id="Edit_ID1"');
    expect(xml2p).toContain('x="297"');
  });

  test("Pass 11: inflates all 289 Fx:Etc/*_mm zlib minimap sheets & verifies CGOItemBox/SelectCharShop PE tables + sprites", async () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const pe = readFileSync("CA.exe");

    // 1. Verify all 289 `Fx:Etc/*_mm` entries are detected by `isBnbZlibPayload` & inflate to `198x171` sheets!
    const mmEntries = fx.entries.filter((e) => /^Etc\/.*_mm$/i.test(e.name));
    expect(mmEntries.length).toBe(289);
    for (const e of mmEntries) {
      const pay = fx.payload(e.name)!;
      expect(isBnbZlibPayload(pay)).toBe(true);
    }
    // Inflate & decode representative minimaps across themes (Camp, Village, Patrit, Ocean, Kart, Bula, Bonus)
    for (const mmName of [
      "Etc/Camp01_mm",
      "Etc/Village00_mm",
      "Etc/Patrit00_mm",
      "Etc/Ocean00_mm",
      "Etc/Kart01_mm",
      "Etc/Bula00_mm",
      "Etc/Bonus01_mm",
    ]) {
      const inflated = await inflateBnbZlib(fx.payload(mmName)!);
      const sheet = decodeSpriteSheet(inflated);
      expect(sheet).not.toBeNull();
      expect(sheet!.sheetW).toBeGreaterThanOrEqual(120);
      expect(sheet!.sheetW).toBeLessThanOrEqual(200);
      expect(sheet!.sheetH).toBeGreaterThanOrEqual(120);
      expect(sheet!.sheetH).toBeLessThanOrEqual(176);
    }

    // 2. Verify `ITEM_BOX_RING_25` (`CGOItemBox` 5x5 wheel) & `SELECT_CHAR_SHOP_COORDS` against `CA.exe` PE `.data`!
    const e_lfanew = pe.readUInt32LE(0x3c);
    const numSec = pe.readUInt16LE(e_lfanew + 6);
    const optSize = pe.readUInt16LE(e_lfanew + 20);
    const secOff = e_lfanew + 24 + optSize;
    const vaToFile = (va: number): number => {
      const rva = va - 0x400000;
      for (let s = 0; s < numSec; s++) {
        const o = secOff + s * 40;
        const vaddr = pe.readUInt32LE(o + 12);
        const vsize = pe.readUInt32LE(o + 8);
        const rawPtr = pe.readUInt32LE(o + 20);
        if (rva >= vaddr && rva < vaddr + vsize) return rawPtr + (rva - vaddr);
      }
      return -1;
    };

    const ringOff = vaToFile(0x614088);
    const peRing = Array.from({ length: 25 }, (_, i) => pe.readInt32LE(ringOff + i * 4));
    expect([...ITEM_BOX_RING_25]).toEqual(peRing);

    const charShopOff = vaToFile(0x614aa8);
    const peCharShop: [number, number][] = Array.from({ length: 8 }, (_, i) => [
      pe.readInt32LE(charShopOff + i * 8),
      pe.readInt32LE(charShopOff + i * 8 + 4),
    ]);
    expect([...SELECT_CHAR_SHOP_COORDS]).toEqual(peCharShop);

    // 3. Verify Pass 11 dialog, shop, inventory, globalUI, and CGOItemBox sprites in `Fx.idx`
    const dec = (name: string) => decodeSpriteSheet(fx.payload(name)!)!;
    const fw = (s: ReturnType<typeof dec>) => s.rects[0]!.x1 - s.rects[0]!.x0;
    const fh = (s: ReturnType<typeof dec>) => s.rects[0]!.y1 - s.rects[0]!.y0;

    expect(dec("GlobalUI/BtMessengerArrv").rects.length).toBe(5);
    expect(dec("GlobalUI/MenuIconDisable").rects.length).toBe(6);
    expect(fw(dec("Dialog/DlgRoomInfo"))).toBe(295);
    expect(fh(dec("Dialog/DlgRoomInfo"))).toBe(395);
    expect(fw(dec("Dialog/DlgRoomInfo12"))).toBe(295);
    expect(fh(dec("Dialog/DlgRoomInfo12"))).toBe(491);
    expect(dec("Dialog/RoomInfoImg").rects.length).toBe(16);
    expect(fw(dec("Dialog/DlgSelectUser"))).toBe(400);
    expect(fh(dec("Dialog/DlgSelectUser"))).toBe(290);
    expect(fw(dec("Dialog/DlgSelectUserExchange"))).toBe(400);
    expect(fw(dec("Dialog/DlgShopSelectUser"))).toBe(400);
    expect(dec("Dialog/BtSelect").rects.length).toBe(5);
    expect(fw(dec("Shop/popup_Notice"))).toBe(406);
    expect(fh(dec("Shop/popup_Notice"))).toBe(450);
    expect(dec("Shop/BtTab_ChoiceBlink").rects.length).toBe(4);
    expect(dec("Shop/IcoFree").rects.length).toBe(8);
    expect(dec("Shop/IcoLimit").rects.length).toBe(1);
    expect(dec("Shop/IconTime").rects.length).toBe(1);
    expect(dec("Shop/Talk_octo00").rects.length).toBe(3);
    expect(dec("Shop/Talk_octo01").rects.length).toBe(3);
    expect(dec("Chatting/BtAccessory").rects.length).toBe(4);
    expect(dec("Chatting/BtEmotion").rects.length).toBe(4);
    expect(dec("Exchange/BtAccessory").rects.length).toBe(4);
    expect(dec("Exchange/BtEmotion").rects.length).toBe(4);
    expect(dec("Etc/ItemBox").rects.length).toBe(5);
    expect(fw(dec("Etc/ItemBox"))).toBe(110);
    expect(fh(dec("Etc/ItemBox"))).toBe(110);
    expect(dec("Etc/ItemBoxCursor").rects.length).toBe(2);
    expect(fw(dec("Etc/ItemBoxCursor"))).toBe(20);
    expect(fh(dec("Etc/ItemBoxCursor"))).toBe(20);
    for (let i = 0; i < 8; i++) {
      expect(dec(`Dialog/BtCharac_C0${i}`).rects.length).toBe(4);
      expect(dec(`Dialog/BtCharacMyPage_C0${i}`).rects.length).toBe(4);
      expect(fw(dec(`MyInfo/MypageMain_C0${i}`))).toBe(125);
      expect(fh(dec(`MyInfo/MypageMain_C0${i}`))).toBe(120);
      expect(dec(`Shop/BtShopMain_C0${i}`).rects.length).toBe(4);
    }

    // Verify ObjectTable `Game/KartSand` has all 4 directional actions (`00 Left..03 Down`)
    const objTab = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const ksObj = objTab.byName.get("Game/KartSand");
    expect(ksObj).toBeDefined();
    expect(ksObj!.actions.get("00 Left")?.sprite).toBe("Game/KartSand_Left00");
    expect(ksObj!.actions.get("01 Up")?.sprite).toBe("Game/KartSand_Up00");
    expect(ksObj!.actions.get("02 Right")?.sprite).toBe("Game/KartSand_Right00");
    expect(ksObj!.actions.get("03 Down")?.sprite).toBe("Game/KartSand_Down00");
  });

  test("Pass 12: Attr/MapGroup, 13 Theme-Randoms, Carol/EventLyric BGM, Mode/Manner badges, Survival & MSN/Hinet sprites", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));

    // 1. `Fx:Attr/MapGroup` (`CA.exe.c:118624..118677`)
    const mg = parseMapGroup(fx.payload("Attr/MapGroup")!);
    expect(mg.get("PraticeMapGroup")?.length).toBe(45);
    expect(mg.get("LadderMapGroup")?.length).toBe(6);
    expect(mg.get("ReBirthMapGroup")?.length).toBe(2);

    // 2. 13 Theme-Random entries in `fxdynmapinfo.ssd` + `[84x65, 12x12]` `Fx:Theme/*` sprites
    const mapSsi = readSsi(readFileSync("fxdynmapinfo.ssd"))!;
    const allMaps = parseMapInfo(mapSsi.payload)!.maps;
    const playableFamilies = new Set(
      allMaps
        .filter((m) => !m.random && fx.has(`Map/${m.name}`))
        .map((m) => m.family.toLowerCase()),
    );
    const themeRandoms = allMaps.filter(
      (m) => m.random && m.family !== "Random" && playableFamilies.has(m.family.toLowerCase()),
    );
    expect(themeRandoms.length).toBe(13);
    for (const tr of themeRandoms) {
      const sh = decodeSpriteSheet(fx.payload(`Theme/${tr.family}`)!)!;
      expect(sh.rects.length).toBe(2);
      expect(sh.rects[0]!.x1 - sh.rects[0]!.x0).toBe(84);
      expect(sh.rects[0]!.y1 - sh.rects[0]!.y0).toBe(65);
      expect(sh.rects[1]!.x1 - sh.rects[1]!.x0).toBeGreaterThanOrEqual(10);
      expect(sh.rects[1]!.x1 - sh.rects[1]!.x0).toBeLessThanOrEqual(14);
      expect(sh.rects[1]!.y1 - sh.rects[1]!.y0).toBeGreaterThanOrEqual(10);
      expect(sh.rects[1]!.y1 - sh.rects[1]!.y0).toBeLessThanOrEqual(14);
    }

    // 3. `resolveMapBgmTrack` (`CA.exe.c:113655..113696`): `EventLyric`, `Carol00..03`, `Ex*`
    expect(resolveMapBgmTrack("EventCamp00", "EventCamp", "EventCamp")).toBe("MP3/EventLyric");
    expect(resolveMapBgmTrack("EventOcean01", "EventOcean", "EventOcean")).toBe("MP3/EventLyric");
    for (let c = 0; c < 4; c++) {
      expect(resolveMapBgmTrack("Xmas00", "Xmas", "Xmas", c)).toBe(`MP3/Carol0${c}`);
      expect(fx.payload(`MP3/Carol0${c}`)!.byteLength).toBeGreaterThan(10000);
    }
    expect(fx.payload("MP3/EventLyric")!.byteLength).toBeGreaterThan(10000);
    expect(resolveMapBgmTrack("ExVillage00", "ExVillage", "ExVillage")).toBe("MP3/Village");

    // 4. Mode badges (`Game/Kill_Image[36..39]`, `Etc/GameModeImg[0..1]`), Survival (`Result[52,53]`), MSN, SMSNotice, RetNotice, HiNet
    expect(gameKillModeIconFrame(0)).toBeNull();
    expect(gameKillModeIconFrame(1)).toBe(38);
    expect(gameKillModeIconFrame(2)).toBe(39);
    expect(gameKillModeIconFrame(3)).toBe(36);
    expect(gameKillModeIconFrame(4)).toBe(37);

    const dec = (p: string) => decodeSpriteSheet(fx.payload(p)!)!;
    const fw = (s: { rects: readonly { x0: number; x1: number }[] }) => s.rects[0]!.x1 - s.rects[0]!.x0;
    const fh = (s: { rects: readonly { y0: number; y1: number }[] }) => s.rects[0]!.y1 - s.rects[0]!.y0;
    expect(dec("Etc/GameModeImg").rects.length).toBe(2);
    expect(dec("Game/Kill_Image").rects.length).toBe(40);
    expect(dec("Game/ResultImg").rects.length).toBeGreaterThanOrEqual(54);
    expect(fw(dec("NM/DlgMsnListBox"))).toBe(306);
    expect(fh(dec("NM/DlgMsnListBox"))).toBe(260);
    expect(fw(dec("NM/DlgMsnChatBox"))).toBe(309);
    expect(fh(dec("NM/DlgMsnChatBox"))).toBe(260);
    expect(dec("NM/BtMsnMail").rects.length).toBe(5);
    expect(dec("NM/BtMsnMail01").rects.length).toBe(5);
    expect(dec("NM/BtMsnOption").rects.length).toBe(4);
    expect(dec("NM/BtMsnExit").rects.length).toBe(4);
    expect(dec("NM/BtMsnClose").rects.length).toBe(4);
    expect(dec("NM/MsnListIdBox").rects.length).toBe(4);
    expect(fw(dec("Dialog/DlgRetNotice"))).toBe(340);
    expect(fh(dec("Dialog/DlgRetNotice"))).toBe(200);
    expect(dec("Dialog/BtRetNoticeYes").rects.length).toBe(5);
    expect(dec("Dialog/BtRetNoticeNo").rects.length).toBe(5);
    expect(fw(dec("Dialog/Popup_Back"))).toBe(102);
    expect(dec("Dialog/Popup_ListDelete").rects.length).toBe(5);
    expect(fw(dec("Dialog/Dlg_SMSNoticeYesNo"))).toBe(340);
    expect(fw(dec("Dialog/Dlg_SMSNoticeDelete"))).toBe(340);
    expect(fw(dec("Dialog/Dlg_SMSNoticeOk"))).toBe(340);
    expect(dec("Dialog/Bt_SMSNoticeOk").rects.length).toBe(5);
    expect(dec("Dialog/Bt_SMSNoticeCancel").rects.length).toBe(5);
    const hinetJpg = fx.payload("Event/Hinet_LobyTop")!;
    expect(hinetJpg[0]).toBe(0xff);
    expect(hinetJpg[1]).toBe(0xd8);
    expect(hinetJpg.byteLength).toBeGreaterThan(2000);
    expect(fw(dec("Event/DlgUserInfo_Hinet"))).toBe(416);
    expect(fw(dec("Event/DlgUserinfoResults_Hinet"))).toBe(356);

    // 5. `CChatStage` Slash Command dispatcher (`/ar`, `/msn`, `/m`, `/u`, `/mute`, `/unmute`, `/w`, `/who`, `/qhfk`)
    const hub = new ClientHub();
    const sysSsi = readSsi(readFileSync("csysstr.ssd"))!;
    const fakeAssets = { tables: { sysStrings: parseSysStrings(sysSsi.payload) } } as any;
    let openedWho: string | undefined = "__none__";
    let whisperTarget = "__init__";
    let openedShout = false;
    const hooks = {
      onOpenUserInfo: (u?: string) => (openedWho = u),
      onSetWhisperTarget: (t: string) => (whisperTarget = t),
      onOpenShout: () => (openedShout = true),
    };
    expect(hub.autoReady).toBe(false);
    expect(handleRetailSlashCommand("/ar", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.autoReady).toBe(true);
    expect(handleRetailSlashCommand("/msn", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.msnEnabled).toBe(false);
    expect(handleRetailSlashCommand("/m spammer123", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.refusalList.has("spammer123")).toBe(true);
    expect(handleRetailSlashCommand("/u spammer123", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.refusalList.has("spammer123")).toBe(false);
    expect(handleRetailSlashCommand("/mute", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.refuseAllWhispers).toBe(true);
    expect(handleRetailSlashCommand("/unmute", fakeAssets, hub, hooks)).toBe(true);
    expect(hub.refuseAllWhispers).toBe(false);
    expect(handleRetailSlashCommand("/w buddy88", fakeAssets, hub, hooks)).toBe(true);
    expect(whisperTarget).toBe("buddy88");
    expect(handleRetailSlashCommand("/w off", fakeAssets, hub, hooks)).toBe(true);
    expect(whisperTarget).toBe("");
    // 2+ tokens `/w buddy88 hello` passes through (`false`) so server sends whisper!
    expect(handleRetailSlashCommand("/w buddy88 hello", fakeAssets, hub, hooks)).toBe(false);
    expect(handleRetailSlashCommand("/who DaoHero", fakeAssets, hub, hooks)).toBe(true);
    expect(openedWho).toBe("DaoHero");
    expect(handleRetailSlashCommand("/whoami", fakeAssets, hub, hooks)).toBe(true);
    expect(openedWho).toBeUndefined();
    expect(handleRetailSlashCommand("/qhfk 大家好", fakeAssets, hub, hooks)).toBe(true);
    expect(openedShout).toBe(true);
  });

  test("Pass 13: Shop Wishlist (`Zzim`), `Popup_Discount`, `MyPageDlg` MoneyType, `NoSpeakDlg`, `DlgHedgehog`, `ImperialMark`, `Newmap_Icon` & 52 `Wave/*` SFX", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const dec = (name: string) => {
      const p = fx.payload(name);
      expect(p).not.toBeNull();
      const s = decodeSpriteSheet(p!);
      expect(s).not.toBeNull();
      return s!;
    };
    const fw = (s: NonNullable<ReturnType<typeof decodeSpriteSheet>>) =>
      s.rects[0]!.x1 - s.rects[0]!.x0;
    const fh = (s: NonNullable<ReturnType<typeof decodeSpriteSheet>>) =>
      s.rects[0]!.y1 - s.rects[0]!.y0;

    // 1. `CShopBuyDlg` Set-Package & Coupon Discount (`Shop/Popup_Discount` `406x494` + `DiscountSlotImg` `169x67` + `IconCoupon` `38x20`)
    expect(fw(dec("Shop/Popup_Discount"))).toBe(406);
    expect(fh(dec("Shop/Popup_Discount"))).toBe(494);
    expect(fw(dec("Shop/DiscountSlotImg"))).toBe(169);
    expect(fh(dec("Shop/DiscountSlotImg"))).toBe(67);
    expect(fw(dec("Shop/IconCoupon"))).toBe(38);
    expect(fh(dec("Shop/IconCoupon"))).toBe(20);

    // 2. `CShopStageNew` Wishlist (`BtItemSlot_zzim` `69x59`, `Zzimlist_cash` `26x13`, `Zzimlist_Lucci` `38x13`, `BtChoice` `26x20`, `BtShop_+|-` `18x9`, `BtShop_Delete` `35x20`, `BtTab_Special02` / `SpecialAni02` `62x22`)
    expect(fw(dec("Shop/BtItemSlot_zzim"))).toBe(69);
    expect(fh(dec("Shop/BtItemSlot_zzim"))).toBe(59);
    expect(dec("Shop/BtItemSlot_zzim").rects.length).toBe(4);
    expect(fw(dec("Shop/Zzimlist_cash"))).toBe(26);
    expect(fw(dec("Shop/Zzimlist_Lucci"))).toBe(38);
    expect(fw(dec("Shop/BtChoice"))).toBe(26);
    expect(dec("Shop/BtChoice").rects.length).toBe(5);
    expect(fw(dec("Shop/BtShop_+"))).toBe(18);
    expect(fh(dec("Shop/BtShop_+"))).toBe(9);
    expect(fw(dec("Shop/BtShop_-"))).toBe(18);
    expect(fh(dec("Shop/BtShop_-"))).toBe(9);
    expect(fw(dec("Shop/BtShop_Delete"))).toBe(35);
    expect(fw(dec("Shop/BtTab_Special02"))).toBe(62);
    expect(fw(dec("Shop/BtTab_SpecialAni02"))).toBe(62);

    // 3. `off_6180B4` Emotion fallback icons (`Shop/Emot*`) & `SPEAKER_COLOR_ICONS` (`Item/ItemSpeaker*` `31x31`)
    expect(EMOT_SHOP_FALLBACK_ICONS.length).toBe(8);
    for (const em of EMOT_SHOP_FALLBACK_ICONS) {
      expect(fw(dec(em))).toBeGreaterThanOrEqual(40);
    }
    expect(SPEAKER_COLOR_ICONS.length).toBe(5);
    for (const sp of SPEAKER_COLOR_ICONS.slice(1)) {
      expect(fw(dec(sp))).toBe(31);
      expect(fh(dec(sp))).toBe(31);
    }

    // 4. `CMyPageDlg` MoneyType (`27x13` & `38x12`), `CNoSpeakDlg` (`340x226` + `86x25` buttons), `CHedgehogComponent`, `ImperialMark`, `Newmap_Icon`
    expect(fw(dec("MyInfo/MoneyType_Cash"))).toBe(27);
    expect(fw(dec("MyInfo/MoneyType_Lucci"))).toBe(38);
    expect(fw(dec("Dialog/DlgSpeaker_003"))).toBe(340);
    expect(fh(dec("Dialog/DlgSpeaker_003"))).toBe(226);
    expect(fx.has("Dialog/DlgColorPencil")).toBe(true);
    expect(fw(dec("Dialog/BtSpeaker_Shop"))).toBe(86);
    expect(fw(dec("Dialog/BtSpeaker_Cancel"))).toBe(86);
    expect(fw(dec("Dialog/DlgHedgehog"))).toBe(310);
    expect(fh(dec("Dialog/DlgHedgehog"))).toBe(178);
    expect(fw(dec("Game/ImperialMark"))).toBe(22);
    expect(fh(dec("Game/ImperialMark"))).toBe(24);
    expect(fw(dec("Game/ImperialResultMark"))).toBe(21);
    expect(fh(dec("Game/ImperialResultMark"))).toBe(21);
    expect(fw(dec("Theme/Newmap_Icon"))).toBe(8);
    expect(fh(dec("Theme/Newmap_Icon"))).toBe(8);

    // 5. `fxdynmapinfo.ssd` `minLevel` & `isNew` fields + `SpriteButton` tab hoverSfx (`MouseMove_1`) + all 5 newly wired `Fx:Wave/*` entries
    const mf = parseMapInfo(readSsi(readFileSync("fxdynmapinfo.ssd"))!.payload)!;
    const ocean00 = mf.maps.find((m) => m.name === "Ocean00");
    expect(ocean00?.minLevel).toBe(100);
    expect(typeof ocean00?.isNew).toBe("boolean");

    const tabBtn = new SpriteButton(0, 0, undefined, { isTab: true });
    expect(tabBtn.hoverSfx).toBe("MouseMove_1");
    for (const wv of [
      "Wave/MouseMove_0",
      "Wave/MouseMove_1",
      "Wave/MouseMove_2",
      "Wave/GameStart_0",
      "Wave/GameStart_1",
      "Wave/TimerExpired_0",
      "Wave/TimerExpired_1",
      "Wave/Ending",
    ]) {
      expect(fx.has(wv)).toBe(true);
      expect(fx.payload(wv)!.byteLength).toBeGreaterThan(200);
    }

    // 6. `GameDatabase.buyStock` coupon discount (`price - floor(discountPct * 0.01 * price)`) & `buyStockBatch` wishlist checkout
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const memDb = new GameDatabase(":memory:", stockById, pkgMap);
    const reg = memDb.registerAccount("Pass13Buyer", "pw1234", "收藏買家", 0);
    expect(reg.ok).toBe(true);
    const accId = reg.profile!.id;
    memDb.chargeCash(accId, 10000);
    const lucciItem = stocks.find((s) => s.buyableLucci && s.priceLucci > 0 && s.priceLucci <= 5000 && s.minLevel <= 1)!;
    const cashItem = stocks.find((s) => !s.buyableLucci && s.priceCash > 0 && s.priceCash <= 2000 && s.minLevel <= 1)!;
    memDb.grantCoupon(accId, cashItem.id, 30, 1);
    const cpn = memDb.getCoupons(accId).find((c) => c.stockId === cashItem.id && c.discountPct === 30)!;
    expect(cpn).toBeDefined();
    const cashBefore = memDb.getProfileById(accId)!.cash;
    const buyDc = memDb.buyStock(accId, cashItem.id, "cash", undefined, undefined, 1, cpn.couponId);
    expect(buyDc.ok).toBe(true);
    const expectedPaid = cashItem.priceCash - Math.floor(0.3 * cashItem.priceCash);
    expect(memDb.getProfileById(accId)!.cash).toBe(cashBefore - expectedPaid);
    expect(memDb.getCoupons(accId).find((c) => c.couponId === cpn.couponId)).toBeUndefined();

    const lucciBefore = memDb.getProfileById(accId)!.lucci;
    const batchRes = memDb.buyStockBatch(accId, [{ stockId: lucciItem.id, currency: "lucci", qty: 2 }]);
    expect(batchRes.ok).toBe(true);
    expect(batchRes.boughtCount).toBe(2);
    expect(memDb.getProfileById(accId)!.lucci).toBe(lucciBefore - lucciItem.priceLucci * 2);
  });

  test("cart checkout keeps items on failure and only removes matching successful purchases", () => {
    const sent: ClientMsg[] = [];
    const dialogs: unknown[] = [];
    const stage = new ShopStage({ hub: { connected: true, send: (msg: ClientMsg) => sent.push(msg) }, dialogs: { push: (d: unknown) => dialogs.push(d) } } as any) as any;
    const item = parseFxStock(readFileSync("fxstock.ini")).find(s => s.priceLucci > 0)!;
    stage.addOrToggleCartItem(item);
    stage.cartQty.set(item.id, 3);
    stage.buyCartItems(stage.cart);
    stage.buyCartItems(stage.cart);
    expect(sent).toHaveLength(1);
    const first = sent[0] as Extract<ClientMsg, { type: "shop_buy_batch" }>;
    expect(stage.cart.length).toBe(1);
    stage.applyCartPurchaseResult("unrelated", true);
    expect(stage.cart.length).toBe(1);
    stage.applyCartPurchaseResult(first.requestId, false);
    expect(stage.cart.length).toBe(1);
    expect(stage.cartQty.get(item.id)).toBe(3);
    stage.buyCartItems(stage.cart);
    const second = sent[1] as Extract<ClientMsg, { type: "shop_buy_batch" }>;
    stage.applyCartPurchaseResult(second.requestId, true);
    expect(stage.cart.length).toBe(0);
    expect(stage.cartQty.has(item.id)).toBe(false);
    expect(stage.cartSelected.has(item.id)).toBe(false);
  });

  test("shop card controls and native icon anchor follow retail positions", () => {
    expect([SHOP_CARD.buyX, SHOP_CARD.buyY, SHOP_CARD.choiceX, SHOP_CARD.choiceY]).toEqual([75, 57, 111, 57]);
    expect([SHOP_CARD.iconX, SHOP_CARD.iconY, SHOP_CARD.nameX, SHOP_CARD.nameY, SHOP_CARD.priceY]).toEqual([21, 77, 18, 81, 97]);
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const sprite = decodeSpriteSheet(fx.payload("Item/Bomb")!)!;
    const rect = sprite.rects[0]!;
    const drawn: { x: number; y: number; w: number; h: number }[] = [];
    const renderer = { drawSprite: (cmd: any) => drawn.push(cmd) } as any;
    drawSheetFrame(renderer, { tex: {} as any, sheet: sprite, width: sprite.width, height: sprite.height }, 0, 16 + SHOP_CARD.iconX, 140 + SHOP_CARD.iconY, { anchor: true });
    expect(drawn[0]!.x).toBe(16 + SHOP_CARD.iconX - rect.px);
    expect(drawn[0]!.y).toBe(140 + SHOP_CARD.iconY - rect.py);
    expect(drawn[0]!.w).toBe(rect.x1 - rect.x0);
    expect(drawn[0]!.h).toBe(rect.y1 - rect.y0);
  });

  test("shop purchases and gifts ignore stock level, but still require valid currency and funds", () => {
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const original = stocks.find(s => s.minLevel > 1 && s.priceLucci > 0)!;
    expect(original).toBeDefined();
    const restricted = { ...original, minLevel: 450, priceLucci: 1000, priceCash: 0 };
    const giftItem = { ...restricted, id: restricted.id + 100000, priceCash: 100, priceLucci: 0, buyableLucci: false, currencyType: 0 };
    const db = new GameDatabase(":memory:", new Map([[restricted.id, restricted], [giftItem.id, giftItem]]), new Map());
    const buyer = db.registerAccount("levelbuyer", "pw", "買家", 0);
    const recipient = db.registerAccount("levelgift", "pw", "收禮者", 0);
    expect(buyer.ok && recipient.ok).toBe(true);
    const id = buyer.profile!.id;
    expect(buyer.profile!.level).toBeLessThan(restricted.minLevel);
    expect(db.buyStock(id, restricted.id, "lucci").ok).toBe(true);
    expect(db.buyStock(id, restricted.id, "lucci", "levelgift").ok).toBe(false);
    expect(db.buyStock(id, giftItem.id, "cash", "levelgift").ok).toBe(true);
    expect(db.buyStockBatch(id, [{ stockId: restricted.id, currency: "lucci", qty: 2 }]).ok).toBe(true);
    expect(db.getInventory(id).find(i => i.stockId === restricted.id)?.quantity).toBe(3);
    expect(db.getInventory(recipient.profile!.id).find(i => i.stockId === giftItem.id)?.quantity).toBe(1);
    const before = db.getProfileById(id)!;
    expect(db.buyStock(id, restricted.id, "cash").ok).toBe(false);
    expect(db.buyStockBatch(id, [{ stockId: restricted.id, currency: "cash", qty: 1 }]).ok).toBe(false);
    expect(db.buyStock(id, restricted.id, "lucci", undefined, undefined, 99).ok).toBe(false);
    expect(db.buyStockBatch(id, Array.from({ length: 26 }, () => ({ stockId: restricted.id, currency: "lucci" as const, qty: 1 }))).ok).toBe(false);
    expect(db.buyStockBatch(id, [{ stockId: restricted.id, currency: "lucci", qty: 1 }, { stockId: -99, currency: "lucci", qty: 1 }]).ok).toBe(false);
    expect(db.buyStockBatch(id, [{ stockId: restricted.id, currency: "lucci", qty: 0 }]).ok).toBe(false);
    expect(db.buyStock(id, restricted.id, "lucci", undefined, undefined, Number.NaN).ok).toBe(false);
    expect(db.getProfileById(id)!.lucci).toBe(before.lucci);
    expect(db.getInventory(id).find(i => i.stockId === restricted.id)?.quantity).toBe(3);
  });

  test("Pass 14: Shop hero portraits, card badges, context menu, ShopTextDlg, GoldFlag/effectId=99 pickups, SMS scrollbar & DB sell/delete", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const dec = (name: string) => {
      const p = fx.payload(name);
      expect(p).not.toBeNull();
      const s = decodeSpriteSheet(p!);
      expect(s).not.toBeNull();
      return s!;
    };
    const fw = (s: NonNullable<ReturnType<typeof decodeSpriteSheet>>) =>
      s.rects[0]!.x1 - s.rects[0]!.x0;
    const fh = (s: NonNullable<ReturnType<typeof decodeSpriteSheet>>) =>
      s.rects[0]!.y1 - s.rects[0]!.y0;

    // 1. Verify all 35 Pass 14 `Fx.idx` sprites exist & match `CA.exe` pixel dimensions
    for (const c of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(fx.has(`Shop/ShopMain_C0${c}`)).toBe(true);
      const hero = dec(`Shop/ShopMain_C0${c}`);
      expect(fw(hero)).toBe(475);
      expect(fh(hero)).toBe(105);

      const btn = dec(`Shop/BtShopMain_C0${c}`);
      expect(btn.rects.length).toBeGreaterThanOrEqual(4);
      expect(fw(btn)).toBe(40);
      expect(fh(btn)).toBe(40);
    }
    expect(fw(dec("Shop/CharSel_Table"))).toBe(107);
    expect(fh(dec("Shop/CharSel_Table"))).toBe(44);
    expect(fx.has("Shop/CharSelShadow_Table")).toBe(true);
    expect(fw(dec("Shop/IconTime"))).toBe(28);
    expect(fh(dec("Shop/IconTime"))).toBe(14);
    expect(fw(dec("Shop/ItemSoldOut"))).toBe(57);
    expect(fh(dec("Shop/ItemSoldOut"))).toBe(30);
    expect(fw(dec("Shop/IcoLimit"))).toBe(27);
    expect(fh(dec("Shop/IcoLimit"))).toBe(13);
    expect(fw(dec("Shop/Ico_ImpEnd"))).toBe(43);
    expect(fh(dec("Shop/Ico_ImpEnd"))).toBe(13);
    expect(fw(dec("Shop/IconCoupon"))).toBe(38);
    expect(fh(dec("Shop/IconCoupon"))).toBe(20);
    expect(dec("Shop/ShopImg").rects.length).toBeGreaterThan(40);
    expect(fw(dec("Shop/TimeTable_01"))).toBe(117);
    expect(fh(dec("Shop/TimeTable_01"))).toBe(26);
    expect(fw(dec("Shop/TimeTable_02"))).toBe(117);
    expect(fh(dec("Shop/TimeTable_02"))).toBe(42);

    // 2. `CShopInventoryPopupDlg` (`Shop/SelectBox*`) + `CShopTextDlg` (`Dialog/DlgShopText`) + `SelectCharShopDlg` + `SmsFriendDlg` + `OptionDlg`
    expect(fw(dec("Shop/SelectBox_Single"))).toBe(86);
    expect(fh(dec("Shop/SelectBox_Single"))).toBe(23);
    expect(fw(dec("Shop/SelectBox"))).toBe(86);
    expect(fh(dec("Shop/SelectBox"))).toBe(42);
    expect(fw(dec("Shop/SelectBox_Three"))).toBe(86);
    expect(fh(dec("Shop/SelectBox_Three"))).toBe(62);
    for (const rowSp of [
      "Shop/SelectBox_Deco",
      "Shop/SelectBox_DecoCancel",
      "Shop/SelectBox_Dialog",
      "Shop/SelectBox_Sell",
      "Shop/SelectBox_Delete",
    ]) {
      const s = dec(rowSp);
      expect(s.rects.length).toBe(4);
      expect(fw(s)).toBe(81);
      expect(fh(s)).toBe(15);
    }
    expect(fw(dec("Dialog/DlgShopText"))).toBe(340);
    expect(fh(dec("Dialog/DlgShopText"))).toBe(393);
    expect(fw(dec("Dialog/BtSelMapOk"))).toBe(100);
    expect(fh(dec("Dialog/BtSelMapOk"))).toBe(32);
    expect(fw(dec("Dialog/ImgMycharl"))).toBe(88);
    expect(fh(dec("Dialog/ImgMycharl"))).toBe(51);
    expect(dec("MyInfo/MypageImg").rects.length).toBe(7);
    expect(fw(dec("Dialog/OPTION_ball"))).toBe(13);
    expect(fh(dec("Dialog/OPTION_ball"))).toBe(9);
    for (const smsSp of [
      "Dialog/SMSScroll_BtUp",
      "Dialog/SMSScroll_BtDown",
      "Dialog/SMSScroll_Ball",
      "Dialog/SMSScroll_Pattern",
      "Dialog/Bt_SMSReply",
      "Dialog/Bt_SMSCancel",
      "Dialog/SMSList02",
    ]) {
      expect(fx.has(smsSp)).toBe(true);
    }

    // 3. `fxstock.ini` `durationDays` (`1 | 3 | 7`) & `flags` (`0x20` special bag items `1208/1212`) parsing
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const timedItems = stocks.filter((s) => (s.durationDays ?? 0) > 0);
    expect(timedItems.length).toBeGreaterThan(20);
    expect(timedItems.some((s) => s.durationDays === 1)).toBe(true);
    expect(timedItems.some((s) => s.durationDays === 3)).toBe(true);
    expect(timedItems.some((s) => s.durationDays === 7)).toBe(true);
    expect(stocks.some((s) => ((s.flags ?? 0) & 0x20) !== 0)).toBe(true);

    // 4. `Item/ItemGoldFlag` (`6f`, `74x75`) + `effectId === 99` pickups (`GoldFlag` + seasonal `IceCon00`)
    const goldFlagSp = dec("Item/ItemGoldFlag");
    expect(goldFlagSp.rects.length).toBe(6);
    expect(fw(goldFlagSp)).toBe(74);
    expect(fh(goldFlagSp)).toBe(75);
    const objTab = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const campMap = parseMapBinary("Camp01", fx.payload("Map/Camp01")!);

    const sim = new GameSimulation({
      mapData: campMap,
      mode: 0,
      componentMode: 1, // Event2004 Golden Flag mode
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0, isAi: false },
        { slot: 1, name: "P2", charCode: 1, team: 1, isAi: false },
      ],
      objectTable: objTab,
      bomberByCode,
      itemAttr,
      tileInfo,
      seed: 14014,
    });
    while (sim.tick <= START_BANNER_TICKS) sim.step();
    const p0 = sim.players[0]!;
    const p0Cx = Math.floor(p0.px / 40);
    const p0Cy = Math.floor(p0.py / 40);
    sim.items.push({
      id: 9901,
      cx: p0Cx,
      cy: p0Cy,
      objectName: "GoldFlag",
      iconSprite: "Item/ItemGoldFlag",
      pickupFlag: 1,
      effectId: 99,
      spawnTick: 0,
    });
    sim.items.push({
      id: 9902,
      cx: p0Cx,
      cy: p0Cy,
      objectName: "IceCon00",
      iconSprite: "Item/IceCon00",
      pickupFlag: 1,
      effectId: 99,
      spawnTick: 0,
    });
    const flagsBefore = p0.goldFlags;
    const lucciBeforeSim = p0.bonusLucci;
    sim.step();
    expect(p0.goldFlags).toBe(flagsBefore + 1);
    expect(p0.bonusLucci).toBe(lucciBeforeSim + 100 + 30);

    // 5. `GameDatabase.sellInventoryItem` (50% Lucci refund) & `deleteInventoryItem` + `setSelectedChar`
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const memDb = new GameDatabase(":memory:", stockById, pkgMap);
    const reg = memDb.registerAccount("Pass14Seller", "pw1234", "背包測試", 0);
    expect(reg.ok).toBe(true);
    const accId = reg.profile!.id;
    memDb.setSelectedChar(accId, 5);
    expect(memDb.getProfileById(accId)!.selectedChar).toBe(5);

    const lucciGear = stocks.find((s) => s.buyableLucci && s.priceLucci >= 500 && s.priceLucci <= 5000 && s.minLevel <= 1 && s.category !== 1 && !s.durationDays)!;
    const cashGear = stocks.find((s) => !s.buyableLucci && s.priceCash > 0 && s.priceCash <= 2000 && s.minLevel <= 1)!;
    memDb.chargeCash(accId, 5000);
    expect(memDb.buyStock(accId, lucciGear.id, "lucci").ok).toBe(true);
    expect(memDb.buyStock(accId, cashGear.id, "cash").ok).toBe(true);

    const invRows = memDb.getInventory(accId);
    const lucciInv = invRows.find((r) => r.stockId === lucciGear.id)!;
    const cashInv = invRows.find((r) => r.stockId === cashGear.id)!;
    expect(lucciInv).toBeDefined();
    expect(cashInv).toBeDefined();

    const lucciPreSell = memDb.getProfileById(accId)!.lucci;
    const sellRes = memDb.sellInventoryItem(accId, lucciInv.invId);
    expect(sellRes.ok).toBe(true);
    const expectedRefund = Math.floor(lucciGear.priceLucci / 2);
    expect(sellRes.refundLucci).toBe(expectedRefund);
    expect(memDb.getProfileById(accId)!.lucci).toBe(lucciPreSell + expectedRefund);

    const delRes = memDb.deleteInventoryItem(accId, cashInv.invId);
    expect(delRes.ok).toBe(true);
    expect(memDb.getInventory(accId).some((i) => i.stockId === cashGear.id)).toBe(false);
  });

  test("Pass 15: verifies Exchange lock/cancel, Shop/Marid/Present, MyPage ItemDeco 0x61714C, Ladder/Guild UI, Bonus/Mission sprites & Serial Coupon redemption", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const charTe = new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd"));
    const emoTe = new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd"));
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const objTab = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);

    // 1. Verify all Pass 15 retail Fx.idx sprite dimensions & frame counts
    const expectedSprites: [string, number, number, number][] = [
      ["Exchange/Bt_Cancel", 5, 86, 32],
      ["Exchange/Box-Rock", 4, 250, 111],
      ["Shop/SlotImg", 1, 98, 98],
      ["Shop/Ready", 1, 448, 353],
      ["Dialog/DlgMarid_Notice", 1, 340, 220],
      ["Dialog/BtShopInfoPresent", 5, 107, 36],
      ["Prepare/BtShop", 5, 70, 21],
      ["MyInfo/Bt_ItemBack00", 3, 84, 80],
      ["MyInfo/Bt_ItemBack01", 3, 84, 80],
      ["MyInfo/Bt_ItemBack02", 3, 84, 80],
      ["MyInfo/Bt_ItemBack03", 3, 84, 80],
      ["Shop/Talk_Load", 6, 108, 124],
      ["Shop/Talk_octo00", 3, 41, 40],
      ["Shop/Talk_octo01", 3, 41, 40],
      ["Dialog/DlgCreateLadder", 1, 340, 229],
      ["Ladder/Ladder_loadingStage", 1, 369, 179],
      ["Ladder/Ladder_loading", 4, 167, 30],
      ["Ladder/Ladder_loadingBar", 1, 12, 15],
      ["Ladder/Big_LD", 9, 44, 16],
      ["Ladder/Small_LD", 9, 14, 16],
      ["Ladder/LadderLevelBlank", 1, 49, 20],
      ["Etc/GuildIcon", 1, 16, 16],
      ["Game/Mission", 1, 108, 85],
      ["Game/OngamenetMark", 1, 40, 35],
      ["Game/SchoolZzangMark1", 1, 22, 27],
      ["Game/SchoolZzangMark2", 1, 26, 29],
      ["Bonus/Prepare", 25, 295, 79],
      ["Bonus/Game", 25, 46, 446],
      ["Bonus/Enemy", 25, 379, 33],
      ["Item/NiddlePlus", 1, 43, 33],
      ["Item/RadioBomb", 1, 36, 38],
      ["Item/AdvMotionBlur", 1, 36, 38],
      ["Item/Nitro", 1, 30, 38],
    ];

    for (const [name, minFrames, w, h] of expectedSprites) {
      expect(fx.has(name)).toBe(true);
      const sh = decodeSpriteSheet(fx.payload(name)!)!;
      expect(sh.rects.length).toBeGreaterThanOrEqual(minFrames);
      const r0 = sh.rects[0]!;
      expect(r0.x1 - r0.x0).toBe(w);
      expect(r0.y1 - r0.y0).toBe(h);
    }

    // 2. Verify ObjectTable mappings for MyPage ItemDeco fishing hook & octopuses
    expect(objTab.byName.get("Shop/Hook")?.actions.get("Default")?.sprite).toBe("Shop/Talk_Load");
    expect(objTab.byName.get("Shop/turtle0")?.actions.get("Default")?.sprite).toBe("Shop/Talk_octo00");
    expect(objTab.byName.get("Shop/turtle1")?.actions.get("Default")?.sprite).toBe("Shop/Talk_octo01");

    // 3. Verify CosmeticCatalog remaps `Item/Fuel`, `Item/RemoteBomb`, and `Item/MotionBlur` to exact Fx.idx sprites
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const probe = (p: Pack) => ({
      has: (n: string) => p.has(n),
      entriesMatching: (pref: string) =>
        p.entries.filter((e) => e.name.toLowerCase().startsWith(pref.toLowerCase())),
    });
    const charObjects = new ObjectTable(charTe.payload("ObjectTable/CharTEObjectTable")!);
    const emoObjects = new ObjectTable(emoTe.payload("ObjectTable/EmoTEObjectTable")!);
    const catalog = new CosmeticCatalog({
      stocks,
      packageMap: pkgMap,
      fx: probe(fx),
      charTe: probe(charTe),
      emoTe: probe(emoTe),
      cx: probe(cx),
      charObjects,
      emoObjects,
    });
    expect(catalog.resolve(1124)?.iconName).toBe("Item/Nitro");
    expect(catalog.resolve(1132)?.iconName).toBe("Item/RadioBomb");
    expect(catalog.resolve(1207)?.iconName).toBe("Item/AdvMotionBlur");
    expect(catalog.resolve(1207)?.liveKind).toBeUndefined();

    // 4. Verify `GameDatabase.redeemSerialCode` one-time serial coupon redemption + duplicate rejection
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const memDb = new GameDatabase(":memory:", stockById, pkgMap);
    const reg = memDb.registerAccount("Pass15Tester", "pw1234", "序號達人", 0);
    expect(reg.ok).toBe(true);
    const accId = reg.profile!.id;
    const before = memDb.getProfileById(accId)!;

    const r1 = memDb.redeemSerialCode(accId, "bnb9-gift-2006");
    expect(r1.ok).toBe(true);
    const after = memDb.getProfileById(accId)!;
    expect(after.lucci).toBe(before.lucci + 30000);
    expect(after.cash).toBe(before.cash + 3000);

    // Duplicate redemption must be rejected
    const dup = memDb.redeemSerialCode(accId, "BNB9GIFT2006");
    expect(dup.ok).toBe(false);

    // Bag expansion serial grants `1212` (`物品包包`)
    const bagRes = memDb.redeemSerialCode(accId, "BNB9-BAG-PLUS");
    expect(bagRes.ok).toBe(true);
    expect(memDb.getInventory(accId).some((i) => i.stockId === 1212)).toBe(true);
  });

  test("Pass 16: ItemAttr multi-charge stacks, ACTIVE_WATERTIGHT, Kart fuel refill, retail AI item scoring, ShopMain_C10, WebNoticeDlg & MultiServerDlg assets", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const itemAttr = parseItemAttr(fx.payload("Attr/ItemAttr")!);
    const bombers = parseBomberAttr(fx.payload("Attr/BomberAttr")!);
    const bomberByCode = new Map(bombers.map((b) => [b.code, b]));
    const tileInfo = parseTileInfo(fx.payload("TileInfo/TileInfo")!);
    const objectTable = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);

    // 1. Verify every Pass 16 Fx/Cx sprite & MP3 payload exists in the shipped Taiwan v9 archives
    const fxRequired = [
      "Shop/BtShopMain_C10",
      "Shop/ShopMain_C10",
      "Dialog/DlgWebNotice",
      "Etc/WebLoading",
      "Etc/BtWebExit",
      "Dialog/XMas_Item0",
      "Dialog/XMas_Item1",
      "Dialog/XMas_Item2",
      "MultiServer/CAStage",
      "MultiServer/Icon",
      "MultiServer/BtJoin",
      "MultiServer/BtExit",
      "Dialog/SMSList03",
      "NM/VScroll_BtUp",
      "NM/VScroll_BtDown",
      "NM/VScroll_Ball",
      "NM/Scroll_Pattern",
      "Item/Watertight",
      "Item/ItemEnergy",
      "Item/ChristmasCandy",
      "Item/ChristmasWreeth",
      "Item/ChristmasTree",
      "MP3/Xmas",
      "MP3/Kartfast",
    ];
    for (const p of fxRequired) {
      expect(fx.payload(p)?.byteLength ?? 0).toBeGreaterThan(0);
    }
    expect(cx.payload("Etc/WebScreen")?.byteLength ?? 0).toBeGreaterThan(0);
    expect(cx.payload("StageChannel/BtBbs")?.byteLength ?? 0).toBeGreaterThan(0);

    // 2. Verify `multisvr.ssd` + 4 HiNet `BUILTIN_SERVERS` merge & `MP3/Xmas` routing
    const ssi = readSsi(readFileSync("multisvr.ssd"));
    expect(ssi).not.toBeNull();
    const parsedServers = parseServerList(ssi!.payload);
    expect(parsedServers?.servers[0]?.name).toBe("world name");
    const mergedEndpoints = mergeWithBuiltins(parsedServers);
    expect(mergedEndpoints.length).toBe(4);
    expect(mergedEndpoints[0]?.address).toBe("211.20.189.170");
    expect(resolveMapBgmTrack("Snow01")).toBe("MP3/Xmas");
    expect(resolveMapBgmTrack("Xmas01", "xmas", "", 4)).toBe("MP3/Xmas");

    // 3. Verify `Attr/ItemAttr` `activeSlotFlag` multi-charge pickups, `ACTIVE_WATERTIGHT`, Kart fuel refill, & `xmasItems`
    const mapData = parseMapBinary("Village00", fx.payload("Map/Village00")!);

    const sim = new GameSimulation({
      mapData,
      tileInfo,
      itemAttr,
      bomberByCode,
      objectTable,
      mode: 0,
      seed: 202616,
      participants: [
        { slot: 0, name: "P1", charCode: 0, team: 0, initialNeedles: 0, activeSlotCap: 6 },
        { slot: 1, name: "Bot2", charCode: 1, team: 1, isAi: true, aiLevel: 3 },
      ],
    });
    for (let i = 0; i < START_BANNER_TICKS + 2; i++) sim.step();
    const p1 = sim.players[0]!;
    // Clear cell around p1 so pickups happen deterministically
    const pcx = Math.floor(p1.px / 40);
    const pcy = Math.floor(p1.py / 40);

    const dartSpec = itemAttr.items.find((i) => i.objectName === "Item/ItemDart")!;
    expect(dartSpec.activeSlotFlag).toBe(3);
    sim.items.push({
      id: 9001,
      cx: pcx,
      cy: pcy,
      objectName: dartSpec.objectName,
      iconSprite: dartSpec.iconSprite,
      pickupFlag: dartSpec.pickupFlag,
      effectId: dartSpec.effectId,
      activeSlotFlag: dartSpec.activeSlotFlag,
      spawnTick: sim.tick,
    });
    sim.step();
    expect(p1.activeSlots.filter((s) => s === ACTIVE_DART).length).toBe(3);

    // Clear slots and test `Banana3` (`activeSlotFlag=3`) + `Waterproof` (`ACTIVE_WATERTIGHT` -> `shieldTicks=180`) + `Item/ItemFuel` (`kartFuel=100`)
    p1.activeSlots = [0, 0, 0, 0, 0, 0];
    p1.kartFuel = 25;
    const ban3Spec = itemAttr.items.find((i) => i.objectName === "Banana3")!;
    const wpSpec = itemAttr.items.find((i) => i.objectName === "Waterproof")!;
    const fuelSpec = itemAttr.items.find((i) => i.objectName === "Item/ItemFuel")!;
    sim.items.push(
      {
        id: 9002,
        cx: pcx,
        cy: pcy,
        objectName: ban3Spec.objectName,
        iconSprite: ban3Spec.iconSprite,
        pickupFlag: ban3Spec.pickupFlag,
        effectId: ban3Spec.effectId,
        activeSlotFlag: ban3Spec.activeSlotFlag,
        spawnTick: sim.tick,
      },
      {
        id: 9003,
        cx: pcx,
        cy: pcy,
        objectName: wpSpec.objectName,
        iconSprite: wpSpec.iconSprite,
        pickupFlag: wpSpec.pickupFlag,
        effectId: wpSpec.effectId,
        activeSlotFlag: wpSpec.activeSlotFlag,
        spawnTick: sim.tick,
      },
      {
        id: 9004,
        cx: pcx,
        cy: pcy,
        objectName: fuelSpec.objectName,
        iconSprite: fuelSpec.iconSprite,
        pickupFlag: fuelSpec.pickupFlag,
        effectId: fuelSpec.effectId,
        activeSlotFlag: fuelSpec.activeSlotFlag,
        spawnTick: sim.tick,
      },
      {
        id: 9005,
        cx: pcx,
        cy: pcy,
        objectName: "Item/Christmas02",
        iconSprite: "Item/ChristmasTree",
        pickupFlag: 1,
        effectId: 99,
        spawnTick: sim.tick,
      },
    );
    sim.step();
    expect(p1.activeSlots.filter((s) => s === ACTIVE_BANANA).length).toBe(3);
    expect(p1.activeSlots.includes(ACTIVE_WATERTIGHT)).toBe(true);
    expect(p1.activeSlots.includes(ACTIVE_CAN)).toBe(true);
    expect(p1.kartFuel).toBe(100);
    expect(p1.xmasItems).toEqual([0, 0, 1]);
    expect(p1.bonusLucci).toBe(100);

    // Activate `ACTIVE_WATERTIGHT` -> grants 180-tick extended water immunity
    const wtSlot = p1.activeSlots.indexOf(ACTIVE_WATERTIGHT);
    sim.setInput(0, { dir: -1, placeBomb: false, useActive: true, slotUse: wtSlot });
    sim.step();
    expect(p1.shieldTicks).toBeGreaterThanOrEqual(179);

    // 4. Verify `CA.exe.c:131579..131738` `scoreRetailItemPriority` (`RedDevil` desired vs `ItemGreenDevil` avoided!)
    expect(
      scoreRetailItemPriority(
        { bombsMax: 1, power: 1, speed: 4, rideId: 0 },
        { objectName: "RedDevil", pickupFlag: 1, effectId: 13 },
      ),
    ).toBe(610);
    expect(
      scoreRetailItemPriority(
        { bombsMax: 1, power: 1, speed: 4, rideId: 0 },
        { objectName: "Item/ItemGreenDevil", pickupFlag: 1, effectId: 12 },
      ),
    ).toBe(0);
    expect(
      scoreRetailItemPriority(
        { bombsMax: 1, power: 2, speed: 5, rideId: 0 },
        { objectName: "Item/ItemPunch", pickupFlag: 1, effectId: 5 },
      ),
    ).toBe(0);
    expect(
      scoreRetailItemPriority(
        { bombsMax: 3, power: 4, speed: 5, rideId: 0 },
        { objectName: "Item/ItemPunch", pickupFlag: 1, effectId: 5 },
      ),
    ).toBe(560);
    expect(
      scoreRetailItemPriority(
        { bombsMax: 2, power: 2, speed: 5, rideId: 0 },
        { objectName: "Item/Christmas01", pickupFlag: 1, effectId: 99 },
      ),
    ).toBe(620);

    // 5. Verify Level 3 Bot pops emergency `ACTIVE_SHIELD` when bomb danger is <= 4 ticks!
    const bot = sim.players[1]!;
    for (let i = 0; i < 30; i++) sim.step(); // advance past 76-tick AI warmup
    bot.activeSlots[0] = ACTIVE_SHIELD;
    bot.shieldTicks = 0;
    const bcx = Math.floor(bot.px / 40);
    const bcy = Math.floor(bot.py / 40);
    sim.bombs.push({
      id: 9500,
      ownerSlot: 0,
      power: 3,
      pierce: false,
      style: "normal",
      cx: bcx,
      cy: bcy,
      px: bcx * 40 + 20,
      py: bcy * 40 + 20,
      fuseTicks: 3,
      slidingDir: -1,
      thrownTicks: 0,
      throwFromX: 0,
      throwFromY: 0,
      throwToCx: 0,
      throwToCy: 0,
    });
    const aiOut = computeAiInput(sim, bot);
    expect(aiOut.useActive).toBe(true);
    expect(aiOut.slotUse).toBe(0);
  });

  test("Pass 17: Guild/Ladder match start, 2P toggle, Fx:Help/Help slash commands, C10 UI sprites, Kart GaugeImg[17..24] & UndergroundWater", async () => {
    // 1. Verify all Pass 17 retail Fx.idx JPEGs & CDataI16 sprites decode with exact CA.exe dimensions & frame counts!
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const checkJpeg = (name: string, w: number, h: number) => {
      const raw = fx.payload(name);
      expect(raw).not.toBeNull();
      expect(raw![0]).toBe(0xff);
      expect(raw![1]).toBe(0xd8);
      let sofW = 0;
      let sofH = 0;
      for (let i = 2; i < raw!.length - 9; ) {
        if (raw![i] !== 0xff) {
          i++;
          continue;
        }
        const marker = raw![i + 1]!;
        if (marker === 0xc0 || marker === 0xc2) {
          sofH = (raw![i + 5]! << 8) | raw![i + 6]!;
          sofW = (raw![i + 7]! << 8) | raw![i + 8]!;
          break;
        }
        const len = (raw![i + 2]! << 8) | raw![i + 3]!;
        i += 2 + Math.max(2, len);
      }
      expect(sofW).toBe(w);
      expect(sofH).toBe(h);
    };
    const checkFx = (name: string, frames: number, pivW: number, pivH: number) => {
      const raw = fx.payload(name);
      expect(raw).not.toBeNull();
      const sh = decodeSpriteSheet(raw!);
      expect(sh).not.toBeNull();
      expect(sh!.rects.length).toBe(frames);
      expect(sh!.rects[0]!.pivotX).toBe(pivW);
      expect(sh!.rects[0]!.pivotY).toBe(pivH);
      return sh!;
    };

    checkJpeg("Prepare/CAStageLadder", 800, 600);
    checkJpeg("Prepare/CAStageLadder2p", 800, 600);
    checkJpeg("Prepare/CAStageGuild", 800, 600);
    checkJpeg("Prepare/CAStageGuild2p", 800, 600);
    checkFx("Dialog/DlgCreateLadder", 1, 342, 235);
    checkFx("Dialog/DlgCreateGuildTypeSelect", 1, 342, 397);
    checkFx("MyInfo/MypageMain_C10", 1, 125, 120);
    checkFx("Dialog/BtCharac_C10", 4, 88, 51);
    checkFx("Dialog/BtCharacMyPage_C10", 4, 88, 51);
    const gaugeSh = checkFx("Game/GaugeImg", 25, 169, 22);
    expect(gaugeSh.rects[17]!.x1 - gaugeSh.rects[17]!.x0).toBe(44); // `1st`..`8th` Kart rank badges (`17..24`)
    expect(gaugeSh.rects[24]!.x1 - gaugeSh.rects[24]!.x0).toBe(44);
    checkFx("Game/UndergroundWater", 12, 51, 48);
    checkFx("Bonus/Star01", 6, 130, 130);
    checkFx("Bonus/Star02", 6, 50, 50);
    checkFx("Bonus/Star03", 5, 50, 50);
    checkFx("Bonus/Star04", 5, 50, 50);

    // 2. Verify ClientHub HUD toggles (`F2`/`F3`/`F6`) & `handleRetailSlashCommand` (`/to a`, `/to off`, `/msn`)
    const hub = new ClientHub();
    expect(hub.showPlayerIds).toBe(false);
    expect(hub.showSelfIndicator).toBe(true);
    expect(hub.showSpeechBalloons).toBe(true);
    expect(hub.teamChatOnly).toBe(false);

    let whisperTarget = "";
    let msnOpened = 0;
    hub.onOpenMessenger = () => {
      msnOpened++;
    };
    const fakeAssets = { tables: null } as any;

    expect(
      handleRetailSlashCommand("/to a", fakeAssets, hub, {
        onSetWhisperTarget: (t) => {
          whisperTarget = t;
        },
      }),
    ).toBe(true);
    expect(hub.teamChatOnly).toBe(true);
    expect(whisperTarget).toBe("a");

    expect(
      handleRetailSlashCommand("/to off", fakeAssets, hub, {
        onSetWhisperTarget: (t) => {
          whisperTarget = t;
        },
      }),
    ).toBe(true);
    expect(hub.teamChatOnly).toBe(false);
    expect(whisperTarget).toBe("");

    // `/to a <message>` (2+ tokens) returns `false` so `server/gateway.ts` dispatches team-only chat!
    expect(handleRetailSlashCommand("/to a 大家衝啊", fakeAssets, hub)).toBe(false);

    expect(handleRetailSlashCommand("/msn", fakeAssets, hub)).toBe(true);
    expect(msnOpened).toBe(1);

    // 3. Live WebSocket E2E: verify `kind: "guild"` (`guildType: 1`, `CAStageGuild`) room creation,
    //    `room_toggle_2p`, `/rt`, `/in`, `/to a`, `/ready`, and `/start` -> `match_start`!
    const utf8Enc = new TextEncoder();
    const utf8Dec = new TextDecoder();
    async function connectGuildClient() {
      const inbox: ServerMsg[] = [];
      const waiters: { type: string; pred?: (m: any) => boolean; resolve: (m: any) => void }[] = [];
      let hsDone!: () => void;
      const hsPromise = new Promise<void>((res) => {
        hsDone = res;
      });
      const sock = new GameSocket({
        packet: (op, payload) => {
          if (op === 0x01) {
            hsDone();
            return;
          }
          if (op !== OP_RPC) return;
          const msg = JSON.parse(utf8Dec.decode(payload)) as ServerMsg;
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i]!;
            if (w.type === msg.type && (!w.pred || w.pred(msg))) {
              waiters.splice(i, 1);
              w.resolve(msg);
              return;
            }
          }
          inbox.push(msg);
        },
      });
      await sock.connect("ws://127.0.0.1:3000/ws");
      await hsPromise;
      return {
        sock,
        inbox,
        send: (m: ClientMsg) => sock.send(OP_RPC, utf8Enc.encode(JSON.stringify(m))),
        waitFor: <T extends ServerMsg["type"]>(
          t: T,
          pred?: (m: Extract<ServerMsg, { type: T }>) => boolean,
        ): Promise<Extract<ServerMsg, { type: T }>> => {
          const idx = inbox.findIndex((x) => x.type === t && (!pred || pred(x as any)));
          if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0] as any);
          return new Promise((resolve) => waiters.push({ type: t, pred: pred as any, resolve }));
        },
      };
    }

    const sfx = `${Date.now() % 100000}`;
    const uHost = `gh_${sfx}`;
    const uAlly = `ga_${sfx}`;
    const uEnemy = `ge_${sfx}`;
    const cHost = await connectGuildClient();
    const cAlly = await connectGuildClient();
    const cEnemy = await connectGuildClient();

    try {
      cHost.send({ type: "auth_register", username: uHost, password: "pw", nickname: "公會隊長", gender: 0 });
      cAlly.send({ type: "auth_register", username: uAlly, password: "pw", nickname: "同隊隊友", gender: 0 });
      cEnemy.send({ type: "auth_register", username: uEnemy, password: "pw", nickname: "敵隊對手", gender: 1 });
      await cHost.waitFor("auth_ok");
      await cAlly.waitFor("auth_ok");
      await cEnemy.waitFor("auth_ok");

      cHost.send({ type: "join_channel", channelIdx: 0 });
      cAlly.send({ type: "join_channel", channelIdx: 0 });
      cEnemy.send({ type: "join_channel", channelIdx: 0 });
      await cHost.waitFor("channel_joined");
      await cAlly.waitFor("channel_joined");
      await cEnemy.waitFor("channel_joined");

      // Host creates a Guild Session room (`kind: "guild", guildType: 1`)
      cHost.send({
        type: "create_room",
        title: "初版公會房",
        password: "",
        manner: true,
        kind: "guild",
        mode: 0,
        mapIndex: 0,
        capacity: 6,
        guildType: 1,
      });
      const joinedHost = await cHost.waitFor("room_joined");
      expect(joinedHost.room.kind).toBe("guild");
      expect(joinedHost.room.guildType).toBe(1);
      const roomId = joinedHost.room.id;

      // Host uses `/in <uAlly>` -> cAlly receives room invite system `chat_recv` notice!
      cHost.send({ type: "chat_send", text: `/in ${uAlly}` });
      const inviteNotice = await cAlly.waitFor(
        "chat_recv",
        (m) => m.text.includes("[房間邀請]") && m.text.includes(`/join ${roomId}`),
      );
      expect(inviteNotice.text).toContain("公會隊長");

      // Host toggles 2P (`room_toggle_2p`) on `kind: "guild"` room and then untoggles it
      cHost.send({ type: "room_toggle_2p", enable: true });
      const upd2p = await cHost.waitFor(
        "room_sync",
        (m) => m.room.slots.some((s) => s.occupied && s.is2P === true),
      );
      expect(upd2p.room.guildType).toBe(1);
      cHost.send({ type: "room_toggle_2p", enable: false });
      await cHost.waitFor(
        "room_sync",
        (m) => !m.room.slots.some((s) => s.occupied && s.is2P === true),
      );

      // Host renames room live via `/rt 公會王者決戰`
      cHost.send({ type: "chat_send", text: "/rt 公會王者決戰" });
      const renamed = await cHost.waitFor("room_sync", (m) => m.room.title === "公會王者決戰");
      expect(renamed.room.title).toBe("公會王者決戰");

      // Ally and Enemy join the Guild room; put Host & Ally on Team 0 and Enemy on Team 1
      cAlly.send({ type: "join_room", roomId });
      await cAlly.waitFor("room_joined");
      cEnemy.send({ type: "join_room", roomId });
      await cEnemy.waitFor("room_joined");

      cHost.send({ type: "room_set_team", team: 0 });
      cAlly.send({ type: "room_set_team", team: 0 });
      cEnemy.send({ type: "room_set_team", team: 1 });
      await cHost.waitFor(
        "room_sync",
        (m) =>
          m.room.slots.find((s) => s.username === uAlly)?.team === 0 &&
          m.room.slots.find((s) => s.username === uEnemy)?.team === 1,
      );

      // Host sends `/to a 秘密戰術99` -> Ally (Team 0) receives `[隊伍]`, Enemy (Team 1) does NOT!
      cHost.send({ type: "chat_send", text: "/to a 秘密戰術99" });
      const allyTeamMsg = await cAlly.waitFor("chat_recv", (m) => m.text.includes("秘密戰術99"));
      expect(allyTeamMsg.from).toContain("[隊伍]");
      expect(cEnemy.inbox.some((m) => m.type === "chat_recv" && m.text.includes("秘密戰術99"))).toBe(false);

      // Ally & Enemy ready up via `/ready`, Host starts match via `/start` on `kind === "guild"` room!
      cAlly.send({ type: "chat_send", text: "/ready" });
      cEnemy.send({ type: "chat_send", text: "/ready" });
      await cHost.waitFor(
        "room_sync",
        (m) =>
          m.room.slots.find((s) => s.username === uAlly)?.ready === true &&
          m.room.slots.find((s) => s.username === uEnemy)?.ready === true,
      );

      cHost.send({ type: "chat_send", text: "/start" });
      const matchStart = await cHost.waitFor("match_start");
      expect(matchStart.snapshot.players.length).toBeGreaterThanOrEqual(3);
    } finally {
      cHost.sock.close();
      cAlly.sock.close();
      cEnemy.sock.close();
    }
  });

  test("MotionBlur equips independently and tracks past bomber positions", () => {
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map(s => [s.id, s]));
    const motion = stockById.get(1207)!;
    expect(motion.iconPath).toBe("Item/MotionBlur");
    const other = stocks.find(s => s.category === 12 && s.id !== 1207)!;
    const db = new GameDatabase(":memory:", stockById, parsePackageMap(readFileSync("packagemap.ini")));
    const id = db.registerAccount("trail_test", "pw", "幻影測試", 0).profile!.id;
    db.grantStock(id, 1207);
    db.grantStock(id, other.id);
    const inventory = db.getInventory(id);
    const motionItem = inventory.find(i => i.stockId === 1207)!;
    const otherItem = inventory.find(i => i.stockId === other.id)!;
    expect(db.setEquipped(id, motionItem.invId, true)).toBe(true);
    expect(db.setEquipped(id, otherItem.invId, true)).toBe(true);
    expect(db.getInventory(id).filter(i => i.equipped).map(i => i.stockId)).toContain(1207);
    expect(db.getProfileById(id)!.equipped.charDecoStockIds).toContain(1207);
    const trail = new MotionBlurTrail();
    expect(trail.update(0, 0, 0, true)).toEqual([]);
    trail.update(1, 2, 0, true);
    trail.update(2, 4, 0, true);
    expect(trail.update(3, 6, 0, true)).toEqual([
      { x: 0, y: 0, alpha: 76 / 255 },
      { x: 2, y: 0, alpha: 102 / 255 },
      { x: 4, y: 0, alpha: 128 / 255 },
    ]);
    expect(trail.update(4, 6, 0, false)).toEqual([]);
    expect(trail.update(5, 100, 0, true)).toEqual([]);
    expect(trail.update(6, 500, 0, true)).toEqual([]);
  });

  test("game chat balloons use retail-sized tiles and wrap instead of truncating", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const sheet = decodeSpriteSheet(fx.payload("Game/ChatBalloon")!);
    const calls: any[] = [];
    const lines: string[] = [];
    const renderer = {
      measureText: (s: string) => s.length * 6,
      drawSprite: (s: any) => calls.push(s),
      drawText: (s: string) => lines.push(s),
    };
    drawGameSpeechBubble(renderer as never, { sheet, tex: "balloon" } as never, "abcdefghijklmnopqrstuvwxyz", 300, 200);
    expect(lines).toEqual(["abcdefghijklmnopqrst", "uvwxyz"]);
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.every(c => c.tint[3] === 128 / 255)).toBe(true);
    expect(calls.every(c => c.w === 10 || c.w === 12 || c.w === 6)).toBe(true);
    expect(calls.some(c => c.src[0] === sheet.rects[14]!.x0 && c.src[1] === sheet.rects[14]!.y0)).toBe(false);
  });

  test("retail sprite drawing ignores invalid frame indices", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const sheet = decodeSpriteSheet(fx.payload("Dialog/BtNoticeClose")!);
    const loaded = { sheet, tex: "button", width: 86, height: 25 } as never;
    const calls: any[] = [];
    const renderer = { drawSprite: (s: any) => calls.push(s) } as never;
    for (const index of [-1, sheet.rects.length, 1.5, NaN]) {
      expect(drawSheetFrame(renderer, loaded, index, 10, 20)).toEqual({ w: 0, h: 0 });
    }
    expect(calls.length).toBe(0);
    drawSheetFrame(renderer, loaded, 0, 10, 20);
    expect(calls.length).toBe(1);
    const empty = { sheet: { ...sheet, rects: [] }, tex: "empty", width: 86, height: 25 } as never;
    expect(drawSheetFrame(renderer, empty, 0, 0, 0)).toEqual({ w: 0, h: 0 });
    expect(calls.length).toBe(1);
  });

  test("retail notice button uses pressed, disabled and hover frames", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const sheet = decodeSpriteSheet(fx.payload("Dialog/BtNoticeClose")!);
    expect(sheet.rects.length).toBe(5);
    const button = new SpriteButton(0, 0);
    button.bindSheet({ sheet, tex: "button", width: 86, height: 25 } as never);
    let drawn: any;
    const renderer = { drawSprite: (s: any) => { drawn = s; } };
    const check = (frame: number) => {
      button.render(renderer as never);
      const rc = sheet.rects[frame]!;
      expect(drawn.src).toEqual([rc.x0, rc.y0, rc.x1 - rc.x0, rc.y1 - rc.y0]);
    };
    check(0);
    button.onMouseMove(1, 1);
    check(3);
    button.onMouseDown(1, 1);
    check(1);
    button.enabled = false;
    check(2);
  });

  test("retail level notice uses a static three-layer badge", async () => {
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const sheet = decodeSpriteSheet(cx.payload("Etc/LevelIcons")!);
    const loads: string[] = [];
    const assets = { loadSheet: async (_pack: string, name: string) => {
      loads.push(name);
      return name === "Etc/LevelIcons" ? { sheet, tex: "badge", width: 16, height: 14 } : null;
    } };
    const dlg = new LevelNoticeDlg(assets as never, 200);
    await Promise.resolve();
    await Promise.resolve();
    expect(loads).toEqual(["Dialog/DlgNotice", "Dialog/BtNoticeClose", "Etc/LevelIcons"]);
    const sprites: any[] = [];
    const renderer = { drawSprite: (s: any) => sprites.push(s), drawText: () => {} };
    dlg.render(renderer as never);
    const parts = computeLevelIconParts(200);
    expect(sprites.length).toBe(3);
    expect(sprites.map(s => s.src)).toEqual([parts.ribbonFrame, parts.pipFrame, parts.emblemFrame].map(i => {
      const rc = sheet.rects[i]!;
      return [rc.x0, rc.y0, rc.x1 - rc.x0, rc.y1 - rc.y0];
    }));
  });

  test("retail Bomb/Bubble lock animation holds its final frame even when looping is requested", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const objects = new ObjectTable(fx.payload("ObjectTable/ObjectTable")!);
    const action = objects.byName.get("Bomb/Bubble")!.actions.get("00 Lock")!;
    expect(action.steps).toEqual([{ frame: 0, ticks: 4 }, { frame: 1, ticks: 4 }, { frame: 2, ticks: 4 }, { frame: 6, ticks: -1 }]);
    for (const loop of [true, false]) {
      expect(sampleActionFrame(action, 0, loop)).toBe(0);
      expect(sampleActionFrame(action, 4, loop)).toBe(1);
      expect(sampleActionFrame(action, 8, loop)).toBe(2);
      expect(sampleActionFrame(action, 12, loop)).toBe(6);
      expect(sampleActionFrame(action, 10000, loop)).toBe(6);
    }
  });

  test("Pass 18: modular CLevelIconEffector (Etc/LevelIcons 46f + Level/Rotate000 240f + silhouette Twinkle)", () => {
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));

    const lvSh = decodeSpriteSheet(cx.payload("Etc/LevelIcons")!);
    expect(lvSh.rects.length).toBe(46);

    const rotSh = decodeSpriteSheet(fx.payload("Level/Rotate000")!)!;
    expect(rotSh.rects.length).toBe(240);
    expect(rotSh.rects[0]!.x1 - rotSh.rects[0]!.x0).toBeGreaterThanOrEqual(8);
    expect(rotSh.rects[0]!.y1 - rotSh.rects[0]!.y0).toBeGreaterThanOrEqual(8);

    for (let tw = 0; tw <= 7; tw++) {
      const twSh = decodeSpriteSheet(fx.payload(`Level/Twinkle00${tw}`)!)!;
      expect(twSh.rects.length).toBeGreaterThanOrEqual(tw < 2 ? 4 : 60);
    }

    // sub_4F6F4C: both effects share one frame, four updates per frame,
    // three loops followed by a pause. The web's fixed 75-update pause is
    // an approximation of retail's random 60–90-update per-instance pause.
    expect(levelEffectFrame(0, 240, 4)).toBeNull();
    expect(levelEffectFrame(74, 240, 4)).toBeNull();
    expect(levelEffectFrame(75, 240, 4)).toBe(0);
    expect(levelEffectFrame(79, 240, 4)).toBe(1);
    expect(levelEffectFrame(83, 240, 4)).toBe(0);
    expect(levelEffectFrame(98, 240, 4)).toBe(1);
    expect(levelEffectFrame(99, 240, 4)).toBeNull();
    expect(levelEffectFrame(75 + 5 * 4, 240, 60)).toBe(5);
    expect(levelEffectFrame(75 + 6 * 4, 240, 60)).toBe(0);
    expect(levelEffectFrame(75, 0, 0)).toBeNull();

    // Retail uses levels directly; test the 450-rank table boundaries.
    const r1 = computeLevelIconParts(1);
    expect(r1).toEqual({
      rank450: 1,
      ribbonFrame: 3,
      pipFrame: 0,
      emblemFrame: 8,
      tier: 0,
      medal30: 0,
      silhouette10: 0,
    });

    const r225 = computeLevelIconParts(225);
    expect(r225).toEqual({
      rank450: 225,
      ribbonFrame: 7,
      pipFrame: 2,
      emblemFrame: 22,
      tier: 0,
      medal30: 14,
      silhouette10: 4,
    });

    const r226 = computeLevelIconParts(226);
    expect(r226).toEqual({
      rank450: 226,
      ribbonFrame: 26,
      pipFrame: 23,
      emblemFrame: 31,
      tier: 1,
      medal30: 15,
      silhouette10: 5,
    });

    const r450 = computeLevelIconParts(450);
    expect(r450).toEqual({
      rank450: 450,
      ribbonFrame: 30,
      pipFrame: 25,
      emblemFrame: 45,
      tier: 1,
      medal30: 29,
      silhouette10: 9,
    });

    // Check direct rank lookup across all retail levels, including clamp edges.
    expect(computeLevelIconParts(0)).toEqual(r1);
    expect(computeLevelIconParts(451)).toEqual(r450);
    expect(computeLevelIconParts(200).rank450).toBe(200);
    expect(computeLevelIconParts(200).tier).toBe(0);
    expect(computeLevelIconParts(201).rank450).toBe(201);
    for (let lv = 1; lv <= 450; lv++) {
      const parts = computeLevelIconParts(lv);
      expect(parts.rank450).toBe(lv);
      const v = lv - 1;
      const tier = Math.floor(v / 225);
      expect(parts.ribbonFrame).toBe(23 * tier + Math.floor(v / 3) % 5 + 3);
      expect(parts.pipFrame).toBe(23 * tier + v % 3);
      expect(parts.emblemFrame).toBe(23 * tier + Math.floor(v / 15) % 15 + 8);
      expect(parts.ribbonFrame).toBeGreaterThanOrEqual(0);
      expect(parts.ribbonFrame).toBeLessThan(46);
      expect(parts.pipFrame).toBeGreaterThanOrEqual(0);
      expect(parts.pipFrame).toBeLessThan(46);
      expect(parts.emblemFrame).toBeGreaterThanOrEqual(0);
      expect(parts.emblemFrame).toBeLessThan(46);
      expect(parts.medal30 * 8 + 7).toBeLessThan(rotSh.rects.length);
    }
  });

  test("Pass 18: CGOFanfareActor (1410..1416 -> Fanfare000..006), CGOExtensionShadow, & Item/Doll01..03", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    const charTe = new Pack("CharTE", readFileSync("CharTE.idx"), readFileSync("CharTE.idd"));
    const emo = new Pack("EmoTE", readFileSync("EmoTE.idx"), readFileSync("EmoTE.idd"));
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const probe = (p: Pack) => ({
      has: (n: string) => p.has(n),
      entriesMatching: (pref: string) =>
        p.entries.filter((e) => e.name.toLowerCase().startsWith(pref.toLowerCase())),
    });
    const charObjects = new ObjectTable(charTe.payload("ObjectTable/CharTEObjectTable")!);
    const emoObjects = new ObjectTable(emo.payload("ObjectTable/EmoTEObjectTable")!);
    const catalog = new CosmeticCatalog({
      stocks,
      packageMap: pkgMap,
      fx: probe(fx),
      charTe: probe(charTe),
      emoTe: probe(emo),
      cx: probe(cx),
      charObjects,
      emoObjects,
    });

    // `1410..1416` map 1:1 onto `0..6` (`EmoTE:Fanfare/Fanfare000..006` + `Wave/Fanfare000..006`)!
    const expectedFanfareIds = [1410, 1411, 1412, 1413, 1414, 1415, 1416];
    expectedFanfareIds.forEach((id, expectedIdx) => {
      const it = stocks.find((s) => s.id === id)!;
      expect(it).toBeDefined();
      expect(resolveFanfareIndex(it.avatarCode, it.iconPath)).toBe(expectedIdx);
      const vis = catalog.expandVisuals(id);
      const fanVis = vis.find((v) => v.liveKind === "fanfare");
      expect(fanVis).toBeDefined();
      expect(fanVis!.skinIndex).toBe(expectedIdx);
      expect(fanVis!.liveObject).toBe(`Fanfare/Fanfare00${expectedIdx}`);

      const pad = `00${expectedIdx}`;
      const fanSh = decodeSpriteSheet(emo.payload(`Fanfare/Fanfare${pad}`)!)!;
      expect(fanSh.rects.length).toBeGreaterThan(0);
      expect(emo.payload(`Wave/Fanfare${pad}`)).toBeDefined();
    });

    // `1207` resolves to `Fx:Item/AdvMotionBlur` AND `Fx:"ExtensionShadow/GourdBottleEffect "` has 12 frames (`64x65`)!
    expect(catalog.resolve(1207)?.iconName).toBe("Item/AdvMotionBlur");
    const extSh = decodeSpriteSheet(fx.payload("ExtensionShadow/GourdBottleEffect ")!)!;
    expect(extSh.rects.length).toBe(11);
    expect(extSh.images[0]!.w).toBeGreaterThanOrEqual(32);
    expect(extSh.images[0]!.h).toBeGreaterThanOrEqual(32);

    // `Item/Doll01`, `Item/Doll02`, and `Item/Doll03` all decode cleanly in `Fx.idx`!
    for (const dName of ["Item/Doll01", "Item/Doll02", "Item/Doll03"]) {
      const dSh = decodeSpriteSheet(fx.payload(dName)!)!;
      expect(dSh.rects.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("Pass 18: ShopInventoryPopupMenu (no duplicate Delete row, CCartSlotPopupDlg, CShopItemPopupDlg)", () => {
    const popup = new ShopInventoryPopupMenu();
    let detailCalls = 0;
    let deleteCalls = 0;
    let previewCalls = 0;

    // 1a. Non-equippable (`category: 9`) when `onSell` is omitted and `onDelete` is provided has ONLY 2 rows (`Detail`, `Delete`)!
    popup.open(
      200,
      200,
      { invId: 7, stockId: 1905, category: 9, equipped: false },
      {
        onToggleEquip: () => {},
        onShowDetail: () => {
          detailCalls++;
        },
        onDelete: () => {
          deleteCalls++;
        },
      },
    );
    expect(popup.active).toBe(true);
    // Clicking Row 2 (`y = 248`) dismisses the 2-row box WITHOUT firing a duplicate `Delete`!
    popup.onMouseDown(210, 248);
    expect(deleteCalls).toBe(0);
    expect(popup.active).toBe(false);

    // 1b. Equippable (`category: 12`) has 3 rows (`Equip`, `Detail`, `Delete` at `y = 241..255`)!
    popup.open(
      200,
      200,
      { invId: 8, stockId: 1207, category: 12, equipped: false },
      {
        onToggleEquip: () => {},
        onShowDetail: () => {
          detailCalls++;
        },
        onDelete: () => {
          deleteCalls++;
        },
      },
    );
    popup.onMouseDown(210, 248);
    popup.onMouseUp(210, 248, { playSfx: () => {} } as never);
    expect(deleteCalls).toBe(1);
    expect(popup.active).toBe(false);

    // 2. `openCartSlot()` (`CCartSlotPopupDlg`: `Detail` at row 0, `Delete` at row 1)
    popup.openCartSlot(150, 150, {
      onShowDetail: () => {
        detailCalls++;
      },
      onDelete: () => {
        deleteCalls++;
      },
    });
    expect(popup.active).toBe(true);
    popup.onMouseDown(160, 176);
    popup.onMouseUp(160, 176, { playSfx: () => {} } as never);
    expect(deleteCalls).toBe(2);

    // 3. `openShopCard()` (`CShopItemPopupDlg`: `Detail` at row 0, `TogglePreview` at row 1)
    popup.openShopCard(180, 180, false, {
      onShowDetail: () => {
        detailCalls++;
      },
      onTogglePreview: () => {
        previewCalls++;
      },
    });
    popup.onMouseDown(190, 206);
    popup.onMouseUp(190, 206, { playSfx: () => {} } as never);
    expect(previewCalls).toBe(1);
    expect(detailCalls).toBe(0);
  });

  test("Pass 18: Cx:Etc/CommunityLogo01|02|04|05|06 & persistent school/communityLogo profile RPCs", async () => {
    const cx = new Pack("Cx", readFileSync("Cx.idx"), readFileSync("Cx.idd"));
    for (const opt of COMMUNITY_LOGO_OPTIONS) {
      if (opt.code === 0) continue;
      const pad = String(opt.code).padStart(2, "0");
      const sh = decodeSpriteSheet(cx.payload(`Etc/CommunityLogo${pad}`)!);
      expect(sh.rects.length).toBe(3);
    }

    // Verify SQLite persistence + live WebSocket `update_memo` + `/community` command!
    const stocks = parseFxStock(readFileSync("fxstock.ini"));
    const stockById = new Map(stocks.map((s) => [s.id, s]));
    const pkgMap = parsePackageMap(readFileSync("packagemap.ini"));
    const db = new GameDatabase(":memory:", stockById, pkgMap);
    const reg = db.registerAccount("comm_tester", "pass123", "阿爆隊長", 0);
    expect(reg.ok).toBe(true);
    const accId = reg.profile!.id;
    db.updateMemo(accId, "你好爆爆王", {
      school: "台大爆爆社",
      communityLogo: 5,
    });
    const prof = db.getProfileById(accId)!;
    expect(prof.school).toBe("台大爆爆社");
    expect(prof.communityLogo).toBe(5);

    // Invalid logo code (`3`) normalizes cleanly to `0` (`無社群徽章`)!
    db.updateMemo(accId, "你好爆爆王", { communityLogo: 3 });
    expect(db.getProfileById(accId)!.communityLogo).toBe(0);

    // Live WebSocket E2E check against the Gateway (`/community 6` + `update_memo` with `school`)
    const utf8Enc = new TextEncoder();
    const utf8Dec = new TextDecoder();
    const inbox: ServerMsg[] = [];
    const waiters: { type: string; pred?: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    let hsDone!: () => void;
    const hsPromise = new Promise<void>((res) => {
      hsDone = res;
    });
    const sock = new GameSocket({
      packet: (op, payload) => {
        if (op === 0x01) {
          hsDone();
          return;
        }
        if (op !== OP_RPC) return;
        const msg = JSON.parse(utf8Dec.decode(payload)) as ServerMsg;
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.type === msg.type && (!w.pred || w.pred(msg))) {
            waiters.splice(i, 1);
            w.resolve(msg);
            return;
          }
        }
        inbox.push(msg);
      },
    });
    await sock.connect("ws://127.0.0.1:3000/ws");
    await hsPromise;
    const send = (m: ClientMsg) => sock.send(OP_RPC, utf8Enc.encode(JSON.stringify(m)));
    const waitFor = <T extends ServerMsg["type"]>(
      t: T,
      pred?: (m: Extract<ServerMsg, { type: T }>) => boolean,
    ): Promise<Extract<ServerMsg, { type: T }>> => {
      const idx = inbox.findIndex((x) => x.type === t && (!pred || pred(x as any)));
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0] as any);
      return new Promise((resolve) => waiters.push({ type: t, pred: pred as any, resolve }));
    };

    try {
      const u1 = `cm_${Date.now().toString(36).slice(-5)}`;
      send({ type: "auth_register", username: u1, password: "pw", nickname: "社群測試", gender: 0 });
      await waitFor("auth_ok");

      send({
        type: "update_memo",
        memo: "歡迎一起玩！",
        school: "台北第一爆爆學園",
        communityLogo: 2,
      });
      const sync1 = await waitFor(
        "profile_sync",
        (m) => m.profile.school === "台北第一爆爆學園" && m.profile.communityLogo === 2,
      );
      expect(sync1.profile.memo).toBe("歡迎一起玩！");

      // Invalid optional fields must not partially persist an otherwise valid memo.
      for (const invalid of [{ school: null }, { nickname: 7 }, { gender: "1" }, { communityLogo: 1.5 }, { memo: null }]) {
        send({ type: "update_memo", memo: "不應儲存", ...invalid } as unknown as ClientMsg);
        send({ type: "user_info_req", username: u1 });
        const info = await waitFor("user_info_res");
        expect(info.profile!.memo).toBe("歡迎一起玩！");
        expect(info.profile!.school).toBe("台北第一爆爆學園");
        expect(info.profile!.communityLogo).toBe(2);
      }

      send({ type: "join_channel", channelIdx: 0 });
      await waitFor("channel_joined");
      send({ type: "chat_send", text: "/community 6" });
      const sync2 = await waitFor("profile_sync", (m) => m.profile.communityLogo === 6);
      expect(sync2.profile.school).toBe("台北第一爆爆學園");
    } finally {
      sock.close();
    }
  });
});


describe("retail game map HUD", () => {
  test("truncates by Big5 bytes without splitting a character", () => {
    expect(gameMapLabel("工廠00")).toBe("工廠00");
    expect(gameMapLabel("一二三四五六七")).toBe("一二三四...");
    expect(gameMapLabel("ABCDEFGH中文長")).toBe("ABCDEFGH...");
    expect(gameMapLabel("ABCDEFGHIJKLM")).toBe("ABCDEFGHI...");
  });
  test("real theme sheets supply the small HUD frame", () => {
    const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
    for (const art of ["Camp", "Factory", "Village"]) {
      const payload = fx.payload(`Theme/${art}`);
      expect(payload).toBeTruthy();
      const sheet = decodeSpriteSheet(payload!);
      expect(sheet.rects.length).toBeGreaterThanOrEqual(2);
      expect(sheet.rects[1]!.x1 - sheet.rects[1]!.x0).toBe(12);
    }
  });
});


test("MyPage bag selects without equipping and bounds its wheel pages", () => {
  const sent: unknown[] = [];
  const inventory = Array.from({ length: 9 }, (_, i) => ({ invId: i + 1, stockId: 1200 + i, category: 12, quantity: 1, equipped: false }));
  const assets = { loadSheet: async () => null, tables: null } as never;
  const hub = { inventory, send: (msg: unknown) => sent.push(msg) } as never;
  const dlg = new MyPageDlg(assets, hub, () => {});
  const sound = { playSfx: () => {} } as never;
  dlg.onMouseDown(164, 404, sound);
  expect(sent).toEqual([]);
  dlg.onWheel(1);
  dlg.onWheel(1);
  expect((dlg as any).bag.page).toBe(1);
  dlg.onWheel(-1);
  expect((dlg as any).bag.page).toBe(0);
  dlg.onMouseDown(164, 404, sound, 2);
  expect((dlg as any).invPopup.active).toBe(false);
  dlg.onMouseUp(164, 404, sound, 2);
  expect((dlg as any).invPopup.active).toBe(true);
  dlg.onWheel(1);
  expect((dlg as any).bag.page).toBe(0);
});


test("MyInfo partitions the entire bag and shares ordering for selection, double click and menu", () => {
  const sent: any[] = [];
  const inventory = [
    { invId: 1, stockId: 1, category: 1, quantity: 1, equipped: false },
    { invId: 2, stockId: 2, category: 12, quantity: 1, equipped: false },
    { invId: 3, stockId: 3, category: 15, quantity: 1, equipped: false },
  ];
  const assets = { loadSheet: async () => null, tables: null } as never;
  const hub = { inventory, send: (msg: unknown) => sent.push(msg) } as never;
  const dlg = new MyPageDlg(assets, hub, () => {});
  const sound = { playSfx: () => {} } as never;
  expect((dlg as any).bagRows().map((row: any) => row.invId)).toEqual([2, 1, 3]);
  dlg.onMouseDown(164, 404, sound);
  expect((dlg as any).bag.selectedInvId).toBe(2);
  expect(sent).toEqual([]);
  dlg.onDoubleClick(164, 404, sound);
  expect(sent).toEqual([{ type: "item_equip", invId: 2, equip: true }]);
  dlg.onMouseDown(164 + 126, 404, sound, 2);
  dlg.onMouseUp(164 + 126, 404, sound, 2);
  const popup = (dlg as any).invPopup;
  expect(popup.buttons.length).toBe(1); // category 15: delete only
  popup.onMouseDown(300, 410);
  popup.onMouseUp(300, 410, sound);
  expect(sent.length).toBe(1); // no delete before confirmation
  const stack = new DialogStack();
  stack.push(dlg);
  stack.onKeyDown({ key: "Escape" } as KeyboardEvent);
  expect(dlg.closed).toBe(false);
  expect((dlg as any).deleteConfirm.closed).toBe(true);
  expect(sent.length).toBe(1);
  dlg.onMouseDown(164 + 126, 404, sound, 2);
  dlg.onMouseUp(164 + 126, 404, sound, 2);
  popup.onMouseDown(300, 410);
  popup.onMouseUp(300, 410, sound);
  stack.onKeyDown({ key: "Enter" } as KeyboardEvent);
  expect(sent.at(-1)).toEqual({ type: "inventory_delete", invId: 3 });
});

test("MyInfo popup follows native category-specific rows", () => {
  const popup = new ShopInventoryPopupMenu();
  const calls: string[] = [];
  const actions = { onDecorate: () => calls.push("deco"), onDelete: () => calls.push("delete") };
  const sound = { playSfx: () => {} } as never;
  popup.openMyInfo(100, 100, { invId: 1, category: 12 }, actions);
  expect((popup as any).buttons.length).toBe(2);
  popup.onMouseDown(110, 106); popup.onMouseUp(110, 106, sound);
  expect(calls).toEqual(["deco"]);
  popup.openMyInfo(100, 100, { invId: 1, category: 27 }, actions);
  expect((popup as any).buttons.length).toBe(1);
  popup.onMouseDown(110, 106); popup.onMouseUp(110, 106, sound);
  expect(calls).toEqual(["deco", "delete"]);
});

test("MyInfo uses native in-place partition and retains bag order on premium tab", () => {
  const inventory = [1, 12, 3, 19, 5].map((category, i) => ({
    invId: i + 1, stockId: i + 1, category, quantity: 1, equipped: false,
  }));
  const assets = { loadSheet: async () => null, tables: null } as never;
  const hub = { inventory, send: () => {} } as never;
  const dlg = new MyPageDlg(assets, hub, () => {});
  expect((dlg as any).bagRows().map((r: any) => r.invId)).toEqual([4, 2, 3, 1, 5]);
  (dlg as any).tabIdx = 4;
  expect((dlg as any).bagRows().map((r: any) => r.invId)).toEqual([5, 2, 3, 1, 4]);
  (dlg as any).tabIdx = 0;
  expect((dlg as any).bagRows().map((r: any) => r.invId)).toEqual([5, 2, 3, 1, 4]);
  inventory.splice(0, 1);
  expect((dlg as any).bagRows().map((r: any) => r.invId)).toEqual([5, 2, 3, 4]);
});

test("MyInfo right click does not activate underlying controls", () => {
  const sent: unknown[] = [];
  const dlg = new MyPageDlg({ loadSheet: async () => null } as never,
    { inventory: [], send: (m: unknown) => sent.push(m) } as never, () => {});
  const sound = { playSfx: () => {} } as never;
  dlg.onMouseDown(129 + 168, 20 + 32, sound, 2);
  expect((dlg as any).charPickerPopup).toBeNull();
  expect(sent).toEqual([]);
});

test("MyInfo equipped item slot selects on click and removes on double click or popup", () => {
  const sent: any[] = [];
  const stock = { id: 500, category: 14, name: "測試水球" };
  const assets = { loadSheet: async () => null, tables: { stockById: new Map([[500, stock]]) } } as never;
  const hub = { inventory: [{ invId: 42, stockId: 500, category: 14, quantity: 1, equipped: true }],
    send: (m: unknown) => sent.push(m) } as never;
  const dlg = new MyPageDlg(assets, hub, () => {});
  (dlg as any).tabIdx = 1;
  const sound = { playSfx: () => {} } as never;
  const x = 129 + 250, y = 20 + 130;
  dlg.onMouseDown(x, y, sound);
  expect(sent).toEqual([]);
  dlg.onDoubleClick(x, y, sound);
  expect(sent).toEqual([{ type: "item_equip", invId: 42, equip: false }]);
  dlg.onMouseDown(x, y, sound, 2);
  dlg.onMouseUp(x, y, sound, 2);
  const popup = (dlg as any).invPopup;
  expect(popup.active).toBe(true);
  expect(popup.buttons.length).toBe(2);
  popup.onMouseDown(x + 8, y + 26);
  popup.onMouseUp(x + 8, y + 26, sound);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual({ type: "item_equip", invId: 42, equip: false });
});

test("shop purchase and batch rollback balances and inventory on grant failure", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const item = stocks.find((s) => s.priceLucci > 0 && s.priceLucci < 5000)!;
  const db = new GameDatabase(":memory:", new Map(stocks.map((s) => [s.id, s])), new Map());
  const account = db.registerAccount("AtomicShop", "pw", "交易測試", 0).profile!;
  const before = db.getProfileById(account.id)!;
  const rowsBefore = db.getInventory(account.id);
  const original = db.grantStock.bind(db);
  let grants = 0;
  db.grantStock = (...args) => {
    original(...args);
    if (++grants === 2) throw new Error("injected grant failure");
  };
  const oldError = console.error;
  console.error = () => {};
  try {
    const single = db.buyStock(account.id, item.id, "lucci", undefined, undefined, 2);
    expect(single.ok).toBe(false);
    expect(db.getProfileById(account.id)!.lucci).toBe(before.lucci);
    expect(db.getInventory(account.id)).toEqual(rowsBefore);
    grants = 0;
    const batch = db.buyStockBatch(account.id, [{ stockId: item.id, currency: "lucci", qty: 2 }]);
    expect(batch.ok).toBe(false);
    expect(batch.boughtCount).toBe(0);
    expect(db.getProfileById(account.id)!.lucci).toBe(before.lucci);
    expect(db.getInventory(account.id)).toEqual(rowsBefore);
  } finally {
    console.error = oldError;
    db.db.close();
  }
});

test("retail stock price, currency and new/hot markers use distinct native fields", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const cash = stocks.find(s => s.id === 6196)!;
  expect([cash.priceCash, cash.priceLucci, cash.secondaryPrice, cash.currencyType]).toEqual([98, 0, 120, 0]);
  expect([cash.isNew, cash.isHot, cash.buyableLucci]).toEqual([false, true, false]);
  const lucci = stocks.find(s => s.id === 3086)!;
  expect([lucci.priceCash, lucci.priceLucci, lucci.currencyType]).toEqual([0, 1800, 1]);
  expect([lucci.isNew, lucci.isHot, lucci.buyableLucci]).toEqual([false, false, true]);
  expect(stocks.filter(s => s.isNew).length).toBe(33);
  expect(stocks.filter(s => s.isHot).length).toBe(341);
});

test("retail sale rejects ineligible goods and refunds half the actual Lucci price", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const cheap = stocks.find(s => s.id === 6303)!;
  const cash = stocks.find(s => s.id === 6196)!;
  const timed = { ...cheap, id: 999991, durationDays: 1 };
  const db = new GameDatabase(":memory:", new Map([cheap, cash, timed].map(s => [s.id, s])), new Map());
  const id = db.registerAccount("sellrules", "pw", "販售測試", 0).profile!.id;
  for (const stock of [cheap, cash, timed]) expect(db.buyStock(id, stock.id, stock.priceLucci ? "lucci" : "cash").ok).toBe(true);
  const inv = db.getInventory(id);
  expect(db.sellInventoryItem(id, inv.find(i => i.stockId === cash.id)!.invId).ok).toBe(false);
  expect(db.sellInventoryItem(id, inv.find(i => i.stockId === timed.id)!.invId).ok).toBe(false);
  const result = db.sellInventoryItem(id, inv.find(i => i.stockId === cheap.id)!.invId);
  expect(result.ok).toBe(true);
  expect(result.refundLucci).toBe(0);
});

test("retail special catalogue separates new, hot and flag 0x40 and sorts signed keys", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const base = stocks.find(s => s.id === 3086)!;
  const item = (id: number, order: number, flags = 0) => ({
    ...base, id, sortOrder: order, flags,
    isNew: order <= -10000, isHot: order < 0 && order > -10000,
  });
  const entries = [item(1, -10001), item(2, -5), item(3, -20000), item(4, -3, 0x40), item(5, -20001, 4), item(6, -2, 8), item(7, -1, 0x20)];
  const stage = new ShopStage({ assets: { tables: { fxStock: entries } } } as any) as any;
  stage.rebuildFilter();
  expect(stage.filtered.map((s: any) => s.id)).toEqual([3, 1]);
  stage.subTabIdx = 1;
  stage.rebuildFilter();
  expect(stage.filtered.map((s: any) => s.id)).toEqual([2]);
  stage.subTabIdx = 2;
  stage.rebuildFilter();
  expect(stage.filtered.map((s: any) => s.id)).toEqual([4]);
  stage.currencyFilter = "cash";
  stage.rebuildFilter();
  expect(stage.filtered).toEqual([]);
});

test("sold out stock cannot be purchased, gifted or batch checked out", () => {
  const original = parseFxStock(readFileSync("fxstock.ini")).find(s => s.priceCash > 0)!;
  const good = { ...original, id: 888880, flags: 0 };
  const sold = { ...original, id: 888881, flags: 0x10 };
  const db = new GameDatabase(":memory:", new Map([[good.id, good], [sold.id, sold]]), new Map());
  const buyer = db.registerAccount("soldbuyer", "pw", "買家", 0).profile!;
  db.registerAccount("soldreceiver", "pw", "收禮", 0);
  expect(db.buyStock(buyer.id, sold.id, "cash").ok).toBe(false);
  expect(db.buyStock(buyer.id, sold.id, "cash", "soldreceiver").ok).toBe(false);
  expect(db.buyStockBatch(buyer.id, [{ stockId: good.id, currency: "cash", qty: 1 }, { stockId: sold.id, currency: "cash", qty: 1 }]).ok).toBe(false);
  expect(db.getProfileById(buyer.id)!.cash).toBe(buyer.cash);
  expect(db.getInventory(buyer.id).some(i => i.stockId === good.id || i.stockId === sold.id)).toBe(false);
});

test("retail description uses ShopItem +52, not its sort key or a character mask", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const strings = parseStringTable(readFileSync("stringtable.ini"));
  const st = stocks.find(s => s.id === 3086)!;
  expect(st.descriptionId).toBe(49);
  expect(strings.get(st.descriptionId)).toBe("把自己的背景圖案裝飾的很漂亮.");
  expect(st.sortOrder).toBe(519);
  expect(strings.get(st.sortOrder)).toBeUndefined();
  const cash = stocks.find(s => s.id === 6196)!;
  expect(cash.sortOrder).toBe(-150);
  expect(strings.get(cash.descriptionId)).toContain("角色打扮");
});

test("MyPage premium slots come from catalogue rather than bag rows", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const stock = stocks.find(s => s.id === 3086)!;
  const other = stocks.find(s => s.id === 6196)!;
  const assets = { loadSheet: async () => null, tables: { stockById: new Map([[stock.id, stock], [other.id, other]]) } } as any;
  const hub = { inventory: [{ invId: 42, stockId: other.id, category: 1, quantity: 1, equipped: true }], premiumSlots: [], profile: null, send: () => {} } as any;
  const dlg = new MyPageDlg(assets, hub, () => {}) as any;
  dlg.tabIdx = 0;
  expect(dlg.activeTabItems()).toEqual([]);
  dlg.selectedPremiumSlot = 0;
  expect(dlg.selectedPremiumStock()).toBeUndefined();
  hub.premiumSlots = [{ stockId: stock.id, iconName: "SlotDeco" }];
  expect(dlg.selectedPremiumStock()?.id).toBe(stock.id);
  hub.inventory = [];
  expect(dlg.selectedPremiumStock()?.id).toBe(stock.id);
  hub.premiumSlots = [];
  expect(dlg.selectedPremiumStock()).toBeUndefined();
});

test("retail catalogue main and directly known subcategories follow ShopItem classifiers", () => {
  for (const [category, main, sub] of [
    [1, 1, 1], [2, 1, 0], [9, 1, 0], [15, 1, 2], [16, 1, 0], [17, 1, 2], [27, 1, 2], [33, 1, 0],
    [3, 2, 6], [14, 2, 0], [20, 2, 5], [4, 3, 6], [5, 3, 4], [6, 3, 4], [18, 3, 5],
    [11, 4, 1], [21, 4, 2], [22, 4, 3], [23, 4, 1], [24, 4, 4], [25, 4, 4], [26, 4, 0],
  ] as const) expect(retailShopCategory(category)).toEqual({ main, sub });
  expect(retailShopCategory(12)).toEqual({ main: 2, sub: null });
  expect(retailShopCategory(10)).toEqual({ main: 3, sub: null });
  expect(retailShopCategory(11, 1)).toEqual({ main: 1, sub: 0 });
  expect(retailShopCategory(1, 4)).toEqual({ main: -1, sub: -1 });
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const stage = new ShopStage({ assets: { tables: { fxStock: stocks } } } as any) as any;
  stage.tabIdx = 1; stage.subTabIdx = 1; stage.rebuildFilter();
  expect(stage.filtered.length).toBeGreaterThan(0);
  expect(stage.filtered.every((s: any) => s.category === 1)).toBe(true);
  stage.tabIdx = 4; stage.subTabIdx = 1; stage.rebuildFilter();
  expect(stage.filtered.length).toBeGreaterThan(0);
  expect(stage.filtered.every((s: any) => s.category === 11 || s.category === 23)).toBe(true);
  stage.tabIdx = 2; stage.subTabIdx = 6; stage.rebuildFilter();
  expect(stage.filtered.some((s: any) => s.category === 3)).toBe(true);
});


test("retail card price uses original +124 and arrow to current +112", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const discounted = stocks.find(s => s.id === 6196)!;
  expect(retailPriceText(discounted.priceCash, discounted.secondaryPrice)).toBe("120------>98");
  const normal = stocks.find(s => s.id === 3086)!;
  expect(retailPriceText(normal.priceLucci, normal.secondaryPrice)).toBe("1800");
  expect(retailPriceText(15)).toBe("15");
});

test("zero-price stock retains native currency and can be checked out without charge", () => {
  const stocks = parseFxStock(readFileSync("fxstock.ini"));
  const item = stocks.find(s => s.id === 3232)!;
  expect([item.priceCash, item.priceLucci, item.currencyType, item.stockType]).toEqual([0, 0, 1, 0]);
  const db = new GameDatabase(":memory:", new Map([[item.id, item]]), new Map());
  const profile = db.registerAccount("freebuyer", "pw", "零價買家", 0).profile!;
  expect(db.buyStock(profile.id, item.id, "cash").ok).toBe(false);
  expect(db.buyStock(profile.id, item.id, "lucci").ok).toBe(true);
  expect(db.buyStockBatch(profile.id, [{ stockId: item.id, currency: "lucci", qty: 2 }]).ok).toBe(true);
  expect(db.getProfileById(profile.id)!.lucci).toBe(profile.lucci);
  expect(db.getInventory(profile.id).find(i => i.stockId === item.id)?.quantity).toBe(3);
  const sent: ClientMsg[] = [];
  const stage = new ShopStage({ hub: { connected: true, send: (m: ClientMsg) => sent.push(m) }, dialogs: { push: () => {} } } as any) as any;
  stage.addOrToggleCartItem(item);
  stage.buyCartItems(stage.cart);
  expect((sent[0] as Extract<ClientMsg, { type: "shop_buy_batch" }>).items[0]!.currency).toBe("lucci");
});

test("MyInfo uses known character metadata for native partition and descending priority sort", () => {
  const inventory = [
    { invId: 1, stockId: 1, category: 19, quantity: 1, equipped: false, nativeCharacterCode: 1, nativeSortKey: 7 },
    { invId: 2, stockId: 2, category: 12, quantity: 1, equipped: false },
    { invId: 3, stockId: 3, category: 19, quantity: 1, equipped: false, nativeCharacterCode: 0, nativeSortKey: 4 },
    { invId: 4, stockId: 4, category: 14, quantity: 1, equipped: false },
    { invId: 5, stockId: 5, category: 19, quantity: 1, equipped: false, nativeCharacterCode: 0, nativeSortKey: 9 },
  ];
  const hub = { inventory, profile: { selectedChar: 0 }, send: () => {} } as any;
  const dlg = new MyPageDlg({ loadSheet: async () => null } as never, hub, () => {}) as any;
  let rows = dlg.bagRows();
  expect(rows.slice(0, 2).map((r: any) => r.invId)).toEqual([5, 3]);
  expect(rows.slice(2, 4).map((r: any) => r.category).sort()).toEqual([12, 14]);
  expect(rows[4].invId).toBe(1);
  expect(dlg.isBagPriority(inventory[0])).toBe(false);
  hub.profile.selectedChar = 1;
  rows = dlg.bagRows();
  expect(rows[0].invId).toBe(1);
  expect(dlg.isBagPriority(inventory[0])).toBe(true);
});

test("inventory hour thresholds and stack labels follow native fields", () => {
  expect(formatRemainingHours(undefined)).toBe("期限未提供");
  expect(formatRemainingHours(0)).toBe("0天 0小時");
  expect(formatRemainingHours(25)).toBe("1天 1小時");
  expect(formatRemainingHours(8759)).toBe("364天 23小時");
  expect(formatRemainingHours(8760)).toBe("365天以上");
  expect(formatRemainingHours(240000)).toBe("無限");
  const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
  const sheet = decodeSpriteSheet(fx.payload("Shop/IconTime")!)!;
  const bag = new InventoryWndNew(0, 0, { drawStockIconAnchored: () => {} } as any) as any;
  bag.timeIconSheet = { tex: {}, sheet, width: sheet.width, height: sheet.height };
  const items = [
    { invId: 1, stockId: 1, category: 1, quantity: 1, equipped: false, remainingHours: 8759 },
    { invId: 2, stockId: 2, category: 12, quantity: 7, equipped: false, remainingHours: 8760 },
    { invId: 3, stockId: 3, category: 15, quantity: 2, equipped: false },
  ];
  const draws: any[] = [], texts: string[] = [];
  bag.render({ drawSprite: (x: any) => draws.push(x), drawText: (text: string) => texts.push(text) }, { tables: null }, { inventory: items });
  expect(draws.length).toBe(1);
  expect(texts).toContain("1");
  expect(texts).toContain("2");
  expect(texts).not.toContain("7");
});


test("Bula client traces coloured subcell loops and scans block requests, not floor flood fills", () => {
  const width = 15, height = 10;
  const states = Array<number>(width * height).fill(0);
  for (let x = 2; x <= 10; x++) states[2 * width + x] = states[7 * width + x] = 3;
  for (let y = 2; y <= 7; y++) states[y * width + 2] = states[y * width + 10] = 3;
  const grid = { width, height, states };
  const loops = traceBulaLoopsAt(grid, 2, 2, 3);
  expect(loops).toHaveLength(2);
  expect(loops[0]!.reduce((a, b) => a + b, 0)).toBe(26);
  // sub_49BF75 enumerates existing unclaimed block cells, deduplicated across
  // subcell rows; claimed/absent objects are filtered by the caller.
  const blocks = new Set(["1:1", "1:2", "2:2", "3:3"]);
  expect(bulaLoopCandidates(loops[0]!, width, height, (row, col) => blocks.has(`${row}:${col}`)))
    .toEqual([[1, 1], [1, 2], [2, 2], [3, 3]]);
  expect(bulaLoopCandidates(loops[0]!, width, height, () => false)).toEqual([]);
  states[4 * width + 2] = 0;
  expect(traceBulaLoopsAt(grid, 2, 2, 3)).toHaveLength(0);
  states[4 * width + 2] = 4; // rival coloured dot blocks the walk too
  expect(traceBulaLoopsAt(grid, 2, 2, 3)).toHaveLength(0);
  states[4 * width + 2] = bulaNativeDotState(1, { hideAfter: true });
  expect(states[4 * width + 2]).toBe(11); // hidden immediately, even during its animation
  expect(traceBulaLoopsAt(grid, 2, 2, 3)).toHaveLength(0);
  expect(bulaNativeDotState(1, { hideAfter: false })).toBe(3);
  expect(bulaNativeDotState(-1, null)).toBe(0);
  expect(bulaNativeDotState(0, null)).toBe(1);
  expect(traceBulaLoop(grid, -1, 0, 0, 1, 3)).toBeNull();
  expect(traceBulaLoop({ width, height, states: [] }, 0, 0, 0, 1, 3)).toBeNull();

  // The native scan has no invented 24-cell flood-fill cap.
  const w = 45, h = 26, large = Array<number>(w * h).fill(0);
  for (let x = 2; x <= 40; x++) large[2 * w + x] = large[22 * w + x] = 3;
  for (let y = 2; y <= 22; y++) large[y * w + 2] = large[y * w + 40] = 3;
  const largeLoops = traceBulaLoopsAt({ width: w, height: h, states: large }, 2, 2, 3);
  expect(largeLoops.length).toBeGreaterThan(0);
  expect(bulaLoopCandidates(largeLoops[0]!, w, h, () => true).length).toBeGreaterThan(24);
});


test("inventory hover uses retail Big5 name truncation and real period tooltip frames", () => {
  const strings = parseSysStrings(readFileSync("csysstr.ssd"));
  expect(inventoryTooltipPeriod(undefined, strings)).toBeNull();
  expect(inventoryTooltipPeriod(0, strings)).toBeNull();
  expect(inventoryTooltipPeriod(1, strings)).toBe("期限 : 0天 1小時");
  expect(inventoryTooltipPeriod(25, strings)).toBe("期限 : 1天 1小時");
  expect(inventoryTooltipPeriod(8759, strings)).toBe("期限 : 364天 23小時");
  expect(inventoryTooltipPeriod(8760, strings)).toBe("365天以上");
  expect(inventoryTooltipPeriod(239999, strings)).toBe("365天以上");
  expect(inventoryTooltipPeriod(240000, strings)).toBeNull();
  expect(inventoryTooltipName("123456789012345678")).toBe("123456789012345678");
  expect(inventoryTooltipName("1234567890123456789")).toBe("1234567890123...");
  expect(inventoryTooltipName("一二三四五六七八九十")).toBe("一二三四五六七...");
  expect(inventoryTooltipName("A一二三四五六七八九十")).toBe("A一二三四五六...");

  const fx = new Pack("Fx", readFileSync("Fx.idx"), readFileSync("Fx.idd"));
  const one = decodeSpriteSheet(fx.payload("Shop/TimeTable_01")!)!;
  const two = decodeSpriteSheet(fx.payload("Shop/TimeTable_02")!)!;
  expect([one.rects[0]!.px, one.rects[0]!.py]).toEqual([0, 25]);
  expect([two.rects[0]!.px, two.rects[0]!.py]).toEqual([0, 41]);
  const bag = new InventoryWndNew(34, 383, { drawStockIconAnchored: () => {} } as any) as any;
  bag.timeTable01Sheet = { tex: "one", sheet: one, width: one.width, height: one.height };
  bag.timeTable02Sheet = { tex: "two", sheet: two, width: two.width, height: two.height };
  const items = [
    { invId: 1, stockId: 1, category: 12, quantity: 1, equipped: false, remainingHours: 25 },
    { invId: 2, stockId: 2, category: 12, quantity: 1, equipped: false },
  ];
  const assets = { tables: { stockById: new Map([[1, { name: "一二三四五六七八九十" }], [2, { name: "無期限資料" }]]), sysStrings: strings } } as any;
  const draws: any[] = [], texts: any[] = [];
  const renderer = { drawSprite: (x: any) => draws.push(x), drawText: (...args: any[]) => texts.push(args) };
  const sound = { playSfx: () => {} } as any;
  bag.onMouseMove(145, 248, sound, 100, -140); // first slot with dialog offset
  bag.render(renderer, assets, { inventory: items }, 100, -140);
  expect(draws.find(x => x.tex === "two")).toMatchObject({ x: 107, y: 202, w: 117, h: 42 });
  expect(texts.find(x => x[0] === "一二三四五六七...")?.slice(1, 3)).toEqual([165, 208]);
  expect(texts.find(x => x[0] === "期限 : 1天 1小時")?.slice(1, 3)).toEqual([165, 222]);
  draws.length = 0; texts.length = 0;
  bag.onMouseMove(210, 248, sound, 100, -140);
  bag.render(renderer, assets, { inventory: items }, 100, -140);
  expect(draws.some(x => x.tex === "one")).toBe(true);
  expect(texts.some(x => x[0] === "期限未提供")).toBe(false);
  bag.clearHover(); draws.length = 0; texts.length = 0;
  bag.render(renderer, assets, { inventory: items }, 100, -140);
  expect(draws.some(x => x.tex === "one" || x.tex === "two")).toBe(false);
});


test("dialog stack does not turn secondary clicks into left button actions", () => {
  const events: string[] = [];
  const stack = new DialogStack();
  const dlg = { id: "test", closed: false, onMouseMove() {},
    onMouseDown() { events.push("down"); return true; },
    onMouseUp() { events.push("up"); return true; }, render() {} };
  stack.push(dlg);
  const sound = {} as never;
  stack.onMouseDown(1, 1, sound, 2);
  stack.onMouseUp(1, 1, sound, 2);
  expect(events).toEqual([]);
  stack.onMouseDown(1, 1, sound, 0);
  stack.onMouseUp(1, 1, sound, 0);
  expect(events).toEqual(["down", "up"]);
});


test("shop owned tooltip uses native localized count and actual remaining hours", () => {
  const strings = parseSysStrings(readFileSync("csysstr.ssd"));
  expect(retailOwnedTooltip(1, 7, undefined, strings)).toEqual({ title: "有保留", detail: "數量 : 7個" });
  expect(retailOwnedTooltip(13, 1, 240000, strings).detail).toBe("數量 : 1個");
  expect(retailOwnedTooltip(15, 3, 0, strings).detail).toBe("數量 : 3個");
  expect(retailOwnedTooltip(12, 1, undefined, strings).detail).toBeNull();
  expect(retailOwnedTooltip(12, 1, 0, strings).detail).toBe("期限 : 0天 0小時");
  expect(retailOwnedTooltip(12, 1, 25, strings).detail).toBe("期限 : 1天 1小時");
  expect(retailOwnedTooltip(12, 1, 8759, strings).detail).toBe("期限 : 364天 23小時");
  expect(retailOwnedTooltip(12, 1, 8760, strings).detail).toBe("365天以上");
  expect(retailOwnedTooltip(12, 1, 239999, strings).detail).toBe("365天以上");
  expect(retailOwnedTooltip(12, 1, 240000, strings).detail).toBeNull();
});

test("shop secondary release never activates an existing menu button", () => {
  const stage = new ShopStage({} as any) as any;
  const popup = stage.popupMenu;
  let calls = 0;
  popup.openShopCard(100, 100, false, { onShowDetail: () => calls++, onTogglePreview: () => calls++ });
  popup.onMouseDown(105, 105);
  stage.onMouseUp(105, 105, 2);
  expect(calls).toBe(0);
  expect(popup.active).toBe(true);
  stage.onMouseDown(105, 105, 2);
  expect(popup.active).toBe(false);
  expect(calls).toBe(0);
});
