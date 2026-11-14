/**
 * Retail Bula loop tracing, transcribed from sub_49A7FE, sub_49A85C,
 * sub_49BF75 and sub_49C290 in CA.exe.c. This describes the client request,
 * not the server's response, reward multiplier, or item selection.
 *
 * Dot states are native CGOBula states: 0 absent, 1 neutral, 3..10 team
 * colours, 11 hidden. A hidden dot is nonzero and therefore an obstruction.
 */
export interface BulaDotGrid {
  readonly width: number;
  readonly height: number;
  readonly states: readonly number[];
}

/** Translate the simulation's visible dot and deferred-hide animation to native state.
 * sub_49C41C sets state 11 immediately, while sub_49C4BD lets the animation finish.
 */
export function bulaNativeDotState(dot: number, effect: { hideAfter: boolean } | null | undefined): number {
  if (dot === -2 || effect?.hideAfter) return 11;
  return dot < 0 ? 0 : dot === 0 ? 1 : dot + 2;
}

const DX = [-1, 0, 1, 0] as const;
const DY = [0, -1, 0, 1] as const;
const OPPOSITE = [2, 3, 0, 1] as const;
type Direction = 0 | 1 | 2 | 3;

/** Return the visited boundary when the native right/left-hand walk closes with winding +4. */
export function traceBulaLoop(
  grid: BulaDotGrid, row: number, col: number, initialDirection: Direction,
  side: Direction, ownerState: number,
): Uint8Array | null {
  const { width, height, states } = grid;
  if (width <= 0 || height <= 0 || states.length !== width * height ||
      row < 0 || row >= height || col < 0 || col >= width || ownerState < 3 || ownerState > 10 ||
      states[row * width + col] !== ownerState) return null;
  const visited = new Uint8Array(width * height);
  let forward: Direction = initialDirection;
  let turnSide: Direction = side;
  let first = true;
  let turns = 0;
  const neighbour = (dir: Direction): number => {
    const x = col + DX[dir];
    const y = row + DY[dir];
    return x >= 0 && x < width && y >= 0 && y < height ? states[y * width + x]! : 0;
  };
  for (;;) {
    const index = row * width + col;
    if (visited[index]) {
      if (forward !== initialDirection) turns += initialDirection === turnSide ? 1 : -1;
      return turns === 4 ? visited : null;
    }
    visited[index] = 1;
    const oppositeSide = OPPOSITE[turnSide];
    const ahead = neighbour(forward);
    const sideState = neighbour(turnSide);
    const otherSide = neighbour(oppositeSide);
    let move: Direction;
    if (!first && sideState !== 0) {
      if (sideState !== ownerState) return null;
      move = turnSide;
      turnSide = OPPOSITE[forward];
      forward = move;
      turns++;
    } else if (ahead === 0) {
      if (first || otherSide === 0 || otherSide !== ownerState) return null;
      move = oppositeSide;
      turnSide = forward;
      forward = move;
      turns--;
    } else {
      if (ahead !== ownerState) return null;
      move = forward;
    }
    col += DX[move];
    row += DY[move];
    first = false;
  }
}

/**
 * sub_49BF75 scans between successive boundary pixels on each subcell row,
 * stepping by three columns. It selects existing, unclaimed static tile cells; the
 * caller owns the pending-state and server acknowledgement semantics.
 */
export function bulaLoopCandidates(
  boundary: Uint8Array, dotWidth: number, dotHeight: number,
  isUnclaimedBlock: (row: number, col: number) => boolean,
): [number, number][] {
  if (dotWidth <= 0 || dotHeight <= 0 || boundary.length !== dotWidth * dotHeight) return [];
  const result: [number, number][] = [];
  const seen = new Set<string>();
  for (let row = 0; row < dotHeight; row++) {
    let start = -1;
    let crossings = 0;
    for (let col = 0; col < dotWidth; col++) {
      if (boundary[row * dotWidth + col]) crossings++;
      if (crossings % 2 === 1) {
        if (start < 0) start = col;
      } else if (start >= 0) {
        for (let x = start + 1; x < col; x += 3) {
          const blockRow = Math.floor(row / 2);
          const blockCol = Math.floor(x / 3);
          const key = `${blockRow}:${blockCol}`;
          if (!seen.has(key) && isUnclaimedBlock(blockRow, blockCol)) {
            seen.add(key);
            result.push([blockRow, blockCol]);
          }
        }
        start = -1;
      }
    }
  }
  return result;
}

/** Enumerate only traces the client attempts when a dot changes colour. */
export function traceBulaLoopsAt(grid: BulaDotGrid, row: number, col: number, ownerState: number): Uint8Array[] {
  const paths: Uint8Array[] = [];
  const attempts: readonly [Direction, Direction, Direction][] = [
    [1, 1, 0], [1, 1, 2], [3, 3, 2], [3, 3, 0],
    [0, 0, 1], [0, 0, 3], [2, 2, 1], [2, 2, 3],
  ];
  for (const [neighbourDirection, direction, side] of attempts) {
    const x = col + DX[neighbourDirection];
    const y = row + DY[neighbourDirection];
    if (x < 0 || x >= grid.width || y < 0 || y >= grid.height ||
        grid.states[y * grid.width + x] !== ownerState) continue;
    const path = traceBulaLoop(grid, row, col, direction, side, ownerState);
    if (path) paths.push(path);
  }
  return paths;
}
