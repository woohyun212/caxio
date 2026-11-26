import type {
  GameState,
  OwnSettlement,
  Payment,
  PlayerState,
  SeatId,
  Slots,
} from "../contracts/domain";
import type { IsGameOver, Rank, Settle } from "../contracts/engine";

function playerAt(state: GameState, seatId: SeatId): PlayerState {
  const player = state.players[seatId];
  if (!player) throw new Error(`No player in occupied seat ${seatId}`);
  return player;
}

export const settle: Settle = (state) => {
  const { activePlayers, round, roundLeader } = state;
  const first =
    roundLeader === null ? 0 : Math.max(0, activePlayers.indexOf(roundLeader));
  const turnOrder = [
    ...activePlayers.slice(first),
    ...activePlayers.slice(0, first),
  ];
  const details: [...Slots<OwnSettlement>] = [null, null, null, null, null];
  const ordered = turnOrder
    .map((seatId) => {
      const player = playerAt(state, seatId);
      const remaining = player.hand.length;
      const twos = player.hand.filter((tile) => tile.number === 2).length;
      const effective = remaining * 2 ** twos;
      details[seatId] = { round, remaining, twos, effective };
      return { seatId, player, remaining, effective, chips: player.chips };
    })
    .sort((a, b) => a.effective - b.effective || a.remaining - b.remaining);

  const payments: Payment[] = [];
  for (const [index, receiver] of ordered.entries()) {
    if (receiver.chips === 0) continue;
    for (const payer of ordered.slice(index + 1)) {
      const amount = Math.min(
        payer.chips,
        payer.effective - receiver.effective,
      );
      if (amount === 0) continue;
      payer.chips -= amount;
      receiver.chips += amount;
      payments.push({ from: payer.seatId, to: receiver.seatId, amount });
    }
  }

  const players: [...Slots<PlayerState>] = [...state.players];
  const results = ordered.map(({ seatId, player, effective, chips }, index) => {
    players[seatId] =
      chips === 0
        ? {
            ...player,
            chips,
            isOut: true,
            eliminatedRound: round,
            eliminatedEffectiveTiles: effective,
          }
        : { ...player, chips };
    return { seatId, rank: index + 1, chipChange: chips - player.chips };
  });
  return {
    ...state,
    players,
    activePlayers: activePlayers.filter((seat) => !players[seat]?.isOut),
    lastSettlement: { round, results, details, payments },
  };
};

export const rank: Rank = (state, leaverSeatId) => {
  if (leaverSeatId !== undefined) {
    const others = state.seatOrder
      .filter((id) => id !== leaverSeatId)
      .map((seatId) => ({ seatId, chips: playerAt(state, seatId).chips }))
      .sort((a, b) => b.chips - a.chips);
    let place = 0;
    return [
      ...others.map(({ seatId, chips }, i) => {
        if (others[i - 1]?.chips !== chips) place = i + 1;
        return { seatId, rank: place };
      }),
      { seatId: leaverSeatId, rank: state.seatOrder.length },
    ];
  }

  const rows = state.seatOrder.map((seatId) => {
    const player = playerAt(state, seatId);
    const { isOut } = player;
    const primary = isOut ? (player.eliminatedRound ?? 0) : player.chips;
    const effective = isOut
      ? player.eliminatedEffectiveTiles
      : state.lastSettlement?.details[seatId]?.effective;
    return { seatId, isOut, primary, effective };
  });
  // Without every detail in a chip tie, shares of that place must remain transitive.
  const missingDetails = new Set(
    rows
      .filter((row) => !row.isOut && row.effective == null)
      .map((row) => row.primary),
  );
  function compare(a: (typeof rows)[number], b: (typeof rows)[number]) {
    return (
      Number(a.isOut) - Number(b.isOut) ||
      b.primary - a.primary ||
      (!a.isOut && missingDetails.has(a.primary)
        ? 0
        : (a.effective ?? 0) - (b.effective ?? 0))
    );
  }
  rows.sort(compare);
  let place = 0;
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    if (!previous || compare(previous, row) !== 0) place = index + 1;
    return { seatId: row.seatId, rank: place };
  });
};

export const isGameOver: IsGameOver = (state) => {
  if (state.round === state.maxRounds) return "LAST_ROUND";
  return state.activePlayers.length < 3 ? "FEWER_THAN_THREE" : false;
};
