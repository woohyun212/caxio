import { expect } from "bun:test";
import type {
  Action,
  GameState,
  MaxNumber,
  PlayerState,
  SeatId,
  Slots,
  Suit,
  Tile,
  TurnError,
} from "@caxio/shared/contracts/domain";
import type { RulesApi } from "@caxio/shared/contracts/engine";
import {
  a4Settlement,
  firstDealState,
  gameOverState,
  seatReuse,
  settledState,
  spectatorExamples,
} from "@caxio/shared/contracts/fixtures";

export function at<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing test fixture");
  return value;
}
function slots<T>(get: (id: SeatId) => T | null): Slots<T> {
  return [get(0), get(1), get(2), get(3), get(4)];
}
export const tile = (number: number, suit: Suit = 0): Tile => ({
  number,
  suit,
});
const key = (t: Tile) => 4 * t.number + t.suit;
const strength = (t: Tile, n: MaxNumber) =>
  4 * ((t.number + n - 3) % n) + t.suit;
const deck13 = Array.from({ length: 13 }, (_, i) => [
  tile(i + 1),
  tile(i + 1, 1),
  tile(i + 1, 2),
  tile(i + 1, 3),
]).flat();
const deck15 = [
  ...deck13,
  ...[14, 15].flatMap((n) => [tile(n), tile(n, 1), tile(n, 2), tile(n, 3)]),
];
const anchors = [
  [tile(1), tile(9), tile(3)],
  [tile(7)],
  [tile(4), tile(8, 2)],
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
];
const remaining = deck13.filter(
  (t) => !anchors.flat().some((p) => key(p) === key(t)),
);
const fourHands = anchors.map((hand) => [
  ...hand,
  ...remaining.splice(0, 13 - hand.length),
]);
const unused = (): never => {
  throw new Error("Room called an unrelated rules API");
};

