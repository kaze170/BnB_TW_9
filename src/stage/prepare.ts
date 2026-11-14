// Stages 12 & 19: `CPrepareStage` & `CPrepareStagePractice` (`src/stage/prepare.ts`).
// Strictly implements `CA.exe` `CPrepareStage` / `CPrepareStagePractice` (`Fx:Prepare/*` & `Fx:PraticePrepare/*`):
//   - `Prepare/CAStage` (`800x600` JPEG, or `Prepare/CAStage2p` when `dual2P` is active)
//   - Practice header `PraticePrepare/TitlePractice`, AI `Bt_LevelUp (+70, +33)` & `Bt_LevelDown (+70, +76)`
//   - 8 Player Slots: `[[37,110],[140,110],[243,110],[346,110],[37,210],[140,210],[243,210],[346,210]]`
//     (`BtCloseSlot` / `BtOpenSlot` 98x98, character `(+49, +72)`)
//   - 8 Bomber Buttons (`0x615E60`): `[[491,52],[587,52],[683,52],[491,122],[683,122],[491,192],[587,192],[683,192]]`
//     (`BtSelBomber` 93x68) + `BtSelRandBomber (587, 122)`
//   - `CTeamSelectWnd (490, 436, 287, 45)` (`Prepare/ImgTeam` 8 team flags at `4 + 35*i, 4`)
//   - `BtChange (357, 19)`, `BtSelMap (495, 320)`, `BtReady` / `BtStart (568, 510)`
//   - Chat: `CCtrlMsgView (36, 370, 390, 149)`, `VScroll (436, 360, 18, 166)`,
//     `Whisper (42, 535, 74, 12)`, `Edit (151, 535, 250, 12)`, `Dialog/BtSpeaker_Speaker (413, 527)`
//   - `CGlobalButtonDlg (0, 566)`

import { CHAR_MAIN_MAP, type LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { GameModeId } from "../sim/engine.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import {
  CharacterPreviewCache,
  SpriteButton,
  SpriteItemBoxWheel,
  SpriteMsgView,
  SpriteScrollBar,
  SpriteWhisperLog,
  drawLevelIcon,
  drawSheetFrame,
  drawSpeechBubble,
  drawSpriteDigits,
  gameKillModeIconFrame,
  handleRetailSlashCommand,
  inferChatEmotionPose,
  pointInRect,
} from "../ui/widgets.ts";
import { MapSelectDlg, NoticeDlg, ShoutDlg, SmsFriendDlg, UserInfoDlg } from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

const PLAYER_SLOTS: readonly [number, number][] = [
  [37, 110],
  [140, 110],
  [243, 110],
  [346, 110],
  [37, 210],
  [140, 210],
  [243, 210],
  [346, 210],
];

const BOMBER_SLOTS: readonly [number, number][] = [
  [491, 52],
  [587, 52],
  [683, 52],
  [491, 122],
  [683, 122],
  [491, 192],
  [587, 192],
  [683, 192],
];

const MODES: GameModeId[] = [0, 4, 1, 2, 3];
const MODE_NAMES: Record<GameModeId, string> = {
  0: "一般對戰",
  1: "隊長模式",
  2: "計時炸彈",
  3: "刺蝟道具",
  4: "生存死鬥",
};

interface PracticeSlot {
  open: boolean;
  isHuman: boolean;
  is2P: boolean;
  isAi: boolean;
  aiLevel: 1 | 2 | 3;
  charCode: number;
  team: number;
}

export class PrepareStage implements Stage {
  readonly id: "prepare" | "practice";
  private readonly isPractice: boolean;

  private bg1p: LoadedSheet | null = null;
  private bg2p: LoadedSheet | null = null;
  private bgLadder1p: LoadedSheet | null = null;
  private bgLadder2p: LoadedSheet | null = null;
  private bgGuild1p: LoadedSheet | null = null;
  private bgGuild2p: LoadedSheet | null = null;
  private closeSlotSheet: LoadedSheet | null = null;
  private openSlotSheet: LoadedSheet | null = null;
  private selBomberSheet: LoadedSheet | null = null;
  private selRandSheet: LoadedSheet | null = null;
  private imgTeamSheet: LoadedSheet | null = null;
  private imgTeam4Sheet: LoadedSheet | null = null;
  private prepImgSheet: LoadedSheet | null = null;
  private img1PSheet: LoadedSheet | null = null;
  private img2PSheet: LoadedSheet | null = null;
  private titlePracticeSheet: LoadedSheet | null = null;
  private btLvUpSheet: LoadedSheet | null = null;
  private btLvDnSheet: LoadedSheet | null = null;
  private gameModeImgSheet: LoadedSheet | null = null;
  private killImageSheet: LoadedSheet | null = null;
  private specialRoomCharSheet: LoadedSheet | null = null;
  private newMapIconSheet: LoadedSheet | null = null;
  private bonusPrepareSheet: LoadedSheet | null = null;
  private smallLdSheet: LoadedSheet | null = null;
  private guildIconSheet: LoadedSheet | null = null;
  private balloonSheet: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private mapThumbSheet: LoadedSheet | null = null;
  private mapThumbPath = "";

  private readonly btChange: SpriteButton;
  private readonly btSelMap: SpriteButton;
  private readonly btStart: SpriteButton;
  private readonly btReady: SpriteButton;
  private readonly btShop: SpriteButton;
  private readonly btSpeaker: SpriteButton;
  private readonly bomberBtns: SpriteButton[] = [];
  private readonly btRandBomber: SpriteButton;

  private readonly chatScroll: SpriteScrollBar;
  private readonly chatView: SpriteMsgView;
  private readonly edWhisper: WebGpuEditBox;
  private readonly edChat: WebGpuEditBox;
  private readonly whisperLog: SpriteWhisperLog;

  private readonly cache = new CharacterPreviewCache();
  private readonly itemBoxWheel: SpriteItemBoxWheel;
  private readonly slotBubbles = new Map<number, { text: string; untilMs: number }>();
  private readonly slotEmotions = new Map<number, { pose: number; untilMs: number }>();
  private readonly seenOccupants = new Set<string>();
  private hoveredBomberCode: number | null = null;
  private attrViewerSlide = 0;

