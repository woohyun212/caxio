import { expect, test } from "bun:test";
import type {
  Action,
  GameOverReason,
  GameState,
  HandKey,
  HandKind,
  MaxNumber,
  PreviewResult,
  RankingRow,
  SeatId,
  Settlement,
  Tile,
  TileRank,
  TransitionResult,
  TurnError,
} from "./domain";
import type {
  CreateRoundRules,
  HandRules,
  Rng,
  RulesApi,
  SettlementRules,
} from "./engine";
import { DEFAULT_MAX_ROUNDS, INITIAL_CHIPS } from "./engine";
import {
  a4Settlement,
  firstDealState,
  gameOverState,
  phaseExamples,
  settledState,
} from "./fixtures";
import type { Exact } from "./type-check";

// Check the entry points in both directions so a formerly required parameter cannot silently disappear.
type Signatures = {
  rankTile: [[tile: Tile, maxNumber: MaxNumber], TileRank];
  classify: [[tiles: readonly Tile[], maxNumber: MaxNumber], HandKey | null];
  compare: [[challenger: HandKey, table: HandKey], boolean];
  startRound: [
    [seatOrder: readonly SeatId[], rng: Rng, maxRounds?: number],
    GameState,
  ];
  applyTurn: [
    [state: GameState, seat: SeatId, action: Action, automatic?: boolean],
    TransitionResult,
  ];
  timeoutAction: [[state: GameState], Action];
  advance: [[state: GameState, rng: Rng], GameState];
  settle: [[state: GameState], GameState];
  rank: [[state: GameState, leaverSeatId?: SeatId], readonly RankingRow[]];
  isGameOver: [[state: GameState], false | GameOverReason];
};
type Api = {
  [K in keyof RulesApi]: [Parameters<RulesApi[K]>, ReturnType<RulesApi[K]>];
};
type Same<A, B> = [A, B] extends [B, A] ? true : false;
const signatures: Same<Api, Signatures> = true;
const injection: Same<
  Parameters<CreateRoundRules>,
  [HandRules, SettlementRules]
> = true;
const assembly: Same<
  ReturnType<CreateRoundRules> & HandRules & SettlementRules,
  RulesApi
> = true;
test("engine ports compose and expose ordered payment and elimination inputs", () => {
  expect([signatures, injection, assembly]).toEqual([true, true, true]);
  const settlement: Settlement = a4Settlement;
  const balance = [64, 64, 64];
  for (const payment of settlement.payments) {
    const payer = balance[payment.from],
      receiver = balance[payment.to];
    if (payer === undefined || receiver === undefined)
      throw Error("unknown payment seat");
    balance[payment.from] = payer - payment.amount;
    balance[payment.to] = receiver + payment.amount;
    expect(balance.reduce((a, b) => a + b, 0)).toBe(192);
  }
  expect(balance).toEqual([67, 64, 61]);
  for (const detail of settlement.details)
    if (detail)
      expect(detail.effective).toBe(detail.remaining * 2 ** detail.twos);
});

type ExpectedTransition =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; code: TurnError };
type ExpectedPreview =
  | { ok: true; kind: HandKind; representative: Tile | number }
  | {
      ok: false;
      reason: "EMPTY" | "COUNT" | "ILLEGAL_HAND" | "WRONG_COUNT" | "NOT_HIGHER";
    };
test("transition and preview preserve both discriminated branches", () => {
  const transition: Exact<TransitionResult, ExpectedTransition> = true;
  const preview: Exact<PreviewResult, ExpectedPreview> = true;
  expect([transition, preview]).toEqual([true, true]);
});
test("first deal projects round one and opens turn one on advance", () => {
  const state: GameState = firstDealState,
    view = phaseExamples[1].view;
  expect([
    state.phase,
    state.round,
    state.maxRounds,
    state.maxNumber,
    state.currentTurn,
  ]).toEqual([
    view.phase,
    view.round,
    view.maxRounds,
    view.maxNumber,
    view.currentTurn,
  ]);
  expect(state.seatOrder).toEqual(view.seatOrder);
  expect(state.activePlayers).toEqual(view.activePlayers);
  expect([
    state.maxRounds,
    DEFAULT_MAX_ROUNDS,
    state.maxNumber,
    INITIAL_CHIPS,
  ]).toEqual([5, 5, 9, 64]);
  const tiles = state.players.flatMap((p) => p?.hand ?? []);
  expect(tiles).toHaveLength(36);
  expect(new Set(tiles.map((t) => t.number * 4 + t.suit)).size).toBe(36);
  expect(
    state.players.map((p) => (p ? [p.hand.length, p.chips] : null)),
  ).toEqual(
    view.slots.map((p) => (p ? [p.remainingTileCount, p.chips] : null)),
  );
  expect(state.players.map((p) => p?.chips ?? null)).toEqual([
    64,
    64,
    64,
    null,
    null,
  ]);
  expect(state.players[0]?.hand).toEqual(view.ownHand);
  const lead = state.players.findIndex((p) =>
    p?.hand.some((t) => t.number === 3 && t.suit === 0),
  );
  expect(lead).toBe(state.currentTurn ?? -1);
  expect(state.roundLeader).toBe(state.currentTurn);
  expect(state.lastPlayedBy).toBe(state.roundLeader);
  expect([state.turnId, view.turnId, phaseExamples[2].view.turnId]).toEqual([
    0,
    null,
    1,
  ]);
});

test("paid and finished engine states project to the complete seat-zero views", () => {
  for (const [state, snapshot] of [
    [settledState, phaseExamples[3]],
    [gameOverState, phaseExamples[4]],
  ] as const) {
    const { players, lastSettlement } = state;
    expect(state.turnId).toBe(state.lastPlay.turnId);
    for (const seat of state.seatOrder) {
      const hand = players[seat].hand;
      expect(hand.length).toBe(lastSettlement.details[seat].remaining);
      expect(hand.filter((t) => t.number === 2).length).toBe(
        lastSettlement.details[seat].twos,
      );
      for (const t of hand)
        expect(firstDealState.players[seat].hand).toContainEqual(t);
    }
    const projected = {
      phase: state.phase,
      round: state.round,
      maxRounds: state.maxRounds,
      maxNumber: state.maxNumber,
      seatOrder: state.seatOrder,
      activePlayers: state.activePlayers,
      currentTurn: state.currentTurn,
      slots: players.map(
        (p) =>
          p && {
            remainingTileCount: p.hand.length,
            chips: p.chips,
            isOut: p.isOut,
            isConnected: true,
          },
      ),
      turnId: null,
      deadline: null,
      tableHand: state.tableHand,
      lastPlay: state.lastPlay,
      lastAction: state.lastAction,
      consecutivePasses: state.consecutivePasses,
      ranking: state.ranking,
      lastSettlement: {
        round: lastSettlement.round,
        results: lastSettlement.results.map(({ seatId, rank, chipChange }) => ({
          seatId,
          rank,
          chipChange,
        })),
      },
      ownHand: players[0].hand,
      ownSettlement: lastSettlement.details[0],
    };
    expect<object>(projected).toEqual(snapshot.view);
  }
});
