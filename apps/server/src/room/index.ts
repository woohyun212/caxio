import type { GameState, SeatId } from "@caxio/shared/contracts/domain";
import {
  decodeCommand,
  type ErrorCode,
  isRoomCode,
} from "@caxio/shared/contracts/wire";
import {
  type CreateRoomService,
  DEFAULT_TURN_LIMIT_MS,
  ROOM_DISPOSAL_MS,
  type RoomConnection,
  SEAT_RESERVATION_MS,
} from "../contracts";
import { type Occupant, project, type Room, ready } from "./view";

const seats: readonly SeatId[] = [0, 1, 2, 3, 4];
export const createRoomService: CreateRoomService = (deps) => {
  const rooms = new Map<string, Room>();
  const bindings = new Map<RoomConnection, { room: Room; seat: Occupant }>();
  const replaced = new WeakSet<RoomConnection>();
  const limit = deps.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;

  // Each arm owns its callback. Even explicitly replaying a cancelled or early callback is harmless.
  function scheduleAt(
    deadline: number,
    start: number,
    expire: (now: number) => void,
  ) {
    let cancel: () => void;
    function arm(from: number) {
      let live = true;
      const stop = deps.schedule(deadline - from, () => {
        const now = deps.now();
        if (!live) return;
        live = false;
        if (now < deadline) arm(now);
        else expire(now);
      });
      cancel = () => {
        live = false;
        stop();
      };
    }
    arm(start);
    return () => cancel();
  }

  function snapshot(room: Room, seat: Occupant, now: number) {
    if (seat.connection)
      deps.send(seat.connection, {
        type: "SNAPSHOT",
        revision: room.revision,
        serverNow: now,
        view: project(room, seat.id),
      });
  }
  function broadcast(room: Room, now: number) {
    room.revision++;
    for (const seat of room.occupants.values()) snapshot(room, seat, now);
  }
  function disposeLater(room: Room, now: number) {
    room.cancelDisposal?.();
    room.cancelDisposal = scheduleAt(now + ROOM_DISPOSAL_MS, now, () => {
      room.cancelTurn?.();
      for (const seat of room.occupants.values()) {
        seat.cancelReservation?.();
        if (seat.connection) bindings.delete(seat.connection);
      }
      rooms.delete(room.code);
    });
  }
  function automatic(room: Room, game: GameState, now: number) {
    if (game.currentTurn === null)
      throw new Error("Timeout without a current seat");
    const result = deps.rules.applyTurn(
      game,
      game.currentTurn,
      deps.rules.timeoutAction(game),
      true,
    );
    if (!result.ok)
      throw new Error(`Engine rejected timeout action: ${result.code}`);
    commit(room, result.state, now);
  }
  function commit(room: Room, game: GameState, now: number) {
    room.cancelTurn?.();
    delete room.cancelTurn;
    room.deadline = null;
    room.game = game;
    if (game.phase === "TURN_ACTIVE") {
      room.deadline = now + limit;
      room.cancelTurn = scheduleAt(room.deadline, now, (time) =>
        automatic(room, game, time),
      );
    } else if (game.phase === "GAME_OVER") disposeLater(room, now);
    broadcast(room, now);
    if (game.phase === "ROUND_START" || game.phase === "ROUND_SETTLEMENT")
      commit(room, deps.rules.advance(game, deps.dealRng), now);
  }
  function bind(
    room: Room,
    seat: Occupant,
    connection: RoomConnection,
    now: number,
  ) {
    const previous = seat.connection;
    if (previous) {
      bindings.delete(previous);
      replaced.add(previous);
    }
    seat.cancelReservation?.();
    delete seat.cancelReservation;
    if (room.game?.phase !== "GAME_OVER") {
      room.cancelDisposal?.();
      delete room.cancelDisposal;
    }
    seat.connection = connection;
    bindings.set(connection, { room, seat });
    deps.send(connection, {
      type: "SEATED",
      roomCode: room.code,
      seatId: seat.id,
      token: seat.token,
    });
    if (previous) snapshot(room, seat, now);
    else broadcast(room, now);
  }
  function join(
    room: Room,
    id: SeatId,
    connection: RoomConnection,
    now: number,
  ) {
    const seat = { id, token: deps.newToken(), connection: null };
    room.occupants.set(room.nextJoin++, seat);
    bind(room, seat, connection, now);
  }
  return {
    receive(connection, frame) {
      const now = deps.now();
      const command = decodeCommand(frame);
      const error = (code: ErrorCode) =>
        deps.send(connection, { type: "ERROR", code });
      if (command === "INVALID_MESSAGE") return error(command);
      if (replaced.has(connection)) return error("NOT_SEATED");
      const bound = bindings.get(connection);
      switch (command.type) {
        case "CREATE_ROOM": {
          if (bound) return error("INVALID_PHASE");
          let code = deps.newRoomCode();
          while (!isRoomCode(code) || rooms.has(code))
            code = deps.newRoomCode();
          const room: Room = {
            code,
            occupants: new Map(),
            nextJoin: 0,
            revision: 0,
            game: null,
            deadline: null,
          };
          rooms.set(code, room);
          return join(room, 0, connection, now);
        }
        case "JOIN_ROOM":
        case "RESUME": {
          if (bound) return error("INVALID_PHASE");
          const room = rooms.get(command.roomCode);
          if (!room) return error("ROOM_NOT_FOUND");
          const occupants = [...room.occupants.values()];
          if (command.type === "RESUME") {
            const seat = occupants.find((s) => s.token === command.token);
            if (!seat) return error("RESUME_DENIED");
            return bind(room, seat, connection, now);
          }
          if (room.game) return error("GAME_STARTED");
          const id = seats.find((id) => occupants.every((s) => s.id !== id));
          if (id === undefined) return error("ROOM_FULL");
          return join(room, id, connection, now);
        }
        case "START_GAME": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          if (room.game) return error("INVALID_PHASE");
          const order = [...room.occupants.values()].map((s) => s.id);
          if (order[0] !== seat.id) return error("NOT_HOST");
          if (!ready(room)) return error("NOT_READY");
          return commit(room, deps.rules.startRound(order, deps.dealRng), now);
        }
        case "PLAY":
        case "PASS": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          const game = room.game;
          if (game?.phase !== "TURN_ACTIVE" || room.deadline === null)
            return error("INVALID_PHASE");
          if (command.turnId !== game.turnId) return error("STALE_TURN");
          if (now >= room.deadline) {
            automatic(room, game, now);
            return error("TIME_EXPIRED");
          }
          const result = deps.rules.applyTurn(
            game,
            seat.id,
            command.type === "PASS"
              ? { type: "PASS" }
              : { type: "PLAY", tiles: command.tiles },
          );
          if (!result.ok) return error(result.code);
          return commit(room, result.state, now);
        }
      }
    },
    close(connection) {
      const now = deps.now();
      const bound = bindings.get(connection);
      if (!bound) return;
      const { room, seat } = bound;
      bindings.delete(connection);
      seat.connection = null;
      if (!room.game) {
        seat.cancelReservation = scheduleAt(
          now + SEAT_RESERVATION_MS,
          now,
          (time) => {
            for (const [number, occupant] of room.occupants)
              if (occupant === seat) room.occupants.delete(number);
            broadcast(room, time);
          },
        );
      }
      if (
        room.game?.phase !== "GAME_OVER" &&
        [...room.occupants.values()].every((s) => s.connection === null)
      )
        disposeLater(room, now);
      broadcast(room, now);
    },
  };
};
