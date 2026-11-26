import { expect, mock, spyOn, test } from "bun:test";
import { rules } from "@caxio/shared";
import type { GameState } from "@caxio/shared/contracts/domain";
import {
  a4Settlement,
  abandonmentResults,
  firstDealState,
  nonHostAbandonmentLobby,
  roomCode,
} from "@caxio/shared/contracts/fixtures";
import { ROOM_DISPOSAL_MS, SEAT_RESERVATION_MS } from "../contracts";
import { at, tile } from "./rules.fixture";
import { harness } from "./service.fixture";

type Harness = ReturnType<typeof harness>;
const names = ["A", "B", "C", "D"];
function expire(h: Harness) {
  h.clock.time += h.timer().delay;
  h.timer().fire();
}
function pass(h: Harness) {
  const g = at(h.calls.state);
  h.request(at(names[at(g.currentTurn)]), { type: "PASS", turnId: g.turnId });
}
function twoExpiries(h: Harness) {
  h.start();
  h.close("A");
  for (let i = 0; i < 2; i++) {
    const previous = h.calls.automatic;
    const timer = h.timer();
    h.clock.time += timer.delay - 1;
    timer.fire();
    timer.fire();
    expect(h.calls.automatic).toBe(previous);
    const due = h.timer();
    expire(h);
    due.fire();
    expect(h.calls.automatic).toBe(previous + 1);
    expect(h.latest("B").view.lastAction).toMatchObject({
      type: "PLAY",
      automatic: true,
      seatId: 0,
    });
    pass(h);
    if (i === 0) pass(h);
  }
}
type Boundary =
  | "follow PASS"
  | "ordinary lead"
  | "last non-final"
  | "last final"
  | "last before bankruptcy";
function boundary(kind: Boundary, random = () => 0.25) {
  const h = harness(5, undefined, random);
  twoExpiries(h);
  // C opens the third disconnected turn. Supply the endgame hands and prior ledger at that boundary.
  if (kind.startsWith("last")) {
    const apply = h.rules.applyTurn;
    h.rules.applyTurn = (...args) => {
      const result = apply(...args);
      if (!result.ok) return result;
      const g = result.state;
      const last = kind === "last final";
      const short = kind === "last before bankruptcy";
      const previous = (d: (typeof a4Settlement.details)[number]) =>
        d && { ...d, round: 4 };
      const [a, b, c] = a4Settlement.details;
      const state: GameState = {
        ...g,
        round: last ? 5 : 1,
        lastSettlement: last
          ? {
              ...a4Settlement,
              round: 4,
              details: [previous(a), previous(b), previous(c), null, null],
            }
          : null,
        players: [
          { ...at(g.players[0]), hand: [tile(3)] },
          {
            ...at(g.players[1]),
            hand: short
              ? [
                  tile(2),
                  tile(2, 1),
                  tile(2, 2),
                  tile(4),
                  tile(5),
                  tile(6),
                  tile(7),
                  tile(9),
                ]
              : [tile(6)],
          },
          { ...at(g.players[2]), hand: [tile(8)] },
          null,
          null,
        ],
      };
      h.calls.state = state;
      return { ...result, state };
    };
    pass(h);
    h.rules.applyTurn = apply;
  } else if (kind === "ordinary lead") pass(h);
  else
    h.request("C", {
      type: "PLAY",
      turnId: at(h.calls.state).turnId,
      tiles: [tile(8, 2)],
    });
  expect(h.calls.state?.currentTurn).toBe(0);
  return h;
}

