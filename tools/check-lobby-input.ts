/** Room-key navigation must follow the executable's column-major slot table. */
import { strict as assert } from 'node:assert';
import { LobbyStage, type RoomSlot } from '../src/stage/lobby.ts';
import type { SpriteRenderer } from '../src/gfx/renderer.ts';

const lobby = new LobbyStage({} as SpriteRenderer);
const slots: RoomSlot[] = Array.from({ length: 6 }, (_, id) => ({
  id, name: `Room ${id + 1}`, players: 0, capacity: 8, state: 'waiting', map: 3,
}));
lobby.setSlots(slots);
const press = (key: string) => lobby.handleKey({ key, preventDefault() {} } as KeyboardEvent);
const selected = () => lobby.selectedSlot?.id;
assert.equal(selected(), 0);
press('ArrowUp'); assert.equal(selected(), 0);
press('ArrowDown'); assert.equal(selected(), 1);
press('ArrowRight'); assert.equal(selected(), 4);
press('ArrowDown'); assert.equal(selected(), 5);
press('ArrowDown'); assert.equal(selected(), 5);
press('ArrowLeft'); assert.equal(selected(), 2);
press('ArrowDown'); assert.equal(selected(), 2);
press('ArrowUp'); assert.equal(selected(), 1);
press('ArrowLeft'); assert.equal(selected(), 1);
let joined = -1;
lobby.setHandlers(() => {}, (room) => { joined = room.id; });
press('Enter'); assert.equal(joined, 1);
console.log('lobby keyboard navigation checks passed');
