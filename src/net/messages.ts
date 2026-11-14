// Shared Client <-> Server message schemas carried inside `CClientSocket`
// encrypted binary frames (`OP_RPC = 0x40` via `encodeFrame` / `decodeFrame`).

import type { GameModeId, PlayerInput, SimSnapshot } from "../sim/engine.ts";

export const OP_RPC = 0x40;

export interface UserProfile {
  id: number;
  username: string;
  nickname: string;
  gender: number; // 0 = male, 1 = female
  level: number;
  exp: number;
  nextExp: number;
  lucci: number;
  cash: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  saves: number;
  selectedChar: number; // -1 = random, 0..7 = Bazzi..Ethi
  memo: string;
  school?: string;
  communityLogo?: number; // 0 = none, or `Cx:Etc/CommunityLogo01|02|04|05|06` (`CA.exe.c:203445`)
  equipped: {
    hatStockId: number;
    bombStockId: number;
    slotDecoStockId: number;
    emotionStockId: number;
    fanfareStockId: number;
    idDecoStockId: number;
    slotDecoStockIds?: number[];
    charDecoStockIds?: number[];
    levelEffectIdx?: number;
    levelDisguiseDelta?: number;
    crayonColor?: string;
    battleItemStockId?: number;
  };
}

export interface InventoryRow {
  invId: number;
  stockId: number;
  category: number;
  quantity: number;
  equipped: boolean;
  /** Native inventory fields when supplied by the server; absent means unknown. */
  remainingHours?: number;
  nativeCharacterCode?: number;
  nativeSortKey?: number;
}

export interface CouponRow {
  couponId: number;
  stockId: number;
  discountPct: number;
  quantity: number;
  createdAt: string;
}

export interface SmsRow {
  id: number;
  sender: string;
  receiver: string;
  body: string;
  read: boolean;
  sentAt: string;
}

export interface RankingRow {
  rank: number;
  username: string;
  nickname: string;
  level: number;
  exp: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  winRate: number;
}

export interface NoticeItem {
  id: number;
  category: "公告" | "活動" | "更新";
  title: string;
  date: string;
  body: string;
}

export type RoomKind = "game" | "chat" | "exchange" | "guild";

export interface LobbyUserSummary {
  username: string;
  nickname: string;
  level: number;
  roomId: number; // 0 = in lobby
  levelEffectIdx?: number;
}

export interface RoomOccupantSummary {
  slot: number;
  username: string;
  nickname: string;
  level: number;
  isHost: boolean;
  ready: boolean;
  isAi: boolean;
}

export interface RoomSummary {
  id: number;
  title: string;
  hasPassword: boolean;
  manner?: boolean;
  kind: RoomKind;
  mode: GameModeId;
  mapIndex: number; // fxdynmapinfo index
  mapName: string;
  players: number;
  capacity: number;
  playing: boolean;
  hostName: string;
  createdAtMs?: number;
  startedAtMs?: number;
  occupants?: RoomOccupantSummary[];
}

export interface RoomSlotInfo {
  slot: number; // 0..7
  open: boolean;
  occupied: boolean;
  isAi: boolean;
  aiLevel: 1 | 2 | 3;
  username: string;
  nickname: string;
  level: number;
  charCode: number; // -1 = random, 0..9
  team: number;     // 0..7
  ready: boolean;
  isHost: boolean;
  is2P?: boolean;   // local 2P guest on same client
  slotDecoStockId: number;
  slotDecoStockIds?: number[];
  hatStockId: number;
  charDecoStockIds?: number[];
  bombStockId?: number;
  fanfareStockId?: number;
  idDecoStockId?: number;
  levelEffectIdx?: number;
  emotionPose: number;
}

export interface RoomDetail {
  id: number;
  channelIdx: number;
  title: string;
  hasPassword: boolean;
  manner?: boolean;
  kind: RoomKind;
  guildType?: 0 | 1; // 0 = Ladder (`CAStageLadder`), 1 = Guild War (`CAStageGuild`)
  mode: GameModeId;
  mapIndex: number;
  mapName: string;
  playing: boolean;
  hostSlot: number;
  slots: RoomSlotInfo[];
}

export interface ExchangeState {
  roomId: number;
  mySide: 0 | 1;
  users: [string, string];
  offeredInvIds: [number[], number[]];
  offeredStocks: [{ invId: number; stockId: number; qty: number }[], { invId: number; stockId: number; qty: number }[]];
  offeredLucci: [number, number];
  locked: [boolean, boolean];
  confirmed: [boolean, boolean];
}

export interface MatchRewardRow {
  slot: number;
  name: string;
  team: number;
  won: boolean;
  kills: number;
  deaths?: number;
  maxCombo?: number;
  saves: number;
  expGain: number;
  /** Current progress under the server's EXP curve, in tenths of a percent. */
  expProgressTenths?: number;
  lucciGain: number;
  newLevel: number;
  leveledUp: boolean;
  questionMarks?: number;
  goldFlags?: number;
}

