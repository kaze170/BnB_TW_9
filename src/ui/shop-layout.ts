/** CShopSlotWnd, CA.exe.c:151980–152200 and 153540–153840.
 * All offsets are relative to the upper-left corner of a shop card. */
export const SHOP_CARD = {
  width: 148, height: 117,
  iconX: 21, iconY: 77,
  buyX: 75, buyY: 57, buyWidth: 35, buyHeight: 20,
  choiceX: 111, choiceY: 57, choiceWidth: 26, choiceHeight: 20,
  nameX: 18, nameY: 81, priceLabelX: 18, priceValueX: 55, priceY: 97,
} as const;

/** Main/sub-tab derivation from ShopItem::4D490E/4D49C3.
 * null sub means the server's UserItem (+52) is required; -1 means hidden. */
export function retailShopCategory(category: number, flags = 0): { main: number; sub: number | null } {
  if (flags & (4 | 8 | 0x20)) return { main: -1, sub: -1 };
  if (flags & 1) return { main: 1, sub: category === 13 ? -1 : 0 };
  switch (category) {
    case 1: return { main: 1, sub: 1 };
    case 2: case 9: case 16: case 33: return { main: 1, sub: 0 };
    case 15: case 17: case 27: return { main: 1, sub: 2 };
    case 3: return { main: 2, sub: 6 };
    case 14: return { main: 2, sub: 0 };
    case 20: return { main: 2, sub: 5 };
    case 12: case 19: return { main: 2, sub: null };
    case 4: return { main: 3, sub: 6 };
    case 5: case 6: return { main: 3, sub: 4 };
    case 18: return { main: 3, sub: 5 };
    case 10: return { main: 3, sub: null };
    case 11: case 23: return { main: 4, sub: 1 };
    case 21: return { main: 4, sub: 2 };
    case 22: return { main: 4, sub: 3 };
    case 24: case 25: return { main: 4, sub: 4 };
    case 26: return { main: 4, sub: 0 };
    default: return { main: -1, sub: -1 };
  }
}

/** sub_4AD... shows +124 first and appends +112 when prices differ. */
export function retailPriceText(price: number, secondaryPrice?: number): string {
  const original = secondaryPrice ?? price;
  return original === price ? String(price) : `${original}------>${price}`;
}

/** CShopSlotWnd::sub_4ACF75 owned-item tooltip. Unknown server hours are
 * intentionally not treated as either a timed or permanent entitlement. */
export function retailOwnedTooltip(category: number, quantity: number, hours: number | undefined,
  strings?: ReadonlyMap<string, string>): { title: string; detail: string | null } {
  const title = strings?.get("AlreadyHaveItem") ?? "有保留";
  if (category === 1 || category === 13 || category === 15) {
    return { title, detail: (strings?.get("Amount") ?? "數量 : %d個").replace("%d", String(quantity)) };
  }
  if (hours === undefined || !Number.isFinite(hours) || hours < 0 || hours >= 240000) return { title, detail: null };
  const n = Math.floor(hours);
  const detail = n >= 8760 ? (strings?.get("ItemRemainsOver365days") ?? "365天以上")
    : (strings?.get("ItemRemainsPeriod") ?? "期限 : %d天 %d小時")
      .replace("%d", String(Math.floor(n / 24))).replace("%d", String(n % 24));
  return { title, detail };
}
