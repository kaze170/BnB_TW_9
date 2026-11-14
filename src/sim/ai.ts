// Smart Retail BnB AI Controller (`src/sim/ai.ts`)
// Drives Practice Mode AI opponents (`PraticePrepare` Levels 1..3) and `/bot`
// multiplayer room bots on the authoritative Bun server.

import {
  ACTIVE_CAN,
  ACTIVE_NEEDLE,
  ACTIVE_REMOTE,
  ACTIVE_SHIELD,
  ACTIVE_WATERTIGHT,
  CELL_PX,
  DIR_DX,
  DIR_DY,
  GameSimulation,
  type Dir4,
  type PlayerInput,
  type SimGroundItem,
  type SimPlayer,
} from "./engine.ts";

const AI_START_DELAY_TICKS = 76; // retail 2300ms AI warmup (`CA.exe`)

/**
 * Exact decompiled `CA.exe.c:131579..131738` (`sub_496A12`) AI ground-item desirability table!
 * Returns `0` for curses / unwanted items (`GreenDevil`, `Skeleton0/1`, `MoonWalk`, negative `LucciPocket1`),
 * and `470..650` for desirable powerups, mounts, Lucci bags, and seasonal collectibles.
 */
export function scoreRetailItemPriority(
  bot: Pick<SimPlayer, "bombsMax" | "power" | "speed" | "rideId">,
  it: Pick<SimGroundItem, "objectName" | "pickupFlag" | "effectId">,
): number {
  const nm = it.objectName.toLowerCase();
  if (it.effectId < 0) return 0;
  if (it.pickupFlag === 98 && it.effectId >= 50) return 650; // `GoldFlag`
  if (it.pickupFlag === 98) return 590; // `Alphabet01..11`

  if (nm === "item/itembomb") {
    return bot.bombsMax > 1 ? (bot.bombsMax > 3 ? 490 : 540) : 610;
  }
  if (nm === "item/itemfire") {
    if (bot.power <= 1) return 599;
    return (bot.power > 3 ? 0 : 50) + 470;
  }
  if (nm === "item/itemroller") {
    return bot.speed > 4 ? (bot.speed > 6 ? 530 : 560) : 611;
  }
  if (nm === "item/itemshoe") return 580;
  if (nm === "item/itempunch") {
    return bot.bombsMax >= 2 && bot.bombsMax + bot.power >= 6 ? 560 : 0;
  }
  if (nm === "item/itemmaxpower") return bot.power > 4 ? 480 : 550;
  if (nm === "item/itemhollow") return 530;
  if (
    nm.startsWith("item/itemcandy") ||
    nm.startsWith("item/icecon") ||
    nm.startsWith("item/christmas") ||
    nm === "chuseokbam" ||
    nm === "chuseokgam" ||
    nm.startsWith("item/doll")
  ) {
    return 620;
  }
  if (nm === "item/itemairship" || nm === "chicken") return 560;
  if (nm === "item/itemowl") return bot.speed > 5 ? 540 : 570;
  if (
    nm === "item/itemturtle0" ||
    nm === "item/itemairshipbroken" ||
    nm === "item/itemoctopus0" ||
    nm === "item/itemrailcar"
  ) {
    return 560;
  }
  if (nm === "item/itemturtle1" || nm === "item/itemoctopus1") return 610;
  if (nm === "item/itemkart" || nm === "item/itemkart0" || nm === "tank") return 560;
  if (nm === "luccibronze" || nm === "luccisilver" || nm === "luccigold") return 530;
  if (nm === "luccipocketbronze" || nm === "luccipocketsilver" || nm === "luccipocketgold") return 570;
  if (nm === "luccipocket0") return 610;
  if (nm === "item/itemdart") return 570;
  if (nm === "item/itemoxygen" || nm === "item/itemscanner") return 470;
  if (nm === "item/itemniddle") return 570;
  if (nm === "item/itempotion" || nm === "item/itemmotor" || nm === "item/itemcan" || nm === "item/itemspanner") {
    return 560;
  }
  if (nm === "item/itembond" || nm === "pin") return 480;
  if (nm === "item/itemtrap") return 490;
  if (nm === "reddevil") return bot.speed > 4 ? 560 : 610;
  if (nm === "skate") return bot.speed > 4 ? 555 : 600;
  if (nm === "hollowbomb" || nm === "goggle") return 540;
  if (nm === "camouflage") return 545;
  if (nm === "spring") return 550;
  if (nm === "drill") return 540;
  if (nm === "remotebomb") return 555;
  if (nm === "banana1") return 480;
  if (nm === "banana2") return 485;
  if (nm === "banana3") return 490;
  if (nm === "banana8") return 495;
  if (nm === "blind" || nm === "waterproof" || nm === "nitro" || nm === "item/itemfuel") return 535;
  if (
    nm.includes("greendevil") ||
    nm.includes("skeleton") ||
    nm.includes("moonwalk") ||
    (it.pickupFlag === 1 && (it.effectId === 8 || it.effectId === 9 || it.effectId === 10 || it.effectId === 12))
  ) {
    return 0;
  }
  if (nm.includes("questionmark")) return 520;
  return it.pickupFlag === 99 && it.effectId > 0 ? 530 : 500;
}

