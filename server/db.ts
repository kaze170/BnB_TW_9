// Persistent SQLite backend (`bun:sqlite`) for Retail Taiwan BnB v9 Server.
// Manages accounts, EXP/Level progression, Lucci & Cash balances, 1,461-item
// `fxstock.ini` + `packagemap.ini` inventory/equipping, Rankings, Friends,
// SMS mail, and atomic 1-on-1 Item/Lucci Exchange transactions.

import { Database } from "bun:sqlite";
import {
  avatarDecoSlotsConflict,
  classifyCharDecoSlot,
  classifySlotLayerByName,
  resolveAvatarDecoCode,
  resolveCrayonColor,
  resolveLevelDisguiseDelta,
  resolveLevelEffectIndex,
  type SlotDecoLayer,
} from "../src/data/cosmetics.ts";
import { stockCurrency, type StockItem } from "../src/data/tables.ts";
import type {
  CouponRow,
  InventoryRow,
  NoticeItem,
  RankingRow,
  SmsRow,
  UserProfile,
} from "../src/net/messages.ts";

function hashPass(pass: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update("bnb_tw9_salt:");
  h.update(pass);
  return h.digest("hex");
}

/** Retail-style quadratic EXP curve for levels 1..200. */
export function expForLevel(lv: number): number {
  if (lv <= 1) return 0;
  const n = lv - 1;
  return 100 * n + 35 * n * n;
}

export function levelFromExp(exp: number): { level: number; nextExp: number } {
  let lv = 1;
  while (lv < 200 && exp >= expForLevel(lv + 1)) {
    lv++;
  }
  return { level: lv, nextExp: expForLevel(lv + 1) };
}

interface DbAccountRow {
  id: number;
  username: string;
  pass_hash: string;
  nickname: string;
  gender: number;
  exp: number;
  lucci: number;
  cash: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  saves: number;
  selected_char: number;
  memo: string;
  school?: string;
  community_logo?: number;
}

export class GameDatabase {
  readonly db: Database;
  readonly stockById: ReadonlyMap<number, StockItem>;
  readonly packageMap: ReadonlyMap<number, readonly number[]>;
  private readonly slotHintByAvatar = new Map<number, SlotDecoLayer>();

