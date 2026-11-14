// Stage 18: `CExchangeStage` (`src/stage/exchange.ts`).
// Strictly implements `CA.exe` `CExchangeStage` (`Fx:Exchange/*`):
//   - `Exchange/CAStage` (`800x600` JPEG)
//   - 2 Avatar Slots: my avatar `(581, 46)` (`BtChLeft (520, 82)` & `BtChRight (695, 82)`), partner `(41, 124)`
//   - Trade Grids (`0x617E08..14`): my grid `(508, 160)` & partner grid `(174, 122)`
//   - `Exchange/Bt-Enter (716, 290)` -> `LucciEnterDlg` (`Exchange/PU-Lucci_enter`)
//   - `Exchange/Bt_Exchange (534, 321)` + `Box-Rock`, `Exchange/Bt_Confirm (641, 321)` -> `ExchangeConfirmDlg` -> `ExchangeSuccessDlg`
//   - `CInventoryWndNew (505, 406)` 8-slot bag (`sub_4CBFF0` `L172109`)
//   - Chat: `CCtrlMsgView (36, 370, 392, 148)`, `VScroll (436, 360, 18, 166)`,
//     `Whisper (42, 535, 74, 12)`, `Edit (151, 535, 248, 12)`, `Dialog/BtSpeaker_Speaker (410, 526)`
//   - `CGlobalButtonDlg (0, 566)`

