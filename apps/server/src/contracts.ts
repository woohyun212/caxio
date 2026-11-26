import type { Rng, RulesApi } from "@caxio/shared/contracts/engine";
import type { Assert, Exact } from "@caxio/shared/contracts/type-check";
import type { Message } from "@caxio/shared/contracts/wire";
export const DEFAULT_TURN_LIMIT_MS = 30_000;
export const SEAT_RESERVATION_MS = 30_000;
export const ROOM_DISPOSAL_MS = 300_000; // Empty or finished room, plan §9.
/** Number of consecutive own-turn expiries for a disconnected occupant, the last of which ends the game by abandonment. */
export const ABANDONMENT_TURN_LIMIT = 3;
export type AbandonmentLimitCheck = Assert<
  Exact<typeof ABANDONMENT_TURN_LIMIT, 3>
>;
/** One stable object per open WebSocket. The HTTP adapter serializes outbound messages. */
export interface RoomConnection {
  send(message: Message): void;
}
export interface RoomService {
  // Accepted CREATE_ROOM/JOIN_ROOM/RESUME sends SEATED before the requester's first SNAPSHOT, which needs a bound seat.
  // START_GAME/PLAY/PASS require a seat (NOT_SEATED), then the command's phase (INVALID_PHASE), before turn checks.
  // A bound active-turn request checks stale ID, expiry, seat, ownership, duplication, legality, count, then strength.
  // The timer, late PLAY/PASS and authenticated RESUME by the current seat share one expiry path.
  // Before its deadline a return wins. At or after it, handle the expired turn once before binding;
  // recheck the credential (RESUME_DENIED if that expiry ended the game by abandonment). Late current-id requests get TIME_EXPIRED.
  // Count only a disconnected occupant's own current deadline: exclude manual actions, connected timeouts,
  // other turns, OUT/spectators and duplicate, early or cancelled callbacks. Carry counts across rounds;
  // authenticated RESUME resets only the returning occupant's count.
  // Choose timeoutAction(game) once. Every expiry commits the automatic action exactly once unless
  // this disconnected own-turn expiry reaches ABANDONMENT_TURN_LIMIT, which ends the game by abandonment.
  // Below the limit, count a disconnected own-turn expiry when its automatic action succeeds.
  // At the limit, skip applyTurn, settlement and advance. Return the seat and credential and send
  // exactly one lobby SNAPSHOT of the same new revision to each remaining connection.
  receive(connection: RoomConnection, frame: unknown): void;
  // The HTTP adapter reports each closed connection exactly once.
  close(connection: RoomConnection): void;
}
export interface RoomDependencies {
  rules: RulesApi;
  // Used only for dealing; room code collisions and token generation have independent sources.
  dealRng: Rng;
  newRoomCode(): string;
  newToken(): string;
  // Server epoch milliseconds, read once at the start of an event.
  now(): number;
  // Relative delay in milliseconds; call the returned function to cancel.
  schedule(delayMs: number, callback: () => void): () => void;
  // Room tests observe this exclusive send path; HTTP adapter tests observe RoomConnection.send.
  send(connection: RoomConnection, message: Message): void;
  // Defaults to DEFAULT_TURN_LIMIT_MS.
  turnLimitMs?: number;
}
export type CreateRoomService = (deps: RoomDependencies) => RoomService;
// Serve WS_PATH and HEALTH_PATH from the shared wire contract on the same port.
export type StartHttpServer = (
  roomService: RoomService,
  staticRoot: string,
  port: number,
) => { url: string; stop(): Promise<void> };

export type RoomDurationCheck = Assert<
  Exact<
    [
      typeof DEFAULT_TURN_LIMIT_MS,
      typeof SEAT_RESERVATION_MS,
      typeof ROOM_DISPOSAL_MS,
    ],
    [30_000, 30_000, 300_000]
  >
>;

export type RoomContractCheck = Assert<
  Exact<
    [
      RoomConnection,
      RoomService,
      RoomDependencies,
      CreateRoomService,
      StartHttpServer,
    ],
    [
      { send(message: Message): void },
      {
        receive(connection: RoomConnection, frame: unknown): void;
        close(connection: RoomConnection): void;
      },
      {
        rules: RulesApi;
        dealRng: Rng;
        newRoomCode(): string;
        newToken(): string;
        now(): number;
        schedule(delayMs: number, callback: () => void): () => void;
        send(connection: RoomConnection, message: Message): void;
        turnLimitMs?: number;
      },
      (deps: RoomDependencies) => RoomService,
      (
        roomService: RoomService,
        staticRoot: string,
        port: number,
      ) => { url: string; stop(): Promise<void> },
    ]
  >
>;
