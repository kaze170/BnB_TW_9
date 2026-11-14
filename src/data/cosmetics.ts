// Retail `CIconMan` (`0x004CA259..0x004CAF20`) + `CUserItemMan` (`0x004DF66D..0x004E0873`)
// multi-archive icon & live cosmetic resolver across `Fx`, `CharTE`, `EmoTE`, and `Cx`.

import type { PackName } from "./assets.ts";
import type { ObjectTable, StockItem } from "./tables.ts";

export type SlotDecoLayer = "Slot01" | "Slot04" | "Slot06" | "Slot07";
export type CharDecoSlot = "A" | "B" | "D" | "E" | "G";

export interface PackProbe {
  has(name: string): boolean;
  entriesMatching(prefix: string): readonly { name: string }[];
}

export interface ResolvedStockVisual {
  readonly stockId: number;
  readonly category: number;
  readonly avatarCode: number;
  readonly iconPack: PackName;
  readonly iconName: string;
  readonly liveKind?:
    | "slotDeco"
    | "charDeco"
    | "bombSkin"
    | "fanfare"
    | "idDeco"
    | "avatarDeco"
    | "emotion"
    | "levelEffect"
    | "levelDisguise"
    | "package";
  readonly livePack?: PackName;
  readonly liveObject?: string;
  readonly subSlot?: string;
  readonly skinIndex?: number;
}

/**
 * Exact verified retail mapping of `cat 14` (`fxstock.ini` bomb skins) to
 * `CharTE:BombDeco/Bomb001..010` & `CharTE:Icon/Bomb001icon..010icon`.
 */
const BOMB_SKIN_BY_AVATAR_CODE: Readonly<Record<number, number>> = {
  20001: 1,
  20002: 2, // 橫紋水球 (blue/cyan striped)
  20003: 3, // 彩虹水球 (rainbow)
  20141: 4, // X-MAS 水球
  20142: 5, // 迷彩水球 (olive camo)
  20143: 6,
  20144: 7, // 春色水球 (spring green)
  20145: 8, // 粉紅愛心水球 (pink heart)
  20273: 9, // 西瓜炸彈 (watermelon)
  20274: 10, // 天藍水球 (sky blue)
};

/**
 * Exact verified retail mapping of `cat 19` (`fxstock.ini` Bazzi `C06` AvatarDeco)
 * to `CharTE:AvatarDeco/A06_*` & `CharTE:Icon/A06_*icon`.
 */
export const AVATAR_DECO_BY_AVATAR_CODE: Readonly<Record<number, string>> = {
  25001: "A06_10_0002", // 睏寶 生氣
  25002: "A06_20_0002", // 睏寶 愛心襯衫
  25003: "A06_40_0001", // 睏寶 圍巾
  25004: "A06_21_0001", // 睏寶 黑色西裝
};

export function resolveAvatarDecoCode(avatarCode: number): string {
  return AVATAR_DECO_BY_AVATAR_CODE[avatarCode] ?? "A06_20_0002";
}

export function avatarDecoSlotsConflict(codeA: string, codeB: string): boolean {
  const slotA = codeA.split("_")[1] ?? "";
  const slotB = codeB.split("_")[1] ?? "";
  if (!slotA || !slotB) return true;
  if (slotA === slotB) return true;
  // `CGOAvatar::sub_407502`: `21` is a full suit replacing both `20` and `30`; `41` replaces `40` and `60`.
  if (slotA === "21" && (slotB === "20" || slotB === "30")) return true;
  if (slotB === "21" && (slotA === "20" || slotA === "30")) return true;
  if (slotA === "41" && (slotB === "40" || slotB === "60")) return true;
  if (slotB === "41" && (slotA === "40" || slotA === "60")) return true;
  return false;
}

export function resolveLevelEffectIndex(avatarCode: number): number {
  if (avatarCode >= 16 && avatarCode <= 23) return avatarCode - 16;
  return 0;
}

/**
 * Exact verified retail mapping of `cat 4` (`fxstock.ini` Fanfares `id=1410..1416`,
 * `av=11..15` + `av=103` `大韓民國` `Item/Fanfare005` + `av=104` `GOAL~~` `Item/Fanfare006`)
 * to `EmoTE:Fanfare/Fanfare000..006` & `EmoTE:Wave/Fanfare000..006`.
 */
