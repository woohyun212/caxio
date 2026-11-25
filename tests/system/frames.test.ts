import { expect, test } from "bun:test";
import type { SeatId } from "../../packages/shared/src/contracts/domain";
import {
  firstDealState,
  lastPlaySequence,
  phaseExamples,
  spectatorExamples,
} from "../../packages/shared/src/contracts/fixtures";
import type { PlayerView } from "../../packages/shared/src/contracts/wire";
import {
  checkAction,
  checkDeal,
  checkFinal,
  checkPublic,
  isPresence,
  judgeFrame,
  need,
  requireCheck,
} from "./judges";

const [lobby, start, active, , over] = phaseExamples;
const [before, passed, cleared, paid] = lastPlaySequence.continuing;
function judge(value: unknown, seat: SeatId = 0) {
  return judgeFrame(JSON.stringify(value), seat, new Map());
}
test("frozen phase, action and spectator frames decode for their recipients", () => {
  for (const f of [...phaseExamples, ...lastPlaySequence.continuing])
    expect(judge(f)).toEqual(f);
  for (const f of [
    spectatorExamples.transition,
    spectatorExamples.following,
    spectatorExamples.restored,
    spectatorExamples.gameOver,
  ])
    expect(judge(f, 3)).toEqual(f);
});
test("decoder rejects malformed, non-text, public extras and private keys", () => {
  for (const raw of ["{", new Uint8Array()])
    expect(() => judgeFrame(raw, 0, new Map())).toThrow("invalid server");
  expect(() =>
    judge({
      ...start,
      view: {
        ...start.view,
        slots: start.view.slots.map((s) => s && { ...s, secret: true }),
      },
    }),
  ).toThrow();
  for (const privateField of [
    { ownHand: [] },
    { ownSettlement: paid.view.ownSettlement },
  ])
    expect(() =>
      judge(
        {
          ...spectatorExamples.transition,
          view: { ...spectatorExamples.transition.view, ...privateField },
        },
        3,
      ),
    ).toThrow();
  expect(() => judge(paid, 1)).toThrow();
  expect(() => judgeFrame(JSON.stringify(start), null, new Map())).toThrow();
});
test("foreign token rejected even in an otherwise valid frame", () => {
  const raw = JSON.stringify({
    type: "SEATED",
    seatId: 0,
    roomCode: "AAAAAA",
    token: "stolen-token",
  });
  expect(() => judgeFrame(raw, null, new Map([[1, "stolen-token"]]))).toThrow(
    "foreign seat token",
  );
});
test("revision strictly increases and presence preserves the clock", () => {
  for (const delta of [0, -1])
    expect(() =>
      judgeFrame(
        JSON.stringify({ ...active, revision: active.revision + delta }),
        0,
        new Map(),
        active,
      ),
    ).toThrow("revision");
  expect(
    judgeFrame(
      JSON.stringify({
        ...active,
        revision: active.revision + 9,
        serverNow: 0,
      }),
      0,
      new Map(),
      active,
    ).type,
  ).toBe("SNAPSHOT");
  const v = active.view;
  requireCheck(v.phase === "TURN_ACTIVE", "fixture phase");
  const [s, ...rest] = v.slots;
  const slots: PlayerView["slots"] = [
    { ...need(s, "seat"), isConnected: false },
    ...rest,
  ];
  expect(isPresence(v, { ...v, slots })).toBe(true);
  expect(() => isPresence(v, { ...v, slots, deadline: 3 })).toThrow("deadline");
});
test("approved command matches last action, play, clear and private hand", () => {
  const pass = { type: "PASS" } as const,
    play = {
      type: "PLAY",
      tiles: need(paid.view.lastPlay, "play").tiles,
    } as const;
  checkAction(before.view, passed.view, 0, pass);
  checkAction(passed.view, cleared.view, 0, pass);
  checkAction(cleared.view, paid.view, 0, play);
  for (const change of [
    { seatId: 0 as const },
    { automatic: true },
    { turnId: 1 },
  ])
    expect(() =>
      checkAction(
        before.view,
        {
          ...passed.view,
          lastAction: { ...need(passed.view.lastAction, "action"), ...change },
        },
        0,
        pass,
      ),
    ).toThrow("lastAction");
  expect(() =>
    checkAction(
      cleared.view,
      { ...paid.view, lastPlay: cleared.view.lastPlay },
      0,
      play,
    ),
  ).toThrow("lastPlay");
  expect(() =>
    checkAction(
      passed.view,
      { ...cleared.view, tableHand: passed.view.tableHand },
      0,
      pass,
    ),
  ).toThrow("trick clear");
  expect(() =>
    checkAction(before.view, { ...passed.view, ownHand: [] }, 0, pass),
  ).toThrow("private hand");
});
test("deck partition and cloud 3 ownership", () => {
  const views = new Map<SeatId, PlayerView>(
    firstDealState.seatOrder.map((id) => [
      id,
      { ...start.view, ownHand: firstDealState.players[id].hand },
    ]),
  );
  checkDeal(views);
  expect(() =>
    checkDeal(
      new Map(
        [...views].map(([id, v]) => [
          id,
          { ...v, ownHand: firstDealState.players[0].hand },
        ]),
      ),
    ),
  ).toThrow("overlapping");
  expect(() =>
    checkDeal(
      new Map(
        [...views].map(([id, v]) => [
          id,
          {
            ...v,
            phase: "ROUND_START",
            round: 1,
            maxNumber: 9,
            ranking: [],
            deadline: null,
            turnId: null,
            currentTurn: 1,
          },
        ]),
      ),
    ),
  ).toThrow("cloud 3");
});
test("shared revisions agree on public table and final chips are conserved", () => {
  requireCheck(lobby.view.phase === "LOBBY", "fixture phase");
  const seen = new Map();
  checkPublic(seen, lobby);
  checkPublic(seen, { ...lobby, view: { ...lobby.view, canStart: false } });
  expect(() =>
    checkPublic(seen, { ...lobby, view: { ...lobby.view, maxRounds: 1 } }),
  ).toThrow("public table");
  checkFinal(over.view);
  const [s, ...rest] = over.view.slots;
  const slots: PlayerView["slots"] = [
    { ...need(s, "seat"), chips: 0 },
    ...rest,
  ];
  expect(() => checkFinal({ ...over.view, slots })).toThrow("chip total");
});
