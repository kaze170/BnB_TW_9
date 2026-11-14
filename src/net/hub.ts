// Browser-side Network & Session Store (`src/net/hub.ts`).
// Connects via relative `/ws` using `GameSocket` (`CClientSocket` binary framing)
// and dispatches `OP_RPC` (`0x40`) messages to active stages & modal dialogs.

import { GameSocket } from "./client.ts";
import {
  OP_RPC,
  type ClientMsg,
  type CouponRow,
  type ExchangeState,
  type InventoryRow,
  type LobbyUserSummary,
  type MatchRewardRow,
  type NoticeItem,
  type PremiumSlot,
  type RankingRow,
  type RoomDetail,
  type RoomSummary,
  type ServerMsg,
  type SmsRow,
  type UserProfile,
} from "./messages.ts";
import type { SimSnapshot } from "../sim/engine.ts";

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

export interface ChatLine {
  kind: "chat" | "whisper" | "speaker" | "system";
  from: string;
  to?: string;
  text: string;
  slot?: number;
  color?: string;
  timeMs: number;
}

export const DEFAULT_MACROS: readonly string[] = [
  "大家掰掰～下次再一起玩！",
  "大家好！請多指教 ^^",
  "救命啊～快來幫我戳泡泡！",
  "小心水球！注意走位！",
  "打得好！Nice！",
  "謝謝你救我 >_<",
  "快準備開始囉！",
  "抱歉抱歉～失誤了 QQ",
  "加油加油！！",
  "再來一場吧！",
];

export class ClientHub {
  private sock: GameSocket | null = null;
  connected = false;
  dual2P = false;

  macros: string[] = [...DEFAULT_MACROS];
  readonly refusalList = new Set<string>();
  refuseAllWhispers = false;
  showDangerZone = false;
  showPlayerIds = false;
  showSelfIndicator = true;
  showSpeechBalloons = true;
  teamChatOnly = false;
  onOpenMessenger?: () => void;
  autoReady = false;
  msnEnabled = true;
  recentWhispers: string[] = [];

  profile: UserProfile | null = null;
  inventory: InventoryRow[] = [];
  premiumSlots: (PremiumSlot | null)[] = [];
  coupons: CouponRow[] = [];
  friends: { username: string; online: boolean; channelIdx: number }[] = [];
  sms: SmsRow[] = [];
  notices: NoticeItem[] = [];
  channels: { name: string; maxUsers: number; users: number; kind: number; index: number }[] = [];

  channelIdx = -1;
  channelName = "";
  lobbyRooms: RoomSummary[] = [];
  lobbyUsers: LobbyUserSummary[] = [];

  currentRoom: RoomDetail | null = null;
  mySlot = -1;
  slot2P = -1;

  latestSnapshot: SimSnapshot | null = null;
  lastMatchRewards: MatchRewardRow[] | null = null;
  lastWinnerTeam = -1;
  pendingQuestionMarks = 0;
  pendingLevelUp: { newLevel: number; expGain: number; lucciGain: number } | null = null;

  rankings: RankingRow[] = [];
  inspectedProfile: UserProfile | null = null;
  exchangeState: ExchangeState | null = null;

  readonly chatLog: ChatLine[] = [];
  readonly whisperLog: ChatLine[] = [];
  speakerBanner: { from: string; text: string; colorIdx?: number; untilMs: number } | null = null;
  noSpeakerPromptKind: "speaker" | "color_pencil" | null = null;

  private readonly listeners = new Set<(msg: ServerMsg) => void>();

  constructor() {
    this.loadLocalPrefs();
  }

  private loadLocalPrefs(): void {
    try {
      if (typeof localStorage !== "undefined") {
        const rawM = localStorage.getItem("bnb_tw9_macros");
        if (rawM) {
          const arr = JSON.parse(rawM);
          if (Array.isArray(arr) && arr.length === 10) {
            this.macros = arr.map((x) => String(x ?? "").slice(0, 80));
          }
        }
        const rawR = localStorage.getItem("bnb_tw9_refusal");
        if (rawR) {
          const arr = JSON.parse(rawR);
          if (Array.isArray(arr)) {
            for (const nm of arr) {
              const s = String(nm ?? "").trim();
              if (s) this.refusalList.add(s);
            }
          }
        }
        const rawAr = localStorage.getItem("bnb_tw9_autoready");
        if (rawAr !== null) this.autoReady = rawAr === "1";
        const rawMsn = localStorage.getItem("bnb_tw9_msn");
        if (rawMsn !== null) this.msnEnabled = rawMsn !== "0";
      }
    } catch {
      /* ignore storage restrictions */
    }
  }