  constructor(
    dbPath: string,
    stockById: ReadonlyMap<number, StockItem>,
    packageMap: ReadonlyMap<number, readonly number[]>,
  ) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.stockById = stockById;
    this.packageMap = packageMap;
    for (const [, children] of packageMap) {
      const slotKids = children
        .map((cid) => stockById.get(cid))
        .filter((s): s is StockItem => Boolean(s && s.category === 10));
      if (slotKids.length >= 2) {
        if (!this.slotHintByAvatar.has(slotKids[0]!.avatarCode)) {
          this.slotHintByAvatar.set(slotKids[0]!.avatarCode, "Slot01");
        }
        for (let i = 1; i < slotKids.length; i++) {
          const kw = classifySlotLayerByName(slotKids[i]!.name);
          const fallback: SlotDecoLayer = i === 1 ? "Slot04" : i === 2 ? "Slot06" : "Slot07";
          if (!this.slotHintByAvatar.has(slotKids[i]!.avatarCode)) {
            this.slotHintByAvatar.set(slotKids[i]!.avatarCode, kw ?? fallback);
          }
        }
      }
    }
    this.initSchema();
    try {
      this.db.exec("ALTER TABLE accounts ADD COLUMN school TEXT NOT NULL DEFAULT '爆爆王學園';");
    } catch {}
    try {
      this.db.exec("ALTER TABLE accounts ADD COLUMN community_logo INTEGER NOT NULL DEFAULT 0;");
    } catch {}
    this.seedDefaults();
  }

  private resolveSlotLayer(stockId: number): SlotDecoLayer {
    const spec = this.stockById.get(stockId);
    if (!spec) return "Slot01";
    return this.slotHintByAvatar.get(spec.avatarCode) ?? classifySlotLayerByName(spec.name) ?? "Slot01";
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        nickname TEXT NOT NULL,
        gender INTEGER NOT NULL DEFAULT 0,
        exp INTEGER NOT NULL DEFAULT 0,
        lucci INTEGER NOT NULL DEFAULT 50000,
        cash INTEGER NOT NULL DEFAULT 10000,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        selected_char INTEGER NOT NULL DEFAULT 0,
        memo TEXT NOT NULL DEFAULT '歡迎來到爆爆王 BnB Taiwan v9！',
        school TEXT NOT NULL DEFAULT '爆爆王學園',
        community_logo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        equipped INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account_id, stock_id)
      );

      CREATE TABLE IF NOT EXISTS friends (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        friend_name TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (account_id, friend_name)
      );

      CREATE TABLE IF NOT EXISTS sms_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_name TEXT NOT NULL,
        receiver_name TEXT NOT NULL COLLATE NOCASE,
        body TEXT NOT NULL,
        read_flag INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        serial_code TEXT NOT NULL COLLATE NOCASE,
        redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, serial_code)
      );

      CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        stock_id INTEGER NOT NULL,
        discount_pct INTEGER NOT NULL DEFAULT 30,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, stock_id, discount_pct)
      );
    `);
  }

  private seedDefaults(): void {
    const countRow = this.db.query("SELECT COUNT(*) as cnt FROM accounts").get() as { cnt: number };
    if (countRow.cnt > 0) return;

    // Seed classic Taiwan BnB leaderboard legends so RankStage is populated from boot
    const legends: { u: string; n: string; exp: number; w: number; l: number; d: number; k: number; c: number; memo: string }[] = [
      { u: "BazziTW", n: "藍寶小霸王", exp: 18500, w: 142, l: 38, d: 9, k: 310, c: 0, memo: "海盜船14常駐～歡迎挑戰！" },
      { u: "DaoMaster", n: "睏寶水球神", exp: 14200, w: 118, l: 41, d: 11, k: 265, c: 1, memo: "工廠地圖連勝中！" },
      { u: "DizniCute", n: "囡囡愛水球", exp: 9800, w: 89, l: 35, d: 7, k: 174, c: 2, memo: "交換房間收購鬱金香花田～" },
      { u: "CaptainLodu", n: "海盜船長", exp: 7600, w: 67, l: 29, d: 5, k: 155, c: 5, memo: "金銀島尋寶隊招募中" },
      { u: "CappiStar", n: "痞子妹極速", exp: 5200, w: 48, l: 22, d: 6, k: 102, c: 3, memo: "溜冰鞋滿速衝刺！" },
      { u: "MaridRich", n: "藍妹妹富豪", exp: 3400, w: 31, l: 19, d: 4, k: 68, c: 6, memo: "商店街血拼達人" },
    ];
    const stmt = this.db.prepare(
      `INSERT INTO accounts (username, pass_hash, nickname, gender, exp, lucci, cash, wins, losses, draws, kills, selected_char, memo)
       VALUES (?, ?, ?, 0, ?, 88000, 15000, ?, ?, ?, ?, ?, ?)`,
    );
    for (const lg of legends) {
      stmt.run(lg.u, hashPass("bnb1234"), lg.n, lg.exp, lg.w, lg.l, lg.d, lg.k, lg.c, lg.memo);
    }
  }

  notices(): NoticeItem[] {
    return [
      {
        id: 1,
        category: "公告",
        title: "歡迎光臨《爆爆王 Crazy Arcade BnB》台灣第9版伺服器！",
        date: "2026-11-12",
        body: "本伺服器完整支援單人練習、雙人同機對戰、多人連線房間、1461件原版商城道具、1對1道具LUCCI交換與排行榜！在等待室輸入 /bot 1~3 即可加入電腦AI陪練！",
      },
      {
        id: 2,
        category: "活動",
        title: "新創帳號好禮大放送：免費贈送 50,000 LUCCI + 10,000 樂豆點數！",
        date: "2026-11-12",
        body: "所有註冊與登入玩家皆享有 50,000 LUCCI、10,000 點數與新手針筒補給包，並可於商城隨時免費儲值體驗全套時裝、水球造型與背景裝飾！",
      },
      {
        id: 3,
        category: "更新",
        title: "開放全部 240 張經典地圖（海盜、露營、工廠、冰原、沙漠、墓地、賽車）",
        date: "2026-11-12",
        body: "支援一般模式、隊長模式、定時炸彈模式、刺蝟模式與復活計分戰，對戰結束自動結算經驗值與 LUCCI 獎勵！",
      },
    ];
  }

  isUsernameAvailable(username: string): boolean {
    const clean = username.trim();
    if (clean.length < 2 || clean.length > 16) return false;
    const row = this.db.query("SELECT id FROM accounts WHERE username = ?").get(clean);
    return !row;
  }

  registerAccount(
    username: string,
    password: string,
    nickname: string,
    gender: number,
  ): { ok: true; profile: UserProfile } | { ok: false; message: string } {
    const u = username.trim();
    const n = (nickname.trim() || u).slice(0, 16);
    if (u.length < 2 || u.length > 16) {
      return { ok: false, message: "帳號長度需為 2 ~ 16 字元" };
    }
    if (password.length < 1) {
      return { ok: false, message: "請輸入密碼" };
    }
    if (!this.isUsernameAvailable(u)) {
      return { ok: false, message: "此帳號已被註冊，請換一個帳號" };
    }

    this.db
      .prepare(
        `INSERT INTO accounts (username, pass_hash, nickname, gender, exp, lucci, cash)
         VALUES (?, ?, ?, ?, 0, 50000, 10000)`,
      )
      .run(u, hashPass(password), n, gender & 1);

    const row = this.db.query("SELECT * FROM accounts WHERE username = ?").get(u) as DbAccountRow;
    // Starter items: Needle (stock 1102 = 針 15個) + Megaphone (stock 1209 = 廣播器) + Welcome QuestionMark Coupons!
    this.grantStock(row.id, 1102, 15);
    this.grantStock(row.id, 1209, 5);
    if (this.stockById.has(6172)) this.grantCoupon(row.id, 6172, 50, 1);
    if (this.stockById.has(1905)) this.grantCoupon(row.id, 1905, 30, 1);
    this.sendSms("系統管理員", u, `歡迎 ${n} 加入爆爆王！已發送 50,000 LUCCI、10,000 點數與新手針筒禮包至您的道具欄！`);

    return { ok: true, profile: this.toUserProfile(row) };
  }

  /**
   * Login existing account, OR auto-register on first login if username doesn't exist yet
   * (just like classic arcade quick-entry while strictly enforcing password on existing accounts!).
   */
  loginOrCreate(
    username: string,
    password: string,
  ): { ok: true; profile: UserProfile } | { ok: false; message: string } {
    const u = username.trim();
    if (u.length < 2 || u.length > 16) {
      return { ok: false, message: "帳號長度需為 2 ~ 16 字元" };
    }
    const row = this.db.query("SELECT * FROM accounts WHERE username = ?").get(u) as DbAccountRow | null;
    if (!row) {
      return this.registerAccount(u, password || "1234", u, 0);
    }
    if (row.pass_hash !== hashPass(password)) {
      return { ok: false, message: "密碼不正確，請重新輸入" };
    }
    return { ok: true, profile: this.toUserProfile(row) };
  }

  getProfileByUsername(username: string): UserProfile | null {
    const row = this.db
      .query("SELECT * FROM accounts WHERE username = ?")
      .get(username.trim()) as DbAccountRow | null;
    return row ? this.toUserProfile(row) : null;
  }

  getProfileById(accountId: number): UserProfile | null {
    const row = this.db
      .query("SELECT * FROM accounts WHERE id = ?")
      .get(accountId) as DbAccountRow | null;
    return row ? this.toUserProfile(row) : null;
  }

  private toUserProfile(row: DbAccountRow): UserProfile {
    const { level, nextExp } = levelFromExp(row.exp);
    const inv = this.getInventory(row.id);
    let hatStockId = 0;
    let bombStockId = 0;
    let slotDecoStockId = 0;
    let emotionStockId = 0;
    let fanfareStockId = 0;
    let idDecoStockId = 0;
    const slotDecoStockIds: number[] = [];
    const charDecoStockIds: number[] = [];
    let levelEffectIdx: number | undefined;
    let levelDisguiseDelta: number | undefined;
    let crayonColor: string | undefined;
    let battleItemStockId: number | undefined;

    for (const it of inv) {
      if (!it.equipped) continue;
      const spec = this.stockById.get(it.stockId);
      if (it.category === 12 || it.category === 19) {
        if (!hatStockId) hatStockId = it.stockId;
        charDecoStockIds.push(it.stockId);
      } else if (it.category === 14) {
        bombStockId = it.stockId;
      } else if (it.category === 10) {
        if (!slotDecoStockId) slotDecoStockId = it.stockId;
        slotDecoStockIds.push(it.stockId);
      } else if (it.category === 3) {
        emotionStockId = it.stockId;
      } else if (it.category === 4) {
        fanfareStockId = it.stockId;
      } else if (it.category === 18) {
        idDecoStockId = it.stockId;
      } else if (it.category === 5 && spec) {
        levelEffectIdx = resolveLevelEffectIndex(spec.avatarCode);
      } else if (it.category === 6 && spec) {
        levelDisguiseDelta = resolveLevelDisguiseDelta(spec.avatarCode);
      } else if (it.category === 15 && spec) {
        crayonColor = resolveCrayonColor(spec.avatarCode) ?? undefined;
      } else if (it.category === 1) {
        battleItemStockId = it.stockId;
      }
    }

    return {
      id: row.id,
      username: row.username,
      nickname: row.nickname,
      gender: row.gender,
      level,
      exp: row.exp,
      nextExp,
      lucci: row.lucci,
      cash: row.cash,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      kills: row.kills,
      saves: row.saves,
      selectedChar: row.selected_char,
      memo: row.memo,
      school: row.school ?? "爆爆王學園",
      communityLogo: row.community_logo ?? 0,
      equipped: {
        hatStockId,
        bombStockId,
        slotDecoStockId,
        emotionStockId,
        fanfareStockId,
        idDecoStockId,
        slotDecoStockIds,
        charDecoStockIds,
        levelEffectIdx,
        levelDisguiseDelta,
        crayonColor,
        battleItemStockId,
      },
    };
  }

  setSelectedChar(accountId: number, charCode: number): void {
    this.db.prepare("UPDATE accounts SET selected_char = ? WHERE id = ?").run(charCode, accountId);
  }

  updateMemo(
    accountId: number,
    memo: string,
    opts?: { nickname?: string; gender?: number; school?: string; communityLogo?: number },
  ): void {
    this.db.prepare("UPDATE accounts SET memo = ? WHERE id = ?").run(memo.slice(0, 80), accountId);
    if (opts?.nickname !== undefined) {
      const cleanNick = opts.nickname.trim().slice(0, 16);
      if (cleanNick.length > 0) {
        this.db.prepare("UPDATE accounts SET nickname = ? WHERE id = ?").run(cleanNick, accountId);
      }
    }
    if (opts?.gender !== undefined) {
      this.db.prepare("UPDATE accounts SET gender = ? WHERE id = ?").run(opts.gender & 1, accountId);
    }
    if (opts?.school !== undefined) {
      this.db
        .prepare("UPDATE accounts SET school = ? WHERE id = ?")
        .run(opts.school.trim().slice(0, 30) || "爆爆王學園", accountId);
    }
    if (opts?.communityLogo !== undefined) {
      const validLogos = new Set([0, 1, 2, 4, 5, 6]);
      const logo = validLogos.has(opts.communityLogo) ? opts.communityLogo : 0;
      this.db.prepare("UPDATE accounts SET community_logo = ? WHERE id = ?").run(logo, accountId);
    }
  }

  chargeCash(accountId: number, amount: number): UserProfile | null {
    const add = Math.max(0, Math.min(100000, amount | 0));
    this.db.prepare("UPDATE accounts SET cash = cash + ?, lucci = lucci + ? WHERE id = ?").run(add, add * 2, accountId);
    return this.getProfileById(accountId);
  }

  adjustLucci(accountId: number, delta: number): boolean {
    const prof = this.getProfileById(accountId);
    if (!prof) return false;
    if (delta < 0 && prof.lucci + delta < 0) return false;
    this.db.prepare("UPDATE accounts SET lucci = MAX(0, lucci + ?) WHERE id = ?").run(delta | 0, accountId);
    return true;
  }

  getInventory(accountId: number): InventoryRow[] {
    const rows = this.db
      .query("SELECT id, stock_id, category, quantity, equipped FROM inventory WHERE account_id = ? ORDER BY equipped DESC, id DESC")
      .all(accountId) as { id: number; stock_id: number; category: number; quantity: number; equipped: number }[];
    return rows.map((r) => ({
      invId: r.id,
      stockId: r.stock_id,
      category: r.category,
      quantity: r.quantity,
      equipped: r.equipped !== 0,
    }));
  }

  grantStock(accountId: number, stockId: number, qtyOverride?: number): void {
    const spec = this.stockById.get(stockId);
    const cat = spec?.category ?? 1;
    const qty = qtyOverride ?? Math.max(1, spec?.quantity ?? 1);

    // If Set/Bundle (`category == 11`), expand via `packagemap.ini`!
    const children = this.packageMap.get(stockId);
    if (children && children.length > 0) {
      for (const childId of children) {
        const cSpec = this.stockById.get(childId);
        if (cSpec) {
          this.upsertInventoryRow(accountId, childId, cSpec.category, Math.max(1, cSpec.quantity));
        }
      }
      return;
    }
    this.upsertInventoryRow(accountId, stockId, cat, qty);
  }

  private upsertInventoryRow(accountId: number, stockId: number, category: number, qty: number): void {
    this.db
      .prepare(
        `INSERT INTO inventory (account_id, stock_id, category, quantity, equipped)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(account_id, stock_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
      )
      .run(accountId, stockId, category, qty);
  }

  consumeStock(accountId: number, stockId: number, amount = 1): boolean {
    const row = this.db
      .query("SELECT id, quantity FROM inventory WHERE account_id = ? AND stock_id = ?")
      .get(accountId, stockId) as { id: number; quantity: number } | null;
    if (!row || row.quantity < amount) return false;
    if (row.quantity === amount) {
      this.db.prepare("DELETE FROM inventory WHERE id = ?").run(row.id);
    } else {
      this.db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE id = ?").run(amount, row.id);
    }
    return true;
  }

  buyStock(
    buyerId: number,
    stockId: number,
    currency: "lucci" | "cash",
    giftToUsername?: string,
    giftMessage?: string,
    qty = 1,
    couponId?: number,
  ): { ok: boolean; message: string } {
    try {
      return this.db.transaction(() => this.buyStockInTransaction(
        buyerId, stockId, currency, giftToUsername, giftMessage, qty, couponId,
      ))();
    } catch (error) {
      console.error("shop purchase rolled back:", error);
      return { ok: false, message: "購買失敗，交易已取消，請稍後再試。" };
    }
  }

  private buyStockInTransaction(
    buyerId: number,
    stockId: number,
    currency: "lucci" | "cash",
    giftToUsername?: string,
    giftMessage?: string,
    qty = 1,
    couponId?: number,
  ): { ok: boolean; message: string } {
    const spec = this.stockById.get(stockId);
    if (!spec) return { ok: false, message: "找不到該商品資料" };
    if (((spec.flags ?? 0) & 0x10) !== 0) return { ok: false, message: "此商品已售完。" };
    // CShopBuyDlg disables Present for Lucci goods and flag 1 (53191).
    if (giftToUsername && (currency === "lucci" || ((spec.flags ?? 0) & 1) !== 0)) {
      return { ok: false, message: "此商品無法贈送。" };
    }

    const buyer = this.getProfileById(buyerId);
    if (!buyer) return { ok: false, message: "帳號狀態異常" };

    let targetId = buyerId;
    let targetName = buyer.username;
    if (giftToUsername) {
      const target = this.getProfileByUsername(giftToUsername);
      if (!target) return { ok: false, message: `找不到收禮玩家「${giftToUsername}」` };
      targetId = target.id;
      targetName = target.username;
    }

    if (!Number.isFinite(qty) || qty < 1 || !Number.isInteger(qty)) {
      return { ok: false, message: "購買數量無效" };
    }
    const safeQty = Math.min(99, qty);
    let unitPrice = currency === "cash" ? spec.priceCash : spec.priceLucci;
    if ((currency !== "cash" && currency !== "lucci") || currency !== stockCurrency(spec) ||
        unitPrice < 0 || (unitPrice === 0 && (spec.currencyType === undefined || spec.stockType === 101))) {
      return { ok: false, message: "此商品無法使用該貨幣購買" };
    }
    let usedCouponRowId: number | null = null;
    if (couponId && !giftToUsername && safeQty === 1) {
      const cRow = this.db
        .query("SELECT id, stock_id, discount_pct, quantity FROM coupons WHERE id = ? AND account_id = ?")
        .get(couponId, buyerId) as {
        id: number;
        stock_id: number;
        discount_pct: number;
        quantity: number;
      } | null;
      if (cRow && cRow.quantity > 0 && (cRow.stock_id === stockId || cRow.stock_id === 0)) {
        // Exact `CA.exe.c:53075` discount formula: `price - floor(discountPct * 0.01 * price)`
        unitPrice = Math.max(0, unitPrice - Math.floor(cRow.discount_pct * 0.01 * unitPrice));
        usedCouponRowId = cRow.id;
      }
    }
    const price = unitPrice * safeQty;
    if (currency === "cash") {
      if (buyer.cash < price) return { ok: false, message: "樂豆點數不足，可點選「儲值」免費領取點數！" };
      this.db.prepare("UPDATE accounts SET cash = cash - ? WHERE id = ?").run(price, buyerId);
    } else {
      if (buyer.lucci < price) return { ok: false, message: "LUCCI 不足，快去對戰賺取 LUCCI 吧！" };
      this.db.prepare("UPDATE accounts SET lucci = lucci - ? WHERE id = ?").run(price, buyerId);
    }
    if (usedCouponRowId !== null) {
      this.db
        .prepare("UPDATE coupons SET quantity = MAX(0, quantity - 1) WHERE id = ?")
        .run(usedCouponRowId);
      this.db.prepare("DELETE FROM coupons WHERE id = ? AND quantity <= 0").run(usedCouponRowId);
    }

    for (let k = 0; k < safeQty; k++) {
      this.grantStock(targetId, stockId);
    }

    if (giftToUsername && targetId !== buyerId) {
      this.sendSms(
        buyer.nickname,
        targetName,
        `【商城禮物】贈送給您「${spec.name}」！留言：${giftMessage || "祝你遊戲愉快！"}`,
      );
      return { ok: true, message: `已成功將「${spec.name}」贈送給 ${targetName}！` };
    }
    const qtyLabel = safeQty > 1 ? ` x${safeQty}` : "";
    const dcLabel = usedCouponRowId !== null ? "（已套用優惠券折扣）" : "";
    return { ok: true, message: `購買成功！獲得「${spec.name}」${qtyLabel}${dcLabel}` };
  }

  buyStockBatch(
    buyerId: number,
    items: { stockId: number; currency: "lucci" | "cash"; qty: number }[],
  ): { ok: boolean; message: string; boughtCount: number } {
    try {
      return this.db.transaction(() => this.buyStockBatchInTransaction(buyerId, items))();
    } catch (error) {
      console.error("shop batch purchase rolled back:", error);
      return { ok: false, message: "結帳失敗，交易已取消，請稍後再試。", boughtCount: 0 };
    }
  }

  private buyStockBatchInTransaction(
    buyerId: number,
    items: { stockId: number; currency: "lucci" | "cash"; qty: number }[],
  ): { ok: boolean; message: string; boughtCount: number } {
    if (!Array.isArray(items) || !items.length) return { ok: false, message: "請先勾選要購買的收藏清單商品！", boughtCount: 0 };
    if (items.length > 25) return { ok: false, message: "一次最多購買 25 種商品，請分批結帳。", boughtCount: 0 };
    const buyer = this.getProfileById(buyerId);
    if (!buyer) return { ok: false, message: "帳號狀態異常", boughtCount: 0 };

    let totalCash = 0;
    let totalLucci = 0;
    const valid: { spec: NonNullable<ReturnType<GameDatabase["stockById"]["get"]>>; currency: "lucci" | "cash"; qty: number }[] = [];
    for (const req of items) {
      const spec = req && this.stockById.get(req.stockId);
      if (!spec) return { ok: false, message: "找不到商品資料，請確認收藏清單。", boughtCount: 0 };
      if (((spec.flags ?? 0) & 0x10) !== 0) return { ok: false, message: `「${spec.name}」已售完。`, boughtCount: 0 };
      if (!Number.isFinite(req.qty) || req.qty < 1 || !Number.isInteger(req.qty)) {
        return { ok: false, message: "購買數量無效", boughtCount: 0 };
      }
      const q = Math.min(99, req.qty);
      const price = req.currency === "cash" ? spec.priceCash : spec.priceLucci;
      if ((req.currency !== "cash" && req.currency !== "lucci") || req.currency !== stockCurrency(spec) ||
          price < 0 || (price === 0 && (spec.currencyType === undefined || spec.stockType === 101))) {
        return { ok: false, message: `「${spec.name}」無法使用該貨幣購買`, boughtCount: 0 };
      }
      if (req.currency === "cash") {
        totalCash += spec.priceCash * q;
      } else {
        totalLucci += spec.priceLucci * q;
      }
      valid.push({ spec, currency: req.currency, qty: q });
    }
    if (!valid.length) return { ok: false, message: "找不到有效商品資料", boughtCount: 0 };
    if (buyer.cash < totalCash) {
      return { ok: false, message: `樂豆點數不足（共需 ${totalCash.toLocaleString()} 點）！`, boughtCount: 0 };
    }
    if (buyer.lucci < totalLucci) {
      return { ok: false, message: `LUCCI 不足（共需 ${totalLucci.toLocaleString()} L）！`, boughtCount: 0 };
    }
    if (totalCash > 0) {
      this.db.prepare("UPDATE accounts SET cash = cash - ? WHERE id = ?").run(totalCash, buyerId);
    }
    if (totalLucci > 0) {
      this.db.prepare("UPDATE accounts SET lucci = lucci - ? WHERE id = ?").run(totalLucci, buyerId);
    }
    let boughtCount = 0;
    for (const v of valid) {
      for (let k = 0; k < v.qty; k++) {
        this.grantStock(buyerId, v.spec.id);
      }
      boughtCount += v.qty;
    }
    return {
      ok: true,
      message: `收藏清單結帳完成！共購入 ${valid.length} 項商品（${boughtCount} 件）！`,
      boughtCount,
    };
  }

  setEquipped(accountId: number, invId: number, equip: boolean): boolean {
    const item = this.db
      .query("SELECT id, stock_id, category FROM inventory WHERE id = ? AND account_id = ?")
      .get(invId, accountId) as { id: number; stock_id: number; category: number } | null;
    if (!item) return false;
    if (equip) {
      const spec = this.stockById.get(item.stock_id);
      if (item.category === 10) {
        // Multi-layer `SlotDeco` (`Slot01 | Slot04 | Slot06 | Slot07`): only unequip conflicting same-layer items!
        const targetLayer = this.resolveSlotLayer(item.stock_id);
        const equippedCat10 = this.db
          .query("SELECT id, stock_id FROM inventory WHERE account_id = ? AND category = 10 AND equipped = 1")
          .all(accountId) as { id: number; stock_id: number }[];
        for (const other of equippedCat10) {
          if (this.resolveSlotLayer(other.stock_id) === targetLayer) {
            this.db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").run(other.id);
          }
        }
      } else if (item.category === 12) {
        // Multi-slot `CharDeco` (`A | B | D | E | G`): only unequip conflicting same-sub-slot items!
        // Motion blur occupies its own functional slot, not an inferred hat slot.
        const targetSlot = spec?.iconPath.toLowerCase() === "item/motionblur"
          ? "motionBlur" : classifyCharDecoSlot(spec?.name ?? "");
        const equippedCat12 = this.db
          .query("SELECT id, stock_id FROM inventory WHERE account_id = ? AND category = 12 AND equipped = 1")
          .all(accountId) as { id: number; stock_id: number }[];
        for (const other of equippedCat12) {
          const otherSpec = this.stockById.get(other.stock_id);
          const otherSlot = otherSpec?.iconPath.toLowerCase() === "item/motionblur"
            ? "motionBlur" : classifyCharDecoSlot(otherSpec?.name ?? "");
          if (otherSlot === targetSlot) {
            this.db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").run(other.id);
          }
        }
      } else if (item.category === 19 && spec) {
        // `CGOAvatar` `AvatarDeco` (`10 | 20 | 21 | 30 | 40 | 41 | 50 | 60`): respect 12-slot conflict rules!
        const targetCode = resolveAvatarDecoCode(spec.avatarCode);
        const equippedCat19 = this.db
          .query("SELECT id, stock_id FROM inventory WHERE account_id = ? AND category = 19 AND equipped = 1")
          .all(accountId) as { id: number; stock_id: number }[];
        for (const other of equippedCat19) {
          const otherSpec = this.stockById.get(other.stock_id);
          const otherCode = resolveAvatarDecoCode(otherSpec?.avatarCode ?? 0);
          if (avatarDecoSlotsConflict(targetCode, otherCode)) {
            this.db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").run(other.id);
          }
        }
      } else {
        // Unequip other items in same exclusive slot category
        this.db
          .prepare("UPDATE inventory SET equipped = 0 WHERE account_id = ? AND category = ?")
          .run(accountId, item.category);
      }
      this.db.prepare("UPDATE inventory SET equipped = 1 WHERE id = ?").run(invId);
    } else {
      this.db.prepare("UPDATE inventory SET equipped = 0 WHERE id = ?").run(invId);
    }
    return true;
  }

  /** Retail sell eligibility/refund checks from sub_4D7621 (CA.exe.c:192556). */
  sellInventoryItem(accountId: number, invId: number): { ok: boolean; refundLucci: number; message: string } {
    const row = this.db
      .query("SELECT id, stock_id, quantity FROM inventory WHERE id = ? AND account_id = ?")
      .get(invId, accountId) as { id: number; stock_id: number; quantity: number } | null;
    if (!row) return { ok: false, refundLucci: 0, message: "找不到該道具！" };
    const spec = this.stockById.get(row.stock_id);
    // Retail uses ShopItem +112, not a cash-to-Lucci conversion or a minimum.
    // +172 is the stock duration field, not the player's remaining time.
    if (!spec || !spec.buyableLucci || spec.priceLucci <= 0 || spec.category === 1 ||
        ((spec.durationDays ?? 0) > 0 && (spec.durationDays ?? 0) <= 8760)) {
      return { ok: false, refundLucci: 0, message: "此道具無法販售。" };
    }
    const refund = Math.floor(spec.priceLucci / 2);
    const account = this.getProfileById(accountId);
    if (!account || account.lucci + refund > 1_000_000) {
      return { ok: false, refundLucci: 0, message: "販售後的 LUCCI 不能超過 1,000,000。" };
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM inventory WHERE id = ? AND account_id = ?").run(invId, accountId);
      this.db.prepare("UPDATE accounts SET lucci = lucci + ? WHERE id = ?").run(refund, accountId);
    })();
    return {
      ok: true,
      refundLucci: refund,
      message: `已販售「${spec?.name ?? `#${row.stock_id}`}」，獲得 +${refund.toLocaleString()} LUCCI！`,
    };
  }

  /**
   * Retail `CShopInventoryPopupDlg` `Shop/SelectBox_Delete` (`CA.exe.c:54985`):
   * Permanently deletes an inventory row from the player's bag.
   */
  deleteInventoryItem(accountId: number, invId: number): { ok: boolean; message: string } {
    const row = this.db
      .query("SELECT id, stock_id FROM inventory WHERE id = ? AND account_id = ?")
      .get(invId, accountId) as { id: number; stock_id: number } | null;
    if (!row) return { ok: false, message: "找不到該道具！" };
    const spec = this.stockById.get(row.stock_id);
    this.db.prepare("DELETE FROM inventory WHERE id = ? AND account_id = ?").run(invId, accountId);
    return { ok: true, message: `已丟棄道具「${spec?.name ?? `#${row.stock_id}`}」。` };
  }

  recordMatchOutcome(
    accountId: number,
    outcome: "win" | "loss" | "draw",
    kills: number,
    saves: number,
    usedNeedles: number,
    bonusLucci = 0,
    extraExpMult = 1,
    extraLucciMult = 1,
  ): { expGain: number; lucciGain: number; newLevel: number; leveledUp: boolean; expProgressTenths: number; premiumApplied?: boolean } {
    const before = this.getProfileById(accountId);
    const oldLevel = before?.level ?? 1;
    const inv = this.getInventory(accountId);
    const hasPremium = inv.some((r) => r.category === 9 && r.quantity > 0);
    const multExp = (hasPremium ? 2 : 1) * extraExpMult;
    const multLucci = (hasPremium ? 2 : 1) * extraLucciMult;

    const baseExp =
      (outcome === "win" ? 120 : outcome === "draw" ? 65 : 45) + kills * 25 + saves * 15;
    const baseLucci =
      (outcome === "win" ? 280 : outcome === "draw" ? 120 : 80) + kills * 40 + saves * 20 + Math.max(0, bonusLucci);
    const expGain = Math.round(baseExp * multExp);
    const lucciGain = Math.round(baseLucci * multLucci);

    const col = outcome === "win" ? "wins" : outcome === "loss" ? "losses" : "draws";
    this.db
      .prepare(
        `UPDATE accounts
         SET exp = exp + ?, lucci = lucci + ?, ${col} = ${col} + 1, kills = kills + ?, saves = saves + ?
         WHERE id = ?`,
      )
      .run(expGain, lucciGain, kills, saves, accountId);

    if (usedNeedles > 0) {
      const needleInv = inv.find(
        (r) => r.category === 1 && this.stockById.get(r.stockId)?.avatarCode === 1 && r.quantity > 0,
      );
      if (needleInv) this.consumeStock(accountId, needleInv.stockId, usedNeedles);
    }

    const after = this.getProfileById(accountId);
    const newLevel = after?.level ?? oldLevel;
    const levelStart = expForLevel(newLevel);
    const levelEnd = expForLevel(newLevel + 1);
    const expProgressTenths = Math.max(0, Math.min(999, Math.floor(((after?.exp ?? levelStart) - levelStart) * 1000 / (levelEnd - levelStart))));
    return { expGain, lucciGain, newLevel, leveledUp: newLevel > oldLevel, expProgressTenths, premiumApplied: hasPremium };
  }

  getRankings(sortBy: "wins" | "exp" | "kills" = "exp", limit = 50): RankingRow[] {
    const orderCol = sortBy === "wins" ? "wins DESC, exp DESC" : sortBy === "kills" ? "kills DESC, exp DESC" : "exp DESC, wins DESC";
    const rows = this.db
      .query(`SELECT username, nickname, exp, wins, losses, draws, kills FROM accounts ORDER BY ${orderCol} LIMIT ?`)
      .all(limit) as {
      username: string;
      nickname: string;
      exp: number;
      wins: number;
      losses: number;
      draws: number;
      kills: number;
    }[];

    return rows.map((r, i) => {
      const total = r.wins + r.losses + r.draws;
      const winRate = total > 0 ? Math.round((r.wins / total) * 100) : 0;
      return {
        rank: i + 1,
        username: r.username,
        nickname: r.nickname,
        level: levelFromExp(r.exp).level,
        exp: r.exp,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        kills: r.kills,
        winRate,
      };
    });
  }

  getFriends(accountId: number): string[] {
    const rows = this.db
      .query("SELECT friend_name FROM friends WHERE account_id = ? ORDER BY friend_name ASC")
      .all(accountId) as { friend_name: string }[];
    return rows.map((r) => r.friend_name);
  }

  addFriend(accountId: number, friendUsername: string): { ok: boolean; message: string } {
    const target = this.getProfileByUsername(friendUsername);
    if (!target) return { ok: false, message: `找不到玩家「${friendUsername}」` };
    if (target.id === accountId) return { ok: false, message: "不能將自己加入好友名單" };
    this.db
      .prepare("INSERT OR IGNORE INTO friends (account_id, friend_name) VALUES (?, ?)")
      .run(accountId, target.username);
    return { ok: true, message: `已將 ${target.username} 加入好友名單` };
  }

  removeFriend(accountId: number, friendUsername: string): void {
    this.db
      .prepare("DELETE FROM friends WHERE account_id = ? AND friend_name = ?")
      .run(accountId, friendUsername.trim());
  }

  sendSms(senderName: string, receiverUsername: string, body: string): boolean {
    const target = this.getProfileByUsername(receiverUsername);
    if (!target) return false;
    this.db
      .prepare("INSERT INTO sms_messages (sender_name, receiver_name, body) VALUES (?, ?, ?)")
      .run(senderName, target.username, body.slice(0, 200));
    return true;
  }

  getSms(username: string): SmsRow[] {
    const rows = this.db
      .query(
        "SELECT id, sender_name, receiver_name, body, read_flag, sent_at FROM sms_messages WHERE receiver_name = ? ORDER BY id DESC LIMIT 50",
      )
      .all(username) as {
      id: number;
      sender_name: string;
      receiver_name: string;
      body: string;
      read_flag: number;
      sent_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      sender: r.sender_name,
      receiver: r.receiver_name,
      body: r.body,
      read: r.read_flag !== 0,
      sentAt: r.sent_at,
    }));
  }

  deleteSms(username: string, smsId: number, deleteAll = false): void {
    if (deleteAll) {
      this.db.prepare("DELETE FROM sms_messages WHERE receiver_name = ?").run(username);
    } else {
      this.db.prepare("DELETE FROM sms_messages WHERE id = ? AND receiver_name = ?").run(smsId, username);
    }
  }

  /** Atomic 1-on-1 Exchange trade execution between two accounts! */
  executeExchange(
    accA: number,
    invIdsA: readonly number[],
    lucciA: number,
    accB: number,
    invIdsB: readonly number[],
    lucciB: number,
  ): { ok: boolean; message: string } {
    const tx = this.db.transaction(() => {
      const pA = this.getProfileById(accA);
      const pB = this.getProfileById(accB);
      if (!pA || !pB) throw new Error("玩家狀態離線");
      if (lucciA < 0 || lucciB < 0 || pA.lucci < lucciA || pB.lucci < lucciB) {
        throw new Error("交易雙方 LUCCI 餘額不足");
      }

      const transferItems = (fromAcc: number, toAcc: number, ids: readonly number[]) => {
        for (const invId of ids) {
          const row = this.db
            .query("SELECT id, stock_id, category, quantity FROM inventory WHERE id = ? AND account_id = ?")
            .get(invId, fromAcc) as { id: number; stock_id: number; category: number; quantity: number } | null;
          if (!row || row.quantity < 1) throw new Error("交易道具已變更");
          if (row.quantity === 1) {
            this.db.prepare("DELETE FROM inventory WHERE id = ?").run(row.id);
          } else {
            this.db.prepare("UPDATE inventory SET quantity = quantity - 1 WHERE id = ?").run(row.id);
          }
          this.upsertInventoryRow(toAcc, row.stock_id, row.category, 1);
        }
      };

      transferItems(accA, accB, invIdsA);
      transferItems(accB, accA, invIdsB);

      const netA = lucciB - lucciA;
      if (netA !== 0) {
        this.db.prepare("UPDATE accounts SET lucci = lucci + ? WHERE id = ?").run(netA, accA);
        this.db.prepare("UPDATE accounts SET lucci = lucci - ? WHERE id = ?").run(netA, accB);
      }
    });

    try {
      tx();
      return { ok: true, message: "交換成功！道具與 LUCCI 已完成轉移！" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "交換失敗" };
    }
  }

  // ─── Retail `QuestionMarkCoupon` & `CMyCouponListDlg` (`CA.exe.c:224695..226065`) ──

  grantCoupon(accountId: number, stockId: number, discountPct: number, quantity = 1): void {
    const pct = Math.max(10, Math.min(100, Math.round(discountPct)));
    const qty = Math.max(1, Math.round(quantity));
    const existing = this.db
      .query("SELECT id FROM coupons WHERE account_id = ? AND stock_id = ? AND discount_pct = ?")
      .get(accountId, stockId, pct) as { id: number } | null;
    if (existing) {
      this.db.prepare("UPDATE coupons SET quantity = quantity + ? WHERE id = ?").run(qty, existing.id);
    } else {
      this.db
        .prepare("INSERT INTO coupons (account_id, stock_id, discount_pct, quantity) VALUES (?, ?, ?, ?)")
        .run(accountId, stockId, pct, qty);
    }
  }

  getCoupons(accountId: number): CouponRow[] {
    const rows = this.db
      .query(
        "SELECT id, stock_id, discount_pct, quantity, created_at FROM coupons WHERE account_id = ? AND quantity > 0 ORDER BY id DESC",
      )
      .all(accountId) as {
      id: number;
      stock_id: number;
      discount_pct: number;
      quantity: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      couponId: r.id,
      stockId: r.stock_id,
      discountPct: r.discount_pct,
      quantity: r.quantity,
      createdAt: r.created_at,
    }));
  }

  deleteCoupon(accountId: number, couponId: number): boolean {
    const res = this.db
      .prepare("DELETE FROM coupons WHERE id = ? AND account_id = ?")
      .run(couponId, accountId);
    return res.changes > 0;
  }

  useCoupon(
    accountId: number,
    couponId: number,
  ):
    | { ok: true; stockId: number; itemName: string; discountPct: number; paidLucci: number; paidCash: number }
    | { ok: false; message: string } {
    const cRow = this.db
      .query("SELECT id, stock_id, discount_pct, quantity FROM coupons WHERE id = ? AND account_id = ?")
      .get(couponId, accountId) as {
      id: number;
      stock_id: number;
      discount_pct: number;
      quantity: number;
    } | null;
    if (!cRow || cRow.quantity < 1) {
      return { ok: false, message: "找不到此優惠券或已使用完畢！" };
    }
    const spec = this.stockById.get(cRow.stock_id);
    if (!spec) {
      return { ok: false, message: "此優惠券對應的商品已下架！" };
    }
    const acc = this.db
      .query("SELECT lucci, cash FROM accounts WHERE id = ?")
      .get(accountId) as { lucci: number; cash: number } | null;
    if (!acc) return { ok: false, message: "帳號狀態異常" };

    const factor = Math.max(0, 100 - cRow.discount_pct) / 100;
    const useLucci = spec.buyableLucci && spec.priceLucci > 0;
    const paidLucci = useLucci ? Math.max(0, Math.round(spec.priceLucci * factor)) : 0;
    const paidCash = !useLucci && spec.priceCash > 0 ? Math.max(0, Math.round(spec.priceCash * factor)) : 0;

    if (paidLucci > 0 && acc.lucci < paidLucci) {
      return { ok: false, message: `LUCCI 不足（折價後需 ${paidLucci} LUCCI）！` };
    }
    if (paidCash > 0 && acc.cash < paidCash) {
      return { ok: false, message: `點數不足（折價後需 ${paidCash} 點）！` };
    }

    const tx = this.db.transaction(() => {
      if (paidLucci > 0) {
        this.db.prepare("UPDATE accounts SET lucci = lucci - ? WHERE id = ?").run(paidLucci, accountId);
      }
      if (paidCash > 0) {
        this.db.prepare("UPDATE accounts SET cash = cash - ? WHERE id = ?").run(paidCash, accountId);
      }
      if (cRow.quantity <= 1) {
        this.db.prepare("DELETE FROM coupons WHERE id = ?").run(cRow.id);
      } else {
        this.db.prepare("UPDATE coupons SET quantity = quantity - 1 WHERE id = ?").run(cRow.id);
      }
      this.grantStock(accountId, spec.id, Math.max(1, spec.quantity));
    });
    tx();

    return {
      ok: true,
      stockId: spec.id,
      itemName: spec.name || `#${spec.id}`,
      discountPct: cRow.discount_pct,
      paidLucci,
      paidCash,
    };
  }

  redeemSerialCode(accountId: number, rawCode: string): { ok: boolean; message: string } {
    const clean = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (clean.length < 4 || clean.length > 24) {
      return { ok: false, message: "請輸入有效的活動兌換序號！" };
    }
    const already = this.db
      .query("SELECT 1 FROM coupon_redemptions WHERE account_id = ? AND serial_code = ?")
      .get(accountId, clean);
    if (already) {
      return { ok: false, message: "此帳號已兌換過該序號，每組序號限領一次！" };
    }

    const SERIAL_CATALOG: Record<
      string,
      { lucci?: number; cash?: number; stocks?: [number, number][]; coupon?: [number, number]; label: string }
    > = {
      BNB9GIFT2006: { lucci: 30000, cash: 3000, stocks: [[1102, 15], [1209, 5]], label: "台灣爆爆王 v9 典藏禮包（30,000 LUCCI + 3,000 點數 + 針筒 + 廣播器）" },
      BNB9LUCCI999: { lucci: 50000, label: "50,000 LUCCI 活動獎金" },
      BNB9CASH2000: { cash: 5000, label: "5,000 樂豆點數儲值序號" },
      BNB9BAGPLUS: { stocks: [[1212, 1]], label: "「物品包包」6格快捷欄擴充道具" },
      BNB9VIPPASS: { stocks: [[1205, 1], [1203, 1], [1204, 1]], label: "貴賓包廂券 + 超級室長券 + 反制退出券組合" },
      BNB9DC80OFF: { coupon: [1905, 80], label: "80% 特級折價優惠券" },
    };
    const reward = SERIAL_CATALOG[clean];
    if (!reward) {
      return { ok: false, message: "查無此兌換序號（可用範例：BNB9-GIFT-2006 / BNB9-BAG-PLUS）" };
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO coupon_redemptions (account_id, serial_code) VALUES (?, ?)")
        .run(accountId, clean);
      if (reward.lucci) {
        this.db.prepare("UPDATE accounts SET lucci = lucci + ? WHERE id = ?").run(reward.lucci, accountId);
      }
      if (reward.cash) {
        this.db.prepare("UPDATE accounts SET cash = cash + ? WHERE id = ?").run(reward.cash, accountId);
      }
      for (const [sid, qty] of reward.stocks ?? []) {
        if (this.stockById.has(sid)) this.grantStock(accountId, sid, qty);
      }
      if (reward.coupon && this.stockById.has(reward.coupon[0])) {
        this.grantCoupon(accountId, reward.coupon[0], reward.coupon[1], 1);
      }
    });
    tx();

    return { ok: true, message: `序號兌換成功！已獲得：${reward.label}` };
  }
}
