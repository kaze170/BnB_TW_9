// Stage 11: `CLobbyStage` (`src/stage/channel.ts`).
// Strictly implements `CA.exe` `CLobbyStage` (`Fx:Channel/*`):
//   - `Channel/CAStage` (`800x600` JPEG)
//   - Top bar: `BtShowAll`/`BtWaitRoom (237, 0)`, `BtCreate (350, 0)`, `BtQuickJoin (463, 0)`,
//     `Tab_GameSelect (563, 12)` + `BtGameSelect (628, 13)`, `BtPractice (680, 0)`
//   - 6 room slots (`0x615880`): `[[26,104],[26,185],[26,266],[307,104],[307,185],[307,266]]`
//     (`BtSessionSlot` / `BtSessionSlotExchange` + `BtRoomInfo (+236, +12)`), `BtLeft/Right (259|305, 353)`
//   - 16 user rows (`0x6158B0`): `(643, 111 + 23*i)`, All/Friends toggle `(570, 45, 100, 50)`, `BtLeft/Right (655|701, 495)`
//   - Chat: `CCtrlMsgView (40, 415, 510, 106)`, `VScroll (556, 404, 17, 121)`,
//     `Whisper (42, 535, 74, 12)`, `Edit (155, 535, 366, 12)`, `Dialog/BtSpeaker_Speaker (533, 527)`
//   - `CGlobalButtonDlg (0, 566)`

import type { LoadedSheet } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { RoomKind, RoomSummary } from "../net/messages.ts";
import { WebGpuEditBox, imeHost } from "../ui/ime.ts";
import {
  CharacterPreviewCache,
  SpriteButton,
  SpriteMsgView,
  SpriteScrollBar,
  SpriteWhisperLog,
  drawLevelIcon,
  drawSheetFrame,
  drawSpriteDigits,
  gameKillModeIconFrame,
  handleRetailSlashCommand,
  pointInRect,
} from "../ui/widgets.ts";
import {
  CreateRoomDlg,
  LadderLoadingDlg,
  MultiServerDlg,
  NoticeDlg,
  PasswordDlg,
  RoomInfoDlg,
  ShoutDlg,
  SmsFriendDlg,
  UserInfoDlg,
  WebNoticeDlg,
} from "../ui/dialogs.ts";
import type { AppContext, Stage } from "./types.ts";

const ROOM_SLOTS: readonly [number, number][] = [
  [26, 104],
  [26, 185],
  [26, 266],
  [307, 104],
  [307, 185],
  [307, 266],
];

const SELECT_MODES: {
  label: string;
  createKind: RoomKind;
  filterKind: RoomKind | "all";
  guildType?: 0 | 1;
}[] = [
  { label: "全部", createKind: "game", filterKind: "all" },
  { label: "對戰", createKind: "game", filterKind: "game" },
  { label: "天梯", createKind: "guild", filterKind: "guild", guildType: 0 },
  { label: "公會", createKind: "guild", filterKind: "guild", guildType: 1 },
  { label: "聊天", createKind: "chat", filterKind: "chat" },
  { label: "交換", createKind: "exchange", filterKind: "exchange" },
];

export class LobbyStage implements Stage {
  readonly id = "lobby" as const;

  private bg: LoadedSheet | null = null;
  private slotGameSheet: LoadedSheet | null = null;
  private slotExchSheet: LoadedSheet | null = null;
  private roomInfoSheet: LoadedSheet | null = null;
  private tabSelectSheet: LoadedSheet | null = null;
  private chanImgSheet: LoadedSheet | null = null;
  private fireSessionSheet: LoadedSheet | null = null;
  private fireSessionRingSheet: LoadedSheet | null = null;
  private gameModeImgSheet: LoadedSheet | null = null;
  private killImageSheet: LoadedSheet | null = null;
  private specialRoomCharSheet: LoadedSheet | null = null;
  private hinetLobbyTopSheet: LoadedSheet | null = null;
  private newMapIconSheet: LoadedSheet | null = null;
  private bigLdSheet: LoadedSheet | null = null;
  private guildIconSheet: LoadedSheet | null = null;
  private levelSheet: LoadedSheet | null = null;
  private readonly themeSheets = new Map<string, LoadedSheet | null>();
  private readonly cache = new CharacterPreviewCache();

