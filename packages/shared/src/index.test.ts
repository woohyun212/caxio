import { expect, test } from "bun:test";
import * as engine from "@caxio/shared";
import type { Action, GameState, Tile } from "./contracts/domain";
import {
  a4Settlement,
  dealExamples,
  firstDealState,
  gameOverExamples,
  gameOverState,
  lastPlaySequence,
  settledState,
  tiedRankingExample,
  turnErrorExamples,
} from "./contracts/fixtures";

const {
  rules,
  startRound,
  advance,
  applyTurn,
  timeoutAction,
  classify,
  compare,
  settle,
  rank,
  isGameOver,
  rankTile,
} = engine;
const identityShuffle = () => 0.999999;
function play(state: GameState, action: Action) {
  if (state.currentTurn === null) throw Error("No actor");
  const result = applyTurn(state, state.currentTurn, action);
  if (!result.ok) throw Error(result.code);
  return result.state;
}
function tile(number: number, suit: Tile["suit"] = 0): Tile {
  return { number, suit };
}
test("A1 public engine deals every deck and opens on the cloud 3 holder", () => {
  expect(rules).toEqual({
    startRound,
    advance,
    applyTurn,
    timeoutAction,
    classify,
    compare,
    settle,
    rank,
    isGameOver,
    rankTile,
  });
  for (const { view } of dealExamples) {
    if (view.phase !== "ROUND_START") throw Error("Expected deal");
    let state = startRound(view.seatOrder, identityShuffle);
    for (let round = 1; round <= 2; round++) {
      expect(state.maxNumber).toBe(view.maxNumber);
      const all = state.players.flatMap((p) => p?.hand ?? []);
      expect(new Set(all.map((t) => t.number * 4 + t.suit)).size).toBe(
        view.maxNumber * 4,
      );
      for (const id of state.activePlayers) {
        expect(state.players[id]?.hand).toHaveLength(
          view.slots[id]?.remainingTileCount ?? 0,
        );
        expect(state.players[id]?.chips).toBe(64);
      }
      const hand =
        state.currentTurn === null
          ? undefined
          : state.players[state.currentTurn]?.hand;
      expect(hand).toContainEqual(tile(3));
      const other = hand?.find((t) => t.number !== 3);
      if (!other) throw Error("missing opening tile");
      expect(
        play(advance(state, identityShuffle), { type: "PLAY", tiles: [other] })
          .lastPlay?.tiles,
      ).toEqual([other]);
      state = advance({ ...state, phase: "ROUND_SETTLEMENT" }, () => 0.25);
    }
  }
});

test("A2/A3 applyTurn validates the frozen errors and permits returning after a pass", () => {
  const active = advance(firstDealState, identityShuffle);
  for (const example of turnErrorExamples) {
    if (
      example.reply.code === "TIME_EXPIRED" ||
      example.reply.code === "STALE_TURN"
    )
      continue;
    const state = {
      ...active,
      tableHand: example.before.view.tableHand,
      currentTurn: example.before.view.currentTurn,
    };
    expect(applyTurn(state, example.recipient, example.command)).toMatchObject({
      ok: false,
      state,
      code: example.reply.code,
    });
  }
  const pair = [tile(3), tile(3, 1)];
  const single = classify(pair.slice(1), 9),
    key = classify(pair, 9);
  if (!single || !key) throw Error("missing keys");
  expect(single.key).toEqual(key.key);
  expect(compare(key, single)).toBe(false);
  expect(
    applyTurn({ ...active, tableHand: pair.slice(1) }, 0, {
      type: "PLAY",
      tiles: pair,
    }),
  ).toMatchObject({ code: "WRONG_COUNT" });
  expect(
    applyTurn(active, 0, {
      type: "PLAY",
      tiles: active.players[0]?.hand.filter((t) => t.number === 3) ?? [],
    }),
  ).toMatchObject({ code: "ILLEGAL_HAND" });
  expect(() => rankTile(tile(10), 9)).toThrow(RangeError);
  expect(timeoutAction(active)).toEqual({ type: "PLAY", tiles: [tile(3)] });
  const opening = play(active, timeoutAction(active));
  expect(timeoutAction(opening)).toEqual({ type: "PASS" });
  const [a, b, c] = firstDealState.players;
  let game: GameState = {
    ...active,
    players: [
      { ...a, hand: [tile(3), tile(4)] },
      { ...b, hand: [tile(8), tile(9)] },
      { ...c, hand: [tile(5), tile(6)] },
      null,
      null,
    ],
  };
  for (const action of [
    { type: "PLAY", tiles: [tile(3)] },
    { type: "PASS" },
    { type: "PLAY", tiles: [tile(5)] },
    { type: "PASS" },
    { type: "PLAY", tiles: [tile(8)] },
    { type: "PASS" },
    { type: "PASS" },
  ] as const)
    game = play(game, action);
  expect(game.currentTurn).toBe(1);
  expect(game.tableHand).toBeNull();
  expect(game.consecutivePasses).toBe(0);
});

