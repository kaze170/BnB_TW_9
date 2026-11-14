// Stage 10: `CSelectServerStage` (`src/stage/selectserver.ts`).
// Strictly renders `CA.exe` `CSelectServerStage` (`Fx:SelectServerStage/*`):
//   - `SelectServerStage/CAStage` (`800x600` JPEG)
//   - Category tabs at `(509, 48)`: `BtNormal (+0)`, `BtFree (+56)`, `BtPremium (+112)`, `BtEvent (+168)`
//   - 13 channel rows at `y = 112 + 23*i` (`SelChannelImg` at `x=542`, name at `557, y+5`, `0..6` `Bar_User` at `672 + 9*k, y+3`)
//   - Paging `BtLeft01 (604, 444)` & `BtRight01 (652, 444)`, `BtEnter (575, 486)`
//   - Left notice board with `CCtrlScrollBar (465, 122, 17, 299)` + `CGlobalButtonDlg (0, 566)`

import type { LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { MultiServerDlg, WebNoticeDlg, type MultiServerRealmRow } from "../ui/dialogs.ts";
import {
  SpriteButton,
  SpriteMsgView,
  SpriteScrollBar,
  drawSheetFrame,
  pointInRect,
  sysStr,
} from "../ui/widgets.ts";
import type { AppContext, Stage } from "./types.ts";

export class SelectServerStage implements Stage {
  readonly id = "selectserver" as const;

  private bg: LoadedSheet | null = null;
  private barUser: LoadedSheet | null = null;
  private selRowImg: LoadedSheet | null = null;
  private bannerSheet: LoadedSheet | null = null;
  private realmBarSheet: LoadedSheet | null = null;

  private readonly tabs: SpriteButton[] = [];
  private readonly btLeft: SpriteButton;
  private readonly btRight: SpriteButton;
  private readonly btEnter: SpriteButton;
  private readonly btBbs: SpriteButton;
  private readonly noticeScroll: SpriteScrollBar;
  private readonly noticeView: SpriteMsgView;

  private tabIdx = 1; // 0=Normal(新手), 1=Free(自由), 2=Premium(段位), 3=Event(特殊)
  private page = 0;
  private selectedRow = 0;
  private hoveredRow = -1;
  private hoveredRealmPill = false;
  private activeRealmName = "BnB-HiNet 第一伺服器";
  private lastClickMs = 0;
  private noticeSynced = false;
  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;

    for (let i = 0; i < 4; i++) {
      const btn = new SpriteButton(509 + i * 56, 48, () => {
        this.tabIdx = i;
        this.page = 0;
        this.selectedRow = 0;
        this.tabs.forEach((t, j) => (t.toggled = j === i));
      }, { isTab: true });
      btn.toggled = i === this.tabIdx;
      this.tabs.push(btn);
    }

    this.btLeft = new SpriteButton(604, 444, () => {
      this.page = Math.max(0, this.page - 1);
      this.selectedRow = 0;
    });
    this.btRight = new SpriteButton(652, 444, () => {
      const maxP = Math.max(0, Math.ceil(this.filteredChannels().length / 13) - 1);
      this.page = Math.min(maxP, this.page + 1);
      this.selectedRow = 0;
    });
    this.btEnter = new SpriteButton(575, 486, () => this.enterChannel());
    this.btBbs = new SpriteButton(342, 74, () => {
      this.ctx.dialogs.push(new WebNoticeDlg(this.ctx.assets, this.ctx.hub));
    });

    this.noticeScroll = new SpriteScrollBar(465, 122, 17, 299);
    this.noticeView = new SpriteMsgView(31, 122, 428, 299, this.noticeScroll);
  }

  async enter(): Promise<void> {
    this.ctx.sound.playBgm("StageChannel");
    this.noticeSynced = false;
    await this.ctx.globalBar.load(this.ctx.assets);

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      await assets.fx.prefetch([
        "SelectServerStage/CAStage",
        "SelectServerStage/BtEnter",
        "SelectServerStage/BtNormal",
        "SelectServerStage/BtFree",
        "SelectServerStage/BtPremium",
        "SelectServerStage/BtEvent",
        "SelectServerStage/BtLeft01",
        "SelectServerStage/BtRight01",
        "SelectServerStage/Bar_User",
        "SelectServerStage/SelChannelImg",
        "Banner/banner_00",
      ]);
      const [bg, en, t0, t1, t2, t3, bl, br, bu, sl, bn, bbs, rb] = await Promise.all([
        assets.loadSheet("Fx", "SelectServerStage/CAStage"),
        assets.loadSheet("Fx", "SelectServerStage/BtEnter"),
        assets.loadSheet("Fx", "SelectServerStage/BtNormal"),
        assets.loadSheet("Fx", "SelectServerStage/BtFree"),
        assets.loadSheet("Fx", "SelectServerStage/BtPremium"),
        assets.loadSheet("Fx", "SelectServerStage/BtEvent"),
        assets.loadSheet("Fx", "SelectServerStage/BtLeft01"),
        assets.loadSheet("Fx", "SelectServerStage/BtRight01"),
        assets.loadSheet("Fx", "SelectServerStage/Bar_User"),
        assets.loadSheet("Fx", "SelectServerStage/SelChannelImg"),
        assets.loadSheet("Fx", "Banner/banner_00"),
        assets.loadSheet("Cx", "StageChannel/BtBbs"),
        assets.loadSheet("Fx", "MultiServer/Icon"),
        this.noticeScroll.load(assets),
      ]);
      this.bg = bg;
      this.barUser = bu;
      this.selRowImg = sl;
      this.bannerSheet = bn;
      this.realmBarSheet = rb;
      this.btEnter.bindSheet(en, 151, 39);
      this.btBbs.bindSheet(bbs, 136, 38);
      this.tabs[0]?.bindSheet(t0, 56, 26);
      this.tabs[1]?.bindSheet(t1, 56, 27);
      this.tabs[2]?.bindSheet(t2, 56, 27);
      this.tabs[3]?.bindSheet(t3, 56, 27);
      this.btLeft.bindSheet(bl, 43, 22);
      this.btRight.bindSheet(br, 43, 22);
    }

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "channel_joined") {
        void this.ctx.goto("lobby");
      }
    });
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private filteredChannels() {
    const base =
      this.ctx.hub.channels.length > 0
        ? this.ctx.hub.channels
        : this.ctx.assets.channels.map((c, index) => ({
            index,
            name: c.name,
            maxUsers: c.maxUsers,
            users: 0,
            kind: c.kind,
          }));
    const sub = base.filter((c) => {
      if (this.tabIdx === 0) return c.name.includes("初學") || c.name.includes("新手") || c.kind === 1;
      if (this.tabIdx === 1) return c.name.includes("自由") || c.kind === 0;
      if (this.tabIdx === 2) return c.name.includes("段位") || c.name.includes("高手") || c.kind === 2;
      return c.kind >= 3;
    });
    return sub.length > 0 ? sub : base;
  }

  private enterChannel(): void {
    const list = this.filteredChannels();
    const picked = list[this.page * 13 + this.selectedRow] ?? list[0];
    if (!picked) return;
    this.ctx.hub.send({ type: "join_channel", channelIdx: picked.index });
  }

  tick(): void {}

  private allButtons(): SpriteButton[] {
    return [...this.tabs, this.btLeft, this.btRight, this.btEnter, this.btBbs];
  }

  private openMultiServerPicker(): void {
    this.ctx.dialogs.push(
      new MultiServerDlg(this.ctx.assets, (picked: MultiServerRealmRow) => {
        this.activeRealmName = picked.name;
        this.page = 0;
        this.selectedRow = 0;
      }),
    );
  }

  onMouseMove(mx: number, my: number): void {
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    for (const b of this.allButtons()) b.onMouseMove(mx, my, this.ctx.sound);
    this.noticeScroll.onMouseMove(mx, my);
    this.hoveredRealmPill = pointInRect(mx, my, { x: 31, y: 78, w: 232, h: 28 });

    const list = this.filteredChannels();
    this.hoveredRow = -1;
    for (let i = 0; i < 13; i++) {
      if (!list[this.page * 13 + i]) break;
      if (pointInRect(mx, my, { x: 542, y: 112 + i * 23, w: 215, h: 22 })) {
        this.hoveredRow = i;
        break;
      }
    }
  }

  onMouseDown(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    for (const b of this.allButtons()) {
      if (b.onMouseDown(mx, my)) return;
    }
    if (this.noticeScroll.onMouseDown(mx, my)) return;
    if (pointInRect(mx, my, { x: 31, y: 78, w: 232, h: 28 })) {
      this.ctx.sound.playSfx("ButtonDown_0", 0.55);
      this.openMultiServerPicker();
      return;
    }
    if (pointInRect(mx, my, { x: 27, y: 446, w: 444, h: 104 })) {
      this.ctx.sound.playSfx("ButtonDown_0", 0.55);
      this.ctx.dialogs.push(new WebNoticeDlg(this.ctx.assets, this.ctx.hub));
      return;
    }

    const list = this.filteredChannels();
    for (let i = 0; i < 13; i++) {
      if (!list[this.page * 13 + i]) break;
      if (pointInRect(mx, my, { x: 542, y: 112 + i * 23, w: 215, h: 22 })) {
        const now = performance.now();
        if (this.selectedRow === i && now - this.lastClickMs < 380) {
          this.enterChannel();
        } else {
          this.selectedRow = i;
          this.lastClickMs = now;
          this.ctx.sound.playSfx("ButtonDown_0", 0.55);
        }
        return;
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    for (const b of this.allButtons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
    this.noticeScroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onWheel(deltaY: number, mx: number): void {
    if (mx < 495) {
      this.noticeScroll.scrollBy(deltaY > 0 ? 2 : -2);
    } else {
      const maxP = Math.max(0, Math.ceil(this.filteredChannels().length / 13) - 1);
      this.page = Math.max(0, Math.min(maxP, this.page + (deltaY > 0 ? 1 : -1)));
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter") this.enterChannel();
  }

  render(r: SpriteRenderer): void {
    drawSheetFrame(r, this.bg, 0, 0, 0, { w: 800, h: 600 });
    drawSheetFrame(r, this.bannerSheet, 0, 27, 446, { w: 444, h: 104 });
    if (this.realmBarSheet) {
      drawSheetFrame(r, this.realmBarSheet, this.hoveredRealmPill ? 1 : 2, 31, 81, { w: 232, h: 22 });
    }
    r.drawText(this.activeRealmName, 54, 85, {
      color: [1, 0.96, 0.66, 1],
      outlineColor: [0, 0, 0, 0.85],
    });

    if (!this.noticeSynced) {
      this.noticeSynced = true;
      const notices = this.ctx.hub.notices;
      const body =
        notices.length > 0
          ? notices.map((n) => `【${n.category}】${n.title} (${n.date})\n${n.body}`).join("\n\n")
          : "歡迎進入台灣爆爆王 Crazy Arcade BnB v9！\n\n請於右側選擇欲進入的遊戲頻道。";
      this.noticeView.setStaticText(r, body, [0.06, 0.14, 0.28, 1]);
    }
    this.noticeView.render(r);

    // Channel category description (`ChannelExplain0..3` from `csysstr.ssd`)
    const explain = sysStr(this.ctx.assets, `ChannelExplain${this.tabIdx}`, "");
    if (explain) {
      r.drawText(explain.slice(0, 26), 516, 84, { color: [0.08, 0.18, 0.34, 1] });
    }

    const list = this.filteredChannels();
    const maxP = Math.max(0, Math.ceil(list.length / 13) - 1);
    if (this.page > maxP) this.page = maxP;
    this.btLeft.enabled = this.page > 0;
    this.btRight.enabled = this.page < maxP;

    // Exact `CA.exe.c:86265..86290` & `85650..85700`: 13 Channel Rows at `y0 = 115 + 23*i`, hit `(542, 112 + 23*i, 215, 22)`
    for (let i = 0; i < 13; i++) {
      const ch = list[this.page * 13 + i];
      if (!ch) break;
      const y0 = 115 + i * 23;
      const sel = i === this.selectedRow;
      const hov = i === this.hoveredRow;

      if (sel || hov) {
        drawSheetFrame(r, this.selRowImg, sel ? 1 : 3, 542, y0 - 3, { anchor: true });
      }
      r.drawText(ch.name, 557, y0 + 2, {
        color: sel ? [1, 1, 1, 1] : [0.06, 0.14, 0.28, 1],
      });

      // 0..6 `Bar_User` population pips at `(672 + 9*k, y0)`
      const ratio = Math.min(1, ch.users / Math.max(1, ch.maxUsers));
      const pips = ch.users > 0 ? Math.max(1, Math.min(6, Math.ceil(ratio * 6))) : 1;
      for (let k = 0; k < pips; k++) {
        drawSheetFrame(r, this.barUser, Math.min(5, k), 672 + k * 9, y0);
      }
    }

    for (const b of this.allButtons()) b.render(r);
    this.ctx.globalBar.render(r, this.ctx.hub);
  }
}
