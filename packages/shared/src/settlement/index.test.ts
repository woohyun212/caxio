import { expect, test } from "bun:test";
import type {
  GameState,
  PlayerState,
  RankingRow,
  SeatId,
  Slots,
  Suit,
} from "../contracts/domain";
import {
  a4Settlement,
  gameOverExamples,
  gameOverState,
  settledState,
  spectatorExamples,
  tiedRankingExample,
} from "../contracts/fixtures";
import { isGameOver, rank, settle } from "./index";

const seats = [0, 1, 2, 3, 4] as const;
function player(remaining: number, chips = 64, twos = 0): PlayerState {
  const suits: readonly Suit[] = [0, 1, 2, 3];
  return {
    ...settledState.players[0],
    chips,
    hand: Array.from({ length: remaining }, (_, i) => ({
      number: i < twos ? 2 : 3 + Math.floor((i - twos) / 4),
      suit: suits[i % 4] ?? 0,
    })),
  };
}

function state(
  players: Slots<PlayerState>,
  seatOrder = seats.filter((id) => players[id] !== null),
): GameState {
  return {
    ...settledState,
    players,
    seatOrder,
    activePlayers: seatOrder.filter((id) => !players[id]?.isOut),
    lastSettlement: null,
  };
}

function verifiedSettlement(input: GameState) {
  const original = structuredClone(input);
  const output = settle(input);
  expect(input).toEqual(original);
  const log = output.lastSettlement;
  if (!log) throw new Error("Expected a settlement");
  const balances = input.players.map((p) => p?.chips ?? 0);
  const sum = () => balances.reduce((a, b) => a + b, 0);
  const total = sum();
  for (const { from, to, amount } of log.payments) {
    const payer = balances[from] ?? 0;
    const receiver = balances[to] ?? 0;
    expect(input.activePlayers).toContain(from);
    expect(input.activePlayers).toContain(to);
    expect(amount).toBeGreaterThan(0);
    expect(payer).toBeGreaterThanOrEqual(amount);
    expect(receiver).toBeGreaterThan(0);
    balances[from] = payer - amount;
    balances[to] = receiver + amount;
    expect(sum()).toBe(total);
  }
  expect(balances).toEqual(output.players.map((p) => p?.chips ?? 0));
  expect(output.activePlayers).toEqual(
    input.activePlayers.filter((id) => balances[id] !== 0),
  );
  expect(output.phase).toBe(input.phase);
  expect(log.results.map((r) => r.seatId).sort()).toEqual(
    [...input.activePlayers].sort(),
  );
  expect(log.results.map((r) => r.rank)).toEqual(
    input.activePlayers.map((_, i) => i + 1),
  );
  expect(log.results.reduce((net, r) => net + r.chipChange, 0)).toBe(0);
  for (const r of log.results) {
    const before = input.players[r.seatId];
    const after = output.players[r.seatId];
    if (!before || !after) throw new Error("Missing participant");
    expect(after.hand).toBe(before.hand);
    expect(after.isOut).toBe(after.chips === 0);
    expect(r.chipChange).toBe(after.chips - before.chips);
  }
  return { output, log };
}

test("payment ranks use effective count, remaining count, then rotated turn order", () => {
  const input = state([
    player(4),
    player(2, 64, 1),
    player(0),
    player(2, 64, 1),
    player(3, 64, 3),
  ]);
  for (const [leader, tieOrder] of [
    [3, [3, 1]],
    [1, [1, 3]],
    [null, [1, 3]],
  ] as const) {
    const { log } = verifiedSettlement({ ...input, roundLeader: leader });
    expect(log.results.map((r) => r.seatId)).toEqual([2, ...tieOrder, 0, 4]);
    expect(log.details.map((d) => d?.effective)).toEqual([4, 4, 0, 4, 24]);
    expect(log.details[4]).toEqual({
      round: 1,
      remaining: 3,
      twos: 3,
      effective: 24,
    });
  }
});

test("absent leaders use active join order and equal counts transfer nothing", () => {
  const input = state([player(1), null, player(1), null, player(1)], [4, 0, 2]);
  for (const leader of [null, 1] as const) {
    const { log } = verifiedSettlement({ ...input, roundLeader: leader });
    expect(log.results.map((r) => r.seatId)).toEqual([4, 0, 2]);
    expect(log.payments).toEqual([]);
  }
});