  // Offline Practice Room state (`CPrepareStagePractice`)
  private pracMapIdx = -1;
  private pracMode: GameModeId = 0;
  private readonly pracSlots: PracticeSlot[] = [];

  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext, isPractice: boolean) {
    this.ctx = ctx;
    this.isPractice = isPractice;
    this.id = isPractice ? "practice" : "prepare";

    this.initPracticeSlots();
    this.itemBoxWheel = new SpriteItemBoxWheel(this.cache, (entry) => {
      const mySlot = this.isPractice ? 0 : this.ctx.hub.mySlot;
      if (mySlot >= 0) {
        this.slotEmotions.set(mySlot, { pose: entry.pose, untilMs: performance.now() + 3200 });
        if (!this.isPractice) {
          const cmds = ["/hi", "/哭", "/怒", "/笑", "/加油", "/羞", "/特", "/愛"];
          this.ctx.hub.send({ type: "chat_send", text: cmds[(entry.pose - 3 + cmds.length) % cmds.length] ?? "/笑" });
        }
      }
    });

    this.btChange = new SpriteButton(357, 19, () => this.cycleMode());
    this.btSelMap = new SpriteButton(495, 320, () => this.openMapSelect());
    this.btStart = new SpriteButton(568, 510, () => this.startMatch());
    this.btReady = new SpriteButton(568, 510, () => {
      this.ctx.hub.send({ type: "room_toggle_ready" });
    });
    // Exact `CA.exe.c:129337..129350`: `Prepare/BtShop` (`70x21`, 5f) at `(475, 573)`!
    this.btShop = new SpriteButton(475, 573, () => {
      if (this.isPractice) {
        this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", ["單機練習室無法進入商城，請於大廳開啟商城！"]));
        return;
      }
      this.ctx.hub.send({ type: "leave_room" });
      void this.ctx.goto("shop");
    });
    this.btSpeaker = new SpriteButton(413, 527, () => {
      if (!this.isPractice) {
        this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub));
      }
    });

    BOMBER_SLOTS.forEach(([bx, by], idx) => {
      const charCode = CHAR_MAIN_MAP[idx] ?? idx;
      const btn = new SpriteButton(bx, by, () => this.pickBomber(charCode), { isTab: true });
      this.bomberBtns.push(btn);
    });
    this.btRandBomber = new SpriteButton(587, 122, () => this.pickBomber(-1), { isTab: true });

    this.chatScroll = new SpriteScrollBar(436, 360, 18, 166);
    this.chatView = new SpriteMsgView(36, 370, 390, 149, this.chatScroll);

    this.edWhisper = new WebGpuEditBox({
      x: 38,
      y: 535,
      w: 74,
      h: 12,
      maxLength: 16,
      textColor: [0.06, 0.24, 0.12, 1],
      onTab: () => this.edChat.focus(),
      onEnter: () => this.edChat.focus(),
    });
    this.edChat = new WebGpuEditBox({
      x: 151,
      y: 535,
      w: 250,
      h: 12,
      maxLength: 80,
      textColor: [0.05, 0.08, 0.16, 1],
      onTab: () => this.edWhisper.focus(),
      onEnter: () => this.sendChat(),
    });
    this.whisperLog = new SpriteWhisperLog(112, 529, (target) => {
      this.edWhisper.value = target;
      this.edChat.focus();
    });
  }

  private roomPeerNames(): string[] {
    const out: string[] = [];
    for (const sl of this.ctx.hub.currentRoom?.slots ?? []) {
      if (sl.occupied && !sl.isAi && sl.nickname) out.push(sl.nickname);
    }
    return out;
  }

  private initPracticeSlots(): void {
    this.pracSlots.length = 0;
    const dual = this.ctx.hub.dual2P;
    for (let i = 0; i < 8; i++) {
      if (i === 0) {
        this.pracSlots.push({
          open: true,
          isHuman: true,
          is2P: false,
          isAi: false,
          aiLevel: 2,
          charCode: this.ctx.hub.profile?.selectedChar ?? 0,
          team: 0,
        });
      } else if (i === 1 && dual) {
        this.pracSlots.push({
          open: true,
          isHuman: true,
          is2P: true,
          isAi: false,
          aiLevel: 2,
          charCode: 1,
          team: 0,
        });
      } else if (i <= 3) {
        this.pracSlots.push({
          open: true,
          isHuman: false,
          is2P: false,
          isAi: true,
          aiLevel: 2,
          charCode: i % 8,
          team: i % 2 === 0 ? 0 : 1,
        });
      } else {
        this.pracSlots.push({
          open: false,
          isHuman: false,
          is2P: false,
          isAi: false,
          aiLevel: 2,
          charCode: i % 8,
          team: i % 2,
        });
      }
    }
  }

  async enter(): Promise<void> {
    this.ctx.sound.playBgm("StagePrepare");
    await this.ctx.globalBar.load(this.ctx.assets);

    if (this.isPractice) {
      this.initPracticeSlots();
    }

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      await assets.fx.prefetch([
        "Prepare/CAStage",
        "Prepare/CAStage2p",
        "Prepare/BtChange",
        "Prepare/BtCloseSlot",
        "Prepare/BtOpenSlot",
        "Prepare/BtSelBomber",
        "Prepare/BtSelRandBomber",
        "Prepare/BtSelMap",
        "Prepare/BtStart",
        "Prepare/BtReady",
        "Prepare/ImgTeam",
        "Prepare/ImgTeam_4",
        "Prepare/PrepareImg",
        "Prepare/Img1P",
        "Prepare/Img2P",
        "PraticePrepare/TitlePractice",
        "PraticePrepare/Bt_LevelUp",
        "PraticePrepare/Bt_LevelDown",
        "Dialog/BtSpeaker_Speaker",
      ]);
      const [bg1, bg2, bgL1, bgL2, bgG1, bgG2, chg, cs, os, sb, sr, sm, st, rd, bsh, tm, tm4, pimg, i1p, i2p, tp, lu, ld, sp, bal, lv, gmi, ki, src, nmi, bPrep, sLd, gIco] =
        await Promise.all([
          assets.loadSheet("Fx", "Prepare/CAStage"),
          assets.loadSheet("Fx", "Prepare/CAStage2p"),
          assets.loadSheet("Fx", "Prepare/CAStageLadder"),
          assets.loadSheet("Fx", "Prepare/CAStageLadder2p"),
          assets.loadSheet("Fx", "Prepare/CAStageGuild"),
          assets.loadSheet("Fx", "Prepare/CAStageGuild2p"),
          assets.loadSheet("Fx", "Prepare/BtChange"),
          assets.loadSheet("Fx", "Prepare/BtCloseSlot"),
          assets.loadSheet("Fx", "Prepare/BtOpenSlot"),
          assets.loadSheet("Fx", "Prepare/BtSelBomber"),
          assets.loadSheet("Fx", "Prepare/BtSelRandBomber"),
          assets.loadSheet("Fx", "Prepare/BtSelMap"),
          assets.loadSheet("Fx", "Prepare/BtStart"),
          assets.loadSheet("Fx", "Prepare/BtReady"),
          assets.loadSheet("Fx", "Prepare/BtShop"),
          assets.loadSheet("Fx", "Prepare/ImgTeam"),
          assets.loadSheet("Fx", "Prepare/ImgTeam_4"),
          assets.loadSheet("Fx", "Prepare/PrepareImg"),
          assets.loadSheet("Fx", "Prepare/Img1P"),
          assets.loadSheet("Fx", "Prepare/Img2P"),
          assets.loadSheet("Fx", "PraticePrepare/TitlePractice"),
          assets.loadSheet("Fx", "PraticePrepare/Bt_LevelUp"),
          assets.loadSheet("Fx", "PraticePrepare/Bt_LevelDown"),
          assets.loadSheet("Fx", "Dialog/BtSpeaker_Speaker"),
          assets.loadSheet("Cx", "Etc/ChatBalloon"),
          assets.loadSheet("Cx", "Etc/LevelIcons"),
          assets.loadSheet("Fx", "Etc/GameModeImg"),
          assets.loadSheet("Fx", "Game/Kill_Image"),
          assets.loadSheet("Fx", "Etc/SpecialRoomChar"),
          assets.loadSheet("Fx", "Theme/Newmap_Icon"),
          assets.loadSheet("Fx", "Bonus/Prepare"),
          assets.loadSheet("Fx", "Ladder/Small_LD"),
          assets.loadSheet("Fx", "Etc/GuildIcon"),
          this.chatScroll.load(assets),
          this.whisperLog.load(assets),
          this.itemBoxWheel.load(assets),
        ]);
      this.bg1p = bg1;
      this.bg2p = bg2;
      this.bgLadder1p = bgL1;
      this.bgLadder2p = bgL2;
      this.bgGuild1p = bgG1;
      this.bgGuild2p = bgG2;
      this.closeSlotSheet = cs;
      this.openSlotSheet = os;
      this.selBomberSheet = sb;
      this.selRandSheet = sr;
      this.imgTeamSheet = tm;
      this.imgTeam4Sheet = tm4;
      this.prepImgSheet = pimg;
      this.img1PSheet = i1p;
      this.img2PSheet = i2p;
      this.titlePracticeSheet = tp;
      this.btLvUpSheet = lu;
      this.btLvDnSheet = ld;
      this.balloonSheet = bal;
      this.levelSheet = lv;
      this.gameModeImgSheet = gmi;
      this.killImageSheet = ki;
      this.specialRoomCharSheet = src;
      this.newMapIconSheet = nmi;
      this.bonusPrepareSheet = bPrep;
      this.smallLdSheet = sLd;
      this.guildIconSheet = gIco;

      this.btChange.bindSheet(chg, 93, 26);
      this.btSelMap.bindSheet(sm, 66, 58);
      this.btStart.bindSheet(st, 135, 36);
      this.btReady.bindSheet(rd, 135, 36);
      this.btShop.bindSheet(bsh, 70, 21);
      this.btSpeaker.bindSheet(sp, 41, 28);
      for (const b of this.bomberBtns) b.bindSheet(sb, 93, 68);
      this.btRandBomber.bindSheet(sr, 93, 68);
    }

    this.refreshMapThumb();

    this.unsub?.();
    this.seenOccupants.clear();
    if (!this.isPractice) {
      this.unsub = this.ctx.hub.onMessage((msg) => {
        if (msg.type === "room_sync") {
          this.refreshMapThumb();
          const cos = this.ctx.assets.tables?.cosmetics;
          for (const sl of msg.room.slots) {
            if (!sl.occupied || sl.isAi) continue;
            const key = `${sl.slot}:${sl.username}`;
            if (!this.seenOccupants.has(key)) {
              this.seenOccupants.add(key);
              if (sl.fanfareStockId && cos) {
                for (const v of cos.expandVisuals(sl.fanfareStockId)) {
                  if (v.liveKind === "fanfare" && v.skinIndex !== undefined) {
                    const pad = String(v.skinIndex).padStart(3, "0");
                    this.ctx.sound.playSfx(`Wave/Fanfare${pad}`, 0.85, "EmoTE");
                    break;
                  }
                }
              }
            }
          }
        } else if (msg.type === "room_left") {
          void this.ctx.goto("lobby");
        } else if (msg.type === "match_start") {
          this.ctx.practiceConfig = null;
          void this.ctx.goto("game");
        } else if (msg.type === "chat_recv" && msg.slot !== undefined && msg.slot >= 0) {
          this.slotBubbles.set(msg.slot, { text: msg.text, untilMs: performance.now() + 4000 });
          const pose = inferChatEmotionPose(msg.text);
          if (pose > 0) {
            this.slotEmotions.set(msg.slot, { pose, untilMs: performance.now() + 3200 });
          }
        } else if (msg.type === "room_err") {
          this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", [msg.message]));
        }
      });

      // Retail `/ar` Auto-Ready (`CA.exe.c:75230`): auto-toggle ready if non-host and unready on enter!
      if (this.ctx.hub.autoReady) {
        const rm = this.ctx.hub.currentRoom;
        const mySl = rm?.slots[this.ctx.hub.mySlot];
        if (rm && mySl && rm.hostSlot !== this.ctx.hub.mySlot && !mySl.ready) {
          this.ctx.hub.send({ type: "room_toggle_ready" });
        }
      }
    }

    setTimeout(() => this.edChat.focus(), 30);
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
    imeHost.blur();
  }

  private currentMapIdx(): number {
    return this.isPractice ? this.pracMapIdx : (this.ctx.hub.currentRoom?.mapIndex ?? -1);
  }

  private isFourTeamMode(): boolean {
    const mode = this.isPractice ? this.pracMode : (this.ctx.hub.currentRoom?.mode ?? 0);
    const idx = this.currentMapIdx();
    const info = idx >= 0 ? (this.ctx.assets.tables?.playableMaps ?? []).find((m) => m.index === idx) : null;
    return mode === 1 || info?.art === "Monster";
  }

  private refreshMapThumb(): void {
    const idx = this.currentMapIdx();
    const allMaps = this.ctx.assets.tables?.mapInfo.maps ?? [];
    const info = idx >= 0 ? allMaps.find((m) => m.index === idx) : null;
    const art = info
      ? info.art && info.art !== "none"
        ? info.art
        : info.family || "Random"
      : "Random";
    const cand = `Theme/${art}`;
    if (cand === this.mapThumbPath) return;
    this.mapThumbPath = cand;
    void this.ctx.assets.loadSheet("Fx", cand).then((s) => {
      if (this.mapThumbPath === cand) this.mapThumbSheet = s;
    });
  }

  private isHost(): boolean {
    if (this.isPractice) return true;
    const rm = this.ctx.hub.currentRoom;
    return !!rm && rm.hostSlot === this.ctx.hub.mySlot;
  }

  private cycleMode(): void {
    if (!this.isHost()) return;
    if (this.isPractice) {
      const idx = MODES.indexOf(this.pracMode);
      this.pracMode = MODES[(idx + 1) % MODES.length]!;
    } else {
      const cur: GameModeId = this.ctx.hub.currentRoom?.mode ?? 0;
      const idx = MODES.indexOf(cur);
      this.ctx.hub.send({ type: "room_set_mode", mode: MODES[(idx + 1) % MODES.length]! });
    }
  }

  private openMapSelect(): void {
    if (!this.isHost()) return;
    this.ctx.dialogs.push(
      new MapSelectDlg(
        this.ctx.assets,
        this.currentMapIdx(),
        (mapIdx) => {
          if (this.isPractice) {
            this.pracMapIdx = mapIdx;
            this.refreshMapThumb();
          } else {
            this.ctx.hub.send({ type: "room_set_map", mapIndex: mapIdx });
          }
        },
        this.isPractice,
      ),
    );
  }

  private pickBomber(charIdx: number): void {
    if (this.isPractice) {
      this.pracSlots[0]!.charCode = charIdx;
    } else {
      this.ctx.hub.send({ type: "room_set_char", charCode: charIdx });
    }
  }

  private pickTeam(teamIdx: number): void {
    if (this.isPractice) {
      this.pracSlots[0]!.team = teamIdx;
    } else {
      this.ctx.hub.send({ type: "room_set_team", team: teamIdx });
    }
  }

  private startMatch(): void {
    if (this.isPractice) {
      const maps = this.ctx.assets.tables?.playableMaps ?? [];
      const allMaps = this.ctx.assets.tables?.mapInfo.maps ?? [];
      // The web version exposes every archived map, including in practice random.
      const defaultPool = maps;

      const selectedInfo = this.pracMapIdx >= 0 ? allMaps.find((m) => m.index === this.pracMapIdx) : null;
      let pickedCode = "Bula00";
      if (selectedInfo && !selectedInfo.random) {
        pickedCode = selectedInfo.name;
      } else if (selectedInfo && selectedInfo.random) {
        const famPool = maps.filter(
          (m) => selectedInfo.family === "Random" || m.family.toLowerCase() === selectedInfo.family.toLowerCase(),
        );
        const pool = famPool.length > 0 ? famPool : defaultPool;
        pickedCode = pool[Math.floor(Math.random() * Math.max(1, pool.length))]?.name ?? "Bula00";
      } else {
        pickedCode = defaultPool[Math.floor(Math.random() * Math.max(1, defaultPool.length))]?.name ?? "Bula00";
      }

      const p1 = this.pracSlots[0]!;
      const p2 = this.pracSlots[1]!;
      const bots = this.pracSlots
        .slice(1)
        .filter((s) => s.open && s.isAi)
        .map((s) => ({
          charIdx: s.charCode,
          team: s.team,
          aiLevel: s.aiLevel,
        }));

      if (!this.ctx.hub.dual2P && bots.length === 0) {
        bots.push({ charIdx: 1, team: (p1.team + 1) % 2, aiLevel: 2 });
      }

      this.ctx.practiceConfig = {
        mapCode: pickedCode,
        mode: this.pracMode,
        dual2P: this.ctx.hub.dual2P,
        player1Char: p1.charCode,
        player1Team: p1.team,
        player2Char: p2.charCode,
        player2Team: p2.team,
        bots,
      };
      void this.ctx.goto("game");
    } else {
      this.ctx.hub.send({ type: "room_start" });
    }
  }

  private sendChat(): void {
    const text = this.edChat.value.trim();
    if (!text) return;
    this.edChat.value = "";
    if (
      handleRetailSlashCommand(text, this.ctx.assets, this.ctx.hub, {
        onOpenUserInfo: (target) =>
          this.ctx.dialogs.push(
            new UserInfoDlg(this.ctx.assets, this.ctx.hub, target, (u) => {
              this.ctx.dialogs.push(new SmsFriendDlg(this.ctx.assets, this.ctx.hub, u));
            }),
          ),
        onSetWhisperTarget: (target) => {
          this.edWhisper.value = target;
        },
        onOpenShout: () => this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub)),
      })
    ) {
      // If `/ar` was just turned ON while unready in a room, apply immediately!
      if (!this.isPractice && this.ctx.hub.autoReady) {
        const rm = this.ctx.hub.currentRoom;
        const mySl = rm?.slots[this.ctx.hub.mySlot];
        if (rm && mySl && rm.hostSlot !== this.ctx.hub.mySlot && !mySl.ready) {
          this.ctx.hub.send({ type: "room_toggle_ready" });
        }
      }
      return;
    }
    const pose = inferChatEmotionPose(text);
    if (this.isPractice) {
      this.slotBubbles.set(0, { text, untilMs: performance.now() + 4000 });
      if (pose > 0) {
        this.slotEmotions.set(0, { pose, untilMs: performance.now() + 3200 });
      }
      this.ctx.hub.chatLog.push({
        kind: "chat",
        from: this.ctx.hub.profile?.nickname ?? "1P",
        text,
        timeMs: Date.now(),
      });
      return;
    }
    const whisperTo = this.edWhisper.value.trim();
    if (whisperTo.toLowerCase() === "a") {
      this.ctx.hub.send({ type: "chat_send", text: `/to a ${text}` });
    } else if (whisperTo) {
      this.ctx.hub.send({ type: "whisper_send", to: whisperTo, text });
    } else {
      this.ctx.hub.send({ type: "chat_send", text });
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === "F5") {
      e.preventDefault();
      if (this.isHost()) this.startMatch();
      else this.ctx.hub.send({ type: "room_toggle_ready" });
      return;
    }
    if (e.altKey && e.code >= "Digit1" && e.code <= "Digit8") {
      e.preventDefault();
      this.itemBoxWheel.open = false;
      const pose = Number(e.code.slice(5));
      const mySlot = this.isPractice ? 0 : this.ctx.hub.mySlot;
      if (mySlot >= 0) {
        this.slotEmotions.set(mySlot, { pose, untilMs: performance.now() + 3200 });
        if (!this.isPractice) {
          const cmds = ["/hi", "/笑", "/哭", "/怒", "/羞", "/加油", "/愛", "/特"];
          this.ctx.hub.send({ type: "chat_send", text: cmds[pose - 1] ?? "/笑" });
        }
      }
      return;
    }
    if (this.itemBoxWheel.onKeyDown(e)) {
      e.preventDefault();
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    this.itemBoxWheel.onKeyUp(e, this.ctx.assets, this.ctx.hub);
  }

  private activeButtons(): SpriteButton[] {
    const actionBtn = this.isHost() ? this.btStart : this.btReady;
    const base = [
      this.btChange,
      this.btSelMap,
      actionBtn,
      this.btSpeaker,
      ...this.bomberBtns,
      this.btRandBomber,
    ];
    if (!this.isPractice) base.push(this.btShop);
    return base;
  }

  tick(): void {
    const dual = this.ctx.hub.dual2P;
    const myChar = this.isPractice
      ? this.pracSlots[0]!.charCode
      : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.mySlot]?.charCode ?? 0);
    const p2Char = dual
      ? this.isPractice
        ? (this.pracSlots[1]?.charCode ?? -99)
        : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.slot2P]?.charCode ?? -99)
      : -99;
    this.bomberBtns.forEach((b, idx) => {
      const code = CHAR_MAIN_MAP[idx] ?? idx;
      b.toggled = myChar === code || p2Char === code;
    });
    this.btRandBomber.toggled = myChar < 0 || p2Char === -1;
    this.btChange.enabled = this.isHost();
    this.btSelMap.enabled = this.isHost();
    if (this.hoveredBomberCode !== null) {
      this.attrViewerSlide = Math.min(5, this.attrViewerSlide + 1);
    } else if (this.attrViewerSlide > 0) {
      this.attrViewerSlide = Math.max(0, this.attrViewerSlide - 1);
    }
  }

  onMouseMove(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseMove(mx, my)) return;
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    this.whisperLog.onMouseMove(mx, my, this.ctx.hub, this.roomPeerNames());
    for (const b of this.activeButtons()) b.onMouseMove(mx, my, this.ctx.sound);
    this.chatScroll.onMouseMove(mx, my);

    let nextHover: number | null = null;
    for (let i = 0; i < BOMBER_SLOTS.length; i++) {
      const [bx, by] = BOMBER_SLOTS[i]!;
      if (pointInRect(mx, my, { x: bx, y: by, w: 93, h: 68 })) {
        nextHover = CHAR_MAIN_MAP[i] ?? i;
        break;
      }
    }
    if (nextHover === null && pointInRect(mx, my, { x: 587, y: 122, w: 93, h: 68 })) {
      nextHover = -1; // Random / Super bomber (`PrepareImg[42]`)
    }
    if (nextHover !== this.hoveredBomberCode) {
      if (nextHover !== null && this.hoveredBomberCode === null) {
        this.attrViewerSlide = 1;
      }
      this.hoveredBomberCode = nextHover;
    }
  }

  onMouseDown(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseDown(mx, my, this.ctx.assets, this.ctx.hub)) return;
    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    if (this.whisperLog.onMouseDown(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    if (this.edWhisper.handleMouseDown(mx, my) || this.edChat.handleMouseDown(mx, my)) return;
    for (const b of this.activeButtons()) {
      if (b.onMouseDown(mx, my)) return;
    }
    if (this.chatScroll.onMouseDown(mx, my)) return;

    // `CTeamSelectWnd (490, 436, 287, 45)`:
    //   - 4-team mode (`0x615C48` `Prepare/ImgTeam_4`): 4 wide flags at `(495 + 70*i, 441, 69, 37)` -> `[0, 3, 5, 6]`
    //   - 8-team mode (`0x615BC8` `Prepare/ImgTeam`): 8 flags at `(494 + 35*i, 440, 34, 37)` -> `0..7`
    if (this.isFourTeamMode()) {
      const team4 = [0, 3, 5, 6] as const;
      for (let i = 0; i < 4; i++) {
        if (pointInRect(mx, my, { x: 495 + i * 70, y: 441, w: 69, h: 37 })) {
          this.ctx.sound.playSfx("ButtonDown_0", 0.6);
          this.pickTeam(team4[i]!);
          return;
        }
      }
    } else {
      for (let t = 0; t < 8; t++) {
        if (pointInRect(mx, my, { x: 494 + t * 35, y: 440, w: 34, h: 37 })) {
          this.ctx.sound.playSfx("ButtonDown_0", 0.6);
          this.pickTeam(t);
          return;
        }
      }
    }

    // 8 Player Slots `[[37,110]..[346,210]]` (`98x98`)
    for (let i = 0; i < 8; i++) {
      const [sx, sy] = PLAYER_SLOTS[i]!;
      if (!pointInRect(mx, my, { x: sx, y: sy, w: 98, h: 98 })) continue;
      this.ctx.sound.playSfx("ButtonDown_0", 0.55);

      if (this.isPractice) {
        if (i === 0) return;
        const ps = this.pracSlots[i]!;
        if (ps.open && ps.isAi) {
          if (pointInRect(mx, my, { x: sx + 70, y: sy + 33, w: 22, h: 19 })) {
            ps.aiLevel = Math.min(3, ps.aiLevel + 1) as 1 | 2 | 3;
            return;
          }
          if (pointInRect(mx, my, { x: sx + 70, y: sy + 74, w: 22, h: 19 })) {
            ps.aiLevel = Math.max(1, ps.aiLevel - 1) as 1 | 2 | 3;
            return;
          }
        }
        if (ps.is2P) return;
        ps.open = !ps.open;
        ps.isAi = ps.open;
        return;
      } else {
        const rm = this.ctx.hub.currentRoom;
        const sl = rm?.slots[i];
        if (!sl) return;
        if (sl.occupied && !sl.isAi && sl.username) {
          if (this.isHost() && i !== this.ctx.hub.mySlot && mx > sx + 72 && my < sy + 24) {
            this.ctx.hub.send({ type: "room_kick", slot: i });
          } else {
            this.ctx.dialogs.push(
              new UserInfoDlg(this.ctx.assets, this.ctx.hub, sl.username, (u) => {
                this.ctx.dialogs.push(new SmsFriendDlg(this.ctx.assets, this.ctx.hub, u));
              }),
            );
          }
        } else if (this.isHost()) {
          this.ctx.hub.send({ type: "room_toggle_slot", slot: i });
        }
        return;
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.whisperLog.onMouseUp(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    for (const b of this.activeButtons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
    this.chatScroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onWheel(deltaY: number): void {
    this.chatScroll.scrollBy(deltaY > 0 ? 2 : -2);
  }

  render(r: SpriteRenderer, nowMs: number): void {
    const dual = this.ctx.hub.dual2P;
    const curRoom = this.isPractice ? null : this.ctx.hub.currentRoom;
    // Exact `CA.exe.c:105398..105403` & `107673..107679`: Ladder (`CAStageLadder`) vs Guild (`CAStageGuild`) vs Standard (`CAStage`)!
    let bg = dual && this.bg2p ? this.bg2p : this.bg1p;
    if (curRoom?.kind === "guild") {
      if (curRoom.guildType === 1) {
        bg = (dual ? this.bgGuild2p : this.bgGuild1p) ?? bg;
      } else {
        bg = (dual ? this.bgLadder2p : this.bgLadder1p) ?? bg;
      }
    }
    drawSheetFrame(r, bg, 0, 0, 0, { w: 800, h: 600 });

    const tick = Math.floor(nowMs / 30);

    // Top room title / Practice banner (`CA.exe.c:104215..104264, 108262`: digits `(91,58)`, title `(135,57)`, lock `(377,52)`, mode `(400,52)`, manner `(423,52)`)
    if (this.isPractice) {
      drawSheetFrame(r, this.titlePracticeSheet, 0, 32, 16);
      const modeIcon = gameKillModeIconFrame(this.pracMode);
      if (modeIcon !== null && this.killImageSheet) {
        drawSheetFrame(r, this.killImageSheet, modeIcon, 400, 52);
      }
      if (this.gameModeImgSheet) {
        drawSheetFrame(r, this.gameModeImgSheet, 1, 423, 52);
      }
      r.drawText(`${MODE_NAMES[this.pracMode]}`, 268, 25, {
        color: [1, 0.96, 0.65, 1],
        outlineColor: [0.04, 0.14, 0.34, 0.95],
      });
    } else if (this.ctx.hub.currentRoom) {
      const rm = this.ctx.hub.currentRoom;
      if (this.prepImgSheet) {
        if (rm.id >= 10000 && this.specialRoomCharSheet) {
          drawSheetFrame(r, this.specialRoomCharSheet, 0, 29, 63);
          drawSpriteDigits(r, this.prepImgSheet, 104, 58, 13, 2, rm.id - 10000, 0);
        } else {
          drawSpriteDigits(r, this.prepImgSheet, 91, 58, 13, 3, rm.id, 0);
        }
        if (rm.hasPassword) drawSheetFrame(r, this.prepImgSheet, 41, 377, 52);
      }
      const modeIcon = gameKillModeIconFrame(rm.mode);
      if (modeIcon !== null && this.killImageSheet) {
        drawSheetFrame(r, this.killImageSheet, modeIcon, 400, 52);
      }
      if (this.gameModeImgSheet) {
        drawSheetFrame(r, this.gameModeImgSheet, rm.manner === false ? 1 : 0, 423, 52);
      }
      r.drawText(rm.title, 135, 57, {
        color: [0, 0.36, 0.64, 1],
      });
      r.drawText(MODE_NAMES[rm.mode], 282, 25, {
        color: [0.85, 0.95, 1, 1],
        outlineColor: [0.04, 0.14, 0.34, 0.95],
      });
    }

    // 8 Player Slots `[[26..374, 82|213]]` (`CA.exe` `CGameSlot` `L60998..61058`)
    for (let i = 0; i < 8; i++) {
      const [sx, sy] = PLAYER_SLOTS[i]!;
      if (this.isPractice) {
        const ps = this.pracSlots[i]!;
        if (!ps.open) {
          drawSheetFrame(r, this.closeSlotSheet, 0, sx, sy);
          continue;
        }
        drawSheetFrame(r, this.openSlotSheet, 0, sx, sy);
        const eq = this.ctx.hub.profile?.equipped;
        const pStocks =
          i === 0 && eq
            ? [
                ...(eq.slotDecoStockIds ?? [eq.slotDecoStockId]),
                eq.fanfareStockId,
                ...(eq.charDecoStockIds ?? [eq.hatStockId]),
                eq.idDecoStockId,
              ].filter((x) => x > 0)
            : [];
        const hasSlotBg =
          pStocks.length > 0 &&
          this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pStocks, "back", sx, sy, tick);
        if (pStocks.length > 0) {
          this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pStocks, "idDeco", sx, sy, tick);
        }
        const teamOne = (ps.team % 8) + 1;
        if (ps.charCode < 0 && this.prepImgSheet) {
          drawSheetFrame(r, this.prepImgSheet, 19, sx + 34, sy + 32);
        } else {
          const emo = this.slotEmotions.get(i);
          const activeEmo = emo && nowMs < emo.untilMs ? { pose: emo.pose } : undefined;
          this.cache.drawDisplayBomber(
            r,
            this.ctx.assets,
            ps.charCode,
            teamOne,
            hasSlotBg ? sx + 32 : sx + 49,
            hasSlotBg ? sy + 94 : sy + 72,
            tick,
            false,
            pStocks,
            activeEmo,
          );
        }
        if (pStocks.length > 0) {
          this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pStocks, "front", sx, sy, tick);
        }
        if (this.prepImgSheet) {
          drawSheetFrame(r, this.prepImgSheet, 12, sx + 6, sy + 10, { tint: [1, 1, 1, 0.78] });
        }
        drawSheetFrame(r, this.imgTeamSheet, ps.team * 5, sx + 62, sy + 4);
        if (dual && i === 0 && this.img1PSheet) drawSheetFrame(r, this.img1PSheet, 0, sx, sy + 80);
        else if (dual && ps.is2P && this.img2PSheet) drawSheetFrame(r, this.img2PSheet, 0, sx, sy + 80);
        const name =
          i === 0
            ? (this.ctx.hub.profile?.nickname ?? "1P玩家")
            : ps.is2P
              ? "2P同機"
              : `電腦Lv.${ps.aiLevel}`;
        r.drawText(name.slice(0, 8), sx + 49, sy + 14, {
          align: "center",
          color: [1, 1, 1, 1],
          outlineColor: [0.04, 0.12, 0.28, 0.9],
        });
        if (ps.isAi) {
          drawSheetFrame(r, this.btLvUpSheet, 0, sx + 70, sy + 33);
          drawSheetFrame(r, this.btLvDnSheet, 0, sx + 70, sy + 76);
        }
      } else {
        const sl = this.ctx.hub.currentRoom?.slots[i];
        if (!sl || !sl.open) {
          drawSheetFrame(r, this.closeSlotSheet, 0, sx, sy);
          continue;
        }
        drawSheetFrame(r, this.openSlotSheet, 0, sx, sy);
        if (sl.occupied) {
          const sStocks = [
            ...(sl.slotDecoStockIds ?? [sl.slotDecoStockId]),
            sl.fanfareStockId ?? 0,
            ...(sl.charDecoStockIds ?? [sl.hatStockId]),
            sl.idDecoStockId ?? 0,
          ].filter((x) => x > 0);
          const hasSlotBg = this.cache.drawSlotCosmeticsForStocks(
            r,
            this.ctx.assets,
            sStocks,
            "back",
            sx,
            sy,
            tick,
          );
          this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, sStocks, "idDeco", sx, sy, tick);
          const teamOne = (sl.team % 8) + 1;
          if (sl.charCode < 0 && this.prepImgSheet) {
            drawSheetFrame(r, this.prepImgSheet, 19, sx + 34, sy + 32);
          } else {
            const emo = this.slotEmotions.get(i);
            const activePose = emo && nowMs < emo.untilMs ? emo.pose : sl.emotionPose;
            this.cache.drawDisplayBomber(
              r,
              this.ctx.assets,
              sl.charCode,
              teamOne,
              hasSlotBg ? sx + 32 : sx + 49,
              hasSlotBg ? sy + 94 : sy + 72,
              tick,
              false,
              sStocks,
              activePose > 0 ? { pose: activePose } : undefined,
            );
          }
          this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, sStocks, "front", sx, sy, tick);
          if (this.prepImgSheet) {
            drawSheetFrame(r, this.prepImgSheet, sl.isHost ? 13 : 12, sx + 6, sy + 10, { tint: [1, 1, 1, 0.78] });
          }
          drawLevelIcon(
            r,
            this.levelSheet,
            sl.level,
            sx + 8,
            sy + 13,
            this.cache.getTwinkleSheet(this.ctx.assets, sl.levelEffectIdx),
            tick,
            this.cache.getRotateSheet(this.ctx.assets, sl.levelEffectIdx),
          );
          if (this.ctx.hub.currentRoom?.kind === "guild") {
            const ldTier = Math.max(0, Math.min(8, Math.floor((sl.level - 1) / 30)));
            drawSheetFrame(r, this.smallLdSheet, ldTier, sx + 22, sy + 13);
            drawSheetFrame(r, this.guildIconSheet, 0, sx + 4, sy + 80);
          }
          drawSheetFrame(r, this.imgTeamSheet, (sl.team % 8) * 5, sx + 62, sy + 4);
          r.drawText(sl.nickname.slice(0, 8), sx + 54, sy + 14, {
            align: "center",
            color: [1, 1, 1, 1],
            outlineColor: [0.04, 0.12, 0.28, 0.9],
          });
          if (this.prepImgSheet && (sl.isHost || sl.ready)) {
            drawSheetFrame(r, this.prepImgSheet, sl.isHost ? 10 : 11, sx + 12, sy + 82);
          }
        }
      }

      const bub = this.slotBubbles.get(i);
      if (bub && nowMs < bub.untilMs && this.ctx.hub.showSpeechBalloons) {
        drawSpeechBubble(r, this.balloonSheet, bub.text, sx + 49, sy + 16);
      }
    }

    // 8 Bomber Select Buttons (`CBomberSelectWnd` `CA.exe.c` `L109883..110032`: `CHAR_MAIN_MAP` + `1P`/`2P` badge)
    const p1Char = this.isPractice
      ? this.pracSlots[0]!.charCode
      : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.mySlot]?.charCode ?? 0);
    const p2Char = dual
      ? this.isPractice
        ? (this.pracSlots[1]?.charCode ?? 1)
        : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.slot2P]?.charCode ?? -99)
      : -99;
    const p1TeamOne =
      ((this.isPractice
        ? this.pracSlots[0]!.team
        : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.mySlot]?.team ?? 0)) %
        8) +
      1;

    this.bomberBtns.forEach((btn, idx) => {
      const charCode = CHAR_MAIN_MAP[idx] ?? idx;
      const sel1 = p1Char === charCode;
      const sel2 = dual && p2Char === charCode;
      btn.toggled = sel1 || sel2;
      btn.render(r);
      this.cache.drawDisplayBomber(
        r,
        this.ctx.assets,
        charCode,
        sel1 || sel2 ? p1TeamOne : 1,
        btn.x + 47,
        btn.y + 58,
        tick,
        true,
      );
      if (this.imgTeamSheet) {
        if (sel1 && sel2) drawSheetFrame(r, this.imgTeamSheet, 42, btn.x + 64, btn.y + 33);
        else if (sel1) drawSheetFrame(r, this.imgTeamSheet, 40, btn.x + 64, btn.y + 33);
        else if (sel2) drawSheetFrame(r, this.imgTeamSheet, 41, btn.x + 64, btn.y + 33);
      }
    });
    const randSel1 = p1Char < 0;
    const randSel2 = dual && p2Char < 0 && p2Char !== -99;
    this.btRandBomber.toggled = randSel1 || randSel2;
    this.btRandBomber.render(r);
    if (this.imgTeamSheet) {
      if (randSel1 && randSel2) drawSheetFrame(r, this.imgTeamSheet, 42, 651, 155);
      else if (randSel1) drawSheetFrame(r, this.imgTeamSheet, 40, 651, 155);
      else if (randSel2) drawSheetFrame(r, this.imgTeamSheet, 41, 651, 155);
    }

    // Retail `CBomberAttrViewer::sub_47D471` (`CA.exe.c:109160..109425`):
    // Sliding `159x79` (`PrepareImg[17]`) or `159x130` (`PrepareImg[42]`) character stat drawer at `(320, 45)`!
    if (this.hoveredBomberCode !== null && this.attrViewerSlide > 0 && this.prepImgSheet) {
      const slideFrac = this.attrViewerSlide / 5;
      const dxSlide = Math.round(79 - 79 * slideFrac);
      const cardX = 320 + dxSlide;
      const cardY = 45;
      const isRand = this.hoveredBomberCode < 0;
      drawSheetFrame(r, this.prepImgSheet, isRand ? 42 : 17, cardX, cardY);

      const spec = !isRand
        ? this.ctx.assets.tables?.bomberByCode.get(this.hoveredBomberCode)
        : this.ctx.assets.tables?.bomberByCode.get(0);
      if (!isRand && this.hoveredBomberCode >= 0 && this.hoveredBomberCode <= 7) {
        drawSheetFrame(r, this.prepImgSheet, 20 + this.hoveredBomberCode, cardX + 51, cardY + 9);
      } else if (isRand) {
        r.drawText("隨機角色 / 超人", cardX + 51, cardY + 9, {
          color: [0.06, 0.16, 0.32, 1],
        });
      }

      if (spec) {
        const bMaxW = Math.round(((100 * Math.min(10, spec.bombMax)) / 10) * slideFrac);
        const bMinW = Math.round(((100 * Math.min(10, spec.bombMin)) / 10) * slideFrac);
        const pMaxW = Math.round(((100 * Math.min(10, spec.powerMax)) / 10) * slideFrac);
        const pMinW = Math.round(((100 * Math.min(10, spec.powerMin)) / 10) * slideFrac);
        const sMaxW = Math.round(((100 * Math.min(10, spec.speedMax)) / 10) * slideFrac);
        const sMinW = Math.round(((100 * Math.min(10, spec.speedMin)) / 10) * slideFrac);

        // Exact `CA.exe.c:109235..109415` green gradient bars (`#EEFEE4`, `#C3E896`, `#83D213`, `#1C9B00`)
        r.fillRect(cardX + 54, cardY + 26, bMaxW, 11, [0.765, 0.91, 0.588, 1]);
        r.fillRect(cardX + 54, cardY + 26, bMinW, 11, [0.933, 0.996, 0.894, 1]);
        r.fillRect(cardX + 54, cardY + 40, pMaxW, 11, [0.514, 0.824, 0.075, 1]);
        r.fillRect(cardX + 54, cardY + 40, pMinW, 11, [0.765, 0.91, 0.588, 1]);
        r.fillRect(cardX + 54, cardY + 54, sMaxW, 11, [0.11, 0.608, 0.0, 1]);
        r.fillRect(cardX + 54, cardY + 54, sMinW, 11, [0.514, 0.824, 0.075, 1]);
      }

      if (isRand) {
        const superSpec = this.ctx.assets.tables?.bomberByCode.get(9) ?? this.ctx.assets.tables?.bomberByCode.get(8);
        if (superSpec) {
          const sbMax = Math.round(((100 * Math.min(10, superSpec.bombMax)) / 10) * slideFrac);
          const spMax = Math.round(((100 * Math.min(10, superSpec.powerMax)) / 10) * slideFrac);
          const ssMax = Math.round(((100 * Math.min(10, superSpec.speedMax)) / 10) * slideFrac);
          // Exact `CA.exe.c:109250` Super gold/orange bars (`#FFDA2D`, `#FFB400`, `#FA7A00`)
          r.fillRect(cardX + 54, cardY + 77, sbMax, 11, [1.0, 0.855, 0.176, 1]);
          r.fillRect(cardX + 54, cardY + 91, spMax, 11, [1.0, 0.706, 0.0, 1]);
          r.fillRect(cardX + 54, cardY + 105, ssMax, 11, [0.98, 0.478, 0.0, 1]);
        }
      }
    }

    // Exact `CA.exe` `L105744..105749`: `Theme/<art>` (`84x65`) at `(587, 316)`, map title at `(678, 326)`
    if (this.mapThumbSheet) {
      drawSheetFrame(r, this.mapThumbSheet, 0, 587, 316);
    }
    const mapIdx = this.currentMapIdx();
    const foundMap =
      mapIdx >= 0 ? (this.ctx.assets.tables?.playableMaps ?? []).find((m) => m.index === mapIdx) : null;
    if (foundMap?.isNew && this.newMapIconSheet) {
      drawSheetFrame(r, this.newMapIconSheet, 0, 668, 328);
    }
    const mapLabel = foundMap ? foundMap.description || foundMap.name : "隨機地圖";
    r.drawText(mapLabel.slice(0, 12), 678, 326, {
      color: [0.06, 0.14, 0.28, 1],
    });
    const maxStr = this.ctx.assets.tables?.sysStrings.get("Max") ?? "人數上限";
    r.drawText(`${maxStr} :${foundMap ? "8" : "??"}`, 678, 358, {
      color: [0.16, 0.28, 0.44, 1],
    });

    // `CTeamSelectWnd (490, 436, 287, 45)` or `CA.exe.c:106036..106046` `Bonus/Prepare` (`25f` `295x79` at `(487, 408)`)!
    const isBonusMap = Boolean(
      foundMap && (foundMap.family.toLowerCase() === "bonus" || foundMap.name.toLowerCase().startsWith("bonus")),
    );
    const myTeam = this.isPractice
      ? this.pracSlots[0]!.team
      : (this.ctx.hub.currentRoom?.slots[this.ctx.hub.mySlot]?.team ?? 0);
    if (isBonusMap && this.bonusPrepareSheet) {
      drawSheetFrame(r, this.bonusPrepareSheet, Math.floor(nowMs / 80) % 25, 487, 408);
    } else if (this.isFourTeamMode() && this.imgTeam4Sheet) {
      const team4 = [0, 3, 5, 6] as const;
      for (let i = 0; i < 4; i++) {
        const base = i * 5;
        const frame = myTeam === team4[i] ? base + 1 : base;
        drawSheetFrame(r, this.imgTeam4Sheet, frame, 495 + i * 70, 441);
      }
    } else {
      for (let t = 0; t < 8; t++) {
        const base = t * 5;
        const frame = myTeam === t ? base + 1 : base;
        drawSheetFrame(r, this.imgTeamSheet, frame, 494 + t * 35, 440);
      }
    }

    // Chat `CCtrlMsgView` + Edit wells
    this.chatView.syncChatLog(r, this.ctx.hub.chatLog, false);
    this.chatView.render(r);
    this.edWhisper.render(r, nowMs);
    this.edChat.render(r, nowMs);

    this.btChange.render(r);
    this.btSelMap.render(r);
    (this.isHost() ? this.btStart : this.btReady).render(r);
    this.btSpeaker.render(r);
    this.whisperLog.render(r, this.ctx.hub, this.roomPeerNames());

    const myIdx = Math.max(0, Math.min(7, this.isPractice ? 0 : this.ctx.hub.mySlot));
    const [mySx, mySy] = PLAYER_SLOTS[myIdx] ?? [37, 110];
    this.itemBoxWheel.render(r, this.ctx.assets, this.ctx.hub, mySx + 49, mySy + 56);

    this.ctx.globalBar.render(r, this.ctx.hub);
    if (!this.isPractice) this.btShop.render(r);
  }
}