// Client -> Server RPC messages
export type ClientMsg =
  | { type: "auth_login"; username: string; password: string; dual2P?: boolean }
  | { type: "auth_check_id"; username: string }
  | { type: "auth_register"; username: string; password: string; nickname: string; gender: number }
  | { type: "join_channel"; channelIdx: number }
  | { type: "lobby_refresh" }
  | {
      type: "create_room";
      title: string;
      password: string;
      manner?: boolean;
      kind: RoomKind;
      guildType?: 0 | 1;
      mode: GameModeId;
      mapIndex: number;
      capacity: number;
    }
  | { type: "join_room"; roomId: number; password?: string }
  | { type: "quick_join" }
  | { type: "leave_room" }
  | { type: "room_set_map"; mapIndex: number }
  | { type: "room_set_mode"; mode: GameModeId }
  | { type: "room_set_char"; charCode: number; for2P?: boolean }
  | { type: "room_set_team"; team: number; for2P?: boolean }
  | { type: "room_toggle_slot"; slot: number }
  | { type: "room_toggle_2p"; enable: boolean }
  | { type: "room_toggle_ready" }
  | { type: "room_start" }
  | { type: "room_kick"; slot: number }
  | { type: "room_emotion"; pose: number }
  | { type: "match_input"; input: PlayerInput; input2P?: PlayerInput }
  | { type: "chat_send"; text: string }
  | { type: "whisper_send"; to: string; text: string }
  | { type: "speaker_send"; text: string; colorIdx?: number }
  | { type: "shop_buy"; stockId: number; currency: "lucci" | "cash"; qty?: number; couponId?: number; requestId?: string }
  | {
      type: "shop_buy_batch";
      requestId?: string;
      items: { stockId: number; currency: "lucci" | "cash"; qty: number }[];
    }
  | { type: "shop_gift"; stockId: number; toUsername: string; message: string; currency: "lucci" | "cash" }
  | { type: "charge_cash"; amount: number }
  | { type: "gachapon_spin"; preferredStockId?: number }
  | { type: "item_equip"; invId: number; equip: boolean }
  | { type: "select_char"; charCode: number }
  | { type: "inventory_sell"; invId: number }
  | { type: "inventory_delete"; invId: number }
  | { type: "rankings_req"; sortBy?: "wins" | "exp" | "kills" }
  | { type: "user_info_req"; username: string }
  | {
      type: "update_memo";
      memo: string;
      nickname?: string;
      gender?: number;
      school?: string;
      communityLogo?: number;
    }
  | { type: "friend_add"; username: string }
  | { type: "friend_remove"; username: string }
  | { type: "sms_send"; to: string; body: string }
  | { type: "sms_delete"; smsId: number; deleteAll?: boolean }
  | { type: "exchange_offer"; invIds: number[]; lucci: number }
  | { type: "exchange_lock"; locked: boolean }
  | { type: "exchange_confirm" }
  | { type: "coupon_use"; couponId: number }
  | { type: "coupon_delete"; couponId: number }
  | { type: "coupon_redeem"; code: string };

// Server -> Client RPC messages
/** Twelve server-supplied CGameCard catalogue slots, independent of inventory. */
export interface PremiumSlot {
  stockId: number;
  iconName: string;
}

export type ServerMsg =
  | { type: "auth_check_res"; available: boolean; message: string }
  | {
      type: "auth_ok";
      profile: UserProfile;
      inventory: InventoryRow[];
      premiumSlots?: (PremiumSlot | null)[];
      coupons?: CouponRow[];
      friends: { username: string; online: boolean; channelIdx: number }[];
      sms: SmsRow[];
      notices: NoticeItem[];
      channels: { name: string; maxUsers: number; users: number; kind: number; index: number }[];
    }
  | { type: "auth_err"; message: string }
  | { type: "profile_sync"; profile: UserProfile }
  | { type: "inventory_sync"; inventory: InventoryRow[]; profile: UserProfile }
  | { type: "premium_catalog_sync"; slots: (PremiumSlot | null)[] }
  | { type: "channel_joined"; channelIdx: number; channelName: string }
  | { type: "lobby_sync"; rooms: RoomSummary[]; users: LobbyUserSummary[] }
  | { type: "room_joined"; room: RoomDetail; mySlot: number; slot2P: number }
  | { type: "room_sync"; room: RoomDetail }
  | { type: "room_left"; reason?: string }
  | { type: "room_err"; message: string }
  | { type: "match_start"; snapshot: SimSnapshot; mySlot: number; slot2P: number }
  | { type: "match_state"; snapshot: SimSnapshot }
  | { type: "match_result"; rewards: MatchRewardRow[]; winnerTeam: number }
  | { type: "chat_recv"; from: string; text: string; slot?: number; system?: boolean; color?: string }
  | { type: "whisper_recv"; from: string; to: string; text: string }
  | { type: "speaker_recv"; from: string; text: string; colorIdx?: number }
  | { type: "no_speaker"; kind: "speaker" | "color_pencil" }
  | { type: "shop_res"; ok: boolean; message: string; requestId?: string }
  | { type: "gachapon_res"; ok: boolean; stockId: number; lucciJackpot: number; freeTicketsLeft: number; message: string }
  | { type: "rankings_res"; rows: RankingRow[] }
  | { type: "user_info_res"; profile: UserProfile | null }
  | { type: "friends_sync"; friends: { username: string; online: boolean; channelIdx: number }[] }
  | { type: "sms_sync"; sms: SmsRow[]; toast?: string }
  | { type: "exchange_sync"; state: ExchangeState }
  | { type: "exchange_done"; message: string }
  | { type: "coupons_sync"; coupons: CouponRow[]; message?: string };
