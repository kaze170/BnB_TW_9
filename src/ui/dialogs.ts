// Retail Taiwan Crazy Arcade BnB v9 — Authentic `CDialogWnd` Modal Dialogs (`src/ui/dialogs.ts`).
// Strictly implements `CA.exe`'s centered `CDialogWnd` modals (`x = (800 - w)/2, y = (600 - h)/2`)
// using ONLY unmodified retail `Fx` / `Cx` sprite sheets and decompiled child coordinates:
//   1. `NoticeDlg`         (`Dialog/DlgNotice` 340x200 / `Dialog/DlgRetNotice` 340x200)
//   2. `NewUserDlg`        (`Dialog/DlgNewUser` 388x513)
//   3. `CreateRoomDlg`     (`Dialog/DlgCreateGuildTypeSelect` 340x391 / `Dialog/DlgCreate` 340x229 / `Dialog/DlgCreateExchange` 340x229)
//   4. `PasswordDlg`       (`Dialog/DlgPassword` 310x140)
//   5. `MapSelectDlg`      (`Dialog/DlgSelMap` 502x378)
//   6. `MyPageDlg`         (`MyInfo/MyItem_Stage` 542x560 + 5 Deco tabs + `CInventoryWndNew` 8-slot bag)
//   7. `UserInfoDlg`       (`Dialog/DlgMyinfo` / `Dialog/DlgUserInfo` 416x583 + `Dialog/DlgUserinfoResults`)
//   8. `ShopBuyDlg`        (`Shop/Popup_Buy` 400x317) & `ShopPresentDlg` (`Dialog/DlgShopPresent` 400x243)
//   9. `SmsFriendDlg`      (`Dialog/Dlg_SMS` 426x320 + `Dialog/Dlg_SMSImg` / `Dlg_SMSImg_01`)
//  10. `ShoutDlg`          (`Dialog/DlgSpeaker_main` 426x340)
//  11. `OptionDlg`         (`Dialog/DlgOPTION` 382x421 + `CCtrlBar` MP3/WAV sliders + `BtCheckBox`)
//  12. `HelpDlg`           (`Dialog/DlgHelp` 340x393 + retail `Fx:Help/Help` Big5 text)
//  13. `RoomInfoDlg`       (`Dialog/DlgRoomInfo` 295x395)
//  14. `LucciEnterDlg`     (`Exchange/PU-Lucci_enter` 355x178), `ExchangeConfirmDlg` (`Exchange/PU-Exchange` 371x238), `ExchangeSuccessDlg` (`Exchange/DlgChangeSucc` 366x420)

import { decodeBig5 } from "../data/big5.ts";
import type { GameAssets, LoadedSheet } from "../data/assets.ts";
import type { MapInfoEntry } from "../data/mapinfo.ts";
import { mergeWithBuiltins } from "../data/serverlist.ts";
import { stockCurrency, type StockItem } from "../data/tables.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { SoundManager } from "../audio/sound.ts";
import type { ClientHub } from "../net/hub.ts";
import type { CouponRow, RoomKind, RoomSummary } from "../net/messages.ts";
import type { GameModeId } from "../sim/engine.ts";
import { WebGpuEditBox, imeHost } from "./ime.ts";
import {
  CharacterPreviewCache,
  InventoryWndNew,
  ShopInventoryPopupMenu,
  SpriteButton,
  SpriteCheckBox,
  SpriteHSlider,
  SpriteMsgView,
  SpriteScrollBar,
  drawLevelIcon,
  formatRemainingHours,
  drawSheetFrame,
  drawSpriteDigits,
  drawSpriteNumber,
  pointInRect,
  sysStr,
} from "./widgets.ts";

export interface ModalDialog {
  readonly id: string;
  closed: boolean;
  onMouseMove(mx: number, my: number, sound: SoundManager): void;
  onMouseDown(mx: number, my: number, sound: SoundManager, button?: number): boolean;
  onMouseUp(mx: number, my: number, sound: SoundManager, button?: number): boolean;
  readonly acceptsSecondaryPointer?: boolean;
  onWheel?(deltaY: number, mx: number, my: number): boolean;
  onDoubleClick?(mx: number, my: number, sound: SoundManager): boolean;
  onEscape?(): boolean;
  onKeyDown?(e: KeyboardEvent): boolean;
  render(r: SpriteRenderer, nowMs: number): void;
}

export class DialogStack {
  private readonly stack: ModalDialog[] = [];

  get active(): boolean {
    this.prune();
    return this.stack.length > 0;
  }

  push(dlg: ModalDialog): void {
    this.prune();
    this.stack.push(dlg);
  }

  closeTop(): void {
    const top = this.stack.pop();
    if (top) top.closed = true;
    imeHost.blur();
  }

  clear(): void {
    this.stack.length = 0;
    imeHost.blur();
  }

  private prune(): void {
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.closed) {
      this.stack.pop();
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    top.onMouseMove(mx, my, sound);
    return true;
  }

  onMouseDown(mx: number, my: number, sound: SoundManager, button = 0): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    if (button === 0 || top.acceptsSecondaryPointer) top.onMouseDown(mx, my, sound, button);
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager, button = 0): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    if (button === 0 || top.acceptsSecondaryPointer) top.onMouseUp(mx, my, sound, button);
    return true;
  }

  onDoubleClick(mx: number, my: number, sound: SoundManager): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    top.onDoubleClick?.(mx, my, sound);
    return true;
  }

  onWheel(deltaY: number, mx: number, my: number): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    return top.onWheel ? top.onWheel(deltaY, mx, my) : true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    this.prune();
    const top = this.stack[this.stack.length - 1];
    if (!top) return false;
    if (e.key === "Escape") {
      if (top.onEscape?.()) return true;
      top.closed = true;
      imeHost.blur();
      return true;
    }
    return top.onKeyDown ? top.onKeyDown(e) : true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    this.prune();
    for (const dlg of this.stack) {
      if (!dlg.closed) dlg.render(r, nowMs);
    }
  }
}

// ─── 1. CNoticeDlg / CRetNoticeDlg (`340x200` at `(230, 200)`) ───────────────

export class NoticeDlg implements ModalDialog {
  readonly id = "notice";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 200;
  private bg: LoadedSheet | null = null;
  private readonly btOk: SpriteButton;
  private readonly btNo: SpriteButton | null;
  private readonly lines: string[];

  constructor(
    assets: GameAssets,
    _title: string,
    lines: string[],
    onOk?: () => void,
    confirmCancel = false,
  ) {
    this.lines = lines;
    if (confirmCancel) {
      this.btOk = new SpriteButton(72, 160, () => {
        this.closed = true;
        onOk?.();
      });
      this.btNo = new SpriteButton(184, 160, () => {
        this.closed = true;
      });
      void Promise.all([
        assets.loadSheet("Fx", "Dialog/DlgRetNotice"),
        assets.loadSheet("Fx", "Dialog/BtRetNoticeYes"),
        assets.loadSheet("Fx", "Dialog/BtRetNoticeNo"),
      ]).then(([bg, y, n]) => {
        this.bg = bg;
        this.btOk.bindSheet(y, 86, 25);
        this.btNo?.bindSheet(n, 86, 25);
      });
    } else {
      this.btOk = new SpriteButton(128, 160, () => {
        this.closed = true;
        onOk?.();
      });
      this.btNo = null;
      void Promise.all([
        assets.loadSheet("Fx", "Dialog/DlgNotice"),
        assets.loadSheet("Fx", "Dialog/BtNoticeClose"),
      ]).then(([bg, ok]) => {
        this.bg = bg;
        this.btOk.bindSheet(ok, 86, 25);
      });
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btNo?.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btNo?.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btNo?.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter" || e.key === " ") {
      this.btOk.onClick?.();
      return true;
    }
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    // Exact `CA.exe` `CNoticeDlg` message box `(48, 51, 228, 92)`
    const startY = this.dy + Math.max(51, Math.round(97 - this.lines.length * 9));
    this.lines.forEach((ln, idx) => {
      r.drawText(ln, this.dx + 162, startY + idx * 18, {
        align: "center",
        color: [0.06, 0.14, 0.28, 1],
        maxWidth: 228,
      });
    });
    this.btOk.render(r, this.dx, this.dy);
    this.btNo?.render(r, this.dx, this.dy);
  }
}

// ─── 1b. CLevelNoticeDlg (`CA.exe.c:38845..38900, 39795..39855`) ──────────────
// Retail level notice shell, also reused here for a web-server level-up message.
// `sub_42A3FF` accepts a caller-supplied message and `sub_4298DA` draws a
// static three-layer level icon via `sub_4F6DD5` at (89, 89). The level-up
// text and rewards shown here are web-server additions, not verified retail text.

export class LevelNoticeDlg implements ModalDialog {
  readonly id = "level_notice";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 200;
  private bg: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private readonly btClose: SpriteButton;
  private readonly newLevel: number;
  private readonly expGain: number;
  private readonly lucciGain: number;