  private readonly btShowAll: SpriteButton;
  private readonly btWaitRoom: SpriteButton;
  private readonly btCreate: SpriteButton;
  private readonly btQuickJoin: SpriteButton;
  private readonly btGameSelect: SpriteButton;
  private readonly btPractice: SpriteButton;
  private readonly btRoomLeft: SpriteButton;
  private readonly btRoomRight: SpriteButton;
  private readonly btUserLeft: SpriteButton;
  private readonly btUserRight: SpriteButton;
  private readonly btSpeaker: SpriteButton;

  private readonly chatScroll: SpriteScrollBar;
  private readonly chatView: SpriteMsgView;
  private readonly edWhisper: WebGpuEditBox;
  private readonly edChat: WebGpuEditBox;
  private readonly whisperLog: SpriteWhisperLog;

  private waitOnly = false;
  private modeFilterIdx = 0;
  private showFriendsOnly = false;
  private roomPage = 0;
  private userPage = 0;
  private hoveredSlot = -1;
  private infoHoverSlot = -1;

  private unsub: (() => void) | null = null;
  private loaded = false;
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;

    this.btShowAll = new SpriteButton(237, 0, () => {
      this.waitOnly = true;
      this.roomPage = 0;
    });
    this.btWaitRoom = new SpriteButton(237, 0, () => {
      this.waitOnly = false;
      this.roomPage = 0;
    });
    this.btCreate = new SpriteButton(350, 0, () => {
      const kind = this.currentDefaultRoomKind();
      const gType = SELECT_MODES[this.modeFilterIdx]?.guildType ?? 0;
      this.ctx.dialogs.push(new CreateRoomDlg(this.ctx.assets, this.ctx.hub, kind, gType));
    });
    this.btQuickJoin = new SpriteButton(463, 0, () => {
      if (SELECT_MODES[this.modeFilterIdx]?.filterKind === "guild") {
        this.ctx.dialogs.push(
          new LadderLoadingDlg(this.ctx.assets, () => {
            const ladderRoom = this.ctx.hub.lobbyRooms.find(
              (rm) => rm.kind === "guild" && !rm.playing && !rm.hasPassword && rm.players < rm.capacity,
            );
            if (ladderRoom) {
              this.ctx.hub.send({ type: "join_room", roomId: ladderRoom.id });
            } else {
              this.ctx.hub.send({
                type: "create_room",
                title: "公會天梯配對戰",
                password: "",
                manner: true,
                kind: "guild",
                mode: 0,
                mapIndex: -1,
                capacity: 4,
              });
            }
          }),
        );
        return;
      }
      this.ctx.hub.send({ type: "quick_join" });
    });
    this.btGameSelect = new SpriteButton(628, 13, () => {
      this.modeFilterIdx = (this.modeFilterIdx + 1) % SELECT_MODES.length;
      this.roomPage = 0;
    });
    this.btPractice = new SpriteButton(680, 0, () => {
      void this.ctx.goto("practice");
    });

    this.btRoomLeft = new SpriteButton(259, 353, () => {
      this.roomPage = Math.max(0, this.roomPage - 1);
    });
    this.btRoomRight = new SpriteButton(305, 353, () => {
      const maxP = Math.max(0, Math.ceil(this.filteredRooms().length / 6) - 1);
      this.roomPage = Math.min(maxP, this.roomPage + 1);
    });

    this.btUserLeft = new SpriteButton(655, 495, () => {
      this.userPage = Math.max(0, this.userPage - 1);
    });
    this.btUserRight = new SpriteButton(701, 495, () => {
      this.userPage++;
    });

