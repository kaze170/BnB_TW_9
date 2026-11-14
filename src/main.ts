// Browser entrypoint: WebGPU 800x600 canvas, GameAssets, SoundManager,
// ClientHub, DialogStack, GlobalButtonBar (`CGlobalButtonDlg`), retail `Cx:Etc/Cursor`,
// and `CMainWnd` 11-stage state machine (`sub_4C8CE5`).

import { GameAssets, type LoadedSheet } from "./data/assets.ts";
import { SoundManager } from "./audio/sound.ts";
import { SpriteRenderer, requestDevice } from "./gfx/renderer.ts";
import { ClientHub } from "./net/hub.ts";
import { imeHost } from "./ui/ime.ts";
import { GlobalButtonBar, drawSheetFrame } from "./ui/widgets.ts";
import {
  BnbMessengerDlg,
  ColorPencilDlg,
  DialogStack,
  HelpDlg,
  KeyMapDlg,
  MyPageDlg,
  NoSpeakDlg,
  NoticeDlg,
  OptionDlg,
  RefusalListDlg,
  SmsFriendDlg,
  SpeakerPopupOverlay,
  UserInfoDlg,
} from "./ui/dialogs.ts";
import { TitleStage } from "./stage/title.ts";
import { LoginStage } from "./stage/login.ts";
import { CreditStage } from "./stage/credit.ts";
import { SelectServerStage } from "./stage/selectserver.ts";
import { LobbyStage } from "./stage/channel.ts";
import { PrepareStage } from "./stage/prepare.ts";
import { GameStage } from "./stage/game.ts";
import { ShopStage } from "./stage/shop.ts";
import { ChattingStage } from "./stage/chatting.ts";
import { ExchangeStage } from "./stage/exchange.ts";
import type { AppContext, Stage, StageId } from "./stage/types.ts";

const SCREEN_W = 800;
const SCREEN_H = 600;

