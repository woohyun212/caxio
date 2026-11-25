import type {
  GameState,
  PlayerState,
  SeatId,
  Slots,
  Tile,
} from "../contracts/domain";
import {
  type CreateRoundRules,
  DEFAULT_MAX_ROUNDS,
  INITIAL_CHIPS,
  type Rng,
} from "../contracts/engine";

function deal(
  activePlayers: readonly SeatId[],
  rng: Rng,
  previous?: GameState,
) {
  const count = activePlayers.length;
  if (count < 3 || count > 5 || new Set(activePlayers).size !== count) {
    throw new RangeError("A deal requires 3–5 distinct seats");
  }
  const maxNumber = count === 3 ? 9 : count === 4 ? 13 : 15;
  const deck: Tile[] = [];
  for (let number = 1; number <= maxNumber; number++) {
    for (const suit of [0, 1, 2, 3] as const) deck.push({ number, suit });
  }
  for (let end = deck.length - 1; end > 0; end--) {
    const index = Math.floor(rng() * (end + 1));
    const picked = deck[index];
    const last = deck[end];
    if (!picked || !last) throw new RangeError("Shuffle index outside deck");
    deck[index] = last;
    deck[end] = picked;
  }
  const players: [...Slots<PlayerState>] = [null, null, null, null, null];
  let leader: SeatId | undefined;
  const handSize = deck.length / count;
  for (const seat of previous?.seatOrder ?? activePlayers) {
    const index = activePlayers.indexOf(seat);
    const hand =
      index < 0 ? [] : deck.slice(index * handSize, (index + 1) * handSize);
    const player = previous?.players[seat] ?? {
      chips: INITIAL_CHIPS,
      isOut: false,
      eliminatedRound: null,
      eliminatedEffectiveTiles: null,
    };
    players[seat] = { ...player, hand };
    if (hand.some((tile) => tile.number === 3 && tile.suit === 0))
      leader = seat;
  }
  if (leader === undefined) throw new Error("Deal has no cloud 3 holder");
  return {
    phase: "ROUND_START",
    players,
    maxNumber,
    roundLeader: leader,
    currentTurn: leader,
    lastPlayedBy: leader,
    consecutivePasses: 0,
    tableHand: null,
    lastPlay: null,
    lastAction: null,
    ranking: [],
  } as const;
}

function nextSeat(activePlayers: readonly SeatId[], seat: SeatId) {
  const index = activePlayers.indexOf(seat);
  const next = activePlayers[(index + 1) % activePlayers.length];
  if (index < 0 || next === undefined)
    throw new Error("Turn seat is not active");
  return next;
}

function sameTile(a: Tile, b: Tile) {
  return a.number === b.number && a.suit === b.suit;
}

export const createRoundRules: CreateRoundRules = (hands, settlement) => ({
  startRound(seats, rng, maxRounds = DEFAULT_MAX_ROUNDS) {
    const seatOrder = [...seats];
    return {
      ...deal(seatOrder, rng),
      round: 1,
      maxRounds,
      seatOrder,
      activePlayers: seatOrder,
      turnId: 0,
      lastSettlement: null,
    };
  },
  applyTurn(state, seat, action, automatic = false) {
    if (state.phase !== "TURN_ACTIVE")
      return { ok: false, state, code: "INVALID_PHASE" };
    if (seat !== state.currentTurn)
      return { ok: false, state, code: "NOT_YOUR_TURN" };
    const { turnId, tableHand, activePlayers, maxNumber } = state;
    const lastAction = { turnId, seatId: seat, type: action.type, automatic };
    if (action.type === "PASS") {
      if (!tableHand) return { ok: false, state, code: "LEAD_PASS" };
      const passes = state.consecutivePasses + 1;
      const clear = passes === activePlayers.length - 1;
      return {
        ok: true,
        state: {
          ...state,
          turnId: turnId + 1,
          lastAction,
          currentTurn: clear
            ? state.lastPlayedBy
            : nextSeat(activePlayers, seat),
          consecutivePasses: clear ? 0 : passes,
          tableHand: clear ? null : tableHand,
        },
      };
    }
    const player = state.players[seat];
    if (!player || maxNumber === null)
      throw new Error("Active turn requires a player and deck");
    const { tiles } = action;
    if (
      !tiles.every((tile) => player.hand.some((owned) => sameTile(owned, tile)))
    ) {
      return { ok: false, state, code: "NOT_OWNED" };
    }
    if (
      tiles.some(
        (tile, index) =>
          tiles.findIndex((other) => sameTile(other, tile)) !== index,
      )
    ) {
      return { ok: false, state, code: "DUPLICATE_TILE" };
    }
    const key = hands.classify(tiles, maxNumber);
    if (!key) return { ok: false, state, code: "ILLEGAL_HAND" };
    if (tableHand) {
      if (tiles.length !== tableHand.length)
        return { ok: false, state, code: "WRONG_COUNT" };
      const tableKey = hands.classify(tableHand, maxNumber);
      if (!tableKey) throw new Error("Table contains an illegal hand");
      if (!hands.compare(key, tableKey))
        return { ok: false, state, code: "NOT_HIGHER" };
    }
    const hand = player.hand.filter(
      (owned) => !tiles.some((tile) => sameTile(owned, tile)),
    );
    const players: [...Slots<PlayerState>] = [...state.players];
    players[seat] = { ...player, hand };
    const played = {
      ...state,
      players,
      lastAction,
      tableHand: tiles,
      lastPlayedBy: seat,
      consecutivePasses: 0,
      lastPlay: { turnId, seatId: seat, tiles },
    };
    if (hand.length === 0)
      return {
        ok: true,
        state: settlement.settle({
          ...played,
          phase: "ROUND_SETTLEMENT",
          currentTurn: null,
        }),
      };
    return {
      ok: true,
      state: {
        ...played,
        turnId: turnId + 1,
        currentTurn: nextSeat(activePlayers, seat),
      },
    };
  },
  timeoutAction(state) {
    const { currentTurn, maxNumber } = state;
    if (
      state.phase !== "TURN_ACTIVE" ||
      currentTurn === null ||
      maxNumber === null
    ) {
      throw new Error("Timeout requires an active turn");
    }
    if (state.tableHand) return { type: "PASS" };
    const hand = state.players[currentTurn]?.hand;
    let lowest = hand?.[0];
    if (!hand || !lowest) throw new Error("Leading seat has no tiles");
    let rank = hands.rankTile(lowest, maxNumber);
    for (const tile of hand.slice(1)) {
      const candidate = hands.rankTile(tile, maxNumber);
      if (
        candidate.numRank < rank.numRank ||
        (candidate.numRank === rank.numRank &&
          candidate.suitRank < rank.suitRank)
      ) {
        lowest = tile;
        rank = candidate;
      }
    }
    return { type: "PLAY", tiles: [lowest] };
  },
  advance(state, rng) {
    if (state.phase === "ROUND_START")
      return { ...state, phase: "TURN_ACTIVE", turnId: state.turnId + 1 };
    if (state.phase !== "ROUND_SETTLEMENT") return state;
    if (settlement.isGameOver(state))
      return {
        ...state,
        phase: "GAME_OVER",
        currentTurn: null,
        ranking: settlement.rank(state),
      };
    return {
      ...state,
      ...deal(state.activePlayers, rng, state),
      round: state.round + 1,
    };
  },
});
