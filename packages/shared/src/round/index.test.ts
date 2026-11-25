import { expect, mock, test } from "bun:test";
import type {
  Action,
  GameOverReason,
  GameState,
  MaxNumber,
  Phase,
  SeatId,
  Suit,
  Tile,
  TurnError,
} from "../contracts/domain";
import type { HandRules, SettlementRules } from "../contracts/engine";
import {
  a4Settlement,
  firstDealState,
  settledState,
} from "../contracts/fixtures";
import { createRoundRules } from "./index";

const tile = (number: number, suit: Suit = 0): Tile => ({ number, suit });
const play = (...tiles: Tile[]): Action => ({ type: "PLAY", tiles });
const pass = { type: "PASS" } as const;
const identityShuffle = () => 0.999;
const noShuffle = () => {
  throw new Error("Unexpected shuffle");
};
const hands: HandRules = {
  rankTile: (tile, max) => ({
    numRank: (tile.number + max - 3) % max,
    suitRank: tile.suit,
  }),
  classify(tiles) {
    const first = tiles[0];
    if (!first) return null;
    const key = [first.number];
    if (tiles.length === 1)
      return { kind: "SINGLE", count: 1, representative: first, key };
    if (tiles.length === 5 && tiles.every((t) => t.suit === first.suit))
      return { kind: "FLUSH", count: 5, representative: first, key };
    if (tiles.some((t) => t.number !== first.number)) return null;
    if (tiles.length === 2)
      return { kind: "PAIR", count: 2, representative: first, key };
    if (tiles.length === 3)
      return { kind: "TRIPLE", count: 3, representative: first.number, key };
    return null;
  },
  compare: (a, b) => (a.key[0] ?? 0) > (b.key[0] ?? 0),
};
const settlement: SettlementRules = {
  settle: (state) => ({ ...state, lastSettlement: a4Settlement }),
  rank: () => [],
  isGameOver: () => false,
};
const rules = createRoundRules(hands, settlement);

function accept(
  state: GameState,
  action: Action,
  automatic = false,
  engine = rules,
) {
  if (state.currentTurn === null) throw new Error("No turn");
  const before = structuredClone(state);
  const result = engine.applyTurn(state, state.currentTurn, action, automatic);
  expect(state).toEqual(before);
  if (!result.ok) throw new Error(result.code);
  return result.state;
}

const sizes: readonly [readonly SeatId[], MaxNumber, number][] = [
  [[4, 0, 2], 9, 12],
  [[3, 0, 4, 1], 13, 13],
  [[2, 0, 4, 3, 1], 15, 12],
];
function checkDeck(state: GameState, max: MaxNumber, size: number) {
  expect(state.maxNumber).toBe(max);
  const tiles = state.activePlayers.flatMap((seat) => {
    const hand = state.players[seat]?.hand;
    expect(hand).toHaveLength(size);
    return hand ?? [];
  });
  const ids = tiles.map((t) => t.number * 4 + t.suit).sort((a, b) => a - b);
  expect(ids).toEqual(Array.from({ length: max * 4 }, (_, i) => i + 4));
  const leader = state.activePlayers.find((seat) =>
    state.players[seat]?.hand.some((t) => t.number === 3 && t.suit === 0),
  );
  if (leader === undefined) throw new Error("No seat holds cloud 3");
  expect([state.roundLeader, state.currentTurn, state.lastPlayedBy]).toEqual([
    leader,
    leader,
    leader,
  ]);
}
for (const [order, max, size] of sizes) {
  test(`A1: ${order.length} seats receive the full deck in their fixed slots`, () => {
    const state = rules.startRound(order, identityShuffle, 7);
    checkDeck(state, max, size);
    expect(state.seatOrder).toEqual(order);
    expect(state.activePlayers).toEqual(order);
    expect(state.maxRounds).toBe(7);
    for (const seat of [0, 1, 2, 3, 4] as const) {
      const player = state.players[seat];
      if (!order.includes(seat)) expect(player).toBeNull();
      else
        expect(player).toMatchObject({
          chips: 64,
          isOut: false,
          eliminatedRound: null,
          eliminatedEffectiveTiles: null,
        });
    }
  });
}
test("A1: first deal matches the frozen state, including default rounds", () => {
  let end = 36;
  expect(
    rules.startRound([0, 1, 2], () =>
      --end === 32 ? 1.5 / 33 : identityShuffle(),
    ),
  ).toEqual(firstDealState);
});
test("Same RNG sequence reproduces the deal and changing it changes hands", () => {
  function sequence(seed: number) {
    return () => {
      seed = (seed * 17 + 3) % 97;
      return seed / 97;
    };
  }
  const deal = (seed: number) => rules.startRound([3, 1, 2, 4], sequence(seed));
  expect(deal(1)).toEqual(deal(1));
  expect(deal(2).players).not.toEqual(deal(1).players);
});