export function computeAiInput(sim: GameSimulation, bot: SimPlayer): PlayerInput {
  const out = computeAiInputRaw(sim, bot);
  if (
    out.dir !== -1 &&
    bot.state === "alive" &&
    bot.aiLevel >= 2 &&
    bot.curseTicks > 0 &&
    (bot.curseKind === 10 || (bot.curseKind ?? 12) === 12)
  ) {
    return { ...out, dir: ((out.dir + 2) & 3) as Dir4 };
  }
  return out;
}

function computeAiInputRaw(sim: GameSimulation, bot: SimPlayer): PlayerInput {
  if (sim.tick < AI_START_DELAY_TICKS) {
    return { dir: -1, placeBomb: false, useActive: false };
  }
  if (bot.state === "dead" || bot.state === "dying") {
    return { dir: -1, placeBomb: false, useActive: false };
  }

  // If trapped in bubble: crawl toward nearest teammate, or pop Needle if carrying one!
  if (bot.state === "trapped") {
    const hasNeedle = bot.activeSlots.includes(ACTIVE_NEEDLE);
    const reactTicks = bot.aiLevel === 3 ? 18 : bot.aiLevel === 2 ? 42 : 95;
    if (hasNeedle && bot.stateTicks >= reactTicks) {
      return { dir: -1, placeBomb: false, useActive: true };
    }
    // Crawl toward nearest alive teammate
    let bestDir: Dir4 | -1 = -1;
    let bestDist = Infinity;
    for (const ally of sim.players) {
      if (ally !== bot && ally.team === bot.team && ally.state === "alive") {
        const dx = ally.px - bot.px;
        const dy = ally.py - bot.py;
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < bestDist) {
          bestDist = d;
          bestDir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 0 : 2) : dy < 0 ? 1 : 3;
        }
      }
    }
    return { dir: bestDir, placeBomb: false, useActive: false };
  }

  const w = sim.width;
  const h = sim.height;
  const danger = buildDangerGrid(sim);

  const bcx = Math.floor(bot.px / CELL_PX);
  const bcy = Math.floor(bot.py / CELL_PX);

  // Kart Racing AI (`CKartComponent`, `componentMode === 1`): race checkpoints `0 -> 1 -> 2 -> 3 -> 4 -> 0`!
  if (sim.componentMode === 1) {
    if (bot.aiLevel === 1 && sim.tick % 6 === 0) {
      return { dir: -1, placeBomb: false, useActive: false };
    }
    const wantRefuel = (bot.kartFuel ?? 100) < 25;
    const nextCp = (bot.kartCheckpoint ?? -1) + 1;
    let raceDir = -1 as Dir4 | -1;
    if (wantRefuel) {
      raceDir = bfsMoveToward(
        sim,
        bot,
        bcx,
        bcy,
        (x, y) => Boolean(sim.cellAt(x, y)?.isPitStop),
        true,
        danger,
        48,
      );
    }
    if (raceDir === -1) {
      raceDir = bfsMoveToward(
        sim,
        bot,
        bcx,
        bcy,
        (x, y) => sim.cellAt(x, y)?.lapCheckpoint === nextCp,
        true,
        danger,
        64,
        true,
      );
    }
    const useNitro =
      bot.boostTicks === 0 &&
      bot.activeSlots.includes(ACTIVE_CAN) &&
      sim.tick % 45 === (bot.slot * 7) % 45;
    const dropTrackBomb =
      bot.bombsPlaced < bot.bombsMax &&
      !sim.bombAt(bcx, bcy) &&
      !sim.cellAt(bcx, bcy)?.noBombPlace &&
      sim.tick % 50 === (bot.slot * 11) % 50 &&
      sim.players.some(
        (o) =>
          o !== bot &&
          o.state === "alive" &&
          Math.abs(o.px - bot.px) + Math.abs(o.py - bot.py) <= 140,
      );
    return {
      dir: raceDir !== -1 ? raceDir : centerCellDir(bot, bcx, bcy),
      placeBomb: dropTrackBomb,
      useActive: useNitro,
    };
  }

  const inDanger = danger[bcy * w + bcx]! < 999;

  // 1. Urgent escape if standing in any flame or bomb blast line!
  if (inDanger) {
    const escDir = bfsMoveToward(
      sim,
      bot,
      bcx,
      bcy,
      (x, y) => danger[y * w + x]! === 999,
      true,
      danger,
    );
    const curDanger = danger[bcy * w + bcx]!;
    const shieldSlot = bot.activeSlots.findIndex((s) => s === ACTIVE_SHIELD || s === ACTIVE_WATERTIGHT);
    const popEmergencyShield =
      bot.aiLevel >= 2 &&
      bot.shieldTicks === 0 &&
      shieldSlot >= 0 &&
      (curDanger <= 4 || (escDir === -1 && curDanger <= 10));
    return {
      dir: escDir !== -1 ? escDir : centerCellDir(bot, bcx, bcy),
      placeBomb: false,
      useActive: popEmergencyShield,
      slotUse: popEmergencyShield ? shieldSlot : undefined,
    };
  }

  // Level-based decision throttle so Level 1 feels forgiving & natural
  if (bot.aiLevel === 1 && sim.tick % 5 >= 3) {
    return { dir: -1, placeBomb: false, useActive: false };
  }

  // Detonate owned RemoteBomb (`ACTIVE_REMOTE`) when safe for self and an enemy is near!
  if (bot.aiLevel >= 2 && bot.activeSlots.includes(ACTIVE_REMOTE)) {
    const myRemotes = sim.bombs.filter((b) => b.ownerSlot === bot.slot && b.style === "remote" && b.thrownTicks === 0);
    if (
      myRemotes.length > 0 &&
      danger[bcy * w + bcx]! === 999 &&
      myRemotes.some((rb) =>
        sim.players.some(
          (e) =>
            e.team !== bot.team &&
            e.state === "alive" &&
            ((Math.floor(e.px / CELL_PX) === rb.cx && Math.abs(Math.floor(e.py / CELL_PX) - rb.cy) <= rb.power) ||
              (Math.floor(e.py / CELL_PX) === rb.cy && Math.abs(Math.floor(e.px / CELL_PX) - rb.cx) <= rb.power)),
        ),
      )
    ) {
      return {
        dir: -1,
        placeBomb: false,
        useActive: true,
        slotUse: bot.activeSlots.indexOf(ACTIVE_REMOTE),
      };
    }
  }

  // 2. Rescue trapped teammate or execute trapped enemy if safe path exists!
  const bubbleTargets = sim.players.filter(
    (o) =>
      o !== bot &&
      o.state === "trapped" &&
      (o.team === bot.team || o.stateTicks >= 14),
  );
  if (bubbleTargets.length > 0) {
    const targetCells = new Set<number>();
    for (const t of bubbleTargets) {
      const tx = Math.floor(t.px / CELL_PX);
      const ty = Math.floor(t.py / CELL_PX);
      if (danger[ty * w + tx]! > 25) targetCells.add(ty * w + tx);
    }
    if (targetCells.size > 0) {
      const chaseDir = bfsMoveToward(
        sim,
        bot,
        bcx,
        bcy,
        (x, y) => targetCells.has(y * w + x),
        false,
        danger,
      );
      if (chaseDir !== -1) {
        return { dir: chaseDir, placeBomb: false, useActive: false };
      }
    }
  }

  // 3. Timebomb OR contagious GreenDevil (`eff=12`) carrier: chase nearest enemy immediately!
  const hasContagiousCurse = bot.curseTicks > 0 && (bot.curseKind ?? 12) === 12;
  if (bot.hasTimebomb || hasContagiousCurse) {
    const enemySet = new Set<number>();
    for (const e of sim.players) {
      if (e.team !== bot.team && e.state === "alive" && (!hasContagiousCurse || e.curseTicks === 0)) {
        enemySet.add(Math.floor(e.py / CELL_PX) * w + Math.floor(e.px / CELL_PX));
      }
    }
    const dir = bfsMoveToward(sim, bot, bcx, bcy, (x, y) => enemySet.has(y * w + x), false, danger);
    if (dir !== -1) return { dir, placeBomb: false, useActive: false };
  }

  // 4. Pick up nearby safe powerups & Event2004 Golden Flags using `CA.exe.c:131579..131738` desirability scores!
  const desiredItems = new Set<number>();
  let hasHighPriorityTarget = false;
  for (const it of sim.items) {
    if (danger[it.cy * w + it.cx]! < 45) continue;
    const prio = scoreRetailItemPriority(bot, it);
    if (bot.aiLevel >= 2 && prio <= 0) continue;
    desiredItems.add(it.cy * w + it.cx);
    if (
      prio >= 615 ||
      it.pickupFlag === 98 ||
      (sim.componentMode === 4 && it.pickupFlag === 99 && it.effectId > 0)
    ) {
      hasHighPriorityTarget = true;
    }
  }
  if (desiredItems.size > 0) {
    const itemDir = bfsMoveToward(
      sim,
      bot,
      bcx,
      bcy,
      (x, y) => desiredItems.has(y * w + x),
      false,
      danger,
      hasHighPriorityTarget ? 30 : bot.aiLevel === 1 ? 5 : 10,
    );
    if (itemDir !== -1) {
      return { dir: itemDir, placeBomb: false, useActive: false };
    }
  }

  // Approximate Bula bot: seek walkable cells with unclaimed or rival dots.
  if (sim.componentMode === 2) {
    const bulaDir = bfsMoveToward(
      sim,
      bot,
      bcx,
      bcy,
      (x, y) => {
        const c = sim.cellAt(x, y);
        if (!c || c.blocksWalk || danger[y * w + x]! < 45) return false;
        return c.bulaDots.some((owner, i) => owner >= 0 && owner !== bot.team + 1 && !c.bulaDotEffects[i]);
      },
      false,
      danger,
      24,
    );
    if (bulaDir !== -1 && (!isGoodBombSpot(sim, bot, bcx, bcy) || sim.tick % 4 !== 0)) {
      return { dir: bulaDir, placeBomb: false, useActive: false };
    }
  }

  // 5. Check if placing a bomb right here hits an enemy, Soul monster, or destructible crate AND has a safe escape!
  const bombCooldownMod = bot.aiLevel === 3 ? 6 : bot.aiLevel === 2 ? 15 : 32;
  const curCell = sim.cellAt(bcx, bcy);
  const canTryBomb =
    bot.bombsPlaced < bot.bombsMax &&
    !sim.bombAt(bcx, bcy) &&
    !curCell?.noBombPlace &&
    sim.tick % bombCooldownMod === (bot.slot * 3) % bombCooldownMod;

  if (canTryBomb && isGoodBombSpot(sim, bot, bcx, bcy) && hasSafeEscapeAfterBomb(sim, bot, bcx, bcy, danger)) {
    return { dir: -1, placeBomb: true, useActive: false };
  }

  // 6. Move toward a safe cell adjacent to an enemy, Soul monster, OR a destructible box!
  const goalDir = bfsMoveToward(
    sim,
    bot,
    bcx,
    bcy,
    (x, y) => isGoodBombSpot(sim, bot, x, y),
    false,
    danger,
    32,
  );

  if (goalDir !== -1) {
    return { dir: goalDir, placeBomb: false, useActive: false };
  }

  return { dir: centerCellDir(bot, bcx, bcy), placeBomb: false, useActive: false };
}

