import type { Rng, RulesApi } from "@caxio/shared/contracts/engine";
import type { DEFAULT_TURN_LIMIT_SECONDS } from "@caxio/shared/contracts/settings";
import type { Assert, Exact } from "@caxio/shared/contracts/type-check";
import type {
  ChatError,
  ChatMessage,
  Message,
  ServerMessage,
} from "@caxio/shared/contracts/wire";
export const DEFAULT_TURN_LIMIT_MS = 30_000;
export type DefaultTurnLimitCheck = Assert<
  Exact<
    `${typeof DEFAULT_TURN_LIMIT_SECONDS}000`,
    `${typeof DEFAULT_TURN_LIMIT_MS}`
  >
>;
export const SEAT_RESERVATION_MS = 30_000;
export const ROOM_DISPOSAL_MS = 300_000; // Empty or finished room, plan §9.
/** Number of consecutive own-turn expiries for a disconnected occupant, the last of which ends the game by abandonment. */
export const ABANDONMENT_TURN_LIMIT = 3;
export type AbandonmentLimitCheck = Assert<
  Exact<typeof ABANDONMENT_TURN_LIMIT, 3>
>;
/** One stable object per open WebSocket. The HTTP adapter serializes outbound messages. */
export interface RoomConnection {
  send(message: ServerMessage): void;
}
export interface RoomService {
  // CREATE_ROOM stores each supplied setting or its shared default for the room's lifetime,
  // including the lobby after abandonment and every restart. Project maxRounds and turnLimitSeconds
  // in every phase to every recipient (including OUT). Pass the room's maxRounds to startRound.
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
  // Decode frames with decodeClientRequest. CREATE_ROOM/JOIN_ROOM store their optional name on the new seat; every
  // PublicSeat of that seat carries it until the seat is vacated (also while disconnected), RESUME keeps it, and
  // abandonment ranking rows copy each named seat's name. LEAVE_ROOM requires a bound seat (NOT_SEATED), handles an
  // expired current turn once like RESUME, then sends the leaver nothing, unbinds the connection and revokes the
  // credential. In the lobby it vacates the seat and broadcasts. From a seat that is not OUT in a running game it
  // ends the game by abandonment like the limit above, with that seat as leaver and the current confirmed chips.
  // From an OUT seat in a running game, or in GAME_OVER, the seat stays in the game disconnected and broadcasts;
  // it is vacated, never reserved, when the room returns to the lobby.
  // CHAT requires a valid body (INVALID_MESSAGE), then a currently bound connection (NOT_SEATED,
  // including replaced sockets and connections unbound by LEAVE_ROOM). It never counts toward
  // MAX_LOOKUP_MISSES. Allow every phase, including OUT spectators and GAME_OVER.
  // Derive seatId from that binding and deliver CHAT to every connected occupant of that room,
  // sender included. Keep no history, replay nothing, and leave snapshots and revision untouched.
  // Count only accepted sends per occupant in (now - CHAT_RATE_LIMIT_WINDOW_MS, now], across RESUME.
  // At CHAT_RATE_LIMIT_COUNT send CHAT_ERROR/CHAT_RATE_LIMITED only to the sender. Free the
  // counter with the vacated seat. Chat validation and rate errors leave the connection open.
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
  // Exclusive path for SEATED, SNAPSHOT and ERROR (including INVALID_MESSAGE and NOT_SEATED).
  send(connection: RoomConnection, message: Message): void;
  // Optional for the pre-chat room fixture and HTTP assembly. For every CHAT and CHAT_ERROR
  // call this when supplied (room tests), otherwise call connection.send(message) (production).
  sendChat?(connection: RoomConnection, message: ChatMessage | ChatError): void;
  // Each deadline uses explicit CREATE_ROOM.turnLimitSeconds × 1000 when supplied.
  // Otherwise use this dependency or DEFAULT_TURN_LIMIT_MS; the public setting remains the shared default.
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
      { send(message: ServerMessage): void },
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
        sendChat?(
          connection: RoomConnection,
          message: ChatMessage | ChatError,
        ): void;
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