const lead = rules.advance(firstDealState, noShuffle);
const leadHand = [
  tile(1),
  tile(1, 1),
  tile(1, 2),
  tile(4),
  tile(5),
  tile(6),
  tile(7),
  tile(3),
];
const customLead: GameState = {
  ...lead,
  players: [
    { ...firstDealState.players[0], hand: leadHand },
    firstDealState.players[1],
    firstDealState.players[2],
    null,
    null,
  ],
};
for (const tiles of [
  [tile(1)],
  leadHand.slice(0, 2),
  leadHand.slice(0, 3),
  [tile(1), tile(4), tile(5), tile(6), tile(7)],
]) {
  test(`A1/A3: leader may open with ${tiles.length} legal tiles without cloud 3`, () => {
    const next = accept(customLead, play(...tiles));
    expect(next.players[0]?.hand).toEqual(
      leadHand.filter(
        (t) => !tiles.some((p) => t.number === p.number && t.suit === p.suit),
      ),
    );
    expect(next).toMatchObject({
      currentTurn: 1,
      lastPlayedBy: 0,
      consecutivePasses: 0,
      turnId: 2,
      tableHand: tiles,
      lastPlay: { turnId: 1, seatId: 0, tiles },
      lastAction: { turnId: 1, type: "PLAY", seatId: 0, automatic: false },
    });
  });
}

function reject(
  state: GameState,
  seat: SeatId,
  action: Action,
  code: TurnError,
) {
  const before = structuredClone(state);
  const result = rules.applyTurn(state, seat, action);
  expect(result).toEqual({ ok: false, state, code });
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}
test("A3: validation precedence and all eight errors preserve the identical state", () => {
  const missing = play(tile(9, 3), tile(9, 3));
  for (const phase of [
    "LOBBY",
    "ROUND_START",
    "ROUND_SETTLEMENT",
    "GAME_OVER",
  ] as const) {
    reject({ ...lead, phase }, 1, missing, "INVALID_PHASE");
  }
  reject(lead, 1, missing, "NOT_YOUR_TURN");
  reject(lead, 0, missing, "NOT_OWNED");
  reject(lead, 0, play(tile(3), tile(3), tile(2)), "DUPLICATE_TILE");
  reject(lead, 0, pass, "LEAD_PASS");
  const following = accept(lead, play(tile(9)));
  reject(following, 1, play(tile(4), tile(5)), "ILLEGAL_HAND");
  reject(following, 1, play(tile(4), tile(4, 1)), "WRONG_COUNT");
  reject(following, 1, play(tile(4)), "NOT_HIGHER");
});
test("A3: a passer can beat a later play in the same trick", () => {
  const state: GameState = {
    ...lead,
    players: [
      { ...firstDealState.players[0], hand: [tile(3), tile(1)] },
      { ...firstDealState.players[1], hand: [tile(8), tile(4)] },
      { ...firstDealState.players[2], hand: [tile(7), tile(2)] },
      null,
      null,
    ],
  };
  const compare = mock(hands.compare);
  const engine = createRoundRules({ ...hands, compare }, settlement);
  const played = accept(state, play(tile(3)), false, engine);
  const passed = accept(played, pass, false, engine);
  const higher = accept(passed, play(tile(7)), false, engine);
  expect(higher.consecutivePasses).toBe(0);
  const again = accept(higher, pass, false, engine);
  const next = accept(again, play(tile(8)), false, engine);
  expect(compare.mock.calls.map((pair) => pair.map((key) => key.key))).toEqual([
    [[7], [3]],
    [[8], [7]],
  ]);
  expect(next.lastPlay).toEqual({ turnId: 5, seatId: 1, tiles: [tile(8)] });
  expect(next.tableHand).toEqual([tile(8)]);
  expect(next.consecutivePasses).toBe(0);
  const cleared = accept(
    accept(next, pass, false, engine),
    pass,
    false,
    engine,
  );
  expect(cleared).toMatchObject({
    currentTurn: 1,
    lastPlayedBy: 1,
    tableHand: null,
    lastPlay: next.lastPlay,
  });
});
for (const [order] of sizes) {
  test(`A3: ${order.length} active seats clear only on pass M−1 and retain lastPlay`, () => {
    let state = rules.advance(
      rules.startRound(order, identityShuffle),
      noShuffle,
    );
    // Extra room seats must not affect turn rotation or the clear threshold.
    const out = {
      hand: [],
      isOut: true,
      chips: 0,
      eliminatedRound: 1,
      eliminatedEffectiveTiles: 10,
    };
    const players: [...GameState["players"]] = [...state.players];
    const omitted = ([0, 1, 2, 3, 4] as const).filter(
      (seat) => !order.includes(seat),
    );
    for (const seat of omitted) players[seat] = out;
    state = { ...state, round: 2, players, seatOrder: [...omitted, ...order] };
    const leader = state.currentTurn;
    if (leader === null) throw new Error("Missing leader");
    const played = accept(state, play(tile(3)));
    state = played;
    for (let i = 1; i < order.length; i++) {
      const seatId = order[(order.indexOf(leader) + i) % order.length];
      if (seatId === undefined) throw new Error("Missing active seat");
      expect(state.currentTurn).toBe(seatId);
      expect(state.consecutivePasses).toBe(i - 1);
      expect(state.tableHand).toEqual([tile(3)]);
      state = accept(state, pass);
      expect(state.lastAction).toEqual({
        turnId: i + 1,
        seatId,
        type: "PASS",
        automatic: false,
      });
      expect(state.lastPlay).toEqual(played.lastPlay);
      expect(state.turnId).toBe(i + 2);
    }
    expect(state).toMatchObject({
      phase: "TURN_ACTIVE",
      currentTurn: leader,
      lastPlayedBy: leader,
      tableHand: null,
      consecutivePasses: 0,
    });
  });
}