/** Returns ticks until blast for each cell (`0` = active flame, `1..96` = bomb fuse / Soul hazard, `999` = safe). */
function buildDangerGrid(sim: GameSimulation): Int16Array {
  const w = sim.width;
  const h = sim.height;
  const grid = new Int16Array(w * h).fill(999);

  for (const f of sim.flames) {
    if (f.cx >= 0 && f.cx < w && f.cy >= 0 && f.cy < h) {
      grid[f.cy * w + f.cx] = 0;
    }
  }

  // Mark patrolling Bula Souls (`InnerSoul` Mummy & `OuterSoul` BulaBat) and their next tile as immediate danger!
  for (const s of sim.souls) {
    if (s.state !== "walk") continue;
    const sx = Math.floor(s.px / CELL_PX);
    const sy = Math.floor(s.py / CELL_PX);
    if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
      grid[sy * w + sx] = 0;
    }
    const nx = sx + DIR_DX[s.dir]!;
    const ny = sy + DIR_DY[s.dir]!;
    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
      grid[ny * w + nx] = Math.min(grid[ny * w + nx]!, 10);
    }
  }

  // Mark Hurry-Up `CGOGhost` (`Game/Ghost` / `Game/Ghost Big`) and its rush corridor as danger!
  if (sim.ghost && sim.ghost.state !== "stun") {
    const g = sim.ghost;
    const gx = Math.floor(g.px / CELL_PX);
    const gy = Math.floor(g.py / CELL_PX);
    if (gx >= 0 && gx < w && gy >= 0 && gy < h) {
      grid[gy * w + gx] = 0;
    }
    const lookSteps = g.state === "rush" || g.state === "trans" ? 3 : 1;
    for (let st = 1; st <= lookSteps; st++) {
      const nx = gx + DIR_DX[g.dir]! * st;
      const ny = gy + DIR_DY[g.dir]! * st;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) break;
      if (sim.cellAt(nx, ny)?.blocksWalk) break;
      grid[ny * w + nx] = Math.min(grid[ny * w + nx]!, st * 8);
    }
  }

  // Sort bombs ascending by fuseTicks so chain-detonated bombs inherit shorter fuse!
  const sortedBombs = [...sim.bombs].sort((a, b) => a.fuseTicks - b.fuseTicks);
  for (let pass = 0; pass < 2; pass++) {
    for (const b of sortedBombs) {
      const bx = b.thrownTicks > 0 ? b.throwDestCx : b.cx;
      const by = b.thrownTicks > 0 ? b.throwDestCy : b.cy;
      if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
      const fuse = Math.min(b.fuseTicks, grid[by * w + bx]!);
      grid[by * w + bx] = Math.min(grid[by * w + bx]!, fuse);
      const bCell = sim.cellAt(bx, by);

      for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
        if (bCell && bCell.blockKind === 3 && !bCell.passFlameDir[d]) continue;
        const dx = DIR_DX[d]!;
        const dy = DIR_DY[d]!;
        const oppDir = (d ^ 2) as Dir4;
        for (let s = 1; s <= b.power; s++) {
          const tx = bx + dx * s;
          const ty = by + dy * s;
          const c = sim.cellAt(tx, ty);
          if (!c || c.blockKind === 1 || (c.blockKind === 3 && !c.passFlameDir[oppDir])) break;
          if (c.blockKind === 2) break;
          if (fuse < grid[ty * w + tx]!) {
            grid[ty * w + tx] = fuse;
          }
          if (c.blockKind === 3 && !c.passFlameDir[d]) break;
        }
      }
    }
  }
  return grid;
}