  savePrefs(): void {
    this.saveLocalPrefs();
  }

  private saveLocalPrefs(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("bnb_tw9_macros", JSON.stringify(this.macros));
        localStorage.setItem("bnb_tw9_refusal", JSON.stringify([...this.refusalList]));
        localStorage.setItem("bnb_tw9_autoready", this.autoReady ? "1" : "0");
        localStorage.setItem("bnb_tw9_msn", this.msnEnabled ? "1" : "0");
      }
    } catch {
      /* ignore */
    }
  }

  setMacro(digit: number, text: string): void {
    if (digit < 0 || digit > 9) return;
    this.macros[digit] = text.slice(0, 80);
    this.saveLocalPrefs();
  }

  triggerMacro(digit: number): string | null {
    if (digit < 0 || digit > 9) return null;
    const text = (this.macros[digit] ?? "").trim();
    if (!text) return null;
    if (this.connected && this.sock) {
      this.send({ type: "chat_send", text });
    } else {
      this.chatLog.push({
        kind: "chat",
        from: this.profile?.nickname ?? "1P玩家",
        text,
        slot: 0,
        timeMs: performance.now(),
      });
      if (this.chatLog.length > 100) this.chatLog.shift();
    }
    return text;
  }

  addRefusal(name: string): boolean {
    const clean = name.trim().slice(0, 12);
    if (!clean || clean === this.profile?.username || clean === this.profile?.nickname) return false;
    if (this.refusalList.size >= 40) return false;
    const before = this.refusalList.size;
    this.refusalList.add(clean);
    if (this.refusalList.size !== before) {
      this.saveLocalPrefs();
      return true;
    }
    return false;
  }

  removeRefusal(name: string): boolean {
    const ok = this.refusalList.delete(name.trim());
    if (ok) this.saveLocalPrefs();
    return ok;
  }

  isRefused(from: string): boolean {
    const clean = from.trim().toLowerCase();
    for (const r of this.refusalList) {
      if (r.toLowerCase() === clean) return true;
    }
    return false;
  }

  onMessage(fn: (msg: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async ensureConnected(): Promise<void> {
    if (this.connected && this.sock) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws`;

    await new Promise<void>((resolve, reject) => {
      let resolved = false;
      const gs = new GameSocket({
        close: () => {
          this.connected = false;
          this.sock = null;
        },
        error: (err) => {
          if (!resolved) reject(err);
        },
        packet: (op, body) => {
          if (op === 0x01 && !resolved) {
            // CClientSocket key handshake confirmed!
            resolved = true;
            this.connected = true;
            resolve();
            return;
          }
          if (op === OP_RPC) {
            try {
              const msg = JSON.parse(utf8Dec.decode(body)) as ServerMsg;
              this.applyMessage(msg);
              for (const fn of this.listeners) fn(msg);
            } catch {
              /* ignore */
            }
          }
        },
      });
      this.sock = gs;
      gs.connect(wsUrl).catch((e) => {
        if (!resolved) reject(e);
      });
    });
  }

  recordWhisperContact(name: string): void {
    const clean = name.trim();
    if (!clean || clean === this.profile?.username || clean === this.profile?.nickname) return;
    const idx = this.recentWhispers.findIndex((x) => x.toLowerCase() === clean.toLowerCase());
    if (idx >= 0) this.recentWhispers.splice(idx, 1);
    this.recentWhispers.unshift(clean);
    if (this.recentWhispers.length > 7) this.recentWhispers.length = 7;
  }

  send(msg: ClientMsg): void {
    if (msg.type === "whisper_send") {
      this.recordWhisperContact(msg.to);
    }
    if (!this.sock || !this.connected) return;
    this.sock.send(OP_RPC, utf8Enc.encode(JSON.stringify(msg)));
  }

  pushSystemChat(text: string): void {
    this.chatLog.push({ kind: "system", from: "系統", text, timeMs: performance.now() });
    if (this.chatLog.length > 100) this.chatLog.shift();
  }

  private applyMessage(msg: ServerMsg): void {
    switch (msg.type) {
      case "auth_ok":
        this.profile = msg.profile;
        this.inventory = msg.inventory;
        this.premiumSlots = (msg.premiumSlots ?? []).slice(0, 12);
        this.coupons = msg.coupons ?? [];
        this.friends = msg.friends;
        this.sms = msg.sms;
        this.notices = msg.notices;
        this.channels = msg.channels;
        break;
      case "premium_catalog_sync":
        this.premiumSlots = msg.slots.slice(0, 12);
        break;
      case "profile_sync":
        this.profile = msg.profile;
        break;
      case "inventory_sync":
        this.inventory = msg.inventory;
        this.profile = msg.profile;
        break;
      case "channel_joined":
        this.channelIdx = msg.channelIdx;
        this.channelName = msg.channelName;
        this.currentRoom = null;
        this.chatLog.length = 0;
        this.pushSystemChat(`歡迎進入「${msg.channelName}」頻道！`);
        break;
      case "lobby_sync":
        this.lobbyRooms = msg.rooms;
        this.lobbyUsers = msg.users;
        break;
      case "room_joined":
        this.currentRoom = msg.room;
        this.mySlot = msg.mySlot;
        this.slot2P = msg.slot2P;
        this.lastMatchRewards = null;
        this.chatLog.length = 0;
        if (msg.room.kind === "game" || msg.room.kind === "guild") {
          this.pushSystemChat("輸入 /bot 1~3 可加入電腦AI陪練，/nobot 移除AI！");
        }
        break;
      case "room_sync":
        this.currentRoom = msg.room;
        break;
      case "room_left":
        this.currentRoom = null;
        this.mySlot = -1;
        this.slot2P = -1;
        this.latestSnapshot = null;
        this.exchangeState = null;
        break;
      case "match_start":
        this.latestSnapshot = msg.snapshot;
        this.mySlot = msg.mySlot;
        this.slot2P = msg.slot2P;
        this.lastMatchRewards = null;
        break;
      case "match_state":
        this.latestSnapshot = msg.snapshot;
        break;
      case "match_result": {
        this.lastMatchRewards = msg.rewards;
        this.lastWinnerTeam = msg.winnerTeam;
        const myRw = msg.rewards.find((r) => r.slot === this.mySlot);
        if (myRw?.questionMarks && myRw.questionMarks > 0) {
          this.pendingQuestionMarks += myRw.questionMarks;
        }
        if (myRw?.leveledUp) {
          this.pendingLevelUp = {
            newLevel: myRw.newLevel,
            expGain: myRw.expGain,
            lucciGain: myRw.lucciGain,
          };
        }
        break;
      }
      case "gachapon_res":
        this.pendingQuestionMarks = msg.freeTicketsLeft;
        break;
      case "chat_recv": {
        if (!msg.system && this.isRefused(msg.from)) break;
        const line: ChatLine = {
          kind: msg.system ? "system" : "chat",
          from: msg.from,
          text: msg.text,
          slot: msg.slot,
          color: msg.color,
          timeMs: performance.now(),
        };
        this.chatLog.push(line);
        if (this.chatLog.length > 100) this.chatLog.shift();
        break;
      }
      case "whisper_recv": {
        if (msg.from !== this.profile?.nickname && (this.refuseAllWhispers || this.isRefused(msg.from))) {
          break;
        }
        this.recordWhisperContact(msg.from === this.profile?.nickname ? msg.to : msg.from);
        const line: ChatLine = {
          kind: "whisper",
          from: msg.from,
          to: msg.to,
          text: msg.text,
          timeMs: performance.now(),
        };
        this.chatLog.push(line);
        this.whisperLog.push(line);
        if (this.chatLog.length > 100) this.chatLog.shift();
        if (this.whisperLog.length > 100) this.whisperLog.shift();
        break;
      }
      case "speaker_recv": {
        this.speakerBanner = {
          from: msg.from,
          text: msg.text,
          colorIdx: msg.colorIdx ?? 0,
          untilMs: performance.now() + 9000,
        };
        this.chatLog.push({
          kind: "speaker",
          from: msg.from,
          text: msg.text,
          timeMs: performance.now(),
        });
        break;
      }
      case "no_speaker": {
        this.noSpeakerPromptKind = msg.kind;
        break;
      }
      case "rankings_res":
        this.rankings = msg.rows;
        break;
      case "user_info_res":
        this.inspectedProfile = msg.profile;
        break;
      case "friends_sync":
        this.friends = msg.friends;
        break;
      case "sms_sync":
        this.sms = msg.sms;
        if (msg.toast) this.pushSystemChat(msg.toast);
        break;
      case "exchange_sync":
        this.exchangeState = msg.state;
        break;
      case "coupons_sync":
        this.coupons = msg.coupons;
        if (msg.message) this.pushSystemChat(msg.message);
        break;
    }
  }
}
