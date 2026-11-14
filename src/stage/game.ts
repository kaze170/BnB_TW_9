// Stage 13: `CGameStage` (`src/stage/game.ts`).
// Full retail Taiwan BnB v9 playfield & HUD renderer supporting:
//   - Online authoritative 30ms multiplayer matches (`ClientHub`)
//   - Offline 1P / 2P Split-Keyboard + Smart AI Practice matches (`GameSimulation`)
//   - Authentic Y-sorted playfield rendering (animated ground, items, crumbling
//     boxes, sliding push-boxes, parabolic thrown water balloons, multi-part
//     directional flames, two-layer HLS-tinted bombers, mounts, bubbles, bushes)
//   - Wave-bouncing `Game/Start`, `Game/HurryUp`, `Game/Win`, `Game/Lose`, `Game/Draw`
//     letter banners + post-match EXP/Lucci Result Scoreboard!

import type { LoadedSheet } from "../data/assets.ts";
import { encodeBig5, decodeBig5 } from "../data/big5.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
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
  BOX_CRUMBLE_TICKS,
  CELL_PX,
  FLAME_TICKS,
  GameSimulation,
  START_BANNER_TICKS,
  TICK_MS,
  type Dir4,
  type GameModeId,
  type MatchParticipantInit,
  type PlayerInput,
  type SimPlayer,
  type SimSnapshot,
} from "../sim/engine.ts";
import { computeAiInput } from "../sim/ai.ts";
import { LevelNoticeDlg, QuestionMarkRouletteDlg, RetNoticeDlg, UserInfoDlg } from "../ui/dialogs.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import {
  CharacterPreviewCache,
  MotionBlurTrail,
  SpriteButton,
  SpriteItemBoxWheel,
  SpriteMsgView,
  drawLevelIcon,
  drawPat9Slice,
  drawSheetFrame,
  drawGameSpeechBubble,
  handleRetailSlashCommand,
  inferChatEmotionPose,
  sampleActionFrame,
} from "../ui/widgets.ts";
import type { AppContext, Stage } from "./types.ts";

/** Retail caps map labels at 12 Big5 bytes; avoid cutting a double-byte character. */
export function gameMapLabel(name: string): string {
  const bytes = encodeBig5(name);
  if (bytes.length <= 12) return name;
  let end = 9;
  // Walk complete Big5 characters rather than leaving a dangling lead byte.
  let i = 0;
  while (i < end) {
    const size = bytes[i]! >= 0x81 ? 2 : 1;
    if (i + size > end) break;
    i += size;
  }
  end = i;
  return decodeBig5(bytes.subarray(0, end)) + "...";
}

const RIDE_OBJECTS: Record<number, string> = {
  1: "Ship/Airship",
  2: "Ship/Owl",
  3: "Ship/Turtle0",
  4: "Ship/Turtle1",
  5: "Ship/AirshipBroken",
  6: "Ship/Octopus0",
  7: "Ship/Octopus1",
  8: "Ship/RailCar",
  9: "Ship/Kart",
  10: "Ship/Kart",
  11: "Ship/Tank",
};

const ACTIVE_HUD_SPRITES: Record<number, string> = {
  [ACTIVE_NEEDLE]: "Item/Niddle",
  [ACTIVE_SHIELD]: "Item/Shield",
  [ACTIVE_CAN]: "Item/Can",
  [ACTIVE_DART]: "Item/Dart",
  [ACTIVE_BANANA]: "Item/Banana00",
  [ACTIVE_MINE]: "Item/Trap",
  [ACTIVE_SPRING]: "Item/Spring",
  [ACTIVE_REMOTE]: "Item/RadioBomb",
  [ACTIVE_BLIND]: "Item/Blind",
  [ACTIVE_DRILL]: "Item/Drill",
  [ACTIVE_GUM]: "Item/Bond",
  [ACTIVE_PIN]: "Item/Pushpin",
  [ACTIVE_WATERTIGHT]: "Item/Watertight",
};

const DIR_WORDS = ["Left", "Up", "Right", "Down"] as const;

export class GameStage implements Stage {
  readonly id = "game" as const;

  private hudBg: LoadedSheet | null = null;
  private hudBg2P: LoadedSheet | null = null;
  private timerSheet: LoadedSheet | null = null;
  private itemBoxSheet: LoadedSheet | null = null;
  private itemBox2PSheet: LoadedSheet | null = null;
  private patResultSheet: LoadedSheet | null = null;
  private resultImgSheet: LoadedSheet | null = null;
  private balloonSheet: LoadedSheet | null = null;
  private needleSheet: LoadedSheet | null = null;
  private shieldSheet: LoadedSheet | null = null;
  private bombSheet: LoadedSheet | null = null;
  private bubbleSheet: LoadedSheet | null = null;
  private fireSheet: LoadedSheet | null = null;
  private shadowSheet: LoadedSheet | null = null;
  private selfIndSheet: LoadedSheet | null = null;
  private selfInd1PSheet: LoadedSheet | null = null;
  private selfInd2PSheet: LoadedSheet | null = null;
  private captainFlagSheet: LoadedSheet | null = null;
  private timebombIndSheet: LoadedSheet | null = null;
  private timebombFrameSheet: LoadedSheet | null = null;
  private timebombRouletteSheet: LoadedSheet | null = null;
  private levelIconsSheet: LoadedSheet | null = null;
  private portraitHandleSheet: LoadedSheet | null = null;
  private bannerStart: LoadedSheet | null = null;
  private bannerBonus: LoadedSheet | null = null;
  private bannerHurry: LoadedSheet | null = null;
  private bannerWin: LoadedSheet | null = null;
  private bannerPerfect: LoadedSheet | null = null;
  private bannerPlayer01: LoadedSheet | null = null;
  private bannerPlayer02: LoadedSheet | null = null;
  private bannerLose: LoadedSheet | null = null;
  private bannerDraw: LoadedSheet | null = null;
  private firstFlagSheet: LoadedSheet | null = null;
  private finalFlagSheet: LoadedSheet | null = null;

  private readonly btExit: SpriteButton;
  private readonly btResultOk: SpriteButton;
  private readonly chatView: SpriteMsgView;
  private readonly edChat: WebGpuEditBox;
  private chatOpen = false;

  private readonly cache = new CharacterPreviewCache();
  private loaded = false;

  // Offline simulation state (when `ctx.practiceConfig !== null`)
  private localSim: GameSimulation | null = null;
  private localAccMs = 0;
  private finishHoldMs = 0;
  private hurryPlayed = false;
  private endSfxPlayed = false;
  private goPlayed = false;
  private kartFastPlayed = false;
  private lastCountSec = -1;
  private lastWalkSfxMs = 0;
  private activeMapName = "";
  private activeMapPortals: readonly (readonly [number, number, number, number])[] = [];

  // Pressed key tracking (`e.code`) for crisp 1P & 2P split-keyboard response
  private readonly keysDown = new Set<string>();
  private readonly dirStack1P: Dir4[] = [];
  private readonly dirStack2P: Dir4[] = [];
  private bombEdge1P = false;
  private activeEdge1P = false;
  private slotEdge1P: number | undefined = undefined;
  private bombEdge2P = false;
  private activeEdge2P = false;
  private lastSentHash1 = "";
  private lastSentHash2 = "";