function isGoodBombSpot(sim: GameSimulation, bot: SimPlayer, cx: number, cy: number): boolean {
  if (sim.bombAt(cx, cy)) return false;
  const bCell = sim.cellAt(cx, cy);
  if (!bCell || bCell.noBombPlace) return false;
  // Check if any enemy, Bula Soul monster, or destructible crate is within blast line
  for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
    if (bCell.blockKind === 3 && !bCell.passFlameDir[d]) continue;
    const dx = DIR_DX[d]!;
    const dy = DIR_DY[d]!;
    const oppDir = (d ^ 2) as Dir4;
    for (let s = 1; s <= bot.power; s++) {
      const tx = cx + dx * s;
      const ty = cy + dy * s;
      const c = sim.cellAt(tx, ty);
      if (!c || c.blockKind === 1 || (c.blockKind === 3 && !c.passFlameDir[oppDir])) break;
      if (c.blockKind === 2) {
        if (!c.indestructible && c.crumbleTicks === 0) return true;
        break;
      }
      for (const soul of sim.souls) {
        if (
          soul.state === "walk" &&
          Math.floor(soul.px / CELL_PX) === tx &&
          Math.floor(soul.py / CELL_PX) === ty
        ) {
          return true;
        }
      }
      for (const e of sim.players) {
        if (
          e.team !== bot.team &&
          e.state === "alive" &&
          Math.floor(e.px / CELL_PX) === tx &&
          Math.floor(e.py / CELL_PX) === ty
        ) {
          return true;
        }
      }
      if (c.blockKind === 3 && !c.passFlameDir[d]) break;
    }
  }
  return false;
}

