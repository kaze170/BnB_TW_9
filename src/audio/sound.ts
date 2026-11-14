// Retail WebAudio Sound & BGM Manager (`CFxSound` / `CSound` port).
// Decodes RIFF WAV (`Wave/*`) and MPEG Layer-3 (`MP3/*`) payloads directly from
// `Fx` / `Cx` archives, supports polyphonic SFX playback, looping stage/map BGM,
// HurryUp tempo acceleration, and OptionDlg BGM/SFX volume & mute controls.

import type { GameAssets, PackName } from "../data/assets.ts";

// Retail map family -> MP3/* track name inside Fx.idd
const FAMILY_BGM: Record<string, string> = {
  patrit: "MP3/Patrit",
  pirate: "MP3/Patrit",
  camp: "MP3/Camp",
  village: "MP3/Village",
  town: "MP3/Village",
  fact: "MP3/Factory",
  factory: "MP3/Factory",
  forest: "MP3/Forest",
  ice: "MP3/Ice",
  desert: "MP3/Desert",
  mine: "MP3/Mine",
  ocean: "MP3/Ocean",
  tomb: "MP3/Tomb",
  cemetery: "MP3/Cemetery",
  bula: "MP3/Bula",
  exbula: "MP3/Bula",
  excamp: "MP3/Camp",
  exfactory: "MP3/Factory",
  exforest: "MP3/Forest",
  expatrit: "MP3/Patrit",
  extomb: "MP3/Tomb",
  exvillage: "MP3/Village",
  eventcamp: "MP3/EventLyric",
  eventfactory: "MP3/EventLyric",
  eventforest: "MP3/EventLyric",
  eventocean: "MP3/EventLyric",
  eventpatrit: "MP3/EventLyric",
  kfc: "MP3/Kfc",
  xmas: "MP3/Carol00",
  snow: "MP3/Xmas",
  kart: "MP3/Kart",
  bonus: "MP3/Bonus",
};

/**
 * Exact `CA.exe.c:113655..113696` map BGM resolver:
 *   - `Event*` themes -> `MP3/EventLyric` (`L113662`)
 *   - `Ex*` themes -> strips `Ex` prefix (`L113667`)
 *   - `Xmas` / `MP3/Xmas` theme -> random Christmas carol `MP3/Carol00..03` or `MP3/Xmas` (`L113655..113695`)
 */
export function resolveMapBgmTrack(
  mapName: string,
  family = "",
  art = "",
  carolSeed = Math.floor(Math.random() * 4),
): string {
  const candidates = [art.toLowerCase(), family.toLowerCase(), mapName.replace(/\d+$/, "").toLowerCase()];
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("event")) return "MP3/EventLyric";
    if (c === "xmas" || c === "mp3/xmas") {
      if (carolSeed === 4) return "MP3/Xmas";
      const idx = ((carolSeed % 4) + 4) % 4;
      return `MP3/Carol0${idx}`;
    }
    const stripped = c.startsWith("ex") && c !== "exchange" ? c.slice(2) : c;
    if (FAMILY_BGM[c]) return FAMILY_BGM[c]!;
    if (FAMILY_BGM[stripped]) return FAMILY_BGM[stripped]!;
  }
  return "MP3/Patrit";
}

export class SoundManager {
  private readonly assets: GameAssets;
  private ctx: AudioContext | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  private readonly decodedBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private currentBgmKey = "";
  private currentBgmSource: AudioBufferSourceNode | null = null;
  private bgmRate = 1.0;
  private pendingBgm: { pack: PackName; name: string; loop: boolean } | null = null;

  bgmVolume = 0.65; // 0..1
  sfxVolume = 0.85; // 0..1
  bgmMuted = false;
  sfxMuted = false;

  constructor(assets: GameAssets) {
    this.assets = assets;
  }

  /** Call on any pointer/keyboard user gesture so WebAudio unlocks cleanly. */
  unlock(): void {
    if (!this.ctx) {
      const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.bgmGain.connect(this.ctx.destination);
      this.sfxGain.connect(this.ctx.destination);
      this.syncVolumes();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().then(() => {
        if (this.pendingBgm && !this.currentBgmSource) {
          const p = this.pendingBgm;
          this.pendingBgm = null;
          this.playBgm(p.name, p.pack, p.loop);
        }
      });
    } else if (this.pendingBgm && !this.currentBgmSource) {
      const p = this.pendingBgm;
      this.pendingBgm = null;
      this.playBgm(p.name, p.pack, p.loop);
    }
  }

  setBgmVolume(v: number): void {
    this.bgmVolume = Math.max(0, Math.min(1, v));
    this.syncVolumes();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    this.syncVolumes();
  }

  setBgmMuted(muted: boolean): void {
    this.bgmMuted = muted;
    this.syncVolumes();
  }

  setSfxMuted(muted: boolean): void {
    this.sfxMuted = muted;
    this.syncVolumes();
  }

