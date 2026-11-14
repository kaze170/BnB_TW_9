// Stage 14: `CShopStageNew` / `CShopStageTw` (`src/stage/shop.ts`).
// Strictly implements `CA.exe` `CShopStageNew` (`Fx:Shop/*`):
//   - `Shop/Stage` (`800x600` JPEG) & `Shop/Stage_zzim` (`800x600` JPEG for Shopping Cart)
//   - Top Character Filter Tabs (`0x616EC8`): `[[116,5]..[417,5]]` (`Shop/BtTab_C_00..07`)
//   - 6 Main Category Tabs (`0x616CA8`): `[[6,79],[69,79],[132,79],[195,79],[258,79],[398,79]]`
//     (`BtTab_Special`, `BtTab_Item`, `BtTab_Character`, `BtTab_Slot`, `BtTab_Set`, `BtTab_Choice`)
//   - Currency Tabs (`0x616CD0`): `BtTab_Cash (400, 109)`, `BtTab_Lucci (435, 109)`
//   - 3x3 Item Grid (`0x616DB0`): `[[16,140],[166,140],[316,140],[16,258],[166,258],[316,258],[16,376],[166,376],[316,376]]`
//     (`Shop/BtItemSlot` 148x117 + `Shop/BtBuy_Lucci` / `BtBuy_Cash` -> `ShopBuyDlg` `Shop/Popup_Buy`)
//   - 5-Row Shopping Cart (`0x616C80`): `[[26,140],[26,208],[26,276],[26,344],[26,412]]` (`Shop/Zzimlist` 410x67)
//   - Paging `Shop/BtLeft (154, 499)`, `BtRight (283, 499)`, `VScroll (445, 136, 18, 347)`
//   - Right Avatar Preview `(502, 64, 264, 128)`, `BtShop_Reset (491, 160)`, `BtShop_Hide (491, 185)`, `BtCharge (608, 510)`
//   - `CGlobalButtonDlg (0, 566)`

import { CHAR_MAIN_MAP, type LoadedSheet } from "../data/assets.ts";
import { stockCurrency, type StockItem } from "../data/tables.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import { imeHost } from "../ui/ime.ts";
import { SHOP_CARD, retailOwnedTooltip, retailPriceText, retailShopCategory } from "../ui/shop-layout.ts";
import {
  CharacterPreviewCache,
  MotionBlurTrail,
  ShopInventoryPopupMenu,
  SpriteButton,
  SpriteCheckBox,
  SpriteScrollBar,
  drawLevelIcon,
  drawSheetFrame,
  drawSpriteDigits,
  drawSpriteNumber,
  pointInRect,
  sampleActionFrame,
} from "../ui/widgets.ts";
import {
  MaridNoticeDlg,
  MyCouponListDlg,
  NoticeDlg,
  QuestionMarkRouletteDlg,
  RetNoticeDlg,
  SelectCharShopDlg,
  ShopBuyDlg,
  ShopPresentDlg,
  ShopTextDlg,
} from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

const SHOP_MAIN_CHAR_NAMES_TW: readonly string[] = [
  "藍寶 Bazzi",
  "痞子妹 Dao",
  "睏寶 Uni",
  "小乖 Mos",
  "囡囡 Dizni",
  "胖墩 Kephi",
  "工頭 Digg",
  "ㄚ肥 Ethi",
  "隨機角色 Random",
];

const ITEM_GRID_3X3: readonly [number, number][] = [
  [16, 140],
  [166, 140],
  [316, 140],
  [16, 258],
  [166, 258],
  [316, 258],
  [16, 376],
  [166, 376],
  [316, 376],
];

const CART_ROWS_5: readonly [number, number][] = [
  [26, 140],
  [26, 208],
  [26, 276],
  [26, 344],
  [26, 412],
];

interface SubTabSpec {
  sprite: string;
  x: number;
  cats: number[] | null;
  filterMode?: "hot" | "new" | "special";
}

const SUB_TABS_BY_MAIN: Record<number, SubTabSpec[]> = {
  0: [
    { sprite: "Shop/BtTab_Special00", x: 12, cats: null, filterMode: "new" },
    { sprite: "Shop/BtTab_Special01", x: 56, cats: null, filterMode: "hot" },
    { sprite: "Shop/BtTab_Special02", x: 126, cats: null, filterMode: "special" },
  ],
  1: [
    { sprite: "Shop/BtTab_Item00", x: 12, cats: [1, 2, 14] },
    { sprite: "Shop/BtTab_Item01", x: 79, cats: [1] },
    { sprite: "Shop/BtTab_Item02", x: 123, cats: [2, 14] },
  ],
  2: [
    { sprite: "Shop/BtTab_Character00", x: 12, cats: [12, 19] },
    { sprite: "Shop/BtTab_Character01", x: 67, cats: [12] },
    { sprite: "Shop/BtTab_Character02", x: 111, cats: [19] },
    { sprite: "Shop/BtTab_Character03", x: 155, cats: [12, 19] },
    { sprite: "Shop/BtTab_Character04", x: 199, cats: [12, 19] },
    { sprite: "Shop/BtTab_Character05", x: 261, cats: [12, 19] },
    { sprite: "Shop/BtTab_Character06", x: 323, cats: [12, 19] },
  ],
  3: [
    { sprite: "Shop/BtTab_Slot00", x: 12, cats: [10, 18, 4, 5] },
    { sprite: "Shop/BtTab_Slot01", x: 56, cats: [10] },
    { sprite: "Shop/BtTab_Slot02", x: 100, cats: [18] },
    { sprite: "Shop/BtTab_Slot03", x: 144, cats: [4] },
    { sprite: "Shop/BtTab_Slot04", x: 188, cats: [5] },
    { sprite: "Shop/BtTab_Slot05", x: 232, cats: [10, 18] },
    { sprite: "Shop/BtTab_Slot06", x: 285, cats: [4, 5] },
  ],
  4: [
    { sprite: "Shop/BtTab_Set00", x: 12, cats: [11, 3] },
    { sprite: "Shop/BtTab_Set01", x: 81, cats: [11] },
    { sprite: "Shop/BtTab_Set02", x: 148, cats: [3] },
    { sprite: "Shop/BtTab_Set03", x: 215, cats: [11, 3] },
    { sprite: "Shop/BtTab_Set04", x: 282, cats: [11, 3] },
  ],
};

const MAIN_TABS: { sprite: string; x: number; cats: number[] | null }[] = [
  { sprite: "Shop/BtTab_Special", x: 6, cats: null },
  { sprite: "Shop/BtTab_Item", x: 69, cats: [1, 2, 14] },
  { sprite: "Shop/BtTab_Character", x: 132, cats: [12, 19] },
  { sprite: "Shop/BtTab_Slot", x: 195, cats: [10, 18, 4, 5] },
  { sprite: "Shop/BtTab_Set", x: 258, cats: [11, 3] },
  { sprite: "Shop/BtTab_Choice", x: 398, cats: [] }, // Shopping Cart (`Zzimlist`)
];

export class ShopStage implements Stage {
  readonly id = "shop" as const;

  private bg: LoadedSheet | null = null;
  private bgCart: LoadedSheet | null = null;
  private readonly charBanners: (LoadedSheet | null)[] = new Array(9).fill(null);
  private slotSheet: LoadedSheet | null = null;
  private zzimRowSheet: LoadedSheet | null = null;
  private zzimSlotSheet: LoadedSheet | null = null;
  private zzimCashSheet: LoadedSheet | null = null;
  private zzimLucciSheet: LoadedSheet | null = null;
  private btChoiceSheet: LoadedSheet | null = null;
  private btShopPlusSheet: LoadedSheet | null = null;
  private btShopMinusSheet: LoadedSheet | null = null;
  private btShopDelSheet: LoadedSheet | null = null;
  private specialAni02Sheet: LoadedSheet | null = null;
  private icoHot: LoadedSheet | null = null;
  private icoNew: LoadedSheet | null = null;
  private btBuyCashSheet: LoadedSheet | null = null;
  private btBuyLucciSheet: LoadedSheet | null = null;
  private btBuyBagSheet: LoadedSheet | null = null;
  private shopImgSheet: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private qmSpriteSheet: LoadedSheet | null = null;
  private myCouponAniSheet: LoadedSheet | null = null;
  private choiceBlinkSheet: LoadedSheet | null = null;
  private icoFreeSheet: LoadedSheet | null = null;
  private icoLimitSheet: LoadedSheet | null = null;
  private icoImpEndSheet: LoadedSheet | null = null;
  private icoTimeSheet: LoadedSheet | null = null;
  private icoCouponSheet: LoadedSheet | null = null;
  private itemSoldOutSheet: LoadedSheet | null = null;
  private timeTable01Sheet: LoadedSheet | null = null;
  private timeTable02Sheet: LoadedSheet | null = null;
  private charSelTableSheet: LoadedSheet | null = null;
  private charSelShadowSheet: LoadedSheet | null = null;
  private slotImgSheet: LoadedSheet | null = null;
  private shopReadySheet: LoadedSheet | null = null;
  private talkOcto0Sheet: LoadedSheet | null = null;
  private talkOcto1Sheet: LoadedSheet | null = null;
  private readonly shopMainBtnSheets: (LoadedSheet | null)[] = new Array(9).fill(null);