for (const kind of [
  "follow PASS",
  "ordinary lead",
  "last non-final",
  "last final",
  "last before bankruptcy",
] as const) {
  test(`A18 third expiry skips action, settlement, advance and deal: ${kind}`, () => {
    const random = mock(() => 0.25);
    const h = boundary(kind, random);
    const draws = random.mock.calls.length;
    const game = at(h.calls.state);
    expect(game.round).toBe(kind === "last final" ? 5 : 1);
    expect(game.seatOrder.map((id) => at(game.players[id]).chips)).toEqual([
      64, 64, 64,
    ]);
    const candidate = rules.timeoutAction(game);
    expect(candidate.type).toBe(kind === "follow PASS" ? "PASS" : "PLAY");
    if (kind.startsWith("last"))
      expect(candidate).toEqual({ type: "PLAY", tiles: [tile(3)] });
    const timeout = spyOn(h.rules, "timeoutAction");
    const before = { ...h.calls };
    const previous = h.latest("B");
    const index = h.log.length;
    const timer = h.timer();
    expire(h);
    timer.fire();
    expect(h.calls).toEqual({
      ...before,
      rankings: before.rankings + 1,
      timeouts: before.timeouts + 1,
    });
    expect(timeout.mock.results.map((r) => r.value)).toEqual([candidate]);
    expect(timer.cancelled).toBe(true);
    expect(random.mock.calls).toHaveLength(draws);
    const ranking = abandonmentResults.threeTied.result.ranking;
    for (const name of ["B", "C"]) {
      expect(h.latest(name)).toMatchObject({
        revision: previous.revision + 1,
        view: {
          phase: "LOBBY",
          currentTurn: null,
          lastSettlement: null,
          deadline: null,
          lastGameResult: { reason: "ABANDONMENT", leaverSeatId: 0, ranking },
        },
      });
      expect(h.latest(name).view.slots[0]).toBeNull();
    }
    expect(h.log.slice(index)).toEqual(
      ["B", "C"].map((name) => ({ name, message: h.latest(name) })),
    );
    h.reject(
      "old",
      { type: "RESUME", roomCode, token: "fixture-A" },
      "RESUME_DENIED",
    );
  });
}
for (const kind of ["last final", "last before bankruptcy"] as const) {
  test(`A18 connected same last tile settles once, then GAME_OVER: ${kind}`, () => {
    const h = boundary(kind);
    h.resume("restored", "A");
    h.rules.settle = (state) => {
      h.calls.settlements++;
      return rules.settle(state);
    };
    const index = h.snaps("B").length;
    h.request("restored", {
      type: "PLAY",
      turnId: at(h.calls.state).turnId,
      tiles: [tile(3)],
    });
    const frames = h.snaps("B").slice(index);
    expect(frames.map((s) => s.view.phase)).toEqual([
      "ROUND_SETTLEMENT",
      "GAME_OVER",
    ]);
    expect(h.calls.settlements).toBe(1);
    expect(h.calls.endChecks).toBe(1);
    expect(
      at(at(h.calls.state).lastSettlement).payments.length,
    ).toBeGreaterThan(0);
    expect(rules.isGameOver(at(h.calls.state))).toBe(
      kind === "last final" ? "LAST_ROUND" : "FEWER_THAN_THREE",
    );
  });
}
for (const first of ["timer", "resume", "late PASS", "late PLAY"] as const) {
  test(`A17 exact third deadline processes once with ${first} first`, () => {
    const h = boundary("ordinary lead");
    const timer = h.timer();
    h.clock.time = at(h.latest("B").view.deadline);
    const log = h.log.length;
    if (first === "timer") timer.fire();
    if (first.startsWith("late")) {
      const turnId = at(h.calls.state).turnId;
      h.request(
        "B",
        first === "late PASS"
          ? { type: "PASS", turnId }
          : { type: "PLAY", turnId, tiles: [tile(4)] },
      );
      expect(h.messages("B").at(-1)).toEqual({
        type: "ERROR",
        code: "TIME_EXPIRED",
      });
    }
    h.resume("returned", "A");
    timer.fire();
    expect(h.messages("returned")).toEqual([
      { type: "ERROR", code: "RESUME_DENIED" },
    ]);
    expect(
      h.log
        .slice(log)
        .filter((r) => r.message.type === "SNAPSHOT")
        .map((r) => r.name),
    ).toEqual(["B", "C"]);
    expect([h.calls.automatic, h.calls.rankings, h.calls.timeouts]).toEqual([
      2, 1, 3,
    ]);
  });
}