function hasSafeEscapeAfterBomb(
  sim: GameSimulation,
  bot: SimPlayer,
  bx: number,
  by: number,
  baseDanger: Int16Array,
): boolean {
  const w = sim.width;
  const h = sim.height;
  const hyp = new Int16Array(baseDanger);
  hyp[by * w + bx] = Math.min(hyp[by * w + bx]!, 96);
  const bCell = sim.cellAt(bx, by);
  for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
    if (bCell && bCell.blockKind === 3 && !bCell.passFlameDir[d]) continue;
    const dx = DIR_DX[d]!;
    const dy = DIR_DY[d]!;
    const oppDir = (d ^ 2) as Dir4;
    for (let s = 1; s <= bot.power; s++) {
      const tx = bx + dx * s;
      const ty = by + dy * s;
      const c = sim.cellAt(tx, ty);
      if (!c || c.blockKind === 1 || c.blockKind === 2 || (c.blockKind === 3 && !c.passFlameDir[oppDir])) break;
      hyp[ty * w + tx] = Math.min(hyp[ty * w + tx]!, 96);
      if (c.blockKind === 3 && !c.passFlameDir[d]) break;
    }
  }

  // BFS up to 7 cells for a completely safe tile (`hyp == 999`)
  const visited = new Uint8Array(w * h);
  const qx = [bx];
  const qy = [by];
  const qd = [0];
  visited[by * w + bx] = 1;

  for (let head = 0; head < qx.length; head++) {
    const x = qx[head]!;
    const y = qy[head]!;
    const dist = qd[head]!;
    if (hyp[y * w + x]! === 999) return true;
    if (dist >= 7) continue;
    for (let d = 0 as Dir4; d < 4; d = (d + 1) as Dir4) {
      const nx = x + DIR_DX[d]!;
      const ny = y + DIR_DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (visited[ny * w + nx]) continue;
      if (!sim.canWalkStep(bot, x, y, d)) continue;
      // Don't walk onto an imminent flame (< 18 ticks)
      if (hyp[ny * w + nx]! < 18) continue;
      visited[ny * w + nx] = 1;
      qx.push(nx);
      qy.push(ny);
      qd.push(dist + 1);
    }
  }
  return false;
}