    this.btSpeaker = new SpriteButton(533, 527, () => {
      this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub));
    });

    this.chatScroll = new SpriteScrollBar(556, 404, 17, 121);
    this.chatView = new SpriteMsgView(40, 415, 510, 106, this.chatScroll);

    this.edWhisper = new WebGpuEditBox({
      x: 42,
      y: 535,
      w: 74,
      h: 12,
      maxLength: 16,
      textColor: [0.06, 0.24, 0.12, 1],
      onTab: () => this.edChat.focus(),
      onEnter: () => this.edChat.focus(),
    });
    this.edChat = new WebGpuEditBox({
      x: 155,
      y: 535,
      w: 366,
      h: 12,
      maxLength: 80,
      textColor: [0.05, 0.08, 0.16, 1],
      onTab: () => this.edWhisper.focus(),
      onEnter: () => this.sendChat(),
    });
    this.whisperLog = new SpriteWhisperLog(116, 529, (target) => {
      this.edWhisper.value = target;
      this.edChat.focus();
    });
  }

  private currentDefaultRoomKind(): RoomKind {
    const chName = this.ctx.hub.channelName;
    if (chName.includes("交換") || chName.includes("市集")) return "exchange";
    if (chName.includes("聊天")) return "chat";
    return SELECT_MODES[this.modeFilterIdx]?.createKind ?? "game";
  }

  async enter(): Promise<void> {
    this.ctx.practiceConfig = null;
    this.ctx.sound.playBgm("StageChannel");
    await this.ctx.globalBar.load(this.ctx.assets);

    if (!this.loaded) {
      this.loaded = true;
      const { assets } = this.ctx;
      await assets.fx.prefetch([
        "Channel/CAStage",
        "Channel/BtShowAll",
        "Channel/BtWaitRoom",
        "Channel/BtCreate",
        "Channel/BtQuickJoin",
        "Channel/BtGameSelect",
        "Channel/Tab_GameSelect",
        "Channel/BtPractice",
        "Channel/BtSessionSlot",
        "Channel/BtSessionSlotExchange",
        "Channel/BtRoomInfo",
        "Channel/BtLeft",
        "Channel/BtRight",
        "Channel/ChannelImg",
        "Channel/FireSessionIcon",
        "Etc/GameModeImg",
        "Game/Kill_Image",
        "Etc/SpecialRoomChar",
        "Event/Hinet_LobyTop",
        "Dialog/BtSpeaker_Speaker",
      ]);
      const [bg, sa, wr, cr, qj, gs, tgs, pr, sg, se, ri, bl, br, ci, fsi, sp, lv, gmi, ki, src, hlt, nmi, bLd, gIco] =
        await Promise.all([
          assets.loadSheet("Fx", "Channel/CAStage"),
          assets.loadSheet("Fx", "Channel/BtShowAll"),
          assets.loadSheet("Fx", "Channel/BtWaitRoom"),
          assets.loadSheet("Fx", "Channel/BtCreate"),
          assets.loadSheet("Fx", "Channel/BtQuickJoin"),
          assets.loadSheet("Fx", "Channel/BtGameSelect"),
          assets.loadSheet("Fx", "Channel/Tab_GameSelect"),
          assets.loadSheet("Fx", "Channel/BtPractice"),
          assets.loadSheet("Fx", "Channel/BtSessionSlot"),
          assets.loadSheet("Fx", "Channel/BtSessionSlotExchange"),
          assets.loadSheet("Fx", "Channel/BtRoomInfo"),
          assets.loadSheet("Fx", "Channel/BtLeft"),
          assets.loadSheet("Fx", "Channel/BtRight"),
          assets.loadSheet("Fx", "Channel/ChannelImg"),
          assets.loadSheet("Fx", "Channel/FireSessionIcon"),
          assets.loadSheet("Fx", "Dialog/BtSpeaker_Speaker"),
          assets.loadSheet("Cx", "Etc/LevelIcons"),
          assets.loadSheet("Fx", "Etc/GameModeImg"),
          assets.loadSheet("Fx", "Game/Kill_Image"),
          assets.loadSheet("Fx", "Etc/SpecialRoomChar"),
          assets.loadSheet("Fx", "Event/Hinet_LobyTop"),
          assets.loadSheet("Fx", "Theme/Newmap_Icon"),
          assets.loadSheet("Fx", "Ladder/Big_LD"),
          assets.loadSheet("Fx", "Etc/GuildIcon"),
          this.chatScroll.load(assets),
          this.whisperLog.load(assets),
        ]);
      this.bg = bg;
      this.slotGameSheet = sg;
      this.slotExchSheet = se;
      this.roomInfoSheet = ri;
      this.tabSelectSheet = tgs;
      this.chanImgSheet = ci;
      this.fireSessionSheet = fsi;
      this.fireSessionRingSheet = fsi;
      this.gameModeImgSheet = gmi;
      this.killImageSheet = ki;
      this.specialRoomCharSheet = src;
      this.hinetLobbyTopSheet = hlt;
      this.newMapIconSheet = nmi;
      this.bigLdSheet = bLd;
      this.guildIconSheet = gIco;
      this.levelSheet = lv;

      this.btShowAll.bindSheet(sa, 111, 68);
      this.btWaitRoom.bindSheet(wr, 111, 68);
      this.btCreate.bindSheet(cr, 111, 68);
      this.btQuickJoin.bindSheet(qj, 215, 68);
      this.btGameSelect.bindSheet(gs, 28, 30);
      this.btPractice.bindSheet(pr, 111, 68);
      this.btRoomLeft.bindSheet(bl, 43, 22);
      this.btRoomRight.bindSheet(br, 43, 22);
      this.btUserLeft.bindSheet(bl, 43, 22);
      this.btUserRight.bindSheet(br, 43, 22);
      this.btSpeaker.bindSheet(sp, 41, 28);
    }

    this.ctx.hub.send({ type: "lobby_refresh" });

    this.unsub?.();
    this.unsub = this.ctx.hub.onMessage((msg) => {
      if (msg.type === "room_joined") {
        const k = msg.room.kind;
        if (k === "chat") void this.ctx.goto("chatting");
        else if (k === "exchange") void this.ctx.goto("exchange");
        else void this.ctx.goto("prepare");
      } else if (msg.type === "room_err") {
        this.ctx.dialogs.push(new NoticeDlg(this.ctx.assets, "", [msg.message]));
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

    // Retail `CChatStage` slash commands (`CA.exe.c:74720..75240`)
    if (
      handleRetailSlashCommand(text, this.ctx.assets, this.ctx.hub, {
        onOpenUserInfo: (target) =>
          this.ctx.dialogs.push(
            new UserInfoDlg(this.ctx.assets, this.ctx.hub, target, (u) => {
              this.ctx.dialogs.push(new SmsFriendDlg(this.ctx.assets, this.ctx.hub, u));
            }),
          ),
        onSetWhisperTarget: (target) => {
          this.edWhisper.value = target;
        },
        onOpenShout: () => this.ctx.dialogs.push(new ShoutDlg(this.ctx.assets, this.ctx.hub)),
        onOpenWebNotice: () => this.ctx.dialogs.push(new WebNoticeDlg(this.ctx.assets, this.ctx.hub)),
        onOpenMultiServer: () => this.ctx.dialogs.push(new MultiServerDlg(this.ctx.assets)),
      })
    ) {
      return;
    }

    if (text.startsWith("/")) {
      const [cmdRaw, ...rest] = text.split(/\s+/);
      const cmd = (cmdRaw ?? "").toLowerCase();
      if (cmd === "/join" || cmd === "/go") {
        const rid = Number(rest[0] ?? "0");
        if (rid > 0) this.ctx.hub.send({ type: "join_room", roomId: rid });
        return;
      }
      if (cmd === "/st") {
        const rid = Number(rest[0] ?? "0");
        const rm = this.ctx.hub.lobbyRooms.find((r) => r.id === rid);
        if (rm) this.ctx.dialogs.push(new RoomInfoDlg(this.ctx.assets, rm, this.ctx.hub, this.ctx.dialogs));
        return;
      }
      if ((cmd === "/w" || cmd === "/to" || cmd === "/whisper") && rest.length >= 2) {
        const to = rest[0]!;
        this.edWhisper.value = to;
        this.ctx.hub.send({ type: "whisper_send", to, text: rest.slice(1).join(" ") });
        return;
      }
      if (cmd === "/chat") {
        this.ctx.dialogs.push(new CreateRoomDlg(this.ctx.assets, this.ctx.hub, "chat"));
        return;
      }
      if (cmd === "/trade" || cmd === "/exchange") {
        this.ctx.dialogs.push(new CreateRoomDlg(this.ctx.assets, this.ctx.hub, "exchange"));
        return;
      }
      if (cmd === "/ladder") {
        this.ctx.dialogs.push(new CreateRoomDlg(this.ctx.assets, this.ctx.hub, "guild", 0));
        return;
      }
      if (cmd === "/guild") {
        this.ctx.dialogs.push(new CreateRoomDlg(this.ctx.assets, this.ctx.hub, "guild", 1));
        return;
      }
    }

    const whisperTo = this.edWhisper.value.trim();
    if (whisperTo && whisperTo.toLowerCase() !== "a") {
      this.ctx.hub.send({ type: "whisper_send", to: whisperTo, text });
    } else {
      this.ctx.hub.send({ type: "chat_send", text });
    }
  }

  private filteredRooms(): RoomSummary[] {
    let list = this.ctx.hub.lobbyRooms;
    if (this.waitOnly) list = list.filter((r) => !r.playing);
    const fk = SELECT_MODES[this.modeFilterIdx]?.filterKind ?? "all";
    if (fk !== "all") list = list.filter((r) => r.kind === fk);
    return list;
  }

  private clickRoom(rm: RoomSummary): void {
    if (rm.hasPassword) {
      this.ctx.dialogs.push(
        new PasswordDlg(this.ctx.assets, (pw) => {
          this.ctx.hub.send({ type: "join_room", roomId: rm.id, password: pw });
        }),
      );
    } else {
      this.ctx.hub.send({ type: "join_room", roomId: rm.id });
    }
  }

  private activeButtons(): SpriteButton[] {
    return [
      this.waitOnly ? this.btWaitRoom : this.btShowAll,
      this.btCreate,
      this.btQuickJoin,
      this.btGameSelect,
      this.btPractice,
      this.btRoomLeft,
      this.btRoomRight,
      this.btUserLeft,
      this.btUserRight,
      this.btSpeaker,
    ];
  }

  tick(): void {}

  onMouseMove(mx: number, my: number): void {
    this.ctx.globalBar.onMouseMove(mx, my, this.ctx.sound);
    this.whisperLog.onMouseMove(
      mx,
      my,
      this.ctx.hub,
      this.ctx.hub.lobbyUsers.map((u) => u.nickname),
    );
    for (const b of this.activeButtons()) b.onMouseMove(mx, my, this.ctx.sound);
    this.chatScroll.onMouseMove(mx, my);

    const prevHovered = this.hoveredSlot;
    this.hoveredSlot = -1;
    this.infoHoverSlot = -1;
    const rooms = this.filteredRooms();
    for (let i = 0; i < 6; i++) {
      if (!rooms[this.roomPage * 6 + i]) continue;
      const [sx, sy] = ROOM_SLOTS[i]!;
      if (pointInRect(mx, my, { x: sx + 236, y: sy + 12, w: 25, h: 25 })) {
        this.infoHoverSlot = i;
        break;
      }
      if (pointInRect(mx, my, { x: sx, y: sy, w: 274, h: 76 })) {
        this.hoveredSlot = i;
        if (i !== prevHovered) this.ctx.sound.playSfx("Wave/MouseMove_2", 0.35);
        break;
      }
    }
  }

  onMouseDown(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseDown(mx, my)) return;
    if (
      this.whisperLog.onMouseDown(
        mx,
        my,
        this.ctx.sound,
        this.ctx.hub,
        this.ctx.hub.lobbyUsers.map((u) => u.nickname),
      )
    ) {
      return;
    }
    if (this.edWhisper.handleMouseDown(mx, my) || this.edChat.handleMouseDown(mx, my)) return;
    for (const b of this.activeButtons()) {
      if (b.onMouseDown(mx, my)) return;
    }
    if (this.chatScroll.onMouseDown(mx, my)) return;

    // Right panel All / Friends toggle hotspot `(570, 45, 100, 50)` (`CA.exe` `L93555`)
    if (pointInRect(mx, my, { x: 570, y: 45, w: 180, h: 50 })) {
      this.showFriendsOnly = !this.showFriendsOnly;
      this.userPage = 0;
      this.ctx.sound.playSfx("ButtonDown_0", 0.55);
      return;
    }

    // 6 Room Slots
    const rooms = this.filteredRooms();
    for (let i = 0; i < 6; i++) {
      const rm = rooms[this.roomPage * 6 + i];
      if (!rm) continue;
      const [sx, sy] = ROOM_SLOTS[i]!;
      if (pointInRect(mx, my, { x: sx + 236, y: sy + 12, w: 25, h: 25 })) {
        this.ctx.sound.playSfx("ButtonDown_0", 0.6);
        this.ctx.dialogs.push(new RoomInfoDlg(this.ctx.assets, rm, this.ctx.hub, this.ctx.dialogs));
        return;
      }
      if (pointInRect(mx, my, { x: sx, y: sy, w: 274, h: 76 })) {
        this.ctx.sound.playSfx("ButtonDown_0", 0.65);
        this.clickRoom(rm);
        return;
      }
    }

    // 16 User Rows `(598, uy - 2, 178, 22)` (`CA.exe.c:96775..96838`)
    const users = this.visibleUsers();
    for (let i = 0; i < 16; i++) {
      const u = users[this.userPage * 16 + i];
      if (!u) break;
      const uy = 111 + i * 23;
      if (pointInRect(mx, my, { x: 598, y: uy - 2, w: 178, h: 22 })) {
        this.ctx.sound.playSfx("ButtonDown_0", 0.55);
        this.ctx.dialogs.push(
          new UserInfoDlg(this.ctx.assets, this.ctx.hub, u.username, (target) => {
            this.ctx.dialogs.push(new SmsFriendDlg(this.ctx.assets, this.ctx.hub, target));
          }),
        );
        return;
      }
    }
  }

  onMouseUp(mx: number, my: number): void {
    if (this.ctx.globalBar.onMouseUp(mx, my, this.ctx.sound)) return;
    if (
      this.whisperLog.onMouseUp(
        mx,
        my,
        this.ctx.sound,
        this.ctx.hub,
        this.ctx.hub.lobbyUsers.map((u) => u.nickname),
      )
    ) {
      return;
    }
    for (const b of this.activeButtons()) {
      if (b.onMouseUp(mx, my, this.ctx.sound)) return;
    }
    this.chatScroll.onMouseUp(mx, my, this.ctx.sound);
  }

  onWheel(deltaY: number, mx: number, my: number): void {
    if (my >= 400 && mx < 580) {
      this.chatScroll.scrollBy(deltaY > 0 ? 2 : -2);
    } else if (mx < 580) {
      const maxP = Math.max(0, Math.ceil(this.filteredRooms().length / 6) - 1);
      this.roomPage = Math.max(0, Math.min(maxP, this.roomPage + (deltaY > 0 ? 1 : -1)));
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.key === "F1") {
      e.preventDefault();
      this.ctx.globalBar.btMenu.onClick?.();
    }
  }

  private visibleUsers(): {
    username: string;
    nickname: string;
    level: number;
    online: boolean;
    levelEffectIdx?: number;
  }[] {
    if (this.showFriendsOnly) {
      return this.ctx.hub.friends.map((f) => ({
        username: f.username,
        nickname: f.username,
        level: 1,
        online: f.online,
      }));
    }
    return this.ctx.hub.lobbyUsers.map((u) => ({
      username: u.username,
      nickname: u.nickname,
      level: u.level,
      online: true,
      levelEffectIdx: u.levelEffectIdx,
    }));
  }

  private getThemeSheet(art: string): LoadedSheet | null {
    if (!art) return null;
    if (this.themeSheets.has(art)) return this.themeSheets.get(art) ?? null;
    this.themeSheets.set(art, null);
    void this.ctx.assets.loadSheet("Fx", `Theme/${art}`).then((s) => {
      this.themeSheets.set(art, s);
    });
    return null;
  }

  render(r: SpriteRenderer, nowMs: number): void {
    drawSheetFrame(r, this.bg, 0, 0, 0, { w: 800, h: 600 });

    // Channel title at `(104, 56)` centered (`Event/Hinet_LobyTop` `160x53` on HiNet channels, `CA.exe.c:99899`)
    const chTitle = this.ctx.hub.channelName || "BnB自由-1";
    if (chTitle.toLowerCase().includes("hinet") && this.hinetLobbyTopSheet) {
      drawSheetFrame(r, this.hinetLobbyTopSheet, 0, 24, 15);
    }
    r.drawText(chTitle, 104, 56, {
      align: "center",
      color: [1, 0.96, 0.72, 1],
      outlineColor: [0.04, 0.14, 0.34, 0.95],
    });

    // Mode filter badge `Channel/Tab_GameSelect` `(563, 12)`
    drawSheetFrame(r, this.tabSelectSheet, this.modeFilterIdx % 13, 563, 12);

    // 6 Room Slots (`0x615880`)
    const rooms = this.filteredRooms();
    const maxRoomP = Math.max(0, Math.ceil(rooms.length / 6) - 1);
    if (this.roomPage > maxRoomP) this.roomPage = maxRoomP;
    this.btRoomLeft.enabled = this.roomPage > 0;
    this.btRoomRight.enabled = this.roomPage < maxRoomP;

    for (let i = 0; i < 6; i++) {
      const rm = rooms[this.roomPage * 6 + i];
      if (!rm) continue;
      const [sx, sy] = ROOM_SLOTS[i]!;
      const sh = rm.kind === "exchange" ? this.slotExchSheet : this.slotGameSheet;
      const frame = rm.playing ? 3 : this.hoveredSlot === i ? 2 : 0;
      drawSheetFrame(r, sh, frame, sx, sy);

      // Exact `CA.exe.c:100012..100180`:
      //   - `Channel/FireSession` (`54x54` flame ring) at `(sx + 11, sy + 10)` on active rooms
      //   - 3-digit room number (`Channel/ChannelImg` frames `0..9`, stride `13px`) at `(sx + 15, sy + 20)`
      //     (or `Etc/SpecialRoomChar` `(sx + 15, sy + 29)` + 2 digits `(sx + 28, sy + 20)` when `id >= 10000`)
      //   - `Etc/GameModeImg` (`0=Manner`, `1=Free`, `29x22`) at `(sx + 219, sy + 13)`
      //   - `Game/Kill_Image` (`36..39`, `22x22`) at `(sx + 198, sy + 13)` when `mode !== 0`
      //   - Password lock `ChannelImg[12]` (`16x22`) at `(sx + (modeIcon !== null ? 177 : 198), sy + 13)`
      //   - `Theme/<art>` frame `1` (`12x12`) at `(sx + 105, sy + 52)`
      //   - Status badge (`50` playing, `51` full, `52` waiting) at `(sx + 6, sy + 46)`
      if (this.fireSessionRingSheet && rm.playing && rm.players >= Math.max(4, rm.capacity - 2)) {
        const ringFrames = Math.max(1, this.fireSessionRingSheet.sheet?.rects.length ?? 1);
        drawSheetFrame(r, this.fireSessionRingSheet, Math.floor(nowMs / 120) % ringFrames, sx + 11, sy + 10);
      }

      if (this.chanImgSheet) {
        if (rm.id >= 10000 && this.specialRoomCharSheet) {
          drawSheetFrame(r, this.specialRoomCharSheet, 0, sx + 15, sy + 29);
          drawSpriteDigits(r, this.chanImgSheet, sx + 28, sy + 20, 13, 2, rm.id - 10000, 0);
        } else {
          drawSpriteDigits(r, this.chanImgSheet, sx + 15, sy + 20, 13, 3, rm.id, 0);
        }
        const modeIcon = rm.kind === "game" || rm.kind === "guild" ? gameKillModeIconFrame(rm.mode) : null;
        if (modeIcon !== null && this.killImageSheet) {
          drawSheetFrame(r, this.killImageSheet, modeIcon, sx + 198, sy + 13);
        }
        if (rm.hasPassword) {
          drawSheetFrame(r, this.chanImgSheet, 12, sx + (modeIcon !== null ? 177 : 198), sy + 13);
        }
        if (rm.kind !== "exchange" && this.gameModeImgSheet) {
          drawSheetFrame(r, this.gameModeImgSheet, rm.manner === false ? 1 : 0, sx + 219, sy + 13);
        }
        if (rm.kind === "guild") {
          drawSheetFrame(r, this.guildIconSheet, 0, sx + 86, sy + 52);
          drawSheetFrame(r, this.bigLdSheet, Math.min(8, rm.id % 9), sx + 174, sy + 52);
        }
        if (rm.kind === "game" || rm.kind === "guild") {
          const mapObj =
            rm.mapIndex < 0 ? undefined : this.ctx.assets.tables?.mapInfo.maps.find((m) => m.index === rm.mapIndex);
          const art = mapObj
            ? mapObj.art && mapObj.art !== "none"
              ? mapObj.art
              : mapObj.family || "Random"
            : "Random";
          const themeSh = this.getThemeSheet(art);
          if (themeSh && (themeSh.sheet?.rects.length ?? 0) > 1) {
            drawSheetFrame(r, themeSh, 1, sx + 105, sy + 52);
          }
          if (mapObj?.isNew && this.newMapIconSheet) {
            drawSheetFrame(r, this.newMapIconSheet, 0, sx + 95, sy + 54);
          }
        }
        const statusFrame = rm.playing ? 50 : rm.players >= rm.capacity ? 51 : 52;
        drawSheetFrame(r, this.chanImgSheet, statusFrame, sx + 6, sy + 46);
        if (this.fireSessionSheet && rm.playing && rm.players >= Math.max(4, rm.capacity - 2)) {
          drawSheetFrame(r, this.fireSessionSheet, Math.floor(nowMs / 150) % 4, sx + 6, sy + 46);
        }
      }

      // Room title at `(sx + 61, sy + 19)` in retail `RGB(0, 0x5C, 0xA4)`
      r.drawText(rm.title.slice(0, 14), sx + 61, sy + 19, {
        color: [0, 0.36, 0.64, 1],
      });
      // Map name at `(sx + 121, sy + 52)` & count `"%d/%d"` at `(sx + 232, sy + 52)` in `RGB(0xFF, 0xDE, 0x14)`
      r.drawText(rm.mapName.slice(0, 10), sx + 121, sy + 52, {
        color: [1, 0.87, 0.08, 1],
        outlineColor: [0.06, 0.14, 0.28, 0.9],
      });
      r.drawText(`${rm.players}/${rm.capacity}`, sx + 232, sy + 52, {
        color: [1, 0.87, 0.08, 1],
        outlineColor: [0.06, 0.14, 0.28, 0.9],
      });

      // `Channel/BtRoomInfo` at `(+236, +12)`
      drawSheetFrame(r, this.roomInfoSheet, this.infoHoverSlot === i ? 2 : 0, sx + 236, sy + 12);
    }

    // 16 User Rows `uy = 111 + 23*i`: level `(604, uy - 2)`, nickname `(643, uy)` (`CA.exe.c:96775..96838`)
    const users = this.visibleUsers();
    const maxUserP = Math.max(0, Math.ceil(users.length / 16) - 1);
    if (this.userPage > maxUserP) this.userPage = maxUserP;
    this.btUserLeft.enabled = this.userPage > 0;
    this.btUserRight.enabled = this.userPage < maxUserP;

    const tick = Math.floor(nowMs / 30);
    for (let i = 0; i < 16; i++) {
      const u = users[this.userPage * 16 + i];
      if (!u) break;
      const uy = 111 + i * 23;
      drawLevelIcon(
        r,
        this.levelSheet,
        u.level,
        604,
        uy - 2,
        this.cache.getTwinkleSheet(this.ctx.assets, u.levelEffectIdx),
        tick,
        this.cache.getRotateSheet(this.ctx.assets, u.levelEffectIdx),
      );
      r.drawText(u.nickname.slice(0, 12), 643, uy, {
        color: u.online ? [0.06, 0.14, 0.28, 1] : [0.48, 0.52, 0.58, 1],
      });
    }

    // Chat `CCtrlMsgView` & Edit wells
    this.chatView.syncChatLog(r, this.ctx.hub.chatLog, false);
    this.chatView.render(r);
    this.edWhisper.render(r, nowMs);
    this.edChat.render(r, nowMs);

    for (const b of this.activeButtons()) b.render(r);
    this.whisperLog.render(
      r,
      this.ctx.hub,
      this.ctx.hub.lobbyUsers.map((u) => u.nickname),
    );
    this.ctx.globalBar.render(r, this.ctx.hub);
  }
}