  private readonly motionTrails = new Map<number, MotionBlurTrail>();
  private readonly slotBubbles = new Map<number, { text: string; untilMs: number }>();
  private readonly slotEmotions = new Map<number, { pose: number; stockId: number; untilMs: number }>();
  private readonly followerTrails = new Map<number, { x: number; y: number; dir: 0 | 1 | 2 | 3; tick: number }[]>();
  private readonly prevStates = new Map<number, SimPlayer["state"]>();
  private readonly releaseStartTick = new Map<number, number>();
  private hurryStartTick = -1;
  private finishStartTick = -1;
  private readonly itemBoxWheel: SpriteItemBoxWheel;
  private unsub: (() => void) | null = null;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.btExit = new SpriteButton(649, 555, () => this.exitMatch());
    this.btResultOk = new SpriteButton(270, 474, () => this.exitMatch());
    this.itemBoxWheel = new SpriteItemBoxWheel(this.cache, (entry) => {
      const mySlot = this.localSim ? 0 : Math.max(0, this.ctx.hub.mySlot);
      this.slotEmotions.set(mySlot, {
        pose: entry.pose,
        stockId: entry.stockId ?? (this.ctx.hub.profile?.equipped.emotionStockId ?? 0),
        untilMs: performance.now() + 3200,
      });
      if (!this.localSim) {
        const cmds = ["/hi", "/哭", "/怒", "/笑", "/加油", "/羞", "/特", "/愛"];
        this.ctx.hub.send({ type: "chat_send", text: cmds[(entry.pose - 3 + cmds.length) % cmds.length] ?? "/笑" });
      }
    });
    // Exact `CA.exe` `CGameStage` chat MsgView `(25, 463, 442, 66)` & Edit `(25, 539, 438, 12)`
    this.chatView = new SpriteMsgView(25, 463, 442, 66, null);
    this.edChat = new WebGpuEditBox({
      x: 25,
      y: 539,
      w: 438,
      h: 12,
      maxLength: 80,
      textColor: [1, 1, 1, 1],
      onEnter: () => {
        const txt = this.edChat.value.trim();
        this.edChat.value = "";
        this.chatOpen = false;
        imeHost.blur();
        if (txt && !this.localSim) {
          if (
            handleRetailSlashCommand(txt, this.ctx.assets, this.ctx.hub, {
              onOpenUserInfo: (u) =>
                this.ctx.dialogs.push(new UserInfoDlg(this.ctx.assets, this.ctx.hub, u)),
            })
          ) {
            return;
          }
          const payload =
            this.ctx.hub.teamChatOnly && !txt.startsWith("/") ? `/to a ${txt}` : txt;
          this.ctx.hub.send({ type: "chat_send", text: payload });
        } else if (txt && this.localSim) {
          this.slotBubbles.set(0, { text: txt, untilMs: performance.now() + 3000 });
          const pose = inferChatEmotionPose(txt);
          if (pose > 0) {
            this.slotEmotions.set(0, {
              pose,
              stockId: this.ctx.hub.profile?.equipped.emotionStockId ?? 0,
              untilMs: performance.now() + 3200,
            });
          }
          this.ctx.hub.chatLog.push({
            kind: "chat",
            from: this.ctx.hub.profile?.nickname ?? "1P",
            text: txt,
            timeMs: Date.now(),
          });
        }
      },
    });
  }

  async enter(): Promise<void> {
    this.keysDown.clear();
    this.dirStack1P.length = 0;
    this.dirStack2P.length = 0;
    this.chatOpen = false;
    this.hurryPlayed = false;
    this.endSfxPlayed = false;
    this.goPlayed = false;
    this.kartFastPlayed = false;
    this.lastCountSec = -1;
    this.activeMapName = "";
    this.activeMapPortals = [];
    this.prevStates.clear();
    this.releaseStartTick.clear();
    this.hurryStartTick = -1;
    this.finishStartTick = -1;
    this.finishHoldMs = 0;
    this.slotBubbles.clear();
    this.motionTrails.clear();
    this.followerTrails.clear();
    imeHost.blur();

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      await assets.fx.prefetch([
        "Game/CAStage",
        "Game/CAStage2p",
        "Game/BtExit",
        "Game/Timer",
        "Game/ItemBox00",
        "Game/ItemBox01",
        "Game/PatResultDlg",
        "Game/ResultImg",
        "Game/ChatBalloon",
        "Game/SelfIndicator",
        "Game/SelfIndicator00",
        "Game/SelfIndicator01",
        "Game/CaptainFlag",
        "Game/FirstFlag",
        "Game/FinalFlag",
        "Game/TimebombIndicator",
        "Game/Start",
        "Game/HurryUp",
        "Game/Win",
        "Game/Perfect",
        "Game/Player01",
        "Game/Player02",
        "Game/Lose",
        "Game/Draw",
        "Dialog/Bt_Ok",
        "Bomb/Bomb00",
        "Bomb/Bubble00",
        "Bomb/Fire00",
        "Shadow/Shadow",
        "Item/Niddle",
        "Item/Shield",
        "Etc/PortraitHandle",
      ]);
      const [
        bg1,
        bg2,
        ex,
        tm,
        ib0,
        ib1,
        prd,
        rimg,
        bal,
        rok,
        st,
        hu,
        wn,
        pf,
        p01,
        p02,
        ls,
        dr,
        bm,
        bb,
        fr,
        sh,
        si,
        si0,
        si1,
        cf,
        ff1,
        ffl,
        tbi,
        ndl,
        shld,
        lvi,
        phdl,
        bns,
      ] = await Promise.all([
        assets.loadSheet("Fx", "Game/CAStage"),
        assets.loadSheet("Fx", "Game/CAStage2p"),
        assets.loadSheet("Fx", "Game/BtExit"),
        assets.loadSheet("Fx", "Game/Timer"),
        assets.loadSheet("Fx", "Game/ItemBox00"),
        assets.loadSheet("Fx", "Game/ItemBox01"),
        assets.loadSheet("Fx", "Game/PatResultDlg"),
        assets.loadSheet("Fx", "Game/ResultImg"),
        assets.loadSheet("Fx", "Game/ChatBalloon"),
        assets.loadSheet("Fx", "Dialog/Bt_Ok"),
        assets.loadSheet("Fx", "Game/Start"),
        assets.loadSheet("Fx", "Game/HurryUp"),
        assets.loadSheet("Fx", "Game/Win"),
        assets.loadSheet("Fx", "Game/Perfect"),
        assets.loadSheet("Fx", "Game/Player01"),
        assets.loadSheet("Fx", "Game/Player02"),
        assets.loadSheet("Fx", "Game/Lose"),
        assets.loadSheet("Fx", "Game/Draw"),
        assets.loadSheet("Fx", "Bomb/Bomb00"),
        assets.loadSheet("Fx", "Bomb/Bubble00"),
        assets.loadSheet("Fx", "Bomb/Fire00"),
        assets.loadSheet("Fx", "Shadow/Shadow"),
        assets.loadSheet("Fx", "Game/SelfIndicator"),
        assets.loadSheet("Fx", "Game/SelfIndicator00"),
        assets.loadSheet("Fx", "Game/SelfIndicator01"),
        assets.loadSheet("Fx", "Game/CaptainFlag"),
        assets.loadSheet("Fx", "Game/FirstFlag"),
        assets.loadSheet("Fx", "Game/FinalFlag"),
        assets.loadSheet("Fx", "Game/TimebombIndicator"),
        assets.loadSheet("Fx", "Item/Niddle"),
        assets.loadSheet("Fx", "Item/Shield"),
        assets.loadSheet("Cx", "Etc/LevelIcons"),
        assets.loadSheet("Fx", "Etc/PortraitHandle"),
        assets.loadSheet("Fx", "Bonus/BONUSSTAGE!!"),
        this.itemBoxWheel.load(assets),
      ]);
      this.hudBg = bg1;
      this.hudBg2P = bg2;
      this.btExit.bindSheet(ex, 138, 34);
      this.btResultOk.bindSheet(rok, 100, 32);
      this.timerSheet = tm;
      this.itemBoxSheet = ib0;
      this.itemBox2PSheet = ib1;
      this.patResultSheet = prd;
      this.selfIndSheet = si;
      this.selfInd1PSheet = si0;
      this.selfInd2PSheet = si1;
      this.captainFlagSheet = cf;
      this.firstFlagSheet = ff1;
      this.finalFlagSheet = ffl;
      this.timebombIndSheet = tbi;
      this.needleSheet = ndl;
      this.shieldSheet = shld;
      this.levelIconsSheet = lvi;
      this.portraitHandleSheet = phdl;
      this.bannerBonus = bns;
      this.resultImgSheet = rimg;
      this.balloonSheet = bal;
      this.bannerStart = st;
      this.bannerHurry = hu;
      this.bannerWin = wn;
      this.bannerPerfect = pf;
      this.bannerPlayer01 = p01;
      this.bannerPlayer02 = p02;
      this.bannerLose = ls;
      this.bannerDraw = dr;
      this.bombSheet = bm;
      this.bubbleSheet = bb;
      this.fireSheet = fr;
      this.shadowSheet = sh;
    }

    // Offline Practice Launch vs Online Match
    if (this.ctx.practiceConfig) {
      await this.initOfflineMatch();
    } else {
      this.localSim = null;
      const snap = this.ctx.hub.latestSnapshot;
      if (snap) {
        this.activeMapName = snap.mapName;
        const md = await this.ctx.assets.loadMapData(snap.mapName);
        this.activeMapPortals = md?.portals ?? [];
        this.ctx.sound.playMapBgm(snap.mapName);
      }
      this.ctx.sound.playGameStartSfx();

      this.unsub?.();
      this.unsub = this.ctx.hub.onMessage((msg) => {
        if (msg.type === "match_state") {
          if (msg.snapshot.mapName !== this.activeMapName) {
            this.activeMapName = msg.snapshot.mapName;
            this.ctx.sound.playMapBgm(msg.snapshot.mapName);
            void this.ctx.assets.loadMapData(msg.snapshot.mapName).then((md) => {
              if (this.activeMapName === msg.snapshot.mapName) {
                this.activeMapPortals = md?.portals ?? [];
              }
            });
          }
          this.playSnapSounds(msg.snapshot);
        } else if (msg.type === "room_sync" && !msg.room.playing) {
          const openRoulette = this.ctx.hub.pendingQuestionMarks > 0;
          const lvUp = this.ctx.hub.pendingLevelUp;
          this.ctx.hub.pendingLevelUp = null;
          void this.ctx.goto("prepare").then(() => {
            if (openRoulette) {
              this.ctx.dialogs.push(
                new QuestionMarkRouletteDlg(this.ctx.assets, this.ctx.hub, this.ctx.sound),
              );
            }
            if (lvUp !== null) {
              this.ctx.sound.playSfx("LevelUp", 0.95);
              this.ctx.dialogs.push(
                new LevelNoticeDlg(this.ctx.assets, lvUp.newLevel, lvUp.expGain, lvUp.lucciGain),
              );
            }
          });
        } else if (msg.type === "room_left") {
          void this.ctx.goto("lobby");
        } else if (msg.type === "chat_recv" && msg.slot !== undefined && msg.slot >= 0) {
          this.slotBubbles.set(msg.slot, { text: msg.text, untilMs: performance.now() + 3000 });
          const pose = inferChatEmotionPose(msg.text);
          if (pose > 0) {
            this.slotEmotions.set(msg.slot, {
              pose,
              stockId: 0,
              untilMs: performance.now() + 3200,
            });
          }
        }
      });
    }
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
    this.localSim = null;
    this.ctx.practiceConfig = null;
    this.ctx.sound.setBgmPlaybackRate(1.0);
    imeHost.blur();
  }

  private async initOfflineMatch(): Promise<void> {
    const cfg = this.ctx.practiceConfig!;
    const tables = this.ctx.assets.tables!;
    let mapCode = cfg.mapCode;
    if (!mapCode || mapCode === "Random" || !this.ctx.assets.fx.has(`Map/${mapCode}`)) {
      const pool = tables.playableMaps;
      mapCode = pool[Math.floor(Math.random() * pool.length)]?.name ?? "Patrit00";
    }
    const mapData = await this.ctx.assets.loadMapData(mapCode);
    if (!mapData) return;
    this.activeMapPortals = mapData.portals;

    const eq = this.ctx.hub.profile?.equipped;
    const inv = this.ctx.hub.inventory;
    let p1SlotCap = 4;
    if (inv.some((i) => i.category === 13 && tables.stockById.get(i.stockId)?.avatarCode === 10016 && i.quantity > 0)) {
      p1SlotCap = 6;
    } else if (inv.some((i) => i.category === 13 && i.quantity > 0)) {
      p1SlotCap = 5;
    }
    let p1SpeedBonus = 0;
    let p1PowerBonus = 0;
    let p1RadarTicks = 0;
    let p1Spanner = false;
    const p1Active: number[] = [];
    if (eq?.battleItemStockId) {
      const av = tables.stockById.get(eq.battleItemStockId)?.avatarCode ?? 0;
      if (av === 77) p1PowerBonus = 2;
      else if (av === 76) p1SpeedBonus = 2;
      else if (av === 74) p1Spanner = true;
      else if (av === 78) {
        p1RadarTicks = 600;
        p1Active.push(ACTIVE_RADAR);
      } else if (av === 2) p1Active.push(ACTIVE_DART, ACTIVE_DART);
      else if (av === 75 || av === 654 || av === 655) p1Active.push(ACTIVE_CAN);
      else if (av === 173) p1Active.push(ACTIVE_SPRING, ACTIVE_SPRING);
      else if (av === 10009) p1Active.push(ACTIVE_REMOTE);
    }

    const participants: MatchParticipantInit[] = [];
    participants.push({
      slot: 0,
      name: this.ctx.hub.profile?.nickname ?? "1P 玩家",
      charCode: cfg.player1Char,
      team: cfg.player1Team > 0 ? cfg.player1Team - 1 : 0,
      isAi: false,
      initialNeedles: 2,
      initialShields: 1,
      initialActiveItems: p1Active.length > 0 ? p1Active : undefined,
      initialSpeedBonus: p1SpeedBonus || undefined,
      initialPowerBonus: p1PowerBonus || undefined,
      initialRadarTicks: p1RadarTicks || undefined,
      activeSlotCap: p1SlotCap,
      hasSpanner: p1Spanner || undefined,
      hatCode: eq?.hatStockId ?? 0,
      charDecoCodes: eq?.charDecoStockIds ? [...eq.charDecoStockIds] : undefined,
      bombSkinCode: eq?.bombStockId ?? 0,
      idDecoCode: eq?.idDecoStockId ?? 0,
    });
    if (cfg.dual2P) {
      participants.push({
        slot: 1,
        name: "2P 玩家",
        charCode: cfg.player2Char,
        team: cfg.player2Team > 0 ? cfg.player2Team - 1 : 1,
        isAi: false,
        initialNeedles: 2,
        initialShields: 1,
      });
    }
    const aiPrefix = tables.sysStrings.get("AIName") ?? "機械人";
    cfg.bots.forEach((b, idx) => {
      const slot = participants.length;
      if (slot < 8) {
        participants.push({
          slot,
          name: `${aiPrefix}${idx + 1}`,
          charCode: b.charIdx,
          team: b.team > 0 ? b.team - 1 : (slot % 4),
          isAi: true,
          aiLevel: b.aiLevel,
          initialNeedles: b.aiLevel >= 3 ? 1 : 0,
        });
      }
    });

    this.localSim = new GameSimulation({
      mapData,
      mode: cfg.mode,
      participants,
      objectTable: tables.objectTable,
      bomberByCode: tables.bomberByCode,
      itemAttr: tables.itemAttr,
      tileInfo: tables.tileInfo,
    });
    this.localAccMs = 0;
    this.ctx.hub.latestSnapshot = this.localSim.toSnapshot();
    this.ctx.sound.playMapBgm(mapCode);
    this.ctx.sound.playGameStartSfx();
  }

  private isDual2P(): boolean {
    if (this.localSim) return Boolean(this.ctx.practiceConfig?.dual2P);
    return this.ctx.hub.slot2P >= 0;
  }

  private playSnapSounds(snap: SimSnapshot): void {
    for (const sfx of snap.sounds) {
      this.ctx.sound.playSfx(sfx, 0.8);
    }
    if (!snap.finished && snap.tick >= START_BANNER_TICKS) {
      const mySlot = this.localSim ? 0 : this.ctx.hub.mySlot;
      const me = snap.players.find((p) => p.slot === mySlot);
      if (me && me.state === "alive" && me.moving) {
        const now = performance.now();
        const isKart = me.rideId === 9 || me.rideId === 10;
        const interval = isKart ? 280 : 240;
        if (now - this.lastWalkSfxMs >= interval) {
          this.lastWalkSfxMs = now;
          if (isKart) this.ctx.sound.playSfx("KartMove", 0.42);
          else if (me.rideId <= 0) this.ctx.sound.playSfx("BomberWalk", 0.36);
        }
      }
    }
    if (!this.goPlayed && snap.tick >= START_BANNER_TICKS && !snap.finished) {
      this.goPlayed = true;
      this.ctx.sound.playSfx("TimerGo", 0.85);
    }
    if (snap.componentMode === 1 && !this.kartFastPlayed && !snap.finished) {
      const mySlot = this.localSim ? 0 : this.ctx.hub.mySlot;
      const me = snap.players.find((p) => p.slot === mySlot);
      if (me?.isFinalLap || snap.players.some((p) => p.isFirstPlace && p.isFinalLap)) {
        this.kartFastPlayed = true;
        this.hurryStartTick = snap.tick;
        this.ctx.sound.playSfx("HurryUp", 0.95);
        this.ctx.sound.playBgm("MP3/Kartfast", "Fx", true);
      }
    }
    if (!snap.finished && snap.tick > START_BANNER_TICKS) {
      const secsRem = Math.ceil((snap.ticksRemaining * TICK_MS) / 1000);
      if (secsRem <= 3 && secsRem >= 0 && secsRem !== this.lastCountSec) {
        this.lastCountSec = secsRem;
        if (secsRem === 3) this.ctx.sound.playSfx("Count3", 0.9);
        else if (secsRem === 2) this.ctx.sound.playSfx("Count2", 0.9);
        else if (secsRem === 1) this.ctx.sound.playSfx("Count1", 0.9);
        else if (secsRem === 0) this.ctx.sound.playTimerExpiredSfx(true);
      }
    }
    if (snap.hurryUp && !this.hurryPlayed) {
      this.hurryPlayed = true;
      this.ctx.sound.playSfx("HurryUp", 0.95);
      if (!this.kartFastPlayed) {
        this.ctx.sound.setBgmPlaybackRate(1.18);
      }
    }
    if (snap.finished && !this.endSfxPlayed) {
      this.endSfxPlayed = true;
      this.ctx.sound.setBgmPlaybackRate(1.0);
      const mySlot = this.localSim ? 0 : this.ctx.hub.mySlot;
      if (this.localSim) {
        const me = snap.players.find((p) => p.slot === mySlot);
        if ((me?.questionMarks ?? 0) > 0) {
          this.ctx.hub.pendingQuestionMarks += me!.questionMarks!;
        }
      }
      if (snap.winnerTeam < 0) {
        this.ctx.sound.playSfx("Draw", 0.95);
      } else if (snap.winnerSlots.includes(mySlot)) {
        if (/^bonus/i.test(snap.mapName) || snap.componentMode === 2 || snap.componentMode === 3) {
          this.ctx.sound.playStageEndingSfx();
        } else {
          this.ctx.sound.playSfx("Win", 0.95);
        }
      } else {
        this.ctx.sound.playSfx("Lose", 0.95);
      }

      // `CGOFanfareActor` (`CA.exe.c:55956..56026`): play `EmoTE` `Wave/Fanfare000..006` for winning bombers!
      const playedFanfares = new Set<number>();
      for (const wSlot of snap.winnerSlots) {
        const wPlayer = snap.players.find((pl) => pl.slot === wSlot);
        const rSlot = this.ctx.hub.currentRoom?.slots[wSlot];
        const isLocalW = wSlot === mySlot && !wPlayer?.isAi;
        const eq = isLocalW ? this.ctx.hub.profile?.equipped : undefined;
        const wStocks: Array<number | undefined> = [
          rSlot?.fanfareStockId,
          eq?.fanfareStockId,
          ...(wPlayer?.charDecoCodes ?? []),
          ...(rSlot?.charDecoStockIds ?? []),
          ...(eq?.charDecoStockIds ?? []),
        ];
        const fanIdx = this.cache.resolveFanfareIndexForStocks(this.ctx.assets, wStocks);
        if (fanIdx !== null && !playedFanfares.has(fanIdx)) {
          playedFanfares.add(fanIdx);
          this.ctx.sound.playSfx(`Wave/Fanfare00${fanIdx}`, 0.92, "EmoTE");
        }
      }
      if (this.ctx.hub.pendingLevelUp !== null) {
        this.ctx.sound.playSfx("LevelUp", 0.95);
      }
    }
  }

  private exitMatch(confirmed = false): void {
    const snap = this.localSim ? this.localSim.toSnapshot() : this.ctx.hub.latestSnapshot;
    if (!confirmed && !this.localSim && !this.ctx.practiceConfig && snap && !snap.finished) {
      this.ctx.dialogs.push(new RetNoticeDlg(this.ctx.assets, () => this.exitMatch(true)));
      return;
    }
    const openRoulette = this.ctx.hub.pendingQuestionMarks > 0;
    const lvUp = this.ctx.hub.pendingLevelUp;
    this.ctx.hub.pendingLevelUp = null;
    if (this.localSim || this.ctx.practiceConfig) {
      void this.ctx.goto("practice").then(() => {
        if (openRoulette) {
          this.ctx.dialogs.push(
            new QuestionMarkRouletteDlg(this.ctx.assets, this.ctx.hub, this.ctx.sound),
          );
        }
        if (lvUp !== null) {
          this.ctx.sound.playSfx("LevelUp", 0.95);
          this.ctx.dialogs.push(
            new LevelNoticeDlg(this.ctx.assets, lvUp.newLevel, lvUp.expGain, lvUp.lucciGain),
          );
        }
      });
    } else {
      this.ctx.hub.send({ type: "leave_room" });
      void this.ctx.goto("lobby").then(() => {
        if (lvUp !== null) {
          this.ctx.sound.playSfx("LevelUp", 0.95);
          this.ctx.dialogs.push(
            new LevelNoticeDlg(this.ctx.assets, lvUp.newLevel, lvUp.expGain, lvUp.lucciGain),
          );
        }
      });
    }
  }

  // ─── 1P & 2P Retail Keybind Polling (`CA.exe` 0x4F321A) ───────────────────

  private mapCodeToDir(code: string): { player: 1 | 2; dir: Dir4 } | null {
    const dual = this.isDual2P();
    if (!dual) {
      if (code === "ArrowLeft" || code === "KeyA") return { player: 1, dir: 0 };
      if (code === "ArrowUp" || code === "KeyW") return { player: 1, dir: 1 };
      if (code === "ArrowRight" || code === "KeyD") return { player: 1, dir: 2 };
      if (code === "ArrowDown" || code === "KeyS") return { player: 1, dir: 3 };
      return null;
    }
    // Retail 2P Split-Keyboard:
    // P1 = R(Up), F(Down), D(Left), G(Right) (also W/A/S for ergonomic comfort!)
    if (code === "KeyD" || code === "KeyA") return { player: 1, dir: 0 };
    if (code === "KeyR" || code === "KeyW") return { player: 1, dir: 1 };
    if (code === "KeyG") return { player: 1, dir: 2 };
    if (code === "KeyF" || code === "KeyS") return { player: 1, dir: 3 };
    // P2 = Arrow Keys
    if (code === "ArrowLeft") return { player: 2, dir: 0 };
    if (code === "ArrowUp") return { player: 2, dir: 1 };
    if (code === "ArrowRight") return { player: 2, dir: 2 };
    if (code === "ArrowDown") return { player: 2, dir: 3 };
    return null;
  }

  onKeyDown(e: KeyboardEvent): void {
    if (this.chatOpen) {
      if (e.key === "Escape") {
        this.chatOpen = false;
        imeHost.blur();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this.clearGameplayInput();
      this.chatOpen = true;
      this.edChat.focus();
      return;
    }
    if (e.key === "F4") {
      e.preventDefault();
      this.ctx.sound.playSfx("ScreenShot", 0.9);
      try {
        const cvs = document.getElementById("screen") as HTMLCanvasElement | null;
        if (cvs && typeof cvs.toDataURL === "function") {
          const url = cvs.toDataURL("image/png");
          const a = document.createElement("a");
          a.href = url;
          a.download = `bnb_tw9_${Date.now()}.png`;
          a.click();
        }
      } catch {
        // Ignore headless / cross-origin canvas export errors
      }
      this.ctx.hub.chatLog.push({
        kind: "system",
        from: "系統",
        text: "已擷取對戰畫面！(F4)",
        timeMs: performance.now(),
      });
      return;
    }
    if (e.key === "F6") {
      e.preventDefault();
      this.ctx.hub.showDangerZone = !this.ctx.hub.showDangerZone;
      this.ctx.sound.playSfx("ButtonDown_0", 0.55);
      this.ctx.hub.pushSystemChat(
        `危險區域輔助顯示 (RedZone)：${this.ctx.hub.showDangerZone ? "已開啟" : "已關閉"} (F6)`,
      );
      return;
    }
    if (e.key === "Escape") {
      this.exitMatch();
      return;
    }

    const code = e.code;
    if (
      code.startsWith("Arrow") ||
      code === "Space" ||
      code.startsWith("Shift") ||
      code.startsWith("Control") ||
      code.startsWith("Alt")
    ) {
      e.preventDefault();
    }

    // Retail `CGOItemBox` (`Etc/ItemBox` + `Etc/ItemBoxCursor`): hold `Alt` + Arrow keys in 1P mode!
    if (!this.isDual2P()) {
      if (e.altKey && e.code >= "Digit1" && e.code <= "Digit8") {
        e.preventDefault();
        this.itemBoxWheel.open = false;
        const pose = Number(e.code.slice(5));
        const mySlot = this.localSim ? 0 : Math.max(0, this.ctx.hub.mySlot);
        this.slotEmotions.set(mySlot, {
          pose,
          stockId: this.ctx.hub.profile?.equipped.emotionStockId ?? 0,
          untilMs: performance.now() + 3200,
        });
        return;
      }
      if (e.key === "Alt" || (this.itemBoxWheel.open && e.key.startsWith("Arrow"))) {
        if (this.itemBoxWheel.onKeyDown(e)) {
          e.preventDefault();
          return;
        }
      }
    }

    if (!this.keysDown.has(code)) {
      this.keysDown.add(code);
      const dm = this.mapCodeToDir(code);
      if (dm) {
        const st = dm.player === 1 ? this.dirStack1P : this.dirStack2P;
        const idx = st.indexOf(dm.dir);
        if (idx >= 0) st.splice(idx, 1);
        st.push(dm.dir);
      }

      const dual = this.isDual2P();
      if (!dual) {
        if (code === "Space" || code === "ShiftLeft" || code === "ShiftRight") {
          this.bombEdge1P = true;
        }
        if (code === "ControlLeft" || code === "ControlRight") {
          this.activeEdge1P = true;
        }
        if (e.altKey && code >= "Digit1" && code <= "Digit8") {
          e.preventDefault();
          const pose = Number(code.slice(5));
          const mySlot = this.localSim ? 0 : Math.max(0, this.ctx.hub.mySlot);
          this.slotEmotions.set(mySlot, {
            pose,
            stockId: this.ctx.hub.profile?.equipped.emotionStockId ?? 0,
            untilMs: performance.now() + 3200,
          });
          return;
        }
        if (code >= "Digit1" && code <= "Digit6") {
          this.slotEdge1P = Number(code.slice(5)) - 1;
          this.activeEdge1P = true;
        }
      } else {
        // 2P: P1 bomb = LeftShift / KeyZ, P1 item = LeftCtrl / Digit1..6
        if (code === "ShiftLeft" || code === "KeyZ") this.bombEdge1P = true;
        if (code === "ControlLeft" || (code >= "Digit1" && code <= "Digit6")) {
          this.activeEdge1P = true;
          if (code >= "Digit1" && code <= "Digit6") this.slotEdge1P = Number(code.slice(5)) - 1;
        }
        // P2 bomb = RightShift / Space / Slash, P2 item = RightCtrl / Period
        if (code === "ShiftRight" || code === "Space" || code === "Slash") {
          this.bombEdge2P = true;
        }
        if (code === "ControlRight" || code === "AltRight" || code === "Period") {
          this.activeEdge2P = true;
        }
      }
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    if (!this.isDual2P() && this.itemBoxWheel.onKeyUp(e, this.ctx.assets, this.ctx.hub)) {
      this.keysDown.delete(e.code);
      return;
    }
    const code = e.code;
    this.keysDown.delete(code);
    const dm = this.mapCodeToDir(code);
    if (dm) {
      const st = dm.player === 1 ? this.dirStack1P : this.dirStack2P;
      // Several physical keys can map to the same direction; releasing one
      // must not cancel another key that is still held.
      const stillHeld = [...this.keysDown].some(key => {
        const other = this.mapCodeToDir(key);
        return other?.player === dm.player && other.dir === dm.dir;
      });
      const idx = st.indexOf(dm.dir);
      if (!stillHeld && idx >= 0) st.splice(idx, 1);
    }
  }

  private clearGameplayInput(): void {
    this.keysDown.clear();
    this.dirStack1P.length = 0;
    this.dirStack2P.length = 0;
    this.bombEdge1P = this.bombEdge2P = false;
    this.activeEdge1P = this.activeEdge2P = false;
    this.slotEdge1P = undefined;
  }

  onBlur(): void {
    this.clearGameplayInput();
  }

  private sampleInput1P(): PlayerInput {
    const dual = this.isDual2P();
    const heldBomb = !dual
      ? this.keysDown.has("Space") || this.keysDown.has("ShiftLeft") || this.keysDown.has("ShiftRight")
      : this.keysDown.has("ShiftLeft") || this.keysDown.has("KeyZ");
    const out: PlayerInput = {
      dir: this.dirStack1P.length > 0 ? this.dirStack1P[this.dirStack1P.length - 1]! : -1,
      placeBomb: this.bombEdge1P || heldBomb,
      useActive: this.activeEdge1P,
      slotUse: this.slotEdge1P,
    };
    this.bombEdge1P = false;
    this.activeEdge1P = false;
    this.slotEdge1P = undefined;
    return out;
  }

  private sampleInput2P(): PlayerInput {
    const heldBomb =
      this.keysDown.has("ShiftRight") || this.keysDown.has("Space") || this.keysDown.has("Slash");
    const out: PlayerInput = {
      dir: this.dirStack2P.length > 0 ? this.dirStack2P[this.dirStack2P.length - 1]! : -1,
      placeBomb: this.bombEdge2P || heldBomb,
      useActive: this.activeEdge2P,
    };
    this.bombEdge2P = false;
    this.activeEdge2P = false;
    return out;
  }

  tick(dtSec: number): void {
    if (this.localSim) {
      this.localAccMs += dtSec * 1000;
      let steps = Math.floor(this.localAccMs / TICK_MS);
      if (steps > 0) {
        this.localAccMs -= steps * TICK_MS;
        steps = Math.min(15, steps);
        for (let s = 0; s < steps; s++) {
          this.localSim.setInput(0, this.sampleInput1P());
          if (this.isDual2P()) {
            this.localSim.setInput(1, this.sampleInput2P());
          }
          for (const p of this.localSim.players) {
            if (p.isAi) {
              this.localSim.setInput(p.slot, computeAiInput(this.localSim, p));
            }
          }
          this.localSim.step();
          const snap = this.localSim.toSnapshot();
          this.ctx.hub.latestSnapshot = snap;
          this.playSnapSounds(snap);
        }
      }
      if (this.localSim.finished) {
        this.finishHoldMs += dtSec * 1000;
      }
      return;
    }

    // Online authoritative match: send inputs whenever changed or edge triggered
    const in1 = this.sampleInput1P();
    const in2 = this.isDual2P() ? this.sampleInput2P() : undefined;
    const h1 = `${in1.dir}:${in1.placeBomb ? 1 : 0}:${in1.useActive ? 1 : 0}:${in1.slotUse ?? -1}`;
    const h2 = in2 ? `${in2.dir}:${in2.placeBomb ? 1 : 0}:${in2.useActive ? 1 : 0}` : "";
    if (
      h1 !== this.lastSentHash1 ||
      h2 !== this.lastSentHash2 ||
      in1.placeBomb ||
      in1.useActive ||
      in2?.placeBomb ||
      in2?.useActive
    ) {
      this.lastSentHash1 = h1;
      this.lastSentHash2 = h2;
      this.ctx.hub.send({ type: "match_input", input: in1, input2P: in2 });
    }
  }

  onMouseMove(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseMove(mx, my)) return;
    this.btExit.onMouseMove(mx, my, this.ctx.sound);
    this.btResultOk.onMouseMove(mx, my, this.ctx.sound);
  }

  onMouseDown(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseDown(mx, my, this.ctx.assets, this.ctx.hub)) return;
    if (this.chatOpen && this.edChat.handleMouseDown(mx, my)) return;
    if (this.btExit.onMouseDown(mx, my)) return;
    if (this.ctx.hub.latestSnapshot?.finished && this.btResultOk.onMouseDown(mx, my)) return;
    // Click-to-use on `Game/GameStageItem` 6-Slot Quick-Item Belt (`(61 + i * 40, 565..598)`)!
    if (!this.isDual2P() && my >= 563 && my <= 599) {
      const rel = mx - 61;
      if (rel >= 0 && rel < 240) {
        const sIdx = Math.floor(rel / 40);
        if (sIdx >= 0 && sIdx < 6) {
          this.slotEdge1P = sIdx;
          this.activeEdge1P = true;
        }
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.btExit.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.ctx.hub.latestSnapshot?.finished && this.btResultOk.onMouseUp(mx, my, this.ctx.sound)) return;
  }

  // ─── Playfield & HUD Rendering ────────────────────────────────────────────

  render(r: SpriteRenderer, nowMs: number): void {
    const snap = this.ctx.hub.latestSnapshot;
    const dual = this.isDual2P();
    const hud = dual && this.hudBg2P ? this.hudBg2P : this.hudBg;
    if (hud) drawSheetFrame(r, hud, 0, 0, 0, { w: 800, h: 600 });
    else r.fillRect(0, 0, 800, 600, [0.06, 0.22, 0.48, 1]);

    if (!snap) {
      r.drawText("正在載入對戰地圖...", 320, 290, {
        align: "center",
        color: [1, 1, 1, 1],
        outlineColor: [0, 0, 0, 0.9],
      });
      this.btExit.render(r);
      return;
    }

    const ox = snap.originX;
    const oy = snap.originY;
    const tick = snap.tick;
    const objTab = this.ctx.assets.objects;
    const mySlot = this.localSim ? 0 : this.ctx.hub.mySlot;
    const myPlayer = snap.players.find((p) => p.slot === mySlot);
    const myTeam = myPlayer?.team ?? 0;
    const myGoggle = snap.players.some(
      (pl) =>
        (pl.slot === mySlot || (dual && pl.slot === (this.localSim ? 1 : this.ctx.hub.slot2P)) || pl.team === myTeam) &&
        (pl.goggleTicks ?? 0) > 0,
    );

    // 1. Ground tile pass (including animated `CGOTileLap` `Start_*` / `LapTile01..04_*` states!)
    const nextKartCp = snap.componentMode === 1 ? ((myPlayer?.kartCheckpoint ?? -1) + 1) : -99;
    const isGoalReady =
      snap.componentMode === 1 &&
      (myPlayer?.kartLap ?? 0) >= (snap.kartTotalLaps ?? 3) &&
      nextKartCp === 0;
    const glitterSlot = (Math.floor(tick / 6) % 3) + 1;
    const bonusBack =
      snap.componentMode === 4
        ? this.cache.getSheet(this.ctx.assets, "Fx", "Bonus/BonusStageBack1", 0)
        : null;

    for (let cy = 0; cy < snap.height; cy++) {
      for (let cx = 0; cx < snap.width; cx++) {
        const cell = snap.cells[cy * snap.width + cx]!;
        if (bonusBack) {
          drawSheetFrame(r, bonusBack, 0, ox + cx * CELL_PX, oy + cy * CELL_PX);
        }
        if (!cell.ground) continue;
        const gObj = objTab.byName.get(cell.ground);
        let act = gObj?.actions.get("Default") ?? gObj?.defaultAction;
        if (snap.componentMode === 1 && cell.lapCp !== undefined && gObj && gObj.actionList.length >= 5) {
          const standingHere =
            myPlayer &&
            Math.floor(myPlayer.px / CELL_PX) === cx &&
            Math.floor(myPlayer.py / CELL_PX) === cy;
          if (cell.lapCp === 0 && gObj.actionList.length >= 10) {
            if (isGoalReady) {
              act = gObj.actionList[standingHere ? 9 : 5 + glitterSlot] ?? act;
            } else if (nextKartCp === 0) {
              act = gObj.actionList[glitterSlot] ?? act;
            } else if (standingHere) {
              act = gObj.actionList[4] ?? act;
            }
          } else if (cell.lapCp === nextKartCp) {
            act = gObj.actionList[glitterSlot] ?? act;
          } else if (cell.lapCp <= (myPlayer?.kartCheckpoint ?? -1)) {
            act = gObj.actionList[4] ?? act;
          }
        }
        if (act) {
          const sh = this.cache.getSheet(this.ctx.assets, "Fx", act.sprite, 0);
          const frame = sampleActionFrame(act, tick, true);
          drawSheetFrame(r, sh, frame, ox + cx * CELL_PX, oy + cy * CELL_PX + 39, {
            anchor: true,
          });
        }

      }
    }

    // Retail draws CBulaComponent dots in a separate pass after the ground,
    // so a neighbouring tile cannot cover a dot crossing its boundary.
    if (snap.componentMode === 2) {
      for (let cy = 0; cy < snap.height; cy++) {
        for (let cx = 0; cx < snap.width; cx++) {
          const dots = snap.cells[cy * snap.width + cx]?.bulaDots;
          if (!dots) continue;
          for (let i = 0; i < dots.length; i++) {
            const owner = dots[i]!;
            if (owner < 0) continue;
            const effect = snap.cells[cy * snap.width + cx]?.bulaDotEffects?.[i];
            const action = owner === 0
              ? objTab.byName.get("Game/Bula")?.actionList[1]
              : objTab.byName.get("Character/Bula")?.actionList[effect ? 2 : 1];
            const sh = action ? this.cache.getSheet(this.ctx.assets, "Fx", action.sprite, owner) : null;
            const frame = action ? sampleActionFrame(action, effect ? tick - effect.startTick : 0, false) : 0;
            if (sh) drawSheetFrame(r, sh, frame,
              ox - 20 + cx * CELL_PX + (i % 3) * 13,
              oy - 20 + cy * CELL_PX + Math.floor(i / 3) * 20, { anchor: true });
          }
        }
      }
    }

    // 1b. Shore footprints (`Game/Footprint00..03`) & `Village00` Warp Portal `Effect/UgWater` geysers
    if (snap.footprints && snap.footprints.length > 0) {
      for (const fp of snap.footprints) {
        const fpObj = objTab.byName.get(`Game/Footprint0${fp.dir}`);
        const fpAct =
          fp.dir === 1 || fp.dir === 3
            ? fpObj?.actionList[fp.alt] ?? fpObj?.defaultAction
            : fpObj?.defaultAction;
        if (fpAct) {
          const sh = this.cache.getSheet(this.ctx.assets, "Fx", fpAct.sprite, 0);
          const alpha = Math.max(0.08, Math.min(0.75, fp.ticksLeft / 66));
          drawSheetFrame(r, sh, sampleActionFrame(fpAct, 66 - fp.ticksLeft, false), ox + fp.px - 20, oy + fp.py, {
            anchor: true,
            tint: [1, 1, 1, alpha],
          });
        }
      }
    }

    if (this.activeMapPortals.length > 0 && snap.componentMode !== 1) {
      const ugObj = objTab.byName.get("Effect/UgWater");
      const anyActivePortal = snap.players.some((p) => p.portalCooldownTicks > 0);
      const ugAct = ugObj?.actionList[anyActivePortal ? 1 : 0] ?? ugObj?.defaultAction;
      if (ugAct) {
        const ugSh = this.cache.getSheet(this.ctx.assets, "Fx", ugAct.sprite, 0);
        const ugFrame = sampleActionFrame(ugAct, tick, true);
        for (const [cA, rA, cB, rB] of this.activeMapPortals) {
          drawSheetFrame(r, ugSh, ugFrame, ox + cA * CELL_PX, oy + rA * CELL_PX + 39, { anchor: true });
          drawSheetFrame(r, ugSh, ugFrame, ox + cB * CELL_PX, oy + rB * CELL_PX + 39, { anchor: true });
        }
      }
    }

    // `CBonusComponent` (`componentMode === 4`) twinkling `Bonus/Star00..04` (`OT[65..69]`)!
    if (snap.componentMode === 4 && !snap.finished) {
      for (let si = 0; si < 8; si++) {
        const starIdx = si % 5;
        const starSh = this.cache.getSheet(this.ctx.assets, "Fx", `Bonus/Star0${starIdx}`, 0);
        if (!starSh || !starSh.sheet || starSh.sheet.rects.length === 0) continue;
        const phase = Math.floor((tick + si * 11) / 4);
        const sf = phase % starSh.sheet.rects.length;
        const scx = ((si * 4 + Math.floor(phase / 6)) % snap.width) * CELL_PX + 14;
        const scy = ((si * 3 + Math.floor(phase / 8)) % snap.height) * CELL_PX + 12;
        drawSheetFrame(r, starSh, sf, ox + scx, oy + scy, { tint: [1, 1, 1, 0.85] });
      }
    }

    // `AIaider/RedZone` (`40x40`) blast danger-zone overlay when enabled via `OptionDlg` or `F6`!
    if (this.ctx.hub.showDangerZone && !snap.finished && snap.bombs.length > 0) {
      const rzSh = this.cache.getSheet(this.ctx.assets, "Fx", "AIaider/RedZone", 0);
      if (rzSh) {
        const danger = new Set<number>();
        const dirs: readonly [number, number][] = [
          [-1, 0],
          [0, -1],
          [1, 0],
          [0, 1],
        ];
        for (const b of snap.bombs) {
          if (b.cx < 0 || b.cx >= snap.width || b.cy < 0 || b.cy >= snap.height) continue;
          danger.add(b.cy * snap.width + b.cx);
          const rng = Math.max(1, b.power);
          for (const [dx, dy] of dirs) {
            for (let step = 1; step <= rng; step++) {
              const nx = b.cx + dx * step;
              const ny = b.cy + dy * step;
              if (nx < 0 || nx >= snap.width || ny < 0 || ny >= snap.height) break;
              const c = snap.cells[ny * snap.width + nx]!;
              if (c.kind === 1) break;
              danger.add(ny * snap.width + nx);
              if (c.kind === 2) break;
            }
          }
        }
        const rzAlpha = 0.42 + 0.24 * Math.abs(Math.sin(tick * 0.28));
        for (const idx of danger) {
          const rx = idx % snap.width;
          const ry = Math.floor(idx / snap.width);
          drawSheetFrame(r, rzSh, 0, ox + rx * CELL_PX, oy + ry * CELL_PX, {
            w: 40,
            h: 40,
            tint: [1, 1, 1, rzAlpha],
          });
        }
      }
    }

    // 2. Build Y-sorted drawables list (`sortY` = bottom pixel in playfield space)
    interface Drawable {
      sortY: number;
      prio: number;
      draw: () => void;
    }
    const drawList: Drawable[] = [];

    // 2a. Flames (`Flame/Flame` & `Flame/FlameBlind` -> `Bomb/FireBlind`)
    const flameObj = objTab.byName.get("Flame/Flame");
    const flameBlindObj = objTab.byName.get("Flame/FlameBlind");
    for (const fl of snap.flames) {
      const elapsed = Math.max(0, FLAME_TICKS - fl.ticksLeft);
      let actName = "00 FireC01";
      if (fl.part === "LE") actName = "10 FireL01";
      else if (fl.part === "L") actName = "11 FireL02";
      else if (fl.part === "UE") actName = "20 FireU01";
      else if (fl.part === "U") actName = "21 FireU02";
      else if (fl.part === "RE") actName = "30 FireR01";
      else if (fl.part === "R") actName = "31 FireR02";
      else if (fl.part === "DE") actName = "40 FireD01";
      else if (fl.part === "D") actName = "41 FireD02";
      const obj = fl.blind && flameBlindObj ? flameBlindObj : flameObj;
      const act = obj?.actions.get(actName);
      const frame = act ? sampleActionFrame(act, elapsed, false) : 0;
      const fx = ox + fl.cx * CELL_PX;
      const fy = oy + fl.cy * CELL_PX + 39;
      const isBlind = Boolean(fl.blind);
      drawList.push({
        sortY: fl.cy * CELL_PX + 36,
        prio: 1,
        draw: () => {
          if (isBlind) {
            const blindSheet = this.cache.getSheet(this.ctx.assets, "Fx", "Bomb/FireBlind", 0);
            if (blindSheet) {
              drawSheetFrame(r, blindSheet, frame, fx, fy, {
                anchor: true,
                tint: [1, 1, 1, fl.ownerSlot === mySlot ? 0.72 : 0.2],
              });
              return;
            }
          }
          drawSheetFrame(r, this.fireSheet, frame, fx, fy, { anchor: true });
        },
      });
    }

    // 2b. Ground items (hidden under un-burned bush unless Goggle active)
    for (const it of snap.items) {
      const cell = snap.cells[it.cy * snap.width + it.cx];
      if (cell?.hides && !myGoggle) continue;
      const itemBushAlpha = cell?.hides ? 0.72 : 1.0;
      const sh = this.cache.getSheet(this.ctx.assets, "Fx", it.iconSprite, 0);
      const bob = Math.round(Math.sin((tick - it.spawnTick) * 0.22) * 3);
      const ix = ox + it.cx * CELL_PX;
      const iy = oy + it.cy * CELL_PX + 39;
      drawList.push({
        sortY: it.cy * CELL_PX + 37,
        prio: 2,
        draw: () => {
          if (this.shadowSheet) {
            // `Shadow/Shadow` frame 6 (`28x14, px=-4, py=11`) centered at `(ix, iy)`
            drawSheetFrame(r, this.shadowSheet, 6, ix, iy, {
              anchor: true,
              tint: [1, 1, 1, 0.55 * itemBushAlpha],
            });
          }
          if (sh && sh.sheet && sh.sheet.rects.length > 0) {
            const f = Math.floor((tick - it.spawnTick) / 5) % sh.sheet.rects.length;
            drawSheetFrame(r, sh, f, ix, iy + bob, { anchor: true, tint: [1, 1, 1, itemBushAlpha] });
          }
        },
      });
    }

    // 2c. Stationary / sliding / thrown Water Balloons (`Bomb/Bomb`: `0 Default`, `1 Remote`, `2 Blind`)
    const bombObj = objTab.byName.get("Bomb/Bomb");
    const bombAct = bombObj?.defaultAction;
    for (const bm of snap.bombs) {
      const cell = snap.cells[bm.cy * snap.width + bm.cx];
      if (cell?.hides && bm.thrownTicks <= 0 && !myGoggle) continue;
      const owner = snap.players.find((pl) => pl.slot === bm.ownerSlot);
      const isFriendlyBomb =
        bm.ownerSlot === mySlot ||
        (dual && bm.ownerSlot === (this.localSim ? 1 : this.ctx.hub.slot2P)) ||
        owner?.team === myTeam;
      // Enemy `Bomb/BombBlind` stealth balloons turn invisible once planted unless local player has `Goggle`!
      if (bm.style === "blind" && !isFriendlyBomb && !myGoggle && bm.thrownTicks <= 0 && bm.fuseTicks < 80) {
        continue;
      }
      const bombAlpha = cell?.hides && bm.thrownTicks <= 0 ? 0.72 : bm.style === "blind" && !myGoggle ? 0.62 : 1.0;
      let bx = ox + bm.px - 20;
      let by = oy + bm.py + 19;
      let arcLift = 0;
      if (bm.thrownTicks > 0 && bm.thrownTotalTicks > 0) {
        const prog = 1 - bm.thrownTicks / bm.thrownTotalTicks;
        const destX = bm.throwDestCx * CELL_PX + 20;
        const destY = bm.throwDestCy * CELL_PX + 20;
        const curX = bm.throwStartX + (destX - bm.throwStartX) * prog;
        const curY = bm.throwStartY + (destY - bm.throwStartY) * prog;
        arcLift = Math.sin(prog * Math.PI) * 38;
        bx = ox + curX - 20;
        by = oy + curY + 19;
      }
      const bombSkinId = owner?.bombSkinCode ?? 0;
      const styleAct =
        bm.style === "remote"
          ? bombObj?.actions.get("1 Remote")
          : bm.style === "blind"
            ? bombObj?.actions.get("2 Blind")
            : bombAct;
      const frame = (styleAct ?? bombAct)
        ? sampleActionFrame((styleAct ?? bombAct)!, tick, true)
        : Math.floor(tick / 6) % 4;
      drawList.push({
        sortY: bm.py + 19,
        prio: 3,
        draw: () => {
          if (this.shadowSheet) {
            drawSheetFrame(r, this.shadowSheet, 0, bx, by, {
              anchor: true,
              tint: [1, 1, 1, (arcLift > 1 ? 0.5 : 0.62) * bombAlpha],
            });
          }
          // Special functional bombs (`Remote`, `Blind`, `HollowBomb`) display their tactical sprite clearly
          if (bm.style === "remote" || bm.style === "blind") {
            const spPath = bm.style === "remote" ? "Bomb/BombRadio" : "Bomb/BombBlind";
            const spSh = this.cache.getSheet(this.ctx.assets, "Fx", spPath, 0);
            if (spSh) {
              drawSheetFrame(r, spSh, frame, bx, by - arcLift, {
                anchor: true,
                tint: [1, 1, 1, bombAlpha],
              });
              return;
            }
          }
          if (bm.pierce) {
            const hbSh = this.cache.getSheet(this.ctx.assets, "Fx", "Item/HollowBomb", 0);
            if (hbSh && hbSh.sheet && hbSh.sheet.rects.length > 0) {
              const f = Math.floor(tick / 6) % hbSh.sheet.rects.length;
              drawSheetFrame(r, hbSh, f, bx, by - arcLift, { anchor: true });
              return;
            }
          }
          if (
            !bombSkinId ||
            !this.cache.drawBombSkinForStock(r, this.ctx.assets, bombSkinId, bx, by - arcLift, tick)
          ) {
            drawSheetFrame(r, this.bombSheet, frame, bx, by - arcLift, { anchor: true });
          }
        },
      });
    }

    // 2c2. Planted ground hazards (`Item/BananaGround`, `Item/TrapGround`, `Item/BondGround`, `Item/PushpinGround`) & flying darts
    const trapGroundObj = objTab.byName.get("Item/TrapGround");
    const bondGroundObj = objTab.byName.get("Item/BondGround");
    for (const hz of snap.hazards ?? []) {
      const cell = snap.cells[hz.cy * snap.width + hz.cx];
      if (cell?.hides) continue;
      const hx = ox + hz.cx * CELL_PX;
      const hy = oy + hz.cy * CELL_PX + 39;
      drawList.push({
        sortY: hz.cy * CELL_PX + 36,
        prio: 2,
        draw: () => {
          if (hz.kind === "banana") {
            const sh = this.cache.getSheet(this.ctx.assets, "Fx", "Item/BananaGround", 0);
            drawSheetFrame(r, sh, 0, hx, hy, { anchor: true });
          } else if (hz.kind === "gum") {
            const act = bondGroundObj?.defaultAction;
            const sh = this.cache.getSheet(this.ctx.assets, "Fx", "Item/BondGround", 0);
            const f = act ? sampleActionFrame(act, tick, true) : Math.floor(tick / 6) % 5;
            drawSheetFrame(r, sh, f, hx, hy, { anchor: true });
          } else if (hz.kind === "pin") {
            const sh = this.cache.getSheet(this.ctx.assets, "Fx", "Item/PushpinGround", 0);
            drawSheetFrame(r, sh, 0, hx, hy, { anchor: true });
          } else {
            const act = trapGroundObj?.actions.get("0 Horizontal") ?? trapGroundObj?.defaultAction;
            if (act) {
              const sh = this.cache.getSheet(this.ctx.assets, "Fx", act.sprite, 0);
              const f = sampleActionFrame(act, tick, true);
              drawSheetFrame(r, sh, f, hx, hy, { anchor: true });
            }
          }
        },
      });
    }

    const dartObj = objTab.byName.get("Item/ThrownDart");
    for (const dt of snap.darts ?? []) {
      const actKey = `${dt.dir} ${DIR_WORDS[dt.dir] ?? "Down"}`;
      const act = dartObj?.actions.get(actKey) ?? dartObj?.defaultAction;
      if (!act) continue;
      const sh = this.cache.getSheet(this.ctx.assets, "Fx", act.sprite, 0);
      const f = sampleActionFrame(act, tick, true);
      const dx = ox + dt.px - 20;
      const dy = oy + dt.py + 19;
      drawList.push({
        sortY: dt.py + 21,
        prio: 6,
        draw: () => drawSheetFrame(r, sh, f, dx, dy, { anchor: true }),
      });
    }

    // 2d. Static blocks, multi-HP boxes (`StrongBox01/02`), crumbling boxes, and bushes/roofs (`CGOTile*`)
    for (let cy = 0; cy < snap.height; cy++) {
      for (let cx = 0; cx < snap.width; cx++) {
        const cell = snap.cells[cy * snap.width + cx]!;
        if (!cell.block) continue;
        const bObj = objTab.byName.get(cell.block);
        if (!bObj) continue;

        const bx = ox + cx * CELL_PX;
        const by = oy + cy * CELL_PX + 39;

        // `CBulaComponent`: captured `Bf*` treasure vault transforms into team-colored `Character/remain_aft01..04`!
        if (cell.bulaHouseTeam !== undefined && cell.bulaHouseTeam >= 0) {
          const teamOne = (cell.bulaHouseTeam % 8) + 1;
          const vIdx = cell.bulaHouseVar ?? 0;
          const aftAction = objTab.byName.get(`Tile15_Static/Aft${String(vIdx).padStart(2, "0")}`)?.defaultAction;
          const aftSheet = aftAction ? this.cache.getSheet(this.ctx.assets, "Fx", aftAction.sprite, teamOne) : null;
          if (aftSheet && aftAction) {
            const af = sampleActionFrame(aftAction, tick, true);
            drawList.push({
              sortY: cy * CELL_PX + 39,
              prio: 4,
              draw: () => drawSheetFrame(r, aftSheet, af, bx, by, { anchor: true }),
            });
            continue;
          }
        }

        if (cell.crumble > 0) {
          const brk =
            bObj.actions.get("Broken") ?? bObj.actions.get("broken") ?? bObj.defaultAction;
          if (brk) {
            const elapsed = Math.max(0, BOX_CRUMBLE_TICKS - cell.crumble);
            const scaled = Math.floor((elapsed * Math.max(1, brk.totalTicks)) / BOX_CRUMBLE_TICKS);
            const sh = this.cache.getSheet(this.ctx.assets, "Fx", brk.sprite, 0);
            const frame = sampleActionFrame(brk, scaled, false);
            drawList.push({
              sortY: cy * CELL_PX + 39,
              prio: 4,
              draw: () => drawSheetFrame(r, sh, frame, bx, by, { anchor: true }),
            });
          }
          continue;
        }

        // Retail `CGOTileFixedBox` / `CGOTileMovableBox` multi-HP dent & shake state (`0x0041E5A3..0x0041EA4E`)
        let act =
          bObj.actions.get("Default") ??
          bObj.actions.get("Default01") ??
          bObj.actions.get("default") ??
          bObj.defaultAction;
        let loopAct = true;
        let animTick = tick;
        if (cell.kind === 2 && cell.maxHp > 1) {
          const hitsTaken = Math.max(0, Math.min(cell.maxHp - 1, cell.maxHp - cell.hp));
          if (cell.shake > 0 && hitsTaken >= 1) {
            const shkName = `Default0${hitsTaken}_Shaken`;
            const shkAct = bObj.actions.get(shkName);
            if (shkAct) {
              act = shkAct;
              loopAct = false;
              animTick = Math.max(0, 14 - cell.shake);
            }
          } else if (hitsTaken >= 1) {
            const dentName = `Default0${hitsTaken + 1}`;
            act = bObj.actions.get(dentName) ?? act;
          }
        } else if (cell.kind === 3 && (bObj.actions.has("ShakenHorz") || bObj.actions.has("ShakenVert"))) {
          // Retail `CGOTilePassable` (`kind === 3`): rustles with `ShakenHorz` / `ShakenVert` when walked through!
          const mover = snap.players.find(
            (pl) =>
              pl.state !== "dead" &&
              pl.moving &&
              Math.floor(pl.px / CELL_PX) === cx &&
              Math.floor(pl.py / CELL_PX) === cy,
          );
          if (mover) {
            const rustleKey = mover.facing === 0 || mover.facing === 2 ? "ShakenHorz" : "ShakenVert";
            act = bObj.actions.get(rustleKey) ?? act;
          }
        }
        if (!act) continue;
        const sh = this.cache.getSheet(this.ctx.assets, "Fx", act.sprite, 0);
        const frame = sampleActionFrame(act, animTick, loopAct);

        // If ally/local player is inside this bush, draw translucent so player can see themselves!
        const allyInside =
          cell.hides &&
          snap.players.some(
            (p) =>
              p.state !== "dead" &&
              (p.slot === mySlot || (dual && p.slot === 1) || p.team === myTeam) &&
              Math.floor(p.px / CELL_PX) === cx &&
              Math.floor(p.py / CELL_PX) === cy,
          );

        const localRadar =
          Boolean(cell.dropIcon) &&
          cell.kind === 2 &&
          snap.players.some(
            (p) =>
              p.radarTicks > 0 &&
              (p.slot === mySlot || (dual && p.slot === (this.localSim ? 1 : this.ctx.hub.slot2P)) || p.team === myTeam),
          );
        const dropIconSheet =
          localRadar && cell.dropIcon
            ? this.cache.getSheet(this.ctx.assets, "Fx", cell.dropIcon, 0)
            : null;

        drawList.push({
          sortY: cy * CELL_PX + (cell.hides ? 42 : 39),
          prio: cell.hides ? 7 : 4,
          draw: () => {
            drawSheetFrame(r, sh, frame, bx, by, {
              anchor: true,
              tint: allyInside ? [1, 1, 1, 0.42] : undefined,
            });
            if (dropIconSheet) {
              const pulse = 0.48 + 0.18 * Math.sin(tick * 0.25);
              drawSheetFrame(r, dropIconSheet, 0, bx + 6, by - 34, {
                w: 28,
                h: 28,
                tint: [0.85, 1, 1, pulse],
              });
            }
          },
        });
      }
    }

    // 2e. Sliding push-boxes
    for (const pb of snap.pushBoxes) {
      const bObj = objTab.byName.get(pb.objName);
      const hitsTaken = pb.maxHp > 1 ? Math.max(0, Math.min(pb.maxHp - 1, pb.maxHp - pb.hp)) : 0;
      const act =
        (hitsTaken >= 1 ? bObj?.actions.get(`Default0${hitsTaken + 1}`) : undefined) ??
        bObj?.actions.get("Default") ??
        bObj?.actions.get("Default01") ??
        bObj?.actions.get("default") ??
        bObj?.defaultAction;
      if (!act) continue;
      const prog = 1 - pb.ticksLeft / Math.max(1, pb.totalTicks);
      const wx = (pb.fromCx + (pb.toCx - pb.fromCx) * prog) * CELL_PX;
      const wy = (pb.fromCy + (pb.toCy - pb.fromCy) * prog) * CELL_PX;
      const sh = this.cache.getSheet(this.ctx.assets, "Fx", act.sprite, 0);
      drawList.push({
        sortY: wy + 39,
        prio: 4,
        draw: () => drawSheetFrame(r, sh, 0, ox + wx, oy + wy + 39, { anchor: true }),
      });
    }

    // Track rescue (`trapped -> alive`) & match banner onset ticks
    if (snap.hurryUp && this.hurryStartTick < 0) this.hurryStartTick = tick;
    if (snap.finished && this.finishStartTick < 0) this.finishStartTick = tick;
    if (!snap.finished) this.finishStartTick = -1;

    // 2f. Bula Souls (`CGOInnerSoul` -> `Game/Mummy`, `CGOOuterSoul` -> `Game/BulaBat`)
    if (snap.souls && snap.souls.length > 0) {
      for (const s of snap.souls) {
        const sObj = objTab.byName.get(s.kind === "InnerSoul" ? "Game/Mummy" : "Game/BulaBat");
        if (!sObj) continue;
        let actIdx = 2 + s.dir;
        let animT = tick;
        let loopS = true;
        if (s.state === "spawn") {
          actIdx = 0;
          animT = s.stateTicks;
          loopS = false;
        } else if (s.state === "dying") {
          actIdx = s.kind === "InnerSoul" && s.angry ? 14 : 1;
          animT = s.stateTicks;
          loopS = false;
        } else if (s.kind === "InnerSoul" && s.angry) {
          actIdx = 10 + s.dir;
        }
        const sAct = sObj.actionList[actIdx] ?? sObj.defaultAction;
        if (!sAct) continue;
        const sx = ox + s.px - 20;
        const sy = oy + s.py + 19;
        drawList.push({
          sortY: s.py + 20,
          prio: 5,
          draw: () => {
            if (this.shadowSheet && s.state !== "dying") {
              drawSheetFrame(r, this.shadowSheet, 0, sx, sy, { anchor: true });
            }
            const sh = this.cache.getSheet(this.ctx.assets, "Fx", sAct.sprite, 0);
            const frame = sampleActionFrame(sAct, animT, loopS);
            drawSheetFrame(r, sh, frame, sx, sy, { anchor: true });
          },
        });
      }
    }

    // 2f2. `CGOGhost` (`Game/Ghost`, `CA.exe.c` `0x00414500..0x00414F80`): Hurry-Up Stalker Ghost!
    if (snap.ghost) {
      const gh = snap.ghost;
      const gObj = objTab.byName.get("Game/Ghost");
      if (gObj) {
        let actIdx = 5 + gh.dir;
        let animT = tick;
        let loopG = true;
        if (gh.state === "in") {
          actIdx = 0;
          animT = gh.stateTicks;
          loopG = false;
        } else if (gh.state === "stun") {
          actIdx = 1 + gh.dir;
          animT = gh.stateTicks;
        } else if (gh.state === "trans") {
          actIdx = 9 + gh.dir;
          animT = gh.stateTicks;
          loopG = false;
        } else if (gh.state === "rush") {
          actIdx = 13 + gh.dir;
          animT = tick;
        }
        const gAct = gObj.actionList[actIdx] ?? gObj.defaultAction;
        if (gAct) {
          const gx = ox + gh.px - 20;
          const gy = oy + gh.py + 19;
          const gAlpha = gh.state === "stun" && Math.floor(tick / 2) % 2 === 0 ? 0.62 : 0.92;
          drawList.push({
            sortY: gh.py + 21,
            prio: 5,
            draw: () => {
              if (this.shadowSheet) {
                drawSheetFrame(r, this.shadowSheet, 0, gx, gy, { anchor: true });
              }
              const sh = this.cache.getSheet(this.ctx.assets, "Fx", gAct.sprite, 0);
              const frame = sampleActionFrame(gAct, animT, loopG);
              drawSheetFrame(r, sh, frame, gx, gy, { anchor: true, tint: [1, 1, 1, gAlpha] });
            },
          });
        }
      }
    }

    // 2g. Players (`CGOBomber`) & `CSurvivalComponent` (`Game/Kill_RevivePoint`) respawn beams!
    for (const p of snap.players) {
      const prev = this.prevStates.get(p.slot);
      if (prev === "trapped" && p.state === "alive") {
        this.releaseStartTick.set(p.slot, tick);
      }
      this.prevStates.set(p.slot, p.state);

      // Mode 4 (`CSurvivalComponent` 生死戰): glowing revival beam (`Game/Kill_RevivePoint`) on `(reviveCx, reviveCy)`!
      if (
        snap.mode === 4 &&
        p.state === "dead" &&
        !p.noRevive &&
        p.stateTicks >= 28 &&
        p.reviveCx !== undefined &&
        p.reviveCy !== undefined
      ) {
        const revSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_RevivePoint", 0);
        if (revSh && revSh.sheet && revSh.sheet.rects.length > 0) {
          const rx = ox + p.reviveCx * CELL_PX;
          const ry = oy + p.reviveCy * CELL_PX + 39;
          const rf = Math.floor(tick / 3) % revSh.sheet.rects.length;
          drawList.push({
            sortY: p.reviveCy * CELL_PX + 38,
            prio: 5,
            draw: () => drawSheetFrame(r, revSh, rf, rx, ry, { anchor: true }),
          });
        }
      }

      // Keep rendering the rising angel soul (`01 Die` ticks `28..91`) AND floating Ghost (`stateTicks >= 64`)!
      const soulAlive = p.state === "dead" && p.stateTicks < 64;
      const ghostAlive =
        p.state === "dead" &&
        p.stateTicks >= 64 &&
        !snap.finished &&
        (snap.mode !== 4 || Boolean(p.noRevive)) &&
        snap.players.length >= 2;
      if (p.state === "dead" && !soulAlive && !ghostAlive) continue;

      const pCx = Math.floor(p.px / CELL_PX);
      const pCy = Math.floor(p.py / CELL_PX);
      const inBush = snap.cells[pCy * snap.width + pCx]?.hides;
      const isAlly =
        p.slot === mySlot ||
        (dual && p.slot === (this.localSim ? 1 : this.ctx.hub.slot2P)) ||
        p.team === myTeam;
      if (inBush && !isAlly && !myGoggle && p.state !== "trapped" && p.state !== "dying" && !soulAlive && !ghostAlive) {
        // Enemy hidden inside bush unless local player has `Goggle` (`Item/Swimming`)!
        continue;
      }
      if ((p.camoTicks ?? 0) > 0 && p.state === "alive" && !isAlly && !myGoggle) {
        // `Camouflage` (`Item/Mask`, `eff=19`) stealth invisibility unless within 56px of local player!
        const nearLocal =
          myPlayer &&
          (myPlayer.px - p.px) * (myPlayer.px - p.px) + (myPlayer.py - p.py) * (myPlayer.py - p.py) <= 56 * 56;
        if (!nearLocal) continue;
      }

      const drawX = ox + p.px - 20;
      const drawY = oy + p.py + 19;
      const teamOneBased = (p.team % 8) + 1;

      // Update & render `CGOCharDecoratorFollower` (`0x004156FF`, `CharDeco_E*` trailing pet companion)!
      const decoStocks =
        p.charDecoCodes && p.charDecoCodes.length > 0 ? p.charDecoCodes : p.hatCode ? [p.hatCode] : [];
      if (decoStocks.length > 0 && p.state === "alive") {
        let trail = this.followerTrails.get(p.slot);
        if (!trail) {
          trail = [];
          this.followerTrails.set(p.slot, trail);
        }
        const lastPt = trail[trail.length - 1];
        if (!lastPt || lastPt.tick !== tick) {
          if (!lastPt || Math.abs(lastPt.x - drawX) + Math.abs(lastPt.y - drawY) >= 2) {
            trail.push({ x: drawX, y: drawY, dir: p.facing, tick });
            if (trail.length > 11) trail.shift();
          }
        }
        const petPt = trail[0] ?? { x: drawX - 18, y: drawY, dir: p.facing, tick };
        const petAx = petPt.x + 20;
        const petFootY = petPt.y;
        const petAlpha = (p.camoTicks ?? 0) > 0 ? 0.45 : inBush && !isAlly ? 0.72 : 1.0;
        drawList.push({
          sortY: petFootY - ox + (p.py + 20 - drawY) - 1,
          prio: 4,
          draw: () =>
            this.cache.drawCharDecoForStocks(
              r,
              this.ctx.assets,
              decoStocks,
              "follower",
              petPt.dir,
              petAx,
              petFootY,
              tick,
              teamOneBased,
              petAlpha,
            ),
        });
      }

      drawList.push({
        sortY: p.py + 20,
        prio: 5,
        draw: () =>
          this.drawPlayer(r, snap, p, drawX, drawY, teamOneBased, tick, nowMs, mySlot, dual),
      });
    }

    drawList.sort((a, b) => (a.sortY !== b.sortY ? a.sortY - b.sortY : a.prio - b.prio));
    for (const item of drawList) item.draw();

    // 2g2. `CGOCoinEffect` (`Game/CoinEffImg` + `Item/CoinGold` parabolic `+Lucci` / `-Lucci` popups, `CA.exe.c:3331`)!
    if (snap.coinPopups && snap.coinPopups.length > 0) {
      const coinEff = this.cache.getSheet(this.ctx.assets, "Fx", "Game/CoinEffImg", 0);
      const coinSp = this.cache.getSheet(this.ctx.assets, "Fx", "Item/CoinGold", 0);
      for (const cp of snap.coinPopups) {
        const elapsed = Math.max(0, 25 - cp.ticksLeft);
        const arcDy = Math.round(2 * (4 - elapsed / 2) * (4 - elapsed / 2) - 67);
        const cxPx = ox + cp.px - 10;
        const cyPx = oy + cp.py + arcDy + 18;
        const alpha = cp.ticksLeft < 7 ? cp.ticksLeft / 7 : 1;
        const isNeg = cp.amount < 0;
        if (coinSp && !isNeg) {
          drawSheetFrame(r, coinSp, 0, cxPx - 16, cyPx - 4, { anchor: false, tint: [1, 1, 1, alpha] });
        }
        if (coinEff && coinEff.sheet && coinEff.sheet.rects.length >= 22) {
          // `[21]` = `+` sign, `[10]` = `-` sign; `[0..9]` = gold digits, `[11..20]` = penalty digits!
          drawSheetFrame(r, coinEff, isNeg ? 10 : 21, cxPx, cyPx, { anchor: false, tint: [1, 1, 1, alpha] });
          const digits = String(Math.max(1, Math.abs(Math.round(cp.amount))));
          const digitBase = isNeg ? 11 : 0;
          for (let di = 0; di < digits.length; di++) {
            const dVal = Number(digits[di]!) % 10;
            drawSheetFrame(r, coinEff, digitBase + dVal, cxPx + 11 + di * 11, cyPx, {
              anchor: false,
              tint: [1, 1, 1, alpha],
            });
          }
        }
      }
    }

    // 2g3. Mode 4 (`CSurvivalComponent`) Hurry-Up `Game/Kill_ImageNo-Revive` alert (`(275, 201)`, `CA.exe.c:147537`)!
    if (
      snap.mode === 4 &&
      snap.hurryUp &&
      !snap.finished &&
      this.hurryStartTick >= 0 &&
      tick - this.hurryStartTick >= 58 &&
      tick - this.hurryStartTick < 116
    ) {
      const noRev = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_ImageNo-Revive", 0);
      if (noRev && noRev.sheet && noRev.sheet.rects.length > 0) {
        const nf = Math.min(
          noRev.sheet.rects.length - 1,
          Math.floor(((tick - this.hurryStartTick - 58) * noRev.sheet.rects.length) / 58),
        );
        drawSheetFrame(r, noRev, nf, 275, 201, { anchor: false });
      }
    }

    // 2h. Sky layer: `CGOItemBird` (`Game/AirPlane1`) supply drop & `CGOBatGroup` (`Game/Bat`) flock!
    if (snap.airplane) {
      const apObj = objTab.byName.get("Game/AirPlane1");
      const apAct = apObj?.defaultAction;
      if (apAct) {
        if (this.shadowSheet) {
          drawSheetFrame(r, this.shadowSheet, 0, ox + snap.airplane.px - 20, oy + snap.airplane.py + 19, {
            anchor: true,
            tint: [1, 1, 1, 0.55],
          });
        }
        const apSh = this.cache.getSheet(this.ctx.assets, "Fx", apAct.sprite, 0);
        const apF = sampleActionFrame(apAct, tick, true);
        drawSheetFrame(r, apSh, apF, ox + snap.airplane.px - 60, oy + snap.airplane.py - 28, {
          anchor: true,
        });
      }
    }
    if (snap.batSwarmTick !== undefined && tick >= snap.batSwarmTick && tick - snap.batSwarmTick < 96) {
      const batObj = objTab.byName.get("Game/Bat");
      const batAct = batObj?.defaultAction;
      if (batAct) {
        const batSh = this.cache.getSheet(this.ctx.assets, "Fx", batAct.sprite, 0);
        const dt = tick - snap.batSwarmTick;
        const offsets: [number, number][] = [
          [0, 0],
          [28, -18],
          [-22, -26],
          [52, 8],
          [16, 24],
          [44, -36],
        ];
        offsets.forEach(([bxOff, byOff], bi) => {
          const bx = ox + snap.width * CELL_PX + 40 - dt * 7.5 + bxOff;
          const by = oy + 60 + dt * 3.8 + byOff + Math.sin((tick + bi * 5) * 0.35) * 6;
          const bf = sampleActionFrame(batAct, tick + bi * 2, true);
          drawSheetFrame(r, batSh, bf, bx, by, { anchor: true });
        });
      }
    }

    // 3. Retail `CGOStartGlyph` / `CGOBonusGlyph` / `CGOHurryUpGlyph` / `CGOWinGlyph` / `CGOLoseGlyph` / `CGODrawGlyph`
    //    (`CA.exe` `.data` `0x612838..0x6128EC`, `sub_403E6C`, `sub_403F27`, `sub_405363`)
    if (tick < START_BANNER_TICKS) {
      if (/^bonus/i.test(snap.mapName) && this.bannerBonus) {
        this.drawBonusGlyphs(r, ox, oy, tick);
      } else if (this.bannerStart) {
        this.drawStartGlyphs(r, ox, oy, tick);
      }
    }
    if (!snap.finished && tick >= 12 && tick < 116) {
      this.drawMissionBanner(r, snap, myPlayer, tick);
    }
    if (
      tick >= START_BANNER_TICKS &&
      (snap.hurryUp || this.kartFastPlayed) &&
      !snap.finished &&
      this.hurryStartTick >= 0 &&
      tick - this.hurryStartTick < 58 &&
      this.bannerHurry
    ) {
      this.drawHurryGlyphs(r, ox, oy, tick - this.hurryStartTick);
    } else if (snap.finished) {
      const finElapsed = this.finishStartTick >= 0 ? Math.max(0, tick - this.finishStartTick) : 60;
      const p2Slot = dual ? (this.localSim ? 1 : this.ctx.hub.slot2P) : -1;
      const won1P = snap.winnerSlots.includes(mySlot);
      const won2P = dual && p2Slot >= 0 && snap.winnerSlots.includes(p2Slot);
      const won = won1P || won2P;
      const banner =
        snap.winnerTeam < 0
          ? this.bannerDraw
          : won
            ? snap.perfectWin && this.bannerPerfect
              ? this.bannerPerfect
              : this.bannerWin
            : this.bannerLose;
      if (banner) this.drawEndGlyphs(r, banner, ox, oy, finElapsed);
      if (dual && snap.winnerTeam >= 0 && (won1P !== won2P)) {
        const plSheet = won1P ? this.bannerPlayer01 : this.bannerPlayer02;
        if (plSheet && finElapsed >= 4) {
          const steps = Math.min(2, finElapsed - 4);
          drawSheetFrame(r, plSheet, 0, ox + 216, oy + 43 - 160 + steps * 80, { anchor: true });
        }
      }
      this.drawResultBoard(r, snap, finElapsed);
    }

    // 4. Right-hand HUD (`Timer`, `8 Player Portraits`, `ItemBox00`, `BtExit`)
    this.drawHud(r, snap, mySlot);

    // 5. In-game chat MsgView `(25, 463, 442, 66)` & Edit `(25, 539, 438, 12)`
    this.chatView.syncChatLog(r, this.ctx.hub.chatLog, true);
    this.chatView.render(r, 0, 0, true);
    if (this.chatOpen) {
      this.edChat.render(r, nowMs);
    }
  }

  private drawPlayer(
    r: SpriteRenderer,
    snap: SimSnapshot,
    p: SimPlayer,
    ax: number,
    ay: number,
    team: number,
    tick: number,
    nowMs: number,
    mySlot: number,
    dual: boolean,
  ): void {
    const isSoulOnly = p.state === "dead" && p.stateTicks < 64;
    const isGhost = p.state === "dead" && p.stateTicks >= 64;

    // Ground shadow: `CGOExtensionShadow` (`Fx:"ExtensionShadow/GourdBottleEffect "`, `128/255` alpha)
    // for Super Characters (`charIdx >= 8`) or `G` aura, else `Shadow/Shadow[0]`.
    if (!isSoulOnly && !isGhost) {
      const rSlotExt = this.ctx.hub.currentRoom?.slots[p.slot];
      const isLocalExt = p.slot === mySlot && !p.isAi;
      const extStocks: Array<number | undefined> = [
        p.hatCode,
        ...(p.charDecoCodes ?? []),
        ...(rSlotExt?.charDecoStockIds ?? []),
        ...(isLocalExt ? (this.ctx.hub.profile?.equipped.charDecoStockIds ?? []) : []),
      ];
      if (
        p.state === "alive" &&
        p.jumpTicks === 0 &&
        this.cache.hasExtensionShadow(this.ctx.assets, p.charCode, extStocks)
      ) {
        this.cache.drawExtensionShadow(r, this.ctx.assets, ax, ay, tick, 128 / 255);
      } else if (this.shadowSheet) {
        drawSheetFrame(r, this.shadowSheet, 0, ax, ay, { anchor: true });
      }
    }

    const dirWord = DIR_WORDS[p.facing] ?? "Down";
    const jumpArcLift =
      p.jumpTicks > 0 ? Math.sin((1 - p.jumpTicks / 14) * Math.PI) * 30 : 0;
    const bodyY = ay - jumpArcLift;

    // Helper to draw Mount (`CGOShip`: `sub_40B001` under rider vs `sub_40AFDD` over rider for `Airship`)
    const drawMount = () => {
      if (p.rideId <= 0 || p.state !== "alive") return;
      const rName =
        this.ctx.assets.tables?.itemAttr.ships.get(p.rideId)?.objectName ??
        RIDE_OBJECTS[p.rideId] ??
        "Ship/Owl";

      // Retail `CGOKartSand` (`OT[93] Game/KartSand` -> `Game/KartSand_*00`) dust behind off-road Karts!
      if ((p.rideId === 9 || p.rideId === 10) && p.moving && (snap.componentMode !== 1 || p.offRoadSand)) {
        const ksObj = this.ctx.assets.objects.byName.get("Game/KartSand");
        const ksAct = ksObj?.actions.get(`0${p.facing} ${dirWord}`) ?? ksObj?.defaultAction;
        const ksSh = this.cache.getSheet(
          this.ctx.assets,
          "Fx",
          ksAct?.sprite ?? `Game/KartSand_${dirWord}00`,
          0,
        );
        if (ksSh && ksSh.sheet && ksSh.sheet.rects.length > 0) {
          const ksF = ksAct
            ? sampleActionFrame(ksAct, tick, true)
            : Math.floor(tick / 3) % ksSh.sheet.rects.length;
          drawSheetFrame(r, ksSh, ksF, ax, bodyY, { anchor: true, tint: [1, 1, 1, 0.88] });
        }
      }

      const rObj = this.ctx.assets.objects.byName.get(rName);
      let rActKey = `0${(p.moving ? 0 : 4) + p.facing} ${p.moving ? "Move" : "Stop"} ${dirWord}`;
      if (rName === "Ship/Kart" && p.boostTicks > 0 && p.moving) {
        rActKey = `${String(8 + p.facing).padStart(2, "0")} Boost ${dirWord}`;
      } else if (rName === "Ship/Tank" && p.shootTicks > 0) {
        rActKey = `${String(8 + p.facing).padStart(2, "0")} Shoot ${dirWord}`;
      }
      const rAct = rObj?.actions.get(rActKey) ?? rObj?.defaultAction;
      if (rAct) {
        const sh = this.cache.getSheet(this.ctx.assets, "Fx", rAct.sprite, 0);
        const f =
          rName === "Ship/Tank" && p.shootTicks > 0
            ? sampleActionFrame(rAct, 12 - p.shootTicks, false)
            : sampleActionFrame(rAct, p.walkTicks, true);
        drawSheetFrame(r, sh, f, ax, bodyY, { anchor: true });
      }
    };

    if (!p.rideFly) drawMount();

    // Character sprite (`Character/C00_A`..`C10_A`, including multi-part `C06` & `C10`)
    const cCode = `C${String(Math.max(0, Math.min(10, p.charCode))).padStart(2, "0")}`;
    const cObj = this.ctx.assets.objects.byName.get(`Character/${cCode}_A`);
    const relTick = this.releaseStartTick.get(p.slot);
    const relElapsed = relTick !== undefined ? tick - relTick : 999;

    let actKey = "15 Stop Down";
    let loop = true;
    let animTick = tick;
    let forceFrame = -1;
    let useNeutralPalette = false;

    if (p.state === "dying" || isSoulOnly) {
      actKey = "01 Die";
      loop = false;
      animTick = isSoulOnly ? 28 + p.stateTicks : p.stateTicks;
    } else if (isGhost) {
      if (p.stateTicks < 80) {
        actKey = "43 Ghost Appear";
        loop = false;
        animTick = p.stateTicks - 64;
      } else {
        actKey = p.moving
          ? `${44 + p.facing} Ghost Walk ${dirWord}`
          : `${48 + p.facing} Ghost Stop ${dirWord}`;
        animTick = p.walkTicks;
      }
    } else if (p.state === "trapped") {
      // Retail `25 Locked In` (`Character/Cxx-Die` flailing frames `0` & `1`), NOT `02 Faint`!
      actKey = "25 Locked In";
      forceFrame = Math.floor(p.stateTicks / 4) % 2;
    } else if (p.state === "hedgehog") {
      useNeutralPalette = true;
      if (snap.finished) {
        actKey = snap.winnerSlots.includes(p.slot) ? "61 HedgehogWin" : "62 HedgehogLose";
        animTick = this.finishStartTick >= 0 ? Math.max(0, tick - this.finishStartTick) : tick;
      } else if (p.stateTicks < 12) {
        actKey = "59 HedgehogRebirth";
        loop = false;
        animTick = p.stateTicks;
      } else if (p.hedgehogSpinTicks > 0) {
        actKey = `7${2 + p.facing} HedgehogSpin${dirWord}`;
        animTick = 18 - p.hedgehogSpinTicks;
      } else if (p.hedgehogStruggleTicks > 0) {
        actKey = "60 HedgehogStruggle";
        animTick = 8 - p.hedgehogStruggleTicks;
      } else {
        actKey = p.moving
          ? `6${3 + p.facing} HedgehogWalk${dirWord}`
          : `6${7 + p.facing} HedgehogStop${dirWord}`;
        animTick = p.walkTicks;
      }
    } else if (tick < START_BANNER_TICKS) {
      actKey = "24 Start";
      loop = false;
      animTick = tick;
    } else if (snap.finished && snap.winnerSlots.includes(p.slot)) {
      actKey = "03 Hurrah";
      animTick = this.finishStartTick >= 0 ? Math.max(0, tick - this.finishStartTick) : tick;
    } else if (snap.finished && !snap.winnerSlots.includes(p.slot)) {
      actKey = "02 Faint";
      animTick = this.finishStartTick >= 0 ? Math.max(0, tick - this.finishStartTick) : tick;
    } else if (relElapsed >= 0 && relElapsed < 16 && !p.moving && p.rideId <= 0) {
      actKey = "26 Release";
      loop = false;
      animTick = relElapsed;
    } else if (p.drillTicks > 0 && p.rideId <= 0) {
      actKey = `${35 + p.facing} Drill ${dirWord}`;
      loop = false;
      animTick = 14 - p.drillTicks;
    } else if (p.jumpTicks > 0 && p.rideId <= 0) {
      actKey = `${31 + p.facing} Jump ${dirWord}`;
      loop = false;
      animTick = 14 - p.jumpTicks;
    } else if (p.throwTicks > 0 && p.rideId <= 0) {
      actKey = `${16 + p.facing} Throw ${dirWord}`;
      loop = false;
      animTick = 12 - p.throwTicks;
    } else if (p.slipTicks > 0) {
      actKey =
        p.rideId > 0
          ? `${39 + p.facing} Slide Ride ${dirWord}`.replace(/^39/, "39")
          : `${27 + p.facing} Slide ${dirWord}`;
      animTick = 16 - p.slipTicks;
    } else if (p.rideId > 0) {
      actKey = p.moving
        ? `0${4 + p.facing} Ride ${dirWord}`
        : `0${8 + p.facing} Stop Ride ${dirWord}`.replace("010", "10").replace("011", "11");
      animTick = p.walkTicks;
    } else if (p.moving) {
      actKey = `2${p.facing} Walk ${dirWord}`;
      animTick = p.walkTicks;
    } else {
      actKey = `1${2 + p.facing} Stop ${dirWord}`;
    }

    const act = cObj?.actions.get(actKey) ?? cObj?.actions.get("15 Stop Down") ?? cObj?.defaultAction;
    const blinkAlpha = isGhost
      ? 0.54
      : (p.camoTicks ?? 0) > 0 && p.state === "alive"
        ? 0.52
        : p.invulnTicks > 0 && Math.floor(tick / 2) % 2 === 0
          ? 0.5
          : 1.0;
    const decoStocks =
      p.charDecoCodes && p.charDecoCodes.length > 0
        ? p.charDecoCodes
        : p.hatCode
          ? [p.hatCode]
          : [];
    const showCharDeco = decoStocks.length > 0 && p.state === "alive";
    const decoFootY = p.rideId > 0 ? bodyY - 25 : bodyY;
    const avatarDecoCodes: string[] = [];
    if ((p.charCode === 6 || p.charCode === 10) && decoStocks.length > 0) {
      const cos = this.ctx.assets.tables?.cosmetics;
      if (cos) {
        for (const sid of decoStocks) {
          for (const v of cos.expandVisuals(sid)) {
            if (v.liveKind === "avatarDeco" && v.liveObject) {
              avatarDecoCodes.push(v.liveObject.replace(/^AvatarDeco\//i, ""));
            }
          }
        }
      }
    }
    if (showCharDeco) {
      this.cache.drawCharDecoForStocks(
        r,
        this.ctx.assets,
        decoStocks,
        "back",
        p.facing,
        ax,
        decoFootY,
        tick,
        team,
        blinkAlpha,
      );
    }

    // Check active `CGOEmotionActor` (`EmoTE:Character/C0x_Emotion*`) when standing idle on foot!
    let drewEmo = false;
    const emo = this.slotEmotions.get(p.slot);
    if (
      emo &&
      nowMs < emo.untilMs &&
      p.state === "alive" &&
      !p.moving &&
      p.rideId <= 0 &&
      p.drillTicks === 0 &&
      p.jumpTicks === 0 &&
      p.throwTicks === 0 &&
      p.slipTicks === 0 &&
      tick >= START_BANNER_TICKS &&
      !snap.finished
    ) {
      const emoObjName = this.ctx.assets.cosmetics.resolveEmotionObject(
        p.charCode,
        emo.pose,
        emo.stockId,
      );
      const emoObj = emoObjName ? this.ctx.assets.emoObjects.byName.get(emoObjName) : undefined;
      const emoAct = emoObj?.actions.get("00 Front") ?? emoObj?.defaultAction;
      if (emoAct) {
        const emoSh = this.cache.getSheet(this.ctx.assets, "EmoTE", emoAct.sprite, team);
        if (emoSh && emoSh.sheet && emoSh.sheet.rects.length > 0) {
          const eFrame = sampleActionFrame(emoAct, tick, true);
          drawSheetFrame(r, emoSh, eFrame, ax, bodyY, {
            anchor: true,
            tint: [1, 1, 1, blinkAlpha],
          });
          drewEmo = true;
        }
      }
    }

    if (!drewEmo && act) {
      const sh = this.cache.getSheet(
        this.ctx.assets,
        "Fx",
        act.sprite,
        useNeutralPalette ? 0 : team,
        useNeutralPalette ? undefined : avatarDecoCodes,
      );
      const frame = forceFrame >= 0 ? forceFrame : sampleActionFrame(act, animTick, loop);
      const ghostBob = isGhost ? Math.sin(tick * 0.15 + p.slot) * 3 : 0;
      let trail = this.motionTrails.get(p.slot);
      if (!trail) { trail = new MotionBlurTrail(); this.motionTrails.set(p.slot, trail); }
      const roomStocks = this.ctx.hub.currentRoom?.slots[p.slot]?.charDecoStockIds ?? [];
      const localStocks = p.slot === mySlot && !p.isAi ? (this.ctx.hub.profile?.equipped.charDecoStockIds ?? []) : [];
      const motionEnabled = [...decoStocks, ...roomStocks, ...localStocks].includes(1207);
      const echoes = trail.update(tick, ax, bodyY, motionEnabled && p.state === "alive" && p.moving);
      for (const echo of echoes) {
        drawSheetFrame(r, sh, frame, echo.x, echo.y, { anchor: true, tint: [1, 1, 1, echo.alpha * blinkAlpha] });
      }
      drawSheetFrame(r, sh, frame, ax, bodyY + ghostBob, {
        anchor: true,
        tint: [1, 1, 1, blinkAlpha],
      });
    }
    if (showCharDeco) {
      this.cache.drawCharDecoForStocks(
        r,
        this.ctx.assets,
        decoStocks,
        "front",
        p.facing,
        ax,
        decoFootY,
        tick,
        team,
        blinkAlpha,
        true,
      );
    }

    // `CGOFanfareActor` (`CA.exe.c:55956..56026`): `EmoTE:Fanfare/Fanfare000..006` above winning bombers!
    if (snap.finished && snap.winnerSlots.includes(p.slot) && p.state === "alive") {
      const rSlotFan = this.ctx.hub.currentRoom?.slots[p.slot];
      const isLocalFan = p.slot === mySlot && !p.isAi;
      const fanStocks: Array<number | undefined> = [
        rSlotFan?.fanfareStockId,
        isLocalFan ? this.ctx.hub.profile?.equipped.fanfareStockId : undefined,
        ...decoStocks,
      ];
      const finTick = this.finishStartTick >= 0 ? Math.max(0, tick - this.finishStartTick) : tick;
      this.cache.drawFanfareForStocks(r, this.ctx.assets, fanStocks, ax, decoFootY, finTick);
    }

    // Flying UFO (`Ship/Airship` `flyLevel === 2`) draws IN FRONT OF rider (`sub_40AFDD`)
    if (p.rideFly) drawMount();

    // Retail `Bomb/Bubble` (`00 Lock`: `0->1->2->6`, `01 ExpLive`: `6->7->8`, `02 ExpKill`: `3->4->5`) at `(ax, bodyY)`!
    if (this.bubbleSheet) {
      const bubObj = this.ctx.assets.objects.byName.get("Bomb/Bubble");
      if (p.state === "trapped") {
        const lockAct = bubObj?.actions.get("00 Lock");
        const bFrame =
          p.stateTicks >= 12
            ? 6
            : lockAct
              ? sampleActionFrame(lockAct, p.stateTicks, false)
              : 6;
        const popWarnAt = p.hasOxygen ? 330 : 150;
        const warnTint =
          p.stateTicks > popWarnAt && Math.floor(tick / 3) % 2 === 0
            ? ([1, 0.55, 0.55, 0.88] as const)
            : p.hasOxygen
              ? ([0.72, 0.98, 1, 0.9] as const)
              : ([1, 1, 1, 0.86] as const);
        drawSheetFrame(r, this.bubbleSheet, bFrame, ax, bodyY, {
          anchor: true,
          tint: warnTint,
        });
      } else if (p.state === "dying" && p.stateTicks < 12) {
        const killAct = bubObj?.actions.get("02 ExpKill");
        const bFrame = killAct ? sampleActionFrame(killAct, p.stateTicks, false) : 4;
        drawSheetFrame(r, this.bubbleSheet, bFrame, ax, bodyY, {
          anchor: true,
          tint: [1, 1, 1, 0.86],
        });
      } else if (p.state === "alive" && relElapsed >= 0 && relElapsed < 12) {
        const liveAct = bubObj?.actions.get("01 ExpLive");
        const bFrame = liveAct ? sampleActionFrame(liveAct, relElapsed, false) : 7;
        drawSheetFrame(r, this.bubbleSheet, bFrame, ax, bodyY, {
          anchor: true,
          tint: [1, 1, 1, 0.86],
        });
      }
    }

    if (isSoulOnly) return;

    // `Game/UndergroundWater` (`12`f `51x48` geyser splash when `ACTIVE_DRILL` drills into the tile ahead!)
    if ((p.drillTicks ?? 0) > 0) {
      const ugSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/UndergroundWater", 0);
      if (ugSh && ugSh.sheet && ugSh.sheet.rects.length > 0) {
        const df = Math.min(
          ugSh.sheet.rects.length - 1,
          Math.floor(((14 - (p.drillTicks ?? 0)) * ugSh.sheet.rects.length) / 14),
        );
        const dxCell = p.facing === 0 ? -40 : p.facing === 2 ? 40 : 0;
        const dyCell = p.facing === 1 ? -40 : p.facing === 3 ? 40 : 0;
        drawSheetFrame(r, ugSh, df, ax + dxCell - 5, bodyY + dyCell - 32, { anchor: false });
      }
    }

    // Retail `Fx:Item/Shield` sprite (`34x37`, `px=-3, py=58`)
    const indBaseY = p.rideId > 0 ? bodyY - 25 : bodyY;
    if (p.shieldTicks > 0 && this.shieldSheet) {
      const shAlpha = p.shieldTicks < 20 && Math.floor(tick / 2) % 2 === 0 ? 0.45 : 0.88;
      drawSheetFrame(r, this.shieldSheet, 0, ax, indBaseY, {
        anchor: true,
        tint: [1, 1, 1, shAlpha],
      });
    }

    // Exact `CGOBomber::sub_40BCE3` (`L12563..12595`):
    //   `SelfIndicator[00|01]` & `CaptainFlag` at `(ax + 20, indBaseY - 62)` (`17`-step bounce in `ObjectTable`)!
    //   `TimebombIndicator` at `(ax, indBaseY)` (`px=3, py=102`)!
    if (p.isCaptain && this.captainFlagSheet) {
      const cfAct = this.ctx.assets.objects.byName.get("Game/CaptainFlag")?.defaultAction;
      const cfFrame = cfAct ? sampleActionFrame(cfAct, tick, true) : Math.floor(tick / 4) % 4;
      drawSheetFrame(r, this.captainFlagSheet, cfFrame, ax + 20, indBaseY - 62, {
        anchor: true,
      });
    }
    // Mode 4 (`CSurvivalComponent` 生死戰): animated `Game/Kill_Crown` over the kill leader & `Combo` streak popup!
    if (snap.mode === 4) {
      const topKills = Math.max(0, ...snap.players.map((pl) => pl.kills));
      if (topKills > 0 && p.kills === topKills) {
        const crSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_Crown", 0);
        if (crSh && crSh.sheet && crSh.sheet.rects.length > 0) {
          const cf = Math.floor(tick / 4) % crSh.sheet.rects.length;
          drawSheetFrame(r, crSh, cf, ax + 9, indBaseY - 64, { anchor: false });
        }
      }
      if ((p.comboKills ?? 0) >= 2 && (p.comboWindowTicks ?? 0) > 85) {
        const kno = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_ImageNo", 0);
        if (kno && kno.sheet && kno.sheet.rects.length >= 63) {
          const cf = Math.floor(tick / 3) % 3;
          const digit = Math.min(9, p.comboKills ?? 2);
          drawSheetFrame(r, kno, 60 + cf, ax - 18, indBaseY - 82, { anchor: false });
          drawSheetFrame(r, kno, 30 + digit * 3 + cf, ax + 45, indBaseY - 81, { anchor: false });
        }
      }
    }
    if (snap.componentMode === 1 && p.isFirstPlace && this.firstFlagSheet) {
      const ffAct = this.ctx.assets.objects.byName.get("Game/FirstPlaceFlag")?.defaultAction;
      const ffFrame = ffAct ? sampleActionFrame(ffAct, tick, true) : Math.floor(tick / 4) % 4;
      drawSheetFrame(r, this.firstFlagSheet, ffFrame, ax, indBaseY - 12, { anchor: true });
    } else if (snap.componentMode === 1 && p.isFinalLap && this.finalFlagSheet) {
      const flAct = this.ctx.assets.objects.byName.get("Game/FinalFlag")?.defaultAction;
      const flFrame = flAct ? sampleActionFrame(flAct, tick, true) : Math.floor(tick / 4) % 4;
      drawSheetFrame(r, this.finalFlagSheet, flFrame, ax, indBaseY - 12, { anchor: true });
    }
    // `CTimebombRoulette` (`Game/TimebombRoulette` + `Bomb/TimebombFrame`) & active Timebomb indicator
    if ((snap.timebombRouletteTicks ?? 0) > 0 && snap.timebombRouletteSlot === p.slot) {
      const tbRoul = this.cache.getSheet(this.ctx.assets, "Fx", "Game/TimebombRoulette", 0);
      if (tbRoul && tbRoul.sheet && tbRoul.sheet.rects.length > 0) {
        const rf = Math.floor(tick / 3) % tbRoul.sheet.rects.length;
        drawSheetFrame(r, tbRoul, rf, ax - 3, indBaseY - 92, { anchor: false });
      }
      const tbFrm = this.cache.getSheet(this.ctx.assets, "Fx", "Bomb/TimebombFrame", 0);
      if (tbFrm && tbFrm.sheet && tbFrm.sheet.rects.length > 0) {
        const ff = Math.floor(tick / 2) % tbFrm.sheet.rects.length;
        drawSheetFrame(r, tbFrm, ff, ax, indBaseY - 56, { anchor: false });
      }
    }
    if (p.hasTimebomb) {
      if (this.timebombIndSheet) {
        drawSheetFrame(r, this.timebombIndSheet, 0, ax, indBaseY, { anchor: true });
      }
      const tbFrm = this.cache.getSheet(this.ctx.assets, "Fx", "Bomb/TimebombFrame", 0);
      if (tbFrm && tbFrm.sheet && tbFrm.sheet.rects.length > 0) {
        const ff = Math.floor(tick / 3) % tbFrm.sheet.rects.length;
        drawSheetFrame(r, tbFrm, ff, ax, indBaseY - 46, { anchor: false, tint: [1, 1, 1, 0.82] });
      }
      const sec = Math.ceil(p.timebombTicks / 33);
      r.drawText(`${sec}`, ax + 20, indBaseY - 72, {
        align: "center",
        color: [1, 0.35, 0.3, 1],
        outlineColor: [0, 0, 0, 0.95],
      });
    }
    // `CGOEatQuestionMarkEffect` (`Game/QuestionMark_eff` + `Game/Queryitem_eff`) when collecting `Item/QuestionMark`!
    if ((p.questionEffTicks ?? 0) > 0) {
      const elapsed = Math.max(0, 24 - (p.questionEffTicks ?? 0));
      const qEff = this.cache.getSheet(this.ctx.assets, "Fx", "Game/QuestionMark_eff", 0);
      if (qEff && qEff.sheet && qEff.sheet.rects.length > 0) {
        const qf = Math.min(
          qEff.sheet.rects.length - 1,
          Math.floor((elapsed * qEff.sheet.rects.length) / 24),
        );
        drawSheetFrame(r, qEff, qf, ax - 4, indBaseY - 54, { anchor: false });
      }
      const qiEff = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Queryitem_eff", 0);
      if (qiEff && qiEff.sheet && qiEff.sheet.rects.length > 0) {
        const qif = Math.min(
          qiEff.sheet.rects.length - 1,
          Math.floor((elapsed * qiEff.sheet.rects.length) / 24),
        );
        drawSheetFrame(r, qiEff, qif, ax - 6, indBaseY - 48, { anchor: false });
      }
    }
    // `Game/Ghost InOut` (`OT[43..44]`, 6 frames) puff when `CGOGhost` materializes!
    if (isGhost && p.stateTicks >= 64 && p.stateTicks < 82) {
      const gio = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Ghost InOut", 0);
      if (gio && gio.sheet && gio.sheet.rects.length > 0) {
        const gf = Math.min(
          gio.sheet.rects.length - 1,
          Math.floor(((p.stateTicks - 64) * gio.sheet.rects.length) / 18),
        );
        drawSheetFrame(r, gio, gf, ax, bodyY, { anchor: true, tint: [1, 1, 1, 0.9] });
      }
    }
    // `CGONice` (`Game/SmallNice`) floating praise stamp when landing a multi-KO or clutch save!
    if ((p.niceTicks ?? 0) > 0) {
      const smNice = this.cache.getSheet(this.ctx.assets, "Fx", "Game/SmallNice", 0);
      if (smNice) {
        const elapsed = Math.max(0, 44 - (p.niceTicks ?? 0));
        const lift = Math.min(22, Math.floor(elapsed * 0.65));
        const alpha = (p.niceTicks ?? 0) < 12 ? (p.niceTicks ?? 0) / 12 : 1;
        drawSheetFrame(r, smNice, 0, ax - 4, indBaseY - 66 - lift, {
          anchor: false,
          tint: [1, 1, 1, alpha],
        });
      }
    }

    const p2Slot = this.localSim ? 1 : this.ctx.hub.slot2P;
    if (this.ctx.hub.showSelfIndicator) {
      const indAct = this.ctx.assets.objects.byName.get("Game/SelfIndicator")?.defaultAction;
      const indFrame = indAct ? sampleActionFrame(indAct, tick, true) : 0;
      if (p.slot === mySlot) {
        const sh = dual ? this.selfInd1PSheet : this.selfIndSheet;
        drawSheetFrame(r, sh, indFrame, ax + 20, indBaseY - 62, { anchor: true });
      } else if (dual && p.slot === p2Slot) {
        drawSheetFrame(r, this.selfInd2PSheet, indFrame, ax + 20, indBaseY - 62, { anchor: true });
      }
    }
    // `Fx:Help/Help`: `F2 遊戲中是否顯示ID on/off`
    if (this.ctx.hub.showPlayerIds && p.state !== "dead") {
      const isMe = p.slot === mySlot || (dual && p.slot === p2Slot);
      r.drawText(p.name.slice(0, 10), ax + 20, indBaseY - 48, {
        align: "center",
        color: isMe ? [1, 0.96, 0.35, 1] : [1, 1, 1, 0.95],
        outlineColor: [0, 0, 0, 0.95],
      });
    }

    // Mode 4 (`KillCount` / `SurvivalHeadCount`): overhead kill counter (`Game/Kill_ImageNo`)!
    if (snap.mode === 4 && p.kills > 0) {
      const shcObj = this.ctx.assets.objects.byName.get("Game/SurvivalHeadCount");
      const kIdx = Math.min(9, p.kills);
      const shcAct = shcObj?.actions.get(`0${kIdx} Kill${kIdx}`);
      if (shcAct) {
        const shcSh = this.cache.getSheet(this.ctx.assets, "Fx", shcAct.sprite, 0);
        const shcF = sampleActionFrame(shcAct, tick, true);
        drawSheetFrame(r, shcSh, shcF, ax + 4, indBaseY - 88);
      }
    }

    // Overhead speech bubble (`Fx:Game/ChatBalloon`, toggled via `F6`)
    const bub = this.slotBubbles.get(p.slot);
    if (bub && nowMs < bub.untilMs && this.ctx.hub.showSpeechBalloons) {
      drawGameSpeechBubble(r, this.balloonSheet, bub.text, ax + 20, indBaseY - 58);
    }
  }

  /** Retail `CGOStartGlyph` (`0x612838` + `sub_403E6C`): 5 glyphs at `y=73`, fly up `-80px/t` after tick 30. */
  private drawStartGlyphs(r: SpriteRenderer, ox: number, oy: number, tick: number): void {
    const xs = [153, 220, 293, 363, 432];
    for (let i = 0; i < 5; i++) {
      let dy = 0;
      if (tick > 30) {
        const dt = tick - 30 - i * 4;
        if (dt >= 4) continue;
        if (dt > 0) dy = -80 * dt;
      }
      drawSheetFrame(r, this.bannerStart, i, ox + xs[i]!, oy + 73 + dy, { anchor: true });
    }
  }

  /** Retail `CGOBonusGlyph` (`0x612900` + `sub_404476`): 11 `BONUS STAGE!!` glyphs on `Bonus*` maps! */
  private drawBonusGlyphs(r: SpriteRenderer, ox: number, oy: number, tick: number): void {
    const xs = [150, 219, 287, 356, 425, 138, 191, 239, 316, 385, 450];
    const ys = [220, 220, 220, 220, 220, 282, 282, 282, 282, 282, 282];
    for (let i = 0; i < 11; i++) {
      let dy = 0;
      if (i < 5) {
        const dropSteps = Math.min(3, Math.max(0, tick - i * 2));
        if (tick < i * 2) continue;
        dy = -300 + dropSteps * 100;
      } else {
        const startT = 10 + (i - 5) * 2;
        if (tick < startT) continue;
      }
      if (tick > 34) {
        const dt = tick - 34 - Math.floor(i / 2);
        if (dt >= 4) continue;
        if (dt > 0) dy -= 90 * dt;
      }
      drawSheetFrame(r, this.bannerBonus, i, ox + xs[i]! - 20, oy + ys[i]! - 42 + dy);
    }
  }

  /** Retail `CGOHurryUpGlyph` (`0x6128A8` + `sub_405363`): 8 glyphs at `y=254`, fly up after 30 ticks. */
  private drawHurryGlyphs(r: SpriteRenderer, ox: number, oy: number, elapsed: number): void {
    const xs = [161, 205, 248, 285, 330, 371, 417, 462];
    const frames = [0, 1, 2, 3, 4, 5, 6, 6];
    for (let i = 0; i < 8; i++) {
      let dy = 0;
      if (elapsed > 30) {
        const dt = elapsed - 30 - i * 2;
        if (dt >= 2) continue;
        if (dt > 0) dy = -250 * dt;
      }
      drawSheetFrame(r, this.bannerHurry, frames[i]!, ox + xs[i]!, oy + 254 + dy, { anchor: true });
    }
  }

  /** Retail `CGOWinGlyph`/`CGOLoseGlyph`/`CGODrawGlyph` (`0x612860..0x6128EC` + `sub_403F27`): drop onto `y=73`. */
  private drawEndGlyphs(
    r: SpriteRenderer,
    sheet: LoadedSheet,
    ox: number,
    oy: number,
    elapsed: number,
  ): void {
    const xs = [186, 280, 365];
    for (let i = 0; i < 3; i++) {
      const dt = elapsed - i * 3;
      if (dt < 0) continue;
      const steps = Math.min(2, dt);
      const y = oy + 73 - 200 + steps * 100;
      drawSheetFrame(r, sheet, i, ox + xs[i]!, y, { anchor: true });
    }
  }

  private drawHud(r: SpriteRenderer, snap: SimSnapshot, mySlot: number): void {
    // CGameStage::sub_4922D6: mode emblem, map-family icon, NEW badge and title.
    // Resolve from the snapshot, so online map changes and practice use the same path.
    const map = this.ctx.assets.tables?.mapInfo.maps.find((m) => m.name === snap.mapName);
    const stageIcon = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GameStage_Type_icon", 0);
    // Retail defaults to frame 1; special server mode codes 10–13 select 2–5.
    // Our mode IDs are not those server codes, so retain the confirmed default.
    if (stageIcon) drawSheetFrame(r, stageIcon, 1, 12, 7);
    if (map) {
      const art = map.art && map.art !== "none" ? map.art : map.family;
      const theme = this.cache.getSheet(this.ctx.assets, "Fx", `Theme/${art}`, 0);
      if (theme) drawSheetFrame(r, theme, 1, 35, 9);
      if (map.isNew) {
        const badge = this.cache.getSheet(this.ctx.assets, "Fx", "Theme/Newmap_Icon", 0);
        if (badge) drawSheetFrame(r, badge, 0, 35, 9);
      }
      const c = map.colour;
      r.drawText(gameMapLabel(map.description || map.name), 51, 9, {
        color: [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, 1],
      });
    }
    // Retail digital countdown clock (`Game/Timer`: mm at `(707, 43)`, ss at `(739, 43)`, stride `14`)
    const secsTotal = Math.max(0, Math.ceil((snap.ticksRemaining * TICK_MS) / 1000));
    const mm = Math.floor(secsTotal / 60);
    const ss = secsTotal % 60;
    if (this.timerSheet && this.timerSheet.sheet && this.timerSheet.sheet.rects.length >= 10) {
      drawSheetFrame(r, this.timerSheet, Math.floor(mm / 10), 707, 43);
      drawSheetFrame(r, this.timerSheet, mm % 10, 721, 43);
      drawSheetFrame(r, this.timerSheet, Math.floor(ss / 10), 739, 43);
      drawSheetFrame(r, this.timerSheet, ss % 10, 753, 43);
    }
    // Retail `Game/GameStage_Type_icon` (`CA.exe.c:112795`) mode emblem beside HUD timer!
    const typeIcon = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GameStage_Type_icon", 0);
    if (typeIcon && typeIcon.sheet && typeIcon.sheet.rects.length >= 6) {
      const modeFrame =
        snap.componentMode === 1
          ? 5
          : snap.componentMode === 2 || snap.componentMode === 3
            ? 4
            : Math.min(5, snap.mode);
      drawSheetFrame(r, typeIcon, modeFrame, 684, 42, { anchor: false });
    }

    const dual = this.isDual2P();
    const p2Slot = dual ? (this.localSim ? 1 : this.ctx.hub.slot2P) : -1;
    const mode4TopKills = snap.mode === 4 ? Math.max(0, ...snap.players.map((pl) => pl.kills)) : 0;

    // 8 `CPortraitWnd::sub_494D2D` & `sub_49494C` slots (`0x00616268`: `(v14, v15) = (660, 69 + 43 * row)`)
    // Exact `CA.exe.c:129982..130405`: on `CKartComponent` (`componentMode === 1`), rows `0..7` re-sort by live race rank
    // and stamp `Game/GaugeImg[17 + row]` (`1st`..`8th`) at `(v14 - 26, v15 - 5) = (634, 64 + 43 * row)`!
    const kartSortedSlots =
      snap.componentMode === 1
        ? [...snap.players]
            .sort(
              (a, b) =>
                (b.kartLap ?? 0) * 100 +
                (b.kartCheckpoint ?? -1) -
                ((a.kartLap ?? 0) * 100 + (a.kartCheckpoint ?? -1)),
            )
            .map((pl) => pl.slot)
        : null;

    for (let row = 0; row < 8; row++) {
      const slot = kartSortedSlots ? (kartSortedSlots[row] ?? -1) : row;
      if (slot < 0) continue;
      const p = snap.players.find((pl) => pl.slot === slot);
      if (!p) continue;
      const vx = 660;
      const vy = 69 + row * 43;
      const teamOne = (p.team % 8) + 1;
      const isDead = p.state === "dead" || p.state === "dying";

      // 1. `CLevelIconEffector` (`Cx:Etc/LevelIcons`) at `(v14 + 47, v15 + 1)` + `Game/ImperialMark` (`CA.exe.c:129955`)
      if (!p.isAi) {
        const rSlot = this.ctx.hub.currentRoom?.slots[slot];
        const roomLv = rSlot?.level;
        const isLocalP = slot === mySlot || slot === p2Slot;
        const lv =
          roomLv && roomLv > 0
            ? roomLv
            : isLocalP
              ? (this.ctx.hub.profile?.level ?? 1)
              : 1;
        const effIdxP =
          rSlot?.levelEffectIdx ??
          (isLocalP ? this.ctx.hub.profile?.equipped.levelEffectIdx : undefined);
        drawLevelIcon(
          r,
          this.levelIconsSheet,
          lv,
          vx + 47,
          vy + 1,
          this.cache.getTwinkleSheet(this.ctx.assets, effIdxP),
          snap.tick,
          this.cache.getRotateSheet(this.ctx.assets, effIdxP),
        );
        if (this.ctx.hub.currentRoom?.kind === "guild") {
          const ldBlank = this.cache.getSheet(this.ctx.assets, "Fx", "Ladder/LadderLevelBlank", 0);
          const smLd = this.cache.getSheet(this.ctx.assets, "Fx", "Ladder/Small_LD", 0);
          drawSheetFrame(r, ldBlank, 0, vx + 44, vy - 1);
          drawSheetFrame(r, smLd, Math.max(0, Math.min(8, Math.floor((lv - 1) / 30))), vx + 47, vy + 1);
          const lpDelta = isDead ? -8 : 12 + Math.min(18, p.kills * 3);
          const lpStr = `${lpDelta >= 0 ? "+" : ""}${lpDelta}`;
          r.drawText(lpStr, vx + 93, vy + 3, {
            color: lpDelta >= 0 ? [0.42, 0.98, 0.52, 1] : [1, 0.42, 0.42, 1],
            outlineColor: [0, 0, 0, 0.9],
          });
        }
        const hasImperial = Boolean(
          rSlot?.slotDecoStockId ||
            rSlot?.slotDecoStockIds?.length ||
            (isLocalP &&
              (this.ctx.hub.profile?.equipped.slotDecoStockId ||
                this.ctx.hub.profile?.equipped.slotDecoStockIds?.length)),
        );
        if (hasImperial) {
          const impSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/ImperialMark", 0);
          drawSheetFrame(r, impSh, 0, vx + 64, vy - 2);
        }
        if (lv >= 300) {
          const ognSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/OngamenetMark", 0);
          drawSheetFrame(r, ognSh, 0, vx + 84, vy - 4);
        } else if (lv >= 150) {
          const zzSh = this.cache.getSheet(
            this.ctx.assets,
            "Fx",
            lv >= 220 ? "Game/SchoolZzangMark2" : "Game/SchoolZzangMark1",
            0,
          );
          drawSheetFrame(r, zzSh, 0, vx + 88, vy - 2);
        }
      }

      // 2. `CGOAvatar` portrait at `(v14, v15)` WITH `{ anchor: true }` (`px = -1..-9`, `py = 0..-2`)
      const cCode = `C${String(Math.max(0, Math.min(10, p.charCode))).padStart(2, "0")}`;
      const pObj = this.ctx.assets.objects.byName.get(`Character/${cCode}_Portrait_A`);
      const pAct = isDead ? pObj?.actions.get("Die") : pObj?.actions.get("Default");
      if (pAct) {
        const sh = this.cache.getSheet(this.ctx.assets, "Fx", pAct.sprite, teamOne);
        const pFrame = sampleActionFrame(pAct, isDead ? p.stateTicks : snap.tick, !isDead);
        drawSheetFrame(r, sh, pFrame, vx, vy, { anchor: true });
      }

      // 3. `Fx:Etc/PortraitHandle` steering wheel at `(v14, v15)` `{ anchor: true }` when alive & riding Kart
      if (!isDead && (p.rideId === 9 || p.rideId === 10) && this.portraitHandleSheet) {
        drawSheetFrame(r, this.portraitHandleSheet, 0, vx, vy, { anchor: true });
      }

      // 3b. `CTimebombRoulette` (`Game/TimebombSlot`, `43x51`) at exact retail `(623, 51 + 43 * slot)` (`CA.exe.c:146250`)!
      if (
        ((snap.timebombRouletteTicks ?? 0) > 0 && snap.timebombRouletteSlot === slot) ||
        p.hasTimebomb
      ) {
        const tbSlot = this.cache.getSheet(this.ctx.assets, "Fx", "Game/TimebombSlot", 0);
        if (tbSlot && tbSlot.sheet && tbSlot.sheet.rects.length > 0) {
          const sf = Math.floor(snap.tick / 3) % tbSlot.sheet.rects.length;
          drawSheetFrame(r, tbSlot, sf, 623, 51 + slot * 43, { anchor: false });
        }
      }

      // 3c. Mode 4 (`CSurvivalComponent` 生死戰): `Game/Kill_Image[35|34]` at `(608, 64 + 43 * slot)`
      //     + `Game/Kill_ImageNo` kill count + `Game/Kill_Crown` at `(626, 53 + 43 * slot)` (`CA.exe.c:143813..143848`)!
      if (snap.mode === 4) {
        const kImg = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_Image", 0);
        if (kImg && kImg.sheet && kImg.sheet.rects.length >= 36) {
          drawSheetFrame(r, kImg, isDead && p.noRevive ? 34 : 35, 608, 64 + slot * 43, {
            anchor: false,
          });
        }
        const kNo = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_ImageNo", 0);
        if (kNo && kNo.sheet && kNo.sheet.rects.length >= 60) {
          const cf = Math.floor(snap.tick / 5) % 3;
          const kVal = Math.min(99, p.kills);
          if (kVal >= 10) {
            drawSheetFrame(r, kNo, 30 + Math.floor(kVal / 10) * 3 + cf, 613, 76 + slot * 43, {
              anchor: false,
            });
            drawSheetFrame(r, kNo, 30 + (kVal % 10) * 3 + cf, 625, 76 + slot * 43, {
              anchor: false,
            });
          } else {
            drawSheetFrame(r, kNo, 30 + kVal * 3 + cf, 619, 76 + slot * 43, { anchor: false });
          }
        }
        if (mode4TopKills > 0 && p.kills === mode4TopKills) {
          const crSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Kill_Crown", 0);
          if (crSh && crSh.sheet && crSh.sheet.rects.length > 0) {
            const cf = Math.floor(snap.tick / 4) % crSh.sheet.rects.length;
            drawSheetFrame(r, crSh, cf, 626, 53 + slot * 43, { anchor: false });
          }
        }
      }

      // 4. `CIDDecoEffector` (`EmoTE:IDDeco/IDDeco_C001G..008G`) + Font-2 black-outlined nickname!
      const isLocal = slot === mySlot || slot === p2Slot;
      const idDecoId =
        p.idDecoCode ??
        this.ctx.hub.currentRoom?.slots[slot]?.idDecoStockId ??
        (isLocal ? this.ctx.hub.profile?.equipped.idDecoStockId : undefined);
      this.cache.drawGameIdDeco(r, this.ctx.assets, idDecoId, vx + 36, vy + 6, snap.tick);
      const nameColor = isDead
        ? ([0.769, 0.769, 0.769, 1] as const)
        : isLocal
          ? ([1, 1, 0, 1] as const)
          : ([1, 1, 1, 1] as const);
      r.drawText(p.name.slice(0, 8), vx + 44, vy + 20, {
        color: nameColor,
        outlineColor: [0, 0, 0, 0.95],
      });
    }

    // Retail `Game/ItemBox00` (`135x93` at `(647, 439)`) / `Game/ItemBox01` + `sub_40F5A4` (`CA.exe.c` `L15462..15602`)
    const ib = dual && this.itemBox2PSheet ? this.itemBox2PSheet : this.itemBoxSheet;
    drawSheetFrame(r, ib, 0, 647, 439);

    const drawActiveItemHud = (
      pl: SimPlayer | undefined,
      iconX: number,
      iconY: number,
      cntX: number,
      cntY: number,
    ) => {
      if (!pl) return;
      let primaryKind = 0;
      let primaryCount = 0;
      let secondaryKind = 0;
      for (const s of pl.activeSlots) {
        if (!s) continue;
        if (primaryKind === 0) {
          primaryKind = s;
          primaryCount = 1;
        } else if (s === primaryKind) {
          primaryCount++;
        } else if (secondaryKind === 0) {
          secondaryKind = s;
        }
      }
      if (primaryKind === 0 || primaryCount <= 0) return;

      const sheetFor = (k: number, qty = 1): LoadedSheet | null => {
        if (k === ACTIVE_NEEDLE) {
          if (qty >= 2) {
            const np = this.cache.getSheet(this.ctx.assets, "Fx", "Item/NiddlePlus", 0);
            if (np) return np;
          }
          if (this.needleSheet) return this.needleSheet;
        }
        if (k === ACTIVE_SHIELD && this.shieldSheet) return this.shieldSheet;
        const sp = ACTIVE_HUD_SPRITES[k];
        return sp ? this.cache.getSheet(this.ctx.assets, "Fx", sp, 0) : null;
      };

      // Secondary queued item mini-preview (`14x23` at `(v33 + 36, v34 - 33)`)
      const secSheet = sheetFor(secondaryKind, 1);
      if (secSheet) {
        drawSheetFrame(r, secSheet, 0, iconX + 36, iconY - 33, { w: 14, h: 23 });
      }

      // Primary active item anchored at `(v33, v34)` (`(666, 528)` in 1P, `(662|726, 524)` in 2P)
      const priSheet = sheetFor(primaryKind, primaryCount);
      if (priSheet) {
        drawSheetFrame(r, priSheet, 0, iconX, iconY, { anchor: true });
      }

      // `Game/ResultImg` frame `12` (`"x"`) + 2-digit count (`frames 0..9`, stride `14`)
      if (this.resultImgSheet && this.resultImgSheet.sheet && this.resultImgSheet.sheet.rects.length > 12) {
        const clamped = Math.min(99, primaryCount);
        drawSheetFrame(r, this.resultImgSheet, 12, cntX, cntY);
        drawSheetFrame(r, this.resultImgSheet, Math.floor(clamped / 10), cntX + 14, cntY);
        drawSheetFrame(r, this.resultImgSheet, clamped % 10, cntX + 28, cntY);
      }
    };

    if (!dual) {
      const me = snap.players.find((p) => p.slot === mySlot);
      drawActiveItemHud(me, 666, 528, 719, 498);
    } else {
      const p1 = snap.players.find((p) => p.slot === mySlot);
      const p2 = snap.players.find((p) => p.slot === p2Slot);
      drawActiveItemHud(p1, 662, 524, 662, 512);
      drawActiveItemHud(p2, 726, 524, 726, 512);
    }

    // Retail `Game/GameStageItem` (`CA.exe.c:120674..120708`): 6-Slot Quick-Item Belt (`Keys 1..6`)!
    const gsItem = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GameStageItem", 0);
    if (gsItem && gsItem.sheet && gsItem.sheet.rects.length >= 21) {
      const quickSheetFor = (k: number): LoadedSheet | null => {
        if (k === ACTIVE_NEEDLE && this.needleSheet) return this.needleSheet;
        if (k === ACTIVE_SHIELD && this.shieldSheet) return this.shieldSheet;
        const sp = ACTIVE_HUD_SPRITES[k];
        return sp ? this.cache.getSheet(this.ctx.assets, "Fx", sp, 0) : null;
      };
      const drawQuickBelt = (pl: SimPlayer | undefined, barX: number, barFrame: number) => {
        drawSheetFrame(r, gsItem, barFrame, barX, 563, { anchor: false });
        if (!pl) return;
        const cap = pl.activeSlotCap ?? 4;
        for (let si = 0; si < 6; si++) {
          const sx = barX + 37 + si * 40;
          const kind = pl.activeSlots[si] ?? 0;
          const unlocked = si < cap;
          if (kind > 0) {
            const ic = quickSheetFor(kind);
            if (ic) {
              drawSheetFrame(r, ic, 0, sx + 6, 569, {
                w: 25,
                h: 25,
                anchor: false,
                tint: unlocked ? [1, 1, 1, 1] : [0.6, 0.6, 0.6, 0.6],
              });
            }
            drawSheetFrame(r, gsItem, 3 + si, sx, 566, { anchor: false });
          } else {
            drawSheetFrame(r, gsItem, unlocked ? 3 + si : 15 + si, sx, 566, {
              anchor: false,
              tint: unlocked ? [1, 1, 1, 0.65] : [1, 1, 1, 0.35],
            });
          }
        }
      };
      if (!dual) {
        drawQuickBelt(snap.players.find((p) => p.slot === mySlot), 24, 0);
      } else {
        drawQuickBelt(snap.players.find((p) => p.slot === mySlot), 24, 1);
        drawQuickBelt(snap.players.find((p) => p.slot === p2Slot), 312, 2);
      }
    }

    // Mode-specific playfield HUD (`CKartGauge` `Game/GaugeBg`+`GaugeImg`, `CBulaComponent`, `CEvent2004Component`)
    if (snap.componentMode === 1) {
      const me = snap.players.find((p) => p.slot === mySlot);
      const totLaps = Math.min(9, snap.kartTotalLaps ?? 3);
      const curLap = Math.min(totLaps, (me?.kartLap ?? 0) + 1);
      const fuelPct = Math.max(0, Math.min(100, Math.round(me?.kartFuel ?? 100)));
      // Compute live race rank (`1..8`) among racers by `(kartLap * 100 + kartCheckpoint)`
      const sortedRacers = [...snap.players].sort(
        (a, b) =>
          (b.kartLap ?? 0) * 100 +
          (b.kartCheckpoint ?? -1) -
          ((a.kartLap ?? 0) * 100 + (a.kartCheckpoint ?? -1)),
      );
      const rankOne = Math.max(
        1,
        Math.min(8, sortedRacers.findIndex((p) => p.slot === mySlot) + 1),
      );

      const gBg = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GaugeBg", 0);
      const gImg = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GaugeImg", 0);
      if (gBg && gImg && gImg.sheet && gImg.sheet.rects.length >= 25) {
        drawSheetFrame(r, gBg, 0, 20, 10, { anchor: false, tint: [1, 1, 1, 0.9] });
        drawSheetFrame(r, gImg, 0, 23, 13, { anchor: false });
        // Live rank badge `1st..8th` (`GaugeImg[16 + rankOne]`, `CA.exe.c:22734`)
        drawSheetFrame(r, gImg, 16 + rankOne, 27, 13, { anchor: false });
        // Current Lap / Total Laps digits (`GaugeImg[7 + digit]`)
        drawSheetFrame(r, gImg, 7 + (curLap % 10), 112, 11, { anchor: false });
        drawSheetFrame(r, gImg, 7 + (totLaps % 10), 152, 11, { anchor: false });
        // `"FUEL"` label (`GaugeImg[4]`) + clipped `85x12` fuel bar (`GaugeImg[3]`)!
        drawSheetFrame(r, gImg, 4, 29, 49, { anchor: false });
        const fillW = Math.round((85 * fuelPct) / 100);
        if (fillW > 0) {
          r.pushClip(92, 49, fillW, 14);
          drawSheetFrame(r, gImg, 3, 92, 49, {
            anchor: false,
            tint: fuelPct <= 22 ? [1, 0.45, 0.4, 1] : [1, 1, 1, 1],
          });
          r.popClip();
        }
      }
    } else if (snap.componentMode === 2) {
      const aliveSouls = (snap.souls ?? []).filter((s) => s.state !== "dying").length;
      let totalHouses = 0;
      let capturedHouses = 0;
      for (const c of snap.cells) {
        if (c.bulaHouseEligible) {
          totalHouses++;
          if (c.bulaHouseTeam !== undefined && c.bulaHouseTeam >= 0) capturedHouses++;
        }
      }
      const me = snap.players.find((p) => p.slot === mySlot);
      const tcSheet = this.cache.getSheet(this.ctx.assets, "Fx", "Game/TeamColor", 0);
      if (tcSheet && me) {
        const tf = Math.max(0, Math.min((tcSheet.sheet?.rects.length ?? 1) - 1, me.team * 2));
        drawSheetFrame(r, tcSheet, tf, 22, 10, { w: 72, h: 28, tint: [1, 1, 1, 0.78] });
      }
      r.fillRect(24, 16, 206, 22, [0.03, 0.1, 0.24, 0.74]);
      if (totalHouses > 0) {
        r.drawText(`寶箱: ${capturedHouses}/${totalHouses}  怪物: ${aliveSouls}`, 30, 20, {
          color: [1, 0.92, 0.42, 1],
          outlineColor: [0, 0, 0, 0.95],
        });
      } else {
        r.drawText(`剩餘怪物: ${aliveSouls}`, 30, 20, {
          color: aliveSouls <= 2 ? [1, 0.86, 0.3, 1] : [1, 1, 1, 1],
          outlineColor: [0, 0, 0, 0.95],
        });
      }
    } else if (snap.componentMode === 3) {
      const me = snap.players.find((p) => p.slot === mySlot);
      const aliveSouls = (snap.souls ?? []).filter((s) => s.state !== "dying").length;
      const myFlags = me?.goldFlags ?? 0;
      r.fillRect(24, 16, 198, 22, [0.08, 0.06, 0.2, 0.76]);
      r.drawText(`黃金旗幟: ${myFlags}  怪物: ${aliveSouls}`, 30, 20, {
        color: myFlags > 0 ? [1, 0.88, 0.25, 1] : [1, 1, 1, 1],
        outlineColor: [0, 0, 0, 0.95],
      });
    } else if (snap.componentMode === 4) {
      const bonusGame = this.cache.getSheet(this.ctx.assets, "Fx", "Bonus/Game", 0);
      const bonusEnemy = this.cache.getSheet(this.ctx.assets, "Fx", "Bonus/Enemy", 0);
      const bf = Math.floor(snap.tick / 3) % 25;
      if (bonusGame) drawSheetFrame(r, bonusGame, bf, 4, 77);
      if (bonusEnemy) drawSheetFrame(r, bonusEnemy, bf, 148, 8);
      // Sparkling `Bonus/Star01..04` celebration twinkles across `CBonusComponent`!
      const starCoords: readonly [string, number, number][] = [
        ["Bonus/Star01", 86, 62],
        ["Bonus/Star02", 294, 42],
        ["Bonus/Star03", 468, 56],
        ["Bonus/Star04", 552, 88],
      ];
      starCoords.forEach(([spName, sx, sy], si) => {
        const stSh = this.cache.getSheet(this.ctx.assets, "Fx", spName, 0);
        if (stSh && stSh.sheet && stSh.sheet.rects.length > 0) {
          const sf = Math.floor((snap.tick + si * 5) / 4) % stSh.sheet.rects.length;
          drawSheetFrame(r, stSh, sf, sx, sy, { anchor: true });
        }
      });
      const me = snap.players.find((p) => p.slot === mySlot);
      const myLucci = me?.bonusLucci ?? 0;
      const got = snap.bonusCoinsCollected ?? 0;
      const tot = snap.bonusCoinsTotal ?? 0;
      r.fillRect(24, 16, 236, 22, [0.18, 0.11, 0.02, 0.80]);
      r.drawText(`獎勵關卡 LUCCI: +${myLucci}  (${got}/${tot})`, 30, 20, {
        color: [1, 0.90, 0.28, 1],
        outlineColor: [0, 0, 0, 0.95],
      });
    }
    if ((snap.componentMode === 2 || snap.componentMode === 3) && snap.tick < START_BANNER_TICKS + 45) {
      // Retail `Game/Mission` (`108x85`) at `(137, 28)` (`CA.exe.c:4536`)
      const msnSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Mission", 0);
      if (msnSh) drawSheetFrame(r, msnSh, 0, 137, 28);
    }
    const meXmas = snap.players.find((p) => p.slot === mySlot)?.xmasItems;
    if (meXmas && (meXmas[0] + meXmas[1] + meXmas[2]) > 0) {
      for (let xi = 0; xi < 3; xi++) {
        const xmSh = this.cache.getSheet(this.ctx.assets, "Fx", `Dialog/XMas_Item${xi}`, 0);
        if (xmSh) {
          const xPos = 450 + xi * 52;
          drawSheetFrame(r, xmSh, 0, xPos, 6, { w: 24, h: 28 });
          r.drawText(`x${meXmas[xi]}`, xPos + 26, 15, {
            color: [1, 0.96, 0.56, 1],
            outlineColor: [0, 0, 0, 0.95],
          });
        }
      }
    }

    // `CRAZY ARCADE` (`Item/Alphabet_01..11`) 11-letter collection strip when active!
    const myAlphaMask = snap.players.find((p) => p.slot === mySlot)?.alphabetMask ?? 0;
    if (myAlphaMask > 0) {
      const letters = "CRAZYARCADE";
      r.fillRect(24, 42, 206, 20, [0.05, 0.12, 0.26, 0.72]);
      for (let li = 0; li < 11; li++) {
        const collected = (myAlphaMask & (1 << li)) !== 0;
        r.drawText(letters[li]!, 30 + li * 18, 45, {
          color: collected ? [1, 0.9, 0.22, 1] : [0.55, 0.65, 0.8, 0.45],
          outlineColor: [0, 0, 0, 0.9],
        });
      }
    }

    const meWheel = snap.players.find((p) => p.slot === mySlot);
    if (meWheel && !snap.finished) {
      this.itemBoxWheel.render(
        r,
        this.ctx.assets,
        this.ctx.hub,
        snap.originX + meWheel.px,
        snap.originY + meWheel.py - 18,
      );
    }

    this.btExit.render(r);
  }

  /**
   * Exact retail `CGOGameResult` (`CA.exe.c` `sub_4180CA..sub_418D37`):
   *   - `(50, y)` (`540x270`), sliding smoothly up from `y = 600` to `200`, `PatResultDlg` @ 50% alpha
   *   - Column header sprites `ResultImg[33..37]` at `(103, 234, 283, 343, 387), y + 13`
   *   - 8 slot rows at `ry = y + 48 + 25 * slot`: `ResultImg[15 + slot]`, `ResultImg[25..27]`,
   *     local row highlight `ResultImg[38]` at `(x + 101, ry - 1)`, name at `(x + 123, ry + 3)`,
   *     Kills `(x + 245)`, Saves `(x + 296)`, `XX.X%` EXP `(x + 330)`, `LevelIcons` `(x + 410)`,
   *     and flashing Level-Up / Bonus stamp `(x + 450)`.
   */
  private drawResultBoard(r: SpriteRenderer, snap: SimSnapshot, finElapsed: number): void {
    const x = 50;
    // Approximate the result object's creation by match finish; retail starts
    // moving after its own 50th update (sub_418D37).
    let y = 600;
    if (finElapsed > 50) {
      let curY = 600;
      let vel = 45;
      const steps = Math.min(400, finElapsed - 50);
      for (let s = 0; s < steps && curY > 200; s++) {
        curY = Math.max(200, curY - vel);
        vel = Math.max(1, vel - 2);
      }
      y = curY;
    }
    if (y >= 598) return;

    const w = 540;
    const h = 270;
    drawPat9Slice(r, this.patResultSheet, x, y, w, h, [1, 1, 1, 0.52]);

    const isSurvivalRes = snap.mode === 4;
    const isGuildRes = this.ctx.hub.currentRoom?.kind === "guild";
    const resImg = this.resultImgSheet;
    if (resImg) {
      if (isSurvivalRes && (resImg.sheet?.rects.length ?? 0) >= 54) {
        // `CGOGameResultSurvival` (`CA.exe.c:144788..144890`): `Result[33, 34, 52, 36, 37, 53]`
        drawSheetFrame(r, resImg, 33, x + 103, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 34, x + 221, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 52, x + 261, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 36, x + 301, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 37, x + 343, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 53, x + 401, y + 13, { anchor: true });
      } else {
        // `CGOGameResult::sub_4180CA` column header sprites
        drawSheetFrame(r, resImg, 33, x + 103, y + 13, { anchor: true });
        if (!isGuildRes) {
          drawSheetFrame(r, resImg, 34, x + 234, y + 13, { anchor: true });
          drawSheetFrame(r, resImg, 35, x + 283, y + 13, { anchor: true });
        }
        drawSheetFrame(r, resImg, 36, x + 343, y + 13, { anchor: true });
        drawSheetFrame(r, resImg, 37, x + 387, y + 13, { anchor: true });
      }
    }

    const dual = this.isDual2P();
    const mySlot = this.localSim ? 0 : this.ctx.hub.mySlot;
    const p2Slot = dual ? (this.localSim ? 1 : this.ctx.hub.slot2P) : -1;
    const rewards = this.ctx.hub.lastMatchRewards;
    const maxKills = Math.max(0, ...snap.players.map((pl) => pl.kills));
    const niceSheet = maxKills >= 2 ? this.cache.getSheet(this.ctx.assets, "Fx", "Game/Nice", 0) : null;
    const gaugeImg = this.cache.getSheet(this.ctx.assets, "Fx", "Game/GaugeImg", 0);
    let mvpSlot = -1;
    let mvpScore = 0;
    for (const pl of snap.players) {
      if (!snap.winnerSlots.includes(pl.slot)) continue;
      const sc = pl.kills * 2 + pl.saves;
      if (sc > mvpScore) {
        mvpScore = sc;
        mvpSlot = pl.slot;
      }
    }

    // `CGOGameResultEvent2004`: Golden Flag celebration banner above the scoreboard when earned!
    const totalGoldFlags = snap.players.reduce((acc, pl) => acc + (pl.goldFlags ?? 0), 0);
    if (totalGoldFlags > 0 && y <= 240) {
      const evEff = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Event2004ResultEffect", 0);
      const evFlag = this.cache.getSheet(this.ctx.assets, "Fx", "Game/Event2004ResultFlag", 0);
      if (evEff && evEff.sheet && evEff.sheet.rects.length > 0) {
        const ef = Math.floor(snap.tick / 3) % evEff.sheet.rects.length;
        drawSheetFrame(r, evEff, ef, x + 90, y - 42, { anchor: false });
      }
      if (evFlag) {
        drawSheetFrame(r, evFlag, 0, x + 36, y - 58, { anchor: false });
      }
      const evMsg =
        this.ctx.assets.tables?.sysStrings.get("eventGoldFlag") ?? "恭喜獲得黃金旗幟獎勵！";
      r.drawText(`${evMsg.slice(0, 26)} (x${totalGoldFlags})`, x + 114, y - 28, {
        color: [1, 0.94, 0.35, 1],
        outlineColor: [0, 0, 0, 0.95],
      });
    }

    for (let slot = 0; slot < 8; slot++) {
      const p = snap.players.find((pl) => pl.slot === slot);
      if (!p) continue;
      const ry = y + 48 + slot * 25;
      const won = snap.winnerSlots.includes(p.slot);
      const isLocal = slot === mySlot || slot === p2Slot;
      const rw = rewards?.find((m) => m.slot === p.slot);

      // Exact `CA.exe.c:23039`: MVP 1st-place badge `GaugeImg[17]` at `(x - 9, ry)`!
      if (slot === mvpSlot && gaugeImg && (gaugeImg.sheet?.rects.length ?? 0) > 17) {
        drawSheetFrame(r, gaugeImg, 17, x - 9, ry);
      }

      if (resImg) {
        // Slot index badge `1P..8P` (`ResultImg[15 + slot]`) at `(x + 12, ry)`
        if (slot !== mvpSlot || !gaugeImg) drawSheetFrame(r, resImg, 15 + slot, x + 12, ry);
        // Outcome stamp (`25`=Win, `26`=Lose, `27`=Draw) at `(x + 35, ry)`
        const badgeIdx = snap.winnerTeam < 0 ? 27 : won ? 25 : 26;
        drawSheetFrame(r, resImg, badgeIdx, x + 35, ry);

        // Local player highlight strip (`ResultImg[38]`, `349x19`) at `(x + 101, ry - 1)`
        if (isLocal) {
          drawSheetFrame(r, resImg, 38, x + 101, ry - 1);
        }
        // Dual 1P / 2P badge (`ResultImg[23 | 24]`) at `(x + 104, ry)`
        if (dual && isLocal) {
          drawSheetFrame(r, resImg, slot === mySlot ? 23 : 24, x + 104, ry);
        }

        // Guild LP is omitted until the server supplies a real LP delta.

        if (isSurvivalRes) {
          // `CGOGameResultSurvival` (`L144830..144888`): Kills `(224,238)`, Deaths `(260,274)`, EXP `(292)`, MaxCombo `(413,427)`
          const kVal = Math.min(99, p.kills);
          if (kVal >= 10) drawSheetFrame(r, resImg, Math.floor(kVal / 10), x + 224, ry + 3, { anchor: true });
          drawSheetFrame(r, resImg, kVal % 10, x + 238, ry + 3, { anchor: true });

          const dVal = Math.min(99, rw?.deaths ?? p.deaths);
          if (dVal >= 10) drawSheetFrame(r, resImg, Math.floor(dVal / 10), x + 260, ry + 3, { anchor: true });
          drawSheetFrame(r, resImg, dVal % 10, x + 274, ry + 3, { anchor: true });

          if (!p.isAi && rw?.expProgressTenths !== undefined) {
            // Show the server's actual post-match progress; its EXP curve is
            // a web approximation and the reward arrives after the match.
            const tenths = Math.max(0, Math.min(999, rw.expProgressTenths));
            const whole = Math.floor(tenths / 10);
            drawSheetFrame(r, resImg, Math.floor(whole / 10), x + 292, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, whole % 10, x + 306, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, 11, x + 320, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, tenths % 10, x + 327, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, 10, x + 341, ry + 3, { anchor: true });
          }

          const mcVal = Math.min(99, rw?.maxCombo ?? p.maxCombo ?? 0);
          if (mcVal >= 10) drawSheetFrame(r, resImg, Math.floor(mcVal / 10), x + 413, ry + 3, { anchor: true });
          drawSheetFrame(r, resImg, mcVal % 10, x + 427, ry + 3, { anchor: true });
        } else {
          // Kills (`(x + 245, ry + 3)`) & Saves (`(x + 296, ry + 3)`) via `ResultImg[0..9]`
          if (!isGuildRes) {
            // Retail asks sub_56F5A0 for one digit in each column.
            drawSheetFrame(r, resImg, Math.max(0, p.kills) % 10, x + 245, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, Math.max(0, p.saves) % 10, x + 296, ry + 3, { anchor: true });
          }

          // `sub_4181FF`: `XX.X%` EXP progress (`0..999` tenths of a percent) at `(x + 330, ry)`
          if (!p.isAi && rw?.expProgressTenths !== undefined) {
            // Show the server's actual post-match progress; its EXP curve is
            // a web approximation and the reward arrives after the match.
            const tenths = Math.max(0, Math.min(999, rw.expProgressTenths));
            const whole = Math.floor(tenths / 10);
            drawSheetFrame(r, resImg, Math.floor(whole / 10), x + 330, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, whole % 10, x + 344, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, 11, x + 358, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, tenths % 10, x + 365, ry + 3, { anchor: true });
            drawSheetFrame(r, resImg, 10, x + 379, ry + 3, { anchor: true });
          }
        }

        // Level-Up (`ResultImg[29|30]`); the flash timing is approximate.
        if (finElapsed > 66) {
          const flash = Math.floor((finElapsed - 66) / 3) % 2;
          if (rw?.leveledUp) {
            drawSheetFrame(r, resImg, 29 + flash, x + 451, ry + 1);
          }
        }
      }

      // `CIDDecoEffector` (`EmoTE:IDDeco/IDDeco_C001G..008G`) + Nickname at `(x + 123, ry + 3)`!
      const resIdDeco =
        p.idDecoCode ??
        this.ctx.hub.currentRoom?.slots[slot]?.idDecoStockId ??
        (isLocal ? this.ctx.hub.profile?.equipped.idDecoStockId : undefined);
      this.cache.drawGameIdDeco(r, this.ctx.assets, resIdDeco, x + 114, ry - 9, snap.tick);
      r.drawText(p.name.slice(0, 8), x + 123, ry + 3, {
        color: [1, 1, 1, 1],
        outlineColor: [0, 0, 0, 0.95],
      });
      // `CGONice` (`Game/Nice`) MVP stamp on the top eliminator's row!
      if (niceSheet && finElapsed > 38 && p.kills === maxKills && maxKills >= 2) {
        drawSheetFrame(r, niceSheet, 0, x + 196, ry - 2, { anchor: false });
      }

      // Rank badge (`Cx:Etc/LevelIcons`) at `(x + 410, ry + 2)` (human players only)
      if (!p.isAi) {
        const rSlot = this.ctx.hub.currentRoom?.slots[slot];
        const roomLv = rSlot?.level;
        const lv =
          rw?.newLevel ??
          (roomLv && roomLv > 0
            ? roomLv
            : isLocal
              ? (this.ctx.hub.profile?.level ?? 1)
              : 1);
        const effIdx =
          rSlot?.levelEffectIdx ??
          (isLocal ? this.ctx.hub.profile?.equipped.levelEffectIdx : undefined);
        drawLevelIcon(
          r,
          this.levelIconsSheet,
          lv,
          x + 410,
          ry + 2,
          this.cache.getTwinkleSheet(this.ctx.assets, effIdx),
          snap.tick,
          this.cache.getRotateSheet(this.ctx.assets, effIdx),
        );
        // Exact `CA.exe.c:23082` `Game/ImperialResultMark` (`21x21`) at `(x + 427, ry - 2)`!
        const hasImperial = Boolean(
          rSlot?.slotDecoStockId ||
            rSlot?.slotDecoStockIds?.length ||
            (isLocal &&
              (this.ctx.hub.profile?.equipped.slotDecoStockId ||
                this.ctx.hub.profile?.equipped.slotDecoStockIds?.length)),
        );
        if (hasImperial) {
          const impResSh = this.cache.getSheet(this.ctx.assets, "Fx", "Game/ImperialResultMark", 0);
          drawSheetFrame(r, impResSh, 0, x + 427, ry - 2);
        }
      }
    }

    if (this.localSim && y <= 204) {
      this.btResultOk.render(r);
    }
  }

  /**
   * Retail `GOBulaDisplay` / Mode Mission Intro Banner (`CA.exe.c:137075..137260`, `142395..142460`):
   *   - Placed opposite local player's vertical spawn (`(180, 22)` if spawned lower half, else `(175, 266)`).
   *   - Selects `Dialog/DlgMission*` / `Dialog/DlgHedgehog` sprite & `csysstr.ssd` `Mission*Msg` copy matching the active mode!
   */
  private drawMissionBanner(
    r: SpriteRenderer,
    snap: SimSnapshot,
    myPlayer: SimPlayer | undefined,
    tick: number,
  ): void {
    let spritePath = "";
    let msgKey = "";
    let fallbackMsg = "";
    if (snap.componentMode === 2) {
      spritePath = "Dialog/DlgMissionBula";
      msgKey = "MissionBulaMsg";
      fallbackMsg = "將地板染上隊伍顏色並包圍寶箱，或消滅所有島上怪物即可獲勝！";
    } else if (snap.componentMode === 3) {
      spritePath = "Dialog/DlgMissionEvent2004";
      msgKey = "eventGoldFlag";
      fallbackMsg = "消滅地圖上的怪物收集黃金旗幟，奪取特別獎勵！";
    } else if (snap.mode === 1) {
      spritePath = "Dialog/DlgMissionCaptain";
      msgKey = "MissionCaptainMsg";
      fallbackMsg = "保護我方隊長並合力擊敗敵方隊長即可獲勝！";
    } else if (snap.mode === 2) {
      spritePath = "Dialog/DlgMissionTimebomb";
      msgKey = "MissionTimbombMsg";
      fallbackMsg = "小心身上的定時炸彈！在倒數結束前接觸對手轉移炸彈！";
    } else if (snap.mode === 3) {
      // Exact `CHedgehogComponent` (`CA.exe.c:142395..142460`): `Dialog/DlgHedgehog` (`310x178`) + `MissionHedgehogMsg`
      spritePath = "Dialog/DlgHedgehog";
      msgKey = "MissionHedgehogMsg";
      fallbackMsg = "水泡不會自動破裂，善用針與隊友救援堅持到最後！";
    } else if (snap.mode === 4) {
      spritePath = "Dialog/DlgMissionSurvival";
      msgKey = "MissionSurvivalMsg";
      fallbackMsg = "限時內擊破最多對手即可奪得第一名！倒數結束前可無限復活！";
    } else if (snap.mode === 0 && snap.componentMode === 0) {
      spritePath = "Dialog/DlgMission";
      msgKey = "MissionMsg";
      fallbackMsg = "運用水球困住對手並撞破水泡取得最後勝利！";
    }
    if (!spritePath) return;

    const sh = this.cache.getSheet(this.ctx.assets, "Fx", spritePath, 0);
    if (!sh) return;

    const spawnLower = (myPlayer?.py ?? 300) > 250;
    const bx = spawnLower ? 180 : 175;
    const by = spawnLower ? 22 : 266;
    let alpha = 0.94;
    if (tick < 22) alpha = ((tick - 12) / 10) * 0.94;
    else if (tick > 100) alpha = ((116 - tick) / 16) * 0.94;
    if (alpha <= 0.02) return;

    drawSheetFrame(r, sh, 0, bx, by, { anchor: false, tint: [1, 1, 1, alpha] });

    const rawText = (this.ctx.assets.tables?.sysStrings.get(msgKey) ?? fallbackMsg)
      .replace(/\\n/g, "\n")
      .trim();
    const lines: string[] = [];
    for (const seg of rawText.split(/\r?\n/)) {
      let cur = seg.trim();
      while (cur.length > 16) {
        lines.push(cur.slice(0, 16));
        cur = cur.slice(16);
      }
      if (cur.length > 0) lines.push(cur);
    }
    lines.slice(0, 4).forEach((ln, idx) => {
      r.drawText(ln, bx + 62, by + 76 + idx * 17, {
        color: [0.16, 0.12, 0.05, alpha],
      });
    });
  }
}