export function resolveFanfareIndex(avatarCode: number, iconPath = ""): number {
  const m = /fanfare(\d{3})/i.exec(iconPath);
  if (m) {
    const parsed = Number(m[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 6) return parsed;
  }
  if (avatarCode === 103) return 5;
  if (avatarCode === 104) return 6;
  return Math.max(0, Math.min(6, avatarCode - 11));
}

export function resolveLevelDisguiseDelta(avatarCode: number): number {
  switch (avatarCode) {
    case 95:
      return -15;
    case 96:
      return -30;
    case 97:
      return -45;
    case 98:
      return -90;
    case 99:
      return 15;
    case 100:
      return 30;
    case 101:
      return 45;
    case 102:
      return 90;
    default:
      return 0;
  }
}

export function resolveCrayonColor(avatarCode: number): string | null {
  switch (avatarCode) {
    case 10019:
      return "#FF68B4"; // 蠟筆 (粉紅色)
    case 10020:
      return "#55CCFF";
    case 10021:
      return "#77EE66";
    default:
      return null;
  }
}

const GENERIC_PLACEHOLDER_ICONS = new Set([
  "",
  "item/slotdeco",
  "icon/slotdeco",
  "item/chardeco",
  "icon/chardeco",
  "item/bomb",
  "item/avatardeco",
  "item/iddeco_c001",
  "shot/emotspecial",
  "item/set_decorationicon",
  "item/fuel",
  "item/remotebomb",
  "item/fanfare000",
  "item/fanfare001",
  "item/fanfare002",
  "item/fanfare003",
  "item/fanfare004",
  "item/fanfare005",
  "item/fanfare006",
]);

export function classifySlotLayerByName(name: string): SlotDecoLayer | null {
  if (/前景|籬笆|柵欄|圍欄|欄杆|鐵絲網|花壇|草叢|桌|木樁|水桶|欄/.test(name)) {
    return "Slot07";
  }
  if (/旗|門牌|招牌|橫幅|吊燈|燈籠|彩燈|氣球串|花環|鐘/.test(name)) {
    return "Slot06";
  }
  if (/雪人|爺爺|寶寶|娃娃|小狗|小貓|企鵝|小雞|熊|兔|龍|蛙|豬|鳥|魚|朋友|玩偶|機器人|精靈|夥伴/.test(name)) {
    return "Slot04";
  }
  if (/背景|天空|風景|牆|屋|房|海灘|森林|夜晚|舞台|村|城|山|海|雪地|草地|花園/.test(name)) {
    return "Slot01";
  }
  return null;
}

export function classifyCharDecoSlot(name: string): CharDecoSlot {
  if (/眼鏡|墨鏡|眼罩|面具|口罩|鬍|腮紅|臉|嘴|吻/.test(name)) {
    return "B";
  }
  if (/翅膀|羽翼|披風|背包|筋斗雲|斗篷|尾巴|氣球背/.test(name)) {
    return "D";
  }
  if (/光環|光芒|特效|閃亮|愛心光|星光|火焰光|魔法陣|靈氣/.test(name)) {
    return "G";
  }
  if (/寵物|跟隨|小精靈|迷你|小天使|小惡魔|幽靈|小鳥/.test(name)) {
    return "E";
  }
  return "A";
}

export type EmotionGroup = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

const EMOTION_GROUPS: readonly EmotionGroup[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

function inferCharCodeFromName(name: string): number {
  if (name.includes("藍寶")) return 0;
  if (name.includes("痞子妹")) return 1;
  if (name.includes("囡囡")) return 2;
  if (name.includes("工頭")) return 3;
  if (name.includes("小蜜桃")) return 4;
  if (name.includes("栗子")) return 5;
  if (name.includes("睏寶")) return 6;
  if (name.includes("ㄚ肥")) return 7;
  return 0;
}

function inferEmotionGroup(iconPath: string, name: string): EmotionGroup {
  const low = iconPath.toLowerCase();
  if (low.includes("emotgreet")) return "A";
  if (low.includes("emotsmile")) return "B";
  if (low.includes("emotsad")) return "C";
  if (low.includes("emotangry")) return "D";
  if (low.includes("emotshy")) return "E";
  if (low.includes("emotdance")) return "F";
  if (low.includes("emotlove")) return "G";
  if (/哈囉|歐嗨唷|你好/.test(name)) return "A";
  if (/開心|哈哈|笑/.test(name)) return "B";
  if (/哭|傷心|淚/.test(name)) return "C";
  if (/氣炸|生氣|怒/.test(name)) return "D";
  if (/石化|害羞|膽怯/.test(name)) return "E";
  if (/加油|跳舞|舞/.test(name)) return "F";
  if (/甜蜜|愛心|戀/.test(name)) return "G";
  return "H";
}

export class CosmeticCatalog {
  private readonly byStockId = new Map<number, ResolvedStockVisual>();
  private readonly packageMap: ReadonlyMap<number, readonly number[]>;
  private readonly emoObjects: ObjectTable;

  constructor(opts: {
    stocks: readonly StockItem[];
    packageMap: ReadonlyMap<number, readonly number[]>;
    fx: PackProbe;
    charTe: PackProbe;
    emoTe: PackProbe;
    cx: PackProbe;
    charObjects: ObjectTable;
    emoObjects: ObjectTable;
  }) {
    const { stocks, packageMap, fx, charTe, emoTe, cx, charObjects, emoObjects } = opts;
    this.packageMap = packageMap;
    this.emoObjects = emoObjects;
    const stockById = new Map<number, StockItem>();
    for (const s of stocks) stockById.set(s.id, s);

    // Collect available Character Emotion variants per `(charCode, group)` in `EmoTE`
    const emoPools = new Map<string, string[]>();
    for (const obj of emoObjects.byIndex) {
      if (!obj) continue;
      const m = /^Character\/C(\d{2})_Emotion([A-H]\d{3})$/i.exec(obj.name);
      if (!m) continue;
      const cIdx = Number(m[1]);
      const suffix = m[2]!.toUpperCase();
      const grp = suffix.charAt(0);
      const key = `${cIdx}:${grp}`;
      let arr = emoPools.get(key);
      if (!arr) {
        arr = [];
        emoPools.set(key, arr);
      }
      if (!suffix.endsWith("000")) arr.push(suffix);
    }
    for (const arr of emoPools.values()) arr.sort();
    const emoCursors = new Map<string, number>();

    // Collect available SlotDeco objects in EmoTE grouped by sub-slot (`Slot01`, `Slot04`, `Slot06`, `Slot07`)
    const slotPools: Record<SlotDecoLayer, string[]> = {
      Slot01: [],
      Slot04: [],
      Slot06: [],
      Slot07: [],
    };
    for (const obj of emoObjects.byIndex) {
      if (!obj) continue;
      const m = /^Slot\/(Slot01|Slot04|Slot06|Slot07)_(\d{4})$/i.exec(obj.name);
      if (!m) continue;
      const layer = (m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()) as SlotDecoLayer;
      slotPools[layer].push(m[2]!);
    }
    for (const k of Object.keys(slotPools) as SlotDecoLayer[]) {
      slotPools[k].sort();
    }

    // Collect available CharDeco objects in CharTE grouped by slot (`A`, `B`, `D`, `E`, `G`)
    const charDecoPools: Record<CharDecoSlot, { code: string; objName: string; iconName: string }[]> = {
      A: [],
      B: [],
      D: [],
      E: [],
      G: [],
    };
    for (const obj of charObjects.byIndex) {
      if (!obj) continue;
      const m = /^CharDeco\/CharDeco_([ABDEG])(\d{4})$/i.exec(obj.name);
      if (!m) continue;
      const slot = m[1]!.toUpperCase() as CharDecoSlot;
      const num = m[2]!;
      const candIcon = `Icon/CharDeco_${slot}${num}icon`;
      const iconName = charTe.has(candIcon) ? candIcon : "";
      charDecoPools[slot].push({ code: `${slot}${num}`, objName: obj.name, iconName });
    }
    for (const k of Object.keys(charDecoPools) as CharDecoSlot[]) {
      charDecoPools[k].sort((a, b) => a.code.localeCompare(b.code));
    }

    // Infer SlotDeco layer from `packagemap.ini` bundle order first, then name keywords
    const avatarSlotHint = new Map<number, SlotDecoLayer>();
    for (const [, childIds] of packageMap) {
      const slotKids = childIds
        .map((id) => stockById.get(id))
        .filter((s): s is StockItem => Boolean(s && s.category === 10));
      if (slotKids.length >= 2) {
        // Retail SlotDeco bundles always start with background (`Slot01`), followed by companion/banner/fence
        if (!avatarSlotHint.has(slotKids[0]!.avatarCode)) {
          avatarSlotHint.set(slotKids[0]!.avatarCode, classifySlotLayerByName(slotKids[0]!.name) ?? "Slot01");
        }
        for (let i = 1; i < slotKids.length; i++) {
          const kw = classifySlotLayerByName(slotKids[i]!.name);
          const fallback: SlotDecoLayer =
            i === 1 ? "Slot04" : i === 2 ? "Slot06" : "Slot07";
          if (!avatarSlotHint.has(slotKids[i]!.avatarCode)) {
            avatarSlotHint.set(slotKids[i]!.avatarCode, kw ?? fallback);
          }
        }
      }
    }

    // Assign deterministic 1-to-1 `EmoTE:Slot/*` for every distinct `cat 10` `avatarCode`
    const cat10Codes = [...new Set(stocks.filter((s) => s.category === 10).map((s) => s.avatarCode))].sort(
      (a, b) => a - b,
    );
    const cat10ByAvatar = new Map<number, { layer: SlotDecoLayer; num: string }>();
    const slotCursor: Record<SlotDecoLayer, number> = { Slot01: 0, Slot04: 0, Slot06: 0, Slot07: 0 };
    const nameByCat10Avatar = new Map<number, string>();
    for (const s of stocks) {
      if (s.category === 10 && !nameByCat10Avatar.has(s.avatarCode)) {
        nameByCat10Avatar.set(s.avatarCode, s.name);
      }
    }
    for (const av of cat10Codes) {
      const nm = nameByCat10Avatar.get(av) ?? "";
      let layer: SlotDecoLayer = avatarSlotHint.get(av) ?? classifySlotLayerByName(nm) ?? "Slot01";
      // Spill over gracefully if a sub-pool is full so unique items stay distinct as long as possible
      if (slotCursor[layer] >= slotPools[layer].length) {
        const alt = (["Slot01", "Slot04", "Slot06", "Slot07"] as SlotDecoLayer[]).find(
          (l) => slotCursor[l] < slotPools[l].length,
        );
        if (alt) layer = alt;
      }
      const pool = slotPools[layer];
      const num = pool.length > 0 ? pool[slotCursor[layer]! % pool.length]! : "0001";
      slotCursor[layer]++;
      cat10ByAvatar.set(av, { layer, num });
    }

    // Assign deterministic `CharTE:CharDeco/*` for every distinct `cat 12` `avatarCode`
    const cat12Codes = [...new Set(stocks.filter((s) => s.category === 12).map((s) => s.avatarCode))].sort(
      (a, b) => a - b,
    );
    const cat12ByAvatar = new Map<
      number,
      { slot: CharDecoSlot; objName: string; iconName: string }
    >();
    const cdCursor: Record<CharDecoSlot, number> = { A: 0, B: 0, D: 0, E: 0, G: 0 };
    const nameByCat12Avatar = new Map<number, string>();
    for (const s of stocks) {
      if (s.category === 12 && !nameByCat12Avatar.has(s.avatarCode)) {
        nameByCat12Avatar.set(s.avatarCode, s.name);
      }
    }
    for (const av of cat12Codes) {
      const nm = nameByCat12Avatar.get(av) ?? "";
      let slot: CharDecoSlot = classifyCharDecoSlot(nm);
      if (charDecoPools[slot].length === 0) slot = "A";
      const pool = charDecoPools[slot];
      const entry = pool[cdCursor[slot]! % pool.length]!;
      cdCursor[slot]++;
      cat12ByAvatar.set(av, {
        slot,
        objName: entry.objName,
        iconName: entry.iconName,
      });
    }

    const findDirectPack = (iconPath: string): { pack: PackName; name: string } | null => {
      if (!iconPath) return null;
      if (fx.has(iconPath)) return { pack: "Fx", name: iconPath };
      if (charTe.has(iconPath)) return { pack: "CharTE", name: iconPath };
      if (emoTe.has(iconPath)) return { pack: "EmoTE", name: iconPath };
      if (cx.has(iconPath)) return { pack: "Cx", name: iconPath };
      return null;
    };

    for (const s of stocks) {
      const lowPath = s.iconPath.trim().toLowerCase();
      const isPlaceholder = GENERIC_PLACEHOLDER_ICONS.has(lowPath);
      const direct = !isPlaceholder
        ? findDirectPack(s.iconPath) ??
          (lowPath === "item/motionblur" && fx.has("Item/AdvMotionBlur")
            ? { pack: "Fx" as PackName, name: "Item/AdvMotionBlur" }
            : null)
        : null;

      // Category 14: Bomb skins (`CharTE:BombDeco/Bomb001..010`)
      if (s.category === 14) {
        const idx = BOMB_SKIN_BY_AVATAR_CODE[s.avatarCode] ?? (((s.avatarCode - 20001) % 10 + 10) % 10) + 1;
        const pad = String(idx).padStart(3, "0");
        const iconCand = `Icon/Bomb${pad}icon`;
        const iconPack: PackName = charTe.has(iconCand) ? "CharTE" : "Fx";
        const iconName = charTe.has(iconCand) ? iconCand : "Item/Bomb";
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack,
          iconName,
          liveKind: "bombSkin",
          livePack: "CharTE",
          liveObject: `BombDeco/Bomb${pad}`,
          skinIndex: idx,
        });
        continue;
      }

      // Category 4: Fanfare (`EmoTE:Fanfare/Fanfare000..006`)
      if (s.category === 4) {
        const idx = resolveFanfareIndex(s.avatarCode, s.iconPath);
        const pad = String(idx).padStart(3, "0");
        const iconCand = `Icon/Fanfare${pad}`;
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: emoTe.has(iconCand) ? "EmoTE" : "Fx",
          iconName: emoTe.has(iconCand) ? iconCand : "Icon/Slot000",
          liveKind: "fanfare",
          livePack: "EmoTE",
          liveObject: `Fanfare/Fanfare${pad}`,
          skinIndex: idx,
        });
        continue;
      }

      // Category 18: IDDeco (`EmoTE:IDDeco/IDDeco_C001..002`)
      if (s.category === 18) {
        const idx = Math.max(1, Math.min(8, s.avatarCode - 10010));
        const pad = String(idx).padStart(3, "0");
        const iconCand = `Icon/ItemIDdeco_C${pad}`;
        const objCand = emoObjects.byName.has(`IDDeco/IDDeco_C${pad}`)
          ? `IDDeco/IDDeco_C${pad}`
          : "IDDeco/IDDeco_C001";
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: emoTe.has(iconCand) ? "EmoTE" : "Fx",
          iconName: emoTe.has(iconCand) ? iconCand : "Icon/Slot000",
          liveKind: "idDeco",
          livePack: "EmoTE",
          liveObject: objCand,
          skinIndex: idx,
        });
        continue;
      }

      // Category 5: Level Icon Effect (`Fx:Level/Twinkle000..007`, `CLevelIconEffector`)
      if (s.category === 5) {
        const idx = resolveLevelEffectIndex(s.avatarCode);
        const pad = String(idx).padStart(3, "0");
        const resolvedIcon = direct ?? { pack: "Fx" as PackName, name: `Item/LevelIcon${pad}` };
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: fx.has(resolvedIcon.name) ? resolvedIcon.pack : "Fx",
          iconName: fx.has(resolvedIcon.name) ? resolvedIcon.name : "Item/LevelIcon000",
          liveKind: "levelEffect",
          livePack: "Fx",
          liveObject: `Level/Twinkle${pad}`,
          skinIndex: idx,
        });
        continue;
      }

      // Category 6: Level Disguise (`Fx:Shop/LevelChanger`, shifts displayed level)
      if (s.category === 6) {
        const delta = resolveLevelDisguiseDelta(s.avatarCode);
        const resolvedIcon = direct ?? { pack: "Fx" as PackName, name: "Shop/LevelChanger" };
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: resolvedIcon.pack,
          iconName: resolvedIcon.name,
          liveKind: "levelDisguise",
          skinIndex: delta,
        });
        continue;
      }

      // Category 19: AvatarDeco (`CharTE:AvatarDeco/A06_*`)
      if (s.category === 19) {
        const code = resolveAvatarDecoCode(s.avatarCode);
        const iconCand = `Icon/${code}icon`;
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: charTe.has(iconCand) ? "CharTE" : "Fx",
          iconName: charTe.has(iconCand) ? iconCand : "Icon/Slot000",
          liveKind: "avatarDeco",
          livePack: "CharTE",
          liveObject: `AvatarDeco/${code}`,
          subSlot: code.split("_")[1] ?? "20",
        });
        continue;
      }

      // Category 10: SlotDeco (`EmoTE:Slot/Slot{01|04|06|07}_XXXX`)
      if (s.category === 10) {
        const mapped = cat10ByAvatar.get(s.avatarCode) ?? { layer: "Slot01" as SlotDecoLayer, num: "0001" };
        const iconCand = `Icon/${mapped.layer}_${mapped.num}icon`;
        const liveObj = `Slot/${mapped.layer}_${mapped.num}`;
        const resolvedIcon = direct
          ? direct
          : emoTe.has(iconCand)
            ? { pack: "EmoTE" as PackName, name: iconCand }
            : { pack: "Fx" as PackName, name: "Icon/Slot000" };
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: resolvedIcon.pack,
          iconName: resolvedIcon.name,
          liveKind: "slotDeco",
          livePack: "EmoTE",
          liveObject: liveObj,
          subSlot: mapped.layer,
        });
        continue;
      }

      // MotionBlur is a functional trail, not a CharTE character decoration.
      if (s.category === 12 && lowPath === "item/motionblur") {
        this.byStockId.set(s.id, {
          stockId: s.id, category: s.category, avatarCode: s.avatarCode,
          iconPack: direct?.pack ?? "Fx", iconName: direct?.name ?? "Icon/Slot000",
        });
        continue;
      }

      // Category 12: CharDeco (`CharTE:CharDeco/CharDeco_*`)
      if (s.category === 12) {
        const mapped = cat12ByAvatar.get(s.avatarCode);
        const resolvedIcon = direct
          ? direct
          : mapped && mapped.iconName && charTe.has(mapped.iconName)
            ? { pack: "CharTE" as PackName, name: mapped.iconName }
            : { pack: "Fx" as PackName, name: "Icon/Slot000" };
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: resolvedIcon.pack,
          iconName: resolvedIcon.name,
          liveKind: mapped ? "charDeco" : undefined,
          livePack: mapped ? "CharTE" : undefined,
          liveObject: mapped?.objName,
          subSlot: mapped?.slot,
        });
        continue;
      }

      // Category 3: Emotion (`Fx:Shop/Emot*` icon + `EmoTE:Character/C0x_Emotion{A..H}0xx` live object)
      if (s.category === 3) {
        const resolvedIcon = direct ?? { pack: "Fx" as PackName, name: "Shop/EmotSpecial" };
        const cIdx = inferCharCodeFromName(s.name);
        const grp = inferEmotionGroup(s.iconPath, s.name);
        const poolKey = `${cIdx}:${grp}`;
        const pool = emoPools.get(poolKey) ?? [];
        const cur = emoCursors.get(poolKey) ?? 0;
        const suffix = pool.length > 0 ? pool[cur % pool.length]! : `${grp}000`;
        emoCursors.set(poolKey, cur + 1);
        const cPad = String(cIdx).padStart(2, "0");
        const candObj = `Character/C${cPad}_Emotion${suffix}`;
        const liveObj = emoObjects.byName.has(candObj)
          ? candObj
          : emoObjects.byName.has(`Character/C${cPad}_Emotion${grp}000`)
            ? `Character/C${cPad}_Emotion${grp}000`
            : undefined;
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: resolvedIcon.pack,
          iconName: resolvedIcon.name,
          liveKind: "emotion",
          livePack: liveObj ? "EmoTE" : undefined,
          liveObject: liveObj,
          subSlot: suffix,
        });
        continue;
      }

      // Category 11: Package / Set (`CharTE:Icon/SetCharDeco_*`, `EmoTE:Icon/Set_*`, `Fx:Icon/Set_defaulticon`)
      if (s.category === 11) {
        let resolvedIcon = direct;
        if (!resolvedIcon) {
          if (lowPath === "item/set_decorationicon" && emoTe.has("Icon/Set_DecorationIcon")) {
            resolvedIcon = { pack: "EmoTE", name: "Icon/Set_DecorationIcon" };
          } else if (/setchardeco/i.test(lowPath) && emoTe.has("Icon/Set_DecorationIcon")) {
            resolvedIcon = { pack: "EmoTE", name: "Icon/Set_DecorationIcon" };
          } else {
            resolvedIcon = { pack: "Fx", name: "Icon/Set_defaulticon" };
          }
        }
        this.byStockId.set(s.id, {
          stockId: s.id,
          category: s.category,
          avatarCode: s.avatarCode,
          iconPack: resolvedIcon.pack,
          iconName: resolvedIcon.name,
          liveKind: "package",
        });
        continue;
      }

      // Category 1/2 & remaining active/functional items (`Item/RemoteBomb` -> `Item/RadioBomb`, `Item/MotionBlur` -> `Item/AdvMotionBlur`)
      let resolvedIcon = direct;
      if (!resolvedIcon) {
        if (lowPath === "item/fuel" && fx.has("Item/Nitro")) {
          resolvedIcon = { pack: "Fx", name: "Item/Nitro" };
        } else if (lowPath === "item/fuel" && fx.has("Item/Can")) {
          resolvedIcon = { pack: "Fx", name: "Item/Can" };
        } else if (lowPath === "item/remotebomb" && fx.has("Item/RadioBomb")) {
          resolvedIcon = { pack: "Fx", name: "Item/RadioBomb" };
        } else if (lowPath === "item/remotebomb" && fx.has("Bomb/BombRadio")) {
          resolvedIcon = { pack: "Fx", name: "Bomb/BombRadio" };
        } else if (lowPath === "item/motionblur" && fx.has("Item/AdvMotionBlur")) {
          resolvedIcon = { pack: "Fx", name: "Item/AdvMotionBlur" };
        } else {
          resolvedIcon = { pack: "Fx", name: "Icon/Slot000" };
        }
      }
      this.byStockId.set(s.id, {
        stockId: s.id,
        category: s.category,
        avatarCode: s.avatarCode,
        iconPack: resolvedIcon.pack,
        iconName: resolvedIcon.name,
      });
    }
  }

  resolve(stockId: number): ResolvedStockVisual | undefined {
    return this.byStockId.get(stockId);
  }

  /**
   * Expand a stock item (including `cat 11` multi-item bundles via `packagemap.ini`)
   * into all constituent live cosmetic visuals for previewing!
   */
  expandVisuals(stockId: number): ResolvedStockVisual[] {
    const root = this.byStockId.get(stockId);
    if (!root) return [];
    if (root.category !== 11) return [root];
    const kids = this.packageMap.get(stockId);
    if (!kids || kids.length === 0) return [root];
    const out: ResolvedStockVisual[] = [];
    for (const cid of kids) {
      const cv = this.byStockId.get(cid);
      if (cv) out.push(cv);
    }
    return out.length > 0 ? out : [root];
  }

  /**
   * Resolve a live `EmoTE` `Character/C0x_Emotion*` object name for `charCode` (`0..10`):
   * - If `stockId > 0`, adapts the emotion's `subSlot` (`e.g. "H012"` or `"B001"`) to `charCode`
   *   so previewing or using an emotion works on any `C00..C07` character.
   * - Otherwise maps `pose` (`1..8` -> `'A'..'H'`) to `Character/C0x_Emotion{A..H}000`.
   */
  resolveEmotionObject(charCode: number, pose: number, stockId = 0): string | null {
    const c = Math.max(0, Math.min(7, charCode < 0 ? 0 : charCode > 7 ? 0 : charCode));
    const cPad = String(c).padStart(2, "0");
    if (stockId > 0) {
      for (const v of this.expandVisuals(stockId)) {
        if (v.liveKind === "emotion" && v.subSlot) {
          const adapted = `Character/C${cPad}_Emotion${v.subSlot}`;
          if (this.emoObjects.byName.has(adapted)) return adapted;
          if (v.liveObject && this.emoObjects.byName.has(v.liveObject)) return v.liveObject;
        }
      }
    }
    if (pose >= 1 && pose <= 8) {
      const grp = EMOTION_GROUPS[pose - 1]!;
      const defObj = `Character/C${cPad}_Emotion${grp}000`;
      if (this.emoObjects.byName.has(defObj)) return defObj;
    }
    return null;
  }
}