  private syncVolumes(): void {
    if (this.bgmGain) {
      this.bgmGain.gain.value = this.bgmMuted ? 0 : this.bgmVolume;
    }
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.sfxMuted ? 0 : this.sfxVolume;
    }
  }

  private loadBuffer(pack: PackName, name: string): Promise<AudioBuffer | null> {
    const key = `${pack}:${name.toLowerCase()}`;
    let p = this.decodedBuffers.get(key);
    if (!p) {
      p = (async () => {
        if (!this.ctx) return null;
        try {
          const sp = this.assets.streamPack(pack);
          const payload = await sp.payload(name);
          if (!payload || payload.byteLength < 16) return null;
          // decodeAudioData detaches its ArrayBuffer; pass a fresh copy.
          const copy = new ArrayBuffer(payload.byteLength);
          new Uint8Array(copy).set(payload);
          return await this.ctx.decodeAudioData(copy);
        } catch {
          return null;
        }
      })();
      this.decodedBuffers.set(key, p);
    }
    return p;
  }

  /** Play one of the 2 retail match-start jingles (`Wave/GameStart_0` / `Wave/GameStart_1`, `0x615268..0x61526C`). */
  playGameStartSfx(seed = Math.random()): void {
    this.playSfx(seed < 0.5 ? "Wave/GameStart_0" : "Wave/GameStart_1", 0.9);
  }

  /** Play retail timer-expired alarm (`Wave/TimerExpired_1` at `00:00`, `Wave/TimerExpired_0` per countdown second). */
  playTimerExpiredSfx(finalZero: boolean): void {
    this.playSfx(finalZero ? "Wave/TimerExpired_1" : "Wave/TimerExpired_0", finalZero ? 0.85 : 0.7);
  }

  /** Play retail stage-clear ending fanfare (`Wave/Ending`, `0x615324`). */
  playStageEndingSfx(): void {
    this.playSfx("Wave/Ending", 0.95);
  }

  /** Play a one-shot sound effect from `Fx` (`Wave/<name>` or full path). */
  playSfx(waveName: string, volumeScale = 1.0, pack: PackName = "Fx"): void {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    if (!this.ctx || !this.sfxGain || this.ctx.state !== "running") return;
    const fullPath = waveName.includes("/") ? waveName : `Wave/${waveName}`;
    void this.loadBuffer(pack, fullPath).then((buf) => {
      if (!buf || !this.ctx || !this.sfxGain || this.sfxMuted) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (volumeScale !== 1.0) {
        const g = this.ctx.createGain();
        g.gain.value = volumeScale;
        src.connect(g);
        g.connect(this.sfxGain);
      } else {
        src.connect(this.sfxGain);
      }
      src.start(0);
    });
  }

  /** Play or switch background music (`MP3/StageLogin`, `MP3/StageChannel`, `MP3/Prepare`, etc.). */
  playBgm(trackName: string, pack: PackName = "Fx", loop = true): void {
    const aliased =
      trackName === "StageLobby"
        ? "StageChannel"
        : trackName === "StagePrepare"
          ? "Prepare"
          : trackName;
    const fullPath = aliased.includes("/") ? aliased : `MP3/${aliased}`;
    const key = `${pack}:${fullPath.toLowerCase()}`;
    if (this.currentBgmKey === key && this.currentBgmSource) return;

    this.stopBgm();
    this.currentBgmKey = key;
    this.bgmRate = 1.0;

    if (!this.ctx || this.ctx.state !== "running") {
      this.pendingBgm = { pack, name: fullPath, loop };
      return;
    }

    void this.loadBuffer(pack, fullPath).then((buf) => {
      if (!buf || !this.ctx || !this.bgmGain || this.currentBgmKey !== key) return;
      this.stopSourceOnly();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = loop;
      src.playbackRate.value = this.bgmRate;
      src.connect(this.bgmGain);
      src.start(0);
      this.currentBgmSource = src;
    });
  }

  /** Play the retail BGM track matching a map's `art` / `family` / `name` (`CA.exe.c:113655..113696`). */
  playMapBgm(mapName: string, family = "", art = ""): void {
    this.playBgm(resolveMapBgmTrack(mapName, family, art), "Fx", true);
  }

  setBgmPlaybackRate(rate: number): void {
    this.bgmRate = rate;
    if (this.currentBgmSource) {
      this.currentBgmSource.playbackRate.value = rate;
    }
  }

  private stopSourceOnly(): void {
    if (this.currentBgmSource) {
      try {
        this.currentBgmSource.stop();
      } catch {
        /* ignore */
      }
      this.currentBgmSource.disconnect();
      this.currentBgmSource = null;
    }
  }

  stopBgm(): void {
    this.currentBgmKey = "";
    this.pendingBgm = null;
    this.stopSourceOnly();
  }
}
