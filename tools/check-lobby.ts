/**
 * End-to-end check of the login -> channel flow, against a live server.
 *
 * Run the dev server first, then:
 *   bun run tools/check-lobby.ts
 *
 * What it asserts:
 *   - the handshake completes and the key byte is echoed correctly
 *   - login succeeds
 *   - the ChannelList body decodes and carries the retail channels
 *   - joining a channel by index succeeds
 *
 * The channel names are compared against `channel2_000.ssd` parsed directly,
 * so a regression in either the parser or the wire format is caught.
 */

import { GameSocket, OP, decodeChannelList, decodeRoomList } from '../src/net/client.ts';
import { readSsi, decodeSystemStrings } from '../src/data/ssi.ts';
import { parseMapInfo } from '../src/data/mapinfo.ts';

function str16At(bytes: Uint8Array, off: number): string {
  const n = (bytes[off]! << 8) | bytes[off + 1]!;
  return new TextDecoder('latin1').decode(bytes.subarray(off + 2, off + 2 + n));
}
import { readChannelFile } from '../src/data/channel.ts';
import { readServerList, mergeWithBuiltins } from '../src/data/serverlist.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const URL_BASE = process.env.BNB_URL ?? 'ws://127.0.0.1:3000/ws';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- the data the server is expected to serve ------------------------------

const expectedFile = readChannelFile(
  new Uint8Array(await Bun.file(`${ROOT}channel2_000.ssd`).arrayBuffer()),
  'channel2_000.ssd',
);
const expected = expectedFile?.channels ?? [];
check(`channel2_000.ssd parses (${expected.length} channels)`, expected.length > 0);

const realms = mergeWithBuiltins(
  readServerList(new Uint8Array(await Bun.file(`${ROOT}multisvr.ssd`).arrayBuffer())),
);
check(`multisvr.ssd realm list (${realms.length} endpoints)`, realms.length === 4);
check(
  'realm endpoints are the retail HiNet hosts',
  realms.every((r) => r.address.startsWith('211.20.') && r.port === 3838),
  realms.map((r) => r.address).join(', '),
);

// --- live round trip -------------------------------------------------------

interface Result {
  confirmed: boolean;
  loginOk: boolean;
  channels: ReturnType<typeof decodeChannelList>;
  joinOk: boolean;
  joinChannelId: number;
  rooms: ReturnType<typeof decodeRoomList>;
  enterOk: boolean;
  enterSlot: number;
  enterKey: string;
  closed: boolean;
}

const result: Result = {
  confirmed: false,
  loginOk: false,
  channels: [],
  joinOk: false,
  joinChannelId: -1,
  rooms: [],
  enterOk: false,
  enterSlot: -1,
  enterKey: '',
  closed: false,
};

await new Promise<void>((resolve) => {
  let settled = false;
  let attemptedEntry = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    resolve();
  };

  const sock = new GameSocket({
    open: () => undefined,
    close: () => {
      result.closed = true;
      finish();
    },
    error: () => finish(),
    packet: (op, body) => {
      if (op === OP.Confirm) {
        result.confirmed = body.length === 1;
        sock.setKey(body[0]!);
        sock.login('tester', 'hunter2');
        return;
      }
      if (op === OP.LoginResult) {
        result.loginOk = body[0] === 1;
        return;
      }
      if (op === OP.ChannelList) {
        result.channels = decodeChannelList(body);
        if (result.channels.length) sock.joinChannel(3);
        else sock.close();
        return;
      }
      if (op === OP.JoinResult) {
        result.joinOk = body[0] === 1;
        result.joinChannelId = (body[1]! << 8) | body[2]!;
        return;
      }
      if (op === OP.RoomList) {
        result.rooms = decodeRoomList(body);
        if (!attemptedEntry) {
          attemptedEntry = true;
          const free = result.rooms.find((r) => r.players < r.capacity);
          if (free) sock.enterRoom(free.slot);
          else sock.close();
        }
        return;
      }
      if (op === OP.EnterResult) {
        const okNow = body[0] === 1;
        const slotNow = (body[1]! << 8) | body[2]!;
        if (okNow) {
          result.enterOk = true;
          result.enterSlot = slotNow;
          // Ask for a slot that cannot exist: the client must be handed a
          // csysstr.ssd key, not a server sentence.
          sock.enterRoom(99);
          return;
        }
        result.enterKey = str16At(body, 3);
        sock.leaveRoom();
        sock.close();
        return;
      }
    },
  });
  sock.connect(URL_BASE).catch(() => finish());
  setTimeout(finish, 5000);
});

check('handshake sent exactly one key byte', result.confirmed);
check('login accepted', result.loginOk);
check(
  `channel list matches channel2_000.ssd (${result.channels.length})`,
  result.channels.length === expected.length &&
    result.channels.every((c, i) => c.name === expected[i]!.name && c.maxUsers === expected[i]!.maxUsers),
  result.channels.map((c) => c.name).join(', '),
);
check(
  'channel user counts match the file',
  result.channels.every((c, i) => c.users === expected[i]!.users && c.kind === expected[i]!.kind),
);
check('join by index accepted', result.joinOk);
check('join returned the requested channel id', result.joinChannelId === 3, `got ${result.joinChannelId}`);
check(
  `room list has the six CLobbyStage slots (${result.rooms.length})`,
  result.rooms.length === 6 && result.rooms.every((r, i) => r.slot === i),
  result.rooms.map((r) => `#${r.slot}`).join(' '),
);
check(
  'room records are internally consistent',
  result.rooms.every((r) => r.players <= r.capacity && r.capacity > 0 && r.name !== ''),
);
check('entering a room was accepted', result.enterOk, `slot ${result.enterSlot}`);

const mapFile = parseMapInfo(
  readSsi(new Uint8Array(await Bun.file(new URL('../fxdynmapinfo.ssd', import.meta.url)).arrayBuffer()))!.payload,
)!;
check(
  'every room names a real fxdynmapinfo map',
  result.rooms.length === 6 &&
    result.rooms.every((r) => mapFile.maps.some((m) => m.index === r.map && !m.random)),
  result.rooms.map((r) => `${r.map}:${mapFile.maps.find((m) => m.index === r.map)?.description ?? '?'}`).join(', '),
);

const sysRows = decodeSystemStrings(
  readSsi(new Uint8Array(await Bun.file(new URL('../csysstr.ssd', import.meta.url)).arrayBuffer()))!.payload,
)!;
const enterMsg = sysRows.find((r) => r.name === result.enterKey);
check(
  'a bad room slot is reported with a csysstr.ssd key',
  result.enterKey === 'NotValidRoomInfo',
  `got ${JSON.stringify(result.enterKey)}`,
);
check(
  'that key resolves in the client string table',
  enterMsg?.text === '無效的房間，無法確認房間資料',
  enterMsg?.text,
);
check(
  'the room failure keys the retail lobby uses all resolve',
  ['NoEmptySlot', 'CantCreateRoom', 'NoAuthority', 'SameRoomExist', 'InvalidGradeCreate'].every((k) =>
    sysRows.some((r) => r.name === k),
  ),
);

console.log(failures === 0 ? '\nlobby checks passed' : `\n${failures} check(s) failed`);
if (failures > 0) process.exit(1);