test("A3: timeout plays the lowest ranked single or passes automatically", () => {
  const state: GameState = {
    ...lead,
    players: [
      {
        ...firstDealState.players[0],
        hand: [tile(1), tile(3, 3), tile(2), tile(3, 1)],
      },
      firstDealState.players[1],
      firstDealState.players[2],
      null,
      null,
    ],
  };
  const before = structuredClone(state);
  const automatic = rules.timeoutAction(state);
  expect(automatic).toEqual(play(tile(3, 1)));
  expect(state).toEqual(before);
  const next = accept(state, automatic, true);
  expect(next.lastAction).toEqual({
    turnId: 1,
    type: "PLAY",
    seatId: 0,
    automatic: true,
  });
  const follow = rules.timeoutAction(next);
  expect(follow).toEqual(pass);
  expect(accept(next, follow, true).lastAction).toEqual({
    turnId: 2,
    type: "PASS",
    seatId: 1,
    automatic: true,
  });
});

test("A3/A5: turn IDs span a full round, one settlement and the next lead", () => {
  const settle = mock(settlement.settle);
  const engine = createRoundRules(hands, { ...settlement, settle });
  const start = engine.startRound([0, 1, 2], identityShuffle);
  let state = engine.advance(start, noShuffle);
  expect(state).toEqual({ ...start, phase: "TURN_ACTIVE", turnId: 1 });
  let turnId = 1;
  for (const tile of start.players[0]?.hand ?? []) {
    expect(state.turnId).toBe(turnId);
    state = accept(state, play(tile), false, engine);
    if (state.phase === "ROUND_SETTLEMENT") break;
    state = accept(accept(state, pass, false, engine), pass, false, engine);
    turnId += 3;
  }
  expect(turnId).toBe(34);
  expect(settle).toHaveBeenCalledTimes(1);
  const winning = settle.mock.calls[0]?.[0];
  expect(winning).toMatchObject({
    phase: "ROUND_SETTLEMENT",
    currentTurn: null,
    turnId,
    lastPlayedBy: 0,
    tableHand: [tile(3, 3)],
    lastPlay: { turnId, seatId: 0, tiles: [tile(3, 3)] },
    lastAction: { turnId, seatId: 0, type: "PLAY", automatic: false },
    lastSettlement: null,
  });
  expect(winning?.players[0]?.hand).toEqual([]);
  expect(settle.mock.results[0]?.value).toBe(state);
  reject(state, 0, pass, "INVALID_PHASE");
  const next = engine.advance(state, () => 0);
  expect(next).toMatchObject({
    round: 2,
    turnId,
    tableHand: null,
    lastPlay: null,
    lastAction: null,
    lastSettlement: a4Settlement,
  });
  expect(engine.advance(next, noShuffle)).toEqual({
    ...next,
    phase: "TURN_ACTIVE",
    turnId: 35,
  });
});