  private readonly charTabs: SpriteButton[] = [];
  private hoveredCharTab = -1;
  private readonly popupMenu: ShopInventoryPopupMenu;
  private readonly mainTabs: SpriteButton[] = [];
  private readonly subTabsByMain = new Map<number, SpriteButton[]>();
  private readonly btTabCash: SpriteButton;
  private readonly btTabLucci: SpriteButton;
  private readonly btLeft: SpriteButton;
  private readonly btRight: SpriteButton;
  private readonly btReset: SpriteButton;
  private readonly btHide: SpriteButton;
  private readonly btCharge: SpriteButton;
  private readonly btGachapon: SpriteButton;
  private readonly btMyCoupon: SpriteButton;
  private readonly btCartSelBuy: SpriteButton;
  private readonly btCartBuyAll: SpriteButton;
  private readonly btCartDelAll: SpriteButton;
  private readonly btCartGoShop: SpriteButton;
  private readonly cartChecks: SpriteCheckBox[] = [];
  private readonly scroll: SpriteScrollBar;
  private readonly cache = new CharacterPreviewCache();

  private previewChar = 0;
  private tabIdx = 0;
  private subTabIdx = 0;
  private currencyFilter: "all" | "cash" | "lucci" = "all";
  private filtered: StockItem[] = [];
  private readonly cart: StockItem[] = [];
  private readonly cartQty = new Map<number, number>();
  private readonly cartSelected = new Set<number>();
  private pendingCartPurchase: { requestId: string; startedMs: number; items: { stockId: number; qty: number }[] } | null = null;
  private page = 0;
  private hoveredCard = -1;
  private hoveredBuyBtn = -1;
  private hoveredBagBtn = -1;
  private previewItem: StockItem | null = null;
  private hideDeco = false;

  // `CMiniMapWndForShop` (`(502, 64, 264, 128)`, `CA.exe.c:127890..128199`) live preview sandbox!
  private readonly miniMotionTrail = new MotionBlurTrail();
  private miniX = 0;
  private miniY = 0;
  private miniDir: 0 | 1 | 2 | 3 = 3;
  private readonly miniKeys = new Set<string>();
  private readonly miniBombs: Array<{ x: number; y: number; placedMs: number; stockId: number }> = [];
  private readonly miniFlames: Array<{ x: number; y: number; explodeMs: number }> = [];

  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.popupMenu = new ShopInventoryPopupMenu();

    // Exact `CA.exe.c:153299..153345, 158403..158415, 373837..373851` (`0x616EC8`: `116 + 43*i, 5`):
    // 8 `Shop/BtShopMain_C0${CHAR_MAIN_MAP[i]}` + 9th `Shop/BtShopMain_C10` (`460, 5`, Random Character `charCode = -1`)!
    for (let i = 0; i < 9; i++) {
      const btn = new SpriteButton(
        116 + i * 43,
        5,
        () => {
          if (this.previewChar === i && i < 8) {
            this.openSelectCharDialog();
            return;
          }
          this.previewChar = i;
          this.charTabs.forEach((b, j) => (b.toggled = j === i));
          const charCode = i === 8 ? -1 : (CHAR_MAIN_MAP[i] ?? 0);
          if (this.ctx.hub.profile) this.ctx.hub.profile.selectedChar = charCode;
          this.ctx.hub.send({ type: "select_char", charCode });
          this.ctx.hub.send({ type: "room_set_char", charCode });
          if (this.tabIdx === 2) {
            this.page = 0;
            this.rebuildFilter();
          }
        },
        { isTab: true },
      );
      btn.toggled = i === 0;
      this.charTabs.push(btn);
    }

    // 6 Main Tabs (`0x616CA8`) + per-category Sub-Tabs at `y = 110`
    MAIN_TABS.forEach((mt, idx) => {
      const btn = new SpriteButton(mt.x, 79, () => {
        this.tabIdx = idx;
        this.subTabIdx = 0;
        this.page = 0;
        this.mainTabs.forEach((b, j) => (b.toggled = j === idx));
        this.subTabsByMain.get(idx)?.forEach((sb, sj) => (sb.toggled = sj === 0));
        this.rebuildFilter();
      }, { isTab: true });
      btn.toggled = idx === 0;
      this.mainTabs.push(btn);

      const specs = SUB_TABS_BY_MAIN[idx] ?? [];
      const subBtns: SpriteButton[] = [];
      specs.forEach((sp, sIdx) => {
        const sb = new SpriteButton(sp.x, 110, () => {
          this.subTabIdx = sIdx;
          this.page = 0;
          subBtns.forEach((b, j) => (b.toggled = j === sIdx));
          this.rebuildFilter();
        }, { isTab: true });
        sb.toggled = sIdx === 0;
        subBtns.push(sb);
      });
      this.subTabsByMain.set(idx, subBtns);
    });

    this.btTabCash = new SpriteButton(400, 109, () => {
      this.currencyFilter = this.currencyFilter === "cash" ? "all" : "cash";
      this.btTabCash.toggled = this.currencyFilter === "cash";
      this.btTabLucci.toggled = false;
      this.page = 0;
      this.rebuildFilter();
    });
    this.btTabLucci = new SpriteButton(435, 109, () => {
      this.currencyFilter = this.currencyFilter === "lucci" ? "all" : "lucci";
      this.btTabLucci.toggled = this.currencyFilter === "lucci";
      this.btTabCash.toggled = false;
      this.page = 0;
      this.rebuildFilter();
    });

    this.btLeft = new SpriteButton(154, 499, () => {
      this.page = Math.max(0, this.page - 1);
      this.scroll.value = this.page;
    });
    this.btRight = new SpriteButton(283, 499, () => {
      const maxP = this.maxPage();
      this.page = Math.min(maxP, this.page + 1);
      this.scroll.value = this.page;
    });
    this.scroll = new SpriteScrollBar(445, 136, 18, 347, (v) => {
      this.page = v;
    });

    this.btReset = new SpriteButton(491, 160, () => {
      this.previewItem = null;
      this.hideDeco = false;
      this.miniX = 0;
      this.miniY = 0;
      this.miniDir = 3;
      this.miniBombs.length = 0;
      this.miniFlames.length = 0;
    });
    this.btHide = new SpriteButton(491, 185, () => {
      this.hideDeco = !this.hideDeco;
    });
    this.btCharge = new SpriteButton(608, 510, () => {
      this.ctx.hub.send({ type: "charge_cash", amount: 5000 });
    });
    this.btGachapon = new SpriteButton(516, 516, () => {
      this.ctx.dialogs.push(new QuestionMarkRouletteDlg(this.ctx.assets, this.ctx.hub, this.ctx.sound));
    });
    // `BtShop_MyCoupon` at `(268, 108)` on the Special tab (right of `BtTab_Special00..02`, left of `BtTab_Cash`)
    this.btMyCoupon = new SpriteButton(268, 108, () => {
      this.ctx.dialogs.push(
        new MyCouponListDlg(this.ctx.assets, this.ctx.hub, (dlg) => this.ctx.dialogs.push(dlg)),
      );
    });

