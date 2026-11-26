import { expect } from "bun:test";
import type { SeatId, Tile } from "@caxio/shared/contracts/domain";
import {
  epoch,
  phaseExamples,
  roomCode,
} from "@caxio/shared/contracts/fixtures";
import {
  decodeCommand,
  decodeServerMessage,
  type ErrorCode,
  type Message,
  type Snapshot,
} from "@caxio/shared/contracts/wire";
import type { RoomConnection } from "../contracts";
import { createRoomService } from "./index";
import { at, rulesFixture, tile } from "./rules.fixture";

export function harness(
  maxRounds = 5,
  turnLimitMs?: number,
  dealRng = () => 0.25,
) {
  const clock = { time: epoch, reads: 0 };
  const codes = [roomCode, "WXYZ89"];
  const tokens = [
    "fixture-A",
    "fixture-B",
    "fixture-C",
    "fixture-D",
    "fixture-E",
    "fixture-new",
  ];
  const timers: { delay: number; cancelled: boolean; fire(): void }[] = [];
  const sockets = new Map<string, RoomConnection>();
  const names = new Map<RoomConnection, string>();
  const recipients = new Map<RoomConnection, SeatId>();
  const log: { name: string; message: Message }[] = [];
  let credentialDelivery:
    | { connection: RoomConnection; token: string | undefined }
    | undefined;
  const { rules, calls } = rulesFixture(maxRounds, dealRng);
  function event(fn: () => void) {
    const before = clock.reads;
    fn();
    expect(clock.reads).toBe(before + 1);
  }
  const service = createRoomService({
    rules,
    dealRng,
    turnLimitMs,
    now() {
      clock.reads++;
      return clock.time;
    },
    newRoomCode: () => at(codes.shift()),
    newToken: () => at(tokens.shift()),
    schedule(delay, cb) {
      const timer = { delay, cancelled: false, fire: () => event(cb) };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    send(conn, message) {
      // SEATED binds a previously unbound socket, including after its old room expires.
      const self =
        message.type === "SEATED" ? null : (recipients.get(conn) ?? null);
      const json = JSON.stringify(message);
      expect(decodeServerMessage(json, self)).toEqual(message);
      if (message.type === "SEATED") {
        expect(credentialDelivery?.connection).toBe(conn);
        expect(credentialDelivery?.token).toBe(message.token);
        credentialDelivery = undefined;
        recipients.set(conn, message.seatId);
        expect(Object.keys(message).sort()).toEqual([
          "roomCode",
          "seatId",
          "token",
          "type",
        ]);
      }
      if (message.type === "ERROR")
        expect(Object.keys(message).sort()).toEqual(["code", "type"]);
      if (message.type === "SNAPSHOT") {
        expect(message.serverNow).toBe(clock.time);
        expect(Object.keys(message).sort()).toEqual([
          "revision",
          "serverNow",
          "type",
          "view",
        ]);
        const v = message.view;
        const keys = Object.keys(phaseExamples[1].view).filter(
          (k) => k !== "ownHand",
        );
        if (v.phase === "LOBBY") {
          keys.push("hostSeatId", "canStart");
          if (v.lastGameResult) keys.push("lastGameResult");
        }
        const player =
          v.phase === "LOBBY" ? null : at(at(calls.state).players[at(self)]);
        if (!player?.isOut) {
          keys.push("ownHand");
          expect(v.ownHand).toEqual(player?.hand ?? []);
          if (v.lastSettlement) {
            keys.push("ownSettlement");
            expect(v.ownSettlement).toEqual(
              at(at(calls.state).lastSettlement?.details[at(self)]),
            );
          }
        }
        expect(Object.keys(v).sort()).toEqual(keys.sort());
        expect(v.tableHand).toEqual(
          v.phase === "LOBBY" ? null : at(calls.state).tableHand,
        );
        expect(v.lastPlay).toEqual(
          v.phase === "LOBBY" ? null : at(calls.state).lastPlay,
        );
        expect(json).not.toMatch(
          /fixture-|"(players|roundLeader|lastPlayedBy|details|payments|eliminatedRound|eliminatedEffectiveTiles|undealt|token)":/,
        );
      }
      log.push({ name: at(names.get(conn)), message });
    },
  });
  function socket(name: string) {
    const existing = sockets.get(name);
    if (existing) return existing;
    const conn = {
      send() {
        throw new Error("Direct socket send");
      },
    };
    sockets.set(name, conn);
    names.set(conn, name);
    return conn;
  }
  function request(name: string, command: unknown) {
    const connection = socket(name);
    const frame =
      typeof command === "string" ? command : JSON.stringify(command);
    const parsed = decodeCommand(frame);
    if (
      parsed !== "INVALID_MESSAGE" &&
      ["CREATE_ROOM", "RESUME", "JOIN_ROOM"].includes(parsed.type)
    ) {
      credentialDelivery = {
        connection,
        token: parsed.type === "RESUME" ? parsed.token : tokens[0],
      };
    }
    event(() => service.receive(connection, frame));
    credentialDelivery = undefined;
  }
  const close = (name: string) => event(() => service.close(socket(name)));
  const messages = (name: string) =>
    log.filter((row) => row.name === name).map((row) => row.message);
  const snaps = (name: string) =>
    messages(name).filter((m): m is Snapshot => m.type === "SNAPSHOT");
  const latest = (name = "A") => at(snaps(name).at(-1));
  function reject(name: string, command: unknown, code: ErrorCode) {
    const before = log.length,
      state = calls.state,
      accepted = calls.manual + calls.automatic;
    request(name, command);
    expect(log.slice(before)).toEqual([
      { name, message: { type: "ERROR", code } },
    ]);
    expect(calls.state).toBe(state);
    expect(calls.manual + calls.automatic).toBe(accepted);
  }
  const join = (name: string) => request(name, { type: "JOIN_ROOM", roomCode });
  const create = () => request("A", { type: "CREATE_ROOM" });
  const resume = (name: string, from: string) =>
    request(name, { type: "RESUME", roomCode, token: `fixture-${from}` });
  function lobby(count = 3) {
    create();
    for (const name of ["B", "C", "D", "E"].slice(0, count - 1)) join(name);
  }
  function start(count = 3) {
    lobby(count);
    request("A", { type: "START_GAME" });
  }
  const timer = () => at(timers.at(-1));
  return {
    clock,
    rules,
    codes,
    tokens,
    calls,
    timers,
    timer,
    log,
    messages,
    snaps,
    latest,
    request,
    close,
    reject,
    create,
    join,
    resume,
    lobby,
    start,
  };
}
type Harness = ReturnType<typeof harness>;
const same = (a: Tile, b: Tile) => a.number === b.number && a.suit === b.suit;

// Play down to the fixture's surviving hands. Each player leads repeatedly after the others pass.
export function penultimate(h: Harness, names = ["A", "B", "C", "D"]) {
  const four = at(h.calls.state).activePlayers.length === 4;
  function play(id: SeatId, t: Tile) {
    while (at(h.calls.state).currentTurn !== id) {
      const g = at(h.calls.state);
      const name = at(names[at(g.currentTurn)]);
      const before = h.calls.manual;
      h.request(name, { type: "PASS", turnId: g.turnId });
      expect(h.calls.manual).toBe(before + 1);
    }
    const before = h.calls.manual;
    h.request(at(names[id]), {
      type: "PLAY",
      turnId: at(h.calls.state).turnId,
      tiles: [t],
    });
    expect(h.calls.manual).toBe(before + 1);
  }
  function drain(id: SeatId, keep: readonly Tile[], first: Tile) {
    play(id, first);
    for (const t of at(at(h.calls.state).players[id]).hand)
      if (!keep.some((k) => same(t, k))) play(id, t);
  }
  play(0, tile(3));
  drain(1, [tile(four ? 7 : 4)], four ? tile(5) : tile(4, 1));
  drain(2, [tile(four ? 4 : 7), tile(8, 2)], four ? tile(9, 1) : tile(7, 1));
  if (four)
    drain(
      3,
      [
        tile(2),
        tile(2, 1),
        tile(2, 2),
        tile(10),
        tile(10, 1),
        tile(10, 2),
        tile(10, 3),
        tile(12),
      ],
      tile(12, 3),
    );
  drain(0, [tile(1), tile(9)], tile(2, 3));
  play(0, tile(9));
}
export function finish(h: Harness, names = ["A", "B", "C", "D"]) {
  penultimate(h, names);
  while (at(h.calls.state).currentTurn !== 0) {
    const g = at(h.calls.state);
    h.request(at(names[at(g.currentTurn)]), { type: "PASS", turnId: g.turnId });
  }
  h.request(at(names[0]), {
    type: "PLAY",
    turnId: at(h.calls.state).turnId,
    tiles: [tile(1)],
  });
}