test("A17 return 1ms before third deadline requires three fresh disconnected turns", () => {
  const h = boundary("ordinary lead");
  h.clock.time = at(h.latest("B").view.deadline) - 1;
  h.resume("restored", "A");
  expect(h.latest("restored").view.phase).toBe("TURN_ACTIVE");
  h.close("restored");
  h.clock.time++;
  h.timer().fire();
  pass(h);
  pass(h);
  expire(h);
  pass(h);
  pass(h);
  expect(h.calls.automatic).toBe(4);
  expire(h);
  expect(h.latest("B").view.phase).toBe("LOBBY");
});
test("A17 exact second expiry before resume applies once and resets only the returning seat", () => {
  const h = harness();
  h.start();
  h.close("A");
  h.close("B");
  expire(h);
  expire(h);
  pass(h);
  const timer = h.timer();
  h.clock.time = at(h.latest("C").view.deadline);
  h.resume("restored", "A");
  expect(h.latest("restored").view.lastAction).toMatchObject({
    seatId: 0,
    automatic: true,
  });
  timer.fire();
  h.close("restored");
  expire(h);
  pass(h);
  expire(h);
  expire(h);
  expect(h.latest("C").view).toMatchObject({
    phase: "LOBBY",
    lastGameResult: { leaverSeatId: 1 },
  });
  expect(h.calls.automatic).toBe(5);
});
test("A17 connected expiry contributes zero after disconnection", () => {
  const h = harness();
  h.start();
  expire(h);
  pass(h);
  pass(h);
  h.close("A");
  expire(h);
  pass(h);
  pass(h);
  expire(h);
  pass(h);
  pass(h);
  expect(h.calls.automatic).toBe(3);
  expire(h);
  expect(h.latest("B").view.phase).toBe("LOBBY");
});

