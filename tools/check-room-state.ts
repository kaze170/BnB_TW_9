/** Regression for room-seat accounting, using the real gateway and framed peers. */
import { strict as assert } from 'node:assert';
import { Lobby } from '../src/net/lobby.ts';
import { decodeFrame, encodeFrame, CIPHER_NONE, type SocketCipher } from '../src/net/protocol.ts';
import { PacketWriter } from '../src/net/packet.ts';
import { OP, decodeRoomList, type RoomInfo } from '../src/net/client.ts';
import { attachGateway, loadRetailData } from '../server/gateway.ts';

await loadRetailData();
const lobby = new Lobby();
attachGateway(lobby);

function connect() {
  const frames: Uint8Array[] = [];
  const ws = { send: (bytes: Uint8Array) => frames.push(bytes) };
  lobby.join(ws);
  const hello = decodeFrame(frames.shift()!, { key: 0, mode: CIPHER_NONE, cryptKey: false })!;
  const cipher: SocketCipher = { key: hello[1]!, mode: CIPHER_NONE, cryptKey: true };
  function request(op: number, data: Uint8Array = new Uint8Array(0)) {
    frames.length = 0;
    lobby.handle(ws, encodeFrame(op, data, cipher));
    return frames.map((frame) => decodeFrame(frame, cipher)!);
  }
  function join(): RoomInfo[] {
    const replies = request(OP.JoinChannel, new PacketWriter().u16(0).finish());
    return decodeRoomList(replies.find((p) => p[0] === OP.RoomList)!.subarray(1));
  }
  function enter(slot: number) {
    return request(OP.EnterRoom, new PacketWriter().u16(slot).finish());
  }
  function rooms(replies: Uint8Array[]): RoomInfo[] {
    return decodeRoomList(replies.find((p) => p[0] === OP.RoomList)!.subarray(1));
  }
  return { ws, request, join, enter, rooms };
}

const peer = connect();
const baseline = peer.join();
let rooms = peer.rooms(peer.enter(0));
assert.equal(rooms[0]!.players, baseline[0]!.players + 1, 'first entry occupies a seat');
rooms = peer.rooms(peer.enter(0));
assert.equal(rooms[0]!.players, baseline[0]!.players + 1, 'repeated entry does not occupy another seat');
rooms = peer.rooms(peer.enter(1));
assert.equal(rooms[0]!.players, baseline[0]!.players, 'switching frees the previous room');
assert.equal(rooms[1]!.players, baseline[1]!.players + 1, 'switching occupies the destination');
assert.equal(peer.enter(99)[0]![1], 0, 'invalid room rejected');
rooms = peer.rooms(peer.request(OP.LeaveRoom));
assert.equal(rooms[1]!.players, baseline[1]!.players, 'rejected switch preserves the old seat for leave');
rooms = peer.rooms(peer.request(OP.LeaveRoom));
assert.equal(rooms[1]!.players, baseline[1]!.players, 'leave is idempotent');
peer.enter(0);
lobby.leave(peer.ws);
lobby.leave(peer.ws);
const observer = connect();
rooms = observer.join();
assert.equal(rooms[0]!.players, baseline[0]!.players, 'disconnect frees the seat exactly once');
observer.enter(1);
rooms = observer.join();
assert.equal(rooms[1]!.players, baseline[1]!.players, 'changing channel frees the seat');
lobby.leave(observer.ws);
console.log('room accounting checks passed');