test("three full stacks settle differences of one, two and one", () => {
  const { output, log } = verifiedSettlement(
    state([player(0), player(1), player(2), null, null]),
  );
  expect(log.payments).toEqual([
    { from: 1, to: 0, amount: 1 },
    { from: 2, to: 0, amount: 2 },
    { from: 2, to: 1, amount: 1 },
  ]);
  expect(output.players.slice(0, 3).map((p) => p?.chips)).toEqual([67, 64, 61]);
  expect(output.activePlayers).toEqual([0, 1, 2]);
});

test("pre-payment state reproduces the frozen A4 settlement", () => {
  const [a, b, c] = settledState.players;
  const { output, log } = verifiedSettlement({
    ...settledState,
    players: [{ ...a, chips: 64 }, b, { ...c, chips: 64 }, null, null],
    lastSettlement: null,
  });
  expect(log).toEqual(a4Settlement);
  expect(output).toEqual(settledState);
});

function assertMiddleElimination(chips: number) {
  const payer = player(2, chips);
  const input = {
    ...state([player(0), payer, player(4), null, null]),
    round: 3,
  };
  const { output, log } = verifiedSettlement(input);
  expect(log.payments).toEqual([
    { from: 1, to: 0, amount: chips },
    { from: 2, to: 0, amount: 4 },
  ]);
  expect(output.players[1]).toEqual({
    ...payer,
    chips: 0,
    isOut: true,
    eliminatedRound: 3,
    eliminatedEffectiveTiles: 2,
  });
  expect(output.activePlayers).toEqual([0, 2]);
}
test("short payment eliminates the receiver before its collection", () =>
  assertMiddleElimination(1));
test("exact payment eliminates the receiver before its collection", () =>
  assertMiddleElimination(2));

test("the frozen four-seat spectator transition exhausts the eight-tile hand", () => {
  const { output, log } = verifiedSettlement(
    state([player(0), player(1), player(2), player(8, 64, 3), null]),
  );
  expect(spectatorExamples.transition.view.lastSettlement?.results).toEqual(
    log.results,
  );
  expect(output.players.map((p) => p?.chips ?? null)).toEqual([
    131,
    64,
    61,
    0,
    null,
  ]);
  expect(output.activePlayers).toEqual([0, 1, 2]);
  expect(output.players[3]?.eliminatedEffectiveTiles).toBe(64);
});

function out(round: number, effective: number): PlayerState {
  return {
    ...player(0, 0),
    isOut: true,
    eliminatedRound: round,
    eliminatedEffectiveTiles: effective,
  };
}

test("previously eliminated seats are absent from the next settlement", () => {
  const spectator = out(1, 8);
  const { output, log } = verifiedSettlement({
    ...state([player(0), spectator, player(1), null, player(2)], [4, 1, 0, 2]),
    round: 2,
  });
  expect(output.players[1]).toBe(spectator);
  expect(log.details[1]).toBeNull();
  expect(log.details[3]).toBeNull();
  expect(log.results.map((r) => r.seatId)).toEqual([0, 2, 4]);
  expect(output.activePlayers).toEqual([4, 0, 2]);
});

test("fixed-seed settlements conserve chips after each transfer and preserve inputs", () => {
  let seed = 74319;
  function draw(limit: number) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * limit);
  }
  for (let i = 0; i < 240; i++) {
    const count = 3 + (i % 3);
    const maxNumber = count === 3 ? 9 : count === 4 ? 13 : 15;
    const deck = Array.from({ length: maxNumber }, (_, n) =>
      ([0, 1, 2, 3] as const).map((suit) => ({ number: n + 1, suit })),
    ).flat();
    const pool: SeatId[] = [...seats];
    const participants: SeatId[] = [];
    const players: [...Slots<PlayerState>] = [null, null, null, null, null];
    for (let j = 0; j < count; j++) {
      const id = pool.splice(draw(pool.length), 1)[0];
      if (id === undefined) throw new Error("Empty seat pool");
      participants.push(id);
      const remaining = j === 0 ? 0 : 1 + draw(12);
      const hand = Array.from({ length: remaining }, () =>
        deck.splice(draw(deck.length), 1),
      ).flat();
      players[id] = { ...player(0, 1 + draw(64)), hand };
    }
    verifiedSettlement({
      ...state(players, participants),
      maxNumber,
      phase: i % 2 ? "TURN_ACTIVE" : "ROUND_SETTLEMENT",
      roundLeader: participants[draw(count)] ?? null,
    });
  }
});