// A fixed-deal single-tile script drives real turns to the W1 settlement examples.
// Only the pair/error examples and these singles are supported by the double.
export function rulesFixture(maxRounds: number, rng: () => number) {
  const calls = {
    deals: 0,
    manual: 0,
    automatic: 0,
    attempts: 0,
    state: null as GameState | null,
  };
  const record = (state: GameState) => {
    calls.state = state;
    return state;
  };
  const rules: RulesApi = {
    rankTile: unused,
    classify: unused,
    compare: unused,
    settle: unused,
    rank: unused,
    isGameOver: unused,
    startRound(order, dealRng) {
      expect(dealRng).toBe(rng);
      calls.deals++;
      const leader = at(order[0]);
      const players = slots((id) => {
        if (!order.includes(id)) return null;
        const hand =
          order.length === 5
            ? deck15.slice(id * 12, id * 12 + 12)
            : order.length === 4
              ? at(fourHands[id])
              : leader === 2
                ? at(seatReuse.hands[id])
                : at(firstDealState.players[id]).hand;
        return { ...firstDealState.players[0], hand };
      });
      return record({
        ...firstDealState,
        players,
        seatOrder: order,
        activePlayers: order,
        currentTurn: leader,
        roundLeader: leader,
        lastPlayedBy: leader,
        maxRounds,
        maxNumber: order.length === 5 ? 15 : order.length === 4 ? 13 : 9,
      });
    },
    advance(state, dealRng) {
      expect(dealRng).toBe(rng);
      if (state.phase === "ROUND_START")
        return record({
          ...state,
          phase: "TURN_ACTIVE",
          turnId: state.turnId + 1,
        });
      expect(state.phase).toBe("ROUND_SETTLEMENT");
      if (state.round === state.maxRounds) {
        const ranking =
          state.seatOrder.length === 4
            ? spectatorExamples.gameOver.view.ranking
            : gameOverState.ranking;
        return record({ ...state, phase: "GAME_OVER", ranking });
      }
      return record({
        ...state,
        phase: "ROUND_START",
        round: state.round + 1,
        maxNumber: 9,
        currentTurn: 0,
        roundLeader: 0,
        lastPlayedBy: 0,
        consecutivePasses: 0,
        lastPlay: null,
        tableHand: null,
        lastAction: null,
        players: slots((id) => {
          const p = state.players[id];
          return (
            p && {
              ...p,
              hand: p.isOut ? [] : at(firstDealState.players[id]).hand,
            }
          );
        }),
      });
    },
    timeoutAction(state): Action {
      if (state.tableHand) return { type: "PASS" };
      const hand = at(state.players[at(state.currentTurn)]).hand;
      const n = at(state.maxNumber);
      return {
        type: "PLAY",
        tiles: [
          at([...hand].sort((a, b) => strength(a, n) - strength(b, n))[0]),
        ],
      };
    },
    applyTurn(state, seat, action, automatic = false) {
      calls.attempts++;
      const fail = (code: TurnError) => ({ ok: false, state, code }) as const;
      if (state.currentTurn !== seat) return fail("NOT_YOUR_TURN");
      const player = at(state.players[seat]);
      const nextSeat = at(
        state.activePlayers[
          (state.activePlayers.indexOf(seat) + 1) % state.activePlayers.length
        ],
      );
      let next: GameState = {
        ...state,
        currentTurn: nextSeat,
        turnId: state.turnId + 1,
        lastAction: {
          turnId: state.turnId,
          type: action.type,
          automatic,
          seatId: seat,
        },
      };
      if (action.type === "PASS") {
        if (!state.tableHand) return fail("LEAD_PASS");
        const passes = state.consecutivePasses + 1;
        next =
          passes === state.activePlayers.length - 1
            ? {
                ...next,
                consecutivePasses: 0,
                tableHand: null,
                currentTurn: state.lastPlayedBy,
              }
            : { ...next, consecutivePasses: passes };
      } else {
        const played = action.tiles;
        if (played.some((t) => !player.hand.some((h) => key(h) === key(t))))
          return fail("NOT_OWNED");
        if (new Set(played.map(key)).size !== played.length)
          return fail("DUPLICATE_TILE");
        if (
          !played.length ||
          played.some((t) => t.number !== played[0]?.number)
        )
          return fail("ILLEGAL_HAND");
        if (state.tableHand && state.tableHand.length !== played.length)
          return fail("WRONG_COUNT");
        if (
          state.tableHand &&
          strength(at(played[0]), at(state.maxNumber)) <=
            strength(at(state.tableHand[0]), at(state.maxNumber))
        )
          return fail("NOT_HIGHER");
        const hand = player.hand.filter(
          (h) => !played.some((t) => key(t) === key(h)),
        );
        next = {
          ...next,
          players: slots((id) =>
            id === seat ? { ...player, hand } : state.players[id],
          ),
          lastPlay: { seatId: seat, turnId: state.turnId, tiles: played },
          tableHand: played,
          lastPlayedBy: seat,
          consecutivePasses: 0,
        };
        if (!hand.length) {
          const eliminate = state.activePlayers.length === 4;
          const results = eliminate
            ? at(spectatorExamples.transition.view.lastSettlement).results
            : a4Settlement.results;
          const players = slots<PlayerState>((id) => {
            const p = next.players[id];
            if (!p) return null;
            const change =
              results.find((row) => row.seatId === id)?.chipChange ?? 0;
            if (eliminate && id === 3)
              return {
                ...p,
                chips: 0,
                isOut: true,
                eliminatedRound: 1,
                eliminatedEffectiveTiles: 64,
              };
            return { ...p, chips: p.chips + change };
          });
          const details = slots((id) => {
            if (eliminate && id === 3)
              return { round: 1, remaining: 8, twos: 3, effective: 64 };
            const d = settledState.lastSettlement.details[id];
            return d && { ...d, round: state.round };
          });
          next = {
            ...next,
            phase: "ROUND_SETTLEMENT",
            turnId: state.turnId,
            currentTurn: null,
            players,
            activePlayers: state.activePlayers.filter(
              (id) => !players[id]?.isOut,
            ),
            lastSettlement: {
              round: state.round,
              results,
              details,
              payments: eliminate
                ? [...a4Settlement.payments, { from: 3, to: 0, amount: 64 }]
                : a4Settlement.payments,
            },
          };
        }
      }
      if (automatic) calls.automatic++;
      else calls.manual++;
      return { ok: true, state: record(next) };
    },
  };
  return { rules, calls };
}
