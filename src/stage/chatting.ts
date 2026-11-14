// Stage 17: `CChattingStage` (`src/stage/chatting.ts`).
// Strictly implements `CA.exe` `CChattingStage` (`Fx:Chatting/*`):
//   - `Chatting/CAStage` (`800x600` JPEG) / `Chatting/CAStage2P`
//   - 8 Avatar Slots: `[[53,88],[172,88],[291,88],[410,88],[529,88],[648,88],[53,217],[172,217]]`
//   - `Chatting/BtCharacterLeft (+12, +99)`, `BtCharacterRight (+49, +99)`, `BtAskExchange (+12, +99)`
//   - `CInventoryWndNew (510, 408)` 8-slot bag (`sub_4CBFF0` `L79214`)
//   - Chat: `CCtrlMsgView (36, 370, 404, 148)`, `VScroll (448, 360, 18, 166)`,
//     `Whisper (42, 535, 74, 12)`, `Edit (151, 535, 258, 12)`, `Dialog/BtSpeaker_Speaker (422, 527)`
//   - `CGlobalButtonDlg (0, 566)`

import { CHAR_MAIN_MAP, type LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import {
  CharacterPreviewCache,
  InventoryWndNew,
  SpriteButton,
  SpriteItemBoxWheel,
  SpriteMsgView,
  SpriteScrollBar,
  SpriteWhisperLog,
  drawLevelIcon,
  drawSheetFrame,
  drawSpeechBubble,
  drawSpriteDigits,
  handleRetailSlashCommand,
  inferChatEmotionPose,
  pointInRect,
} from "../ui/widgets.ts";
import { ShoutDlg, SmsFriendDlg, UserInfoDlg } from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

const CHAT_SLOTS: readonly [number, number][] = [
  [53, 88],
  [172, 88],
  [291, 88],
  [410, 88],
  [529, 88],
  [648, 88],
  [53, 217],
  [172, 217],
  [291, 217],
  [410, 217],
  [529, 217],
  [648, 217],
];

export class ChattingStage implements Stage {
  readonly id = "chatting" as const;

  private bg: LoadedSheet | null = null;
  private bg2p: LoadedSheet | null = null;
  private btCharL: LoadedSheet | null = null;
  private btCharR: LoadedSheet | null = null;
  private btAskEx: LoadedSheet | null = null;
  private chattingImgSheet: LoadedSheet | null = null;
  private prepImgSheet: LoadedSheet | null = null;
  private balloonSheet: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private specialRoomCharSheet: LoadedSheet | null = null;
  private gameModeImgSheet: LoadedSheet | null = null;

  private readonly btSpeaker: SpriteButton;
  private readonly bag: InventoryWndNew;
  private readonly itemBoxWheel: SpriteItemBoxWheel;
  private readonly chatScroll: SpriteScrollBar;
  private readonly chatView: SpriteMsgView;
  private readonly edWhisper: WebGpuEditBox;
  private readonly edChat: WebGpuEditBox;
  private readonly whisperLog: SpriteWhisperLog;
  private hoveredAskSlot = -1;

  private readonly cache = new CharacterPreviewCache();
  private readonly slotBubbles = new Map<number, { text: string; untilMs: number }>();
  private readonly slotEmotions = new Map<number, { pose: number; untilMs: number }>();
  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;

    this.btSpeaker = new SpriteButton(422, 527, () => {
      this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub));
    });

    // Exact `sub_4CBFF0` `(510, 408)` 8-slot bag
    this.bag = new InventoryWndNew(510, 408, this.cache, 1, (invId) => {
      const row = this.ctx.hub.inventory.find((r) => r.invId === invId);
      if (!row) return;
      if (row.category === 3) {
        const cmds = ["/hi", "/哭", "/怒", "/笑", "/加油", "/羞", "/特", "/愛"];
        this.ctx.hub.send({ type: "chat_send", text: cmds[row.stockId % cmds.length] ?? "/笑" });
      } else {
        this.ctx.hub.send({ type: "item_equip", invId: row.invId, equip: !row.equipped });
      }
    });

    this.itemBoxWheel = new SpriteItemBoxWheel(this.cache, (entry) => {
      const cmds = ["/hi", "/哭", "/怒", "/笑", "/加油", "/羞", "/特", "/愛"];
      this.ctx.hub.send({ type: "chat_send", text: cmds[(entry.pose - 3 + cmds.length) % cmds.length] ?? "/笑" });
      if (this.ctx.hub.mySlot >= 0) {
        this.slotEmotions.set(this.ctx.hub.mySlot, { pose: entry.pose, untilMs: performance.now() + 3200 });
      }
    });

    // Exact `CA.exe.c:79160..79205`: `chatView (36, 386, 400, 133)`, `scroll (445, 377, 17, 148)`,
    // `edWhisper (33, 535, 74, 12)`, `whisperLog (108, 529)`, `edChat (146, 535, 250, 12)`.
    this.chatScroll = new SpriteScrollBar(445, 377, 17, 148);
    this.chatView = new SpriteMsgView(36, 386, 400, 133, this.chatScroll);

    this.edWhisper = new WebGpuEditBox({
      x: 33,
      y: 535,
      w: 74,
      h: 12,
      maxLength: 16,
      textColor: [0.06, 0.24, 0.12, 1],
      onTab: () => this.edChat.focus(),
      onEnter: () => this.edChat.focus(),
    });
    this.edChat = new WebGpuEditBox({
      x: 146,
      y: 535,
      w: 250,
      h: 12,
      maxLength: 80,
      textColor: [0.05, 0.08, 0.16, 1],
      onTab: () => this.edWhisper.focus(),
      onEnter: () => this.sendChat(),
    });
    this.whisperLog = new SpriteWhisperLog(108, 529, (target) => {
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

  async enter(): Promise<void> {
    this.ctx.sound.playBgm("StagePrepare");
    await this.ctx.globalBar.load(this.ctx.assets);

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      const [bg, bg2, cl, cr, ae, ci, pi, sp, bal, lv, specChar, gmi] = await Promise.all([
        assets.loadSheet("Fx", "Chatting/CAStage"),
        assets.loadSheet("Fx", "Chatting/CAStage2P"),
        assets.loadSheet("Fx", "Chatting/BtCharacterLeft"),
        assets.loadSheet("Fx", "Chatting/BtCharacterRight"),
        assets.loadSheet("Fx", "Chatting/BtAskExchange"),
        assets.loadSheet("Fx", "Chatting/ChattingImg"),
        assets.loadSheet("Fx", "Prepare/PrepareImg"),
        assets.loadSheet("Fx", "Dialog/BtSpeaker_Speaker"),
        assets.loadSheet("Cx", "Etc/ChatBalloon"),
        assets.loadSheet("Cx", "Etc/LevelIcons"),
        assets.loadSheet("Fx", "Etc/SpecialRoomChar"),
        assets.loadSheet("Fx", "Etc/GameModeImg"),
        this.bag.load(assets),
        this.itemBoxWheel.load(assets),
        this.chatScroll.load(assets),
        this.whisperLog.load(assets),
      ]);
      this.bg = bg;
      this.bg2p = bg2;
      this.btCharL = cl;
      this.btCharR = cr;
      this.btAskEx = ae;
      this.chattingImgSheet = ci;
      this.prepImgSheet = pi;
      this.balloonSheet = bal;
      this.levelSheet = lv;
      this.specialRoomCharSheet = specChar;
      this.gameModeImgSheet = gmi;
      this.btSpeaker.bindSheet(sp, 41, 28);
    }

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "room_left") {
        void this.ctx.goto("lobby");
      } else if (msg.type === "chat_recv" && msg.slot !== undefined && msg.slot >= 0) {
        this.slotBubbles.set(msg.slot, { text: msg.text, untilMs: performance.now() + 4500 });
        const pose = inferChatEmotionPose(msg.text);
        if (pose > 0) {
          this.slotEmotions.set(msg.slot, { pose, untilMs: performance.now() + 3200 });
        }
      }
    });

    setTimeout(() => this.edChat.focus(), 30);
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
    imeHost.blur();
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
      return;
    }
    const w = this.edWhisper.value.trim();
    if (w) this.ctx.hub.send({ type: "whisper_send", to: w, text });
    else this.ctx.hub.send({ type: "chat_send", text });
  }

  tick(): void {}

  onMouseMove(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseMove(mx, my)) return;
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    this.whisperLog.onMouseMove(mx, my, this.ctx.hub, this.roomPeerNames());
    this.btSpeaker.onMouseMove(mx, my, this.ctx.sound);
    this.bag.onMouseMove(mx, my, this.ctx.sound);
    this.chatScroll.onMouseMove(mx, my);

    this.hoveredAskSlot = -1;
    const rm = this.ctx.hub.currentRoom;
    if (!rm) return;
    for (let i = 0; i < CHAT_SLOTS.length; i++) {
      const sl = rm.slots[i];
      if (!sl || !sl.occupied || i === this.ctx.hub.mySlot) continue;
      const [sx, sy] = CHAT_SLOTS[i]!;
      if (pointInRect(mx, my, { x: sx + 12, y: sy + 99, w: 73, h: 20 })) {
        this.hoveredAskSlot = i;
        break;
      }
    }
  }

  onMouseDown(mx: number, my: number): void {
    if (this.itemBoxWheel.onMouseDown(mx, my, this.ctx.assets, this.ctx.hub)) return;
    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    if (this.whisperLog.onMouseDown(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    if (this.edWhisper.handleMouseDown(mx, my) || this.edChat.handleMouseDown(mx, my)) return;
    if (this.btSpeaker.onMouseDown(mx, my)) return;
    if (this.bag.onMouseDown(mx, my, this.ctx.hub, this.ctx.sound)) return;
    if (this.chatScroll.onMouseDown(mx, my)) return;

    const rm = this.ctx.hub.currentRoom;
    if (!rm) return;
    for (let i = 0; i < CHAT_SLOTS.length; i++) {
      const sl = rm.slots[i];
      if (!sl || !sl.occupied) continue;
      const [sx, sy] = CHAT_SLOTS[i]!;
      if (i === this.ctx.hub.mySlot) {
        if (pointInRect(mx, my, { x: sx + 12, y: sy + 99, w: 36, h: 20 })) {
          const curIdx = CHAR_MAIN_MAP.indexOf((sl.charCode < 0 ? 0 : sl.charCode) as (typeof CHAR_MAIN_MAP)[number]);
          const next = CHAR_MAIN_MAP[((curIdx >= 0 ? curIdx : 0) + 7) % 8] ?? 0;
          this.ctx.hub.send({ type: "room_set_char", charCode: next });
          this.ctx.sound.playSfx("ButtonDown_0", 0.55);
          return;
        }
        if (pointInRect(mx, my, { x: sx + 49, y: sy + 99, w: 36, h: 20 })) {
          const curIdx = CHAR_MAIN_MAP.indexOf((sl.charCode < 0 ? 0 : sl.charCode) as (typeof CHAR_MAIN_MAP)[number]);
          const next = CHAR_MAIN_MAP[((curIdx >= 0 ? curIdx : 0) + 1) % 8] ?? 0;
          this.ctx.hub.send({ type: "room_set_char", charCode: next });
          this.ctx.sound.playSfx("ButtonDown_0", 0.55);
          return;
        }
      } else if (pointInRect(mx, my, { x: sx + 12, y: sy + 99, w: 73, h: 20 })) {
        this.ctx.sound.playSfx("ButtonDown_0", 0.55);
        this.ctx.hub.send({ type: "whisper_send", to: sl.nickname, text: "要一起交換道具嗎？" });
        return;
      } else if (pointInRect(mx, my, { x: sx, y: sy, w: 98, h: 120 })) {
        this.ctx.sound.playSfx("ButtonDown_0", 0.55);
        this.ctx.dialogs.push(
          new UserInfoDlg(this.ctx.assets, this.ctx.hub, sl.username, (u) => {
            this.ctx.dialogs.push(new SmsFriendDlg(this.ctx.assets, this.ctx.hub, u));
          }),
        );
        return;
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.whisperLog.onMouseUp(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    if (this.btSpeaker.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.bag.onMouseUp(mx, my, this.ctx.sound)) return;
    this.chatScroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.altKey && e.code >= "Digit1" && e.code <= "Digit8") {
      e.preventDefault();
      this.itemBoxWheel.open = false;
      const pose = Number(e.code.slice(5));
      const cmds = ["/hi", "/笑", "/哭", "/怒", "/羞", "/加油", "/愛", "/特"];
      this.ctx.hub.send({ type: "chat_send", text: cmds[pose - 1] ?? "/笑" });
      return;
    }
    if (this.itemBoxWheel.onKeyDown(e)) {
      e.preventDefault();
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    this.itemBoxWheel.onKeyUp(e, this.ctx.assets, this.ctx.hub);
  }

  onWheel(deltaY: number): void {
    this.chatScroll.scrollBy(deltaY > 0 ? 2 : -2);
  }

  render(r: SpriteRenderer, nowMs: number): void {
    const dual = this.ctx.hub.dual2P;
    drawSheetFrame(r, dual && this.bg2p ? this.bg2p : this.bg, 0, 0, 0, { w: 800, h: 600 });

    const rm = this.ctx.hub.currentRoom;
    const tick = Math.floor(nowMs / 30);

    if (rm) {
      // Exact `CA.exe.c:77835..77858`: 3-digit room number (`Prepare/PrepareImg`, `stepX = 13`) at `(95, 32)`,
      // room title at `(145, 32)` in `RGB(0, 0x5C, 0xA4)`, password lock (`frame 41`) at `(718, 26)`.
      if (this.prepImgSheet) {
        if (rm.id >= 10000 && this.specialRoomCharSheet) {
          drawSheetFrame(r, this.specialRoomCharSheet, 0, 95, 36);
          drawSpriteDigits(r, this.prepImgSheet, 108, 32, 13, 2, rm.id - 10000, 0);
        } else {
          drawSpriteDigits(r, this.prepImgSheet, 95, 32, 13, 3, rm.id, 0);
        }
        if (rm.hasPassword) {
          drawSheetFrame(r, this.prepImgSheet, 41, 718, 26);
        }
      } else if (this.chattingImgSheet) {
        drawSpriteDigits(r, this.chattingImgSheet, 95, 32, 12, 3, rm.id, 0);
      }
      if (this.gameModeImgSheet) {
        drawSheetFrame(r, this.gameModeImgSheet, rm.manner === false ? 1 : 0, 425, 59);
      }
      r.drawText(rm.title, 145, 32, {
        color: [0, 0.36, 0.64, 1],
      });

      for (let i = 0; i < CHAT_SLOTS.length; i++) {
        const sl = rm.slots[i];
        if (!sl || !sl.occupied) continue;
        const [sx, sy] = CHAT_SLOTS[i]!;
        const slotStocks = [
          ...(sl.slotDecoStockIds ?? [sl.slotDecoStockId]),
          sl.fanfareStockId ?? 0,
          sl.idDecoStockId ?? 0,
        ].filter((x) => x > 0);
        const hatStocks =
          sl.charDecoStockIds && sl.charDecoStockIds.length > 0
            ? sl.charDecoStockIds
            : sl.hatStockId > 0
              ? [sl.hatStockId]
              : undefined;
        const emo = this.slotEmotions.get(i);
        const activePose = emo && nowMs < emo.untilMs ? emo.pose : sl.emotionPose;
        this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, slotStocks, "back", sx, sy, tick);
        this.cache.drawDisplayBomber(
          r,
          this.ctx.assets,
          sl.charCode,
          (i % 8) + 1,
          sx + 49,
          sy + 72,
          tick,
          false,
          hatStocks,
          activePose > 0 ? { pose: activePose } : undefined,
        );
        this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, slotStocks, "front", sx, sy, tick);
        this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, slotStocks, "idDeco", sx, sy, tick);
        drawLevelIcon(
          r,
          this.levelSheet,
          sl.level,
          sx + 6,
          sy + 4,
          this.cache.getTwinkleSheet(this.ctx.assets, sl.levelEffectIdx),
          tick,
          this.cache.getRotateSheet(this.ctx.assets, sl.levelEffectIdx),
        );
        r.drawText(sl.nickname.slice(0, 8), sx + 49, sy + 82, {
          align: "center",
          color: [0.06, 0.14, 0.28, 1],
        });

        if (i === this.ctx.hub.mySlot) {
          drawSheetFrame(r, this.btCharL, 0, sx + 12, sy + 99);
          drawSheetFrame(r, this.btCharR, 0, sx + 49, sy + 99);
        } else {
          drawSheetFrame(r, this.btAskEx, this.hoveredAskSlot === i ? 2 : 0, sx + 12, sy + 99);
        }

        const bub = this.slotBubbles.get(i);
        if (bub && nowMs < bub.untilMs && this.ctx.hub.showSpeechBalloons) {
          drawSpeechBubble(r, this.balloonSheet, bub.text, sx + 49, sy + 12);
        }
      }
    }

    this.bag.render(r, this.ctx.assets, this.ctx.hub);
    this.chatView.syncChatLog(r, this.ctx.hub.chatLog, false);
    this.chatView.render(r);
    this.edWhisper.render(r, nowMs);
    this.edChat.render(r, nowMs);
    this.btSpeaker.render(r);
    this.whisperLog.render(r, this.ctx.hub, this.roomPeerNames());

    const myIdx = Math.max(0, Math.min(CHAT_SLOTS.length - 1, this.ctx.hub.mySlot));
    const [mySx, mySy] = CHAT_SLOTS[myIdx] ?? [53, 88];
    this.itemBoxWheel.render(r, this.ctx.assets, this.ctx.hub, mySx + 49, mySy + 56);
    void this.specialRoomCharSheet;

    this.ctx.globalBar.render(r, this.ctx.hub);
  }
}