for (const returns of [false, true]) {
  test(`A20 lobby reservation from abandonment, remaining seat ${returns ? "resumes at 29999ms" : "released at 30000ms"}`, () => {
    const h = boundary("ordinary lead");
    h.close("B");
    const third = h.timer();
    expire(h);
    const reservation = h.timer();
    expect(reservation.delay).toBe(SEAT_RESERVATION_MS);
    const result = h.latest("C").view;
    expect(result).toMatchObject({
      phase: "LOBBY",
      hostSeatId: 1,
      lastGameResult: abandonmentResults.threeTied.result,
    });
    h.clock.time += SEAT_RESERVATION_MS - 1;
    reservation.fire();
    const due = h.timer();
    expect(due.delay).toBe(1);
    expect(h.latest("C").view.slots[1]?.isConnected).toBe(false);
    if (returns) h.resume("restored", "B");
    h.clock.time++;
    due.fire();
    expect(h.latest("C").view.slots[1]?.isConnected ?? null).toBe(
      returns ? true : null,
    );
    h.join("newHostSlot");
    if (!returns) h.join("newGuestSlot");
    expect(h.latest("C").view).toMatchObject({
      lastGameResult: abandonmentResults.threeTied.result,
      seatOrder: returns ? [1, 2, 0] : [2, 0, 1],
    });
    h.clock.time += ROOM_DISPOSAL_MS;
    for (const old of h.timers) old.fire();
    h.resume("C2", "C");
    expect(h.latest("C2").view).toEqual(h.latest("C").view);
    h.request(returns ? "restored" : "C2", { type: "START_GAME" });
    const active = h.latest("C2");
    expect(active.view.phase).toBe("TURN_ACTIVE");
    for (const old of [reservation, due, third]) old.fire();
    expect(h.latest("C2")).toBe(active);
  });
}
test("A20 remaining lobby reservations expire independently", () => {
  const h = boundary("ordinary lead");
  h.close("B");
  const third = h.timer();
  h.close("C");
  const before = h.timers.length;
  h.clock.time += third.delay;
  third.fire();
  const reservations = h.timers.slice(before);
  expect(reservations.map((t) => t.delay)).toEqual([
    SEAT_RESERVATION_MS,
    SEAT_RESERVATION_MS,
  ]);
  h.clock.time += SEAT_RESERVATION_MS - 1;
  h.resume("restored", "B");
  expect(reservations.map((t) => t.cancelled)).toEqual([true, false]);
  h.clock.time++;
  for (const timer of reservations) timer.fire();
  expect(h.latest("restored").view).toMatchObject({
    phase: "LOBBY",
    seatOrder: [1],
    lastGameResult: abandonmentResults.threeTied.result,
  });
  h.reject(
    "old",
    { type: "RESUME", roomCode, token: "fixture-C" },
    "RESUME_DENIED",
  );
});
test("A20 abandonment preserves the original all-disconnected disposal", () => {
  const h = boundary("ordinary lead");
  h.close("B");
  const turn = h.timer();
  h.close("C");
  const disposal = h.timer();
  const end = h.clock.time + ROOM_DISPOSAL_MS;
  h.clock.time += turn.delay;
  turn.fire();
  expect(h.calls.rankings).toBe(1);
  expect(h.timers.filter((t) => t.delay === ROOM_DISPOSAL_MS)).toEqual([
    disposal,
  ]);
  expect(disposal.cancelled).toBe(false);
  h.clock.time = end;
  disposal.fire();
  h.reject(
    "lost",
    { type: "RESUME", roomCode, token: "fixture-B" },
    "ROOM_NOT_FOUND",
  );
});
test("A17 A19 A20 A21 non-host leaves with a previous OUT spectator, original host restarts everyone alive", () => {
  const h = harness();
  h.tokens.push("fresh-credential");
  h.lobby();
  h.close("A");
  const a = h.timer();
  h.close("B");
  const b = h.timer();
  h.clock.time += SEAT_RESERVATION_MS;
  a.fire();
  b.fire();
  h.join("X");
  h.join("Y");
  h.join("D");
  const advance = h.rules.advance;
  h.rules.advance = (state, rng) => {
    const active = advance(state, rng);
    const [p0, p1, p2] = firstDealState.players;
    const following: GameState = {
      ...active,
      round: 2,
      maxNumber: 9,
      currentTurn: 0,
      roundLeader: 0,
      lastPlayedBy: 0,
      players: [
        { ...p0, chips: 60 },
        {
          ...p1,
          chips: 0,
          isOut: true,
          hand: [],
          eliminatedRound: 1,
          eliminatedEffectiveTiles: 64,
        },
        { ...p2, chips: 60 },
        { ...p1, chips: 136 },
        null,
      ],
      activePlayers: [2, 0, 3],
      lastSettlement: {
        round: 1,
        payments: [],
        results: [
          { seatId: 3, rank: 1, chipChange: 72 },
          { seatId: 2, rank: 2, chipChange: -4 },
          { seatId: 0, rank: 3, chipChange: -4 },
          { seatId: 1, rank: 4, chipChange: -64 },
        ],
        details: [
          a4Settlement.details[1],
          a4Settlement.details[2],
          a4Settlement.details[1],
          a4Settlement.details[0],
          null,
        ],
      },
    };
    h.calls.state = following;
    return following;
  };
  h.request("C", { type: "START_GAME" });
  h.rules.advance = advance;
  h.close("Y");
  h.close("D");
  for (let i = 0; i < 3; i++) {
    const game = at(h.calls.state);
    h.request("X", { ...rules.timeoutAction(game), turnId: game.turnId });
    if (i === 2) h.resume("spectator", "E");
    expire(h);
    if (i < 2)
      h.request("C", { type: "PASS", turnId: at(h.calls.state).turnId });
  }
  expect(h.latest("C").view).toEqual(nonHostAbandonmentLobby.frame.view);
  h.reject(
    "old",
    { type: "RESUME", roomCode, token: "fixture-new" },
    "RESUME_DENIED",
  );
  for (const [socket, credential] of [
    ["C2", "C"],
    ["X2", "D"],
    ["Y2", "E"],
  ] as const)
    h.resume(socket, credential);
  h.join("replacement");
  expect(h.messages("replacement")[0]).toEqual({
    type: "SEATED",
    roomCode,
    seatId: 3,
    token: "fresh-credential",
  });
  expect(h.latest("C2").view).toMatchObject({
    seatOrder: [2, 0, 1, 3],
    lastGameResult: abandonmentResults.previouslyOut.result,
  });
  h.request("C2", { type: "START_GAME" });
  const v = h.latest("Y2").view;
  expect(v).toMatchObject({
    phase: "TURN_ACTIVE",
    round: 1,
    activePlayers: [2, 0, 1, 3],
  });
  expect(v.ownHand).toHaveLength(13);
  expect(v).not.toHaveProperty("lastGameResult");
  for (const id of v.seatOrder)
    expect(v.slots[id]).toMatchObject({
      chips: 64,
      isOut: false,
      remainingTileCount: 13,
    });
});