async function boot(): Promise<void> {
  const frame = document.getElementById("frame") as HTMLElement | null;
  const canvas = (document.getElementById("screen") ??
    document.getElementById("game") ??
    document.querySelector("canvas")) as HTMLCanvasElement | null;
  const fallback = document.getElementById("fallback") as HTMLElement | null;
  if (!canvas) throw new Error("Missing #screen canvas");

  let renderer: SpriteRenderer;
  try {
    const device = await requestDevice();
    renderer = new SpriteRenderer(device, canvas, SCREEN_W, SCREEN_H);
  } catch (err) {
    console.error("WebGPU initialization failed:", err);
    if (fallback) {
      fallback.style.display = "flex";
      fallback.textContent = `您的瀏覽器未啟用 WebGPU 支援 (${err instanceof Error ? err.message : String(err)})`;
    }
    return;
  }

  // Fit 800x600 aspect-preserved inside viewport (1:1 crisp at >=800x600, scaled down if smaller)
  const fitCanvas = (): void => {
    const scale = Math.min(1, window.innerWidth / SCREEN_W, window.innerHeight / SCREEN_H);
    const cssW = Math.max(400, Math.floor(SCREEN_W * scale));
    const cssH = Math.max(300, Math.floor(SCREEN_H * scale));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    if (frame) {
      frame.style.width = `${cssW}px`;
      frame.style.height = `${cssH}px`;
    }
  };
  fitCanvas();
  window.addEventListener("resize", fitCanvas);

  const assets = new GameAssets("/game");
  assets.attachRenderer(renderer);
  const sound = new SoundManager(assets);
  const hub = new ClientHub();
  const dialogs = new DialogStack();
  const speakerOverlay = new SpeakerPopupOverlay();

  if (fallback) {
    fallback.style.display = "flex";
    fallback.textContent = "正在載入爆爆王原始資源檔...";
  }
  await assets.boot();
  if (fallback) {
    fallback.style.display = "none";
    fallback.textContent = "";
  }
  if (assets.font) {
    renderer.setFont(assets.font);
  }

  // Custom retail cursor (`Cx:Etc/Cursor`: frame 0 normal, frame 1 down) + `CImeStatusWnd` (`Cx:Etc/ImeStatus`)
  let cursorSheet: LoadedSheet | null = null;
  let imeStatusSheet: LoadedSheet | null = null;
  void assets.loadSheet("Cx", "Etc/Cursor").then((s) => {
    cursorSheet = s;
    if (s) canvas.style.cursor = "none";
  });
  void assets.loadSheet("Cx", "Etc/ImeStatus").then((s) => {
    imeStatusSheet = s;
  });
  void speakerOverlay.load(assets);

  let currentId: StageId = "title";

  const openMyPage = (): void => {
    dialogs.push(
      new MyPageDlg(assets, hub, () => {
        if (currentId !== "shop") void ctx.goto("shop");
      }),
    );
  };
  const openMessenger = (initialTarget?: string): void => {
    if (initialTarget) {
      dialogs.push(new SmsFriendDlg(assets, hub, initialTarget));
      return;
    }
    dialogs.push(
      new BnbMessengerDlg(assets, hub, {
        onOpenSms: (target) => dialogs.push(new SmsFriendDlg(assets, hub, target ?? "")),
        onOpenRefusal: () => dialogs.push(new RefusalListDlg(assets, hub)),
      }),
    );
  };
  const openMyInfo = (): void => {
    dialogs.push(new UserInfoDlg(assets, hub, undefined, (u) => openMessenger(u)));
  };
  hub.onOpenMessenger = () => openMessenger();

  // Global bottom bar (`CGlobalButtonDlg` `(0, 566, 800, 34)` + `CGlobalButtonMenuDlg`)
  const globalBar = new GlobalButtonBar({
    onBack: () => {
      if (currentId === "prepare" || currentId === "chatting" || currentId === "exchange") {
        hub.send({ type: "leave_room" });
        void ctx.goto("lobby");
      } else if (currentId === "practice") {
        void ctx.goto("login");
      } else if (currentId === "shop") {
        void ctx.goto(ctx.returnStageAfterModal);
      } else if (currentId === "lobby") {
        void ctx.goto("selectserver");
      } else if (currentId === "selectserver") {
        void ctx.goto("login");
      }
    },
    onExit: () => {
      dialogs.push(
        new NoticeDlg(
          assets,
          "",
          ["確定要離開目前頻道並返回登入畫面嗎？"],
          () => {
            if (hub.currentRoom) hub.send({ type: "leave_room" });
            void ctx.goto("login");
          },
          true,
        ),
      );
    },
    onShop: () => {
      if (currentId === "shop") return;
      if (hub.currentRoom) hub.send({ type: "leave_room" });
      void ctx.goto("shop");
    },
    onMyItem: () => openMyPage(),
    onMessenger: () => openMessenger(),
    onOption: () => dialogs.push(new OptionDlg(assets, sound, hub, (d) => dialogs.push(d))),
    onHelp: () => dialogs.push(new HelpDlg(assets)),
    onMyInfo: () => openMyInfo(),
  });

  const stages = new Map<StageId, Stage>();
  let activeStage: Stage | null = null;

  const ctx: AppContext = {
    renderer,
    assets,
    sound,
    hub,
    dialogs,
    globalBar,
    practiceConfig: null,
    returnStageAfterModal: "lobby",
    goto: async (id: StageId) => {
      if (currentId === "lobby" || currentId === "selectserver") {
        ctx.returnStageAfterModal = currentId;
      }
      globalBar.closeMenu();
      activeStage?.leave?.();
      currentId = id;

      // Match `CA.exe` `CGlobalButtonDlg` enabled/disabled button state per stage
      globalBar.btShop.enabled = id !== "shop" && id !== "practice";
      globalBar.btMyItem.enabled = id !== "practice";
      globalBar.btMyInfo.enabled = id !== "practice";
      globalBar.btMessenger.enabled = id !== "practice";

      let next = stages.get(id);
      if (!next) {
        next = createStage(id, ctx);
        stages.set(id, next);
      }
      activeStage = next;
      await next.enter();
    },
  };

  // Global loudspeaker banner & `CNoSpeakDlg` (`CA.exe.c:38655..38735`) listener
  hub.onMessage((msg) => {
    if (msg.type === "speaker_recv") {
      speakerOverlay.trigger(msg.from, msg.text, msg.colorIdx ?? 0);
      sound.playSfx("Connect", 0.7);
    } else if (msg.type === "no_speaker") {
      dialogs.push(
        new NoSpeakDlg(assets, msg.kind, () => {
          if (currentId !== "shop") {
            if (hub.currentRoom) hub.send({ type: "leave_room" });
            void ctx.goto("shop");
          }
        }),
      );
    }
  });

  // Pointer coordinates in 800x600 virtual space
  let mouseX = 400;
  let mouseY = 300;
  let mouseDown = false;
  let mouseInside = false;

  const toCanvasXY = (ev: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(SCREEN_W - 1, ((ev.clientX - rect.left) / rect.width) * SCREEN_W)),
      y: Math.max(0, Math.min(SCREEN_H - 1, ((ev.clientY - rect.top) / rect.height) * SCREEN_H)),
    };
  };

  canvas.addEventListener("pointerenter", () => {
    mouseInside = true;
  });
  canvas.addEventListener("pointerleave", () => {
    mouseInside = false;
    mouseDown = false;
  });
  canvas.addEventListener("pointermove", (ev) => {
    mouseInside = true;
    const p = toCanvasXY(ev);
    mouseX = p.x;
    mouseY = p.y;
    if (dialogs.active) {
      dialogs.onMouseMove(p.x, p.y, sound);
    } else {
      activeStage?.onMouseMove?.(p.x, p.y);
    }
  });
  canvas.addEventListener("pointerdown", (ev) => {
    sound.unlock();
    mouseDown = true;
    const p = toCanvasXY(ev);
    mouseX = p.x;
    mouseY = p.y;
    if (dialogs.active) {
      dialogs.onMouseDown(p.x, p.y, sound, ev.button);
    } else {
      activeStage?.onMouseDown?.(p.x, p.y, ev.button);
    }
  });
  window.addEventListener("pointerup", (ev) => {
    if (!mouseDown) return;
    mouseDown = false;
    const p = toCanvasXY(ev);
    if (dialogs.active) {
      dialogs.onMouseUp(p.x, p.y, sound, ev.button);
    } else {
      activeStage?.onMouseUp?.(p.x, p.y, ev.button);
    }
  });
  canvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const p = toCanvasXY(ev);
      if (dialogs.active) {
        dialogs.onWheel(ev.deltaY, p.x, p.y);
      } else {
        activeStage?.onWheel?.(ev.deltaY, p.x, p.y);
      }
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", (ev) => {
    if (ev.button !== 0 || !dialogs.active) return;
    const p = toCanvasXY(ev);
    dialogs.onDoubleClick(p.x, p.y, sound);
  });
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  // Retail `CA.exe` `Fx:Help/Help` function keys:
  //   F1 Help, F2 In-game ID on/off (Lobby: KeyMapDlg), F3 In-game SelfIndicator on/off (Lobby: ColorPencilDlg),
  //   F4 / F12 / PrintScreen ScreenShot (`Wave/ScreenShot`), F5 Ready/Start (in PrepareStage),
  //   F6 SpeechBalloon on/off, F7 SFX mute, F8 BGM mute, F9 Macro settings (`OptionDlg`)
  let wantScreenshot = false;
  let screenshotFlashUntilMs = 0;

  window.addEventListener("keydown", (ev) => {
    sound.unlock();
    if (ev.key === "F1") {
      ev.preventDefault();
      if (!dialogs.active) dialogs.push(new HelpDlg(assets));
      return;
    }
    if (ev.key === "F2") {
      ev.preventDefault();
      if (currentId === "game" && !dialogs.active) {
        hub.showPlayerIds = !hub.showPlayerIds;
        sound.playSfx("ButtonDown_0", 0.5);
        hub.pushSystemChat(
          hub.showPlayerIds ? "[系統] 遊戲中顯示玩家ID：開啟 (F2)" : "[系統] 遊戲中顯示玩家ID：關閉 (F2)",
        );
      } else if (!dialogs.active) {
        dialogs.push(new KeyMapDlg(assets));
      }
      return;
    }
    if (ev.key === "F3") {
      ev.preventDefault();
      if (currentId === "game" && !dialogs.active) {
        hub.showSelfIndicator = !hub.showSelfIndicator;
        sound.playSfx("ButtonDown_0", 0.5);
        hub.pushSystemChat(
          hub.showSelfIndicator
            ? "[系統] 自己位置指標 (SelfIndicator)：開啟 (F3)"
            : "[系統] 自己位置指標 (SelfIndicator)：關閉 (F3)",
        );
      } else if (!dialogs.active && currentId !== "title" && currentId !== "login") {
        dialogs.push(
          new ColorPencilDlg(assets, hub, () => {
            if (currentId !== "shop") {
              if (hub.currentRoom) hub.send({ type: "leave_room" });
              void ctx.goto("shop");
            }
          }),
        );
      }
      return;
    }
    if (
      (ev.key === "F4" && !ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
      (ev.key === "F12" && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) ||
      ev.key === "PrintScreen"
    ) {
      ev.preventDefault();
      wantScreenshot = true;
      sound.playSfx("ScreenShot", 0.9);
      sound.playSfx("Flash", 0.55);
      return;
    }
    if (ev.key === "F6") {
      ev.preventDefault();
      hub.showSpeechBalloons = !hub.showSpeechBalloons;
      sound.playSfx("ButtonDown_0", 0.5);
      hub.pushSystemChat(
        hub.showSpeechBalloons ? "[系統] 對話氣球顯示：開啟 (F6)" : "[系統] 對話氣球顯示：關閉 (F6)",
      );
      return;
    }
    if (ev.altKey && /^Digit[0-9]$/.test(ev.code) && !dialogs.active) {
      ev.preventDefault();
      const digit = Number(ev.code.slice(5));
      if (currentId === "lobby" || currentId === "prepare" || currentId === "practice" || currentId === "game" || currentId === "chatting") {
        hub.triggerMacro(digit);
      }
      return;
    }
    if (ev.key === "F7") {
      ev.preventDefault();
      sound.setSfxVolume(sound.sfxVolume > 0.01 ? 0 : 0.8);
      return;
    }
    if (ev.key === "F8") {
      ev.preventDefault();
      sound.setBgmVolume(sound.bgmVolume > 0.01 ? 0 : 0.45);
      return;
    }
    if (ev.key === "F9") {
      ev.preventDefault();
      if (!dialogs.active && currentId !== "title") {
        dialogs.push(new OptionDlg(assets, sound, hub, (d) => dialogs.push(d)));
      }
      return;
    }

    if (dialogs.active) {
      dialogs.onKeyDown(ev);
    } else {
      activeStage?.onKeyDown?.(ev);
    }
  });
  window.addEventListener("keyup", (ev) => {
    // Gameplay releases must reach the stage even if a modal opened while a key was held.
    if (!dialogs.active || currentId === "game") activeStage?.onKeyUp?.(ev);
  });
  window.addEventListener("blur", () => activeStage?.onBlur?.());

  // Start at Stage 0 (`TitleStage`: `nm.bik` intro video -> `LoginStage`)
  await ctx.goto("title");

  let lastMs = performance.now();
  const loop = (nowMs: number): void => {
    const dtSec = Math.min(0.1, Math.max(0, (nowMs - lastMs) / 1000));
    lastMs = nowMs;

    activeStage?.tick(dtSec, nowMs);

    renderer.begin([0, 0, 0, 1]);
    activeStage?.render(renderer, nowMs);
    speakerOverlay.render(renderer, nowMs);
    dialogs.render(renderer, nowMs);

    // Retail `CImeStatusWnd` (`Cx:Etc/ImeStatus` `34x17` frame 0 at `(761, 4)` when CJK IME active, `CA.exe.c:362175..362184`)
    if (imeStatusSheet && imeHost.hasActiveFocus() && imeHost.imeStatusFrame() > 0 && !wantScreenshot) {
      drawSheetFrame(renderer, imeStatusSheet, 0, 761, 4);
    }

    // Retail `Cx:Etc/Cursor` sprite drawn on top of everything in WebGPU
    if (mouseInside && cursorSheet && !wantScreenshot) {
      drawSheetFrame(renderer, cursorSheet, mouseDown ? 1 : 0, mouseX, mouseY);
    }

    if (nowMs < screenshotFlashUntilMs && !wantScreenshot) {
      const a = Math.max(0, Math.min(0.85, (screenshotFlashUntilMs - nowMs) / 220));
      renderer.fillRect(0, 0, SCREEN_W, SCREEN_H, [1, 1, 1, a]);
    }

    renderer.end();

    if (wantScreenshot) {
      wantScreenshot = false;
      screenshotFlashUntilMs = nowMs + 220;
      const d = new Date();
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const fileName = `BnB_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.png`;
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      }, "image/png");
      hub.pushSystemChat(`[系統] 畫面已擷取儲存：${fileName}`);
    }

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function createStage(id: StageId, ctx: AppContext): Stage {
  switch (id) {
    case "title":
      return new TitleStage(ctx);
    case "login":
      return new LoginStage(ctx);
    case "credit":
      return new CreditStage(ctx);
    case "selectserver":
      return new SelectServerStage(ctx);
    case "lobby":
      return new LobbyStage(ctx);
    case "prepare":
      return new PrepareStage(ctx, false);
    case "practice":
      return new PrepareStage(ctx, true);
    case "game":
      return new GameStage(ctx);
    case "shop":
      return new ShopStage(ctx);
    case "chatting":
      return new ChattingStage(ctx);
    case "exchange":
      return new ExchangeStage(ctx);
  }
}

boot().catch((err) => {
  console.error("[BnB boot error]", err);
  const fallback = document.getElementById("fallback");
  if (fallback) {
    fallback.style.display = "flex";
    fallback.textContent = `啟動發生錯誤：${err instanceof Error ? err.message : String(err)}`;
  }
});