import { CHAR_MAIN_MAP, type LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import {
  CharacterPreviewCache,
  InventoryWndNew,
  SpriteButton,
  SpriteMsgView,
  SpriteScrollBar,
  SpriteWhisperLog,
  drawSheetFrame,
  drawSpriteDigits,
  drawSpriteNumber,
  inferChatEmotionPose,
  pointInRect,
} from "../ui/widgets.ts";
import {
  ExchangeConfirmDlg,
  ExchangeSuccessDlg,
  LucciEnterDlg,
  NoticeDlg,
  QuantityEnterDlg,
  ShoutDlg,
} from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

export class ExchangeStage implements Stage {
  readonly id = "exchange" as const;

  private bg: LoadedSheet | null = null;
  private boxRockSheet: LoadedSheet | null = null;
  private btExchangeSheet: LoadedSheet | null = null;
  private btCancelSheet: LoadedSheet | null = null;
  private selBoxSheet: LoadedSheet | null = null;
  private roomNumSheet: LoadedSheet | null = null;
  private shopImgSheet: LoadedSheet | null = null;

  private readonly btChLeft: SpriteButton;
  private readonly btChRight: SpriteButton;
  private readonly btLucciEnter: SpriteButton;
  private readonly btLock: SpriteButton;
  private readonly btConfirm: SpriteButton;
  private readonly btSpeaker: SpriteButton;

  private readonly bag: InventoryWndNew;
  private readonly chatScroll: SpriteScrollBar;
  private readonly chatView: SpriteMsgView;
  private readonly edWhisper: WebGpuEditBox;
  private readonly edChat: WebGpuEditBox;
  private readonly whisperLog: SpriteWhisperLog;

  private readonly cache = new CharacterPreviewCache();
  private readonly slotEmotions = new Map<number, { pose: number; stockId?: number; untilMs: number }>();
  private myOfferedIds: number[] = [];
  private myOfferedLucci = 0;
  private lastReceivedStockIds: number[] = [];
  private lastReceivedLucci = 0;

  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;

    this.btChLeft = new SpriteButton(520, 82, () => this.cycleChar(-1));
    this.btChRight = new SpriteButton(695, 82, () => this.cycleChar(1));
    this.btLucciEnter = new SpriteButton(716, 290, () => {
      const maxL = this.ctx.hub.profile?.lucci ?? 0;
      this.ctx.dialogs.push(
        new LucciEnterDlg(this.ctx.assets, this.myOfferedLucci, maxL, (val) => {
          this.myOfferedLucci = val;
          this.pushOffer();
        }),
      );
    });
    this.btLock = new SpriteButton(534, 321, () => {
      const st = this.ctx.hub.exchangeState;
      const myLocked = st ? st.locked[st.mySide] : false;
      this.ctx.hub.send({ type: "exchange_lock", locked: !myLocked });
    });
    this.btConfirm = new SpriteButton(641, 321, () => {
      this.ctx.dialogs.push(
        new ExchangeConfirmDlg(this.ctx.assets, () => {
          this.ctx.hub.send({ type: "exchange_confirm" });
        }),
      );
    });
    this.btSpeaker = new SpriteButton(410, 526, () => {
      this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub));
    });

    // Exact `sub_4CBFF0` `(505, 406)` 8-slot bag
    this.bag = new InventoryWndNew(505, 406, this.cache, 2, (invId) => {
      const st = this.ctx.hub.exchangeState;
      if (st && st.locked[st.mySide]) return;
      const idx = this.myOfferedIds.indexOf(invId);
      if (idx >= 0) {
        this.myOfferedIds.splice(idx, 1);
        this.pushOffer();
        return;
      }
      const freeSlots = 12 - this.myOfferedIds.length;
      if (freeSlots <= 0) return;
      const inv = this.ctx.hub.inventory.find((r) => r.invId === invId);
      const sameStockUnpicked = inv
        ? this.ctx.hub.inventory.filter(
            (r) => r.stockId === inv.stockId && !this.myOfferedIds.includes(r.invId),
          )
        : [];
      const stackMax = Math.min(freeSlots, Math.max(inv?.quantity ?? 1, sameStockUnpicked.length));
      if (stackMax > 1) {
        this.ctx.dialogs.push(
          new QuantityEnterDlg(this.ctx.assets, 1, stackMax, (qty) => {
            if (sameStockUnpicked.length >= qty) {
              for (let k = 0; k < qty; k++) {
                this.myOfferedIds.push(sameStockUnpicked[k]!.invId);
              }
            } else {
              for (let k = 0; k < qty && this.myOfferedIds.length < 12; k++) {
                this.myOfferedIds.push(invId);
              }
            }
            this.pushOffer();
          }),
        );
        return;
      }
      this.myOfferedIds.push(invId);
      this.pushOffer();
    });

    // Exact `CA.exe.c:172075..172109`: `chatView (31, 336, 394, 181)`, `scroll (433, 322, 17, 201)`,
    // `edWhisper (33, 534, 74, 12)`, `whisperLog (107, 528)`, `edChat (146, 534, 250, 12)`.
    this.chatScroll = new SpriteScrollBar(433, 322, 17, 201);
    this.chatView = new SpriteMsgView(31, 336, 394, 181, this.chatScroll);

    this.edWhisper = new WebGpuEditBox({
      x: 33,
      y: 534,
      w: 74,
      h: 12,
      maxLength: 16,
      textColor: [0.06, 0.24, 0.12, 1],
      onTab: () => this.edChat.focus(),
      onEnter: () => this.edChat.focus(),
    });
    this.edChat = new WebGpuEditBox({
      x: 146,
      y: 534,
      w: 250,
      h: 12,
      maxLength: 80,
      textColor: [0.05, 0.08, 0.16, 1],
      onTab: () => this.edWhisper.focus(),
      onEnter: () => this.sendChat(),
    });
    this.whisperLog = new SpriteWhisperLog(107, 528, (target) => {
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

  private cycleChar(dir: -1 | 1): void {
    const rm = this.ctx.hub.currentRoom;
    const cur = rm?.slots[this.ctx.hub.mySlot]?.charCode ?? 0;
    const curIdx = CHAR_MAIN_MAP.indexOf((cur < 0 ? 0 : cur) as (typeof CHAR_MAIN_MAP)[number]);
    const next = CHAR_MAIN_MAP[((curIdx >= 0 ? curIdx : 0) + dir + 8) % 8] ?? 0;
    this.ctx.hub.send({ type: "room_set_char", charCode: next });
  }

  private pushOffer(): void {
    this.ctx.hub.send({
      type: "exchange_offer",
      invIds: [...this.myOfferedIds],
      lucci: this.myOfferedLucci,
    });
  }

  async enter(): Promise<void> {
    this.myOfferedIds = [];
    this.myOfferedLucci = 0;
    this.ctx.sound.playBgm("StagePrepare");
    await this.ctx.globalBar.load(this.ctx.assets);

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      const [bg, rk, sel, cl, cr, ent, lk, lkc, cf, sp, rn, si] = await Promise.all([
        assets.loadSheet("Fx", "Exchange/CAStage"),
        assets.loadSheet("Fx", "Exchange/Box-Rock"),
        assets.loadSheet("Fx", "MyInfo/BtSpecialItemClicked"),
        assets.loadSheet("Fx", "Exchange/BtChLeft"),
        assets.loadSheet("Fx", "Exchange/BtChRight"),
        assets.loadSheet("Fx", "Exchange/Bt-Enter"),
        assets.loadSheet("Fx", "Exchange/Bt_Exchange"),
        assets.loadSheet("Fx", "Exchange/Bt_Cancel"),
        assets.loadSheet("Fx", "Exchange/Bt_Confirm"),
        assets.loadSheet("Fx", "Dialog/BtSpeaker_Speaker"),
        assets.loadSheet("Fx", "Exchange/Room_Number"),
        assets.loadSheet("Fx", "Shop/ShopImg"),
        this.bag.load(assets),
        this.chatScroll.load(assets),
        this.whisperLog.load(assets),
      ]);
      this.bg = bg;
      this.boxRockSheet = rk;
      this.btExchangeSheet = lk;
      this.btCancelSheet = lkc;
      this.selBoxSheet = sel;
      this.roomNumSheet = rn;
      this.shopImgSheet = si;
      this.btChLeft.bindSheet(cl, 46, 25);
      this.btChRight.bindSheet(cr, 46, 25);
      this.btLucciEnter.bindSheet(ent, 46, 21);
      this.btLock.bindSheet(lk, 86, 32);
      this.btConfirm.bindSheet(cf, 86, 32);
      this.btSpeaker.bindSheet(sp, 41, 28);
    }

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "room_left") {
        void this.ctx.goto("lobby");
      } else if (msg.type === "exchange_sync") {
        const peerSide: 0 | 1 = msg.state.mySide === 0 ? 1 : 0;
        this.lastReceivedStockIds = msg.state.offeredStocks[peerSide].map((it) => it.stockId);
        this.lastReceivedLucci = msg.state.offeredLucci[peerSide] ?? 0;
      } else if (msg.type === "exchange_done") {
        this.myOfferedIds = [];
        this.myOfferedLucci = 0;
        this.ctx.dialogs.push(
          new ExchangeSuccessDlg(
            this.ctx.assets,
            this.lastReceivedStockIds,
            this.lastReceivedLucci,
            this.cache,
          ),
        );
      } else if (msg.type === "room_err") {
        this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", [msg.message]));
      } else if (msg.type === "chat_recv" && msg.slot !== undefined && msg.slot >= 0) {
        const pose = inferChatEmotionPose(msg.text);
        if (pose > 0) {
          this.slotEmotions.set(msg.slot, {
            pose,
            untilMs: performance.now() + 3200,
          });
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
    const w = this.edWhisper.value.trim();
    if (w) this.ctx.hub.send({ type: "whisper_send", to: w, text });
    else this.ctx.hub.send({ type: "chat_send", text });
  }

  private buttons(): SpriteButton[] {
    return [this.btChLeft, this.btChRight, this.btLucciEnter, this.btLock, this.btConfirm, this.btSpeaker];
  }

  tick(): void {
    const st = this.ctx.hub.exchangeState;
    const myLocked = !!st && st.locked[st.mySide];
    const bothLocked = !!st && st.locked[0] && st.locked[1];
    this.btConfirm.enabled = bothLocked;
    this.btLucciEnter.enabled = !myLocked;
    // Exact `CA.exe.c:170035..170042`: swap `Bt_Exchange` <-> `Bt_Cancel` when locked!
    const targetLockSh = myLocked ? this.btCancelSheet : this.btExchangeSheet;
    if (targetLockSh && this.btLock.sheet !== targetLockSh) {
      this.btLock.bindSheet(targetLockSh, 86, 32);
    }
  }

  onMouseMove(mx: number, my: number): void {
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    this.whisperLog.onMouseMove(mx, my, this.ctx.hub, this.roomPeerNames());
    for (const b of this.buttons()) b.onMouseMove(mx, my, this.ctx.sound);
    this.bag.onMouseMove(mx, my, this.ctx.sound);
    this.chatScroll.onMouseMove(mx, my);
  }

  onMouseDown(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    if (this.whisperLog.onMouseDown(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    if (this.edWhisper.handleMouseDown(mx, my) || this.edChat.handleMouseDown(mx, my)) return;
    for (const b of this.buttons()) {
      if (b.onMouseDown(mx, my)) return;
    }
    if (this.bag.onMouseDown(mx, my, this.ctx.hub, this.ctx.sound)) return;
    if (this.chatScroll.onMouseDown(mx, my)) return;

    // Clicking an item inside my `4x3` trade grid `(508, 160)` (`62x56`) removes it from the offer
    const st = this.ctx.hub.exchangeState;
    if (!st || !st.locked[st.mySide]) {
      for (let i = 0; i < 12; i++) {
        const gx = 508 + 62 * (i % 4);
        const gy = 160 + 56 * Math.floor(i / 4);
        if (pointInRect(mx, my, { x: gx, y: gy, w: 61, h: 54 }) && this.myOfferedIds[i] !== undefined) {
          this.myOfferedIds.splice(i, 1);
          this.ctx.sound.playSfx("ButtonDown_0", 0.55);
          this.pushOffer();
          return;
        }
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.whisperLog.onMouseUp(mx, my, this.ctx.sound, this.ctx.hub, this.roomPeerNames())) return;
    for (const b of this.buttons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
    if (this.bag.onMouseUp(mx, my, this.ctx.sound)) return;
    this.chatScroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onWheel(deltaY: number): void {
    this.chatScroll.scrollBy(deltaY > 0 ? 2 : -2);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.altKey && e.code >= "Digit1" && e.code <= "Digit8") {
      e.preventDefault();
      const pose = Number(e.code.slice(5));
      const cmds = ["/hi", "/笑", "/哭", "/怒", "/羞", "/加油", "/愛", "/特"];
      this.ctx.hub.send({ type: "chat_send", text: cmds[pose - 1] ?? "/笑" });
      this.slotEmotions.set(Math.max(0, this.ctx.hub.mySlot), {
        pose,
        stockId: this.ctx.hub.profile?.equipped.emotionStockId ?? 0,
        untilMs: performance.now() + 3200,
      });
    }
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, 0, 0, { w: 800, h: 600 });

    const rm = this.ctx.hub.currentRoom;
    const st = this.ctx.hub.exchangeState;
    const tick = Math.floor(nowMs / 30);

    // Room Header (`CA.exe.c:169832`): `Exchange/Room_Number` `(52, 34)` + Room title `(100, 34)` in `RGB(0, 0x5C, 0xA4)`
    if (rm) {
      if (this.roomNumSheet) {
        drawSpriteDigits(r, this.roomNumSheet, 52, 34, 13, 3, rm.id, 0);
      }
      r.drawText(rm.title, 100, 34, {
        color: [0, 0.36, 0.64, 1],
      });
    }

    // My Avatar `(581, 46)` & Partner Avatar `(41, 124)`
    const mySlotIdx = this.ctx.hub.mySlot;
    const mySlot = rm?.slots[mySlotIdx];
    const partnerSlotIdx = rm?.slots.findIndex((s, idx) => s.occupied && idx !== mySlotIdx) ?? -1;
    const partnerSlot = partnerSlotIdx >= 0 ? rm?.slots[partnerSlotIdx] : undefined;

    const myEmo = this.slotEmotions.get(mySlotIdx);
    const activeMyEmo =
      myEmo && nowMs < myEmo.untilMs
        ? { pose: myEmo.pose, stockId: myEmo.stockId }
        : mySlot && mySlot.emotionPose > 0
          ? { pose: mySlot.emotionPose }
          : undefined;

    const mySlotStocks = mySlot
      ? [
          ...(mySlot.slotDecoStockIds ?? [mySlot.slotDecoStockId]),
          mySlot.fanfareStockId ?? 0,
          mySlot.idDecoStockId ?? 0,
        ].filter((x) => x > 0)
      : [];
    const myHatStocks =
      mySlot && mySlot.charDecoStockIds && mySlot.charDecoStockIds.length > 0
        ? mySlot.charDecoStockIds
        : mySlot && mySlot.hatStockId > 0
          ? [mySlot.hatStockId]
          : undefined;
    if (mySlotStocks.length > 0) this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, mySlotStocks, "back", 581, 46, tick);
    this.cache.drawDisplayBomber(r, this.ctx.assets, mySlot?.charCode ?? 0, 1, 630, 114, tick, false, myHatStocks, activeMyEmo);
    if (mySlotStocks.length > 0) {
      this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, mySlotStocks, "front", 581, 46, tick);
      this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, mySlotStocks, "idDeco", 581, 46, tick);
    }
    if (mySlot) {
      r.drawText(mySlot.nickname, 630, 128, { align: "center", color: [0.06, 0.14, 0.28, 1] });
    }
    if (partnerSlot) {
      const pEmo = this.slotEmotions.get(partnerSlotIdx);
      const activePEmo =
        pEmo && nowMs < pEmo.untilMs
          ? { pose: pEmo.pose, stockId: pEmo.stockId }
          : partnerSlot.emotionPose > 0
            ? { pose: partnerSlot.emotionPose }
            : undefined;
      const pSlotStocks = [
        ...(partnerSlot.slotDecoStockIds ?? [partnerSlot.slotDecoStockId]),
        partnerSlot.fanfareStockId ?? 0,
        partnerSlot.idDecoStockId ?? 0,
      ].filter((x) => x > 0);
      const pHatStocks =
        partnerSlot.charDecoStockIds && partnerSlot.charDecoStockIds.length > 0
          ? partnerSlot.charDecoStockIds
          : partnerSlot.hatStockId > 0
            ? [partnerSlot.hatStockId]
            : undefined;
      if (pSlotStocks.length > 0) this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pSlotStocks, "back", 41, 124, tick);
      this.cache.drawDisplayBomber(r, this.ctx.assets, partnerSlot.charCode, 2, 90, 192, tick, false, pHatStocks, activePEmo);
      if (pSlotStocks.length > 0) {
        this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pSlotStocks, "front", 41, 124, tick);
        this.cache.drawSlotCosmeticsForStocks(r, this.ctx.assets, pSlotStocks, "idDeco", 41, 124, tick);
      }
      r.drawText(partnerSlot.nickname, 90, 206, { align: "center", color: [0.06, 0.14, 0.28, 1] });
    }

    const mySide = st?.mySide ?? 0;
    const otherSide = mySide === 0 ? 1 : 0;
    const myStocks = st?.offeredStocks[mySide] ?? [];
    const otherStocks = st?.offeredStocks[otherSide] ?? [];

    // My `4x3` Trade Grid `(508, 160)` (`62x56` stride, `sub_4C4317` `CA.exe.c:171753`)
    myStocks.slice(0, 12).forEach((o, i) => {
      const gx = 508 + 62 * (i % 4);
      const gy = 160 + 56 * Math.floor(i / 4);
      const stock = this.ctx.assets.tables?.stockById.get(o.stockId);
      this.cache.drawStockIcon(r, this.ctx.assets, stock, gx + 30, gy + 26, 46, 40);
      drawSheetFrame(r, this.selBoxSheet, 0, gx - 1, gy - 1);
    });
    const shownMyLucci = st ? st.offeredLucci[mySide] : this.myOfferedLucci;
    if (this.shopImgSheet) {
      drawSpriteNumber(r, this.shopImgSheet, 580, 294, 10, 12, shownMyLucci, true, 36, false, 0);
    } else {
      r.drawText(`${shownMyLucci.toLocaleString()}`, 704, 294, {
        align: "right",
        color: [0.06, 0.14, 0.28, 1],
      });
    }
    if (st?.locked[mySide]) {
      drawSheetFrame(r, this.boxRockSheet, 0, 505, 160);
    }

    // Partner `4x3` Trade Grid `(174, 122)` (`62x56` stride, `sub_4C4317`)
    otherStocks.slice(0, 12).forEach((o, i) => {
      const gx = 174 + 62 * (i % 4);
      const gy = 122 + 56 * Math.floor(i / 4);
      const stock = this.ctx.assets.tables?.stockById.get(o.stockId);
      this.cache.drawStockIcon(r, this.ctx.assets, stock, gx + 30, gy + 26, 46, 40);
    });
    const peerLucci = st?.offeredLucci[otherSide] ?? 0;
    if (this.shopImgSheet) {
      drawSpriteNumber(r, this.shopImgSheet, 258, 255, 10, 15, peerLucci, true, 36, false, 0);
    } else {
      r.drawText(`${peerLucci.toLocaleString()}`, 418, 255, {
        align: "right",
        color: [0.06, 0.14, 0.28, 1],
      });
    }
    if (st?.locked[otherSide]) {
      drawSheetFrame(r, this.boxRockSheet, 0, 171, 122);
    }

    // My 8-slot Bag `(505, 406)` + `CA.exe.c:171850..171856` `Exchange/Box-Rock` (`250x111`) bag lock shutter at `(506, 407)`!
    this.bag.render(r, this.ctx.assets, this.ctx.hub);
    if (st?.locked[mySide]) {
      drawSheetFrame(r, this.boxRockSheet, 0, 506, 407);
    }

    this.chatView.syncChatLog(r, this.ctx.hub.chatLog, false);
    this.chatView.render(r);
    this.edWhisper.render(r, nowMs);
    this.edChat.render(r, nowMs);

    for (const b of this.buttons()) b.render(r);
    this.whisperLog.render(r, this.ctx.hub, this.roomPeerNames());
    this.ctx.globalBar.render(r, this.ctx.hub);

    // Wallet Lucci (`CA.exe.c:169140` `sub_4BFFD6`: `(308, 576)`, `Shop/ShopImg` `b=36, s=10, d=17`)
    if (this.shopImgSheet) {
      drawSpriteNumber(
        r,
        this.shopImgSheet,
        308,
        576,
        10,
        17,
        this.ctx.hub.profile?.lucci ?? 0,
        true,
        36,
        false,
        0,
      );
    }
  }
}