const terminalCases: readonly [number, readonly SeatId[], GameOverReason][] = [
  [4, [0], "FEWER_THAN_THREE"],
  [4, [0, 1], "FEWER_THAN_THREE"],
  [5, [0, 1, 2], "LAST_ROUND"],
  [2, [0, 1, 2], "LAST_ROUND"], // Deliberately contrary verdict proves the port decides.
];
for (const [round, activePlayers, reason] of terminalCases) {
  test(`A5: round ${round} with ${activePlayers.length} survivors follows the terminal verdict with zero deals`, () => {
    const state: GameState = { ...settledState, round, activePlayers };
    const before = structuredClone(state);
    const ranking = [
      { seatId: 2, rank: 1 },
      { seatId: 0, rank: 2 },
      { seatId: 1, rank: 2 },
    ] as const;
    const isGameOver = mock<SettlementRules["isGameOver"]>(() => reason);
    const rank = mock<SettlementRules["rank"]>(() => ranking);
    const next = createRoundRules(hands, {
      ...settlement,
      isGameOver,
      rank,
    }).advance(state, noShuffle);
    expect(isGameOver.mock.calls).toEqual([[state]]);
    expect(rank.mock.calls).toEqual([[state]]);
    expect(next).toEqual({ ...state, phase: "GAME_OVER", ranking });
    expect(state).toEqual(before);
  });
}
test("A5: before the last round three survivors receive exactly one 36-tile deal", () => {
  const out = {
    ...settledState.players[1],
    isOut: true,
    chips: 0,
    eliminatedRound: 1,
    eliminatedEffectiveTiles: 8,
  };
  const state: GameState = {
    ...settledState,
    maxNumber: 13,
    seatOrder: [3, 1, 0, 2],
    activePlayers: [3, 0, 2],
    players: [
      settledState.players[0],
      out,
      settledState.players[2],
      settledState.players[1],
      null,
    ],
    consecutivePasses: 1,
    ranking: [{ seatId: 0, rank: 1 }],
  };
  const before = structuredClone(state);
  const rng = mock(identityShuffle);
  const isGameOver = mock(settlement.isGameOver);
  const rank = mock(settlement.rank);
  const next = createRoundRules(hands, {
    ...settlement,
    isGameOver,
    rank,
  }).advance(state, rng);
  expect(rng).toHaveBeenCalledTimes(35);
  expect(isGameOver.mock.calls).toEqual([[state]]);
  expect(rank).not.toHaveBeenCalled();
  checkDeck(next, 9, 12);
  expect(next.players[1]).toEqual({ ...out, hand: [] });
  for (const seat of state.seatOrder) {
    const player = state.players[seat];
    const dealt = next.players[seat];
    if (!player || !dealt) throw new Error("Missing seated player");
    expect(dealt).toEqual({ ...player, hand: dealt.hand });
  }
  expect(next.players[4]).toBeNull();
  expect(next).toMatchObject({
    phase: "ROUND_START",
    round: 2,
    turnId: state.turnId,
    seatOrder: state.seatOrder,
    activePlayers: state.activePlayers,
    roundLeader: 3,
    tableHand: null,
    lastPlay: null,
    lastAction: null,
    consecutivePasses: 0,
    ranking: [],
    lastSettlement: a4Settlement,
  });
  expect(state).toEqual(before);
});
test("Invalid seat lists fail before shuffling", () => {
  const lists: readonly (readonly SeatId[])[] = [
    [],
    [0, 1],
    [0, 0, 1],
    [0, 1, 2, 3, 4, 0],
  ];
  for (const order of lists)
    expect(() => rules.startRound(order, noShuffle)).toThrow(RangeError);
});
test("Advance is idle outside start and settlement, and timeout requires an active turn", () => {
  const phases: readonly Phase[] = [
    "LOBBY",
    "ROUND_START",
    "TURN_ACTIVE",
    "ROUND_SETTLEMENT",
    "GAME_OVER",
  ];
  for (const phase of phases) {
    const state = { ...firstDealState, phase };
    if (phase !== "ROUND_START" && phase !== "ROUND_SETTLEMENT")
      expect(rules.advance(state, noShuffle)).toBe(state);
    if (phase !== "TURN_ACTIVE")
      expect(() => rules.timeoutAction(state)).toThrow();
  }
});
