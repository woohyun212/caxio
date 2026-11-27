import type { GameState, SeatId } from "@caxio/shared/contracts/domain";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TURN_LIMIT_SECONDS,
} from "@caxio/shared/contracts/settings";
import {
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  decodeClientRequest,
  type ErrorCode,
  isRoomCode,
} from "@caxio/shared/contracts/wire";
import {
  ABANDONMENT_TURN_LIMIT,
  type CreateRoomService,
  DEFAULT_TURN_LIMIT_MS,
  ROOM_DISPOSAL_MS,
  type RoomConnection,
  SEAT_RESERVATION_MS,
} from "../contracts";
import { type Occupant, project, type Room, ready } from "./view";

const seats: readonly SeatId[] = [0, 1, 2, 3, 4];
const MAX_LIVE_ROOMS = 1_000;
const MAX_LOOKUP_MISSES = 5;
export const createRoomService: CreateRoomService = (deps) => {
  const sendChat: NonNullable<typeof deps.sendChat> =
    deps.sendChat ?? ((connection, message) => connection.send(message));
  const rooms = new Map<string, Room>();
  const bindings = new Map<RoomConnection, { room: Room; seat: Occupant }>();
  const replaced = new WeakSet<RoomConnection>();
  const lookupMisses = new WeakMap<RoomConnection, number>();

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
  function reserve(room: Room, seat: Occupant, now: number) {
    seat.cancelReservation = scheduleAt(
      now + SEAT_RESERVATION_MS,
      now,
      (time) => {
        for (const [join, occupant] of room.occupants)
          if (occupant === seat) room.occupants.delete(join);
        broadcast(room, time);
      },
    );
  }
  function cancelTurn(room: Room) {
    room.cancelTurn?.();
    delete room.cancelTurn;
    room.deadline = null;
  }
  function expire(room: Room, game: GameState, now: number) {
    if (room.game !== game || room.deadline === null || now < room.deadline)
      return false;
    const seat = [...room.occupants.values()].find(
      (occupant) => occupant.id === game.currentTurn,
    );
    if (!seat) throw new Error("Timeout without a current occupant");
    const action = deps.rules.timeoutAction(game);
    if (
      seat.connection === null &&
      seat.disconnectedTurns === ABANDONMENT_TURN_LIMIT - 1
    ) {
      abandon(room, game, seat, now);
      broadcast(room, now);
    } else {
      const result = deps.rules.applyTurn(game, seat.id, action, true);
      if (!result.ok)
        throw new Error(`Engine rejected timeout action: ${result.code}`);
      if (seat.connection === null) seat.disconnectedTurns++;
      commit(room, result.state, now);
    }
    return true;
  }
  // Return to the lobby: vacate the leaver and every departed seat, reserve the other offline seats.
  function abandon(room: Room, game: GameState, leaver: Occupant, now: number) {
    const occupants = [...room.occupants.values()];
    const ranking = deps.rules.rank(game, leaver.id).map(({ seatId, rank }) => {
      const player = game.players[seatId];
      if (!player) throw new Error("Ranked seat has no player");
      const name = occupants.find((s) => s.id === seatId)?.name;
      return { seatId, rank, chips: player.chips, ...(name && { name }) };
    });
    cancelTurn(room);
    room.game = null;
    room.lastGameResult = {
      reason: "ABANDONMENT",
      leaverSeatId: leaver.id,
      ranking,
    };
    leaver.left = true;
    vacate(room);
    for (const other of room.occupants.values())
      if (other.connection === null) reserve(room, other, now);
  }
  function vacate(room: Room) {
    for (const [join, occupant] of room.occupants)
      if (occupant.left) room.occupants.delete(join);
  }
  // Unbind a connection; an all-offline room that is not finished starts its disposal clock.
  function release(
    connection: RoomConnection,
    room: Room,
    seat: Occupant,
    now: number,
  ) {
    bindings.delete(connection);
    seat.connection = null;
    if (
      room.game?.phase !== "GAME_OVER" &&
      [...room.occupants.values()].every((s) => s.connection === null)
    )
      disposeLater(room, now);
    broadcast(room, now);
  }
  function commit(room: Room, game: GameState, now: number) {
    cancelTurn(room);
    room.game = game;
    if (game.phase === "TURN_ACTIVE") {
      room.lastTurnId = game.turnId;
      room.deadline = now + room.turnLimitMs;
      room.cancelTurn = scheduleAt(room.deadline, now, (time) =>
        expire(room, game, time),
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
    seat.disconnectedTurns = 0;
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
    name: string | undefined,
  ) {
    const seat: Occupant = {
      id,
      token: deps.newToken(),
      connection: null,
      disconnectedTurns: 0,
      chatTimes: [],
      name,
    };
    room.occupants.set(room.nextJoin++, seat);
    bind(room, seat, connection, now);
  }
  return {
    receive(connection, frame) {
      const now = deps.now();
      const command = decodeClientRequest(frame);
      const error = (code: ErrorCode) => {
        if (code === "ROOM_NOT_FOUND" || code === "RESUME_DENIED")
          lookupMisses.set(connection, (lookupMisses.get(connection) ?? 0) + 1);
        deps.send(connection, { type: "ERROR", code });
      };
      if (command === "INVALID_MESSAGE") return error(command);
      if (
        (command.type === "JOIN_ROOM" || command.type === "RESUME") &&
        (lookupMisses.get(connection) ?? 0) >= MAX_LOOKUP_MISSES
      )
        return error("INVALID_PHASE");
      if (replaced.has(connection)) return error("NOT_SEATED");
      const bound = bindings.get(connection);
      switch (command.type) {
        case "CHAT": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          seat.chatTimes = seat.chatTimes.filter(
            (time) => time > now - CHAT_RATE_LIMIT_WINDOW_MS,
          );
          // Retain future timestamps across a backwards clock adjustment until their window expires.
          if (
            seat.chatTimes.filter((time) => time <= now).length >=
            CHAT_RATE_LIMIT_COUNT
          )
            return sendChat(connection, {
              type: "CHAT_ERROR",
              code: "CHAT_RATE_LIMITED",
            });
          seat.chatTimes.push(now);
          const message = {
            type: "CHAT",
            seatId: seat.id,
            text: command.text,
          } as const;
          for (const occupant of room.occupants.values())
            if (occupant.connection) sendChat(occupant.connection, message);
          return;
        }
        case "CREATE_ROOM": {
          if (bound) return error("INVALID_PHASE");
          if (rooms.size >= MAX_LIVE_ROOMS) return error("ROOM_FULL");
          let code = deps.newRoomCode();
          while (!isRoomCode(code) || rooms.has(code))
            code = deps.newRoomCode();
          const room: Room = {
            code,
            turnLimitSeconds:
              command.turnLimitSeconds ?? DEFAULT_TURN_LIMIT_SECONDS,
            maxRounds: command.maxRounds ?? DEFAULT_MAX_ROUNDS,
            turnLimitMs:
              command.turnLimitSeconds === undefined
                ? (deps.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS)
                : command.turnLimitSeconds * 1000,
            occupants: new Map(),
            nextJoin: 0,
            lastTurnId: 0,
            revision: 0,
            game: null,
            deadline: null,
          };
          rooms.set(code, room);
          return join(room, 0, connection, now, command.name);
        }
        case "JOIN_ROOM":
        case "RESUME": {
          if (bound) return error("INVALID_PHASE");
          const room = rooms.get(command.roomCode);
          if (!room) return error("ROOM_NOT_FOUND");
          const occupants = [...room.occupants.values()];
          if (command.type === "RESUME") {
            const find = () =>
              [...room.occupants.values()].find(
                (s) => !s.left && s.token === command.token,
              );
            let seat = find();
            const game = room.game;
            if (
              seat &&
              game?.phase === "TURN_ACTIVE" &&
              seat.id === game.currentTurn &&
              expire(room, game, now)
            )
              seat = find();
            if (!seat) return error("RESUME_DENIED");
            return bind(room, seat, connection, now);
          }
          if (room.game) return error("GAME_STARTED");
          const id = seats.find((id) => occupants.every((s) => s.id !== id));
          if (id === undefined) return error("ROOM_FULL");
          return join(room, id, connection, now, command.name);
        }
        case "START_GAME": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          if (room.game) return error("INVALID_PHASE");
          const order = [...room.occupants.values()].map((s) => s.id);
          if (order[0] !== seat.id) return error("NOT_HOST");
          if (!ready(room)) return error("NOT_READY");
          const game = deps.rules.startRound(
            order,
            deps.dealRng,
            room.maxRounds,
          );
          for (const occupant of room.occupants.values())
            occupant.disconnectedTurns = 0;
          delete room.lastGameResult;
          return commit(room, { ...game, turnId: room.lastTurnId }, now);
        }
        case "PLAY":
        case "PASS": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          const game = room.game;
          if (game?.phase !== "TURN_ACTIVE" || room.deadline === null)
            return error("INVALID_PHASE");
          if (command.turnId !== game.turnId) return error("STALE_TURN");
          if (expire(room, game, now)) return error("TIME_EXPIRED");
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
        case "LEAVE_ROOM": {
          if (!bound) return error("NOT_SEATED");
          const { room, seat } = bound;
          if (room.game) expire(room, room.game, now);
          // Leaving applies to the state after any expiry. OUT and finished seats stay in the game offline.
          const game = room.game;
          seat.left = true;
          if (!game) vacate(room);
          else if (game.phase !== "GAME_OVER" && !game.players[seat.id]?.isOut)
            abandon(room, game, seat, now);
          return release(connection, room, seat, now);
        }
      }
    },
    close(connection) {
      const now = deps.now();
      const bound = bindings.get(connection);
      if (!bound) return;
      const { room, seat } = bound;
      if (!room.game) reserve(room, seat, now);
      release(connection, room, seat, now);
    },
  };
};