test("game over follows settlement for one, two and three survivors", () => {
  for (const [b, c, count, reason] of [
    [1, 1, 1, "FEWER_THAN_THREE"],
    [64, 1, 2, "FEWER_THAN_THREE"],
    [64, 64, 3, false],
  ] as const) {
    const paid = settle({
      ...state([player(0), player(1, b), player(2, c), null, null]),
      round: 4,
      maxRounds: 5,
    });
    expect(paid.activePlayers.length).toBe(count);
    expect(isGameOver(paid)).toBe(reason);
    expect(isGameOver({ ...paid, round: 5 })).toBe(gameOverExamples[2].reason);
  }
});
test("a round beyond the configured last round uses survivor count", () => {
  expect(isGameOver({ ...settledState, round: 6, maxRounds: 5 })).toBe(false);
});

function checkRank(input: GameState, expected: readonly RankingRow[]) {
  const snapshot = structuredClone(input);
  const rows = rank(input);
  expect(input).toEqual(snapshot);
  expect(rows).toEqual(expected);
  expect(rows.map((r) => r.seatId).sort()).toEqual([...input.seatOrder].sort());
  for (const [index, row] of rows.entries())
    expect([index + 1, rows[index - 1]?.rank]).toContain(row.rank);
}

test("survivors rank by descending chips", () => {
  checkRank(state([player(0, 60), player(0, 66), player(0, 64), null, null]), [
    { seatId: 1, rank: 1 },
    { seatId: 2, rank: 2 },
    { seatId: 0, rank: 3 },
  ]);
});
test("equal chips rank by ascending last-round effective count", () => {
  const input = state([player(0), player(0), player(0), null, null], [2, 1, 0]);
  checkRank({ ...input, lastSettlement: a4Settlement }, gameOverState.ranking);
});
test("every survivor ranks above an eliminated seat", () => {
  checkRank(state([out(4, 0), player(0, 1), player(0, 2), null, null]), [
    { seatId: 2, rank: 1 },
    { seatId: 1, rank: 2 },
    { seatId: 0, rank: 3 },
  ]);
});
test("later eliminations rank above earlier ones", () => {
  checkRank(state([out(1, 1), out(2, 9), player(0), null, null]), [
    { seatId: 2, rank: 1 },
    { seatId: 1, rank: 2 },
    { seatId: 0, rank: 3 },
  ]);
});
test("same-round eliminations rank by ascending effective count", () => {
  checkRank(state([out(2, 5), out(2, 1), player(0), null, null]), [
    { seatId: 2, rank: 1 },
    { seatId: 1, rank: 2 },
    { seatId: 0, rank: 3 },
  ]);
});
test("frozen game-over state reproduces its ranking", () =>
  checkRank(gameOverState, gameOverState.ranking));
test("complete survivor ties reproduce the frozen competition ranking", () => {
  const input = {
    ...state([player(1, 66), player(1, 66), player(0, 60), null, null]),
    round: 5,
  };
  const paid = settle(input);
  expect(paid.players.map((p) => p?.chips ?? null)).toEqual([
    65,
    65,
    62,
    null,
    null,
  ]);
  checkRank(paid, tiedRankingExample.view.ranking);
  checkRank({ ...paid, seatOrder: [1, 2, 0] }, [
    { seatId: 1, rank: 1 },
    { seatId: 0, rank: 1 },
    { seatId: 2, rank: 3 },
  ]);
});
test("complete elimination ties share a place in join order and skip the next place", () => {
  checkRank(
    state([out(2, 3), out(1, 1), out(2, 3), player(0), null], [2, 1, 0, 3]),
    [
      { seatId: 3, rank: 1 },
      { seatId: 2, rank: 2 },
      { seatId: 0, rank: 2 },
      { seatId: 1, rank: 4 },
    ],
  );
});
test("missing settlement details leave equal-chip survivors tied", () => {
  const input = state([player(0), player(0), player(0), null, null], [2, 1, 0]);
  const expected = input.seatOrder.map((seatId) => ({ seatId, rank: 1 }));
  checkRank(input, expected);
  checkRank(
    {
      ...input,
      lastSettlement: {
        ...a4Settlement,
        details: [
          a4Settlement.details[0],
          null,
          a4Settlement.details[2],
          null,
          null,
        ],
      },
    },
    expected,
  );
});