    // Exact `CA.exe.c:156360..156465` Wishlist row checkboxes `(rx + 4, ry + 25)` + batch buttons:
    //   `BtShop_DeleteAll` `(351, 486)`, `BtShop_SelBuy` `(50, 532)`, `BtShop_BuyAll` `(178, 532)`, `BtShop_GoShop` `(306, 532)`
    for (let i = 0; i < 5; i++) {
      const [rx, ry] = CART_ROWS_5[i]!;
      const cb = new SpriteCheckBox(rx + 4, ry + 25, true, (checked) => {
        const it = this.cart[this.page * 5 + i];
        if (!it) return;
        if (checked) this.cartSelected.add(it.id);
        else this.cartSelected.delete(it.id);
      });
      this.cartChecks.push(cb);
    }
    this.btCartSelBuy = new SpriteButton(50, 532, () => {
      this.buyCartItems(this.cart.filter(it => this.cartSelected.has(it.id)));
    });
    this.btCartBuyAll = new SpriteButton(178, 532, () => {
      this.buyCartItems(this.cart);
    });
    this.btCartDelAll = new SpriteButton(351, 486, () => {
      this.cart.length = 0;
      this.cartSelected.clear();
      this.cartQty.clear();
    });
    this.btCartGoShop = new SpriteButton(306, 532, () => {
      this.tabIdx = 0;
      this.subTabIdx = 0;
      this.page = 0;
      this.mainTabs.forEach((b, j) => (b.toggled = j === 0));
      this.rebuildFilter();
    });
  }

  async enter(): Promise<void> {
    this.ctx.sound.playBgm("StageChannel");
    await this.ctx.globalBar.load(this.ctx.assets);
    if (this.ctx.hub.profile) {
      if (this.ctx.hub.profile.selectedChar === -1 || this.ctx.hub.profile.selectedChar >= 8) {
        this.previewChar = 8;
      } else {
        const tabIdx = CHAR_MAIN_MAP.indexOf(
          this.ctx.hub.profile.selectedChar as (typeof CHAR_MAIN_MAP)[number],
        );
        this.previewChar = tabIdx >= 0 ? tabIdx : 0;
      }
      this.charTabs.forEach((b, j) => (b.toggled = j === this.previewChar));
    }

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      const [
        bg,
        bgz,
        sl,
        zz,
        zzSlot,
        zzCash,
        zzLucci,
        btCh,
        btPl,
        btMn,
        btDel,
        spAni02,
        ih,
        inw,
        bc,
        bl,
        bb,
        si,
        lv,
        tc,
        tl,
        bL,
        bR,
        rs,
        hd,
        chg,
        sb,
        ba,
        da,
        gs,
        qmIcon,
        qmItem,
        mcBtn,
        mcAni,
        chk,
        chBlink,
        iFree,
        iLim,
        iImp,
        iTime,
        iCpn,
        soldOut,
        tt01,
        tt02,
        csTbl,
        csShd,
        slImg,
        shRdy,
        octo0,
        octo1,
      ] = await Promise.all([
        assets.loadSheet("Fx", "Shop/Stage"),
        assets.loadSheet("Fx", "Shop/Stage_zzim"),
        assets.loadSheet("Fx", "Shop/BtItemSlot"),
        assets.loadSheet("Fx", "Shop/Zzimlist"),
        assets.loadSheet("Fx", "Shop/BtItemSlot_zzim"),
        assets.loadSheet("Fx", "Shop/Zzimlist_cash"),
        assets.loadSheet("Fx", "Shop/Zzimlist_Lucci"),
        assets.loadSheet("Fx", "Shop/BtChoice"),
        assets.loadSheet("Fx", "Shop/BtShop_+"),
        assets.loadSheet("Fx", "Shop/BtShop_-"),
        assets.loadSheet("Fx", "Shop/BtShop_Delete"),
        assets.loadSheet("Fx", "Shop/BtTab_SpecialAni02"),
        assets.loadSheet("Fx", "Shop/IcoShopHot"),
        assets.loadSheet("Fx", "Shop/IcoShopNew"),
        assets.loadSheet("Fx", "Shop/BtBuy_Cash"),
        assets.loadSheet("Fx", "Shop/BtBuy_Lucci"),
        assets.loadSheet("Fx", "Shop/BtBuyBag"),
        assets.loadSheet("Fx", "Shop/ShopImg"),
        assets.loadSheet("Cx", "Etc/LevelIcons"),
        assets.loadSheet("Fx", "Shop/BtTab_Cash"),
        assets.loadSheet("Fx", "Shop/BtTab_Lucci"),
        assets.loadSheet("Fx", "Shop/BtLeft"),
        assets.loadSheet("Fx", "Shop/BtRight"),
        assets.loadSheet("Fx", "Shop/BtShop_Reset"),
        assets.loadSheet("Fx", "Shop/BtShop_Hide"),
        assets.loadSheet("Fx", "Shop/BtCharge"),
        assets.loadSheet("Fx", "Shop/BtShop_SelBuy"),
        assets.loadSheet("Fx", "Shop/BtShop_BuyAll"),
        assets.loadSheet("Fx", "Shop/BtShop_DeleteAll"),
        assets.loadSheet("Fx", "Shop/BtShop_GoShop"),
        assets.loadSheet("Fx", "Dialog/QuestionMark_IconCoupon"),
        assets.loadSheet("Fx", "Item/QuestionMark"),
        assets.loadSheet("Fx", "Shop/BtShop_MyCoupon"),
        assets.loadSheet("Fx", "Shop/BtShop_MyCoupon_Ani"),
        assets.loadSheet("Fx", "Dialog/BtCheckBox"),
        assets.loadSheet("Fx", "Shop/BtTab_ChoiceBlink"),
        assets.loadSheet("Fx", "Shop/IcoFree"),
        assets.loadSheet("Fx", "Shop/IcoLimit"),
        assets.loadSheet("Fx", "Shop/Ico_ImpEnd"),
        assets.loadSheet("Fx", "Shop/IconTime"),
        assets.loadSheet("Fx", "Shop/IconCoupon"),
        assets.loadSheet("Fx", "Shop/ItemSoldOut"),
        assets.loadSheet("Fx", "Shop/TimeTable_01"),
        assets.loadSheet("Fx", "Shop/TimeTable_02"),
        assets.loadSheet("Fx", "Shop/CharSel_Table"),
        assets.loadSheet("Fx", "Shop/CharSelShadow_Table"),
        assets.loadSheet("Fx", "Shop/SlotImg"),
        assets.loadSheet("Fx", "Shop/Ready"),
        assets.loadSheet("Fx", "Shop/Talk_octo00"),
        assets.loadSheet("Fx", "Shop/Talk_octo01"),
        this.scroll.load(assets),
        this.popupMenu.load(assets),
      ]);
      this.bg = bg;
      this.bgCart = bgz;
      this.slotSheet = sl;
      this.zzimRowSheet = zz;
      this.zzimSlotSheet = zzSlot;
      this.zzimCashSheet = zzCash;
      this.zzimLucciSheet = zzLucci;
      this.btChoiceSheet = btCh;
      this.btShopPlusSheet = btPl;
      this.btShopMinusSheet = btMn;
      this.btShopDelSheet = btDel;
      this.specialAni02Sheet = spAni02;
      this.icoHot = ih;
      this.icoNew = inw;
      this.btBuyCashSheet = bc;
      this.btBuyLucciSheet = bl;
      this.btBuyBagSheet = bb;
      this.shopImgSheet = si;
      this.levelSheet = lv;
      this.qmSpriteSheet = qmItem;
      this.myCouponAniSheet = mcAni;
      this.choiceBlinkSheet = chBlink;
      this.icoFreeSheet = iFree;
      this.icoLimitSheet = iLim;
      this.icoImpEndSheet = iImp;
      this.icoTimeSheet = iTime;
      this.icoCouponSheet = iCpn;
      this.itemSoldOutSheet = soldOut;
      this.timeTable01Sheet = tt01;
      this.timeTable02Sheet = tt02;
      this.charSelTableSheet = csTbl;
      this.charSelShadowSheet = csShd;
      this.slotImgSheet = slImg;
      this.shopReadySheet = shRdy;
      this.talkOcto0Sheet = octo0;
      this.talkOcto1Sheet = octo1;
      for (const cb of this.cartChecks) cb.bindSheet(chk);

      this.btTabCash.bindSheet(tc, 34, 20);
      this.btTabLucci.bindSheet(tl, 34, 20);
      this.btLeft.bindSheet(bL, 43, 21);
      this.btRight.bindSheet(bR, 43, 21);
      this.btReset.bindSheet(rs, 96, 23);
      this.btHide.bindSheet(hd, 96, 23);
      this.btCharge.bindSheet(chg, 130, 35);
      this.btGachapon.bindSheet(qmIcon, 38, 20);
      this.btMyCoupon.bindSheet(mcBtn, 122, 26);
      this.btCartSelBuy.bindSheet(sb, 122, 26);
      this.btCartBuyAll.bindSheet(ba, 122, 26);
      this.btCartDelAll.bindSheet(da, 95, 29);
      this.btCartGoShop.bindSheet(gs, 122, 26);

      for (let i = 0; i < 8; i++) {
        void assets.loadSheet("Fx", `Shop/ShopMain_C0${CHAR_MAIN_MAP[i]}`).then((s) => {
          this.charBanners[i] = s;
        });
        void assets.loadSheet("Fx", `Shop/BtShopMain_C0${CHAR_MAIN_MAP[i]}`).then((s) => {
          this.shopMainBtnSheets[i] = s;
          this.charTabs[i]?.bindSheet(s, 40, 40);
        });
      }
      // 9th Random Character tab `C10` (`CA.exe.c:153299..153345`: `Shop/ShopMain_C10` + `Shop/BtShopMain_C10` at `(460, 5)`)
      void assets.loadSheet("Fx", "Shop/ShopMain_C10").then((s) => {
        this.charBanners[8] = s;
      });
      void assets.loadSheet("Fx", "Shop/BtShopMain_C10").then((s) => {
        this.shopMainBtnSheets[8] = s;
        this.charTabs[8]?.bindSheet(s, 40, 40);
      });
      // `Shop/BtTab_Choice` (`74x21`), others `63x21`
      MAIN_TABS.forEach((mt, idx) => {
        void assets.loadSheet("Fx", mt.sprite).then((s) => this.mainTabs[idx]?.bindSheet(s, idx === 5 ? 74 : 63, 21));
        const subSpecs = SUB_TABS_BY_MAIN[idx] ?? [];
        const subBtns = this.subTabsByMain.get(idx) ?? [];
        subSpecs.forEach((sp, sIdx) => {
          void assets.loadSheet("Fx", sp.sprite).then((s) => subBtns[sIdx]?.bindSheet(s, 44, 19));
        });
      });
    }

    this.rebuildFilter();

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "shop_res") {
        this.applyCartPurchaseResult(msg.requestId, msg.ok);
        this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", [msg.message]));
      }
    });
  }

  leave(): void {
    this.unsub?.();
    this.unsub = null;
    // The cart remains intact if the response arrives after leaving the stage.
    this.pendingCartPurchase = null;
    this.popupMenu.close();
    this.miniKeys.clear();
    this.miniBombs.length = 0;
    this.miniFlames.length = 0;
  }

  private openSelectCharDialog(): void {
    const cur = CHAR_MAIN_MAP[this.previewChar] ?? 0;
    const applyPick = (picked: number) => {
      const tabIdx = (CHAR_MAIN_MAP as readonly number[]).indexOf(picked);
      if (tabIdx >= 0) {
        this.previewChar = tabIdx;
        this.charTabs.forEach((b, j) => (b.toggled = j === tabIdx));
      }
      if (this.ctx.hub.profile) this.ctx.hub.profile.selectedChar = picked;
      this.ctx.hub.send({ type: "select_char", charCode: picked });
      this.ctx.hub.send({ type: "room_set_char", charCode: picked });
      if (this.tabIdx === 2) {
        this.page = 0;
        this.rebuildFilter();
      }
    };
    this.ctx.dialogs.push(
      new SelectCharShopDlg(
        this.ctx.assets,
        cur,
        false,
        (picked) => {
          // Exact `CA.exe.c:50971` `CMaridNoticeDlg`: confirm when selecting `C06` (胖墩 / Luxury Marid)!
          if (picked === 6 && cur !== 6) {
            this.ctx.dialogs.push(new MaridNoticeDlg(this.ctx.assets, () => applyPick(picked)));
          } else {
            applyPick(picked);
          }
        },
        this.cache,
      ),
    );
  }

  private openItemInfoDialog(item: StockItem): void {
    const cur: "lucci" | "cash" = stockCurrency(item);
    this.ctx.dialogs.push(
      new ShopTextDlg(this.ctx.assets, item, this.cache, cur === "cash" && ((item.flags ?? 0) & 0x11) === 0 ? () => {
        this.ctx.dialogs.push(new ShopPresentDlg(this.ctx.assets, this.ctx.hub, item, cur));
      } : undefined),
    );
  }

  private openCardContextMenu(item: StockItem, mx: number, my: number): void {
    const owned = this.ctx.hub.inventory.find((inv) => inv.stockId === item.id);
    if (!owned) {
      const isPreviewing = this.previewItem?.id === item.id;
      this.popupMenu.openShopCard(mx, my, isPreviewing, {
        onShowDetail: () => this.openItemInfoDialog(item),
        onTogglePreview: () => {
          this.previewItem = isPreviewing ? null : item;
        },
      });
      return;
    }
    const canSell = item.buyableLucci && item.priceLucci > 0 && item.category !== 1 &&
      ((item.durationDays ?? 0) <= 0 || (item.durationDays ?? 0) > 8760);
    this.popupMenu.open(mx, my, owned, {
      onToggleEquip: (invId, eq) => this.ctx.hub.send({ type: "item_equip", invId, equip: eq }),
      onShowDetail: () => this.openItemInfoDialog(item),
      onSell: canSell ? (invId) => this.ctx.dialogs.push(new NoticeDlg(
        this.ctx.assets, "", [`確定販售「${item.name}」？`, `可獲得 ${Math.floor(item.priceLucci / 2).toLocaleString()} LUCCI。`],
        () => this.ctx.hub.send({ type: "inventory_sell", invId }), true,
      )) : undefined,
      onDelete: !canSell ? (invId) => this.ctx.dialogs.push(new NoticeDlg(
        this.ctx.assets, "", ["確定要刪除嗎？刪除不會回收點數或是 Lucci。"],
        () => this.ctx.hub.send({ type: "inventory_delete", invId }), true,
      )) : undefined,
    });
  }

  private openCartContextMenu(item: StockItem, cartIndex: number, mx: number, my: number): void {
    this.popupMenu.openCartSlot(mx, my, {
      onShowDetail: () => this.openItemInfoDialog(item),
      onDelete: () => {
        if (cartIndex >= 0 && cartIndex < this.cart.length) {
          this.cart.splice(cartIndex, 1);
          this.cartSelected.delete(item.id);
          this.cartQty.delete(item.id);
        }
      },
    });
  }

  private isCartTab(): boolean {
    return this.tabIdx === 5;
  }

  private maxPage(): number {
    if (this.isCartTab()) return Math.max(0, Math.ceil(this.cart.length / 5) - 1);
    return Math.max(0, Math.ceil(this.filtered.length / 9) - 1);
  }

  private rebuildFilter(): void {
    const all = this.ctx.assets.tables?.fxStock ?? [];
    const subSpec = SUB_TABS_BY_MAIN[this.tabIdx]?.[this.subTabIdx];
    const cats = subSpec?.cats ?? MAIN_TABS[this.tabIdx]?.cats ?? null;
    // sub_4DCD4E builds three independent special lists: New, Hot,
    // and flag 0x40. Excluded stock flags never enter the catalogue.
    let list = all.filter((it) => ((it.flags ?? 0) & (0x04 | 0x08 | 0x20)) === 0);
    if (subSpec?.filterMode === "special") {
      list = list.filter((it) => ((it.flags ?? 0) & 0x40) !== 0);
    } else if (subSpec?.filterMode === "new") {
      list = list.filter((it) => it.isNew && ((it.flags ?? 0) & 0x40) === 0);
    } else if (subSpec?.filterMode === "hot") {
      list = list.filter((it) => it.isHot && ((it.flags ?? 0) & 0x40) === 0);
    } else if (this.tabIdx >= 1 && this.tabIdx <= 4) {
      list = list.filter((it) => {
        const group = retailShopCategory(it.category, it.flags);
        if (group.main !== this.tabIdx) return false;
        if (group.sub !== null) return group.sub === this.subTabIdx;
        // Categories 10, 12 and 19 depend on server-supplied UserItem +52,
        // unavailable in the local stock table. Keep the existing approximate
        // sub-tab fallback until that data can be supplied.
        return cats?.includes(it.category) ?? false;
      });
    }
    // Character eligibility is determined by the user-item table and package
    // children (sub_4E0144), not the stock's description string ID.
    if (this.currencyFilter === "lucci") {
      list = list.filter((it) => (it.currencyType ?? (it.buyableLucci ? 1 : 0)) === 1);
    } else if (this.currencyFilter === "cash") {
      list = list.filter((it) => (it.currencyType ?? (it.buyableLucci ? 1 : 0)) === 0);
    }
    // sub_4DBBA7 / sub_4D6540 sorts each catalogue by signed +196.
    list.sort((a, b) => a.sortOrder - b.sortOrder);
    this.filtered = list;
    this.scroll.setRange(this.maxPage(), false);
  }

  private applyCartPurchaseResult(requestId: string | undefined, ok: boolean): void {
    const pending = this.pendingCartPurchase;
    if (!pending || requestId !== pending.requestId) return;
    this.pendingCartPurchase = null;
    if (!ok) return;
    for (const bought of pending.items) {
      const idx = this.cart.findIndex(it => it.id === bought.stockId);
      if (idx < 0) continue;
      const remaining = (this.cartQty.get(bought.stockId) ?? 1) - bought.qty;
      if (remaining > 0) this.cartQty.set(bought.stockId, remaining);
      else {
        this.cart.splice(idx, 1);
        this.cartQty.delete(bought.stockId);
        this.cartSelected.delete(bought.stockId);
      }
    }
  }

  private buyCartItems(items: readonly StockItem[]): void {
    if (!items.length || this.pendingCartPurchase) return;
    if (!this.ctx.hub.connected) {
      this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", ["尚未連線，收藏清單未結帳。"]));
      return;
    }
    if (items.length > 25) {
      this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", ["一次最多購買 25 種商品，請分批結帳。"]));
      return;
    }
    const batch = items.map(it => ({
      stockId: it.id,
      currency: stockCurrency(it),
      qty: this.cartQty.get(it.id) ?? 1,
    }));
    const requestId = crypto.randomUUID();
    this.pendingCartPurchase = { requestId, startedMs: performance.now(), items: batch.map(({stockId, qty}) => ({ stockId, qty })) };
    this.ctx.hub.send({ type: "shop_buy_batch", requestId, items: batch });
  }

  private addOrToggleCartItem(item: StockItem, toggleOffIfPresent = false): void {
    const existingIdx = this.cart.findIndex((c) => c.id === item.id);
    if (existingIdx >= 0) {
      if (toggleOffIfPresent) {
        this.cart.splice(existingIdx, 1);
        this.cartSelected.delete(item.id);
        this.cartQty.delete(item.id);
      } else {
        this.cartQty.set(item.id, Math.min(99, (this.cartQty.get(item.id) ?? 1) + 1));
        this.cartSelected.add(item.id);
      }
      return;
    }
    this.cart.push(item);
    this.cartSelected.add(item.id);
    this.cartQty.set(item.id, 1);
  }

  private openBuyPopup(item: StockItem, preferredCurrency?: "lucci" | "cash"): void {
    if (((item.flags ?? 0) & 0x10) !== 0) return;
    const cur: "lucci" | "cash" =
      preferredCurrency ?? stockCurrency(item);
    this.ctx.dialogs.push(
      new ShopBuyDlg(
        this.ctx.assets,
        this.ctx.hub,
        item,
        cur,
        () => {
          this.ctx.dialogs.push(new ShopPresentDlg(this.ctx.assets, this.ctx.hub, item, cur));
        },
        () => {
          this.addOrToggleCartItem(item, false);
        },
      ),
    );
  }

  private activeButtons(): SpriteButton[] {
    const base = [
      ...this.charTabs,
      ...this.mainTabs,
      this.btLeft,
      this.btRight,
      this.btReset,
      this.btHide,
      this.btCharge,
      this.btGachapon,
    ];
    if (this.isCartTab()) {
      base.push(this.btCartSelBuy, this.btCartBuyAll, this.btCartDelAll, this.btCartGoShop);
    } else {
      base.push(...(this.subTabsByMain.get(this.tabIdx) ?? []), this.btTabCash, this.btTabLucci);
      if (this.tabIdx === 0) base.push(this.btMyCoupon);
    }
    return base;
  }

  tick(dtSec: number, nowMs: number): void {
    if (this.pendingCartPurchase && (!this.ctx.hub.connected || nowMs - this.pendingCartPurchase.startedMs > 15000)) {
      this.pendingCartPurchase = null;
      this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", ["無法確認結帳結果，請先檢查背包與餘額，再決定是否重試。"]));
    }
    if (this.miniKeys.size > 0 && !imeHost.hasActiveFocus()) {
      let vx = 0;
      let vy = 0;
      if (this.miniKeys.has("ArrowLeft")) {
        vx -= 1;
        this.miniDir = 0;
      }
      if (this.miniKeys.has("ArrowRight")) {
        vx += 1;
        this.miniDir = 2;
      }
      if (this.miniKeys.has("ArrowUp")) {
        vy -= 1;
        this.miniDir = 1;
      }
      if (this.miniKeys.has("ArrowDown")) {
        vy += 1;
        this.miniDir = 3;
      }
      const speed = 112 * dtSec;
      this.miniX = Math.max(-92, Math.min(92, this.miniX + vx * speed));
      this.miniY = Math.max(-52, Math.min(18, this.miniY + vy * speed));
    }

    for (let i = this.miniBombs.length - 1; i >= 0; i--) {
      const mb = this.miniBombs[i]!;
      if (nowMs - mb.placedMs >= 2000) {
        this.miniBombs.splice(i, 1);
        this.miniFlames.push({ x: mb.x, y: mb.y, explodeMs: nowMs });
        this.ctx.sound.playSfx("BombPop", 0.72);
      }
    }
    for (let i = this.miniFlames.length - 1; i >= 0; i--) {
      if (nowMs - this.miniFlames[i]!.explodeMs >= 450) {
        this.miniFlames.splice(i, 1);
      }
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (imeHost.hasActiveFocus()) return;
    if (
      e.code === "ArrowLeft" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowRight" ||
      e.code === "ArrowDown"
    ) {
      e.preventDefault();
      this.miniKeys.add(e.code);
      if (e.code === "ArrowLeft") this.miniDir = 0;
      else if (e.code === "ArrowUp") this.miniDir = 1;
      else if (e.code === "ArrowRight") this.miniDir = 2;
      else if (e.code === "ArrowDown") this.miniDir = 3;
      return;
    }
    if (e.code === "Space" && !e.repeat) {
      e.preventDefault();
      if (this.miniBombs.length < 4) {
        const p = this.ctx.hub.profile;
        const bombStockId = this.hideDeco ? 0 : (this.previewItem?.id || p?.equipped.bombStockId || 0);
        const bx = Math.round(634 + this.miniX);
        const by = Math.round(164 + this.miniY);
        this.miniBombs.push({
          x: bx,
          y: by,
          placedMs: performance.now(),
          stockId: bombStockId,
        });
        this.ctx.sound.playSfx("BombSet", 0.65);
      }
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    this.miniKeys.delete(e.code);
  }

  onMouseMove(mx: number, my: number): void {
    if (this.popupMenu.active) {
      this.popupMenu.onMouseMove(mx, my, this.ctx.sound);
      return;
    }
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    for (const b of this.activeButtons()) b.onMouseMove(mx, my, this.ctx.sound);
    this.hoveredCharTab = -1;
    for (let i = 0; i < 9; i++) {
      if (pointInRect(mx, my, { x: 116 + i * 43, y: 5, w: 40, h: 40 })) {
        this.hoveredCharTab = i;
        break;
      }
    }
    if (this.isCartTab()) {
      for (let i = 0; i < 5; i++) {
        if (this.cart[this.page * 5 + i]) this.cartChecks[i]?.onMouseMove(mx, my);
      }
    }
    this.scroll.onMouseMove(mx, my);

    this.hoveredCard = -1;
    this.hoveredBuyBtn = -1;
    this.hoveredBagBtn = -1;
    if (!this.isCartTab()) {
      for (let i = 0; i < 9; i++) {
        if (!this.filtered[this.page * 9 + i]) break;
        const [cx, cy] = ITEM_GRID_3X3[i]!;
        if (pointInRect(mx, my, { x: cx, y: cy, w: SHOP_CARD.width, h: SHOP_CARD.height })) {
          this.hoveredCard = i;
          if (pointInRect(mx, my, { x: cx + SHOP_CARD.buyX, y: cy + SHOP_CARD.buyY, w: SHOP_CARD.buyWidth, h: SHOP_CARD.buyHeight })) {
            this.hoveredBuyBtn = i;
          } else if (pointInRect(mx, my, { x: cx + SHOP_CARD.choiceX, y: cy + SHOP_CARD.choiceY, w: SHOP_CARD.choiceWidth, h: SHOP_CARD.choiceHeight })) {
            this.hoveredBagBtn = i;
          }
          break;
        }
      }
    }
  }

  onMouseDown(mx: number, my: number, button = 0): void {
    // Keep the submitted cart snapshot unchanged until its response arrives.
    if (this.pendingCartPurchase) return;
    if (this.popupMenu.active) {
      if (button === 0) this.popupMenu.onMouseDown(mx, my);
      else if (button === 2) this.popupMenu.close();
      return;
    }
    if (button === 2) {
      // Right-click on top character portraits opens `SelectCharShopDlg` (`Shop/popup_Notice`)
      for (let i = 0; i < 8; i++) {
        if (pointInRect(mx, my, { x: 116 + i * 43, y: 5, w: 40, h: 40 })) {
          this.ctx.sound.playSfx("ButtonDown_0", 0.5);
          this.openSelectCharDialog();
          return;
        }
      }
      if (this.isCartTab()) {
        for (let i = 0; i < 5; i++) {
          const cartIdx = this.page * 5 + i;
          const it = this.cart[cartIdx];
          if (!it) break;
          const [rx, ry] = CART_ROWS_5[i]!;
          if (pointInRect(mx, my, { x: rx, y: ry, w: 410, h: 67 })) {
            this.previewItem = it;
            this.ctx.sound.playSfx("ButtonDown_0", 0.5);
            this.openCartContextMenu(it, cartIdx, mx, my);
            return;
          }
        }
      } else {
        for (let i = 0; i < 9; i++) {
          const it = this.filtered[this.page * 9 + i];
          if (!it) break;
          const [cx, cy] = ITEM_GRID_3X3[i]!;
          if (pointInRect(mx, my, { x: cx, y: cy, w: SHOP_CARD.width, h: SHOP_CARD.height })) {
            this.previewItem = it;
            this.ctx.sound.playSfx("ButtonDown_0", 0.5);
            this.openCardContextMenu(it, mx, my);
            return;
          }
        }
      }
      return;
    }

    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    for (const b of this.activeButtons()) {
      if (b.onMouseDown(mx, my)) return;
    }
    if (this.scroll.onMouseDown(mx, my)) return;

    // Right preview click cycles character (`CA.exe` `0x616EB8`: `(502, 64, 264, 128)`)
    if (pointInRect(mx, my, { x: 502, y: 64, w: 264, h: 128 })) {
      this.previewChar = (this.previewChar + 1) % 8;
      this.charTabs.forEach((b, j) => (b.toggled = j === this.previewChar));
      const charCode = CHAR_MAIN_MAP[this.previewChar] ?? 0;
      if (this.ctx.hub.profile) this.ctx.hub.profile.selectedChar = charCode;
      this.ctx.hub.send({ type: "select_char", charCode });
      this.ctx.hub.send({ type: "room_set_char", charCode });
      this.ctx.sound.playSfx("ButtonDown_0", 0.5);
      return;
    }

    if (this.isCartTab()) {
      for (let i = 0; i < 5; i++) {
        const idx = this.page * 5 + i;
        const it = this.cart[idx];
        if (!it) break;
        const [rx, ry] = CART_ROWS_5[i]!;
        const cb = this.cartChecks[i];
        if (cb) {
          cb.checked = this.cartSelected.has(it.id);
          if (cb.onMouseDown(mx, my)) return;
        }
        // `Shop/BtShop_+` (`18x9` at `(rx + 228, ry + 36)`) & `Shop/BtShop_-` (`18x9` at `(rx + 228, ry + 45)`)
        if (pointInRect(mx, my, { x: rx + 226, y: ry + 34, w: 22, h: 11 })) {
          this.cartQty.set(it.id, Math.min(99, (this.cartQty.get(it.id) ?? 1) + 1));
          this.ctx.sound.playSfx("ButtonDown_0", 0.5);
          return;
        }
        if (pointInRect(mx, my, { x: rx + 226, y: ry + 45, w: 22, h: 11 })) {
          this.cartQty.set(it.id, Math.max(1, (this.cartQty.get(it.id) ?? 1) - 1));
          this.ctx.sound.playSfx("ButtonDown_0", 0.5);
          return;
        }
        // Per-row `BtBuy_Cash` / `BtBuy_Lucci` (`35x20` at `(rx + 335, ry + 34)`)
        if (pointInRect(mx, my, { x: rx + 335, y: ry + 34, w: 35, h: 20 })) {
          this.buyCartItems([it]);
          this.ctx.sound.playSfx("ButtonDown_0", 0.6);
          return;
        }
        // Per-row `Shop/BtShop_Delete` (`35x20` at `(rx + 371, ry + 34)`)
        if (pointInRect(mx, my, { x: rx + 371, y: ry + 34, w: 35, h: 20 })) {
          this.cart.splice(idx, 1);
          this.cartSelected.delete(it.id);
          this.cartQty.delete(it.id);
          this.ctx.sound.playSfx("ButtonDown_0", 0.55);
          return;
        }
        if (pointInRect(mx, my, { x: rx + 24, y: ry, w: 308, h: 67 })) {
          this.previewItem = it;
          this.ctx.sound.playSfx("ButtonDown_0", 0.5);
          return;
        }
      }
    } else {
      for (let i = 0; i < 9; i++) {
        const it = this.filtered[this.page * 9 + i];
        if (!it) break;
        const [cx, cy] = ITEM_GRID_3X3[i]!;
        if (pointInRect(mx, my, { x: cx, y: cy, w: SHOP_CARD.width, h: SHOP_CARD.height })) {
          this.ctx.sound.playSfx("ButtonDown_0", 0.6);
          // `Shop/BtChoice` (`26x20` at `(cx + 111, cy + 57)`) toggles item in Wishlist!
          if (pointInRect(mx, my, { x: cx + SHOP_CARD.choiceX, y: cy + SHOP_CARD.choiceY, w: SHOP_CARD.choiceWidth, h: SHOP_CARD.choiceHeight })) {
            this.addOrToggleCartItem(it, true);
            this.previewItem = it;
            return;
          }
          const soldOut = ((it.flags ?? 0) & 0x10) !== 0;
          if (!soldOut && (this.previewItem?.id === it.id || pointInRect(mx, my, { x: cx + SHOP_CARD.buyX, y: cy + SHOP_CARD.buyY, w: SHOP_CARD.buyWidth, h: SHOP_CARD.buyHeight }))) {
            const cur = stockCurrency(it);
            this.openBuyPopup(it, cur);
          } else {
            this.previewItem = it;
            const cos = this.ctx.assets.tables?.cosmetics;
            if (cos) {
              for (const v of cos.expandVisuals(it.id)) {
                if (v.liveKind === "fanfare" && v.skinIndex !== undefined) {
                  const pad = String(v.skinIndex).padStart(3, "0");
                  this.ctx.sound.playSfx(`Wave/Fanfare${pad}`, 0.85, "EmoTE");
                  break;
                }
              }
            }
          }
          return;
        }
      }
    }
  }

  onMouseUp(mx: number, my: number, button = 0): void {
    if (button !== 0) return;
    if (this.popupMenu.active) {
      this.popupMenu.onMouseUp(mx, my, this.ctx.sound);
      return;
    }
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    if (this.isCartTab()) {
      for (let i = 0; i < 5; i++) {
        if (this.cart[this.page * 5 + i] && this.cartChecks[i]?.onMouseUp(mx, my, this.ctx.sound)) {
          return;
        }
      }
    }
    for (const b of this.activeButtons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
    this.scroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onWheel(deltaY: number): void {
    const maxP = this.maxPage();
    this.page = Math.max(0, Math.min(maxP, this.page + (deltaY > 0 ? 1 : -1)));
    this.scroll.value = this.page;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    const bg = this.isCartTab() && this.bgCart ? this.bgCart : this.bg;
    drawSheetFrame(r, bg, 0, 0, 0, { w: 800, h: 600 });
    if (this.charBanners[this.previewChar]) {
      drawSheetFrame(r, this.charBanners[this.previewChar], 0, 0, 0);
    }

    const maxP = this.maxPage();
    if (this.page > maxP) this.page = maxP;
    this.btLeft.enabled = this.page > 0;
    this.btRight.enabled = this.page < maxP;
    this.scroll.setRange(maxP, false);
    this.scroll.value = this.page;

    const tick = Math.floor(nowMs / 30);

    if (this.isCartTab()) {
      // Exact `CA.exe.c:155300..155390` & `156360..156455` 5-Row Wishlist (`dword_616C80`)
      if (this.cart.length === 0) {
        r.drawText("收藏清單尚無商品（可點擊商品卡右下角收藏圖示加入）", 232, 297, {
          align: "center",
          color: [0.16, 0.28, 0.44, 1],
        });
      }
      let totalCash = 0;
      let totalLucci = 0;
      for (const ci of this.cart) {
        if (!this.cartSelected.has(ci.id)) continue;
        const q = this.cartQty.get(ci.id) ?? 1;
        if (ci.priceLucci > 0) totalLucci += ci.priceLucci * q;
        else totalCash += ci.priceCash * q;
      }

      for (let i = 0; i < 5; i++) {
        const it = this.cart[this.page * 5 + i];
        if (!it) break;
        const [rx, ry] = CART_ROWS_5[i]!;
        const qty = this.cartQty.get(it.id) ?? 1;
        const isLucci = stockCurrency(it) === "lucci";
        const unitPrice = isLucci ? it.priceLucci : it.priceCash;
        const isSel = this.previewItem?.id === it.id;

        drawSheetFrame(r, this.zzimRowSheet, 0, rx, ry);
        const cb = this.cartChecks[i];
        if (cb) {
          cb.checked = this.cartSelected.has(it.id);
          cb.render(r);
        }
        drawSheetFrame(r, this.zzimSlotSheet, isSel ? 1 : 0, rx + 25, ry + 3);
        this.cache.drawStockIconAnchored(r, this.ctx.assets, it, rx + 39, ry + 66);
        r.drawText(it.name.slice(0, 14), rx + 103, ry + 17, { color: [0.06, 0.14, 0.28, 1] });
        drawSheetFrame(
          r,
          isLucci ? this.zzimLucciSheet : this.zzimCashSheet,
          0,
          rx + 102,
          ry + 38,
        );
        r.drawText(unitPrice.toLocaleString(), rx + 143, ry + 40, {
          color: isLucci ? [0.08, 0.40, 0.20, 1] : [0.72, 0.20, 0.08, 1],
        });
        r.drawText(`${qty}`, rx + 216, ry + 40, {
          color: [0.06, 0.14, 0.28, 1],
        });
        drawSheetFrame(r, this.btShopPlusSheet, 0, rx + 228, ry + 36);
        drawSheetFrame(r, this.btShopMinusSheet, 0, rx + 228, ry + 45);
        r.drawText((unitPrice * qty).toLocaleString(), rx + 283, ry + 40, {
          color: [0.72, 0.20, 0.08, 1],
        });
        drawSheetFrame(
          r,
          isLucci ? this.btBuyLucciSheet : this.btBuyCashSheet,
          0,
          rx + 335,
          ry + 34,
        );
        drawSheetFrame(r, this.btShopDelSheet, 0, rx + 371, ry + 34);
      }

      // Exact `CA.exe.c:155375..155388` Wishlist totals at `(171, 495)` (Cash) & `(280, 495)` (Lucci)
      r.drawText(`${totalCash.toLocaleString()}`, 171, 495, {
        color: [0.72, 0.20, 0.08, 1],
      });
      r.drawText(`${totalLucci.toLocaleString()}`, 280, 495, {
        color: [0.08, 0.40, 0.20, 1],
      });
    } else {
      // 3x3 Retail `Shop/BtItemSlot` (`148x117`) cards at `0x616DB0`
      const invList = this.ctx.hub.inventory;
      const coupons = this.ctx.hub.coupons;
      let hoveredOwnedInfo: { cx: number; cy: number; item: StockItem; qty: number; remainingHours?: number } | null = null;

      // Exact `CA.exe.c:153869..153870`: `Shop/Ready` (`448x353`) at `(16, 140)` when sub-tab has 0 items!
      if (this.filtered.length === 0 && this.shopReadySheet) {
        drawSheetFrame(r, this.shopReadySheet, 0, 16, 140);
      }

      for (let i = 0; i < 9; i++) {
        const it = this.filtered[this.page * 9 + i];
        if (!it) break;
        const [cx, cy] = ITEM_GRID_3X3[i]!;
        const sel = this.previewItem?.id === it.id;
        const frame = sel ? 1 : this.hoveredCard === i ? 2 : 0;
        drawSheetFrame(r, this.slotSheet, frame, cx, cy);

        this.cache.drawStockIconAnchored(r, this.ctx.assets, it, cx + SHOP_CARD.iconX, cy + SHOP_CARD.iconY);
        // sub_4AAFC0 enables the New/Hot and flag-1 glyphs independently;
        // IcoFree is NOT determined by a zero price (151300 / 153812).
        const flg = it.flags ?? 0;
        if (it.isNew) drawSheetFrame(r, this.icoNew, Math.floor(nowMs / 300) % 2, cx, cy);
        else if (it.isHot) drawSheetFrame(r, this.icoHot, Math.floor(nowMs / 200) % 6, cx, cy);
        if (flg & 1) drawSheetFrame(r, this.icoFreeSheet, Math.floor(nowMs / 180) % 8, cx + 100, cy + 37);

        // Exact `CA.exe.c:153768..153808` card badges:
        if ((flg & 0x10) === 0 && (flg & 0x02) !== 0 && this.icoLimitSheet) {
          drawSheetFrame(r, this.icoLimitSheet, 0, cx + 21, cy + 90, { anchor: true });
        } else if ((flg & 0x10) === 0 && (flg & 0x80) !== 0 && this.icoImpEndSheet) {
          drawSheetFrame(r, this.icoImpEndSheet, 0, cx + 21, cy + 90, { anchor: true });
        }
        if ((it.durationDays ?? 0) > 0 && this.icoTimeSheet) {
          drawSheetFrame(r, this.icoTimeSheet, 0, cx + 26, cy + 97, { anchor: true });
        }
        if ((flg & 0x10) !== 0 && this.itemSoldOutSheet) {
          drawSheetFrame(r, this.itemSoldOutSheet, 0, cx + 21, cy + 73, { anchor: true });
        }

        // `CA.exe.c:152896`: `ShopImg` frame 40 Already-Owned badge at `(cx + 111, cy)` + `IconCoupon` at `(cx + 99, cy + 35)`
        const ownedEntry = invList.find((inv) => inv.stockId === it.id);
        if (ownedEntry && this.shopImgSheet) {
          drawSheetFrame(r, this.shopImgSheet, 40, cx + 111, cy);
          if (this.hoveredCard === i) {
            hoveredOwnedInfo = { cx, cy, item: it, qty: ownedEntry.quantity, remainingHours: ownedEntry.remainingHours };
          }
        }
        if (
          this.icoCouponSheet &&
          coupons.some((c) => c.stockId === 0 || c.stockId === it.id)
        ) {
          drawSheetFrame(r, this.icoCouponSheet, Math.floor(nowMs / 360) % 2, cx + 99, cy + 35);
        }

        // Retail slot text and controls: name and price below the icon,
        // purchase button beside it (CShopSlotWnd::sub_4AC0E4 / sub_4AD...).
        r.drawText(it.name, cx + SHOP_CARD.nameX, cy + SHOP_CARD.nameY, {
          color: [0, 0.36, 0.64, 1], maxWidth: 128,
        });
        const currency = stockCurrency(it);
        const price = currency === "lucci" ? it.priceLucci : it.priceCash;
        r.drawText(currency === "lucci" ? "Lucci" : "Cash", cx + SHOP_CARD.priceLabelX, cy + SHOP_CARD.priceY, {
          color: [0, 0.36, 0.64, 1],
        });
        r.drawText(retailPriceText(price, it.secondaryPrice), cx + SHOP_CARD.priceValueX, cy + SHOP_CARD.priceY, {
          color: [0, 0.36, 0.64, 1], maxWidth: 88,
        });
        const buyFrame = (flg & 0x10) !== 0 ? 2 : this.hoveredBuyBtn === i ? 3 : 0;
        drawSheetFrame(r, currency === "lucci" ? this.btBuyLucciSheet : this.btBuyCashSheet, buyFrame, cx + SHOP_CARD.buyX, cy + SHOP_CARD.buyY);
        // Exact `CA.exe.c:152065` `Shop/BtChoice` (`26x20`, 5 frames) one-click Wishlist toggle on every card!
        const inWishlist = this.cart.some((c) => c.id === it.id);
        const choiceFrame = inWishlist ? 1 : this.hoveredBagBtn === i ? 3 : 0;
        drawSheetFrame(r, this.btChoiceSheet, choiceFrame, cx + SHOP_CARD.choiceX, cy + SHOP_CARD.choiceY);
      }

      // sub_4ACF75 anchors the 117px tooltip above the hovered card and
      // uses the localized title, quantity and period from csysstr.ssd.
      if (hoveredOwnedInfo) {
        const { cx, cy, item, qty, remainingHours } = hoveredOwnedInfo;
        const { title, detail } = retailOwnedTooltip(item.category, qty, remainingHours, this.ctx.assets.tables?.sysStrings);
        const centerX = cx + Math.floor(SHOP_CARD.width / 2) + 1;
        drawSheetFrame(r, detail === null ? this.timeTable01Sheet : this.timeTable02Sheet,
          0, centerX - 58, cy, { anchor: true, tint: [1, 1, 1, 200 / 255] });
        r.drawText(title, centerX, cy - (detail === null ? 20 : 35), {
          align: "center", color: [1, 1, 1, 1],
        });
        if (detail !== null) r.drawText(detail, centerX, cy - 21, {
          align: "center", color: [1, 1, 1, 1],
        });
      }
    }

    // Page indicator `(238, 503)` between `BtLeft (154, 499)` & `BtRight (283, 499)`
    r.drawText(`${this.page + 1} / ${maxP + 1}`, 238, 503, {
      align: "center",
      color: [0.06, 0.14, 0.28, 1],
    });

    // Right Avatar Preview (`CGameSlotForShop` `0x616EB8`: `(502, 64, 264, 128)`)
    const p = this.ctx.hub.profile;
    let previewCode = this.previewChar === 8 ? Math.floor(tick / 45) % 8 : (CHAR_MAIN_MAP[this.previewChar] ?? 0);
    const activePreviewStocks: number[] = [];
    const cos = this.ctx.assets.tables?.cosmetics;
    const previewVisuals = this.previewItem && cos ? cos.expandVisuals(this.previewItem.id) : [];
    if (previewVisuals.some((v) => v.liveKind === "avatarDeco")) {
      previewCode = 6; // `cat 19` (`A06_*`) equips onto `C06`
    }
    if (!this.hideDeco) {
      if (p?.equipped.slotDecoStockIds && p.equipped.slotDecoStockIds.length > 0) {
        activePreviewStocks.push(...p.equipped.slotDecoStockIds);
      } else if (p?.equipped.slotDecoStockId) {
        activePreviewStocks.push(p.equipped.slotDecoStockId);
      }
      if (p?.equipped.fanfareStockId) activePreviewStocks.push(p.equipped.fanfareStockId);
      if (p?.equipped.charDecoStockIds && p.equipped.charDecoStockIds.length > 0) {
        activePreviewStocks.push(...p.equipped.charDecoStockIds);
      } else if (p?.equipped.hatStockId) {
        activePreviewStocks.push(p.equipped.hatStockId);
      }
      if (p?.equipped.idDecoStockId) activePreviewStocks.push(p.equipped.idDecoStockId);
      if (this.previewItem) activePreviewStocks.push(this.previewItem.id);
    }
    const slotX = 585;
    const slotY = 76;
    const hasSlotBg =
      !this.hideDeco &&
      this.cache.drawSlotCosmeticsForStocks(
        r,
        this.ctx.assets,
        activePreviewStocks,
        "back",
        slotX,
        slotY,
        tick,
      );
    if (!this.hideDeco) {
      this.cache.drawSlotCosmeticsForStocks(
        r,
        this.ctx.assets,
        activePreviewStocks,
        "idDeco",
        slotX,
        slotY,
        tick,
      );
    }
    const bomberCx = Math.round((hasSlotBg ? slotX + 32 : 634) + this.miniX);
    const bomberFy = Math.round((hasSlotBg ? slotY + 94 : 164) + this.miniY);
    const miniMoving = this.miniKeys.size > 0 && !imeHost.hasActiveFocus();

    // `CMiniMapWndForShop` (`CA.exe.c:127890..128199`): live preview flames & water balloons inside `(502, 64, 264, 128)`!
    if (this.miniFlames.length > 0) {
      const fireSh = this.cache.getSheet(this.ctx.assets, "Fx", "Bomb/Fire", 0);
      const fireObj = this.ctx.assets.objects.byName.get("Bomb/Fire");
      if (fireSh && fireSh.sheet && fireSh.sheet.rects.length > 0) {
        const fArms: readonly [number, number, string][] = [
          [0, 0, "00 Center"],
          [-36, 0, "01 LeftEnd"],
          [0, -34, "03 UpEnd"],
          [36, 0, "02 RightEnd"],
          [0, 34, "04 DownEnd"],
        ];
        for (const mf of this.miniFlames) {
          const ft = Math.max(0, Math.floor((nowMs - mf.explodeMs) / 30));
          for (const [ox, oy, actName] of fArms) {
            const fx = mf.x + ox;
            const fy = mf.y + oy;
            if (fx < 516 || fx > 752 || fy < 84 || fy > 186) continue;
            const fAct = fireObj?.actions.get(actName) ?? fireObj?.defaultAction;
            const ff = fAct ? sampleActionFrame(fAct, ft, false) : ft % fireSh.sheet.rects.length;
            drawSheetFrame(r, fireSh, ff, fx, fy - 19, { anchor: true });
          }
        }
      }
    }
    for (const mb of this.miniBombs) {
      const bt = Math.max(0, Math.floor((nowMs - mb.placedMs) / 30));
      const drewSkin =
        mb.stockId > 0 &&
        this.cache.drawBombSkinForStock(r, this.ctx.assets, mb.stockId, mb.x, mb.y, bt);
      if (!drewSkin) {
        const defBomb = this.cache.getSheet(this.ctx.assets, "Fx", "Bomb/Bomb", 0);
        if (defBomb && defBomb.sheet && defBomb.sheet.rects.length > 0) {
          drawSheetFrame(r, defBomb, Math.floor(bt / 5) % Math.min(4, defBomb.sheet.rects.length), mb.x, mb.y, {
            anchor: true,
          });
        }
      }
    }

    // Ground effect and equipped/previewed MotionBlur trail.
    if (
      !this.hideDeco &&
      this.cache.hasExtensionShadow(this.ctx.assets, previewCode, activePreviewStocks)
    ) {
      this.cache.drawExtensionShadow(r, this.ctx.assets, bomberCx, bomberFy, tick, 128 / 255);
    }
    const motionEnabled = !this.hideDeco && activePreviewStocks.some(id =>
      id === 1207 || cos?.expandVisuals(id).some(v => v.stockId === 1207));
    const echoes = this.miniMotionTrail.update(tick, bomberCx - 20, bomberFy, !!motionEnabled && miniMoving);
    if (echoes.length) {
      const code = `C${String(Math.max(0, previewCode)).padStart(2, "0")}`;
      const walkNames = ["20 Walk Left", "21 Walk Up", "22 Walk Right", "23 Walk Down"];
      const action = this.ctx.assets.objects.byName.get(`Character/${code}_A`)?.actions.get(walkNames[this.miniDir]!);
      if (action) {
        const sh = this.cache.getSheet(this.ctx.assets, "Fx", action.sprite, 1);
        const frame = sampleActionFrame(action, tick, true);
        for (const echo of echoes) drawSheetFrame(r, sh, frame, echo.x, echo.y, { anchor: true, tint: [1, 1, 1, echo.alpha] });
      }
    }

    const useWalk = miniMoving || this.miniX !== 0 || this.miniY !== 0;
    const emoPreview = !useWalk && !this.hideDeco && this.previewItem
      ? { stockId: this.previewItem.id }
      : undefined;
    this.cache.drawDisplayBomber(
      r,
      this.ctx.assets,
      previewCode,
      1,
      bomberCx,
      bomberFy,
      tick,
      false,
      this.hideDeco ? undefined : activePreviewStocks,
      emoPreview,
      useWalk ? { dir: this.miniDir, moving: miniMoving } : undefined,
    );
    if (!this.hideDeco) {
      // `CGOFanfareActor` (`EmoTE:Fanfare/Fanfare000..006`) live celebration preview when a Fanfare item is selected!
      if (previewVisuals.some((v) => v.liveKind === "fanfare") && this.previewItem) {
        this.cache.drawFanfareForStocks(
          r,
          this.ctx.assets,
          [this.previewItem.id],
          bomberCx,
          bomberFy,
          tick,
        );
      }
      this.cache.drawSlotCosmeticsForStocks(
        r,
        this.ctx.assets,
        activePreviewStocks,
        "front",
        slotX,
        slotY,
        tick,
      );
      const bombPreviewId = this.previewItem?.id || p?.equipped.bombStockId || 0;
      if (bombPreviewId) {
        this.cache.drawBombSkinForStock(r, this.ctx.assets, bombPreviewId, 524, 164, tick);
      }
      const lvEffectVis = previewVisuals.find((v) => v.liveKind === "levelEffect");
      const lvDisguiseVis = previewVisuals.find((v) => v.liveKind === "levelDisguise");
      const effIdx = lvEffectVis?.skinIndex ?? p?.equipped.levelEffectIdx;
      const effDelta = lvDisguiseVis?.skinIndex ?? p?.equipped.levelDisguiseDelta ?? 0;
      if (lvEffectVis || lvDisguiseVis || effIdx !== undefined) {
        const lvSheet = this.cache.getSheet(this.ctx.assets, "Cx", "Etc/LevelIcons", 0);
        const dispLv = Math.max(1, Math.min(450, (p?.level ?? 25) + effDelta));
        drawLevelIcon(
          r,
          lvSheet,
          dispLv,
          524,
          82,
          this.cache.getTwinkleSheet(this.ctx.assets, effIdx),
          tick,
          this.cache.getRotateSheet(this.ctx.assets, effIdx),
        );
      }
    }
    // Right-side Selected Item Detail Panel (`sub_4B0AA8`: `Shop/SlotImg` `(491, 244)` + `(651, 276/299/326)` + desc `(508, 355, 270, 56)`)
    if (this.slotImgSheet) {
      drawSheetFrame(r, this.slotImgSheet, 0, 491, 244);
    }
    if (this.previewItem) {
      this.cache.drawStockIcon(r, this.ctx.assets, this.previewItem, 540, 293, 56, 52);
      r.drawText(this.previewItem.name.slice(0, 11), 651, 276, {
        color: [0.06, 0.14, 0.28, 1],
      });
      const durDays = this.previewItem.durationDays ?? 0;
      const durLabel =
        durDays > 0
          ? `${durDays} 日使用`
          : this.previewItem.quantity > 1
            ? `${this.previewItem.quantity} 個裝`
            : "期限未標示";
      r.drawText(durLabel, 651, 299, {
        color: [0.16, 0.28, 0.44, 1],
      });
      const prText =
        stockCurrency(this.previewItem) === "lucci"
          ? `${this.previewItem.priceLucci.toLocaleString()} Lucci`
          : `${this.previewItem.priceCash.toLocaleString()} 點`;
      r.drawText(prText, 651, 326, {
        color: [0.72, 0.20, 0.08, 1],
      });
      // sub_4ADBxx looks up ShopItem +52 and treats '*' as a line break.
      const description = this.ctx.assets.tables?.stringTable.get(this.previewItem.descriptionId) ?? "";
      const lines = description.replaceAll("*", "\n").split("\n").map(line => line.trim()).filter(Boolean);
      const visible = lines.flatMap(line => line.match(/.{1,20}/gu) ?? []).slice(0, 2);
      visible.forEach((line, index) => r.drawText(line, 508, 355 + index * 18, {
        color: [0.16, 0.28, 0.44, 1],
      }));
    }

    // Player Lucci & Cash balances (`CA.exe.c:158926`: Lucci `(598, 447, b=25, s=10, d=14)` & Cash `(600, 479, b=14, s=16, d=9)`)
    if (p) {
      if (this.shopImgSheet) {
        drawSpriteNumber(r, this.shopImgSheet, 598, 447, 10, 14, p.lucci, true, 25, true, 3);
        drawSpriteNumber(r, this.shopImgSheet, 600, 479, 16, 9, p.cash, true, 14, true, 3);
      } else {
        r.drawText(`${p.lucci.toLocaleString()}`, 738, 447, {
          align: "right",
          color: [0.06, 0.14, 0.28, 1],
        });
        r.drawText(`${p.cash.toLocaleString()}`, 738, 479, {
          align: "right",
          color: [0.72, 0.20, 0.08, 1],
        });
      }
    }

    this.scroll.render(r);
    for (const b of this.activeButtons()) b.render(r);
    // Exact `CA.exe.c:158962..159079`: hover nameplate `Shop/CharSelShadow_Table` + `Shop/CharSel_Table` (`107x44`)!
    if (this.hoveredCharTab >= 0 && this.hoveredCharTab < 9) {
      const bx = 116 + this.hoveredCharTab * 43;
      const nx = bx - 32;
      // The original draws both sheets from the same sprite anchor at y=70.
      drawSheetFrame(r, this.charSelShadowSheet, 0, nx + 31, 70, { anchor: true, tint: [1, 1, 1, 150 / 255] });
      drawSheetFrame(r, this.charSelTableSheet, 0, nx + 31, 70, { anchor: true });
      const cname = SHOP_MAIN_CHAR_NAMES_TW[this.hoveredCharTab] ?? "";
      r.drawText(cname, nx + 53, 66, {
        align: "center",
        color: [0.06, 0.14, 0.28, 1],
      });
    }
    // Retail `CShopStageTw` (`CA.exe.c:156227`): blink `Shop/BtTab_ChoiceBlink` (`74x21`, 4 frames) when cart non-empty!
    if (!this.isCartTab() && this.cart.length > 0 && this.choiceBlinkSheet) {
      drawSheetFrame(r, this.choiceBlinkSheet, Math.floor(nowMs / 260) % 4, 398, 79);
    }
    // Retail `ObjectTable` `Shop/turtle0` & `Shop/turtle1` (`Shop/Talk_octo00` & `Talk_octo01` `41x40`) Shopkeeper mascot!
    const octoSheet = Math.floor(nowMs / 2400) % 2 === 0 ? this.talkOcto0Sheet : this.talkOcto1Sheet;
    if (octoSheet) {
      drawSheetFrame(r, octoSheet, Math.floor(nowMs / 220) % 3, 756, 250, { anchor: true });
    }
    if (!this.isCartTab() && this.tabIdx === 0 && this.subTabIdx !== 2 && this.specialAni02Sheet) {
      drawSheetFrame(r, this.specialAni02Sheet, Math.floor(nowMs / 240) % 5, 126, 110);
    }
    if (!this.isCartTab() && this.tabIdx === 0 && this.ctx.hub.coupons.length > 0 && !this.btMyCoupon.pressed) {
      drawSheetFrame(r, this.myCouponAniSheet, Math.floor(nowMs / 320) % 2, 268, 108);
    }
    if (this.qmSpriteSheet) {
      drawSheetFrame(r, this.qmSpriteSheet, Math.floor(tick / 6) % 6, 486, 540, { anchor: true });
    }
    const freeCnt = this.ctx.hub.pendingQuestionMarks;
    r.drawText(freeCnt > 0 ? `樂爆卡(${freeCnt})` : "樂爆卡", 535, 538, {
      align: "center",
      color: freeCnt > 0 ? [1, 0.92, 0.35, 1] : [0.06, 0.14, 0.28, 1],
      outlineColor: freeCnt > 0 ? [0.06, 0.12, 0.28, 0.95] : undefined,
    });
    this.ctx.globalBar.render(r, this.ctx.hub);
    this.popupMenu.render(r);
  }
}
