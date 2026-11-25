import { expect, test } from "bun:test";
import type { SeatId } from "./domain";
import {
  lastPlaySequence,
  normalCommands,
  phaseExamples,
  seatReuse,
  spectatorExamples,
} from "./fixtures";
import type { Snapshot } from "./wire";
import { decodeCommand, decodeServerMessage } from "./wire";

const [lobby, start, active, paid, over] = phaseExamples;
const [play, pass, clear, , next] = lastPlaySequence.continuing;
type Changes = Record<string, unknown>;
// Paths address fields on a fresh copy, allowing a case to change coupled fields together.
function checkPatches(
  base: Snapshot,
  recipient: SeatId,
  cases: readonly Changes[],
) {
  expect(decodeServerMessage(JSON.stringify(base), recipient)).toEqual(base);
  for (const changes of cases) {
    const copy: unknown = structuredClone(base.view);
    for (const [path, value] of Object.entries(changes)) {
      let target = copy;
      const parts = path.split(".");
      const key = parts.pop();
      for (const part of parts) {
        if (!target || typeof target !== "object") throw Error(path);
        target = Reflect.get(target, part);
      }
      if (!key || !target || typeof target !== "object") throw Error(path);
      Reflect.set(target, key, value);
    }
    expect(
      decodeServerMessage(JSON.stringify({ ...base, view: copy }), recipient),
      JSON.stringify(changes),
    ).toBe("INVALID_MESSAGE");
  }
}
const t = { number: 3, suit: 0 };
test("message envelopes reject malformed, unbound and misdirected data", () => {
  const read = (value: unknown, seat: SeatId | null) =>
    decodeServerMessage(JSON.stringify(value), seat);
  for (const v of [
    null,
    [],
    { type: "OTHER" },
    { type: "ERROR", code: "unknown" },
    { type: "ERROR", code: ["ROOM_FULL"] },
    { type: "ERROR", code: "NOT_SEATED", private: 1 },
    { ...active, revision: -1 },
    { ...active, serverNow: "1" },
    { ...active, view: null },
  ])
    expect(read(v, 0)).toBe("INVALID_MESSAGE");
  expect(read(active, 4)).toBe("INVALID_MESSAGE");
  const seated = seatReuse.credentials.A;
  for (const v of [
    { ...seated, token: "" },
    { ...seated, token: ["x"] },
    { ...seated, seatId: 5 },
    { ...seated, roomCode: "bad" },
    { ...seated, hand: [] },
  ])
    expect(read(v, null)).toBe("INVALID_MESSAGE");
  expect(read(seated, 1)).toBe("INVALID_MESSAGE");
  for (const turnId of [null, "1", 0, 1.5])
    expect(
      decodeCommand(JSON.stringify({ ...normalCommands[4], turnId })),
    ).toBe("INVALID_MESSAGE");
});
test("slots, order, lobby authority and idle fields", () => {
  checkPatches(lobby, 0, [
    { hostSeatId: 1 },
    { canStart: false },
    { maxNumber: 9 },
    { round: 1 },
    { consecutivePasses: 1 },
    { activePlayers: [0] },
    { "slots.2.remainingTileCount": 1 },
    { "slots.1.isOut": true },
    { "slots.3": lobby.view.slots[2] },
    { seatOrder: [0, 1] },
    { lastPlay: play.view.lastPlay },
    { tableHand: [t] },
    { lastAction: play.view.lastAction },
    { lastSettlement: paid.view.lastSettlement },
    { roomCode: "ABCD23" },
  ]);
  checkPatches(seatReuse.bDisconnected, 0, [
    { canStart: true },
    { hostSeatId: 1 },
  ]);
  checkPatches(seatReuse.joins[0], 0, [{ canStart: true }]);
  checkPatches(seatReuse.joins[1], 0, [
    { seatOrder: [0, 1, 1], canStart: true },
  ]);
  if (lobby.view.phase !== "LOBBY") throw Error("missing lobby");
  checkPatches({ ...lobby, view: { ...lobby.view, canStart: false } }, 1, [
    { canStart: true },
  ]);
  checkPatches(active, 0, [
    { "slots.2.chips": -1 },
    { "slots.2.remainingTileCount": 14 },
    { "slots.1.isOut": 0 },
    { "slots.1.isConnected": 1 },
    { phase: "UNKNOWN" },
    { maxRounds: 1.5 },
    { round: 0 },
    { round: 6 },
    { consecutivePasses: -1 },
    { ranking: {} },
    { activePlayers: [1, 0, 2] },
    { currentTurn: 4 },
    { deadline: 0.5 },
    { turnId: 0 },
    { maxNumber: 15 },
    { ownHand: [] },
    { "ownHand.0.number": 10 },
    { "ownHand.0.suit": 8 },
    { "ownHand.0": active.view.ownHand?.[1] },
  ]);
  checkPatches(start, 0, [
    { phase: "UNKNOWN", currentTurn: null },
    { "slots.2.remainingTileCount": 11 },
    { consecutivePasses: 1 },
    {
      lastPlay: play.view.lastPlay,
      lastAction: play.view.lastAction,
      tableHand: play.view.tableHand,
    },
  ]);
  checkPatches(paid, 0, [{ activePlayers: [0, 1] }]);
  checkPatches(spectatorExamples.restored, 3, [
    { "slots.1.isOut": true, activePlayers: [0, 2], maxNumber: null },
  ]);
});
test("table and last action describe the same completed turn", () => {
  checkPatches(play, 0, [
    { "lastAction.automatic": 1 },
    { "lastAction.type": "DEAL" },
    { "lastAction.turnId": 59 },
    { "lastAction.seatId": 2 },
    { turnId: 60 },
    { tableHand: null },
    { tableHand: [t] },
    { tableHand: [] },
    { "tableHand.0.secret": true },
  ]);
  checkPatches(clear, 0, [
    { "lastPlay.turnId": 0 },
    { "lastPlay.seatId": 4 },
    { "lastPlay.tiles.0.number": 10 },
    {
      "lastPlay.tiles": [
        t,
        { ...t, suit: 1 },
        { ...t, suit: 2 },
        { ...t, suit: 3 },
      ],
    },
    { "lastPlay.tiles": [t, t] },
    { lastAction: null },
    { lastPlay: null },
    { "lastPlay.private": [] },
    { "lastAction.private": [] },
  ]);
  checkPatches(pass, 0, [
    { "lastAction.turnId": 60 },
    { "lastAction.seatId": 4 },
  ]);
  checkPatches(paid, 0, [
    { "lastAction.type": "PASS", "lastAction.turnId": 64 },
    { lastPlay: null, lastAction: null, tableHand: null },
    { tableHand: null },
  ]);
});
test("paid rounds disclose complete balanced public rows and eligible private arithmetic", () => {
  checkPatches(paid, 0, [
    { maxNumber: 13 },
    { "lastSettlement.round": 2 },
    { "lastSettlement.results": null },
    { "lastSettlement.results.0.rank": 0 },
    { "lastSettlement.results.1.rank": 1 },
    { "lastSettlement.results.0.chipChange": 4 },
    {
      "lastSettlement.results.0.chipChange": 3.5,
      "lastSettlement.results.2.chipChange": -3.5,
    },
    { "ownSettlement.extra": true },
    { "ownSettlement.round": 2 },
    { "ownSettlement.remaining": 1, "ownSettlement.effective": 1 },
  ]);
  const out = spectatorExamples.transition;
  checkPatches(out, 3, [
    { "lastSettlement.results.3.seatId": 4 },
    { "lastSettlement.results.3.seatId": 1 },
  ]);
  const restored = spectatorExamples.restored;
  checkPatches(restored, 3, [
    {
      "lastSettlement.results": [
        { rank: 1, seatId: 0, chipChange: 0 },
        { rank: 2, seatId: 1, chipChange: 0 },
        { rank: 3, seatId: 3, chipChange: 0 },
      ],
    },
  ]);
  checkPatches(next, 0, [
    { "ownSettlement.remaining": 14, "ownSettlement.effective": 14 },
    { "ownSettlement.twos": 1 },
    { lastSettlement: null },
    { round: 3 },
  ]);
  checkPatches(spectatorExamples.survivor.frame, 1, [
    { "ownSettlement.twos": 1, "ownSettlement.effective": 2 },
  ]);
});
test("final rankings include each occupant and use competition ranks", () => {
  checkPatches(over, 0, [
    { maxRounds: 2 },
    { ranking: null },
    { ranking: over.view.ranking.slice(0, 2) },
    { "ranking.0.extra": true },
    { "ranking.0.seatId": 3 },
    { "ranking.0.seatId": 1 },
    { "ranking.0.rank": 0 },
    { "ranking.2.rank": 1 },
  ]);
});
