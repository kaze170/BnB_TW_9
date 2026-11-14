// Shared Stage Lifecycle & Application Context (`src/stage/types.ts`).
// Strictly mirrors `CMainWnd`'s stage table in Taiwan v9 `CA.exe`:
//   0 = `CTitleStage`, 1 = `CLoginStage`, 3 = `CCreditStage`,
//   10 = `CSelectServerStage`, 11 = `CLobbyStage`, 12 = `CPrepareStage`,
//   13 = `CGameStage`, 14 = `CShopStageTw`, 17 = `CChattingStage`,
//   18 = `CExchangeStage`, 19 = `CPrepareStagePractice`.

import type { GameAssets } from "../data/assets.ts";
import type { SpriteRenderer } from "../gfx/renderer.ts";
import type { SoundManager } from "../audio/sound.ts";
import type { ClientHub } from "../net/hub.ts";
import type { DialogStack } from "../ui/dialogs.ts";
import type { GlobalButtonBar } from "../ui/widgets.ts";
import type { GameModeId } from "../sim/engine.ts";

export type StageId =
  | "title"
  | "login"
  | "credit"
  | "selectserver"
  | "lobby"
  | "prepare"
  | "practice"
  | "game"
  | "shop"
  | "chatting"
  | "exchange";

export interface PracticeLaunchConfig {
  mapCode: string;
  mode: GameModeId;
  dual2P: boolean;
  player1Char: number;
  player1Team: number;
  player2Char: number;
  player2Team: number;
  bots: { charIdx: number; team: number; aiLevel: 1 | 2 | 3 }[];
}

export interface AppContext {
  readonly assets: GameAssets;
  readonly renderer: SpriteRenderer;
  readonly sound: SoundManager;
  readonly hub: ClientHub;
  readonly dialogs: DialogStack;
  readonly globalBar: GlobalButtonBar;

  practiceConfig: PracticeLaunchConfig | null;
  returnStageAfterModal: StageId;

  goto(stage: StageId): Promise<void>;
}

export interface Stage {
  readonly id: StageId;
  enter(): Promise<void>;
  leave?(): void;
  tick(dtSec: number, nowMs: number): void;
  render(r: SpriteRenderer, nowMs: number): void;
  onMouseMove?(mx: number, my: number): void;
  onMouseDown?(mx: number, my: number, button: number): void;
  onMouseUp?(mx: number, my: number, button: number): void;
  onWheel?(deltaY: number, mx: number, my: number): void;
  onKeyDown?(e: KeyboardEvent): void;
  onKeyUp?(e: KeyboardEvent): void;
  onBlur?(): void;
}
