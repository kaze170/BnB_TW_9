// Stage 1: `CLoginStage` (`src/stage/login.ts`).
// Strictly renders the unmodified Taiwan BnB v9 `SkinDsc` + `SkinRsc` XML login skin:
//   - `img\LoginStageBack.jpg` (`800x600`)
//   - `Inner_1P` `(197, 395)`: `LoginTable00.bmp`, `Bt1P`, `Bt2P`, `ServerDream`, `ServerHappy`, ID & PW wells
//   - `Inner_2P` `(154, 395)`: `LoginTable01.bmp`, `Bt1P`, `Bt2P`, `ServerDream2P`, `ServerHappy2P`, 1P & 2P ID/PW wells
//   - Root buttons: `BtLoginNewId`, `BtLoginOK`, `BtLoginCancel`, `BtLoginCredit`

import type { LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { SKIN } from "../ui/skinrsc.ts";
import { parseSkinDsc, PANE, type SkinPane } from "../ui/skindsc.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import { SpriteButton, drawSheetFrame } from "../ui/widgets.ts";
import { NewUserDlg, NewUserSuccessDlg, NoticeDlg, WaitForLoginDlg } from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

interface TaggedSkinBtn {
  tag: string;
  btn: SpriteButton;
}

export class LoginStage implements Stage {
  readonly id = "login" as const;

  private backSheet: LoadedSheet | null = null;
  private table1P: LoadedSheet | null = null;
  private table2P: LoadedSheet | null = null;
  private players: 1 | 2 = 1;
  private serverIndex = 0; // 0 = Dream (夢幻王國), 1 = Happy (歡樂王國)

  private readonly skinBtns: TaggedSkinBtn[] = [];
  private readonly edId1: WebGpuEditBox;
  private readonly edPw1: WebGpuEditBox;
  private readonly ed2pId1: WebGpuEditBox;
  private readonly ed2pPw1: WebGpuEditBox;
  private readonly ed2pId2: WebGpuEditBox;
  private readonly ed2pPw2: WebGpuEditBox;

  private unsub: (() => void) | null = null;
  private waitDlg: WaitForLoginDlg | null = null;
  private loginCancelled = false;
  private registeringNewUser = false;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    // Exact `SkinDsc[2]` 1P wells at Inner_1P `(197, 395) + (205, 96 | 122, 84, 12)`
    this.edId1 = new WebGpuEditBox({
      x: 197 + 205,
      y: 395 + 96,
      w: 84,
      h: 12,
      maxLength: 20,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.edPw1.focus(),
      onEnter: () => void this.submitLogin(),
    });
    this.edPw1 = new WebGpuEditBox({
      x: 197 + 205,
      y: 395 + 122,
      w: 84,
      h: 12,
      maxLength: 20,
      password: true,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.edId1.focus(),
      onEnter: () => void this.submitLogin(),
    });

    // Exact `SkinDsc[3]` 2P wells at Inner_2P `(154, 395) + (199 | 297, 96 | 122, 84, 12)`
    this.ed2pId1 = new WebGpuEditBox({
      x: 154 + 199,
      y: 395 + 96,
      w: 84,
      h: 12,
      maxLength: 20,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.ed2pPw1.focus(),
      onEnter: () => void this.submitLogin(),
    });
    this.ed2pPw1 = new WebGpuEditBox({
      x: 154 + 199,
      y: 395 + 122,
      w: 84,
      h: 12,
      maxLength: 20,
      password: true,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.ed2pId2.focus(),
      onEnter: () => void this.submitLogin(),
    });
    this.ed2pId2 = new WebGpuEditBox({
      x: 154 + 297,
      y: 395 + 96,
      w: 84,
      h: 12,
      maxLength: 20,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.ed2pPw2.focus(),
      onEnter: () => void this.submitLogin(),
    });
    this.ed2pPw2 = new WebGpuEditBox({
      x: 154 + 297,
      y: 395 + 122,
      w: 84,
      h: 12,
      maxLength: 20,
      password: true,
      textColor: [0.04, 0.06, 0.12, 1],
      onTab: () => this.ed2pId1.focus(),
      onEnter: () => void this.submitLogin(),
    });

    this.edId1.value = "player1";
    this.edPw1.value = "1234";
    this.ed2pId1.value = "player1";
    this.ed2pPw1.value = "1234";
    this.ed2pId2.value = "player2";
    this.ed2pPw2.value = "1234";
  }

  async enter(): Promise<void> {
    this.ctx.sound.playBgm("StageLogin");

    if (!this.loaded) {
      this.loaded = true;
      await this.loadSkin();
    }

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "auth_ok") {
        if (this.waitDlg) {
          this.waitDlg.closed = true;
          this.waitDlg = null;
        }
        if (this.loginCancelled) {
          this.loginCancelled = false;
          return;
        }
        this.ctx.hub.dual2P = this.players === 2;
        imeHost.blur();
        if (this.registeringNewUser) {
          this.registeringNewUser = false;
          this.ctx.dialogs.push(
            new NewUserSuccessDlg(this.ctx.assets, () => {
              void this.ctx.goto("selectserver");
            }),
          );
          return;
        }
        void this.ctx.goto("selectserver");
      } else if (msg.type === "auth_err") {
        if (this.waitDlg) {
          this.waitDlg.closed = true;
          this.waitDlg = null;
        }
        this.registeringNewUser = false;
        this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", [msg.message]));
      }
    });

    setTimeout(() => {
      if (this.players === 1) this.edId1.focus();
      else this.ed2pId1.focus();
    }, 30);
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
    imeHost.blur();
  }

  private async loadSkin(): Promise<void> {
    const { assets } = this.ctx;
    const allNames = Object.values(SKIN);
    await assets.skinRsc.prefetch(allNames);
    const dscNames = assets.skinDsc.names();
    await assets.skinDsc.prefetch(dscNames);

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const n of dscNames) {
      const b = await assets.skinDsc.getPayload(n);
      if (b) {
        chunks.push(b);
        total += b.length;
      }
    }
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }
    const panes: SkinPane[] = parseSkinDsc(new TextDecoder("utf-8").decode(merged));

    this.backSheet = await assets.loadSheet("SkinRsc", SKIN.loginStageBack);
    this.table1P = await assets.loadSheet("SkinRsc", SKIN.loginTable00);
    this.table2P = await assets.loadSheet("SkinRsc", SKIN.loginTable01);

    const [btNew, btOk, btCancel, btCredit, bt1p, bt2p, svDream, svHappy, svDream2, svHappy2] =
      await Promise.all([
        assets.loadSheet("SkinRsc", SKIN.btLoginNewId),
        assets.loadSheet("SkinRsc", SKIN.btLoginOk),
        assets.loadSheet("SkinRsc", SKIN.btLoginCancel),
        assets.loadSheet("SkinRsc", SKIN.btLoginCredit),
        assets.loadSheet("SkinRsc", SKIN.bt1p),
        assets.loadSheet("SkinRsc", SKIN.bt2p),
        assets.loadSheet("SkinRsc", SKIN.serverDream),
        assets.loadSheet("SkinRsc", SKIN.serverHappy),
        assets.loadSheet("SkinRsc", SKIN.serverDream2p),
        assets.loadSheet("SkinRsc", SKIN.serverHappy2p),
      ]);

    const addBtn = (tag: string, x: number, y: number, sh: LoadedSheet | null, onClick: () => void, anchor = false) => {
      const btn = new SpriteButton(x, y, onClick, { anchor });
      btn.bindSheet(sh);
      this.skinBtns.push({ tag, btn });
    };

    const rootPane = panes[PANE.LoginStage];
    const findXY = (pane: SkinPane | undefined, id: string, fx: number, fy: number) => {
      const el = pane?.elements.find((e) => e.id === id);
      return { x: el?.x ?? fx, y: el?.y ?? fy };
    };

    const pNew = findXY(rootPane, "Button_New", 240, 560);
    const pOk = findXY(rootPane, "Button_OK", 350, 560);
    const pCancel = findXY(rootPane, "Button_Cancel", 460, 560);
    const pCredit = findXY(rootPane, "Button_Credit", 0, 562);

    addBtn("Button_New", pNew.x, pNew.y, btNew, () => {
      this.registeringNewUser = true;
      this.ctx.dialogs.push(
        new NewUserDlg(this.ctx.assets, this.ctx.hub, () => {
          // Handled via `auth_ok` -> `NewUserSuccessDlg` -> `selectserver`
        }),
      );
    });
    addBtn("Button_OK", pOk.x, pOk.y, btOk, () => void this.submitLogin());
    addBtn("Button_Cancel", pCancel.x, pCancel.y, btCancel, () => {
      this.edId1.value = "";
      this.edPw1.value = "";
      this.ed2pId1.value = "";
      this.ed2pPw1.value = "";
      this.ed2pId2.value = "";
      this.ed2pPw2.value = "";
    });
    addBtn("Button_Credit", pCredit.x, pCredit.y, btCredit, () => {
      void this.ctx.goto("credit");
    }, true);

    // Exact `SkinDsc[2]` 1P pane buttons at `Inner_1P (197, 395)`:
    //   `Bt1P (+10, +39)`, `Bt2P (+337, +39)`, `ServerDream (+108, +31)`, `ServerHappy (+204, +31)`
    addBtn("1P_Bt1P", 197 + 10, 395 + 39, bt1p, () => this.setPlayers(1));
    addBtn("1P_Bt2P", 197 + 337, 395 + 39, bt2p, () => this.setPlayers(2));
    addBtn("1P_Dream", 197 + 108, 395 + 31, svDream, () => this.setRealm(0));
    addBtn("1P_Happy", 197 + 204, 395 + 31, svHappy, () => this.setRealm(1));

    // Exact `SkinDsc[3]` 2P pane buttons at `Inner_2P (154, 395)`:
    //   `Bt1P (+10, +39)`, `Bt2P (+425, +39)`, `ServerDream2P (+107, +31)`, `ServerHappy2P (+250, +31)`
    addBtn("2P_Bt1P", 154 + 10, 395 + 39, bt1p, () => this.setPlayers(1));
    addBtn("2P_Bt2P", 154 + 425, 395 + 39, bt2p, () => this.setPlayers(2));
    addBtn("2P_Dream", 154 + 107, 395 + 31, svDream2, () => this.setRealm(0));
    addBtn("2P_Happy", 154 + 250, 395 + 31, svHappy2, () => this.setRealm(1));

    this.syncVisibility();
  }

  private setPlayers(n: 1 | 2): void {
    this.players = n;
    this.syncVisibility();
    if (n === 1) this.edId1.focus();
    else this.ed2pId1.focus();
  }

  private setRealm(idx: number): void {
    this.serverIndex = idx;
    this.syncVisibility();
  }

  private syncVisibility(): void {
    for (const { tag, btn } of this.skinBtns) {
      if (tag.startsWith("1P_")) btn.visible = this.players === 1;
      if (tag.startsWith("2P_")) btn.visible = this.players === 2;
      if (tag.endsWith("_Bt1P")) btn.toggled = this.players === 1;
      if (tag.endsWith("_Bt2P")) btn.toggled = this.players === 2;
      if (tag.endsWith("_Dream")) btn.toggled = this.serverIndex === 0;
      if (tag.endsWith("_Happy")) btn.toggled = this.serverIndex === 1;
    }
  }

  private async submitLogin(): Promise<void> {
    const username = (this.players === 1 ? this.edId1.value : this.ed2pId1.value).trim();
    const password = this.players === 1 ? this.edPw1.value : this.ed2pPw1.value;
    if (username.length < 2 || password.length < 2) {
      this.ctx.dialogs.push(
        new NoticeDlg(this.ctx.assets, "", ["請輸入至少 2 個字元的帳號與密碼！"]),
      );
      return;
    }
    this.loginCancelled = false;
    this.registeringNewUser = false;
    const wait = new WaitForLoginDlg(this.ctx.assets, () => {
      this.loginCancelled = true;
      this.waitDlg = null;
    });
    this.waitDlg = wait;
    this.ctx.dialogs.push(wait);
    try {
      await this.ctx.hub.ensureConnected();
      if (this.loginCancelled) return;
      this.ctx.hub.send({
        type: "auth_login",
        username,
        password,
        dual2P: this.players === 2,
      });
    } catch {
      if (this.waitDlg) {
        this.waitDlg.closed = true;
        this.waitDlg = null;
      }
      this.ctx.dialogs.push(
        new NoticeDlg(this.ctx.assets, "", ["無法連線至遊戲伺服器，請稍後再試。"]),
      );
    }
  }

  tick(): void {}

  onMouseMove(mx: number, my: number): void {
    for (const { btn } of this.skinBtns) {
      btn.onMouseMove(mx, my, this.ctx.sound);
    }
  }

  onMouseDown(mx: number, my: number): void {
    this.ctx.sound.unlock();
    if (this.players === 1) {
      if (this.edId1.handleMouseDown(mx, my) || this.edPw1.handleMouseDown(mx, my)) return;
    } else {
      if (
        this.ed2pId1.handleMouseDown(mx, my) ||
        this.ed2pPw1.handleMouseDown(mx, my) ||
        this.ed2pId2.handleMouseDown(mx, my) ||
        this.ed2pPw2.handleMouseDown(mx, my)
      ) {
        return;
      }
    }
    for (const { btn } of this.skinBtns) {
      if (btn.onMouseDown(mx, my)) return;
    }
  }

  onMouseUp(mx: number, my: number): void {
    for (const { btn } of this.skinBtns) {
      if (btn.onMouseUp(mx, my, this.ctx.sound)) return;
    }
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.backSheet, 0, 0, 0, { w: 800, h: 600 });

    if (this.players === 1) {
      drawSheetFrame(r, this.table1P, 0, 197, 395);
    } else {
      drawSheetFrame(r, this.table2P, 0, 154, 395);
    }

    for (const { btn } of this.skinBtns) {
      btn.render(r);
    }

    if (this.players === 1) {
      this.edId1.render(r, nowMs);
      this.edPw1.render(r, nowMs);
    } else {
      this.ed2pId1.render(r, nowMs);
      this.ed2pPw1.render(r, nowMs);
      this.ed2pId2.render(r, nowMs);
      this.ed2pPw2.render(r, nowMs);
    }
  }
}
