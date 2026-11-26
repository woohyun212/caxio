import type {
  GameState,
  SeatId,
  Slots,
  Tile,
} from "@caxio/shared/contracts/domain";
import {
  DEFAULT_MAX_ROUNDS,
  INITIAL_CHIPS,
} from "@caxio/shared/contracts/engine";
import type {
  LastGameResult,
  PlayerView,
  PublicSeat,
  PublicTable,
} from "@caxio/shared/contracts/wire";
import type { RoomConnection } from "../contracts";

export interface Occupant {
  id: SeatId;
  token: string;
  disconnectedTurns: number;
  connection: RoomConnection | null;
  name?: string;
  // Explicit leave revoked the credential; the seat is vacated when the room next holds a lobby.
  left?: true;
  cancelReservation?: () => void;
}

export interface Room {
  code: string;
  // Monotonic join numbers keep slot reuse independent of host and dealing order.
  occupants: Map<number, Occupant>;
  nextJoin: number;
  revision: number;
  game: GameState | null;
  lastTurnId: number;
  lastGameResult?: LastGameResult;
  deadline: number | null;
  cancelTurn?: () => void;
  cancelDisposal?: () => void;
}

export function ready(room: Room) {
  return (
    room.occupants.size >= 3 &&
    [...room.occupants.values()].every((s) => s.connection !== null)
  );
}

function tiles(hand: readonly Tile[]) {
  return hand.map(({ number, suit }) => ({ number, suit }));
}

function table(room: Room, recipient: SeatId): PublicTable {
  const game = room.game;
  const occupants = [...room.occupants.values()];
  const seat = (id: SeatId): PublicSeat | null => {
    const occupant = occupants.find((s) => s.id === id);
    if (!occupant) return null;
    const player = game?.players[id];
    return {
      remainingTileCount: player?.hand.length ?? 0,
      chips: player?.chips ?? INITIAL_CHIPS,
      isOut: player?.isOut ?? false,
      isConnected: occupant.connection !== null,
      ...(occupant.name && { name: occupant.name }),
    };
  };
  const slots: Slots<PublicSeat> = [
    seat(0),
    seat(1),
    seat(2),
    seat(3),
    seat(4),
  ];
  const idle = { turnId: null, deadline: null };
  if (!game) {
    const hostSeatId = occupants[0]?.id ?? null;
    return {
      phase: "LOBBY",
      round: 0,
      maxNumber: null,
      maxRounds: DEFAULT_MAX_ROUNDS,
      slots,
      seatOrder: occupants.map((s) => s.id),
      activePlayers: [],
      hostSeatId,
      ...(room.lastGameResult && { lastGameResult: room.lastGameResult }),
      canStart: hostSeatId === recipient && ready(room),
      currentTurn: null,
      consecutivePasses: 0,
      tableHand: null,
      lastPlay: null,
      lastAction: null,
      lastSettlement: null,
      ranking: [],
      ...idle,
    };
  }
  const {
    phase,
    round,
    maxNumber,
    maxRounds,
    currentTurn,
    lastAction,
    lastPlay,
    lastSettlement,
  } = game;
  if (maxNumber === null) throw new Error("Round has no deck size");
  const common = {
    slots,
    round,
    maxRounds,
    maxNumber,
    seatOrder: [...game.seatOrder],
    activePlayers: [...game.activePlayers],
    consecutivePasses: game.consecutivePasses,
    tableHand: game.tableHand && tiles(game.tableHand),
    lastAction: lastAction && {
      type: lastAction.type,
      automatic: lastAction.automatic,
      turnId: lastAction.turnId,
      seatId: lastAction.seatId,
    },
    lastPlay: lastPlay && {
      turnId: lastPlay.turnId,
      seatId: lastPlay.seatId,
      tiles: tiles(lastPlay.tiles),
    },
    lastSettlement: lastSettlement && {
      round: lastSettlement.round,
      results: lastSettlement.results.map(({ seatId, rank, chipChange }) => ({
        seatId,
        rank,
        chipChange,
      })),
    },
  };
  switch (phase) {
    case "ROUND_START":
    case "TURN_ACTIVE":
      if (currentTurn === null)
        throw new Error("Open round has no current seat");
      if (phase === "ROUND_START")
        return { ...common, phase, currentTurn, ranking: [], ...idle };
      if (room.deadline === null)
        throw new Error("Active turn has no deadline");
      return {
        ...common,
        phase,
        currentTurn,
        ranking: [],
        turnId: game.turnId,
        deadline: room.deadline,
      };
    case "ROUND_SETTLEMENT":
      return { ...common, phase, currentTurn: null, ranking: [], ...idle };
    case "GAME_OVER":
      return {
        ...common,
        phase,
        currentTurn: null,
        ranking: game.ranking.map(({ seatId, rank }) => ({ seatId, rank })),
        ...idle,
      };
    default:
      throw new Error("Unexpected engine phase");
  }
}

export function project(room: Room, recipient: SeatId): PlayerView {
  const publicView = table(room, recipient);
  if (!room.game) return { ...publicView, ownHand: [] };
  const player = room.game.players[recipient];
  if (!player) throw new Error("Occupied game seat has no player");
  if (player.isOut) return publicView;
  const detail = room.game.lastSettlement?.details[recipient];
  const ownHand = tiles(player.hand);
  if (!detail) return { ...publicView, ownHand };
  const { round, remaining, twos, effective } = detail;
  return {
    ...publicView,
    ownHand,
    ownSettlement: { round, remaining, twos, effective },
  };
}