  constructor(
    assets: GameAssets,
    newLevel: number,
    expGain = 0,
    lucciGain = 0,
    onClose?: () => void,
  ) {
    this.newLevel = Math.max(1, newLevel);
    this.expGain = expGain;
    this.lucciGain = lucciGain;
    this.btClose = new SpriteButton(128, 160, () => {
      this.closed = true;
      onClose?.();
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgNotice"),
      assets.loadSheet("Fx", "Dialog/BtNoticeClose"),
      assets.loadSheet("Cx", "Etc/LevelIcons"),
    ]).then(([bg, bt, lv]) => {
      this.bg = bg;
      this.btClose.bindSheet(bt, 86, 25);
      this.levelSheet = lv;
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btClose.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    this.btClose.onMouseDown(mx - this.dx, my - this.dy);
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    this.btClose.onMouseUp(mx - this.dx, my - this.dy, sound);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
      this.btClose.onClick?.();
      return true;
    }
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    // CLevelNoticeDlg::sub_4298DA calls the static level drawer, sub_4F6DD5.
    drawLevelIcon(r, this.levelSheet, this.newLevel, this.dx + 89, this.dy + 89);
    r.drawText(`恭喜晉升 Lv.${this.newLevel}！`, this.dx + 188, this.dy + 72, {
      align: "center",
      color: [0.76, 0.20, 0.08, 1],
      maxWidth: 168,
    });
    r.drawText("獲得全新榮耀階級章！", this.dx + 188, this.dy + 94, {
      align: "center",
      color: [0.06, 0.16, 0.34, 1],
      maxWidth: 168,
    });
    if (this.expGain > 0 || this.lucciGain > 0) {
      r.drawText(`+${this.expGain} EXP  +${this.lucciGain} LUCCI`, this.dx + 188, this.dy + 116, {
        align: "center",
        color: [0.10, 0.42, 0.22, 1],
        maxWidth: 176,
      });
    }
    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 1c. CSelectMajorDlg / CLogoMan (`CA.exe.c:41140..42615, 203445..203510`) ─
// Community / School Affiliation Badge selector (`Cx:Etc/CommunityLogo01|02|04|05|06`, 3f each)
// using `Fx:Dialog/DlgShopText` (`340x393`), `Fx:Dialog/Bt_Ok`, `Fx:Dialog/Bt_Back`, `Fx:Dialog/BtCheckBox`.

export const COMMUNITY_LOGO_OPTIONS: readonly { code: number; label: string }[] = [
  { code: 0, label: "不顯示徽章" },
  { code: 1, label: "水球菁英社 (#01)" },
  { code: 2, label: "繁榮山丘學園 (#02)" },
  { code: 4, label: "海盜王同盟 (#04)" },
  { code: 5, label: "超能悟空戰隊 (#05)" },
  { code: 6, label: "皇家冠軍俱樂部 (#06)" },
];

export class SelectCommunityDlg implements ModalDialog {
  readonly id = "select_community";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 103;
  private bg: LoadedSheet | null = null;
  private readonly logoSheets = new Map<number, LoadedSheet>();
  private readonly checks: SpriteCheckBox[] = [];
  private readonly btOk: SpriteButton;
  private readonly btBack: SpriteButton;
  private selectedCode: number;

  constructor(
    assets: GameAssets,
    initialCode: number,
    onPick: (code: number) => void,
  ) {
    const valid = new Set([0, 1, 2, 4, 5, 6]);
    this.selectedCode = valid.has(initialCode) ? initialCode : 0;

    COMMUNITY_LOGO_OPTIONS.forEach((opt, idx) => {
      const cb = new SpriteCheckBox(42, 66 + idx * 44, opt.code === this.selectedCode, () => {
        this.selectOption(opt.code);
      });
      this.checks.push(cb);
    });

    this.btOk = new SpriteButton(62, 340, () => {
      this.closed = true;
      onPick(this.selectedCode);
    });
    this.btBack = new SpriteButton(178, 340, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgShopText"),
      assets.loadSheet("Fx", "Dialog/Bt_Ok"),
      assets.loadSheet("Fx", "Dialog/Bt_Back"),
      assets.loadSheet("Fx", "Dialog/BtCheckBox"),
      assets.loadSheet("Cx", "Etc/CommunityLogo01"),
      assets.loadSheet("Cx", "Etc/CommunityLogo02"),
      assets.loadSheet("Cx", "Etc/CommunityLogo04"),
      assets.loadSheet("Cx", "Etc/CommunityLogo05"),
      assets.loadSheet("Cx", "Etc/CommunityLogo06"),
    ]).then(([bg, ok, bk, chk, l1, l2, l4, l5, l6]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 100, 32);
      this.btBack.bindSheet(bk, 100, 32);
      for (const c of this.checks) c.bindSheet(chk);
      if (l1) this.logoSheets.set(1, l1);
      if (l2) this.logoSheets.set(2, l2);
      if (l4) this.logoSheets.set(4, l4);
      if (l5) this.logoSheets.set(5, l5);
      if (l6) this.logoSheets.set(6, l6);
    });
  }

  private selectOption(code: number): void {
    this.selectedCode = code;
    COMMUNITY_LOGO_OPTIONS.forEach((opt, idx) => {
      if (this.checks[idx]) this.checks[idx]!.checked = opt.code === code;
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btOk.onMouseMove(lx, ly, sound);
    this.btBack.onMouseMove(lx, ly, sound);
    for (const c of this.checks) c.onMouseMove(lx, ly);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btOk.onMouseDown(lx, ly)) return true;
    if (this.btBack.onMouseDown(lx, ly)) return true;
    for (let i = 0; i < COMMUNITY_LOGO_OPTIONS.length; i++) {
      if (this.checks[i]?.onMouseDown(lx, ly)) return true;
      const ry = 56 + i * 44;
      if (lx >= 36 && lx <= 304 && ly >= ry && ly <= ry + 40) {
        this.selectOption(COMMUNITY_LOGO_OPTIONS[i]!.code);
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btOk.onMouseUp(lx, ly, sound)) return true;
    if (this.btBack.onMouseUp(lx, ly, sound)) return true;
    for (const c of this.checks) {
      if (c.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter") {
      this.btOk.onClick?.();
      return true;
    }
    if (e.key === "Escape") {
      this.btBack.onClick?.();
      return true;
    }
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    r.drawText("選擇社群 / 學園代表徽章", this.dx + 170, this.dy + 28, {
      align: "center",
      color: [0.06, 0.14, 0.28, 1],
    });
    const logoFrame = Math.floor(nowMs / 220) % 3;
    COMMUNITY_LOGO_OPTIONS.forEach((opt, i) => {
      const ry = this.dy + 58 + i * 44;
      const active = opt.code === this.selectedCode;
      if (active) {
        r.fillRect(this.dx + 34, ry - 2, 272, 38, [0.20, 0.52, 0.92, 0.16]);
      }
      this.checks[i]?.render(r, this.dx, this.dy);
      r.drawText(opt.label, this.dx + 66, ry + 9, {
        color: active ? [0.76, 0.20, 0.08, 1] : [0.08, 0.18, 0.34, 1],
      });
      const sh = this.logoSheets.get(opt.code);
      if (sh) {
        drawSheetFrame(r, sh, logoFrame, this.dx + 214, ry + 1);
      }
    });
    this.btOk.render(r, this.dx, this.dy);
    this.btBack.render(r, this.dx, this.dy);
  }
}

// ─── 2. CNewUserDlg (`Dialog/DlgNewUser` `388x513` at `(206, 43)`) ───────────

export class NewUserDlg implements ModalDialog {
  readonly id = "newuser";
  closed = false;
  private readonly dx = 206;
  private readonly dy = 43;
  private bg: LoadedSheet | null = null;
  private readonly edUser: WebGpuEditBox;
  private readonly edPass: WebGpuEditBox;
  private readonly edPass2: WebGpuEditBox;
  private readonly edNick: WebGpuEditBox;
  private readonly edEmail: WebGpuEditBox;
  private readonly edMemo: WebGpuEditBox;
  private readonly chkMale: SpriteCheckBox;
  private readonly chkFemale: SpriteCheckBox;
  private readonly chkPublic: SpriteCheckBox;
  private readonly btCheckId: SpriteButton;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private status = "";
  private unsub: (() => void) | null = null;
  private readonly hub: ClientHub;
  private readonly onRegistered: () => void;

  constructor(assets: GameAssets, hub: ClientHub, onRegistered: () => void) {
    this.hub = hub;
    this.onRegistered = onRegistered;

    // Exact `CNewUserDlg` PE/decompilation input well coordinates inside `DlgNewUser` (`388x513`):
    this.edUser = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 75,
      w: 104,
      h: 12,
      maxLength: 16,
      onTab: () => this.edPass.focus(),
    });
    this.edPass = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 105,
      w: 104,
      h: 12,
      maxLength: 20,
      password: true,
      onTab: () => this.edPass2.focus(),
    });
    this.edPass2 = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 135,
      w: 104,
      h: 12,
      maxLength: 20,
      password: true,
      onTab: () => this.edNick.focus(),
    });
    this.edNick = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 165,
      w: 104,
      h: 12,
      maxLength: 14,
      onTab: () => this.edEmail.focus(),
      onEnter: () => void this.submit(),
    });
    this.edEmail = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 279,
      w: 182,
      h: 12,
      maxLength: 40,
      onTab: () => this.edMemo.focus(),
      onEnter: () => void this.submit(),
    });
    this.edMemo = new WebGpuEditBox({
      x: this.dx + 154,
      y: this.dy + 339,
      w: 182,
      h: 12,
      maxLength: 50,
      onEnter: () => void this.submit(),
    });

    this.chkMale = new SpriteCheckBox(155, 224, true, () => {
      this.chkMale.checked = true;
      this.chkFemale.checked = false;
    });
    this.chkFemale = new SpriteCheckBox(218, 224, false, () => {
      this.chkFemale.checked = true;
      this.chkMale.checked = false;
    });
    this.chkPublic = new SpriteCheckBox(155, 404, true);

    this.btCheckId = new SpriteButton(268, 65, () => void this.checkId());
    this.btOk = new SpriteButton(88, 440, () => void this.submit());
    this.btCancel = new SpriteButton(200, 440, () => this.close());

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgNewUser"),
      assets.loadSheet("Fx", "Dialog/BtNewUserConfirmId"),
      assets.loadSheet("Fx", "Dialog/BtNewUserOk"),
      assets.loadSheet("Fx", "Dialog/BtNewUserCancel"),
      assets.loadSheet("Fx", "Dialog/BtCheckBox"),
    ]).then(([bg, cid, ok, ca, chk]) => {
      this.bg = bg;
      this.btCheckId.bindSheet(cid, 79, 32);
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
      this.chkMale.bindSheet(chk);
      this.chkFemale.bindSheet(chk);
      this.chkPublic.bindSheet(chk);
    });

    this.unsub = hub.onMessage((msg) => {
      if (msg.type === "auth_check_res") {
        this.status = msg.message;
      } else if (msg.type === "auth_ok") {
        const memo = this.edMemo.value.trim();
        if (memo) this.hub.send({ type: "update_memo", memo });
        this.close();
        this.onRegistered();
      } else if (msg.type === "auth_err") {
        this.status = msg.message;
      }
    });
    setTimeout(() => this.edUser.focus(), 20);
  }

  private close(): void {
    this.closed = true;
    this.unsub?.();
    imeHost.blur();
  }

  private async checkId(): Promise<void> {
    const u = this.edUser.value.trim();
    if (u.length < 2) {
      this.status = "請輸入至少 2 字元帳號";
      return;
    }
    await this.hub.ensureConnected();
    this.hub.send({ type: "auth_check_id", username: u });
  }

  private async submit(): Promise<void> {
    const u = this.edUser.value.trim();
    const p1 = this.edPass.value;
    const p2 = this.edPass2.value;
    const nick = this.edNick.value.trim() || u;
    if (u.length < 2 || p1.length < 2) {
      this.status = "帳號與密碼需至少 2 字元";
      return;
    }
    if (p1 !== p2) {
      this.status = "兩次密碼不一致";
      return;
    }
    await this.hub.ensureConnected();
    this.hub.send({
      type: "auth_register",
      username: u,
      password: p1,
      nickname: nick,
      gender: this.chkFemale.checked ? 1 : 0,
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    for (const b of [this.btCheckId, this.btOk, this.btCancel]) {
      b.onMouseMove(mx - this.dx, my - this.dy, sound);
    }
    this.chkMale.onMouseMove(mx - this.dx, my - this.dy);
    this.chkFemale.onMouseMove(mx - this.dx, my - this.dy);
    this.chkPublic.onMouseMove(mx - this.dx, my - this.dy);
  }

  onMouseDown(mx: number, my: number): boolean {
    for (const e of [this.edUser, this.edPass, this.edPass2, this.edNick, this.edEmail, this.edMemo]) {
      if (e.handleMouseDown(mx, my)) return true;
    }
    for (const b of [this.btCheckId, this.btOk, this.btCancel]) {
      if (b.onMouseDown(mx - this.dx, my - this.dy)) return true;
    }
    if (this.chkMale.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.chkFemale.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.chkPublic.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    for (const b of [this.btCheckId, this.btOk, this.btCancel]) {
      if (b.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    }
    if (this.chkMale.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.chkFemale.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.chkPublic.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.edUser.render(r, nowMs);
    this.edPass.render(r, nowMs);
    this.edPass2.render(r, nowMs);
    this.edNick.render(r, nowMs);
    this.edEmail.render(r, nowMs);
    this.edMemo.render(r, nowMs);
    this.chkMale.render(r, this.dx, this.dy);
    this.chkFemale.render(r, this.dx, this.dy);
    this.chkPublic.render(r, this.dx, this.dy);
    this.btCheckId.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
    if (this.status) {
      r.drawText(this.status, this.dx + 194, this.dy + 422, {
        align: "center",
        color: [0.75, 0.16, 0.12, 1],
      });
    }
  }
}

// ─── 3. CCreateDlg / CCreateExchangeDialog (`340x391` or `340x229`) ──────────

export class CreateRoomDlg implements ModalDialog {
  readonly id = "create_room";
  closed = false;
  private readonly dx = 230;
  private readonly dy: number;
  private readonly kind: RoomKind;
  private bg: LoadedSheet | null = null;
  private passImg: LoadedSheet | null = null;
  private choiceImg: LoadedSheet | null = null;

  private readonly chkManner: SpriteCheckBox;
  private readonly chkFree: SpriteCheckBox;
  private readonly chkLadder3: SpriteCheckBox;
  private readonly chkPrivate: SpriteCheckBox;
  private readonly edTitle: WebGpuEditBox;
  private readonly edPass: WebGpuEditBox;
  private readonly modeBtns: { mode: GameModeId; btn: SpriteButton }[] = [];
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;

  private mode: GameModeId = 0;
  private ladderSizeIdx = 1; // 0 = 1v1 (2p), 1 = 2v2 (4p), 2 = 3v3 (6p)
  private readonly guildType: 0 | 1;
  private readonly hub: ClientHub;

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    defaultKind: RoomKind = "game",
    guildType: 0 | 1 = 0,
  ) {
    this.hub = hub;
    this.kind = defaultKind;
    this.guildType = guildType;
    const isGuildSession = defaultKind === "guild" && guildType === 1;
    const isGame = defaultKind === "game" || isGuildSession;
    const isLadder = defaultKind === "guild" && guildType === 0;
    const isExchOrLadder = defaultKind === "exchange" || isLadder;
    const h = isGame ? 391 : 229;
    this.dy = Math.floor((600 - h) / 2);

    // Exact `CCreateDlg` / `CCreateGuildSessionDialog` (`game` / `guildType=1`) vs `CCreateExchangeDialog` / `CCreateLadderDlg` (`CA.exe.c:45251..45655`)
    const checkY = isExchOrLadder ? 89 : 56;
    const titleY = isExchOrLadder ? 119 : 86;
    const passY = isExchOrLadder ? 147 : 114;
    const privY = isExchOrLadder ? 172 : 139;
    const okY = isGame ? 335 : 197;

    this.chkManner = new SpriteCheckBox(152, checkY, !isLadder, () => {
      if (isLadder) {
        this.ladderSizeIdx = 0;
        this.chkManner.checked = true;
        this.chkFree.checked = false;
        this.chkLadder3.checked = false;
      } else {
        this.chkManner.checked = true;
        this.chkFree.checked = false;
      }
    });
    this.chkFree = new SpriteCheckBox(isLadder ? 201 : isExchOrLadder ? 224 : 238, checkY, isLadder, () => {
      if (isLadder) {
        this.ladderSizeIdx = 1;
        this.chkManner.checked = false;
        this.chkFree.checked = true;
        this.chkLadder3.checked = false;
      } else {
        this.chkFree.checked = true;
        this.chkManner.checked = false;
      }
    });
    this.chkLadder3 = new SpriteCheckBox(250, checkY, false, () => {
      this.ladderSizeIdx = 2;
      this.chkManner.checked = false;
      this.chkFree.checked = false;
      this.chkLadder3.checked = true;
    });
    this.chkLadder3.visible = isLadder;
    this.chkPrivate = new SpriteCheckBox(197, privY, false, (chk) => {
      if (chk) this.edPass.focus();
      else {
        this.edPass.value = "";
        this.edTitle.focus();
      }
    });

    this.edTitle = new WebGpuEditBox({
      x: this.dx + 153,
      y: this.dy + titleY,
      w: 142,
      h: 14,
      maxLength: 22,
      onEnter: () => this.submit(),
    });
    this.edTitle.value =
      defaultKind === "exchange"
        ? "道具交換房"
        : defaultKind === "chat"
          ? "開心聊天室"
          : isGuildSession
            ? "公會榮譽對戰房！"
            : defaultKind === "guild"
              ? "公會天梯對戰房！"
              : "一起來玩水球吧！";

    this.edPass = new WebGpuEditBox({
      x: this.dx + 153,
      y: this.dy + passY,
      w: 142,
      h: 14,
      maxLength: 8,
      password: true,
      onEnter: () => this.submit(),
    });

    if (isGame) {
      const modes: [GameModeId, string, number][] = [
        [0, "Dialog/BtCreate_Basic", 186],
        [4, "Dialog/BtCreate_KillCount", 214],
        [1, "Dialog/BtCreate_King", 242],
        [3, "Dialog/BtCreate_hedgehog", 270],
        [2, "Dialog/BtCreate_Timebomb", 298],
      ];
      modes.forEach(([m, sp, y]) => {
        const btn = new SpriteButton(49, y, () => {
          this.mode = m;
          this.modeBtns.forEach((mb) => (mb.btn.toggled = mb.mode === m));
        });
        btn.toggled = m === 0;
        this.modeBtns.push({ mode: m, btn });
        void assets.loadSheet("Fx", sp).then((s) => btn.bindSheet(s, 244, 26));
      });
    }

    this.btOk = new SpriteButton(66, okY, () => this.submit());
    this.btCancel = new SpriteButton(176, okY, () => {
      this.closed = true;
      imeHost.blur();
    });

    const bgPath =
      defaultKind === "exchange"
        ? "Dialog/DlgCreateExchange"
        : defaultKind === "chat"
          ? "Dialog/DlgCreate"
          : isLadder
            ? "Dialog/DlgCreateLadder"
            : "Dialog/DlgCreateGuildTypeSelect";

    void Promise.all([
      assets.loadSheet("Fx", bgPath),
      assets.loadSheet("Fx", "Dialog/DlgCreateImg"),
      assets.loadSheet("Fx", "Dialog/BtCreate_Choice"),
      assets.loadSheet("Fx", "Dialog/BtCheckBox"),
      assets.loadSheet("Fx", "Dialog/BtCreateOk"),
      assets.loadSheet("Fx", "Dialog/BtCreateCancel"),
    ]).then(([bg, pi, ch, chk, ok, ca]) => {
      this.bg = bg;
      this.passImg = pi;
      this.choiceImg = ch;
      this.chkManner.bindSheet(chk);
      this.chkFree.bindSheet(chk);
      this.chkLadder3.bindSheet(chk);
      this.chkPrivate.bindSheet(chk);
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
    });

    setTimeout(() => this.edTitle.focus(), 20);
  }

  private submit(): void {
    const title = this.edTitle.value.trim() || "爆爆王對戰房";
    const isLadder = this.kind === "guild" && this.guildType === 0;
    const cap =
      this.kind === "exchange"
        ? 2
        : this.kind === "chat"
          ? 12
          : isLadder
            ? (this.ladderSizeIdx + 1) * 2
            : 8;
    this.hub.send({
      type: "create_room",
      title,
      password: this.chkPrivate.checked ? this.edPass.value.trim() : "",
      manner: isLadder ? true : this.chkManner.checked,
      kind: this.kind,
      mode: this.mode,
      mapIndex: -1,
      capacity: cap,
      guildType: this.kind === "guild" ? this.guildType : undefined,
    });
    this.closed = true;
    imeHost.blur();
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.chkManner.onMouseMove(lx, ly);
    this.chkFree.onMouseMove(lx, ly);
    this.chkLadder3.onMouseMove(lx, ly);
    this.chkPrivate.onMouseMove(lx, ly);
    for (const mb of this.modeBtns) mb.btn.onMouseMove(lx, ly, sound);
    this.btOk.onMouseMove(lx, ly, sound);
    this.btCancel.onMouseMove(lx, ly, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edTitle.handleMouseDown(mx, my)) return true;
    if (this.chkPrivate.checked && this.edPass.handleMouseDown(mx, my)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.chkManner.onMouseDown(lx, ly)) return true;
    if (this.chkFree.onMouseDown(lx, ly)) return true;
    if (this.chkLadder3.onMouseDown(lx, ly)) return true;
    if (this.chkPrivate.onMouseDown(lx, ly)) return true;
    for (const mb of this.modeBtns) {
      if (mb.btn.onMouseDown(lx, ly)) return true;
    }
    if (this.btOk.onMouseDown(lx, ly)) return true;
    if (this.btCancel.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.chkManner.onMouseUp(lx, ly, sound)) return true;
    if (this.chkFree.onMouseUp(lx, ly, sound)) return true;
    if (this.chkLadder3.onMouseUp(lx, ly, sound)) return true;
    if (this.chkPrivate.onMouseUp(lx, ly, sound)) return true;
    for (const mb of this.modeBtns) {
      if (mb.btn.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.btOk.onMouseUp(lx, ly, sound)) return true;
    if (this.btCancel.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const isExchOrLadder =
      this.kind === "exchange" || (this.kind === "guild" && this.guildType === 0);
    if (this.chkPrivate.checked) {
      drawSheetFrame(r, this.passImg, 0, this.dx + 42, this.dy + (isExchOrLadder ? 140 : 107));
      drawSheetFrame(r, this.passImg, 1, this.dx + 148, this.dy + (isExchOrLadder ? 142 : 109));
      this.edPass.render(r, nowMs);
    }
    this.chkManner.render(r, this.dx, this.dy);
    this.chkFree.render(r, this.dx, this.dy);
    this.chkLadder3.render(r, this.dx, this.dy);
    this.chkPrivate.render(r, this.dx, this.dy);
    this.edTitle.render(r, nowMs);

    for (const mb of this.modeBtns) {
      mb.btn.render(r, this.dx, this.dy);
      if (mb.mode === this.mode) {
        drawSheetFrame(r, this.choiceImg, 0, this.dx + 47, this.dy + mb.btn.y - 13);
      }
    }
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 4. CSessionPasswdDlg (`Dialog/DlgPassword` `310x140` at `(245, 230)`) ───

export class PasswordDlg implements ModalDialog {
  readonly id = "password";
  closed = false;
  private readonly dx = 245;
  private readonly dy = 230;
  private bg: LoadedSheet | null = null;
  private readonly edPass: WebGpuEditBox;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;

  constructor(assets: GameAssets, onSubmit: (pw: string) => void) {
    // Exact `CSessionPasswdDlg` PE table: `edPass (160, 51, 80, 12)`, `btOk (52, 91)`, `btCancel (160, 91)`
    this.edPass = new WebGpuEditBox({
      x: this.dx + 160,
      y: this.dy + 51,
      w: 80,
      h: 12,
      maxLength: 12,
      password: true,
      onEnter: () => {
        this.closed = true;
        imeHost.blur();
        onSubmit(this.edPass.value);
      },
    });
    this.btOk = new SpriteButton(52, 91, () => {
      this.closed = true;
      imeHost.blur();
      onSubmit(this.edPass.value);
    });
    this.btCancel = new SpriteButton(160, 91, () => {
      this.closed = true;
      imeHost.blur();
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgPassword"),
      assets.loadSheet("Fx", "Dialog/BtWhisperOk"),
      assets.loadSheet("Fx", "Dialog/BtWhisperCancel"),
    ]).then(([bg, ok, ca]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
    });
    setTimeout(() => this.edPass.focus(), 20);
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edPass.handleMouseDown(mx, my)) return true;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.edPass.render(r, nowMs);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 5. CMapSelectDialog (`Dialog/DlgSelMap` `502x378` at `(149, 111)`) ──────

interface MapSelectRow {
  idx: number;
  label: string;
  code: string;
  art: string;
  maxPlayers: number;
  isNew?: boolean;
  minLevel?: number;
}

export class MapSelectDlg implements ModalDialog {
  readonly id = "selmap";
  closed = false;
  private readonly dx = 149;
  private readonly dy = 111;
  private bg: LoadedSheet | null = null;
  private selBar: LoadedSheet | null = null;
  private authIcon: LoadedSheet | null = null;
  private newMapIcon: LoadedSheet | null = null;
  private thumbSheet: LoadedSheet | null = null;
  private thumbPath = "";
  private hoveredRowIdx = -1;
  private readonly themeSheets = new Map<string, LoadedSheet | null>();

  private readonly btSortName: SpriteButton;
  private readonly btSortPlayer: SpriteButton;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly scroll: SpriteScrollBar;

  private readonly entries: MapSelectRow[] = [];
  private selectedIdx: number;
  private lastClickIdx = -999;
  private lastClickMs = 0;
  private readonly assets: GameAssets;
  private readonly onSelect: (mapIdx: number) => void;

  constructor(
    assets: GameAssets,
    currentMapIdx: number,
    onSelect: (mapIdx: number) => void,
    isPractice = false,
  ) {
    this.assets = assets;
    this.onSelect = onSelect;
    this.selectedIdx = currentMapIdx;
    const familyLabelTw: Record<string, string> = {
      bula: "布拉",
      camp: "露營",
      cemetery: "墓地",
      desert: "沙漠",
      factory: "工廠",
      forest: "森林",
      ice: "冰川",
      kart: "賽車",
      kfc: "肯德基",
      mine: "礦山",
      ocean: "海洋",
      patrit: "海盜",
      tomb: "古墓",
      village: "村落",
      xmas: "聖誕",
    };
    this.entries.push({ idx: -1, label: "隨機地圖 (Random)", code: "", art: "Random", maxPlayers: 8 });
    (assets.tables?.themeRandomMaps ?? []).forEach((rm) => {
      const famTw = familyLabelTw[rm.family.toLowerCase()] ?? rm.family;
      this.entries.push({
        idx: rm.index,
        label: `${famTw} — ${rm.description || "隨機選擇"}`,
        code: "",
        art: rm.family || "Random",
        maxPlayers: 8,
      });
    });

    const practiceSet = isPractice
      ? new Set((assets.tables?.mapGroups.get("PraticeMapGroup") ?? []).map((x) => x.toLowerCase()))
      : null;
    const concreteMaps = [...(assets.tables?.playableMaps ?? [])];
    if (practiceSet && practiceSet.size > 0) {
      concreteMaps.sort((a, b) => {
        const ia = practiceSet.has(a.name.toLowerCase()) ? 0 : 1;
        const ib = practiceSet.has(b.name.toLowerCase()) ? 0 : 1;
        return ia - ib || a.index - b.index;
      });
    }
    concreteMaps.forEach((m) => {
      if (m.name) {
        this.entries.push({
          idx: m.index,
          label: m.description || m.name,
          code: m.name,
          art: m.art && m.art !== "none" ? m.art : m.family || "Bula",
          maxPlayers: 8,
          isNew: m.isNew,
          minLevel: m.minLevel,
        });
      }
    });

    this.scroll = new SpriteScrollBar(453, 99, 17, 201);
    this.scroll.setRange(Math.max(0, this.entries.length - 13), false);

    this.btSortName = new SpriteButton(260, 76, () => {
      this.btSortName.toggled = true;
      this.btSortPlayer.toggled = false;
      this.sortEntries("name");
    }, { isTab: true });
    this.btSortName.toggled = true;

    this.btSortPlayer = new SpriteButton(395, 76, () => {
      this.btSortPlayer.toggled = true;
      this.btSortName.toggled = false;
      this.sortEntries("player");
    }, { isTab: true });

    this.btOk = new SpriteButton(147, 311, () => {
      this.closed = true;
      this.onSelect(this.selectedIdx);
    });
    this.btCancel = new SpriteButton(257, 311, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgSelMap"),
      assets.loadSheet("Fx", "Dialog/BtSelMapSelBar"),
      assets.loadSheet("Fx", "Dialog/BtSelMapName"),
      assets.loadSheet("Fx", "Dialog/BtSelMapPlayer"),
      assets.loadSheet("Fx", "Dialog/BtSelMapOk"),
      assets.loadSheet("Fx", "Dialog/BtSelMapCancel"),
      assets.loadSheet("Fx", "Theme/AuthorityAbleMapIcon"),
      assets.loadSheet("Fx", "Theme/Newmap_Icon"),
      this.scroll.load(assets),
    ]).then(([bg, sb, sn, sp, ok, ca, ai, nm]) => {
      this.bg = bg;
      this.selBar = sb;
      this.authIcon = ai;
      this.newMapIcon = nm;
      this.btSortName.bindSheet(sn, 135, 21);
      this.btSortPlayer.bindSheet(sp, 58, 21);
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
    });
    this.refreshThumb();
  }

  private sortEntries(by: "name" | "player"): void {
    const rand = this.entries.filter((e) => !e.code);
    const rest = this.entries.filter((e) => Boolean(e.code));
    if (by === "name") {
      rest.sort((a, b) => a.label.localeCompare(b.label, "zh-TW") || a.idx - b.idx);
    } else {
      rest.sort((a, b) => b.maxPlayers - a.maxPlayers || a.idx - b.idx);
    }
    this.entries.length = 0;
    this.entries.push(...rand, ...rest);
  }

  private getThemeSheet(art: string): LoadedSheet | null {
    if (!art) return null;
    if (this.themeSheets.has(art)) return this.themeSheets.get(art) ?? null;
    this.themeSheets.set(art, null);
    void this.assets.loadSheet("Fx", `Theme/${art}`).then((s) => {
      this.themeSheets.set(art, s);
    });
    return null;
  }

  private refreshThumb(): void {
    const picked = this.entries.find((e) => e.idx === this.selectedIdx);
    const cand = picked
      ? picked.code
        ? `Etc/${picked.code}_mm`
        : `Theme/${picked.art || "Random"}`
      : "Theme/Random";
    if (cand === this.thumbPath) return;
    this.thumbPath = cand;
    void this.assets.loadSheet("Fx", cand).then((s) => {
      if (this.thumbPath === cand) this.thumbSheet = s;
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btSortName, this.btSortPlayer, this.btOk, this.btCancel]) {
      b.onMouseMove(lx, ly, sound);
    }
    this.scroll.onMouseMove(lx, ly);
    let nextHover = -1;
    for (let i = 0; i < 13; i++) {
      const row = this.entries[this.scroll.value + i];
      if (!row) break;
      if (pointInRect(lx, ly, { x: 265, y: 110 + i * 14, w: 184, h: 14 })) {
        nextHover = i;
        break;
      }
    }
    if (nextHover >= 0 && nextHover !== this.hoveredRowIdx) {
      sound.playSfx("Wave/MouseMove_2", 0.35);
    }
    this.hoveredRowIdx = nextHover;
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btSortName, this.btSortPlayer, this.btOk, this.btCancel]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    if (this.scroll.onMouseDown(lx, ly)) return true;

    // Exact `CA.exe` `L50550..50564` & `sub_437569` (`L50385`): 13 rows at `(269, 111 + 14*i)`, double-click confirms
    for (let i = 0; i < 13; i++) {
      const row = this.entries[this.scroll.value + i];
      if (!row) break;
      if (pointInRect(lx, ly, { x: 265, y: 110 + i * 14, w: 184, h: 14 })) {
        const now = performance.now();
        this.selectedIdx = row.idx;
        sound.playSfx("ButtonDown_0", 0.55);
        this.refreshThumb();
        if (this.lastClickIdx === row.idx && now - this.lastClickMs < 380) {
          this.closed = true;
          this.onSelect(this.selectedIdx);
        }
        this.lastClickIdx = row.idx;
        this.lastClickMs = now;
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btSortName, this.btSortPlayer, this.btOk, this.btCancel]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.scroll.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 3 : -3);
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btSortName.render(r, this.dx, this.dy);
    this.btSortPlayer.render(r, this.dx, this.dy);

    // Exact `CA.exe` `L50770..50801`: `Etc/<code_mm>` centered inside `(44, 112, 200, 176)` +
    // `Theme/<art>` frame `1` at `(103, 82)` + title at `(117, 83)`
    if (this.thumbSheet) {
      const rc = this.thumbSheet.sheet?.rects[0];
      const w = rc ? rc.x1 - rc.x0 : this.thumbSheet.width;
      const h = rc ? rc.y1 - rc.y0 : this.thumbSheet.height;
      drawSheetFrame(
        r,
        this.thumbSheet,
        0,
        this.dx + 44 + Math.floor((200 - w) / 2),
        this.dy + 112 + Math.floor((176 - h) / 2),
      );
    }
    const sel = this.entries.find((e) => e.idx === this.selectedIdx);
    if (sel) {
      const selTheme = this.getThemeSheet(sel.art);
      if (selTheme && (selTheme.sheet?.rects.length ?? 0) > 1) {
        drawSheetFrame(r, selTheme, 1, this.dx + 103, this.dy + 82);
      }
      if (sel.isNew && this.newMapIcon) {
        drawSheetFrame(r, this.newMapIcon, 0, this.dx + 93, this.dy + 84);
      }
      r.drawText(sel.label.slice(0, 16), this.dx + 117, this.dy + 83, {
        color: [0.06, 0.14, 0.28, 1],
      });
    }

    // Exact `CA.exe` `L50685..50745`: 13 rows at `(269, 111 + 14*i)`, `Theme/<art>` badge at `(270, ry)`,
    // label at `(285, ry)`, player count at `(418, ry)`
    for (let i = 0; i < 13; i++) {
      const row = this.entries[this.scroll.value + i];
      if (!row) break;
      const ry = this.dy + 111 + i * 14;
      const active = row.idx === this.selectedIdx;
      if (active) {
        drawSheetFrame(r, this.selBar, 1, this.dx + 269, ry);
      }
      const themeSh = this.getThemeSheet(row.art);
      if (themeSh && (themeSh.sheet?.rects.length ?? 0) > 1) {
        drawSheetFrame(r, themeSh, 1, this.dx + 270, ry + 1);
      } else if (row.idx >= 0 && this.authIcon) {
        drawSheetFrame(r, this.authIcon, 0, this.dx + 270, ry + 1);
      }
      if (row.isNew && this.newMapIcon) {
        // Exact `CA.exe` `L50739`: `Theme/Newmap_Icon` (`8x8`) at `(rowX + 270, ry)`
        drawSheetFrame(r, this.newMapIcon, 0, this.dx + 270, ry);
      }
      r.drawText(row.label.slice(0, 13), this.dx + 285, ry + 1, {
        color: active ? [1, 1, 1, 1] : [0.08, 0.16, 0.30, 1],
      });
      r.drawText(row.idx < 0 ? "??" : String(row.maxPlayers), this.dx + 418, ry + 1, {
        color: active ? [1, 0.95, 0.55, 1] : [0.22, 0.34, 0.52, 1],
      });
    }

    this.scroll.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 6. CMyPageDialog (`MyInfo/MyItem_Stage` `542x560` at `(129, 20)`) ───────
// Exact `CA.exe` PE `.data` slot rect tables (`0x617AE8`, `0x6174C8`, `0x617668`/`0x617968`,
// `0x617C68`, `0x617348`) and `CEmotionWnd::CEmotionPopupDlg` (`MyInfo/DlgEmotion` `406x494`).

const MYPAGE_TABS: { bt: string; back: string; cats: number[] | null }[] = [
  { bt: "MyInfo/BtTebPremiumDeco", back: "MyInfo/Back_PremiumDeco", cats: [1, 2] },
  { bt: "MyInfo/BtTebItemDeco", back: "MyInfo/Back_ItemDeco", cats: [14, 4, 5, 6, 15] },
  { bt: "MyInfo/BtTebCharDeco", back: "MyInfo/Back_CharDeco", cats: [12, 19, 11] },
  { bt: "MyInfo/BtTebEmotionDeco", back: "MyInfo/Back_EmotionDeco", cats: [3] },
  { bt: "MyInfo/BtTebSlotDeco", back: "MyInfo/Back_SlotDeco", cats: [10, 18] },
];

// `0x617AE8` (`CSlotViewerStrategyPremium`, 12 slots `65x64`)
const MYPAGE_PREMIUM_SLOTS: readonly [number, number, number, number][] = [
  [43, 146, 65, 64], [109, 146, 65, 64], [175, 146, 65, 64], [241, 146, 65, 64],
  [43, 212, 65, 64], [109, 212, 65, 64], [175, 212, 65, 64], [241, 212, 65, 64],
  [43, 278, 65, 64], [109, 278, 65, 64], [175, 278, 65, 64], [241, 278, 65, 64],
];

// `0x61714C` (`CItemDecoWnd` `CA.exe.c:164488..164503`, 4 `MyInfo/Bt_ItemBack00..03` slots `84x80`)
const MYPAGE_ITEMDECO_SLOTS: readonly [number, number, number, number][] = [
  [241, 124, 84, 80],
  [407, 124, 84, 80],
  [241, 274, 84, 80],
  [407, 274, 84, 80],
];
const MYPAGE_ITEMDECO_CATS: readonly (readonly number[])[] = [
  [14],
  [4],
  [5],
  [6, 15],
];

// `0x617668` + `0x617968` (`CSlotViewerStrategyAvatar` + `CharDeco`, 10 slots `64x57`)
const MYPAGE_CHARDECO_SLOTS: readonly [number, number, number, number][] = [
  [247, 122, 64, 57], [311, 122, 64, 57], [375, 122, 64, 57], [439, 122, 64, 57],
  [247, 200, 64, 57], [311, 200, 64, 57], [375, 200, 64, 57], [439, 200, 64, 57],
  [247, 282, 64, 57], [311, 282, 64, 57],
];

// `0x617C68` (`CSlotViewerStrategyEmotion`, 7 slots `61x54`)
const MYPAGE_EMOTION_SLOTS: readonly [number, number, number, number][] = [
  [250, 194, 61, 54], [314, 194, 61, 54], [378, 194, 61, 54], [442, 194, 61, 54],
  [250, 281, 61, 54], [314, 281, 61, 54], [378, 281, 61, 54],
];

// `0x617348` (`CSlotViewerStrategyMaster` / `CSlotDecoWnd`, 24 slots `30x30`)
const MYPAGE_SLOTDECO_SLOTS: readonly [number, number, number, number][] = [
  [350, 162, 30, 30], [283, 224, 30, 30], [350, 287, 30, 30], [418, 224, 30, 30],
  [350, 128, 30, 30], [246, 224, 30, 30], [350, 322, 30, 30], [455, 224, 30, 30],
  [286, 167, 30, 30], [249, 167, 30, 30], [286, 132, 30, 30], [249, 132, 30, 30],
  [415, 167, 30, 30], [452, 167, 30, 30], [415, 132, 30, 30], [452, 132, 30, 30],
  [286, 282, 30, 30], [249, 282, 30, 30], [286, 317, 30, 30], [249, 317, 30, 30],
  [415, 282, 30, 30], [452, 282, 30, 30], [415, 317, 30, 30], [452, 317, 30, 30],
];

const DEFAULT_EMOTION_SHORTCUTS = ["/hi", "/笑", "/哭", "/怒", "/羞", "/加油", "/愛"] as const;

export class EmotionPopupDlg implements ModalDialog {
  readonly id = "emotion_popup";
  closed = false;
  private readonly dx = 197;
  private readonly dy = 53;
  private bg: LoadedSheet | null = null;
  private readonly edCmd: WebGpuEditBox;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly btNoEnter: SpriteButton;
  private readonly btLeft: SpriteButton;
  private readonly btRight: SpriteButton;
  private readonly cache: CharacterPreviewCache;
  private readonly assets: GameAssets;
  private readonly hub: ClientHub;
  private poseIdx: number;

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    slotIdx: number,
    cache?: CharacterPreviewCache,
  ) {
    this.assets = assets;
    this.hub = hub;
    this.cache = cache ?? new CharacterPreviewCache();
    this.poseIdx = Math.max(0, Math.min(6, slotIdx));

    // Exact `CA.exe.c:163700..163780`:
    //   Edit `(188, 238, 180, 20)` (`maxLength = 28`)
    //   `Dialog/Bt_Ok (94, 445)`, `Dialog/Bt_Cancel (215, 445)`
    //   `MyInfo/BtNoenter (46, 282)`, `Shop/BtMyBag_Left (134, 398)`, `Shop/BtMyBag_Right (244, 398)`
    this.edCmd = new WebGpuEditBox({
      x: this.dx + 188,
      y: this.dy + 238,
      w: 180,
      h: 20,
      maxLength: 28,
      textColor: [0.06, 0.14, 0.28, 1],
      bgColor: null,
      borderColor: null,
      onEnter: () => this.saveAndClose(),
    });
    const macroKey = (this.poseIdx + 1) % 10;
    this.edCmd.value = hub.macros[macroKey] || DEFAULT_EMOTION_SHORTCUTS[this.poseIdx] || "/笑";

    this.btOk = new SpriteButton(94, 445, () => this.saveAndClose());
    this.btCancel = new SpriteButton(215, 445, () => {
      imeHost.blur();
      this.closed = true;
    });
    this.btNoEnter = new SpriteButton(46, 282, () => {
      this.edCmd.value = "";
    });
    this.btLeft = new SpriteButton(134, 398, () => {
      this.poseIdx = (this.poseIdx + 6) % 7;
    });
    this.btRight = new SpriteButton(244, 398, () => {
      this.poseIdx = (this.poseIdx + 1) % 7;
    });

    void Promise.all([
      assets.loadSheet("Fx", "MyInfo/DlgEmotion"),
      assets.loadSheet("Fx", "Dialog/Bt_Ok"),
      assets.loadSheet("Fx", "Dialog/Bt_Cancel"),
      assets.loadSheet("Fx", "MyInfo/BtNoenter"),
      assets.loadSheet("Fx", "Shop/BtMyBag_Left"),
      assets.loadSheet("Fx", "Shop/BtMyBag_Right"),
    ]).then(([bg, ok, ca, ne, bl, br]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
      this.btNoEnter.bindSheet(ne, 75, 22);
      this.btLeft.bindSheet(bl, 29, 25);
      this.btRight.bindSheet(br, 29, 25);
    });

    setTimeout(() => this.edCmd.focus(), 20);
  }

  private saveAndClose(): void {
    const macroKey = (this.poseIdx + 1) % 10;
    this.hub.setMacro(macroKey, this.edCmd.value.trim());
    imeHost.blur();
    this.closed = true;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btOk, this.btCancel, this.btNoEnter, this.btLeft, this.btRight]) {
      b.onMouseMove(lx, ly, sound);
    }
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edCmd.handleMouseDown(mx, my)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btOk, this.btCancel, this.btNoEnter, this.btLeft, this.btRight]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btOk, this.btCancel, this.btNoEnter, this.btLeft, this.btRight]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    // Exact `dword_617080/617084 = (89, 243)` live avatar + `EmoTE` emotion pose preview!
    const charCode = (this.hub.profile?.selectedChar ?? 0) >= 0 ? (this.hub.profile?.selectedChar ?? 0) : 0;
    const tick = Math.floor(nowMs / 30);
    this.cache.drawDisplayBomber(
      r,
      this.assets,
      charCode,
      1,
      this.dx + 89,
      this.dy + 243,
      tick,
      false,
      undefined,
      { pose: this.poseIdx + 1 },
    );
    r.drawText(`表情動作 #${this.poseIdx + 1}`, this.dx + 190, this.dy + 403, {
      align: "center",
      color: [0.06, 0.16, 0.34, 1],
    });
    this.edCmd.render(r, nowMs);
    for (const b of [this.btOk, this.btCancel, this.btNoEnter, this.btLeft, this.btRight]) {
      b.render(r, this.dx, this.dy);
    }
  }
}

export class MyPageDlg implements ModalDialog {
  readonly id = "mypage";
  readonly acceptsSecondaryPointer = true;
  closed = false;
  private readonly dx = 129;
  private readonly dy = 20;

  private bg: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private shopImg: LoadedSheet | null = null;
  private miniMapSheet: LoadedSheet | null = null;
  private selClickedSheet: LoadedSheet | null = null;
  private moneyCashSheet: LoadedSheet | null = null;
  private moneyLucciSheet: LoadedSheet | null = null;
  private mypageImgSheet: LoadedSheet | null = null;
  private readonly tabBacks: (LoadedSheet | null)[] = [null, null, null, null, null];
  private readonly tabBtns: SpriteButton[] = [];
  private tabIdx = 2; // Default to Character Deco tab

  private readonly btCharLeft: SpriteButton;
  private readonly btCharRight: SpriteButton;
  private readonly btPremiumBuy: SpriteButton;
  private readonly btCharge: SpriteButton;
  private readonly btBuyBag: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly bag: InventoryWndNew;
  private readonly invPopup = new ShopInventoryPopupMenu();
  private shopTextPopup: ShopTextDlg | null = null;
  private deleteConfirm: NoticeDlg | null = null;
  private emotionPopup: EmotionPopupDlg | null = null;
  private charPickerPopup: SelectCharShopDlg | null = null;
  private readonly mypageMainSheets: (LoadedSheet | null)[] = new Array(8).fill(null);
  private mypageMainC10Sheet: LoadedSheet | null = null;
  private readonly itemBackSheets: (LoadedSheet | null)[] = [null, null, null, null];
  private talkLoadSheet: LoadedSheet | null = null;
  private talkOcto0Sheet: LoadedSheet | null = null;
  private talkOcto1Sheet: LoadedSheet | null = null;
  private hoverSlotIdx = -1;
  private selectedPremiumSlot = -1;
  private readonly premiumSheets = new Map<string, LoadedSheet | null>();
  private selectedEquipSlot = -1;
  private bagOrder: number[] = [];
  private bagOrderTab = -1;
  private bagOrderMetadata = "";
  private readonly cache = new CharacterPreviewCache();
  private readonly assets: GameAssets;
  private readonly hub: ClientHub;

  constructor(assets: GameAssets, hub: ClientHub, onGoShop: () => void) {
    this.assets = assets;
    this.hub = hub;
    for (let ci = 0; ci < 8; ci++) {
      void assets.loadSheet("Fx", `MyInfo/MypageMain_C0${ci}`).then((s) => {
        this.mypageMainSheets[ci] = s;
      });
    }
    void assets.loadSheet("Fx", "MyInfo/MypageMain_C10").then((s) => {
      this.mypageMainC10Sheet = s;
    });
    for (let bi = 0; bi < 4; bi++) {
      void assets.loadSheet("Fx", `MyInfo/Bt_ItemBack0${bi}`).then((s) => {
        this.itemBackSheets[bi] = s;
      });
    }

    // 5 Deco Tabs at `[[21,83],[84,83],[147,83],[210,83],[273,83]]` (`0x6171BC`)
    MYPAGE_TABS.forEach((td, idx) => {
      const btn = new SpriteButton(21 + idx * 63, 83, () => {
        this.tabIdx = idx;
        this.hoverSlotIdx = -1;
        this.selectedEquipSlot = -1;
        this.bag.page = 0;
        this.bag.selectedInvId = -1;
        this.tabBtns.forEach((b, j) => (b.toggled = j === idx));
      }, { isTab: true });
      btn.toggled = idx === this.tabIdx;
      this.tabBtns.push(btn);
      void assets.loadSheet("Fx", td.bt).then((s) => btn.bindSheet(s, 63, 21));
      void assets.loadSheet("Fx", td.back).then((s) => {
        this.tabBacks[idx] = s;
      });
    });

    this.btCharLeft = new SpriteButton(141, 32, () => this.cycleChar(-1));
    this.btCharRight = new SpriteButton(222, 32, () => this.cycleChar(1));
    // Exact `CGameCardWnd` (`CA.exe.c:164095`): `MyInfo/Bt_buy` at `(414, 300)`
    this.btPremiumBuy = new SpriteButton(414, 300, () => {
      this.closed = true;
      onGoShop();
    });
    this.btCharge = new SpriteButton(378, 445, () => {
      this.hub.send({ type: "charge_cash", amount: 5000 });
    });
    this.btBuyBag = new SpriteButton(212, 501, () => {
      this.closed = true;
      onGoShop();
    });
    this.btClose = new SpriteButton(382, 502, () => {
      this.closed = true;
    });

    // Exact `sub_4CBFF0` `(34, 383)` 8-slot inventory bag
    // Retail single-click selects; equipping is a separate action (4CC31C).
    this.bag = new InventoryWndNew(34, 383, this.cache, 0);
    this.bag.rowsProvider = () => this.bagRows();
    this.bag.isPriorityRow = (row) => this.isBagPriority(row);

    void Promise.all([
      assets.loadSheet("Fx", "MyInfo/MyItem_Stage"),
      assets.loadSheet("Fx", "MyInfo/BtMyChar_Left"),
      assets.loadSheet("Fx", "MyInfo/BtMyChar_Right"),
      assets.loadSheet("Fx", "MyInfo/Bt_buy"),
      assets.loadSheet("Fx", "MyInfo/BtCharge"),
      assets.loadSheet("Fx", "Shop/BtBuyBag"),
      assets.loadSheet("Fx", "MyInfo/Bt_MyItem_Stage_Close"),
      assets.loadSheet("Fx", "MyInfo/CharDecoMiniMap"),
      assets.loadSheet("Fx", "MyInfo/BtSpecialItemClicked"),
      assets.loadSheet("Fx", "MyInfo/MoneyType_Cash"),
      assets.loadSheet("Fx", "MyInfo/MoneyType_Lucci"),
      assets.loadSheet("Fx", "MyInfo/MypageImg"),
      assets.loadSheet("Cx", "Etc/LevelIcons"),
      assets.loadSheet("Fx", "Shop/ShopImg"),
      assets.loadSheet("Fx", "Shop/Talk_Load"),
      assets.loadSheet("Fx", "Shop/Talk_octo00"),
      assets.loadSheet("Fx", "Shop/Talk_octo01"),
      this.bag.load(assets),
      this.invPopup.load(assets),
    ]).then(([bg, cl, cr, bpb, chg, bb, cls, mm, sel, mc, ml, mpi, lv, si, tl, to0, to1]) => {
      this.bg = bg;
      this.btCharLeft.bindSheet(cl, 29, 36);
      this.btCharRight.bindSheet(cr, 29, 36);
      this.btPremiumBuy.bindSheet(bpb, 75, 22);
      this.btCharge.bindSheet(chg, 132, 33);
      this.btBuyBag.bindSheet(bb, 73, 24);
      this.btClose.bindSheet(cls, 124, 32);
      this.miniMapSheet = mm;
      this.selClickedSheet = sel;
      this.moneyCashSheet = mc;
      this.moneyLucciSheet = ml;
      this.mypageImgSheet = mpi;
      this.levelSheet = lv;
      this.shopImg = si;
      this.talkLoadSheet = tl;
      this.talkOcto0Sheet = to0;
      this.talkOcto1Sheet = to1;
    });
  }

  private bagPriorityCategories(): number[] {
    return this.tabIdx === 2 ? [12, 14, 19]
      : this.tabIdx === 4 ? [4, 5, 6, 10, 18]
      : this.tabIdx === 1 || this.tabIdx === 3 ? [1, 3] : [];
  }

  private isBagPriority(row: ClientHub["inventory"][number]): boolean {
    if (!this.bagPriorityCategories().includes(row.category)) return false;
    if (this.tabIdx === 2 && row.category === 19 && row.nativeCharacterCode !== undefined) {
      return row.nativeCharacterCode === (this.hub.profile?.selectedChar ?? 0);
    }
    return true; // Unknown character data retains the prior approximate ordering.
  }

  private bagRows() {
    // 4D036C partitions in place by swapping from opposite ends, rather
    // than sorting or hiding nonmatching rows.  Preserve that order when the
    // Premium tab requests mode 3 (4D19BC does not partition in that mode).
    const current = new Map(this.hub.inventory.map((row) => [row.invId, row]));
    const old = this.bagOrder.filter((id) => current.has(id));
    const seen = new Set(old);
    const added = this.hub.inventory.filter((row) => !seen.has(row.invId)).map((row) => row.invId);
    const metadata = `${this.hub.profile?.selectedChar ?? 0}:` + this.hub.inventory
      .map(row => `${row.invId},${row.category},${row.nativeCharacterCode ?? "?"},${row.nativeSortKey ?? "?"}`).join(";");
    const changed = old.length !== this.bagOrder.length || added.length > 0 || metadata !== this.bagOrderMetadata;
    const rows = [...old, ...added].map((id) => current.get(id)!);
    if ((changed || this.bagOrderTab !== this.tabIdx) && this.tabIdx !== 0) {
      let left = 0, right = rows.length;
      while (left < right) {
        if (!this.isBagPriority(rows[left]!)) {
          do { right--; } while (left < right && !this.isBagPriority(rows[right]!));
          if (left === right) break;
          [rows[left], rows[right]] = [rows[right]!, rows[left]!];
        }
        left++;
      }
      if (this.tabIdx === 2) {
        // sub_4CEF04: categories 12/14 have key -1, others use +48;
        // only sort when every key in the priority segment is known.
        const prefix = rows.slice(0, left);
        if (prefix.every(row => row.category === 12 || row.category === 14 || row.nativeSortKey !== undefined)) {
          const key = (row: typeof prefix[number]) => row.category === 12 || row.category === 14 ? -1 : row.nativeSortKey!;
          prefix.sort((a, b) => key(b) - key(a));
          rows.splice(0, prefix.length, ...prefix);
        }
      }
    }
    this.bagOrder = rows.map((row) => row.invId);
    this.bagOrderTab = this.tabIdx;
    this.bagOrderMetadata = metadata;
    return rows;
  }

  private activeSlotRects(): readonly [number, number, number, number][] {
    switch (this.tabIdx) {
      case 0:
        return MYPAGE_PREMIUM_SLOTS;
      case 1:
        return MYPAGE_ITEMDECO_SLOTS;
      case 2:
        return MYPAGE_CHARDECO_SLOTS;
      case 3:
        return MYPAGE_EMOTION_SLOTS;
      default:
        return MYPAGE_SLOTDECO_SLOTS;
    }
  }

  private activeTabItems() {
    // Premium slots are a server catalogue, not inventory rows.
    if (this.tabIdx === 0) return [];
    if (this.tabIdx === 1) {
      return MYPAGE_ITEMDECO_CATS.map((slotCats) =>
        this.hub.inventory.find((it) => {
          if (!it.equipped) return false;
          const st = this.assets.tables?.stockById.get(it.stockId);
          return st ? slotCats.includes(st.category) : false;
        }),
      );
    }
    const cats = MYPAGE_TABS[this.tabIdx]?.cats ?? null;
    return this.hub.inventory.filter((it) => {
      if (!it.equipped && this.tabIdx !== 0 && this.tabIdx !== 3) return false;
      const st = this.assets.tables?.stockById.get(it.stockId);
      if (!cats) return true;
      return st ? cats.includes(st.category) : false;
    });
  }

  private selectedPremiumStock(): StockItem | undefined {
    const slot = this.hub.premiumSlots?.[this.selectedPremiumSlot];
    return slot?.iconName ? this.assets.tables?.stockById.get(slot.stockId) : undefined;
  }

  private premiumSheet(iconName: string): LoadedSheet | null {
    if (!this.premiumSheets.has(iconName)) {
      this.premiumSheets.set(iconName, null);
      void this.assets.loadSheet("Fx", `Icon/${iconName}`).then(sheet => this.premiumSheets.set(iconName, sheet));
    }
    return this.premiumSheets.get(iconName) ?? null;
  }

  private cycleChar(dir: -1 | 1): void {
    const p = this.hub.profile;
    if (!p) return;
    const roster = [0, 1, 3, 5, 4, 6, 2, 7, -1];
    const normCur = p.selectedChar < 0 || p.selectedChar >= 8 ? -1 : p.selectedChar;
    const curIdx = Math.max(0, roster.indexOf(normCur));
    const next = roster[(curIdx + dir + roster.length) % roster.length]!;
    p.selectedChar = next;
    this.hub.send({ type: "select_char", charCode: next });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    if ((this.deleteConfirm && !this.deleteConfirm.closed) ||
        (this.shopTextPopup && !this.shopTextPopup.closed) ||
        (this.charPickerPopup && !this.charPickerPopup.closed) ||
        (this.emotionPopup && !this.emotionPopup.closed) || this.invPopup.active) this.bag.clearHover();
    if (this.deleteConfirm && !this.deleteConfirm.closed) { this.deleteConfirm.onMouseMove(mx, my, sound); return; }
    if (this.shopTextPopup && !this.shopTextPopup.closed) {
      this.shopTextPopup.onMouseMove(mx, my, sound);
      return;
    }
    if (this.charPickerPopup && !this.charPickerPopup.closed) {
      this.charPickerPopup.onMouseMove(mx, my, sound);
      return;
    }
    if (this.emotionPopup && !this.emotionPopup.closed) {
      this.emotionPopup.onMouseMove(mx, my, sound);
      return;
    }
    if (this.invPopup.onMouseMove(mx, my, sound)) return;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btPremiumBuy.visible = this.tabIdx === 0;
    this.btPremiumBuy.enabled = this.selectedPremiumStock() !== undefined;
    for (const b of [...this.tabBtns, this.btCharLeft, this.btCharRight, this.btPremiumBuy, this.btCharge, this.btBuyBag, this.btClose]) {
      b.onMouseMove(lx, ly, sound);
    }
    this.hoverSlotIdx = -1;
    const rects = this.activeSlotRects();
    for (let i = 0; i < rects.length; i++) {
      const [rx, ry, rw, rh] = rects[i]!;
      if (pointInRect(lx, ly, { x: rx, y: ry, w: rw, h: rh })) {
        this.hoverSlotIdx = i;
        break;
      }
    }
    this.bag.onMouseMove(mx, my, sound, this.dx, this.dy);
  }

  onMouseDown(mx: number, my: number, sound: SoundManager, button = 0): boolean {
    if (button !== 0) {
      if (button === 2) this.invPopup.close();
      return true;
    }
    if (this.deleteConfirm && !this.deleteConfirm.closed) return this.deleteConfirm.onMouseDown(mx, my);
    if (this.shopTextPopup && !this.shopTextPopup.closed) {
      return this.shopTextPopup.onMouseDown(mx, my, sound);
    }
    if (this.charPickerPopup && !this.charPickerPopup.closed) {
      return this.charPickerPopup.onMouseDown(mx, my, sound);
    }
    if (this.emotionPopup && !this.emotionPopup.closed) {
      return this.emotionPopup.onMouseDown(mx, my);
    }
    if (this.invPopup.active) {
      return this.invPopup.onMouseDown(mx, my);
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btPremiumBuy.visible = this.tabIdx === 0;
    this.btPremiumBuy.enabled = this.selectedPremiumStock() !== undefined;
    for (const b of [...this.tabBtns, this.btCharLeft, this.btCharRight, this.btPremiumBuy, this.btCharge, this.btBuyBag, this.btClose]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    // Clicking the top mini-avatar portrait `(168..222, 24..72)` opens `CSelectCharShopDlg`!
    if (pointInRect(lx, ly, { x: 168, y: 24, w: 54, h: 48 })) {
      sound.playSfx("ButtonDown_0", 0.55);
      const curChar = this.hub.profile?.selectedChar ?? 0;
      this.charPickerPopup = new SelectCharShopDlg(
        this.assets,
        curChar >= 0 ? curChar : 0,
        true,
        (picked) => {
          if (this.hub.profile) this.hub.profile.selectedChar = picked;
          this.hub.send({ type: "select_char", charCode: picked });
        },
        this.cache,
      );
      return true;
    }
    const rects = this.activeSlotRects();
    for (let i = 0; i < rects.length; i++) {
      const [rx, ry, rw, rh] = rects[i]!;
      if (pointInRect(lx, ly, { x: rx, y: ry, w: rw, h: rh })) {
        sound.playSfx("ButtonDown_0", 0.55);
        if (this.tabIdx === 0) {
          this.selectedPremiumSlot = (this.hub.premiumSlots?.[i]?.iconName ? i : -1);
          return true;
        }
        if (this.tabIdx === 3) {
          this.emotionPopup = new EmotionPopupDlg(this.assets, this.hub, i, this.cache);
          return true;
        }
        // Single click selects the equipped slot; native 515 (double click)
        // invokes its removal handler, not the initial 513 mouse-down.
        this.selectedEquipSlot = i;
        return true;
      }
    }
    if (this.bag.onMouseDown(mx, my, this.hub, sound, this.dx, this.dy)) return true;
    return true;
  }

  private openInventoryContext(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    {
      const filtered = this.bagRows();
      for (let i = 0; i < 8; i++) {
        const rc = this.bag.slotRect(i, this.dx, this.dy);
        if (pointInRect(mx, my, rc)) {
          const row = filtered[this.bag.page * 8 + i];
          if (row) {
            this.bag.selectedInvId = row.invId;
            sound.playSfx("ButtonDown_0", 0.55);
            this.invPopup.openMyInfo(mx, my, row, {
              onDecorate: (invId) => this.decorateInventory(invId),
              // MyInfo strategy supplies Delete and Deco, not the shop's Sell/Detail rows (4CCD51).
              onDelete: (invId) => {
                this.deleteConfirm = new NoticeDlg(this.assets, "", [sysStr(this.assets, "SureToDelete", "確定要刪除此道具嗎？")], () => {
                  this.hub.send({ type: "inventory_delete", invId });
                }, true);
              },
            });
          }
          return true;
        }
      }
      // CItemWnd uses CShopItemPopupDlg for equipped item slots (4BB27D).
      if (this.tabIdx === 1) {
        const rects = this.activeSlotRects();
        const items = this.activeTabItems();
        for (let i = 0; i < rects.length; i++) {
          const [x, y, w, h] = rects[i]!;
          if (!pointInRect(lx, ly, { x, y, w, h })) continue;
          const item = items[i];
          if (item) {
            this.selectedEquipSlot = i;
            this.invPopup.openShopCard(mx, my, true, {
              onShowDetail: () => {
                const stock = this.assets.tables?.stockById.get(item.stockId);
                if (stock) this.shopTextPopup = new ShopTextDlg(this.assets, stock, this.cache);
              },
              onTogglePreview: () => this.hub.send({ type: "item_equip", invId: item.invId, equip: false }),
            });
          }
          return true;
        }
      }
      return true;
    }
  }

  onMouseUp(mx: number, my: number, sound: SoundManager, button = 0): boolean {
    if (button !== 0) {
      if (button === 2 && !(this.deleteConfirm && !this.deleteConfirm.closed) &&
          !(this.shopTextPopup && !this.shopTextPopup.closed) &&
          !(this.charPickerPopup && !this.charPickerPopup.closed) &&
          !(this.emotionPopup && !this.emotionPopup.closed)) return this.openInventoryContext(mx, my, sound);
      return true;
    }
    if (this.deleteConfirm && !this.deleteConfirm.closed) return this.deleteConfirm.onMouseUp(mx, my, sound);
    if (this.shopTextPopup && !this.shopTextPopup.closed) {
      const r = this.shopTextPopup.onMouseUp(mx, my, sound);
      if (this.shopTextPopup.closed) this.shopTextPopup = null;
      return r;
    }
    if (this.charPickerPopup && !this.charPickerPopup.closed) {
      const r = this.charPickerPopup.onMouseUp(mx, my, sound);
      if (this.charPickerPopup.closed) this.charPickerPopup = null;
      return r;
    }
    if (this.emotionPopup && !this.emotionPopup.closed) {
      const r = this.emotionPopup.onMouseUp(mx, my, sound);
      if (this.emotionPopup.closed) this.emotionPopup = null;
      return r;
    }
    if (this.invPopup.onMouseUp(mx, my, sound)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btPremiumBuy.visible = this.tabIdx === 0;
    this.btPremiumBuy.enabled = this.selectedPremiumStock() !== undefined;
    for (const b of [...this.tabBtns, this.btCharLeft, this.btCharRight, this.btPremiumBuy, this.btCharge, this.btBuyBag, this.btClose]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.bag.onMouseUp(mx, my, sound, this.dx, this.dy)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.deleteConfirm && !this.deleteConfirm.closed) {
      if (e.key === "Escape") this.deleteConfirm.closed = true;
      else this.deleteConfirm.onKeyDown(e);
      return true;
    }
    if (this.shopTextPopup && !this.shopTextPopup.closed) {
      const r = this.shopTextPopup.onKeyDown(e);
      if (this.shopTextPopup.closed) this.shopTextPopup = null;
      return r;
    }
    if (this.charPickerPopup && !this.charPickerPopup.closed) {
      const r = this.charPickerPopup.onKeyDown(e);
      if (this.charPickerPopup.closed) this.charPickerPopup = null;
      return r;
    }
    if (this.emotionPopup && !this.emotionPopup.closed) {
      const r = this.emotionPopup.onKeyDown(e);
      if (this.emotionPopup.closed) this.emotionPopup = null;
      return r;
    }
    if (this.invPopup.active && e.key === "Escape") {
      this.invPopup.close();
      return true;
    }
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  private decorateInventory(invId: number): void {
    const row = this.hub.inventory.find((item) => item.invId === invId);
    // Only categories with a locally modelled equipment slot; other retail
    // categories need their own registration/use protocol, not generic equip.
    if (row && [3, 4, 5, 6, 10, 12, 14, 18, 19].includes(row.category) && !row.equipped) {
      this.hub.send({ type: "item_equip", invId, equip: true });
    }
  }

  onDoubleClick(mx: number, my: number, _sound: SoundManager): boolean {
    if ((this.deleteConfirm && !this.deleteConfirm.closed) || this.invPopup.active ||
        (this.shopTextPopup && !this.shopTextPopup.closed) ||
        (this.charPickerPopup && !this.charPickerPopup.closed) ||
        (this.emotionPopup && !this.emotionPopup.closed)) return true;
    const rows = this.bagRows();
    for (let i = 0; i < 8; i++) {
      if (pointInRect(mx, my, this.bag.slotRect(i, this.dx, this.dy))) {
        const row = rows[this.bag.page * 8 + i];
        if (row) this.decorateInventory(row.invId);
        return true;
      }
    }
    if (this.tabIdx === 1 || this.tabIdx === 2 || this.tabIdx === 4) {
      const lx = mx - this.dx, ly = my - this.dy;
      const items = this.activeTabItems();
      const rects = this.activeSlotRects();
      for (let i = 0; i < rects.length; i++) {
        const [x, y, w, h] = rects[i]!;
        if (!pointInRect(lx, ly, { x, y, w, h })) continue;
        const item = items[i];
        if (item?.equipped) this.hub.send({ type: "item_equip", invId: item.invId, equip: false });
        return true;
      }
    }
    return false;
  }

  onEscape(): boolean {
    if (this.deleteConfirm && !this.deleteConfirm.closed) { this.deleteConfirm.closed = true; return true; }
    if (this.shopTextPopup && !this.shopTextPopup.closed) { this.shopTextPopup.closed = true; return true; }
    if (this.charPickerPopup && !this.charPickerPopup.closed) { this.charPickerPopup.closed = true; return true; }
    if (this.emotionPopup && !this.emotionPopup.closed) { this.emotionPopup.closed = true; return true; }
    if (this.invPopup.active) { this.invPopup.close(); return true; }
    return false;
  }

  onWheel(deltaY: number): boolean {
    if ((this.deleteConfirm && !this.deleteConfirm.closed) || this.invPopup.active ||
        (this.shopTextPopup && !this.shopTextPopup.closed) ||
        (this.charPickerPopup && !this.charPickerPopup.closed) ||
        (this.emotionPopup && !this.emotionPopup.closed) || deltaY === 0) return true;
    const count = this.bagRows().length;
    const maxPage = Math.max(0, Math.ceil(count / 8) - 1);
    this.bag.page = Math.max(0, Math.min(maxPage, this.bag.page + (deltaY > 0 ? 1 : -1)));
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    // Exact `CA.exe` `sub_56E300(a2, 21, 109, Back_*Deco, 0)` (`CA.exe.c:162200..166575`)
    const back = this.tabBacks[this.tabIdx];
    if (back) drawSheetFrame(r, back, 0, this.dx + 21, this.dy + 109);
    for (const b of this.tabBtns) b.render(r, this.dx, this.dy);

    const p = this.hub.profile;
    if (p) {
      const tick = Math.floor(nowMs / 30);
      const charCode = p.selectedChar >= 0 ? p.selectedChar : 0;
      const eqRows = this.hub.inventory.filter((it) => it.equipped);
      const eqStockIds = eqRows.map((it) => it.stockId);

      // Top mini-avatar `(175, 34)` + centered ID `(269, 37)` (`CA.exe.c:165403..165433`)
      this.cache.drawDisplayBomber(r, this.assets, charCode, 1, this.dx + 195, this.dy + 65, tick, true);
      const dispLv = Math.max(1, Math.min(450, p.level + (p.equipped.levelDisguiseDelta ?? 0)));
      drawLevelIcon(
        r,
        this.levelSheet,
        dispLv,
        this.dx + 252,
        this.dy + 36,
        this.cache.getTwinkleSheet(this.assets, p.equipped.levelEffectIdx),
        tick,
        this.cache.getRotateSheet(this.assets, p.equipped.levelEffectIdx),
      );
      r.drawText(`${p.nickname}`, this.dx + 272, this.dy + 37, {
        color: [0.06, 0.14, 0.28, 1],
      });

      // Render active sub-window (`CGameCardWnd` / `CItemWnd` / `CCharDecoWnd` / `CEmotionWnd` / `CSlotDecoWnd`)
      const rects = this.activeSlotRects();
      const tabItems = this.activeTabItems();

      if (this.tabIdx === 2) {
        // `CCharDecoWnd` (`CA.exe.c:162253`): `MyInfo/CharDecoMiniMap` at `(48, 135)` clipped to `160x160` + live bomber & bomb skin
        if (this.miniMapSheet) {
          r.pushClip(this.dx + 48, this.dy + 135, 160, 160);
          drawSheetFrame(r, this.miniMapSheet, 0, this.dx + 48, this.dy + 135);
          r.popClip();
        }
        this.cache.drawDisplayBomber(
          r,
          this.assets,
          charCode,
          1,
          this.dx + 128,
          this.dy + 225,
          tick,
          false,
          eqStockIds,
        );
        if (p.equipped.bombStockId) {
          this.cache.drawBombSkinForStock(r, this.assets, p.equipped.bombStockId, this.dx + 76, this.dy + 225, tick);
        }
      } else if (this.tabIdx === 4) {
        // `CSlotDecoWnd` (`CA.exe.c:166865..166955`): slot preview at `(65, 139)` & avatar at `dword_617200/617204 = (89, 264)`
        const sx = this.dx + 65;
        const sy = this.dy + 139;
        this.cache.drawSlotCosmeticsForStocks(r, this.assets, eqStockIds, "back", sx, sy, tick);
        this.cache.drawSlotCosmeticsForStocks(r, this.assets, eqStockIds, "idDeco", sx, sy, tick);
        this.cache.drawDisplayBomber(r, this.assets, charCode, 1, this.dx + 114, this.dy + 228, tick, false, eqStockIds);
        this.cache.drawSlotCosmeticsForStocks(r, this.assets, eqStockIds, "front", sx, sy, tick);
      } else if (this.tabIdx === 1) {
        // `CItemDecoWnd` (`Back_ItemDeco` `CA.exe.c:164474..165160`): `MyInfo/MypageMain_C00..C07` + `MyInfo/MypageMain_C10` (Random) + live bomber
        const isRandChar = (p.selectedChar ?? 0) < 0 || (p.selectedChar ?? 0) >= 8;
        const mainIllust = isRandChar
          ? (this.mypageMainC10Sheet ?? this.mypageMainSheets[0])
          : this.mypageMainSheets[charCode & 7];
        if (mainIllust) {
          drawSheetFrame(r, mainIllust, 0, this.dx + 34, this.dy + 136);
        }
        this.cache.drawDisplayBomber(r, this.assets, charCode, 1, this.dx + 96, this.dy + 250, tick, false, eqStockIds);
        drawSheetFrame(r, this.talkLoadSheet, Math.floor(nowMs / 180) % 6, this.dx + 121, this.dy + 360, { anchor: true });
        drawSheetFrame(r, this.talkOcto0Sheet, Math.floor(nowMs / 320) % 3, this.dx + 86, this.dy + 360, { anchor: true });
        drawSheetFrame(r, this.talkOcto1Sheet, Math.floor(nowMs / 300) % 3, this.dx + 44, this.dy + 360, { anchor: true });
      } else if (this.tabIdx === 3) {
        // `CEmotionWnd` (`Back_EmotionDeco`): live emotion preview on left stage `(128, 258)`
        const emoPose = this.hoverSlotIdx >= 0 ? this.hoverSlotIdx + 1 : 1;
        this.cache.drawDisplayBomber(
          r,
          this.assets,
          charCode,
          1,
          this.dx + 128,
          this.dy + 258,
          tick,
          false,
          eqStockIds,
          { pose: emoPose },
        );
      }

      // Render exact `CSlotViewerStrategy*` slot grid for the active tab
      rects.forEach(([rx, ry, rw, rh], idx) => {
        const sx = this.dx + rx;
        const sy = this.dy + ry;
        if (this.tabIdx === 0) {
          const slot = this.hub.premiumSlots?.[idx];
          if (!slot?.iconName) return;
          const stock = this.assets.tables?.stockById.get(slot.stockId);
          const owned = stock && this.hub.inventory.some(row => {
            const item = this.assets.tables?.stockById.get(row.stockId);
            return item && item.avatarCode === stock.avatarCode;
          });
          drawSheetFrame(r, this.premiumSheet(slot.iconName), owned ? 0 : 1, sx, sy);
          if (owned && idx === this.selectedPremiumSlot) drawSheetFrame(r, this.selClickedSheet, 0, sx, sy);
          return;
        }
        if (this.tabIdx === 1) {
          const item = tabItems[idx];
          const cardSheet = this.itemBackSheets[idx];
          const cardFrame = this.hoverSlotIdx === idx ? 1 : item ? 2 : 0;
          drawSheetFrame(r, cardSheet, cardFrame, sx, sy);
        } else if (this.hoverSlotIdx === idx && this.selClickedSheet && rw >= 50) {
          drawSheetFrame(r, this.selClickedSheet, 0, sx - 1, sy - 1);
        } else if (this.hoverSlotIdx === idx) {
          r.fillRect(sx, sy, rw, rh, [1, 0.94, 0.42, 0.28]);
        }

        if (this.tabIdx === 3) {
          const macroKey = (idx + 1) % 10;
          const cmd = this.hub.macros[macroKey] || DEFAULT_EMOTION_SHORTCUTS[idx] || "";
          this.cache.drawDisplayBomber(
            r,
            this.assets,
            charCode,
            1,
            sx + Math.floor(rw / 2),
            sy + rh - 8,
            tick,
            true,
            undefined,
            { pose: idx + 1 },
          );
          if (cmd) {
            r.drawText(cmd.slice(0, 6), sx + Math.floor(rw / 2), sy + rh - 12, {
              align: "center",
              color: [0.06, 0.16, 0.34, 1],
            });
          }
          return;
        }

        const item = tabItems[idx];
        if (!item) return;
        const st = this.assets.tables?.stockById.get(item.stockId);
        this.cache.drawStockIcon(
          r,
          this.assets,
          st,
          sx + Math.floor(rw / 2),
          sy + Math.floor(rh / 2),
          Math.max(22, rw - 10),
          Math.max(22, rh - 10),
        );
      });

      // Exact `CA.exe.c:164230..164310` Selected Item Detail Pane (`(353, 293)` icon, `(410, 262)` MoneyType, `(490, 244)` duration, `(488, 279)` price):
      // CGameCardWnd belongs to the premium tab and uses its clicked slot,
      // not the bag selection or a hovered equipment slot (4BA1EE/4BA7xx).
      const detailStock = this.tabIdx === 0 ? this.selectedPremiumStock() : undefined;
      const detailRow = detailStock && this.hub.inventory.find(row => {
        const item = this.assets.tables?.stockById.get(row.stockId);
        return item && item.avatarCode === detailStock.avatarCode;
      });
      if (detailStock) {
        this.cache.drawStockIcon(r, this.assets, detailStock, this.dx + 353, this.dy + 293, 52, 48);
        r.drawText(detailStock.name.slice(0, 11), this.dx + 490, this.dy + 224, {
          align: "right",
          color: [0.06, 0.14, 0.28, 1],
        });
        // The original reads remaining hours from the user-item/account,
        // not the number of inventory copies or stock duration.
        const remText = formatRemainingHours(detailRow?.remainingHours ?? (!detailRow && detailStock.category !== 9 ? 0 : undefined));
        r.drawText(remText, this.dx + 490, this.dy + 244, {
          align: "right",
          color: [0.16, 0.28, 0.44, 1],
        });
        const isLucci = stockCurrency(detailStock) === "lucci";
        drawSheetFrame(
          r,
          isLucci ? this.moneyLucciSheet : this.moneyCashSheet,
          0,
          this.dx + 410,
          this.dy + 262,
        );
        const valNum = isLucci ? detailStock.priceLucci : detailStock.priceCash;
        r.drawText(valNum.toLocaleString(), this.dx + 488, this.dy + 279, {
          align: "right",
          color: isLucci ? [0.08, 0.40, 0.20, 1] : [0.72, 0.20, 0.08, 1],
        });
      } else if (this.tabIdx === 0 && this.mypageImgSheet) {
        // Exact `CA.exe.c:164159`: `MyInfo/MypageImg` frame `3` (`63x56`) at `(dx + 341, dy + 225)` when empty
        drawSheetFrame(r, this.mypageImgSheet, 3, this.dx + 341, this.dy + 225);
      }

      // Exact `CA.exe.c:165438` & `163996` `ShopImg` sprite digits:
      // Lucci `(dx+385, dy+391, s=10, max=11, b=25, comma=true, cw=3)`
      // Cash  `(dx+386, dy+418, s=16, max=7,  b=14, comma=true, cw=3)`
      if (this.shopImg) {
        drawSpriteNumber(r, this.shopImg, this.dx + 385, this.dy + 391, 10, 11, p.lucci, true, 25, true, 3);
        drawSpriteNumber(r, this.shopImg, this.dx + 386, this.dy + 418, 16, 7, p.cash, true, 14, true, 3);
      } else {
        r.drawText(`${p.lucci.toLocaleString()}`, this.dx + 498, this.dy + 391, {
          align: "right",
          color: [0.06, 0.14, 0.28, 1],
        });
        r.drawText(`${p.cash.toLocaleString()}`, this.dx + 498, this.dy + 418, {
          align: "right",
          color: [0.72, 0.20, 0.08, 1],
        });
      }
    }

    this.btPremiumBuy.visible = this.tabIdx === 0;
    this.btPremiumBuy.enabled = this.selectedPremiumStock() !== undefined;
    this.btPremiumBuy.render(r, this.dx, this.dy);
    this.btCharLeft.render(r, this.dx, this.dy);
    this.btCharRight.render(r, this.dx, this.dy);
    this.bag.render(r, this.assets, this.hub, this.dx, this.dy);
    this.btCharge.render(r, this.dx, this.dy);
    this.btBuyBag.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
    this.invPopup.render(r);
    if (this.deleteConfirm && !this.deleteConfirm.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.deleteConfirm.render(r);
    }

    if (this.emotionPopup && !this.emotionPopup.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.emotionPopup.render(r, nowMs);
    }
    if (this.charPickerPopup && !this.charPickerPopup.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.charPickerPopup.render(r, nowMs);
    }
    if (this.shopTextPopup && !this.shopTextPopup.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.shopTextPopup.render(r, nowMs);
    }
  }
}

// ─── 7. CMyInfoDialog / CUserInfoDialog (`416x583` at `(192, 8)`) ────────────

export class UserInfoDlg implements ModalDialog {
  readonly id = "userinfo";
  closed = false;
  private readonly dx = 192;
  private readonly dy = 8;

  private bg: LoadedSheet | null = null;
  private resOverlay: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private readonly communityLogos = new Map<number, LoadedSheet>();
  private communityLogoCode = 0;
  private communityPopup: SelectCommunityDlg | null = null;
  private tab: "private" | "result" = "result";

  private readonly btTabPrivate: SpriteButton;
  private readonly btTabResult: SpriteButton;
  private readonly btWhisper: SpriteButton;
  private readonly btFriend: SpriteButton;
  private readonly btModify: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly chkMale: SpriteCheckBox;
  private readonly chkFemale: SpriteCheckBox;
  private readonly chkOpen: SpriteCheckBox;
  private readonly edName: WebGpuEditBox;
  private readonly edSchool: WebGpuEditBox;
  private readonly edMemo: WebGpuEditBox;
  private readonly cache = new CharacterPreviewCache();
  private readonly assets: GameAssets;
  private readonly hub: ClientHub;
  private readonly targetUsername: string;
  private readonly isSelf: boolean;

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    targetUsername?: string,
    onSmsTo?: (username: string) => void,
  ) {
    this.assets = assets;
    this.hub = hub;
    const selfUser = hub.profile?.username ?? "";
    this.targetUsername = targetUsername ?? selfUser;
    this.isSelf = !targetUsername || targetUsername.toLowerCase() === selfUser.toLowerCase();

    if (!this.isSelf && this.targetUsername) {
      hub.inspectedProfile = null;
      hub.send({ type: "user_info_req", username: this.targetUsername });
    }
    hub.send({ type: "rankings_req", sortBy: "wins" });

    this.btTabPrivate = new SpriteButton(31, 326, () => {
      this.tab = "private";
      this.btTabPrivate.toggled = true;
      this.btTabResult.toggled = false;
    }, { isTab: true });
    this.btTabResult = new SpriteButton(98, 326, () => {
      this.tab = "result";
      this.btTabResult.toggled = true;
      this.btTabPrivate.toggled = false;
      imeHost.blur();
    }, { isTab: true });
    this.btTabResult.toggled = true;

    this.btWhisper = new SpriteButton(58, 209, () => {
      if (!this.isSelf && onSmsTo) {
        this.closed = true;
        onSmsTo(this.targetUsername);
      }
    });
    this.btFriend = new SpriteButton(203, 273, () => {
      if (!this.isSelf) {
        this.hub.send({ type: "friend_add", username: this.targetUsername });
      }
    });
    this.btModify = new SpriteButton(287, 273, () => {
      if (this.isSelf) {
        this.hub.send({
          type: "update_memo",
          memo: this.edMemo.value,
          nickname: this.edName.value,
          gender: this.chkFemale.checked ? 1 : 0,
          school: this.edSchool.value,
          communityLogo: this.communityLogoCode,
        });
      }
    });
    this.btClose = new SpriteButton(159, 528, () => {
      this.closed = true;
      imeHost.blur();
    });

    const isFemale = hub.profile?.gender === 1;
    this.chkMale = new SpriteCheckBox(258, 107, !isFemale, () => {
      this.chkMale.checked = true;
      this.chkFemale.checked = false;
    });
    this.chkFemale = new SpriteCheckBox(318, 107, isFemale, () => {
      this.chkFemale.checked = true;
      this.chkMale.checked = false;
    });
    this.chkOpen = new SpriteCheckBox(173, 286, true);

    // Exact `CMyInfoDialog` PE coordinates:
    // `edName (dx+264, dy+79, 102, 12)`, `edSchool (dx+164, dy+369, 180, 12)`, `edMemo (dx+164, dy+399, 180, 40)`
    this.edName = new WebGpuEditBox({
      x: this.dx + 264,
      y: this.dy + 79,
      w: 102,
      h: 12,
      maxLength: 14,
    });
    this.edSchool = new WebGpuEditBox({
      x: this.dx + 164,
      y: this.dy + 369,
      w: 180,
      h: 12,
      maxLength: 30,
      onTab: () => this.edMemo.focus(),
    });
    this.edMemo = new WebGpuEditBox({
      x: this.dx + 164,
      y: this.dy + 399,
      w: 180,
      h: 40,
      maxLength: 80,
    });
    if (this.isSelf && hub.profile) {
      this.edName.value = hub.profile.nickname;
      this.edSchool.value = hub.profile.school ?? "爆爆王學園";
      this.edMemo.value = hub.profile.memo;
      this.communityLogoCode = hub.profile.communityLogo ?? 0;
    }

    const isHinet = hub.channelName.toLowerCase().includes("hinet");
    const bgName = this.isSelf
      ? "Dialog/DlgMyinfo"
      : isHinet
        ? "Event/DlgUserInfo_Hinet"
        : "Dialog/DlgUserInfo";
    const resName = isHinet ? "Event/DlgUserinfoResults_Hinet" : "Dialog/DlgUserinfoResults";
    void Promise.all([
      assets.loadSheet("Fx", bgName),
      assets.loadSheet("Fx", resName),
      assets.loadSheet("Fx", "Dialog/BtUserinforPrivate"),
      assets.loadSheet("Fx", "Dialog/BtUserinforResult"),
      assets.loadSheet("Fx", "Dialog/Bt_InfoWhisper"),
      assets.loadSheet("Fx", "Dialog/Bt_InfoTogether"),
      assets.loadSheet("Fx", this.isSelf ? "Dialog/Bt_infoAdjust" : "Dialog/Bt_InfoReset"),
      assets.loadSheet("Fx", "Dialog/BtClose"),
      assets.loadSheet("Fx", "Dialog/BtCheckBox"),
      assets.loadSheet("Cx", "Etc/LevelIcons"),
      assets.loadSheet("Cx", "Etc/CommunityLogo01"),
      assets.loadSheet("Cx", "Etc/CommunityLogo02"),
      assets.loadSheet("Cx", "Etc/CommunityLogo04"),
      assets.loadSheet("Cx", "Etc/CommunityLogo05"),
      assets.loadSheet("Cx", "Etc/CommunityLogo06"),
    ]).then(([bg, ro, tp, tr, wh, fr, md, cl, chk, lv, c1, c2, c4, c5, c6]) => {
      this.bg = bg;
      this.resOverlay = ro;
      this.btTabPrivate.bindSheet(tp, 67, 22);
      this.btTabResult.bindSheet(tr, 67, 22);
      this.btWhisper.bindSheet(wh, 88, 28);
      this.btFriend.bindSheet(fr, 77, 28);
      this.btModify.bindSheet(md, 77, 28);
      this.btClose.bindSheet(cl, 100, 32);
      this.chkMale.bindSheet(chk);
      this.chkFemale.bindSheet(chk);
      this.chkOpen.bindSheet(chk);
      this.levelSheet = lv;
      if (c1) this.communityLogos.set(1, c1);
      if (c2) this.communityLogos.set(2, c2);
      if (c4) this.communityLogos.set(4, c4);
      if (c5) this.communityLogos.set(5, c5);
      if (c6) this.communityLogos.set(6, c6);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    if (this.communityPopup && !this.communityPopup.closed) {
      this.communityPopup.onMouseMove(mx, my, sound);
      return;
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabPrivate, this.btTabResult, this.btWhisper, this.btFriend, this.btModify, this.btClose]) {
      b.onMouseMove(lx, ly, sound);
    }
    if (this.isSelf) {
      this.chkMale.onMouseMove(lx, ly);
      this.chkFemale.onMouseMove(lx, ly);
      this.chkOpen.onMouseMove(lx, ly);
    }
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.communityPopup && !this.communityPopup.closed) {
      return this.communityPopup.onMouseDown(mx, my);
    }
    if (this.isSelf && this.edName.handleMouseDown(mx, my)) return true;
    if (this.tab === "private" && this.isSelf) {
      if (this.edSchool.handleMouseDown(mx, my) || this.edMemo.handleMouseDown(mx, my)) return true;
      const lx0 = mx - this.dx;
      const ly0 = my - this.dy;
      if (lx0 >= 48 && lx0 <= 368 && ly0 >= 446 && ly0 <= 496) {
        imeHost.blur();
        this.communityPopup = new SelectCommunityDlg(this.assets, this.communityLogoCode, (picked) => {
          this.communityLogoCode = picked;
          this.hub.send({
            type: "update_memo",
            memo: this.edMemo.value,
            nickname: this.edName.value,
            gender: this.chkFemale.checked ? 1 : 0,
            school: this.edSchool.value,
            communityLogo: picked,
          });
        });
        return true;
      }
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabPrivate, this.btTabResult, this.btWhisper, this.btFriend, this.btModify, this.btClose]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    if (this.isSelf) {
      if (this.chkMale.onMouseDown(lx, ly)) return true;
      if (this.chkFemale.onMouseDown(lx, ly)) return true;
      if (this.chkOpen.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.communityPopup && !this.communityPopup.closed) {
      return this.communityPopup.onMouseUp(mx, my, sound);
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabPrivate, this.btTabResult, this.btWhisper, this.btFriend, this.btModify, this.btClose]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.isSelf) {
      if (this.chkMale.onMouseUp(lx, ly, sound)) return true;
      if (this.chkFemale.onMouseUp(lx, ly, sound)) return true;
      if (this.chkOpen.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (this.communityPopup && !this.communityPopup.closed) {
      return this.communityPopup.onKeyDown(e);
    }
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const p = this.isSelf ? this.hub.profile : this.hub.inspectedProfile;

    if (p) {
      // Exact `CA.exe` `CUserInfoDialog` / `CMyInfoDialog`:
      // Level icon `(dx+80, dy+77)` + ID label, avatar slot `(dx+53, dy+99)`, status well `(dx+170, dy+229, 180, 27)`
      const tick = Math.floor(nowMs / 30);
      const dispLv = Math.max(1, Math.min(450, p.level + (p.equipped.levelDisguiseDelta ?? 0)));
      drawLevelIcon(
        r,
        this.levelSheet,
        dispLv,
        this.dx + 80,
        this.dy + 77,
        this.cache.getTwinkleSheet(this.assets, p.equipped.levelEffectIdx),
        tick,
        this.cache.getRotateSheet(this.assets, p.equipped.levelEffectIdx),
      );
      r.drawText(p.username, this.dx + 100, this.dy + 78, { color: [0.06, 0.14, 0.28, 1] });

      const uStocks = [
        p.equipped.slotDecoStockId,
        p.equipped.fanfareStockId,
        p.equipped.hatStockId,
        p.equipped.idDecoStockId,
      ];
      const slotX = this.dx + 53;
      const slotY = this.dy + 99;
      const hasSlotBg = this.cache.drawSlotCosmeticsForStocks(
        r,
        this.assets,
        uStocks,
        "back",
        slotX,
        slotY,
        tick,
      );
      this.cache.drawDisplayBomber(
        r,
        this.assets,
        p.selectedChar >= 0 ? p.selectedChar : 0,
        1,
        hasSlotBg ? slotX + 32 : this.dx + 102,
        hasSlotBg ? slotY + 94 : this.dy + 187,
        tick,
        false,
        uStocks,
      );
      this.cache.drawSlotCosmeticsForStocks(r, this.assets, uStocks, "front", slotX, slotY, tick);

      const myRank = this.hub.rankings.find((rk) => rk.username.toLowerCase() === p.username.toLowerCase());
      if (this.isSelf) {
        this.edName.render(r, nowMs);
        this.chkMale.render(r, this.dx, this.dy);
        this.chkFemale.render(r, this.dx, this.dy);
        this.chkOpen.render(r, this.dx, this.dy);
        r.drawText(`${p.exp} / ${p.nextExp}`, this.dx + 262, this.dy + 139, {
          color: [0.12, 0.34, 0.58, 1],
        });
        r.drawText(`${p.lucci.toLocaleString()}`, this.dx + 262, this.dy + 169, {
          color: [0.08, 0.42, 0.22, 1],
        });
      } else {
        r.drawText(p.nickname, this.dx + 269, this.dy + 78, {
          color: [0.06, 0.14, 0.28, 1],
        });
        r.drawText(p.gender === 1 ? "女生" : "男生", this.dx + 269, this.dy + 108, {
          color: [0.16, 0.26, 0.44, 1],
        });
        r.drawText(`${p.exp} / ${p.nextExp}`, this.dx + 269, this.dy + 138, {
          color: [0.12, 0.34, 0.58, 1],
        });
        r.drawText(`${p.lucci.toLocaleString()}`, this.dx + 269, this.dy + 168, {
          color: [0.08, 0.42, 0.22, 1],
        });
      }

      r.drawText(
        myRank ? `第 ${myRank.rank} 名 (${myRank.wins}勝 ${myRank.winRate}%)` : "伺服器排名統計中",
        this.dx + 170,
        this.dy + 235,
        { color: [0.68, 0.22, 0.08, 1], maxWidth: 180 },
      );
    }

    this.btTabPrivate.render(r, this.dx, this.dy);
    this.btTabResult.render(r, this.dx, this.dy);
    if (!this.isSelf) {
      this.btWhisper.render(r, this.dx, this.dy);
      this.btFriend.render(r, this.dx, this.dy);
      this.btModify.render(r, this.dx, this.dy);
    } else {
      this.btModify.render(r, this.dx, this.dy);
    }

    if (this.tab === "result") {
      drawSheetFrame(r, this.resOverlay, 0, this.dx + 30, this.dy + 348);
      if (p) {
        const total = p.wins + p.losses + p.draws;
        const rate = total > 0 ? Math.round((p.wins * 100) / total) : 0;
        r.drawText(`${total} 戰  ${p.wins} 勝  ${p.draws} 平  ${p.losses} 敗  (${rate}%)`, this.dx + 162, this.dy + 368, {
          color: [0.06, 0.14, 0.28, 1],
        });
        r.drawText(`擊破 ${p.kills} 次 / 救援 ${p.saves} 次`, this.dx + 162, this.dy + 398, {
          color: [0.12, 0.28, 0.52, 1],
        });
        this.hub.rankings.slice(0, 3).forEach((rk, i) => {
          r.drawText(
            `#${rk.rank} ${rk.nickname} (Lv.${rk.level}) — ${rk.wins}勝 ${rk.winRate}%`,
            this.dx + 48,
            this.dy + 428 + i * 20,
            { color: [0.10, 0.20, 0.38, 1] },
          );
        });
      }
    } else if (p) {
      const logoCode = this.isSelf ? this.communityLogoCode : (p.communityLogo ?? 0);
      const logoSheet = this.communityLogos.get(logoCode);
      const logoFrame = Math.floor(nowMs / 220) % 3;
      if (this.isSelf) {
        this.edSchool.render(r, nowMs);
        this.edMemo.render(r, nowMs);
        const optLabel =
          COMMUNITY_LOGO_OPTIONS.find((o) => o.code === logoCode)?.label ?? "點擊選擇社群徽章";
        r.drawText(`社群徽章：${optLabel}（點擊切換）`, this.dx + 54, this.dy + 462, {
          color: [0.10, 0.30, 0.62, 1],
        });
        if (logoSheet) {
          drawSheetFrame(r, logoSheet, logoFrame, this.dx + 278, this.dy + 450);
        }
      } else {
        r.drawText(p.school || "爆爆王學園", this.dx + 162, this.dy + 368, {
          color: [0.12, 0.24, 0.44, 1],
        });
        r.drawText(p.memo || "(無自我介紹)", this.dx + 162, this.dy + 398, {
          color: [0.08, 0.16, 0.30, 1],
          maxWidth: 196,
        });
        if (logoSheet) {
          drawSheetFrame(r, logoSheet, logoFrame, this.dx + 268, this.dy + 448);
        }
      }
    }

    // Also render animated `CLogoMan` `Cx:Etc/CommunityLogo01..06` badge on top-right card header when set (`CA.exe.c:203445`)!
    if (p) {
      const hdrLogo = this.communityLogos.get(this.isSelf ? this.communityLogoCode : (p.communityLogo ?? 0));
      if (hdrLogo) {
        drawSheetFrame(r, hdrLogo, Math.floor(nowMs / 220) % 3, this.dx + 284, this.dy + 196);
      }
    }

    this.btClose.render(r, this.dx, this.dy);
    if (this.communityPopup && !this.communityPopup.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.communityPopup.render(r, nowMs);
    }
  }
}

// ─── 8. CShopBuyDlg (`Shop/Popup_Buy` `400x317` / `Popup_Discount` `406x494`) ─

export class ShopBuyDlg implements ModalDialog {
  readonly id = "shop_buy";
  closed = false;
  private readonly dx: number;
  private readonly dy: number;
  private bg: LoadedSheet | null = null;
  private discountSlotSheet: LoadedSheet | null = null;
  private iconCouponSheet: LoadedSheet | null = null;
  private readonly isDiscountPopup: boolean;
  private readonly pkgChildItems: StockItem[] = [];
  private readonly matchedCouponId: number | undefined;
  private readonly matchedCouponPct: number;
  private useCouponDiscount = false;
  private readonly chkUseCoupon: SpriteCheckBox | null = null;
  private readonly btBuy: SpriteButton;
  private readonly btPresent: SpriteButton;
  private readonly btCart: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly cache = new CharacterPreviewCache();
  private readonly assets: GameAssets;
  private readonly item: StockItem;
  private readonly currency: "lucci" | "cash";

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    item: StockItem,
    currency: "lucci" | "cash",
    onPresent: () => void,
    onAddCart: () => void,
  ) {
    this.assets = assets;
    this.item = item;
    this.currency = currency;

    // Exact `CA.exe.c:52972..53535` (`sub_439847` bundle set items OR owned matching coupon):
    const childIds = assets.tables?.packageMap.get(item.id) ?? [];
    for (const cid of childIds.slice(0, 6)) {
      const childSpec = assets.tables?.stockById.get(cid);
      if (childSpec) this.pkgChildItems.push(childSpec);
    }
    const coupon = hub.coupons.find(
      (c) => c.quantity > 0 && (c.stockId === item.id || c.stockId === 0),
    );
    this.matchedCouponId = coupon?.couponId;
    this.matchedCouponPct = coupon?.discountPct ?? 0;
    this.useCouponDiscount = Boolean(coupon);

    this.isDiscountPopup = this.pkgChildItems.length > 0 || Boolean(coupon);
    this.dx = this.isDiscountPopup ? 197 : 200;
    this.dy = this.isDiscountPopup ? 53 : 141;

    if (coupon) {
      this.chkUseCoupon = new SpriteCheckBox(34, 332, true, (next) => {
        this.useCouponDiscount = next;
      });
    }

    // Exact `CA.exe` button layout:
    //   `Popup_Buy` (`400x317`): `(38 | 120 | 202 | 301, 238)`
    //   `Popup_Discount` (`406x494`): `(38 | 121 | 204 | 306, 421)` (`CA.exe.c:53120..53225`)
    const btnY = this.isDiscountPopup ? 421 : 238;
    this.btBuy = new SpriteButton(38, btnY, () => {
      hub.send({
        type: "shop_buy",
        stockId: item.id,
        currency,
        couponId: this.useCouponDiscount ? this.matchedCouponId : undefined,
      });
      this.closed = true;
    });
    this.btPresent = new SpriteButton(this.isDiscountPopup ? 121 : 120, btnY, () => {
      this.closed = true;
      onPresent();
    });
    this.btPresent.enabled = currency !== "lucci" && ((item.flags ?? 0) & 1) === 0;
    this.btCart = new SpriteButton(this.isDiscountPopup ? 204 : 202, btnY, () => {
      this.closed = true;
      onAddCart();
    });
    this.btClose = new SpriteButton(this.isDiscountPopup ? 306 : 301, btnY, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", this.isDiscountPopup ? "Shop/Popup_Discount" : "Shop/Popup_Buy"),
      assets.loadSheet("Fx", "Shop/BtPopup_Purchase"),
      assets.loadSheet("Fx", "Shop/BtPopup_Present"),
      assets.loadSheet("Fx", "Shop/BtPopup_ShoppingBag"),
      assets.loadSheet("Fx", "Shop/BtPopup_Close"),
      this.isDiscountPopup ? assets.loadSheet("Fx", "Shop/DiscountSlotImg") : Promise.resolve(null),
      coupon ? assets.loadSheet("Fx", "Shop/IconCoupon") : Promise.resolve(null),
      coupon ? assets.loadSheet("Fx", "Dialog/BtCheckBox") : Promise.resolve(null),
    ]).then(([bg, bu, pr, ca, cl, ds, ic, chk]) => {
      this.bg = bg;
      this.discountSlotSheet = ds;
      this.iconCouponSheet = ic;
      if (this.chkUseCoupon && chk) this.chkUseCoupon.bindSheet(chk);
      this.btBuy.bindSheet(bu, 79, 36);
      this.btPresent.bindSheet(pr, 79, 36);
      this.btCart.bindSheet(ca, 88, 36);
      this.btClose.bindSheet(cl, 63, 36);
    });
  }

  private effectivePrice(): number {
    const raw = this.currency === "lucci" ? this.item.priceLucci : this.item.priceCash;
    if (this.useCouponDiscount && this.matchedCouponPct > 0) {
      return Math.max(0, raw - Math.floor(this.matchedCouponPct * 0.01 * raw));
    }
    return raw;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.chkUseCoupon?.onMouseMove(lx, ly);
    for (const b of [this.btBuy, this.btPresent, this.btCart, this.btClose]) b.onMouseMove(lx, ly, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.chkUseCoupon?.onMouseDown(lx, ly)) return true;
    for (const b of [this.btBuy, this.btPresent, this.btCart, this.btClose]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.chkUseCoupon?.onMouseUp(lx, ly, sound)) return true;
    for (const b of [this.btBuy, this.btPresent, this.btCart, this.btClose]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const curUnit = this.currency === "lucci" ? "LUCCI" : "點數";
    const effPrice = this.effectivePrice();

    if (this.isDiscountPopup) {
      // Header item summary inside `Shop/Popup_Discount` (`406x494`)
      this.cache.drawStockIcon(r, this.assets, this.item, this.dx + 68, this.dy + 74, 48, 44);
      r.drawText(this.item.name, this.dx + 112, this.dy + 56, { color: [0.06, 0.14, 0.28, 1] });
      r.drawText(`${effPrice.toLocaleString()} ${curUnit}`, this.dx + 112, this.dy + 78, {
        color: [0.72, 0.20, 0.08, 1],
      });

      // CA.exe.c:53438–53590: column stride 173; icons use their native anchor.
      this.pkgChildItems.forEach((child, idx) => {
        const col = idx % 2;
        const row = Math.floor(idx / 2);
        const sx = this.dx + 32 + col * 173;
        const sy = this.dy + 111 + row * 70;
        drawSheetFrame(r, this.discountSlotSheet, 0, sx, sy, { anchor: true });
        this.cache.drawStockIconAnchored(r, this.assets, child, sx + 13, sy + 70);
        const isLucci = stockCurrency(child) === "lucci";
        r.drawText(child.name.slice(0, 7), sx + 68, sy + 11, {
          color: isLucci ? [0.10, 0.44, 0.18, 1] : [0.06, 0.14, 0.28, 1],
        });
        const subVal = isLucci
          ? `${child.priceLucci.toLocaleString()} L`
          : `${child.priceCash.toLocaleString()} 點`;
        r.drawText(subVal, sx + 68, sy + 46, {
          color: [0.44, 0.20, 0.08, 1],
        });
      });

      if (this.chkUseCoupon) {
        this.chkUseCoupon.render(r, this.dx, this.dy);
        drawSheetFrame(r, this.iconCouponSheet, 0, this.dx + 56, this.dy + 330);
        r.drawText(
          `使用 ${this.matchedCouponPct}% 折扣優惠券（折後 ${effPrice.toLocaleString()} ${curUnit}）`,
          this.dx + 100,
          this.dy + 333,
          { color: [0.78, 0.18, 0.08, 1] },
        );
      }

      // Confirmation line (`CA.exe.c:53380`: `(40, 360, 400, 56)` `RGB(0x93, 0xE4, 0xFF)`)
      r.drawText(`確定要購買「${this.item.name.slice(0, 12)}」嗎？`, this.dx + 203, this.dy + 372, {
        align: "center",
        color: [0.58, 0.89, 1.0, 1],
        outlineColor: [0.04, 0.12, 0.26, 0.95],
      });
    } else {
      this.cache.drawStockIcon(r, this.assets, this.item, this.dx + 92, this.dy + 132, 64, 58);
      r.drawText(this.item.name, this.dx + 168, this.dy + 98, { color: [0.06, 0.14, 0.28, 1] });
      const price = `${effPrice.toLocaleString()} ${curUnit}`;
      r.drawText(price, this.dx + 168, this.dy + 124, { color: [0.72, 0.20, 0.08, 1] });
      const description = this.assets.tables?.stringTable.get(this.item.descriptionId) ?? "";
      const line = description.replaceAll("*", " ").trim();
      if (line) r.drawText(line.slice(0, 18), this.dx + 168, this.dy + 150, { color: [0.16, 0.28, 0.44, 1] });
    }
    this.btBuy.render(r, this.dx, this.dy);
    this.btPresent.render(r, this.dx, this.dy);
    this.btCart.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
  }
}

export class ShopPresentDlg implements ModalDialog {
  readonly id = "shop_present";
  closed = false;
  private readonly dx = 200;
  private readonly dy = 178;
  private bg: LoadedSheet | null = null;
  private readonly edTarget: WebGpuEditBox;
  private readonly edMsg: WebGpuEditBox;
  private readonly btPickUser: SpriteButton;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private userPicker: SelectUserDlg | null = null;
  private readonly itemName: string;

  constructor(assets: GameAssets, hub: ClientHub, item: StockItem, currency: "lucci" | "cash") {
    this.itemName = item.name;
    // Exact `DlgShopPresent` (`400x243`) input wells: `(dx+180, dy+86, 150, 18)` & `(dx+180, dy+121, 150, 20)`
    this.edTarget = new WebGpuEditBox({
      x: this.dx + 180,
      y: this.dy + 86,
      w: 150,
      h: 18,
      maxLength: 16,
      onTab: () => this.edMsg.focus(),
    });
    this.edMsg = new WebGpuEditBox({
      x: this.dx + 180,
      y: this.dy + 121,
      w: 150,
      h: 20,
      maxLength: 60,
      onEnter: () => this.btOk.onClick?.(),
    });
    this.edMsg.value = `送你【${item.name}】！`;

    this.btPickUser = new SpriteButton(334, 83, () => {
      const candidates: { username: string; nickname: string }[] = [];
      const seen = new Set<string>();
      const myUser = (hub.profile?.username ?? "").toLowerCase();
      for (const f of hub.friends) {
        const key = f.username.toLowerCase();
        if (key && key !== myUser && !seen.has(key)) {
          seen.add(key);
          candidates.push({ username: f.username, nickname: f.username });
        }
      }
      for (const u of hub.lobbyUsers) {
        const key = u.username.toLowerCase();
        if (key && key !== myUser && !seen.has(key)) {
          seen.add(key);
          candidates.push({ username: u.username, nickname: u.nickname || u.username });
        }
      }
      imeHost.blur();
      this.userPicker = new SelectUserDlg(
        assets,
        candidates,
        (picked) => {
          this.edTarget.value = picked.username;
          this.edMsg.focus();
        },
        { variant: "shop" },
      );
    });
    this.btOk = new SpriteButton(119, 170, () => {
      const to = this.edTarget.value.trim();
      if (!to) return;
      hub.send({ type: "shop_gift", stockId: item.id, toUsername: to, message: this.edMsg.value, currency });
      this.closed = true;
      imeHost.blur();
    });
    this.btCancel = new SpriteButton(206, 170, () => {
      this.closed = true;
      imeHost.blur();
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgShopPresent"),
      assets.loadSheet("Fx", "Dialog/BtShopConfirm"),
      assets.loadSheet("Fx", "Dialog/BtShopCancel"),
      assets.loadSheet("Fx", "WhisperLog/BtWhisperLogArrow"),
    ]).then(([bg, ok, ca, arw]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 77, 36);
      this.btCancel.bindSheet(ca, 77, 36);
      this.btPickUser.bindSheet(arw, 27, 24);
    });
    setTimeout(() => this.edTarget.focus(), 20);
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    if (this.userPicker && !this.userPicker.closed) {
      this.userPicker.onMouseMove(mx, my, sound);
      return;
    }
    this.btPickUser.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    if (this.userPicker && !this.userPicker.closed) {
      return this.userPicker.onMouseDown(mx, my, sound);
    }
    if (this.edTarget.handleMouseDown(mx, my) || this.edMsg.handleMouseDown(mx, my)) return true;
    if (this.btPickUser.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.userPicker && !this.userPicker.closed) {
      const r = this.userPicker.onMouseUp(mx, my, sound);
      if (this.userPicker.closed) this.userPicker = null;
      return r;
    }
    if (this.btPickUser.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    r.drawText(this.itemName, this.dx + 200, this.dy + 60, {
      align: "center",
      color: [0.06, 0.14, 0.28, 1],
    });
    this.edTarget.render(r, nowMs);
    this.edMsg.render(r, nowMs);
    this.btPickUser.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
    if (this.userPicker && !this.userPicker.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.userPicker.render(r, nowMs);
    }
  }
}

// ─── 9. CSmsDlg (`Dialog/Dlg_SMS` `426x320` at `(187, 140)`) + `CSmsNoticeDlg` (`CA.exe.c:130315`) ──

export class SmsNoticeDlg implements ModalDialog {
  readonly id = "sms_notice";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 202;
  private bg: LoadedSheet | null = null;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton | null;

  constructor(
    assets: GameAssets,
    kind: "yesno" | "delete" | "ok",
    onConfirm: () => void,
  ) {
    const bgPath =
      kind === "yesno"
        ? "Dialog/Dlg_SMSNoticeYesNo"
        : kind === "delete"
          ? "Dialog/Dlg_SMSNoticeDelete"
          : "Dialog/Dlg_SMSNoticeOk";
    const twoButtons = kind !== "ok";
    this.btOk = new SpriteButton(twoButtons ? 78 : 127, 148, () => {
      this.closed = true;
      onConfirm();
    });
    this.btCancel = twoButtons
      ? new SpriteButton(176, 148, () => {
          this.closed = true;
        })
      : null;

    void Promise.all([
      assets.loadSheet("Fx", bgPath),
      assets.loadSheet("Fx", "Dialog/Bt_SMSNoticeOk"),
      twoButtons ? assets.loadSheet("Fx", "Dialog/Bt_SMSNoticeCancel") : Promise.resolve(null),
    ]).then(([bg, ok, ca]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 86, 25);
      if (this.btCancel && ca) this.btCancel.bindSheet(ca, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel?.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel?.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel?.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel?.render(r, this.dx, this.dy);
  }
}

export class SmsFriendDlg implements ModalDialog {
  readonly id = "sms";
  closed = false;
  private readonly dx = 187;
  private readonly dy = 140;

  private bg: LoadedSheet | null = null;
  private inboxImg: LoadedSheet | null = null;
  private sendImg: LoadedSheet | null = null;
  private selBar: LoadedSheet | null = null;
  private listLineSheet: LoadedSheet | null = null;
  private listCapSheet: LoadedSheet | null = null;
  private iconSms: LoadedSheet | null = null;
  private smsPopup: LoadedSheet | null = null;
  private sendBtnSheet: LoadedSheet | null = null;
  private replyBtnSheet: LoadedSheet | null = null;
  private closeBtnSheet: LoadedSheet | null = null;
  private cancelBtnSheet: LoadedSheet | null = null;
  private smsNotice: SmsNoticeDlg | null = null;
  private readonly assets: GameAssets;
  private tab: "inbox" | "send" = "inbox";
  private selectedSmsIdx = 0;
  private hoveredRow = -1;
  private expandedIdx = -1;

  private readonly btTabInbox: SpriteButton;
  private readonly btTabSend: SpriteButton;
  private readonly btDelAll: SpriteButton;
  private readonly btDel: SpriteButton;
  private readonly btSend: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly scroll: SpriteScrollBar;
  private readonly edTo: WebGpuEditBox;
  private readonly edBody: WebGpuEditBox;
  private readonly hub: ClientHub;

  constructor(assets: GameAssets, hub: ClientHub, initialTarget = "") {
    this.assets = assets;
    this.hub = hub;
    if (initialTarget) this.tab = "send";

    // Exact `CSMSDlg` custom 23px scrollbar (`Dialog/SMSScroll_*`, `CA.exe.c:48397`)
    this.scroll = new SpriteScrollBar(357, 137, 23, 109);
    this.btTabInbox = new SpriteButton(37, 76, () => {
      this.tab = "inbox";
      this.expandedIdx = -1;
      this.syncTabLayout();
      imeHost.blur();
    }, { isTab: true });
    this.btTabSend = new SpriteButton(214, 76, () => {
      this.tab = "send";
      this.expandedIdx = -1;
      this.syncTabLayout();
      this.edTo.focus();
    }, { isTab: true });

    // Exact `CA.exe` `CSmsDlg` + `CSmsNoticeDlg` (`L48250..48290`, `L130315..130338`):
    //   Inbox action row: `Bt_SMSDelAll (48)`, `Bt_SMSDel (133)`, `Bt_SMSReply (218)`, `Bt_SMSClose (303)` @ `y=255`
    //   Send action row:  `Bt_SMSSend (131, 262)` & `Bt_SMSCancel (220, 262)`
    this.btDelAll = new SpriteButton(48, 255, () => {
      if (this.hub.sms.length === 0) return;
      this.smsNotice = new SmsNoticeDlg(this.assets, "delete", () => {
        this.expandedIdx = -1;
        this.hub.send({ type: "sms_delete", smsId: 0, deleteAll: true });
      });
    });
    this.btDel = new SpriteButton(133, 255, () => {
      const s = this.hub.sms[this.selectedSmsIdx];
      if (s) {
        this.smsNotice = new SmsNoticeDlg(this.assets, "delete", () => {
          this.expandedIdx = -1;
          this.hub.send({ type: "sms_delete", smsId: s.id });
        });
      }
    });
    this.btSend = new SpriteButton(218, 255, () => {
      if (this.tab === "inbox") {
        const s = this.hub.sms[this.selectedSmsIdx];
        if (s) {
          this.edTo.value = s.sender;
          this.tab = "send";
          this.expandedIdx = -1;
          this.syncTabLayout();
          this.edBody.focus();
        }
      } else {
        const to = this.edTo.value.trim();
        const body = this.edBody.value.trim();
        if (to && body) {
          this.smsNotice = new SmsNoticeDlg(this.assets, "yesno", () => {
            this.hub.send({ type: "sms_send", to, body });
            this.edBody.value = "";
            this.tab = "inbox";
            this.syncTabLayout();
            imeHost.blur();
          });
        }
      }
    });
    this.btClose = new SpriteButton(303, 255, () => {
      if (this.tab === "send") {
        this.tab = "inbox";
        this.syncTabLayout();
        imeHost.blur();
        return;
      }
      this.closed = true;
      imeHost.blur();
    });

    // Exact `CSmsDlg` Send tab edit wells (`L49824` + PE table):
    // `edTo (dx+64, dy+142, 146, 17)`, `edBody (dx+63, dy+198, 305, 40)`
    this.edTo = new WebGpuEditBox({
      x: this.dx + 64,
      y: this.dy + 142,
      w: 146,
      h: 17,
      maxLength: 16,
      onTab: () => this.edBody.focus(),
    });
    this.edTo.value = initialTarget;

    this.edBody = new WebGpuEditBox({
      x: this.dx + 63,
      y: this.dy + 198,
      w: 305,
      h: 40,
      maxLength: 80,
      onEnter: () => this.btSend.onClick?.(),
    });

    this.syncTabLayout();

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/Dlg_SMS"),
      assets.loadSheet("Fx", "Dialog/SMSList01"),
      assets.loadSheet("Fx", "Dialog/SMSList02"),
      assets.loadSheet("Fx", "Dialog/SMSList03"),
      assets.loadSheet("Fx", "Dialog/Dlg_SMSImg"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSSelBar"),
      assets.loadSheet("Fx", "Dialog/Icon_SMS"),
      assets.loadSheet("Fx", "Dialog/ImgSMSPopUp"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSReceiveTab"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSSendTab"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSDelAll"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSDel"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSSend"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSReply"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSClose"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSCancel"),
      this.scroll.loadSmsTheme(assets),
    ]).then(([bg, i0, l2, l3, i1, sb, ic, pu, ti, ts, da, de, se, rp, cl, ca]) => {
      this.bg = bg;
      this.inboxImg = i0;
      this.listLineSheet = l2;
      this.listCapSheet = l3;
      this.sendImg = i1;
      this.selBar = sb;
      this.iconSms = ic;
      this.smsPopup = pu;
      this.sendBtnSheet = se;
      this.replyBtnSheet = rp;
      this.closeBtnSheet = cl;
      this.cancelBtnSheet = ca;
      this.btTabInbox.bindSheet(ti, 177, 22);
      this.btTabSend.bindSheet(ts, 177, 22);
      this.btDelAll.bindSheet(da, 77, 23);
      this.btDel.bindSheet(de, 77, 23);
      this.syncTabLayout();
    });

    if (this.tab === "send") {
      setTimeout(() => (initialTarget ? this.edBody.focus() : this.edTo.focus()), 20);
    }
  }

  private syncTabLayout(): void {
    const isInbox = this.tab === "inbox";
    this.btTabInbox.toggled = isInbox;
    this.btTabSend.toggled = !isInbox;
    this.btDelAll.visible = isInbox;
    this.btDel.visible = isInbox;
    this.btSend.x = isInbox ? 218 : 131;
    this.btSend.y = isInbox ? 255 : 262;
    this.btClose.x = isInbox ? 303 : 220;
    this.btClose.y = isInbox ? 255 : 262;
    if (isInbox) {
      if (this.replyBtnSheet) this.btSend.bindSheet(this.replyBtnSheet, 77, 23);
      if (this.closeBtnSheet) this.btClose.bindSheet(this.closeBtnSheet, 77, 23);
    } else {
      if (this.sendBtnSheet) this.btSend.bindSheet(this.sendBtnSheet, 77, 23);
      if (this.cancelBtnSheet) this.btClose.bindSheet(this.cancelBtnSheet, 77, 23);
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    if (this.smsNotice && !this.smsNotice.closed) {
      this.smsNotice.onMouseMove(mx, my, sound);
      return;
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabInbox, this.btTabSend, this.btDelAll, this.btDel, this.btSend, this.btClose]) {
      b.onMouseMove(lx, ly, sound);
    }
    this.hoveredRow = -1;
    if (this.tab === "inbox") {
      this.scroll.onMouseMove(lx, ly);
      for (let i = 0; i < 5; i++) {
        if (!this.hub.sms[this.scroll.value + i]) break;
        if (pointInRect(lx, ly, { x: 53, y: 137 + i * 22, w: 304, h: 21 })) {
          this.hoveredRow = i;
          break;
        }
      }
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    if (this.smsNotice && !this.smsNotice.closed) {
      return this.smsNotice.onMouseDown(mx, my);
    }
    if (this.tab === "send") {
      if (this.edTo.handleMouseDown(mx, my) || this.edBody.handleMouseDown(mx, my)) return true;
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabInbox, this.btTabSend, this.btDelAll, this.btDel, this.btSend, this.btClose]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    if (this.tab === "inbox") {
      if (this.scroll.onMouseDown(lx, ly)) return true;
      for (let i = 0; i < 5; i++) {
        const idx = this.scroll.value + i;
        if (!this.hub.sms[idx]) break;
        if (pointInRect(lx, ly, { x: 53, y: 137 + i * 22, w: 304, h: 21 })) {
          this.selectedSmsIdx = idx;
          this.expandedIdx = this.expandedIdx === idx ? -1 : idx;
          this.hub.sms[idx]!.read = true;
          sound.playSfx("ButtonDown_0", 0.5);
          return true;
        }
      }
      if (this.expandedIdx >= 0) {
        this.expandedIdx = -1;
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.smsNotice && !this.smsNotice.closed) {
      const handled = this.smsNotice.onMouseUp(mx, my, sound);
      if (this.smsNotice.closed) this.smsNotice = null;
      return handled;
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btTabInbox, this.btTabSend, this.btDelAll, this.btDel, this.btSend, this.btClose]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.tab === "inbox") this.scroll.onMouseUp(lx, ly, sound);
    return true;
  }

  onWheel(deltaY: number): boolean {
    if (this.tab === "inbox") {
      this.expandedIdx = -1;
      this.scroll.scrollBy(deltaY > 0 ? 1 : -1);
    }
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btTabInbox.render(r, this.dx, this.dy);
    this.btTabSend.render(r, this.dx, this.dy);

    if (this.tab === "inbox") {
      drawSheetFrame(r, this.inboxImg, 0, this.dx + 37, this.dy + 105);
      this.scroll.setRange(Math.max(0, this.hub.sms.length - 5), false);
      let popupRow = -1;
      for (let i = 0; i < 5; i++) {
        const idx = this.scroll.value + i;
        const s = this.hub.sms[idx];
        if (!s) break;
        const y = 137 + i * 22;
        if (this.listLineSheet && i > 0) {
          drawSheetFrame(r, this.listLineSheet, 0, this.dx + 53, this.dy + y - 1);
        }
        if (idx === this.selectedSmsIdx) {
          drawSheetFrame(r, this.selBar, 1, this.dx + 53, this.dy + y);
        } else if (i === this.hoveredRow) {
          drawSheetFrame(r, this.selBar, 3, this.dx + 53, this.dy + y);
        }
        drawSheetFrame(r, this.iconSms, s.read ? 1 : 0, this.dx + 58, this.dy + y + 7);
        const col = idx === this.selectedSmsIdx ? ([0.98, 0.98, 1.0, 1] as const) : ([0.08, 0.16, 0.30, 1] as const);
        r.drawText(s.sender.slice(0, 10), this.dx + 73, this.dy + y + 5, { color: col, maxWidth: 82 });
        r.drawText(s.body.slice(0, 8), this.dx + 159, this.dy + y + 5, { color: col, maxWidth: 70 });
        r.drawText((s.sentAt || "").slice(5, 16), this.dx + 232, this.dy + y + 5, { color: col, maxWidth: 120 });
        if (idx === this.expandedIdx) popupRow = i;
      }
      this.scroll.render(r, this.dx, this.dy);
      if (popupRow >= 0) {
        const expSms = this.hub.sms[this.expandedIdx];
        if (expSms) {
          const py = 137 + popupRow * 22;
          drawSheetFrame(r, this.smsPopup, 0, this.dx + 53, this.dy + py + 20);
          r.drawText(expSms.body, this.dx + 73, this.dy + py + 25, {
            color: [0.06, 0.14, 0.28, 1],
            maxWidth: 270,
          });
        }
      }
    } else {
      drawSheetFrame(r, this.sendImg, 0, this.dx + 37, this.dy + 105);
      if (this.listCapSheet) {
        drawSheetFrame(r, this.listCapSheet, 0, this.dx + 63, this.dy + 160);
      }
      this.edTo.render(r, nowMs);
      r.drawText("一般短訊", this.dx + 227, this.dy + 146, { color: [0.12, 0.24, 0.44, 1] });
      this.edBody.render(r, nowMs);
      const lenStr = `${this.edBody.value.length}`;
      r.drawText(lenStr, this.dx + 230 - 7 * lenStr.length, this.dy + 252, {
        color: [0.08, 0.18, 0.36, 1],
      });
    }

    this.btDelAll.render(r, this.dx, this.dy);
    this.btDel.render(r, this.dx, this.dy);
    this.btSend.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
    if (this.smsNotice && !this.smsNotice.closed) {
      r.fillRect(0, 0, 800, 600, [0, 0, 0, 0.35]);
      this.smsNotice.render(r);
    }
  }
}

// ─── 10. CShoutDlg (`Dialog/DlgSpeaker_main` `426x340` at `(187, 130)`) & CNoSpeakDlg (`340x226`) ─

/** Exact `CA.exe.c:373624..373634` (`dword_6239B0..6239E0`) loudspeaker icon paths (`31x31`). */
export const SPEAKER_COLOR_ICONS: readonly string[] = [
  "Item/ItemSpeaker",
  "Item/ItemSpeaker_orange",
  "Item/ItemSpeaker_pink",
  "Item/ItemSpeaker_green",
  "Item/ItemSpeaker_violet",
];

export class ShoutDlg implements ModalDialog {
  readonly id = "shout";
  closed = false;
  private readonly dx = 187;
  private readonly dy = 130;
  private bg: LoadedSheet | null = null;
  private readonly speakerIcons: (LoadedSheet | null)[] = [null, null, null, null, null];
  private selectedColorIdx = 0;
  private readonly edText: WebGpuEditBox;
  private readonly radios: SpriteCheckBox[] = [];
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;

  constructor(assets: GameAssets, hub: ClientHub) {
    // Exact `CA.exe` `L43764..43825`: edit `(56, 169, 303, 33)`, 5 radios `(56 + 66*i, 230)`, Ok `(117, 278)`, Cancel `(225, 278)`
    this.edText = new WebGpuEditBox({
      x: this.dx + 56,
      y: this.dy + 169,
      w: 303,
      h: 33,
      maxLength: 50,
      onEnter: () => this.btOk.onClick?.(),
    });
    for (let i = 0; i < 5; i++) {
      const rc = new SpriteCheckBox(56 + i * 66, 230, i === 0, () => {
        this.selectedColorIdx = i;
        this.radios.forEach((r, j) => (r.checked = j === i));
      });
      this.radios.push(rc);
    }
    this.btOk = new SpriteButton(117, 278, () => {
      const t = this.edText.value.trim();
      if (t) hub.send({ type: "speaker_send", text: t, colorIdx: this.selectedColorIdx });
      this.closed = true;
      imeHost.blur();
    });
    this.btCancel = new SpriteButton(225, 278, () => {
      this.closed = true;
      imeHost.blur();
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgSpeaker_main"),
      assets.loadSheet("Fx", "Dialog/BtcircleCheckBox"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSNoticeOk"),
      assets.loadSheet("Fx", "Dialog/Bt_SMSNoticeCancel"),
      ...SPEAKER_COLOR_ICONS.map((p) => assets.loadSheet("Fx", p)),
    ]).then(([bg, rad, ok, ca, s0, s1, s2, s3, s4]) => {
      this.bg = bg;
      this.speakerIcons[0] = s0;
      this.speakerIcons[1] = s1;
      this.speakerIcons[2] = s2;
      this.speakerIcons[3] = s3;
      this.speakerIcons[4] = s4;
      for (const r of this.radios) r.bindSheet(rad);
      this.btOk.bindSheet(ok, 86, 25);
      this.btCancel.bindSheet(ca, 86, 25);
    });
    setTimeout(() => this.edText.focus(), 20);
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btOk.onMouseMove(lx, ly, sound);
    this.btCancel.onMouseMove(lx, ly, sound);
    for (const r of this.radios) r.onMouseMove(lx, ly);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edText.handleMouseDown(mx, my)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const r of this.radios) {
      if (r.onMouseDown(lx, ly)) return true;
    }
    if (this.btOk.onMouseDown(lx, ly) || this.btCancel.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const r of this.radios) {
      if (r.onMouseUp(lx, ly, sound)) return true;
    }
    if (this.btOk.onMouseUp(lx, ly, sound) || this.btCancel.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.edText.render(r, nowMs);
    for (let i = 0; i < 5; i++) {
      drawSheetFrame(r, this.speakerIcons[i] ?? null, 0, this.dx + 49 + i * 66, this.dy + 200);
    }
    for (const rc of this.radios) rc.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

/**
 * Retail `CNoSpeakDlg` (`CA.exe.c:38655..38735`):
 *   - `kind === "speaker"` -> `Fx:Dialog/DlgSpeaker_003` (`340x226`)
 *   - `kind === "color_pencil"` -> `Fx:Dialog/DlgColorPencil`
 *   - `Fx:Dialog/BtSpeaker_Shop` (`86x25`) at `(75, 167)`
 *   - `Fx:Dialog/BtSpeaker_Cancel` (`86x25`) at `(175, 167)`
 */
export class NoSpeakDlg implements ModalDialog {
  readonly id = "no_speak";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 187;
  private bg: LoadedSheet | null = null;
  private readonly btShop: SpriteButton;
  private readonly btCancel: SpriteButton;

  constructor(
    assets: GameAssets,
    kind: "speaker" | "color_pencil",
    onGoShop: () => void,
  ) {
    this.btShop = new SpriteButton(75, 167, () => {
      this.closed = true;
      onGoShop();
    });
    this.btCancel = new SpriteButton(175, 167, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", kind === "color_pencil" ? "Dialog/DlgColorPencil" : "Dialog/DlgSpeaker_003"),
      assets.loadSheet("Fx", "Dialog/BtSpeaker_Shop"),
      assets.loadSheet("Fx", "Dialog/BtSpeaker_Cancel"),
    ]).then(([bg, sh, ca]) => {
      this.bg = bg;
      this.btShop.bindSheet(sh, 86, 25);
      this.btCancel.bindSheet(ca, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btShop.onMouseMove(lx, ly, sound);
    this.btCancel.onMouseMove(lx, ly, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btShop.onMouseDown(lx, ly) || this.btCancel.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btShop.onMouseUp(lx, ly, sound) || this.btCancel.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btShop.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 11. CGameOptionDlg (`Dialog/DlgOPTION` `382x421` at `(209, 89)`) ────────

export class OptionDlg implements ModalDialog {
  readonly id = "option";
  closed = false;
  private readonly dx = 209;
  private readonly dy = 89;
  private bg: LoadedSheet | null = null;
  private readonly bgmBar: SpriteHSlider;
  private readonly sfxBar: SpriteHSlider;
  private readonly btMacro: SpriteButton;
  private readonly btRefusal: SpriteButton;
  private readonly checks: SpriteCheckBox[] = [];
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly origBgm: number;
  private readonly origSfx: number;
  private readonly origRefuseAll: boolean;
  private readonly sound: SoundManager;
  private readonly hub?: ClientHub;

  constructor(
    assets: GameAssets,
    sound: SoundManager,
    hub?: ClientHub,
    pushDialog?: (dlg: ModalDialog) => void,
  ) {
    this.sound = sound;
    this.hub = hub;
    this.origBgm = Math.round(sound.bgmVolume * 100);
    this.origSfx = Math.round(sound.sfxVolume * 100);
    this.origRefuseAll = Boolean(hub?.refuseAllWhispers);

    // Exact `CA.exe` `L35790..35985`:
    //   MP3 CCtrlBar `(125, 118, 220, 17)`, WAV CCtrlBar `(125, 145, 220, 17)`
    //   Bt_MacroSetUp `(129, 178)`, Bt_RefusalList `(129, 203)`
    //   BtCheckBox grid `(237, 207)` & `(133 | 237, 231, 254, 277, 300, 323)`
    //   Bt_Ok `(87, 353)`, Bt_Cancel `(197, 353)`
    this.bgmBar = new SpriteHSlider(125, 118, 220, 17, this.origBgm, (v) => {
      sound.setBgmVolume(v / 100);
    });
    this.sfxBar = new SpriteHSlider(125, 145, 220, 17, this.origSfx, (v) => {
      sound.setSfxVolume(v / 100);
    });

    this.btMacro = new SpriteButton(129, 178, () => {
      if (hub && pushDialog) pushDialog(new MacroEditDlg(assets, hub));
    });
    this.btRefusal = new SpriteButton(129, 203, () => {
      if (hub && pushDialog) pushDialog(new RefusalListDlg(assets, hub));
    });

    const chkPositions: [number, number, boolean][] = [
      [237, 207, this.origRefuseAll],
      [133, 231, Boolean(hub?.showDangerZone)],
      [237, 231, !hub?.showDangerZone],
      [133, 254, true],
      [237, 254, false],
      [133, 277, true],
      [237, 277, false],
      [133, 300, true],
      [237, 300, false],
      [133, 323, true],
      [237, 323, false],
    ];
    for (const [cx, cy, def] of chkPositions) {
      this.checks.push(new SpriteCheckBox(cx, cy, def));
    }

    this.btOk = new SpriteButton(87, 353, () => {
      if (this.hub) {
        this.hub.refuseAllWhispers = Boolean(this.checks[0]?.checked);
        this.hub.showDangerZone = Boolean(this.checks[1]?.checked);
      }
      this.closed = true;
    });
    this.btCancel = new SpriteButton(197, 353, () => {
      this.sound.setBgmVolume(this.origBgm / 100);
      this.sound.setSfxVolume(this.origSfx / 100);
      if (this.hub) {
        this.hub.refuseAllWhispers = this.origRefuseAll;
      }
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgOPTION"),
      assets.loadSheet("Fx", "Dialog/Bt_MacroSetUp"),
      assets.loadSheet("Fx", "Dialog/Bt_RefusalList"),
      assets.loadSheet("Fx", "Dialog/BtCheckBox"),
      assets.loadSheet("Fx", "Dialog/Bt_Ok"),
      assets.loadSheet("Fx", "Dialog/Bt_Cancel"),
      this.bgmBar.loadOptionBall(assets),
      this.sfxBar.loadOptionBall(assets),
    ]).then(([bg, ma, rf, chk, ok, ca]) => {
      this.bg = bg;
      this.btMacro.bindSheet(ma, 100, 23);
      this.btRefusal.bindSheet(rf, 100, 23);
      for (const c of this.checks) c.bindSheet(chk);
      this.btOk.bindSheet(ok, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.bgmBar.onMouseMove(lx, ly);
    this.sfxBar.onMouseMove(lx, ly);
    for (const b of [this.btMacro, this.btRefusal, this.btOk, this.btCancel]) b.onMouseMove(lx, ly, sound);
    for (const c of this.checks) c.onMouseMove(lx, ly);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.bgmBar.onMouseDown(lx, ly) || this.sfxBar.onMouseDown(lx, ly)) return true;
    for (const b of [this.btMacro, this.btRefusal, this.btOk, this.btCancel]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    for (const c of this.checks) {
      if (c.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.bgmBar.onMouseUp() || this.sfxBar.onMouseUp()) {
      sound.playSfx("ButtonDown_0", 0.6);
      return true;
    }
    for (const b of [this.btMacro, this.btRefusal, this.btOk, this.btCancel]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    for (const c of this.checks) {
      if (c.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.bgmBar.render(r, this.dx, this.dy);
    this.sfxBar.render(r, this.dx, this.dy);
    this.btMacro.render(r, this.dx, this.dy);
    this.btRefusal.render(r, this.dx, this.dy);
    for (const c of this.checks) c.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 12. CHelpDialog (`Dialog/DlgHelp` `340x393` at `(230, 103)`) ────────────

export class HelpDlg implements ModalDialog {
  readonly id = "help";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 103;
  private bg: LoadedSheet | null = null;
  private readonly scroll: SpriteScrollBar;
  private readonly msgView: SpriteMsgView;
  private readonly btClose: SpriteButton;
  private helpRaw = "";
  private synced = false;

  constructor(assets: GameAssets) {
    // Exact `CA.exe` `L37570..37610`: MsgView `(51, 94, 222, 222)`, VScroll `(281, 84, 18, 243)`, `Dialog/BtClose` `(121, 332)`
    this.scroll = new SpriteScrollBar(281, 84, 18, 243);
    this.msgView = new SpriteMsgView(51, 94, 222, 222, this.scroll);
    this.btClose = new SpriteButton(121, 332, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgHelp"),
      assets.loadSheet("Fx", "Dialog/BtClose"),
      assets.fx.getPayload("Help/Help"),
      this.scroll.load(assets),
    ]).then(([bg, cl, raw]) => {
      this.bg = bg;
      this.btClose.bindSheet(cl, 100, 32);
      if (raw) {
        this.helpRaw = decodeBig5(raw);
        this.synced = false;
      }
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btClose.onMouseMove(lx, ly, sound);
    this.scroll.onMouseMove(lx, ly);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btClose.onMouseDown(lx, ly)) return true;
    if (this.scroll.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btClose.onMouseUp(lx, ly, sound)) return true;
    if (this.scroll.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 2 : -2);
    return true;
  }

  render(r: SpriteRenderer): void {
    if (!this.synced && this.helpRaw) {
      this.synced = true;
      this.msgView.setStaticText(r, this.helpRaw, [0.06, 0.14, 0.28, 1]);
    }
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.msgView.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 13. CRoomInfoDlg (`Dialog/DlgRoomInfo` `295x395` at `(252, 102)`) ───────

export class RoomInfoDlg implements ModalDialog {
  readonly id = "room_info";
  closed = false;
  private readonly dx = 252;
  private readonly dy: number;
  private readonly is12Slot: boolean;
  private bg: LoadedSheet | null = null;
  private roomInfoImg: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private hoverRow = -1;
  private readonly btClose: SpriteButton;
  private readonly assets: GameAssets;
  private readonly room: RoomSummary;
  private readonly hub?: ClientHub;
  private readonly dialogs?: DialogStack;
  private readonly openedWallMs = Date.now();

  constructor(assets: GameAssets, room: RoomSummary, hub?: ClientHub, dialogs?: DialogStack) {
    this.assets = assets;
    this.room = room;
    this.hub = hub;
    this.dialogs = dialogs;
    // Exact `CRoomDetailInfoDialog` (`CA.exe.c:45664..45893`):
    //   8-slot (`Dialog/DlgRoomInfo` `295x395` at `(252, 102)`, `BtClose (98, 334)`)
    //  12-slot (`Dialog/DlgRoomInfo12` `295x491` at `(252, 54)`, `BtClose (98, 430)`)
    this.is12Slot = room.kind === "chat" || room.capacity > 8;
    this.dy = this.is12Slot ? 54 : 102;
    this.btClose = new SpriteButton(98, this.is12Slot ? 430 : 334, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", this.is12Slot ? "Dialog/DlgRoomInfo12" : "Dialog/DlgRoomInfo"),
      assets.loadSheet("Fx", "Dialog/RoomInfoImg"),
      assets.loadSheet("Fx", "Dialog/BtClose"),
      assets.loadSheet("Cx", "Etc/LevelIcons"),
    ]).then(([bg, ri, cl, lv]) => {
      this.bg = bg;
      this.roomInfoImg = ri;
      this.btClose.bindSheet(cl, 100, 32);
      this.levelSheet = lv;
    });
  }

  private resolvedOccupants() {
    if (this.room.occupants && this.room.occupants.length > 0) {
      return this.room.occupants;
    }
    const lobbyHost = this.hub?.lobbyUsers.find(
      (u) => u.nickname === this.room.hostName || u.username === this.room.hostName,
    );
    const maxN = Math.min(this.is12Slot ? 12 : 8, this.room.players);
    return Array.from({ length: maxN }, (_, i) => ({
      slot: i,
      username: i === 0 ? (lobbyHost?.username ?? this.room.hostName) : "",
      nickname: i === 0 ? this.room.hostName : `玩家 ${i + 1}`,
      level: i === 0 ? (lobbyHost?.level ?? 1) : 1,
      isHost: i === 0,
      ready: i > 0,
      isAi: false,
    }));
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btClose.onMouseMove(lx, ly, sound);
    const occ = this.resolvedOccupants();
    this.hoverRow = -1;
    // Exact `CA.exe.c:45705`: clickable nickname hit rect `(87..180, 122..122 + 24*N)`
    if (lx >= 87 && lx <= 180 && ly >= 122) {
      const idx = Math.floor((ly - 122) / 24);
      if (idx >= 0 && idx < occ.length && occ[idx]?.username) {
        this.hoverRow = idx;
      }
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btClose.onMouseDown(lx, ly)) return true;
    const occ = this.resolvedOccupants();
    if (lx >= 87 && lx <= 180 && ly >= 122 && this.hub && this.dialogs) {
      const idx = Math.floor((ly - 122) / 24);
      const target = occ[idx];
      if (target && target.username && !target.isAi) {
        sound.playSfx("ButtonDown_0", 0.55);
        this.dialogs.push(new UserInfoDlg(this.assets, this.hub, target.username));
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btClose.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const rm = this.room;

    // Exact `CRoomDetailInfoDialog` elapsed `MM:SS` (`RoomInfoImg` `b=6, s=14, d=2`) at `(dx+185, dy+62)` & `(dx+217, dy+62)`
    const refEpoch = rm.playing && rm.startedAtMs ? rm.startedAtMs : (rm.createdAtMs || this.openedWallMs);
    const elapsedSec = Math.max(0, Math.floor((Date.now() - refEpoch) / 1000));
    const mm = Math.min(99, Math.floor(elapsedSec / 60));
    const ss = elapsedSec % 60;
    if (this.roomInfoImg) {
      drawSpriteDigits(r, this.roomInfoImg, this.dx + 185, this.dy + 62, 14, 2, mm, 6);
      drawSpriteDigits(r, this.roomInfoImg, this.dx + 217, this.dy + 62, 14, 2, ss, 6);
    }

    r.drawText(`${rm.mapName}`, this.dx + 88, this.dy + 65, {
      color: [0.06, 0.14, 0.28, 1],
      maxWidth: 92,
    });
    r.drawText(`#${String(rm.id).padStart(3, "0")} ${rm.title}`, this.dx + 88, this.dy + 94, {
      color: [0.06, 0.14, 0.28, 1],
      maxWidth: 168,
    });

    // Exact `CA.exe.c:45848..45875` rows `y = 129 + 24 * i`:
    //   `RoomInfoImg[isHost ? 1 : 0]` at `(47, y+3)`, `lvl (67, y+4)`, `nick (87, y+5)`,
    //   `RoomInfoImg[playing ? 2 : isHost ? 3 : ready ? 4 : 5]` at `(210, y)`
    const occ = this.resolvedOccupants();
    const maxRows = this.is12Slot ? 12 : 8;
    for (let i = 0; i < Math.min(maxRows, occ.length); i++) {
      const row = occ[i]!;
      const y = 129 + i * 24;
      if (this.roomInfoImg) {
        drawSheetFrame(r, this.roomInfoImg, row.isHost ? 1 : 0, this.dx + 47, this.dy + y + 3);
      }
      drawLevelIcon(r, this.levelSheet, row.level, this.dx + 67, this.dy + y + 4);
      r.drawText(row.nickname, this.dx + 87, this.dy + y + 5, {
        color: this.hoverRow === i ? [0.85, 0.22, 0.08, 1] : [0.08, 0.16, 0.30, 1],
        maxWidth: 118,
      });
      if (this.roomInfoImg) {
        const stFrame = rm.playing ? 2 : row.isHost ? 3 : row.ready ? 4 : 5;
        const safeFrame = Math.min((this.roomInfoImg.sheet?.rects.length ?? 6) - 1, stFrame);
        drawSheetFrame(r, this.roomInfoImg, safeFrame, this.dx + 210, this.dy + y);
      }
    }

    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 14. Exchange Popups (`PU-Lucci_enter`, `PU-Exchange`, `DlgChangeSucc`) ──

export class LucciEnterDlg implements ModalDialog {
  readonly id = "lucci_enter";
  closed = false;
  private readonly dx = 222;
  private readonly dy = 211;
  private bg: LoadedSheet | null = null;
  private readonly edLucci: WebGpuEditBox;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;

  constructor(assets: GameAssets, initialLucci: number, maxLucci: number, onSubmit: (val: number) => void) {
    // Exact `PU-Lucci_enter` (`355x178`) edit well `(dx+155, dy+78, 147, 17)`
    this.edLucci = new WebGpuEditBox({
      x: this.dx + 155,
      y: this.dy + 78,
      w: 147,
      h: 17,
      maxLength: 9,
      numericOnly: true,
      onEnter: () => this.btOk.onClick?.(),
    });
    this.edLucci.value = String(initialLucci);

    this.btOk = new SpriteButton(90, 114, () => {
      const v = Math.max(0, Math.min(maxLucci, Number(this.edLucci.value || "0") || 0));
      this.closed = true;
      imeHost.blur();
      onSubmit(v);
    });
    this.btCancel = new SpriteButton(184, 114, () => {
      this.closed = true;
      imeHost.blur();
    });

    void Promise.all([
      assets.loadSheet("Fx", "Exchange/PU-Lucci_enter"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Ok"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Cancel"),
    ]).then(([bg, ok, ca]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 86, 25);
      this.btCancel.bindSheet(ca, 86, 25);
    });
    setTimeout(() => this.edLucci.focus(), 20);
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edLucci.handleMouseDown(mx, my)) return true;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.edLucci.render(r, nowMs);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

export class ExchangeConfirmDlg implements ModalDialog {
  readonly id = "exchange_confirm";
  closed = false;
  private readonly dx = 214;
  private readonly dy = 181;
  private bg: LoadedSheet | null = null;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly createdMs = performance.now();

  constructor(assets: GameAssets, onConfirm: () => void) {
    // Exact `PU-Exchange` (`371x238`) with retail 3-second anti-scam safety lock on `Bt_popup-Ok (97, 171)`
    this.btOk = new SpriteButton(97, 171, () => {
      if (performance.now() - this.createdMs < 3000) return;
      this.closed = true;
      onConfirm();
    });
    this.btOk.enabled = false;
    this.btCancel = new SpriteButton(191, 171, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Exchange/PU-Exchange"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Ok"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Cancel"),
    ]).then(([bg, ok, ca]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 86, 25);
      this.btCancel.bindSheet(ca, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.enabled = performance.now() - this.createdMs >= 3000;
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    this.btOk.enabled = performance.now() - this.createdMs >= 3000;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    this.btOk.enabled = performance.now() - this.createdMs >= 3000;
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    this.btOk.enabled = nowMs - this.createdMs >= 3000;
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

export class ExchangeSuccessDlg implements ModalDialog {
  readonly id = "exchange_succ";
  closed = false;
  private readonly dx = 217;
  private readonly dy = 90;
  private bg: LoadedSheet | null = null;
  private shopImg: LoadedSheet | null = null;
  private readonly btOk: SpriteButton;
  private readonly assets: GameAssets;
  private readonly receivedStockIds: number[];
  private readonly receivedLucci: number;
  private readonly cache: CharacterPreviewCache;

  constructor(
    assets: GameAssets,
    receivedStockIds: number[] = [],
    receivedLucci = 0,
    cache?: CharacterPreviewCache,
  ) {
    this.assets = assets;
    this.receivedStockIds = receivedStockIds;
    this.receivedLucci = receivedLucci;
    this.cache = cache ?? new CharacterPreviewCache();
    // Exact `DlgChangeSucc` (`366x420` at `(217, 90)`): `Shop/BtPopup_Close (154, 348)` (`CA.exe.c:38008`)
    this.btOk = new SpriteButton(154, 348, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Exchange/DlgChangeSucc"),
      assets.loadSheet("Fx", "Shop/BtPopup_Close"),
      assets.loadSheet("Fx", "Shop/ShopImg"),
    ]).then(([bg, ok, si]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 58, 20);
      this.shopImg = si;
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    // Exact `DlgChangeSucc` 4x3 received item grid `(dx+61, dy+134, 62x56)` + Lucci `ShopImg (dx+158, dy+310, s=10, d=12, b=36)`
    for (let i = 0; i < Math.min(12, this.receivedStockIds.length); i++) {
      const stockId = this.receivedStockIds[i]!;
      const st = this.assets.tables?.stockById.get(stockId);
      const gx = this.dx + 61 + (i % 4) * 62;
      const gy = this.dy + 134 + Math.floor(i / 4) * 56;
      this.cache.drawStockIcon(r, this.assets, st, gx + 28, gy + 25, 48, 42);
    }
    if (this.shopImg) {
      drawSpriteNumber(r, this.shopImg, this.dx + 158, this.dy + 310, 10, 12, this.receivedLucci, true, 36);
    } else {
      r.drawText(`${this.receivedLucci.toLocaleString()}`, this.dx + 278, this.dy + 311, {
        align: "right",
        color: [0.06, 0.14, 0.28, 1],
      });
    }
    this.btOk.render(r, this.dx, this.dy);
  }
}

export class QuantityEnterDlg implements ModalDialog {
  readonly id = "quantity_enter";
  closed = false;
  private readonly dx = 222;
  private readonly dy = 211;
  private bg: LoadedSheet | null = null;
  private readonly edQty: WebGpuEditBox;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;

  constructor(assets: GameAssets, initialQty: number, maxQty: number, onSubmit: (qty: number) => void) {
    // Exact `CQuantityEnterDlg` (`Exchange/PU-quantity_enter`, `355x178`, `CA.exe.c:55950..56025`):
    //   Edit `(155, 78, 147, 17)`, `Bt_popup-Ok (90, 114)`, `Bt_popup-Cancel (184, 114)`
    this.edQty = new WebGpuEditBox({
      x: this.dx + 155,
      y: this.dy + 78,
      w: 147,
      h: 17,
      maxLength: 9,
      numericOnly: true,
      onEnter: () => this.btOk.onClick?.(),
    });
    this.edQty.value = String(Math.max(1, Math.min(maxQty, initialQty)));

    this.btOk = new SpriteButton(90, 114, () => {
      const v = Math.max(0, Math.min(maxQty, Number(this.edQty.value || "0") || 0));
      this.closed = true;
      imeHost.blur();
      if (v > 0) onSubmit(v);
    });
    this.btCancel = new SpriteButton(184, 114, () => {
      this.closed = true;
      imeHost.blur();
    });

    void Promise.all([
      assets.loadSheet("Fx", "Exchange/PU-quantity_enter"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Ok"),
      assets.loadSheet("Fx", "Exchange/Bt_popup-Cancel"),
    ]).then(([bg, ok, ca]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 86, 25);
      this.btCancel.bindSheet(ca, 86, 25);
    });
    setTimeout(() => this.edQty.focus(), 20);
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.edQty.handleMouseDown(mx, my)) return true;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.edQty.render(r, nowMs);
    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 18. CExchangeCouponDlg (`Dialog/QuestionMark_DlgCouponChoice`, `458x458`) ─

interface ReelPrize {
  stockId: number; // 0 = 3,000 LUCCI CoinPocketGold Jackpot
  name: string;
}

export class QuestionMarkRouletteDlg implements ModalDialog {
  readonly id = "question_roulette";
  closed = false;
  private readonly dx = 171;
  private readonly dy = 71;

  private bg: LoadedSheet | null = null;
  private backLight: LoadedSheet | null = null;
  private itemLight: LoadedSheet | null = null;
  private choiceFrame: LoadedSheet | null = null;
  private itemBack: LoadedSheet | null = null;
  private iconCoupon: LoadedSheet | null = null;
  private coinJackpot: LoadedSheet | null = null;
  private btStartSheet: LoadedSheet | null = null;
  private btStopSheet: LoadedSheet | null = null;

  private readonly btAction: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly cache = new CharacterPreviewCache();
  private readonly reel: ReelPrize[] = [];
  private reelIdx = 0;
  private scrollPx = 0;
  private speedPx = 0;
  private stopStepsLeft = 0;
  private phase: "idle" | "spinning" | "stopping" | "won" = "idle";
  private statusText = "";
  private lastStepMs = 0;
  private lastDrumMs = 0;
  private unsub: (() => void) | null = null;

  private readonly assets: GameAssets;
  private readonly hub: ClientHub;
  private readonly sound: SoundManager;

  constructor(assets: GameAssets, hub: ClientHub, sound: SoundManager) {
    this.assets = assets;
    this.hub = hub;
    this.sound = sound;

    // Build 18-slot prize reel from authentic retail `StockItem`s + `Item/CoinPocketGold` Jackpot!
    const allStocks = (assets.tables?.fxStock ?? []).filter(
      (s) => [1, 3, 4, 5, 10, 12, 18, 19].includes(s.category) && s.iconPath.length > 0,
    );
    for (let i = 0; i < 18; i++) {
      if (i % 6 === 2 || allStocks.length === 0) {
        this.reel.push({ stockId: 0, name: "黃金錢袋 3,000 LUCCI" });
      } else {
        const pick = allStocks[(i * 7 + 3) % allStocks.length]!;
        this.reel.push({ stockId: pick.id, name: pick.name || `道具 #${pick.id}` });
      }
    }

    this.statusText =
      hub.pendingQuestionMarks > 0
        ? `持有免費問號樂爆卡 x${hub.pendingQuestionMarks}！點擊 START 開始抽獎`
        : "每次抽獎 500 LUCCI（對戰拾獲「?」問號道具可免費抽獎）";

    // Exact `CA.exe.c:225670`: `QuestionMark_Bt_StartAni` / `Bt_StopAni` at `(131, 304)`
    this.btAction = new SpriteButton(131, 304, () => this.onActionClick());
    this.btClose = new SpriteButton(420, 12, () => {
      this.cleanup();
      this.closed = true;
    });

    this.unsub = hub.onMessage((msg) => {
      if (msg.type === "gachapon_res") {
        this.statusText = msg.message;
      }
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/QuestionMark_DlgCouponChoice"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_BackLight"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_ItemLight"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_Choice"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_ItemBack"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_IconCoupon"),
      assets.loadSheet("Fx", "Item/CoinPocketGold"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_Bt_StartAni"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_Bt_StopAni"),
      assets.loadSheet("Fx", "Dialog/Bt_Close"),
    ]).then(([bg, bl, il, ch, ib, ic, cj, bStart, bStop, bClose]) => {
      this.bg = bg;
      this.backLight = bl;
      this.itemLight = il;
      this.choiceFrame = ch;
      this.itemBack = ib;
      this.iconCoupon = ic;
      this.coinJackpot = cj;
      this.btStartSheet = bStart;
      this.btStopSheet = bStop;
      this.btAction.bindSheet(bStart, 196, 109);
      this.btClose.bindSheet(bClose, 24, 24);
    });
  }

  private cleanup(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  private onActionClick(): void {
    if (this.phase === "idle" || this.phase === "won") {
      if (
        this.hub.connected &&
        this.hub.pendingQuestionMarks <= 0 &&
        (this.hub.profile?.lucci ?? 0) < 500
      ) {
        this.statusText = "LUCCI 不足 500，請先對戰賺取 LUCCI 或拾獲問號樂爆卡！";
        return;
      }
      this.phase = "spinning";
      this.speedPx = 22;
      this.statusText = "轉盤高速旋轉中…點擊 STOP 鎖定大獎！";
      if (this.btStopSheet) this.btAction.bindSheet(this.btStopSheet, 196, 109);
      this.sound.playSfx("real_timpani_roll");
    } else if (this.phase === "spinning") {
      this.phase = "stopping";
      this.stopStepsLeft = 7;
      this.statusText = "正在停下轉盤…";
    }
  }

  private stepReel(nowMs: number): void {
    if (this.lastStepMs === 0) this.lastStepMs = nowMs;
    const dt = Math.min(60, nowMs - this.lastStepMs);
    if (dt < 16) return;
    this.lastStepMs = nowMs;

    if (this.phase !== "spinning" && this.phase !== "stopping") return;

    if (nowMs - this.lastDrumMs > 320 && this.phase === "spinning") {
      this.lastDrumMs = nowMs;
      this.sound.playSfx("MouseMove_0", 0.55);
    }

    this.scrollPx += this.speedPx * (dt / 30);
    while (this.scrollPx >= 64) {
      this.scrollPx -= 64;
      this.reelIdx = (this.reelIdx + 1) % this.reel.length;
      if (this.phase === "stopping") {
        this.stopStepsLeft--;
        this.speedPx = Math.max(4, this.speedPx - 2.6);
        if (this.stopStepsLeft <= 0) {
          this.scrollPx = 0;
          this.speedPx = 0;
          this.phase = "won";
          if (this.btStartSheet) this.btAction.bindSheet(this.btStartSheet, 196, 109);
          this.sound.playSfx("brass");
          const won = this.reel[(this.reelIdx + 2) % this.reel.length]!;
          if (this.hub.connected) {
            this.hub.send({ type: "gachapon_spin", preferredStockId: won.stockId });
          } else {
            if (this.hub.pendingQuestionMarks > 0) this.hub.pendingQuestionMarks--;
            this.statusText = `恭喜抽中「${won.name}」！`;
          }
          break;
        }
      }
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btAction.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btClose.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btClose.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btAction.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btClose.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btAction.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.cleanup();
      this.closed = true;
      return true;
    }
    if (e.key === " " || e.key === "Enter") {
      this.onActionClick();
      return true;
    }
    return true;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    this.stepReel(nowMs);
    const tick = Math.floor(nowMs / 33);

    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);

    // `CA.exe.c:225003` celebration sunburst `QuestionMark_BackLight` at `(21, 24)` when won!
    if (this.phase === "won") {
      drawSheetFrame(r, this.backLight, Math.floor(tick / 5) % 2, this.dx + 21, this.dy + 24);
    }

    // `CA.exe.c:225390` clipped 6-card horizontal prize reel at `(dx + 67, dy + 244, 323, 77)`
    r.pushClip(this.dx + 67, this.dy + 244, 323, 77);
    for (let i = 0; i < 6; i++) {
      const cardX = Math.round(this.dx + 67 + i * 64 - this.scrollPx);
      const cardY = this.dy + 245;
      const prize = this.reel[(this.reelIdx + i) % this.reel.length]!;
      const backFrame =
        this.phase === "won" && i === 2 ? (Math.floor(tick / 5) % 2) + 1 : 0;
      drawSheetFrame(r, this.itemBack, backFrame, cardX, cardY);
      if (prize.stockId === 0) {
        drawSheetFrame(r, this.coinJackpot, 0, cardX + 15, cardY + 18);
      } else {
        const stock = this.assets.tables?.stockById.get(prize.stockId);
        this.cache.drawStockIcon(r, this.assets, stock, cardX + 31, cardY + 34, 46, 44);
      }
    }
    r.popClip();

    // `CA.exe.c:224995` marquee lights `QuestionMark_ItemLight` at `(27, 214)` while active
    if (this.phase !== "idle") {
      drawSheetFrame(r, this.itemLight, Math.floor(tick / 5) % 2, this.dx + 27, this.dy + 214);
    }

    // `CA.exe.c:225010` center spotlight `QuestionMark_Choice` at `(192, 204)`
    const choiceIdx = this.phase === "won" ? Math.floor(tick / 2) % 8 : 0;
    drawSheetFrame(r, this.choiceFrame, choiceIdx, this.dx + 192, this.dy + 204);

    if (this.phase === "won") {
      drawSheetFrame(r, this.iconCoupon, 0, this.dx + 211, this.dy + 289);
    }

    this.btAction.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);

    if (this.statusText) {
      r.drawText(this.statusText, this.dx + 229, this.dy + 426, {
        align: "center",
        color: this.phase === "won" ? [1, 0.94, 0.42, 1] : [0.95, 0.98, 1, 1],
        outlineColor: [0.05, 0.12, 0.28, 0.95],
      });
    }
  }
}

export class SpeakerPopupOverlay {
  private icon: LoadedSheet | null = null;
  private readonly colorIcons: (LoadedSheet | null)[] = [null, null, null, null, null];
  private from = "";
  private text = "";
  private colorIdx = 0;
  private untilMs = 0;

  async load(assets: GameAssets): Promise<void> {
    const [base, s0, s1, s2, s3, s4] = await Promise.all([
      assets.loadSheet("Fx", "Dialog/SpeakerIcon"),
      ...SPEAKER_COLOR_ICONS.map((p) => assets.loadSheet("Fx", p)),
    ]);
    this.icon = base;
    this.colorIcons[0] = s0;
    this.colorIcons[1] = s1;
    this.colorIcons[2] = s2;
    this.colorIcons[3] = s3;
    this.colorIcons[4] = s4;
  }

  trigger(from: string, text: string, colorIdx = 0): void {
    this.from = from;
    this.text = text;
    this.colorIdx = Math.max(0, Math.min(4, colorIdx));
    this.untilMs = performance.now() + 6500;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    if (nowMs >= this.untilMs || !this.icon) return;
    const spIcon = this.colorIdx > 0 ? this.colorIcons[this.colorIdx] ?? this.icon : this.icon;
    drawSheetFrame(r, spIcon, 0, this.colorIdx > 0 ? 242 : 260, this.colorIdx > 0 ? 4 : 12);
    const palette: readonly [number, number, number, number][] = [
      [1, 0.96, 0.56, 1],
      [1, 0.68, 0.28, 1],
      [1, 0.62, 0.84, 1],
      [0.56, 1, 0.64, 1],
      [0.82, 0.66, 1, 1],
    ];
    r.drawText(`[${this.from}] ${this.text}`, 276, 13, {
      color: palette[this.colorIdx] ?? palette[0]!,
      outlineColor: [0.06, 0.14, 0.34, 0.95],
    });
  }
}

// ─── 16. CMacroEditDlg (`Dialog/DlgMacro` `310x382` at `(245, 109)`, `CA.exe.c:37885..38010`) ──

export class MacroEditDlg implements ModalDialog {
  readonly id = "macro_edit";
  closed = false;
  private readonly dx = 245;
  private readonly dy = 109;
  private bg: LoadedSheet | null = null;
  private readonly edits: { digit: number; box: WebGpuEditBox }[] = [];
  private readonly btOk: SpriteButton;
  private readonly hub: ClientHub;

  constructor(assets: GameAssets, hub: ClientHub) {
    this.hub = hub;
    // Exact `CA.exe.c:37945..37995`:
    //   Rows 0..8 -> `Alt+1..Alt+9` (`digit = 1..9`) at `(101, 67 + 24*i, 180, 12)`
    //   Row 9     -> `Alt+0`        (`digit = 0`)    at `(101, 283, 180, 12)`
    //   `Dialog/BtNewUserOk` (`100x32`) at `(104, 314)`
    for (let row = 0; row < 10; row++) {
      const digit = row < 9 ? row + 1 : 0;
      const y = 67 + row * 24;
      const nextRow = (row + 1) % 10;
      const box = new WebGpuEditBox({
        x: this.dx + 101,
        y: this.dy + y - 1,
        w: 180,
        h: 14,
        maxLength: 80,
        textColor: [0.06, 0.14, 0.28, 1],
        bgColor: null,
        borderColor: null,
        onEnter: () => this.saveAndClose(),
        onTab: () => this.edits[nextRow]?.box.focus(),
      });
      box.value = hub.macros[digit] ?? "";
      this.edits.push({ digit, box });
    }

    this.btOk = new SpriteButton(104, 314, () => this.saveAndClose());

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgMacro"),
      assets.loadSheet("Fx", "Dialog/BtNewUserOk"),
    ]).then(([bg, ok]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 100, 32);
    });

    setTimeout(() => this.edits[0]?.box.focus(), 20);
  }

  private saveAndClose(): void {
    for (const { digit, box } of this.edits) {
      this.hub.setMacro(digit, box.value);
    }
    imeHost.blur();
    this.closed = true;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    for (const { box } of this.edits) {
      if (box.handleMouseDown(mx, my)) return true;
    }
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    for (const { box } of this.edits) {
      box.render(r, nowMs);
    }
    this.btOk.render(r, this.dx, this.dy);
  }
}

// ─── 17. CDenyWhisperListDlg (`Dialog/DlgRefusalList` `274x308` at `(263, 146)`, `CA.exe.c:35216`) ─

export class RefusalListDlg implements ModalDialog {
  readonly id = "refusal_list";
  closed = false;
  private readonly dx = 263;
  private readonly dy = 146;
  private bg: LoadedSheet | null = null;
  private msnIcon: LoadedSheet | null = null;
  private popupBack: LoadedSheet | null = null;
  private readonly btPopupDel: SpriteButton;
  private popupTarget = "";
  private popupX = 0;
  private popupY = 0;
  private readonly scroll: SpriteScrollBar;
  private readonly edName: WebGpuEditBox;
  private readonly btAdd: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly hub: ClientHub;
  private hoverRow = -1;

  constructor(assets: GameAssets, hub: ClientHub) {
    this.hub = hub;
    // Exact `CA.exe.c:35216..35430`:
    //   VScroll `(220, 66, 18, 143)`
    //   Edit `(48, 219, 100, 12)` (`maxLen=12`)
    //   `Dialog/Bt_add` (`70x23`) at `(149, 213)`
    //   `Dialog/Bt_CLOSE` (`100x32`) at `(89, 246)`
    //   `NM/MsnIcon_Another` per blocked user row (7 visible rows `68..204`, `rowH=19`)
    //   `CDenyWhisperPopupDlg`: `Dialog/Popup_Back` (`102x23`) + `Dialog/Popup_ListDelete` (`102x23`)
    this.scroll = new SpriteScrollBar(220, 66, 18, 143);
    this.edName = new WebGpuEditBox({
      x: this.dx + 48,
      y: this.dy + 218,
      w: 100,
      h: 14,
      maxLength: 12,
      placeholder: "輸入拒絕ID",
      textColor: [0.06, 0.14, 0.28, 1],
      bgColor: null,
      borderColor: null,
      onEnter: () => this.addEntry(),
    });
    this.btAdd = new SpriteButton(149, 213, () => this.addEntry());
    this.btPopupDel = new SpriteButton(0, 0, () => {
      if (this.popupTarget) {
        this.hub.removeRefusal(this.popupTarget);
        this.popupTarget = "";
        this.syncScroll();
      }
    });
    this.btClose = new SpriteButton(89, 246, () => {
      imeHost.blur();
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgRefusalList"),
      assets.loadSheet("Fx", "Dialog/Bt_add"),
      assets.loadSheet("Fx", "Dialog/Bt_CLOSE"),
      assets.loadSheet("Fx", "NM/MsnIcon_Another"),
      assets.loadSheet("Fx", "Dialog/Popup_Back"),
      assets.loadSheet("Fx", "Dialog/Popup_ListDelete"),
      this.scroll.load(assets),
    ]).then(([bg, add, cl, ic, pb, pd]) => {
      this.bg = bg;
      this.btAdd.bindSheet(add, 70, 23);
      this.btClose.bindSheet(cl, 100, 32);
      this.msnIcon = ic;
      this.popupBack = pb;
      this.btPopupDel.bindSheet(pd, 102, 23);
    });

    this.syncScroll();
    setTimeout(() => this.edName.focus(), 20);
  }

  private syncScroll(): void {
    this.scroll.setRange(Math.max(0, this.hub.refusalList.size - 7), false);
  }

  private addEntry(): void {
    const v = this.edName.value.trim();
    if (!v) return;
    if (this.hub.addRefusal(v)) {
      this.edName.value = "";
      this.syncScroll();
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    if (this.popupTarget) {
      this.btPopupDel.onMouseMove(mx - this.popupX, my - this.popupY, sound);
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btAdd.onMouseMove(lx, ly, sound);
    this.btClose.onMouseMove(lx, ly, sound);
    this.scroll.onMouseMove(lx, ly);
    if (lx >= 42 && lx <= 216 && ly >= 68 && ly < 201) {
      this.hoverRow = Math.floor((ly - 68) / 19);
    } else {
      this.hoverRow = -1;
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    if (this.popupTarget) {
      if (this.btPopupDel.onMouseDown(mx - this.popupX, my - this.popupY)) {
        return true;
      }
      this.popupTarget = "";
    }
    if (this.edName.handleMouseDown(mx, my)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btAdd.onMouseDown(lx, ly) || this.btClose.onMouseDown(lx, ly)) return true;
    if (this.scroll.onMouseDown(lx, ly)) return true;
    if (lx >= 42 && lx <= 216 && ly >= 68 && ly < 201) {
      const row = Math.floor((ly - 68) / 19);
      const items = [...this.hub.refusalList];
      const target = items[this.scroll.value + row];
      if (target) {
        // Open `CDenyWhisperPopupDlg` (`Dialog/Popup_Back` + `Dialog/Popup_ListDelete`, `CA.exe.c:35368`)
        this.popupTarget = target;
        this.popupX = Math.min(680, mx);
        this.popupY = Math.min(550, my);
        sound.playSfx("ButtonDown_0", 0.65);
      }
      return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.popupTarget) {
      if (this.btPopupDel.onMouseUp(mx - this.popupX, my - this.popupY, sound)) return true;
    }
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btAdd.onMouseUp(lx, ly, sound) || this.btClose.onMouseUp(lx, ly, sound)) return true;
    if (this.scroll.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 1 : -1);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const items = [...this.hub.refusalList];
    const start = this.scroll.value;
    for (let i = 0; i < 7; i++) {
      const name = items[start + i];
      if (!name) break;
      const ry = this.dy + 68 + i * 19;
      if (this.hoverRow === i) {
        r.fillRect(this.dx + 42, ry, 174, 18, [0.18, 0.42, 0.78, 0.22]);
      }
      drawSheetFrame(r, this.msnIcon, 0, this.dx + 45, ry + 2);
      r.drawText(name, this.dx + 64, ry + 3, {
        color: [0.08, 0.16, 0.30, 1],
      });
    }
    this.scroll.render(r, this.dx, this.dy);
    this.edName.render(r, nowMs);
    this.btAdd.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
    if (this.popupTarget) {
      drawSheetFrame(r, this.popupBack, 0, this.popupX, this.popupY);
      this.btPopupDel.render(r, this.popupX, this.popupY);
    }
  }
}

// ─── 18. CKeyMapDialog (`Dialog/DlgKeyMap` `400x330` at `(200, 135)`, `CA.exe.c:37687`) ────────

export class KeyMapDlg implements ModalDialog {
  readonly id = "keymap";
  closed = false;
  private readonly dx = 200;
  private readonly dy = 135;
  private bg: LoadedSheet | null = null;
  private readonly btClose: SpriteButton;

  constructor(assets: GameAssets) {
    // Exact `CA.exe.c:37718`: `Dialog/BtClose` (`100x32`) at `(150, 264)`
    this.btClose = new SpriteButton(150, 264, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgKeyMap"),
      assets.loadSheet("Fx", "Dialog/BtClose"),
    ]).then(([bg, cl]) => {
      this.bg = bg;
      this.btClose.bindSheet(cl, 100, 32);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btClose.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btClose.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btClose.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter" || e.key === "F2") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 19. DlgColorPencil (`Dialog/DlgColorPencil` `340x226` at `(230, 187)`, `CA.exe.c:38672`) ──

export class ColorPencilDlg implements ModalDialog {
  readonly id = "color_pencil";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 187;
  private bg: LoadedSheet | null = null;
  private readonly btShop: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly hub: ClientHub;
  private readonly ownedPencils: { invId: number; stockId: number; name: string }[] = [];

  constructor(assets: GameAssets, hub: ClientHub, onGoShop?: () => void) {
    this.hub = hub;
    for (const inv of hub.inventory) {
      const st = assets.tables?.stockById.get(inv.stockId);
      if (st && st.category === 15) {
        this.ownedPencils.push({ invId: inv.invId, stockId: st.id, name: st.name });
      }
    }

    // Exact `CA.exe.c:38672`: `BtSpeaker_Shop (75, 167)`, `BtSpeaker_Cancel (175, 167)`
    this.btShop = new SpriteButton(75, 167, () => {
      this.closed = true;
      onGoShop?.();
    });
    this.btCancel = new SpriteButton(175, 167, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgColorPencil"),
      assets.loadSheet("Fx", "Dialog/BtSpeaker_Shop"),
      assets.loadSheet("Fx", "Dialog/BtSpeaker_Cancel"),
    ]).then(([bg, sh, ca]) => {
      this.bg = bg;
      this.btShop.bindSheet(sh, 100, 32);
      this.btCancel.bindSheet(ca, 100, 32);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btShop.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btShop.onMouseDown(lx, ly) || this.btCancel.onMouseDown(lx, ly)) return true;
    for (let i = 0; i < Math.min(4, this.ownedPencils.length); i++) {
      const rx = 44 + (i % 2) * 128;
      const ry = 104 + Math.floor(i / 2) * 24;
      if (pointInRect(lx, ly, { x: rx, y: ry, w: 120, h: 20 })) {
        const p = this.ownedPencils[i]!;
        this.hub.send({ type: "item_equip", invId: p.invId, equip: true });
        sound.playSfx("ButtonDown_0", 0.7);
        this.closed = true;
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btShop.onMouseUp(lx, ly, sound) || this.btCancel.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    if (this.ownedPencils.length > 0) {
      for (let i = 0; i < Math.min(4, this.ownedPencils.length); i++) {
        const p = this.ownedPencils[i]!;
        const rx = this.dx + 44 + (i % 2) * 128;
        const ry = this.dy + 104 + Math.floor(i / 2) * 24;
        r.fillRect(rx, ry, 120, 19, [0.16, 0.36, 0.68, 0.22]);
        r.drawText(p.name.slice(0, 9), rx + 6, ry + 3, { color: [0.06, 0.14, 0.28, 1] });
      }
    }
    this.btShop.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 24. `CGetSaleCouponNoticeDlg` (`CA.exe.c:40133..40235`) ─────────────────
// Retail discount coupon confirmation dialog (`DialogCouponList/DlgCouponDC` `436x241`)
// with `DialogCouponList/Bt_CouponDCYes (121, 199)` and `Bt_CouponDCNo (231, 199)`.

export class CouponConfirmDlg implements ModalDialog {
  readonly id = "coupon_confirm";
  closed = false;
  private readonly dx = 182;
  private readonly dy = 179;
  private bg: LoadedSheet | null = null;
  private iconCoupon: LoadedSheet | null = null;
  private readonly btYes: SpriteButton;
  private readonly btNo: SpriteButton;
  private readonly cache = new CharacterPreviewCache();
  private readonly stock: StockItem | undefined;
  private readonly assets: GameAssets;
  private readonly coupon: CouponRow;

  constructor(
    assets: GameAssets,
    coupon: CouponRow,
    onConfirm: () => void,
  ) {
    this.assets = assets;
    this.coupon = coupon;
    this.stock = assets.tables?.stockById.get(coupon.stockId);
    this.btYes = new SpriteButton(121, 199, () => {
      onConfirm();
      this.closed = true;
    });
    this.btNo = new SpriteButton(231, 199, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "DialogCouponList/DlgCouponDC"),
      assets.loadSheet("Fx", "DialogCouponList/Bt_CouponDCYes"),
      assets.loadSheet("Fx", "DialogCouponList/Bt_CouponDCNo"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_IconCoupon"),
    ]).then(([bg, y, n, ic]) => {
      this.bg = bg;
      this.btYes.bindSheet(y, 86, 25);
      this.btNo.bindSheet(n, 86, 25);
      this.iconCoupon = ic;
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btYes.onMouseMove(lx, ly, sound);
    this.btNo.onMouseMove(lx, ly, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btYes.onMouseDown(lx, ly) || this.btNo.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btYes.onMouseUp(lx, ly, sound) || this.btNo.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter") {
      this.btYes.onClick?.();
      return true;
    }
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const name = this.stock?.name || `商品 #${this.coupon.stockId}`;
    const factor = Math.max(0, 100 - this.coupon.discountPct) / 100;
    const useLucci = Boolean(this.stock?.buyableLucci && (this.stock?.priceLucci ?? 0) > 0);
    const origPrice = useLucci ? (this.stock?.priceLucci ?? 0) : (this.stock?.priceCash ?? 0);
    const discPrice = Math.max(0, Math.round(origPrice * factor));
    const unit = useLucci ? "LUCCI" : "點數";

    if (this.stock) {
      this.cache.drawStockIcon(r, this.assets, this.stock, this.dx + 88, this.dy + 115, 56, 52);
    } else {
      drawSheetFrame(r, this.iconCoupon, 0, this.dx + 62, this.dy + 90);
    }

    r.drawText(`使用 ${this.coupon.discountPct}% 折價優惠券`, this.dx + 146, this.dy + 78, {
      color: [0.06, 0.22, 0.52, 1],
    });
    r.drawText(`商品：${name}`, this.dx + 146, this.dy + 104, {
      color: [0.08, 0.12, 0.22, 1],
    });
    r.drawText(`原價：${origPrice.toLocaleString()} ${unit}`, this.dx + 146, this.dy + 128, {
      color: [0.42, 0.45, 0.52, 1],
    });
    r.drawText(`優惠價：${discPrice.toLocaleString()} ${unit}`, this.dx + 146, this.dy + 152, {
      color: [0.78, 0.16, 0.10, 1],
    });

    this.btYes.render(r, this.dx, this.dy);
    this.btNo.render(r, this.dx, this.dy);
  }
}

// ─── 25. `CMyCouponListDlg` (`CA.exe.c:224515..226045`) ──────────────────────
// Retail `469x463` My Coupon List modal (`DialogCouponList/DlgItemCoupon`) with
// 2x2 `DialogCouponList/SlotCoupon (191x131)` grid `[[42, 97], [237, 97], [42, 232], [237, 232]]`,
// `MyCouponList_BtLeft (153, 373)`, `MyCouponList_BtRight (273, 373)`, & `BtClose (185, 408)`.

const COUPON_SLOTS_2X2: readonly [number, number][] = [
  [42, 97],
  [237, 97],
  [42, 232],
  [237, 232],
];

export class MyCouponListDlg implements ModalDialog {
  readonly id = "my_coupon_list";
  closed = false;
  private readonly dx = 165;
  private readonly dy = 68;
  private bg: LoadedSheet | null = null;
  private slotSheet: LoadedSheet | null = null;
  private iconCoupon: LoadedSheet | null = null;
  private shopImg: LoadedSheet | null = null;
  private readonly btLeft: SpriteButton;
  private readonly btRight: SpriteButton;
  private readonly btClose: SpriteButton;
  private readonly btRedeem: SpriteButton;
  private readonly edSerial: WebGpuEditBox;
  private readonly useBtns: SpriteButton[] = [];
  private readonly delBtns: SpriteButton[] = [];
  private readonly cache = new CharacterPreviewCache();
  private readonly assets: GameAssets;
  private readonly hub: ClientHub;
  private readonly pushDialog: (dlg: ModalDialog) => void;
  private page = 0;

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    pushDialog: (dlg: ModalDialog) => void,
  ) {
    this.assets = assets;
    this.hub = hub;
    this.pushDialog = pushDialog;
    // Exact `CA.exe.c:224778..226020`: `BtLeft (152, 370)`, `BtRight (276, 370)`, `BtClose (185, 415)`
    this.btLeft = new SpriteButton(152, 370, () => {
      this.page = Math.max(0, this.page - 1);
    });
    this.btRight = new SpriteButton(276, 370, () => {
      this.page = Math.min(this.maxPage(), this.page + 1);
    });
    this.btClose = new SpriteButton(185, 415, () => {
      imeHost.blur();
      this.closed = true;
    });
    this.edSerial = new WebGpuEditBox({
      x: this.dx + 122,
      y: this.dy + 64,
      w: 205,
      h: 20,
      maxLength: 20,
      placeholder: "輸入活動序號 (如 BNB9-GIFT-2006)",
      onEnter: () => this.submitSerial(),
    });
    this.btRedeem = new SpriteButton(335, 62, () => this.submitSerial());

    for (let i = 0; i < 4; i++) {
      const [sx, sy] = COUPON_SLOTS_2X2[i]!;
      this.useBtns.push(
        new SpriteButton(sx + 23, sy + 102, () => {
          const cp = this.hub.coupons[this.page * 4 + i];
          if (!cp) return;
          this.pushDialog(
            new CouponConfirmDlg(this.assets, cp, () => {
              this.hub.send({ type: "coupon_use", couponId: cp.couponId });
            }),
          );
        }),
      );
      this.delBtns.push(
        new SpriteButton(sx + 101, sy + 102, () => {
          const cp = this.hub.coupons[this.page * 4 + i];
          if (!cp) return;
          this.hub.send({ type: "coupon_delete", couponId: cp.couponId });
        }),
      );
    }

    void Promise.all([
      assets.loadSheet("Fx", "DialogCouponList/DlgItemCoupon"),
      assets.loadSheet("Fx", "DialogCouponList/SlotCoupon"),
      assets.loadSheet("Fx", "DialogCouponList/BtLeft"),
      assets.loadSheet("Fx", "DialogCouponList/BtRight"),
      assets.loadSheet("Fx", "DialogCouponList/BtClose"),
      assets.loadSheet("Fx", "DialogCouponList/Bt_UseCoupon"),
      assets.loadSheet("Fx", "DialogCouponList/Bt_DelCoupon"),
      assets.loadSheet("Fx", "Dialog/QuestionMark_IconCoupon"),
      assets.loadSheet("Fx", "Shop/ShopImg"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeOk"),
    ]).then(([bg, sl, bl, br, cl, bu, bd, ic, si, ok]) => {
      this.bg = bg;
      this.slotSheet = sl;
      this.iconCoupon = ic;
      this.shopImg = si;
      this.btLeft.bindSheet(bl, 43, 22);
      this.btRight.bindSheet(br, 43, 22);
      this.btClose.bindSheet(cl, 100, 32);
      this.btRedeem.bindSheet(ok, 86, 25);
      for (const b of this.useBtns) b.bindSheet(bu, 68, 22);
      for (const b of this.delBtns) b.bindSheet(bd, 68, 22);
    });
  }

  private submitSerial(): void {
    const code = this.edSerial.value.trim();
    if (!code) return;
    this.hub.send({ type: "coupon_redeem", code });
    this.edSerial.value = "";
    imeHost.blur();
  }

  private maxPage(): number {
    return Math.max(0, Math.ceil(this.hub.coupons.length / 4) - 1);
  }

  private syncSlotButtons(): void {
    const mp = this.maxPage();
    if (this.page > mp) this.page = mp;
    this.btLeft.enabled = this.page > 0;
    this.btRight.enabled = this.page < mp;
    for (let i = 0; i < 4; i++) {
      const has = Boolean(this.hub.coupons[this.page * 4 + i]);
      this.useBtns[i]!.visible = has;
      this.delBtns[i]!.visible = has;
    }
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.syncSlotButtons();
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btLeft.onMouseMove(lx, ly, sound);
    this.btRight.onMouseMove(lx, ly, sound);
    this.btClose.onMouseMove(lx, ly, sound);
    this.btRedeem.onMouseMove(lx, ly, sound);
    for (let i = 0; i < 4; i++) {
      this.useBtns[i]!.onMouseMove(lx, ly, sound);
      this.delBtns[i]!.onMouseMove(lx, ly, sound);
    }
  }

  onMouseDown(mx: number, my: number): boolean {
    this.syncSlotButtons();
    if (this.edSerial.handleMouseDown(mx, my)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btRedeem.onMouseDown(lx, ly)) return true;
    if (this.btLeft.onMouseDown(lx, ly)) return true;
    if (this.btRight.onMouseDown(lx, ly)) return true;
    if (this.btClose.onMouseDown(lx, ly)) return true;
    for (let i = 0; i < 4; i++) {
      if (this.useBtns[i]!.onMouseDown(lx, ly) || this.delBtns[i]!.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    this.syncSlotButtons();
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btRedeem.onMouseUp(lx, ly, sound)) return true;
    if (this.btLeft.onMouseUp(lx, ly, sound)) return true;
    if (this.btRight.onMouseUp(lx, ly, sound)) return true;
    if (this.btClose.onMouseUp(lx, ly, sound)) return true;
    for (let i = 0; i < 4; i++) {
      if (this.useBtns[i]!.onMouseUp(lx, ly, sound) || this.delBtns[i]!.onMouseUp(lx, ly, sound)) {
        return true;
      }
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs?: number): void {
    this.syncSlotButtons();
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    r.drawText("活動序號：", this.dx + 46, this.dy + 67, {
      color: [0.08, 0.22, 0.46, 1],
    });
    this.edSerial.render(r, nowMs ?? performance.now());
    this.btRedeem.render(r, this.dx, this.dy);

    if (this.hub.coupons.length === 0) {
      r.drawText("目前沒有任何折價優惠券", this.dx + 234, this.dy + 215, {
        align: "center",
        color: [0.32, 0.38, 0.48, 1],
      });
    } else {
      for (let i = 0; i < 4; i++) {
        const cp = this.hub.coupons[this.page * 4 + i];
        if (!cp) continue;
        const [sx, sy] = COUPON_SLOTS_2X2[i]!;
        const cx = this.dx + sx;
        const cy = this.dy + sy;
        drawSheetFrame(r, this.slotSheet, 0, cx, cy);

        const spec = this.assets.tables?.stockById.get(cp.stockId);
        if (spec) {
          this.cache.drawStockIcon(r, this.assets, spec, cx + 48, cy + 64, 52, 48);
        } else {
          drawSheetFrame(r, this.iconCoupon, 0, cx + 22, cy + 40);
        }
        drawSheetFrame(r, this.iconCoupon, 0, cx + 76, cy + 36, { w: 28, h: 24 });

        const title = `${spec?.name || `#${cp.stockId}`} (${cp.discountPct}% OFF)`;
        r.drawText(title, cx + 14, cy + 10, {
          color: [0.06, 0.16, 0.36, 1],
          maxWidth: 164,
        });
        r.drawText(`${cp.quantity}`, cx + 157, cy + 47, {
          align: "center",
          color: [0.08, 0.14, 0.24, 1],
        });
        r.drawText(`-${cp.discountPct}%`, cx + 155, cy + 82, {
          align: "center",
          color: [0.80, 0.15, 0.10, 1],
        });

        this.useBtns[i]!.render(r, this.dx, this.dy);
        this.delBtns[i]!.render(r, this.dx, this.dy);
      }
    }

    const mp = this.maxPage();
    if (this.shopImg) {
      drawSpriteDigits(r, this.shopImg, this.dx + 201, this.dy + 377, 14, 2, this.page + 1, 46);
      drawSheetFrame(r, this.shopImg, 56, this.dx + 230, this.dy + 377);
      drawSpriteDigits(r, this.shopImg, this.dx + 245, this.dy + 377, 14, 2, mp + 1, 46);
    } else {
      r.drawText(`${this.page + 1} / ${mp + 1}`, this.dx + 235, this.dy + 375, {
        align: "center",
        color: [0.08, 0.18, 0.34, 1],
      });
    }

    this.btLeft.render(r, this.dx, this.dy);
    this.btRight.render(r, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 26. `CNewUserSuccessDlg` (`CA.exe.c:38022..38105`) ───────────────────────
// Retail `600x483` registration-complete modal (`Dialog/DlgNewUserSuccess`) at `(100, 58)`
// with `Dialog/BtNewUserSuccessClose` (`86x25`) at `(259, 439)`.

export class NewUserSuccessDlg implements ModalDialog {
  readonly id = "newuser_success";
  closed = false;
  private readonly dx = 100;
  private readonly dy = 58;
  private bg: LoadedSheet | null = null;
  private readonly btClose: SpriteButton;

  constructor(assets: GameAssets, onClose?: () => void) {
    this.btClose = new SpriteButton(259, 439, () => {
      this.closed = true;
      onClose?.();
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgNewUserSuccess"),
      assets.loadSheet("Fx", "Dialog/BtNewUserSuccessClose"),
    ]).then(([bg, cl]) => {
      this.bg = bg;
      this.btClose.bindSheet(cl, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btClose.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btClose.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btClose.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter" || e.key === "Escape") {
      this.btClose.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btClose.render(r, this.dx, this.dy);
  }
}

// ─── 27. `CWaitForLoginDlg` (`CA.exe.c:44030..44150`) ─────────────────────────
// Retail `230x240` login wait modal (`Dialog/DlgWait`) at `(285, 180)` with
// `Dialog/WaitNumber` (`44x38` 10-second countdown digits) and `Dialog/BtWaitCancel` at `(66, 191)`.

export class WaitForLoginDlg implements ModalDialog {
  readonly id = "wait_login";
  closed = false;
  private readonly dx = 285;
  private readonly dy = 180;
  private bg: LoadedSheet | null = null;
  private waitNum: LoadedSheet | null = null;
  private readonly btCancel: SpriteButton;
  private readonly startMs = performance.now();

  constructor(assets: GameAssets, onCancel?: () => void) {
    this.btCancel = new SpriteButton(66, 191, () => {
      this.closed = true;
      onCancel?.();
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgWait"),
      assets.loadSheet("Fx", "Dialog/WaitNumber"),
      assets.loadSheet("Fx", "Dialog/BtWaitCancel"),
    ]).then(([bg, wn, ca]) => {
      this.bg = bg;
      this.waitNum = wn;
      this.btCancel.bindSheet(ca, 100, 32);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.btCancel.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const remainSec = Math.max(0, 9 - Math.floor((nowMs - this.startMs) / 1000));
    if (this.waitNum) {
      drawSheetFrame(r, this.waitNum, remainSec % 10, this.dx + 93, this.dy + 112);
    }
    this.btCancel.render(r, this.dx, this.dy);
  }
}

// ─── 22. `CSelectUserDlg` & `CMustSelectUserDlg` (`CA.exe.c:43298..43478`) ────
// Retail `Dialog/DlgSelectUser` / `Dialog/DlgSelectUserExchange` / `Dialog/DlgShopSelectUser` (`400x290` at `(200, 155)`):
//   - `Dialog/SelectUserTitle1` or `Dialog/SelectUserTitle2` at `(dx + 44, dy + 87)`
//   - Candidate user labels at `(dx + 158, dy + 132)` & `(dx + 158, dy + 182)`
//   - `Dialog/BtSelect` at `(267, 122)` & `(267, 172)`
//   - `Dialog/BtLoginCancel` at `(155, 224)` (hidden when `mustSelect === true`)

export class SelectUserDlg implements ModalDialog {
  readonly id = "select_user";
  closed = false;
  private readonly dx = 200;
  private readonly dy = 155;
  private bg: LoadedSheet | null = null;
  private titleSheet: LoadedSheet | null = null;
  private readonly btSelect0: SpriteButton;
  private readonly btSelect1: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly scroll: SpriteScrollBar;
  private readonly candidates: { username: string; nickname: string }[];
  private readonly mustSelect: boolean;
  private readonly onPick: (picked: { username: string; nickname: string }) => void;

  constructor(
    assets: GameAssets,
    candidates: { username: string; nickname: string }[],
    onPick: (picked: { username: string; nickname: string }) => void,
    opts?: { variant?: "default" | "exchange" | "shop"; titleKind?: 1 | 2; mustSelect?: boolean },
  ) {
    this.candidates = candidates;
    this.onPick = onPick;
    this.mustSelect = opts?.mustSelect ?? false;

    this.btSelect0 = new SpriteButton(267, 122, () => {
      const c = this.candidates[this.scroll.value];
      if (!c) return;
      this.closed = true;
      this.onPick(c);
    });
    this.btSelect1 = new SpriteButton(267, 172, () => {
      const c = this.candidates[this.scroll.value + 1];
      if (!c) return;
      this.closed = true;
      this.onPick(c);
    });
    this.btCancel = new SpriteButton(155, 224, () => {
      if (!this.mustSelect) this.closed = true;
    });
    this.btCancel.visible = !this.mustSelect;

    this.scroll = new SpriteScrollBar(358, 118, 17, 92);
    this.scroll.setRange(Math.max(0, candidates.length - 2), false);

    const bgName =
      opts?.variant === "exchange"
        ? "Dialog/DlgSelectUserExchange"
        : opts?.variant === "shop"
          ? "Dialog/DlgShopSelectUser"
          : "Dialog/DlgSelectUser";
    const titleName = opts?.titleKind === 2 ? "Dialog/SelectUserTitle2" : "Dialog/SelectUserTitle1";

    void Promise.all([
      assets.loadSheet("Fx", bgName),
      assets.loadSheet("Fx", titleName),
      assets.loadSheet("Fx", "Dialog/BtSelect"),
      assets.loadSheet("Fx", "Dialog/BtLoginCancel"),
      this.scroll.load(assets),
    ]).then(([bg, ti, sel, ca]) => {
      this.bg = bg;
      this.titleSheet = ti;
      this.btSelect0.bindSheet(sel, 78, 33);
      this.btSelect1.bindSheet(sel, 78, 33);
      this.btCancel.bindSheet(ca, 90, 32);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btSelect0.enabled = Boolean(this.candidates[this.scroll.value]);
    this.btSelect1.enabled = Boolean(this.candidates[this.scroll.value + 1]);
    this.btSelect0.onMouseMove(lx, ly, sound);
    this.btSelect1.onMouseMove(lx, ly, sound);
    if (!this.mustSelect) this.btCancel.onMouseMove(lx, ly, sound);
    if (this.candidates.length > 2) this.scroll.onMouseMove(lx, ly);
  }

  onMouseDown(mx: number, my: number, _sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btSelect0.enabled = Boolean(this.candidates[this.scroll.value]);
    this.btSelect1.enabled = Boolean(this.candidates[this.scroll.value + 1]);
    if (this.btSelect0.onMouseDown(lx, ly)) return true;
    if (this.btSelect1.onMouseDown(lx, ly)) return true;
    if (!this.mustSelect && this.btCancel.onMouseDown(lx, ly)) return true;
    if (this.candidates.length > 2 && this.scroll.onMouseDown(lx, ly)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btSelect0.onMouseUp(lx, ly, sound)) return true;
    if (this.btSelect1.onMouseUp(lx, ly, sound)) return true;
    if (!this.mustSelect && this.btCancel.onMouseUp(lx, ly, sound)) return true;
    if (this.candidates.length > 2 && this.scroll.onMouseUp(lx, ly, sound)) return true;
    return true;
  }

  onWheel(deltaY: number): boolean {
    if (this.candidates.length > 2) this.scroll.scrollBy(deltaY > 0 ? 1 : -1);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && !this.mustSelect) {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, _nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    if (this.titleSheet) {
      drawSheetFrame(r, this.titleSheet, 0, this.dx + 44, this.dy + 87);
    }
    const c0 = this.candidates[this.scroll.value];
    const c1 = this.candidates[this.scroll.value + 1];
    this.btSelect0.enabled = Boolean(c0);
    this.btSelect1.enabled = Boolean(c1);

    if (c0) {
      r.drawText(`${c0.nickname} (${c0.username})`, this.dx + 158, this.dy + 132, {
        align: "center",
        color: [0.06, 0.14, 0.28, 1],
        maxWidth: 185,
      });
    } else {
      r.drawText("目前沒有可選擇的玩家", this.dx + 158, this.dy + 132, {
        align: "center",
        color: [0.38, 0.44, 0.54, 1],
      });
    }
    if (c1) {
      r.drawText(`${c1.nickname} (${c1.username})`, this.dx + 158, this.dy + 182, {
        align: "center",
        color: [0.06, 0.14, 0.28, 1],
        maxWidth: 185,
      });
    }

    this.btSelect0.render(r, this.dx, this.dy);
    this.btSelect1.render(r, this.dx, this.dy);
    if (!this.mustSelect) this.btCancel.render(r, this.dx, this.dy);
    if (this.candidates.length > 2) this.scroll.render(r, this.dx, this.dy);
  }
}

// ─── 23. `CSelectCharShopDlg` (`CA.exe.c:51284..51515`, PE `0x614AA8..0x614BB8`) ──
// 8-Character Picker (`Shop/popup_Notice` `406x450` at `(197, 75)`):
//   - 8 `Dialog/BtCharac_C00..C07` / `Dialog/BtCharacMyPage_C00..C07` (`88x51`) at PE `0x614AA8`:
//     `[[58,96],[257,96],[58,149],[257,149],[58,202],[257,202],[58,255],[257,255]]`
//   - Selected Bomber preview at `(dx + 181 + 22, dy + 208)` & name centered at `(dx + 203, dy + 234)`
//   - `Dialog/BtShopConfirm` `(118, 358)` & `Dialog/BtShopCancel` `(211, 358)`

export const SELECT_CHAR_SHOP_COORDS: readonly [number, number][] = [
  [58, 96],
  [257, 96],
  [58, 149],
  [257, 149],
  [58, 202],
  [257, 202],
  [58, 255],
  [257, 255],
];

const SELECT_CHAR_NAMES_TW: readonly string[] = [
  "藍寶 Bazzi",
  "痞子妹 Dao",
  "工頭 Digg",
  "睏寶 Uni",
  "囡囡 Dizni",
  "小乖 Mos",
  "胖墩 Kephi",
  "ㄚ肥 Ethi",
];

export class SelectCharShopDlg implements ModalDialog {
  readonly id = "select_char_shop";
  closed = false;
  private readonly dx = 197;
  private readonly dy = 75;
  private bg: LoadedSheet | null = null;
  private myCharBadgeSheet: LoadedSheet | null = null;
  private readonly charBtns: SpriteButton[] = [];
  private readonly btRandomC10: SpriteButton;
  private readonly btOk: SpriteButton;
  private readonly btCancel: SpriteButton;
  private readonly currentMainChar: number;
  private selectedChar: number;
  private readonly assets: GameAssets;
  private readonly cache: CharacterPreviewCache;
  private readonly onConfirm: (charCode: number) => void;

  constructor(
    assets: GameAssets,
    initialChar: number,
    myPageVariant: boolean,
    onConfirm: (charCode: number) => void,
    cache?: CharacterPreviewCache,
  ) {
    this.assets = assets;
    this.currentMainChar = initialChar < 0 || initialChar >= 8 ? -1 : initialChar;
    this.selectedChar = this.currentMainChar;
    this.onConfirm = onConfirm;
    this.cache = cache ?? new CharacterPreviewCache();

    SELECT_CHAR_SHOP_COORDS.forEach(([bx, by], idx) => {
      const btn = new SpriteButton(bx, by, () => {
        this.selectedChar = idx;
        this.btRandomC10.toggled = false;
        this.charBtns.forEach((b, j) => (b.toggled = j === idx));
      }, { isTab: true });
      btn.toggled = idx === this.selectedChar;
      this.charBtns.push(btn);
      const spName = myPageVariant ? `Dialog/BtCharacMyPage_C0${idx}` : `Dialog/BtCharac_C0${idx}`;
      void assets.loadSheet("Fx", spName).then((sh) => btn.bindSheet(sh, 88, 51));
    });

    // 9th Random Character (`C10`) card (`Dialog/BtCharac_C10` / `Dialog/BtCharacMyPage_C10`, `88x51`)
    this.btRandomC10 = new SpriteButton(159, 255, () => {
      this.selectedChar = -1;
      this.btRandomC10.toggled = true;
      this.charBtns.forEach((b) => (b.toggled = false));
    }, { isTab: true });
    this.btRandomC10.toggled = this.selectedChar === -1;
    void assets
      .loadSheet("Fx", myPageVariant ? "Dialog/BtCharacMyPage_C10" : "Dialog/BtCharac_C10")
      .then((sh) => this.btRandomC10.bindSheet(sh, 88, 51));

    this.btOk = new SpriteButton(118, 358, () => {
      this.closed = true;
      this.onConfirm(this.selectedChar);
    });
    this.btCancel = new SpriteButton(211, 358, () => {
      this.closed = true;
    });

    void Promise.all([
      assets.loadSheet("Fx", "Shop/popup_Notice"),
      assets.loadSheet("Fx", "Dialog/ImgMycharl"),
      assets.loadSheet("Fx", "Dialog/BtShopConfirm"),
      assets.loadSheet("Fx", "Dialog/BtShopCancel"),
    ]).then(([bg, mcb, ok, ca]) => {
      this.bg = bg;
      this.myCharBadgeSheet = mcb;
      this.btOk.bindSheet(ok, 77, 36);
      this.btCancel.bindSheet(ca, 77, 36);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [...this.charBtns, this.btRandomC10, this.btOk, this.btCancel]) b.onMouseMove(lx, ly, sound);
  }

  onMouseDown(mx: number, my: number, _sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [...this.charBtns, this.btRandomC10, this.btOk, this.btCancel]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [...this.charBtns, this.btRandomC10, this.btOk, this.btCancel]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    if (e.key === "Enter") {
      this.btOk.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    r.drawText("選擇主要角色", this.dx + 203, this.dy + 58, {
      align: "center",
      color: [0.06, 0.14, 0.28, 1],
    });
    for (const b of this.charBtns) b.render(r, this.dx, this.dy);
    this.btRandomC10.render(r, this.dx, this.dy);
    // Exact `CA.exe.c:51317` `Dialog/ImgMycharl` (`88x51`) over current main character card!
    const curCoord: readonly [number, number] | undefined =
      this.currentMainChar === -1 ? [159, 255] : SELECT_CHAR_SHOP_COORDS[this.currentMainChar];
    if (this.myCharBadgeSheet && curCoord) {
      drawSheetFrame(r, this.myCharBadgeSheet, 0, this.dx + curCoord[0], this.dy + curCoord[1]);
    }

    const tick = Math.floor(nowMs / 30);
    const previewChar = this.selectedChar < 0 ? Math.floor(nowMs / 450) % 8 : this.selectedChar;
    this.cache.drawDisplayBomber(r, this.assets, previewChar, 1, this.dx + 203, this.dy + 208, tick, false);
    const cname =
      this.selectedChar < 0 ? "隨機角色 Random" : (SELECT_CHAR_NAMES_TW[this.selectedChar] ?? "");
    r.drawText(cname, this.dx + 203, this.dy + 234, {
      align: "center",
      color: [0.06, 0.16, 0.34, 1],
    });

    this.btOk.render(r, this.dx, this.dy);
    this.btCancel.render(r, this.dx, this.dy);
  }
}

/**
 * Retail `CShopTextDlg` (`CA.exe.c:54435..54560`, PE `0x614D78`):
 *   - Background: `Fx:Dialog/DlgShopText` (`340x393`) at `(230, 103)`
 *   - Close button: `Fx:Dialog/BtSelMapOk` (`98x32`, 5f) at `(121, 332)`
 *   - 6 detail rows at `(100, 110 + 35 * i)` (`0x614D78`)
 */
export class ShopTextDlg implements ModalDialog {
  readonly id = "shop_text";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 103;
  private bg: LoadedSheet | null = null;
  private readonly btOk: SpriteButton;
  private readonly btPresent: SpriteButton | null;
  private readonly assets: GameAssets;
  private readonly stock: StockItem;
  private readonly cache: CharacterPreviewCache;

  constructor(
    assets: GameAssets,
    stock: StockItem,
    cache?: CharacterPreviewCache,
    onPresent?: () => void,
  ) {
    this.assets = assets;
    this.stock = stock;
    this.cache = cache ?? new CharacterPreviewCache();
    const hasPresent = typeof onPresent === "function";
    this.btPresent = hasPresent
      ? new SpriteButton(60, 330, () => {
          this.closed = true;
          onPresent();
        })
      : null;
    this.btOk = new SpriteButton(hasPresent ? 182 : 121, 332, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgShopText"),
      assets.loadSheet("Fx", "Dialog/BtSelMapOk"),
      hasPresent ? assets.loadSheet("Fx", "Dialog/BtShopInfoPresent") : Promise.resolve(null),
    ]).then(([bg, ok, pr]) => {
      this.bg = bg;
      this.btOk.bindSheet(ok, 100, 32);
      if (this.btPresent && pr) this.btPresent.bindSheet(pr, 107, 36);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btPresent?.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btOk.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number, _sound?: SoundManager): boolean {
    if (this.btPresent?.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btOk.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btPresent?.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btOk.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, _nowMs?: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const s = this.stock;
    this.cache.drawStockIcon(r, this.assets, s, this.dx + 64, this.dy + 132, 48, 44);
    r.drawText(s.name, this.dx + 100, this.dy + 110, {
      color: [0.04, 0.12, 0.28, 1],
      maxWidth: 205,
    });

    const catLabels: Record<number, string> = {
      1: "主動戰鬥道具",
      2: "VIP / 功能通行證",
      3: "角色表情動作",
      4: "勝利慶祝特效",
      5: "階級閃耀特效",
      6: "偽裝階級道具",
      10: "房間背景裝飾",
      11: "超值優惠套裝",
      12: "角色隨身裝飾",
      14: "水球造型外觀",
      15: "彩色筆 / 聊天道具",
      18: "ID 名牌裝飾",
      19: "角色造型服飾",
    };
    const priceStr =
      stockCurrency(s) === "lucci"
        ? `${s.priceLucci.toLocaleString()} LUCCI`
        : `${s.priceCash.toLocaleString()} 樂豆點`;
    const durStr =
      s.durationDays && s.durationDays > 0
        ? `使用期限：${s.durationDays} 日`
        : s.quantity > 1
          ? `單次數量：${s.quantity} 個`
          : "使用期限：未標示";
    // Character compatibility comes from the user-item table, not +52
    // (which is a stringtable key). Do not invent a compatibility mask.
    const pkgChildren = this.assets.tables?.packageMap.get(s.id) ?? [];
    const extraLine =
      pkgChildren.length > 0
        ? `內含套裝：共 ${pkgChildren.length} 件組合道具`
        : "購買等級：不限等級";

    const rows = [
      `分類：${catLabels[s.category] ?? `類別 #${s.category}`}`,
      `價格：${priceStr}`,
      durStr,
      `適用角色：未確認`,
      extraLine,
    ];
    rows.forEach((line, idx) => {
      r.drawText(line, this.dx + 100, this.dy + 145 + idx * 35, {
        color: [0.10, 0.22, 0.40, 1],
        maxWidth: 210,
      });
    });

    this.btPresent?.render(r, this.dx, this.dy);
    this.btOk.render(r, this.dx, this.dy);
  }
}

// ─── 23. Retail BnB Messenger (`NM/DlgMsnListBox` `306x260` + `NM/DlgMsnChatBox` `309x260`) ───

export class BnbMessengerDlg implements ModalDialog {
  readonly id = "msn_messenger";
  closed = false;
  private readonly dx = 486;
  private readonly dy = 298;
  private readonly chatDx = 172;
  private readonly chatDy = 298;

  private listBg: LoadedSheet | null = null;
  private chatBg: LoadedSheet | null = null;
  private idBox: LoadedSheet | null = null;
  private mailSheet: LoadedSheet | null = null;
  private mailArrvSheet: LoadedSheet | null = null;
  private iconLogon: LoadedSheet | null = null;
  private iconLogout: LoadedSheet | null = null;
  private iconGame: LoadedSheet | null = null;
  private iconChat: LoadedSheet | null = null;
  private btAddSheet: LoadedSheet | null = null;

  private readonly btMail: SpriteButton;
  private readonly btOption: SpriteButton;
  private readonly btExit: SpriteButton;
  private readonly btAddFriend: SpriteButton;
  private readonly btChatClose: SpriteButton;
  private readonly scroll: SpriteScrollBar;
  private readonly edAddId: WebGpuEditBox;
  private readonly edChatInput: WebGpuEditBox;

  private readonly hub: ClientHub;
  private readonly onOpenSms: (target?: string) => void;
  private readonly onOpenRefusal: () => void;

  private selectedBuddy = "";
  private chatBuddy = "";
  private hoverRow = -1;

  constructor(
    assets: GameAssets,
    hub: ClientHub,
    opts: { onOpenSms: (target?: string) => void; onOpenRefusal: () => void },
  ) {
    this.hub = hub;
    this.onOpenSms = opts.onOpenSms;
    this.onOpenRefusal = opts.onOpenRefusal;

    this.btMail = new SpriteButton(166, 30, () => {
      imeHost.blur();
      this.closed = true;
      this.onOpenSms(this.selectedBuddy || undefined);
    });
    this.btOption = new SpriteButton(206, 30, () => {
      imeHost.blur();
      this.closed = true;
      this.onOpenRefusal();
    });
    this.btExit = new SpriteButton(278, 8, () => {
      imeHost.blur();
      this.closed = true;
    });
    this.btAddFriend = new SpriteButton(210, 228, () => {
      const target = this.edAddId.value.trim();
      if (target) {
        this.hub.send({ type: "friend_add", username: target });
        this.edAddId.value = "";
      }
    });
    this.btChatClose = new SpriteButton(281, 8, () => {
      this.chatBuddy = "";
      imeHost.blur();
    });

    this.scroll = new SpriteScrollBar(276, 74, 18, 146);
    this.edAddId = new WebGpuEditBox({
      x: this.dx + 18,
      y: this.dy + 230,
      w: 184,
      h: 18,
      maxLength: 16,
      placeholder: "新增好友帳號/暱稱",
      textColor: [0.95, 0.98, 1, 1],
      bgColor: [0.04, 0.12, 0.28, 0.72],
      borderColor: [0.28, 0.54, 0.88, 0.75],
      onEnter: () => this.btAddFriend.onClick?.(),
    });
    this.edChatInput = new WebGpuEditBox({
      x: this.chatDx + 18,
      y: this.chatDy + 226,
      w: 272,
      h: 20,
      maxLength: 80,
      placeholder: "輸入即時密語 (Enter 送出)...",
      textColor: [0.98, 0.99, 1, 1],
      bgColor: [0.03, 0.1, 0.25, 0.8],
      borderColor: [0.3, 0.58, 0.92, 0.8],
      onEnter: () => {
        const body = this.edChatInput.value.trim();
        if (this.chatBuddy && body) {
          this.hub.send({ type: "whisper_send", to: this.chatBuddy, text: body });
          this.edChatInput.value = "";
        }
      },
    });

    void Promise.all([
      assets.loadSheet("Fx", "NM/DlgMsnListBox"),
      assets.loadSheet("Fx", "NM/DlgMsnChatBox"),
      assets.loadSheet("Fx", "NM/MsnListIdBox"),
      assets.loadSheet("Fx", "NM/BtMsnMail"),
      assets.loadSheet("Fx", "NM/BtMsnMail01"),
      assets.loadSheet("Fx", "NM/BtMsnOption"),
      assets.loadSheet("Fx", "NM/BtMsnExit"),
      assets.loadSheet("Fx", "NM/BtMsnClose"),
      assets.loadSheet("Fx", "NM/MsnIcon_Logon"),
      assets.loadSheet("Fx", "NM/MsnIcon_Logout"),
      assets.loadSheet("Fx", "NM/MsnIcon_Game"),
      assets.loadSheet("Fx", "NM/MsnIcon_Chat"),
      assets.loadSheet("Fx", "Dialog/Bt_add"),
      this.scroll.loadNmTheme(assets),
    ]).then(([lbg, cbg, ib, ml, ml1, op, ex, cl, ilon, iloff, igm, ich, badd]) => {
      this.listBg = lbg;
      this.chatBg = cbg;
      this.idBox = ib;
      this.mailSheet = ml;
      this.mailArrvSheet = ml1;
      this.btMail.bindSheet(ml, 34, 29);
      this.btOption.bindSheet(op, 46, 29);
      this.btExit.bindSheet(ex, 19, 19);
      this.btChatClose.bindSheet(cl, 19, 19);
      this.iconLogon = ilon;
      this.iconLogout = iloff;
      this.iconGame = igm;
      this.iconChat = ich;
      this.btAddSheet = badd;
      this.btAddFriend.bindSheet(badd, 70, 23);
    });
  }

  private buddyEntries(): { username: string; nickname: string; online: boolean; roomId: number }[] {
    const out: { username: string; nickname: string; online: boolean; roomId: number }[] = [];
    const seen = new Set<string>();
    const lobbyByUser = new Map(this.hub.lobbyUsers.map((u) => [u.username.toLowerCase(), u]));
    for (const f of this.hub.friends) {
      seen.add(f.username.toLowerCase());
      const lu = lobbyByUser.get(f.username.toLowerCase());
      out.push({
        username: f.username,
        nickname: lu?.nickname ?? f.username,
        online: f.online,
        roomId: lu?.roomId ?? 0,
      });
    }
    const selfUser = this.hub.profile?.username.toLowerCase() ?? "";
    for (const u of this.hub.lobbyUsers) {
      if (u.username.toLowerCase() === selfUser || seen.has(u.username.toLowerCase())) continue;
      seen.add(u.username.toLowerCase());
      out.push({ username: u.username, nickname: u.nickname, online: true, roomId: u.roomId });
    }
    return out;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btMail.onMouseMove(lx, ly, sound);
    this.btOption.onMouseMove(lx, ly, sound);
    this.btExit.onMouseMove(lx, ly, sound);
    this.btAddFriend.onMouseMove(lx, ly, sound);
    this.scroll.onMouseMove(lx, ly);
    if (this.chatBuddy) {
      this.btChatClose.onMouseMove(mx - this.chatDx, my - this.chatDy, sound);
    }
    if (lx >= 18 && lx <= 267 && ly >= 74 && ly < 216) {
      this.hoverRow = Math.floor((ly - 74) / 23);
    } else {
      this.hoverRow = -1;
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    if (this.edAddId.handleMouseDown(mx, my)) return true;
    if (this.chatBuddy && this.edChatInput.handleMouseDown(mx, my)) return true;
    if (this.chatBuddy && this.btChatClose.onMouseDown(mx - this.chatDx, my - this.chatDy)) return true;

    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btMail, this.btOption, this.btExit, this.btAddFriend]) {
      if (b.onMouseDown(lx, ly)) return true;
    }
    if (this.scroll.onMouseDown(lx, ly)) return true;

    const entries = this.buddyEntries();
    if (lx >= 18 && lx <= 267 && ly >= 74 && ly < 216) {
      const row = Math.floor((ly - 74) / 23);
      const item = entries[this.scroll.value + row];
      if (item) {
        this.selectedBuddy = item.username;
        sound.playSfx("ButtonDown_0", 0.6);
        if (item.online) {
          this.chatBuddy = item.username;
          setTimeout(() => this.edChatInput.focus(), 10);
        } else {
          this.closed = true;
          this.onOpenSms(item.username);
        }
      }
      return true;
    }

    const inList = mx >= this.dx && mx < this.dx + 306 && my >= this.dy && my < this.dy + 260;
    const inChat =
      Boolean(this.chatBuddy) &&
      mx >= this.chatDx &&
      mx < this.chatDx + 309 &&
      my >= this.chatDy &&
      my < this.chatDy + 260;
    if (!inList && !inChat) {
      imeHost.blur();
      this.closed = true;
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.chatBuddy && this.btChatClose.onMouseUp(mx - this.chatDx, my - this.chatDy, sound)) return true;
    const lx = mx - this.dx;
    const ly = my - this.dy;
    for (const b of [this.btMail, this.btOption, this.btExit, this.btAddFriend]) {
      if (b.onMouseUp(lx, ly, sound)) return true;
    }
    this.scroll.onMouseUp(lx, ly, sound);
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 1 : -1);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      imeHost.blur();
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    const entries = this.buddyEntries();
    this.scroll.setRange(Math.max(0, entries.length - 6), false);

    if (this.chatBuddy) {
      drawSheetFrame(r, this.chatBg, 0, this.chatDx, this.chatDy);
      drawSheetFrame(r, this.iconChat, 0, this.chatDx + 18, this.chatDy + 36);
      r.drawText(`即時對話：${this.chatBuddy}`, this.chatDx + 38, this.chatDy + 38, {
        color: [0.06, 0.16, 0.34, 1],
      });
      this.btChatClose.render(r, this.chatDx, this.chatDy);

      const relevant = this.hub.whisperLog
        .filter((l) => l.from.toLowerCase().includes(this.chatBuddy.toLowerCase()) || l.text.includes(this.chatBuddy))
        .slice(-7);
      for (let i = 0; i < relevant.length; i++) {
        const line = relevant[i]!;
        r.drawText(`${line.from}: ${line.text}`.slice(0, 26), this.chatDx + 18, this.chatDy + 76 + i * 20, {
          color: [0.92, 0.97, 1, 1],
          outlineColor: [0.03, 0.09, 0.22, 1],
          maxWidth: 272,
        });
      }
      this.edChatInput.render(r, nowMs);
    }

    drawSheetFrame(r, this.listBg, 0, this.dx, this.dy);
    const selfNick = this.hub.profile?.nickname ?? "玩家";
    drawSheetFrame(r, this.iconLogon, 0, this.dx + 18, this.dy + 36);
    r.drawText(selfNick.slice(0, 10), this.dx + 38, this.dy + 38, {
      color: [0.06, 0.16, 0.34, 1],
      maxWidth: 122,
    });

    const unread = this.hub.sms.some((s) => !s.read);
    if (unread && this.mailArrvSheet && Math.floor(nowMs / 350) % 2 === 0) {
      this.btMail.bindSheet(this.mailArrvSheet, 34, 29);
    } else if (this.mailSheet) {
      this.btMail.bindSheet(this.mailSheet, 34, 29);
    }
    this.btMail.render(r, this.dx, this.dy);
    this.btOption.render(r, this.dx, this.dy);
    this.btExit.render(r, this.dx, this.dy);

    for (let i = 0; i < 6; i++) {
      const item = entries[this.scroll.value + i];
      if (!item) break;
      const ry = this.dy + 74 + i * 23;
      const sel = item.username === this.selectedBuddy || this.hoverRow === i;
      drawSheetFrame(r, this.idBox, 0, this.dx + 18, ry, {
        tint: sel ? [1.08, 1.08, 1.12, 1] : [1, 1, 1, 0.92],
      });
      const icon = !item.online
        ? this.iconLogout
        : item.roomId > 0
          ? this.iconGame
          : this.iconLogon;
      drawSheetFrame(r, icon, 0, this.dx + 22, ry + 2);
      const statusTag = !item.online ? "離線(寄信)" : item.roomId > 0 ? `#${item.roomId}房` : "大廳線上";
      r.drawText(`${item.nickname}`, this.dx + 42, ry + 3, {
        color: item.online ? [0.06, 0.16, 0.34, 1] : [0.36, 0.42, 0.52, 1],
        maxWidth: 132,
      });
      r.drawText(statusTag, this.dx + 260, ry + 3, {
        align: "right",
        color: item.online ? [0.1, 0.38, 0.18, 1] : [0.42, 0.44, 0.5, 1],
      });
    }

    this.scroll.render(r, this.dx, this.dy);
    this.edAddId.render(r, nowMs);
    if (this.btAddSheet) this.btAddFriend.render(r, this.dx, this.dy);
  }
}

// ─── 24. `CRetNoticeDlg` (`Dialog/DlgRetNotice` `340x200` at `(230, 200)`, `CA.exe.c:41051`) ───

export class RetNoticeDlg implements ModalDialog {
  readonly id = "ret_notice";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 200;
  private bg: LoadedSheet | null = null;
  private readonly btYes: SpriteButton;
  private readonly btNo: SpriteButton;
  private readonly msg: string;

  constructor(assets: GameAssets, onConfirmLeave: () => void) {
    this.msg = sysStr(assets, "ExitGameWarn", "比賽進行中離開將會計算敗場，確定要離開嗎？");
    this.btYes = new SpriteButton(78, 152, () => {
      this.closed = true;
      onConfirmLeave();
    });
    this.btNo = new SpriteButton(176, 152, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgRetNotice"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeYes"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeNo"),
    ]).then(([bg, ys, no]) => {
      this.bg = bg;
      this.btYes.bindSheet(ys, 86, 25);
      this.btNo.bindSheet(no, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btYes.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btNo.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btYes.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btNo.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btYes.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btNo.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    if (e.key === "Enter") {
      this.btYes.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    r.drawText(this.msg, this.dx + 200, this.dy + 86, {
      align: "center",
      color: [0.06, 0.14, 0.28, 1],
      maxWidth: 330,
    });
    this.btYes.render(r, this.dx, this.dy);
    this.btNo.render(r, this.dx, this.dy);
  }
}

/**
 * Retail `CMaridNoticeDlg` (`CA.exe.c:50971..51030`):
 *   - Background: `Fx:Dialog/DlgMarid_Notice` (`340x220`) centered at `(230, 190)`
 *   - Yes / No: `Fx:Dialog/BtRetNoticeYes (74, 162)` & `Fx:Dialog/BtRetNoticeNo (174, 162)` (`86x25`, 5f)
 */
export class MaridNoticeDlg implements ModalDialog {
  readonly id = "marid_notice";
  closed = false;
  private readonly dx = 230;
  private readonly dy = 190;
  private bg: LoadedSheet | null = null;
  private readonly btYes: SpriteButton;
  private readonly btNo: SpriteButton;

  constructor(assets: GameAssets, onConfirm: () => void) {
    this.btYes = new SpriteButton(74, 162, () => {
      this.closed = true;
      onConfirm();
    });
    this.btNo = new SpriteButton(174, 162, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgMarid_Notice"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeYes"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeNo"),
    ]).then(([bg, yes, no]) => {
      this.bg = bg;
      this.btYes.bindSheet(yes, 86, 25);
      this.btNo.bindSheet(no, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btYes.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.btNo.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btYes.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.btNo.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btYes.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    if (this.btNo.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    if (e.key === "Enter") {
      this.btYes.onClick?.();
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    this.btYes.render(r, this.dx, this.dy);
    this.btNo.render(r, this.dx, this.dy);
  }
}

/**
 * Retail `CLadderLoading` (`CA.exe.c:100250..100337`):
 *   - Background: `Fx:Ladder/Ladder_loadingStage` (`369x179`) centered at `(215, 210)`
 *   - Animated header: `Fx:Ladder/Ladder_loading` (`4f`, `167x30`) at `(98, 53)`
 *   - Progress bars (`0..8`): `Fx:Ladder/Ladder_loadingBar` (`12x15`) at `(124 + 14 * i, 90)`
 *   - Cancel button: `Fx:Dialog/BtRetNoticeCancel` (`86x25`, 5f) at `(141, 134)`
 */
export class LadderLoadingDlg implements ModalDialog {
  readonly id = "ladder_loading";
  closed = false;
  private readonly dx = 215;
  private readonly dy = 210;
  private bg: LoadedSheet | null = null;
  private loadingAnim: LoadedSheet | null = null;
  private barSheet: LoadedSheet | null = null;
  private readonly btCancel: SpriteButton;
  private readonly startedAt = performance.now();
  private completed = false;
  private readonly onMatched: () => void;

  constructor(assets: GameAssets, onMatched: () => void) {
    this.onMatched = onMatched;
    this.btCancel = new SpriteButton(141, 134, () => {
      this.closed = true;
    });
    void Promise.all([
      assets.loadSheet("Fx", "Ladder/Ladder_loadingStage"),
      assets.loadSheet("Fx", "Ladder/Ladder_loading"),
      assets.loadSheet("Fx", "Ladder/Ladder_loadingBar"),
      assets.loadSheet("Fx", "Dialog/BtRetNoticeCancel"),
    ]).then(([bg, anim, bar, cancel]) => {
      this.bg = bg;
      this.loadingAnim = anim;
      this.barSheet = bar;
      this.btCancel.bindSheet(cancel, 86, 25);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btCancel.onMouseMove(mx - this.dx, my - this.dy, sound);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btCancel.onMouseDown(mx - this.dx, my - this.dy)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btCancel.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    drawSheetFrame(r, this.loadingAnim, Math.floor(nowMs / 180) % 4, this.dx + 98, this.dy + 53);
    const elapsed = Math.max(0, nowMs - this.startedAt);
    const filled = Math.min(9, Math.floor(elapsed / 120) + 1);
    for (let i = 0; i < filled; i++) {
      drawSheetFrame(r, this.barSheet, 0, this.dx + 124 + 14 * i, this.dy + 90);
    }
    this.btCancel.render(r, this.dx, this.dy);
    if (!this.completed && elapsed >= 1100) {
      this.completed = true;
      this.closed = true;
      this.onMatched();
    }
  }
}

// ─── 25. Retail `CWebNoticeDlg` (`Dialog/DlgWebNotice` 490x480, `Cx:Etc/WebScreen`, `Etc/WebLoading`, `Etc/BtWebExit`) ───

export class WebNoticeDlg implements ModalDialog {
  readonly id = "web_notice";
  closed = false;
  private readonly dx = 155;
  private readonly dy = 60;
  private readonly openedAt = performance.now();

  private bg: LoadedSheet | null = null;
  private webScreen: LoadedSheet | null = null;
  private webLoading: LoadedSheet | null = null;
  private readonly xmasIcons: (LoadedSheet | null)[] = [null, null, null];
  private readonly btExit: SpriteButton;
  private readonly scroll: SpriteScrollBar;
  private readonly view: SpriteMsgView;
  private readonly hub: ClientHub;
  private synced = false;

  constructor(assets: GameAssets, hub: ClientHub) {
    this.hub = hub;
    // Exact `CWebNoticeDlg` (`CA.exe.c:40685..40710`): `Dialog/DlgWebNotice` `(155, 60, 490, 480)`, `Etc/BtWebExit` `(203, 423)`
    this.btExit = new SpriteButton(203, 423, () => {
      this.closed = true;
    });
    this.scroll = new SpriteScrollBar(this.dx + 436, this.dy + 168, 17, 240);
    this.view = new SpriteMsgView(this.dx + 44, this.dy + 170, 386, 236, this.scroll);

    void Promise.all([
      assets.loadSheet("Fx", "Dialog/DlgWebNotice"),
      assets.loadSheet("Cx", "Etc/WebScreen"),
      assets.loadSheet("Fx", "Etc/WebLoading"),
      assets.loadSheet("Fx", "Etc/BtWebExit"),
      assets.loadSheet("Fx", "Dialog/XMas_Item0"),
      assets.loadSheet("Fx", "Dialog/XMas_Item1"),
      assets.loadSheet("Fx", "Dialog/XMas_Item2"),
      this.scroll.load(assets),
    ]).then(([bg, ws, wl, ex, xm0, xm1, xm2]) => {
      this.bg = bg;
      this.webScreen = ws;
      this.webLoading = wl;
      this.xmasIcons[0] = xm0;
      this.xmasIcons[1] = xm1;
      this.xmasIcons[2] = xm2;
      this.btExit.bindSheet(ex, 92, 23);
    });
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    this.btExit.onMouseMove(mx - this.dx, my - this.dy, sound);
    this.scroll.onMouseMove(mx, my);
  }

  onMouseDown(mx: number, my: number): boolean {
    if (this.btExit.onMouseDown(mx - this.dx, my - this.dy)) return true;
    if (this.scroll.onMouseDown(mx, my)) return true;
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    if (this.btExit.onMouseUp(mx - this.dx, my - this.dy, sound)) return true;
    this.scroll.onMouseUp(mx, my, sound);
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 2 : -2);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Escape" || e.key === "Enter") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy);
    const vx = this.dx + 37;
    const vy = this.dy + 103;
    const vw = 418;
    const vh = 307;
    if (this.webScreen) {
      drawSheetFrame(r, this.webScreen, 0, vx, vy, { w: vw, h: vh, tint: [1, 1, 1, 0.28] });
    } else {
      r.fillRect(vx, vy, vw, vh, [0.95, 0.98, 1, 1]);
    }
    r.fillRect(vx, vy, vw, 58, [0.07, 0.22, 0.48, 0.88]);
    r.drawText("台灣爆爆王 Crazy Arcade BnB v9 官方活動公告板", vx + 14, vy + 10, {
      color: [1, 0.94, 0.52, 1],
      outlineColor: [0, 0, 0, 0.85],
    });
    // Seasonal Event Collectible Showcase (`Dialog/XMas_Item0..2`: 拐杖糖 / 聖誕花圈 / 聖誕樹)
    const xmasLabels = ["拐杖糖 +30L", "聖誕花圈 +50L", "聖誕樹 +100L"];
    for (let i = 0; i < 3; i++) {
      const ix = vx + 14 + i * 134;
      if (this.xmasIcons[i]) {
        drawSheetFrame(r, this.xmasIcons[i], 0, ix, vy + 28, { w: 22, h: 26 });
      }
      r.drawText(xmasLabels[i]!, ix + 26, vy + 36, {
        color: [0.92, 0.98, 1, 1],
      });
    }

    const elapsed = Math.max(0, nowMs - this.openedAt);
    if (elapsed < 520 && this.webLoading) {
      const lf = Math.floor(elapsed / 75) % 7;
      drawSheetFrame(r, this.webLoading, lf, vx, vy + 58, { w: vw, h: 18 });
    }

    if (!this.synced) {
      this.synced = true;
      const notices = this.hub.notices;
      const seasonalNote =
        "【節慶收集活動】於冰雪(Snow/Ice)、海灘(Beach/Ocean)、村莊森林(Village/Forest/Camp)地圖炸開木箱，即可收集聖誕樹、拐杖糖、夏日冰淇淋與中秋栗柿獲得最高 +100 LUCCI 獎勵！\n\n" +
        "【密技與指令】聊天欄支援 /notice 開啟公告板、/server 切換 HiNet 伺服器群組、/who <ID> 查詢戰績、/ar 自動準備。";
      const body =
        notices.length > 0
          ? `${seasonalNote}\n\n` +
            notices.map((n) => `【${n.category}】${n.title} (${n.date})\n${n.body}`).join("\n\n")
          : seasonalNote;
      this.view.setStaticText(r, body, [0.06, 0.14, 0.28, 1]);
    }
    this.view.render(r);
    this.btExit.render(r, this.dx, this.dy);
  }
}

// ─── 26. Retail `CMultiServer` Realm Selector (`MultiServer/CAStage` 510x496, `Icon`, `BtJoin`, `BtExit`) ───

export interface MultiServerRealmRow {
  sn: number;
  name: string;
  address: string;
  port: number;
  desc: string;
}

export class MultiServerDlg implements ModalDialog {
  readonly id = "multiserver";
  closed = false;
  private readonly dx = 145;
  private readonly dy = 52;

  private bg: LoadedSheet | null = null;
  private iconSheet: LoadedSheet | null = null;
  private readonly btJoin: SpriteButton;
  private readonly btExit: SpriteButton;
  private readonly scroll: SpriteScrollBar;
  private readonly realms: MultiServerRealmRow[];
  private selectedIdx = 0;
  private hoveredRow = -1;
  private lastClickMs = 0;
  private readonly onPicked?: (realm: MultiServerRealmRow) => void;

  constructor(assets: GameAssets, onPicked?: (realm: MultiServerRealmRow) => void) {
    this.onPicked = onPicked;
    const endpoints = mergeWithBuiltins(assets.tables?.servers ?? null);
    const rawName = assets.tables?.servers?.servers[0]?.name ?? "";
    const baseName = !rawName || rawName.toLowerCase() === "world name" ? "BnB-HiNet" : rawName;
    const realmNames = [
      `${baseName} 第一伺服器 (太魯閣)`,
      `${baseName} 第二伺服器 (阿里山)`,
      `${baseName} 第三伺服器 (日月潭)`,
      `${baseName} 第四伺服器 (墾丁灣)`,
      `${baseName} 活動測試專區`,
    ];
    this.realms = endpoints.map((ep, idx) => ({
      sn: ep.flag || idx + 1,
      name: realmNames[idx] ?? `${baseName} #${idx + 1}`,
      address: ep.address,
      port: ep.port,
      desc: idx === 0 ? "推薦伺服器 · 連線品質最佳 (HiNet 骨幹)" : "台灣爆爆王 v9 官方分流伺服器",
    }));
    if (this.realms.length < 5) {
      this.realms.push({
        sn: 5,
        name: `${baseName} 活動測試專區`,
        address: "127.0.0.1",
        port: 3000,
        desc: "本機 WebSocket 低延遲直連節點",
      });
    }

    const savedSn = Number(globalThis.localStorage?.getItem("bnb_last_multiserver_sn") ?? "1");
    const foundIdx = this.realms.findIndex((rm) => rm.sn === savedSn);
    if (foundIdx >= 0) this.selectedIdx = foundIdx;

    // Exact `CMultiServer` (`CA.exe.c:65196..65290`): `MultiServer/CAStage` `510x496`, 5 rows `(57, 142+23*i)`, selected `(57, 293)`
    this.btJoin = new SpriteButton(112, 444, () => this.confirmJoin());
    this.btExit = new SpriteButton(265, 443, () => {
      this.closed = true;
    });
    this.scroll = new SpriteScrollBar(this.dx + 430, this.dy + 142, 17, 115);
    this.scroll.setRange(Math.max(0, this.realms.length - 5), false);

    void Promise.all([
      assets.loadSheet("Fx", "MultiServer/CAStage"),
      assets.loadSheet("Fx", "MultiServer/Icon"),
      assets.loadSheet("Fx", "MultiServer/BtJoin"),
      assets.loadSheet("Fx", "MultiServer/BtExit"),
      this.scroll.load(assets),
    ]).then(([bg, ic, jn, ex]) => {
      this.bg = bg;
      this.iconSheet = ic;
      this.btJoin.bindSheet(jn, 134, 36);
      this.btExit.bindSheet(ex, 134, 36);
    });
  }

  private confirmJoin(): void {
    const picked = this.realms[this.selectedIdx] ?? this.realms[0];
    if (picked) {
      try {
        globalThis.localStorage?.setItem("bnb_last_multiserver_sn", String(picked.sn));
      } catch {
        // ignore storage quota errors
      }
      this.onPicked?.(picked);
    }
    this.closed = true;
  }

  onMouseMove(mx: number, my: number, sound: SoundManager): void {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    this.btJoin.onMouseMove(lx, ly, sound);
    this.btExit.onMouseMove(lx, ly, sound);
    this.scroll.onMouseMove(mx, my);
    this.hoveredRow = -1;
    for (let i = 0; i < 5; i++) {
      if (!this.realms[this.scroll.value + i]) break;
      if (lx >= 57 && lx <= 424 && ly >= 142 + i * 23 && ly <= 142 + i * 23 + 21) {
        this.hoveredRow = i;
        break;
      }
    }
  }

  onMouseDown(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btJoin.onMouseDown(lx, ly)) return true;
    if (this.btExit.onMouseDown(lx, ly)) return true;
    if (this.scroll.onMouseDown(mx, my)) return true;
    for (let i = 0; i < 5; i++) {
      const idx = this.scroll.value + i;
      if (!this.realms[idx]) break;
      if (lx >= 57 && lx <= 424 && ly >= 142 + i * 23 && ly <= 142 + i * 23 + 21) {
        const now = performance.now();
        if (this.selectedIdx === idx && now - this.lastClickMs < 380) {
          this.confirmJoin();
        } else {
          this.selectedIdx = idx;
          this.lastClickMs = now;
          sound.playSfx("ButtonDown_0", 0.55);
        }
        return true;
      }
    }
    return true;
  }

  onMouseUp(mx: number, my: number, sound: SoundManager): boolean {
    const lx = mx - this.dx;
    const ly = my - this.dy;
    if (this.btJoin.onMouseUp(lx, ly, sound)) return true;
    if (this.btExit.onMouseUp(lx, ly, sound)) return true;
    this.scroll.onMouseUp(mx, my, sound);
    return true;
  }

  onWheel(deltaY: number): boolean {
    this.scroll.scrollBy(deltaY > 0 ? 1 : -1);
    return true;
  }

  onKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "Enter") {
      this.confirmJoin();
      return true;
    }
    if (e.key === "Escape") {
      this.closed = true;
      return true;
    }
    return false;
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, this.dx, this.dy, { w: 510, h: 496 });
    for (let i = 0; i < 5; i++) {
      const idx = this.scroll.value + i;
      const rm = this.realms[idx];
      if (!rm) break;
      const ry = this.dy + 142 + i * 23;
      const isSel = idx === this.selectedIdx;
      const isHov = i === this.hoveredRow;
      const iconFrame = isSel ? 2 : isHov ? 1 : 0;
      if (this.iconSheet) {
        drawSheetFrame(r, this.iconSheet, iconFrame, this.dx + 57, ry, { w: 367, h: 21 });
      }
      r.drawText(`${rm.name}  (${rm.address}:${rm.port})`, this.dx + 84, ry + 4, {
        color: isSel ? [1, 0.96, 0.45, 1] : [0.06, 0.16, 0.32, 1],
        outlineColor: isSel ? [0, 0, 0, 0.85] : undefined,
      });
    }

    const cur = this.realms[this.selectedIdx] ?? this.realms[0];
    if (cur) {
      if (this.iconSheet) {
        drawSheetFrame(r, this.iconSheet, 2, this.dx + 57, this.dy + 293, { w: 392, h: 20 });
      }
      r.drawText(`目前選擇：${cur.name}`, this.dx + 84, this.dy + 296, {
        color: [1, 1, 1, 1],
        outlineColor: [0, 0, 0, 0.85],
      });
      r.fillRect(this.dx + 55, this.dy + 344, 400, 82, [0.94, 0.97, 1, 0.92]);
      r.drawText(cur.desc, this.dx + 66, this.dy + 356, {
        color: [0.08, 0.2, 0.4, 1],
      });
      r.drawText(`伺服器端點：${cur.address}:${cur.port}  (SN #${cur.sn})`, this.dx + 66, this.dy + 382, {
        color: [0.18, 0.34, 0.56, 1],
      });
      r.drawText("雙擊伺服器列或點擊下方 Join 立即切換分流", this.dx + 66, this.dy + 404, {
        color: [0.3, 0.44, 0.62, 1],
      });
    }

    if (this.realms.length > 5) {
      this.scroll.render(r);
    }
    this.btJoin.render(r, this.dx, this.dy);
    this.btExit.render(r, this.dx, this.dy);
  }
}