function bfsMoveToward(
  sim: GameSimulation,
  bot: SimPlayer,
  startX: number,
  startY: number,
  isGoal: (x: number, y: number) => boolean,
  escaping: boolean,
  danger: Int16Array,
  maxDepth = 24,
  preferRoad = false,
): Dir4 | -1 {
  const w = sim.width;
  const h = sim.height;
  if (!escaping && isGoal(startX, startY)) {
    return centerCellDir(bot, startX, startY);
  }

  const visited = new Uint8Array(w * h);
  const qx: number[] = [startX];
  const qy: number[] = [startY];
  const qFirstDir: number[] = [-1];
  const qDepth: number[] = [0];
  visited[startY * w + startX] = 1;

  // Deterministic pseudo-shuffled dir order per bot so multiple bots don't move in lockstep
  const dirOrder: Dir4[] =
    (bot.slot & 1) === 0 ? [1, 2, 3, 0] : [3, 0, 1, 2];

  for (let head = 0; head < qx.length; head++) {
    const x = qx[head]!;
    const y = qy[head]!;
    const first = qFirstDir[head]!;
    const depth = qDepth[head]!;

    if (depth > 0 && isGoal(x, y)) {
      return stepFromCell(bot, startX, startY, first as Dir4);
    }
    if (depth >= maxDepth) continue;

    // On Kart racetracks, explore asphalt road cells before off-road sand cells!
    const orderedDirs = preferRoad
      ? [...dirOrder].sort((da, db) => {
          const ra = sim.cellAt(x + DIR_DX[da]!, y + DIR_DY[da]!)?.isTrackRoad ? 0 : 1;
          const rb = sim.cellAt(x + DIR_DX[db]!, y + DIR_DY[db]!)?.isTrackRoad ? 0 : 1;
          return ra - rb;
        })
      : dirOrder;

    for (const d of orderedDirs) {
      const nx = x + DIR_DX[d]!;
      const ny = y + DIR_DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (visited[ny * w + nx]) continue;
      if (!sim.canWalkStep(bot, x, y, d)) continue;
      const cellDanger = danger[ny * w + nx]!;
      if (escaping) {
        // Allow stepping through bomb blast rays if fuse > ticks needed to cross, never into active flame (0)
        if (cellDanger <= (depth + 1) * 7) continue;
      } else {
        if (cellDanger < 999) continue;
      }
      visited[ny * w + nx] = 1;
      qx.push(nx);
      qy.push(ny);
      qFirstDir.push(first === -1 ? d : first);
      qDepth.push(depth + 1);
    }
  }
  return -1;
}

/** Smoothly align bot to current cell center before turning 90 degrees so it never snags on corners. */
function stepFromCell(bot: SimPlayer, cx: number, cy: number, targetDir: Dir4): Dir4 {
  const centerX = cx * CELL_PX + 20;
  const centerY = cy * CELL_PX + 20;
  if (targetDir === 0 || targetDir === 2) {
    if (Math.abs(bot.py - centerY) > 10) {
      return bot.py < centerY ? 3 : 1;
    }
  } else {
    if (Math.abs(bot.px - centerX) > 10) {
      return bot.px < centerX ? 2 : 0;
    }
  }
  return targetDir;
}

function centerCellDir(bot: SimPlayer, cx: number, cy: number): Dir4 | -1 {
  const centerX = cx * CELL_PX + 20;
  const centerY = cy * CELL_PX + 20;
  if (Math.abs(bot.px - centerX) > 4) return bot.px < centerX ? 2 : 0;
  if (Math.abs(bot.py - centerY) > 4) return bot.py < centerY ? 3 : 1;
  return -1;
}