test("A3/A4 frozen winning play settles immediately, A5 preserves or clears its history", () => {
  const [a, b, c] = settledState.players;
  const before = lastPlaySequence.continuing[0].view;
  if (before.phase !== "TURN_ACTIVE" || !before.ownHand)
    throw Error("Missing turn");
  let state: GameState = {
    ...firstDealState,
    phase: "TURN_ACTIVE",
    turnId: before.turnId,
    currentTurn: before.currentTurn,
    tableHand: before.tableHand,
    lastPlay: before.lastPlay,
    lastAction: before.lastAction,
    players: [
      { ...a, chips: 64, hand: before.ownHand },
      b,
      { ...c, chips: 64 },
      null,
      null,
    ],
  };
  for (const step of lastPlaySequence.continuing.slice(1, 4)) {
    const action =
      step.view.lastAction?.type === "PASS"
        ? ({ type: "PASS" } as const)
        : ({ type: "PLAY", tiles: settledState.tableHand } as const);
    state = play(state, action);
    expect(state.lastPlay).toEqual(step.view.lastPlay);
    expect(state.lastAction).toEqual(step.view.lastAction);
    expect(state.tableHand).toEqual(step.view.tableHand);
  }
  expect(state).toEqual(settledState);
  expect(state.lastSettlement).toEqual(a4Settlement);
  expect(
    advance({ ...state, maxRounds: 1 }, () => {
      throw Error("extra deal");
    }),
  ).toEqual(gameOverState);
  let draws = 0;
  const next = advance(state, () => {
    draws++;
    return identityShuffle();
  });
  expect(draws).toBe(35);
  expect(next).toMatchObject({
    phase: "ROUND_START",
    round: 2,
    lastPlay: null,
    lastSettlement: a4Settlement,
  });
  expect(next.players.flatMap((p) => p?.hand ?? [])).toHaveLength(36);
});

test("A4 effective order breaks ties by remaining tiles then lead order, bankruptcy stops collections", () => {
  const player = (hand: readonly Tile[], chips = 64) => ({
    ...firstDealState.players[0],
    hand,
    chips,
  });
  for (const chips of [1, 2]) {
    const state: GameState = {
      ...settledState,
      roundLeader: 3,
      seatOrder: [0, 1, 2, 3, 4],
      activePlayers: [0, 1, 2, 3, 4],
      players: [
        player([]),
        player([tile(2)], chips),
        player([tile(3), tile(4)]),
        player([tile(2, 1)]),
        player([tile(2, 2), tile(2, 3)]),
      ],
    };
    const output = settle(state),
      log = output.lastSettlement;
    if (!log) throw Error("missing settlement");
    expect(log.details.map((d) => d?.effective)).toEqual([0, 2, 2, 2, 8]);
    expect(log.results.map((r) => r.seatId)).toEqual([0, 3, 1, 2, 4]);
    expect(output.players[1]).toMatchObject({
      chips: 0,
      isOut: true,
      eliminatedRound: 1,
      eliminatedEffectiveTiles: 2,
    });
    const balance = state.players.map((p) => p?.chips ?? 0);
    const total = balance.reduce((a, b) => a + b, 0);
    for (const { from, to, amount } of log.payments) {
      expect(balance[to]).toBeGreaterThan(0);
      balance[from] = (balance[from] ?? 0) - amount;
      balance[to] = (balance[to] ?? 0) + amount;
      expect(Math.min(...balance)).toBeGreaterThanOrEqual(0);
      expect(balance.reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(balance).toEqual(output.players.map((p) => p?.chips ?? 0));
  }
});

test("A5 terminal reasons, no further shuffle, survivor and eliminated ranking keys", () => {
  const stop = () => {
    throw Error("terminal state requested another deal");
  };
  for (const {
    snapshot: { view },
    reason,
  } of gameOverExamples) {
    const state = {
      ...settledState,
      round: view.round,
      maxRounds: view.maxRounds,
      activePlayers: view.activePlayers,
    };
    expect(isGameOver(state)).toBe(reason);
    expect(advance(state, stop).phase).toBe("GAME_OVER");
  }
  for (const survivors of [[0], [0, 1], [0, 1, 2]] as const) {
    const round = survivors.length === 3 ? 5 : 1;
    expect(
      advance({ ...settledState, round, activePlayers: survivors }, stop).phase,
    ).toBe("GAME_OVER");
  }
  const [a, b, c] = settledState.players;
  const state: GameState = {
    ...settledState,
    players: [
      { ...a, chips: 65 },
      { ...b, chips: 65 },
      { ...c, chips: 62 },
      null,
      null,
    ],
    lastSettlement: {
      ...a4Settlement,
      details: [
        a4Settlement.details[1],
        a4Settlement.details[1],
        a4Settlement.details[0],
        null,
        null,
      ],
    },
  };
  expect(rank(state)).toEqual(tiedRankingExample.view.ranking);
  const fullTie: GameState = {
    ...state,
    players: [a, a, a, null, null],
    lastSettlement: {
      ...a4Settlement,
      details: [
        a4Settlement.details[0],
        a4Settlement.details[0],
        a4Settlement.details[0],
        null,
        null,
      ],
    },
  };
  expect(rank(fullTie).map((row) => row.rank)).toEqual([1, 1, 1]);
  const out = (round: number, effective: number) => ({
    ...c,
    chips: 0,
    isOut: true,
    eliminatedRound: round,
    eliminatedEffectiveTiles: effective,
  });
  expect(
    rank({
      ...state,
      seatOrder: [1, 0, 2, 3, 4],
      activePlayers: [1, 0],
      players: [
        state.players[0],
        state.players[1],
        out(1, 1),
        out(2, 8),
        out(2, 5),
      ],
      lastSettlement: a4Settlement,
    }).map((row) => row.seatId),
  ).toEqual([0, 1, 4, 3, 2]);
});
