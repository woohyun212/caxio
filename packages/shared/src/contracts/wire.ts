import type {
  Action,
  LastAction,
  LastPlay,
  LastSettlement,
  MaxNumber,
  OwnSettlement,
  RankingRow,
  SeatId,
  Slots,
  Tile,
} from "./domain";
export const WS_PATH = "/ws";
// GET HEALTH_PATH returns 200 with body "ok"; the probe asserts status 200 only.
export const HEALTH_PATH = "/healthz";
export const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function isRoomCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 6 &&
    [...value].every((char) => ROOM_ALPHABET.includes(char))
  );
}
export const ERROR_TEXT = {
  ROOM_NOT_FOUND: "방 코드를 찾을 수 없어요.",
  ROOM_FULL: "빈자리가 없어요.",
  GAME_STARTED: "이미 시작한 방이에요.",
  RESUME_DENIED: "자리를 복구할 수 없어요. 새 방을 만들어 주세요.",
  NOT_SEATED: "먼저 방에 입장해 주세요.",
  NOT_HOST: "방장만 시작할 수 있어요.",
  NOT_READY: "3~5명이 모두 연결되어야 시작해요.",
  INVALID_PHASE: "지금은 이 행동을 할 수 없어요.",
  NOT_YOUR_TURN: "내 차례를 기다려 주세요.",
  STALE_TURN: "차례가 바뀌었어요.",
  TIME_EXPIRED: "시간이 지났어요.",
  NOT_OWNED: "내 손패에 없는 패예요.",
  DUPLICATE_TILE: "같은 패를 두 번 낼 수 없어요.",
  ILLEGAL_HAND: "낼 수 없는 조합이에요.",
  WRONG_COUNT: "바닥과 같은 장수로 내세요.",
  NOT_HIGHER: "바닥보다 높은 조합이 필요해요.",
  LEAD_PASS: "선은 패스할 수 없어요.",
  INVALID_MESSAGE: "요청을 읽을 수 없어요.",
} as const;
export type ErrorCode = keyof typeof ERROR_TEXT;
export const UNKNOWN_ERROR_TEXT = "요청을 처리하지 못했어요.";
export function errorText(code: string): string {
  return isErrorCode(code) ? ERROR_TEXT[code] : UNKNOWN_ERROR_TEXT;
}
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_TEXT, value);
}
export type Credential = Readonly<{ roomCode: string; token: string }>;
export type Command =
  | { type: "CREATE_ROOM" }
  | { type: "JOIN_ROOM"; roomCode: string }
  | ({ type: "RESUME" } & Credential)
  | { type: "START_GAME" }
  | (Action & { turnId: number });
export type PublicSeat = Readonly<{
  remainingTileCount: number;
  chips: number;
  isOut: boolean;
  isConnected: boolean;
}>;
type TableFields = Readonly<{
  slots: Slots<PublicSeat>;
  seatOrder: readonly SeatId[];
  // [] in LOBBY; otherwise join order without OUT seats, including immediately after payment in ROUND_SETTLEMENT.
  activePlayers: readonly SeatId[];
  consecutivePasses: number;
  maxRounds: number;
  // Trick clear empties tableHand; the settlement snapshot still holds the winning PLAY.
  tableHand: readonly Tile[] | null;
  lastPlay: LastPlay | null;
  // ROUND_START clears both lastAction and lastPlay.
  lastAction: LastAction | null;
  // Project round and each row's seatId, rank, chipChange. Passing through GameState.lastSettlement leaks details and payments.
  lastSettlement: LastSettlement | null;
}>;
type RoundFields = { readonly round: number; readonly maxNumber: MaxNumber };
// Emit ROUND_START before TURN_ACTIVE; only TURN_ACTIVE carries a non-null turnId and epoch deadline.
type IdleClock = { readonly turnId: null; readonly deadline: null };
export type PublicTable = Readonly<
  TableFields &
    (
      | ({
          phase: "LOBBY";
          round: 0;
          maxNumber: null;
          currentTurn: null;
          ranking: readonly [];
          // Only the lobby carries hostSeatId and canStart; its seated recipient has ownHand: [].
          hostSeatId: SeatId | null;
          canStart: boolean;
        } & IdleClock)
      | ({
          phase: "ROUND_START";
          currentTurn: SeatId;
          ranking: readonly [];
        } & RoundFields &
          IdleClock)
      | ({
          phase: "TURN_ACTIVE";
          currentTurn: SeatId;
          ranking: readonly [];
          turnId: number;
          deadline: number;
        } & RoundFields)
      | ({
          phase: "ROUND_SETTLEMENT";
          currentTurn: null;
          ranking: readonly [];
        } & RoundFields &
          IdleClock)
      | ({
          phase: "GAME_OVER";
          currentTurn: null;
          ranking: readonly RankingRow[];
        } & RoundFields &
          IdleClock)
    )
>;
export type PlayerView = PublicTable &
  (
    | {
        readonly ownHand: readonly Tile[];
        readonly ownSettlement?: OwnSettlement;
      }
    | { readonly ownHand?: never; readonly ownSettlement?: never }
  );
export type Seated = { type: "SEATED"; seatId: SeatId } & Credential;
export type Snapshot = {
  type: "SNAPSHOT";
  revision: number;
  serverNow: number;
  view: PlayerView;
};
export type Message = Seated | Snapshot | { type: "ERROR"; code: ErrorCode };

function safeInteger(v: unknown): v is number {
  return Number.isSafeInteger(v);
}
function integer(
  v: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): v is number {
  return safeInteger(v) && v >= min && v <= max;
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function onlyKeys(v: Record<string, unknown>, fields: readonly string[]) {
  return Object.keys(v).every((key) => fields.includes(key));
}
function shape(
  v: unknown,
  fields: readonly string[],
): v is Record<string, unknown> {
  return record(v) && onlyKeys(v, fields);
}
function list<T>(v: unknown, check: (e: unknown) => e is T): v is T[] {
  return Array.isArray(v) && v.every(check);
}
function seat(v: unknown): v is SeatId {
  return integer(v, 0, 4);
}
function tile(v: unknown): v is Tile {
  return (
    shape(v, ["number", "suit"]) &&
    integer(v.number, 1, 15) &&
    integer(v.suit, 0, 3)
  );
}
function seats(v: unknown): v is SeatId[] {
  return list(v, seat) && new Set(v).size === v.length;
}
function read(frame: unknown): unknown {
  if (typeof frame !== "string") return null;
  try {
    return JSON.parse(frame);
  } catch {
    return null;
  }
}
function token(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function command(v: unknown): v is Command {
  if (!record(v)) return false;
  switch (v.type) {
    case "CREATE_ROOM":
    case "START_GAME":
      return onlyKeys(v, ["type"]);
    case "JOIN_ROOM":
      return onlyKeys(v, ["type", "roomCode"]) && isRoomCode(v.roomCode);
    case "RESUME":
      return (
        onlyKeys(v, ["type", "roomCode", "token"]) &&
        isRoomCode(v.roomCode) &&
        token(v.token)
      );
    case "PASS":
      return onlyKeys(v, ["type", "turnId"]) && integer(v.turnId, 1);
    case "PLAY":
      return (
        onlyKeys(v, ["type", "turnId", "tiles"]) &&
        integer(v.turnId, 1) &&
        list(v.tiles, tile) &&
        v.tiles.length <= 13
      );
    default:
      return false;
  }
}
/** Text JSON with exact keys and 0–13 tiles. Ownership, duplicates, count and hand strength belong to the rules. */
export function decodeCommand(frame: unknown): Command | "INVALID_MESSAGE" {
  const v = read(frame);
  return command(v) ? v : "INVALID_MESSAGE";
}

function publicSeat(v: unknown): v is PublicSeat {
  return (
    shape(v, ["remainingTileCount", "chips", "isOut", "isConnected"]) &&
    integer(v.remainingTileCount, 0, 13) &&
    integer(v.chips) &&
    typeof v.isOut === "boolean" &&
    typeof v.isConnected === "boolean"
  );
}
function hasSeat(order: readonly SeatId[], id: unknown): id is SeatId {
  return order.some((seatId) => seatId === id);
}
function ranking(
  value: unknown,
  order: readonly SeatId[],
): value is RankingRow[] {
  if (!Array.isArray(value) || value.length !== order.length) return false;
  let previousRank = 0;
  const seen = new Set<SeatId>();
  for (const [i, r] of value.entries()) {
    if (
      !shape(r, ["seatId", "rank"]) ||
      !hasSeat(order, r.seatId) ||
      seen.has(r.seatId)
    )
      return false;
    if (r.rank !== i + 1 && (i === 0 || r.rank !== previousRank)) return false;
    previousRank = r.rank;
    seen.add(r.seatId);
  }
  return true;
}
function settlement(
  v: unknown,
  round: number,
  order: readonly SeatId[],
  active: readonly SeatId[],
): v is LastSettlement {
  if (
    !shape(v, ["round", "results"]) ||
    v.round !== round ||
    !Array.isArray(v.results)
  )
    return false;
  const participants = new Set<SeatId>(),
    ranks = new Set<number>();
  let net = 0;
  for (const r of v.results) {
    if (
      !shape(r, ["seatId", "rank", "chipChange"]) ||
      !hasSeat(order, r.seatId) ||
      participants.has(r.seatId)
    )
      return false;
    if (
      !integer(r.rank, 1, v.results.length) ||
      ranks.has(r.rank) ||
      !integer(r.chipChange, -320, 320)
    )
      return false;
    participants.add(r.seatId);
    ranks.add(r.rank);
    net += r.chipChange;
  }
  return net === 0 && active.every((id) => participants.has(id));
}
function ownResult(v: unknown, round: number): v is OwnSettlement {
  return (
    shape(v, ["round", "remaining", "twos", "effective"]) &&
    v.round === round &&
    integer(v.remaining, 0, 13) &&
    integer(v.twos, 0, Math.min(v.remaining, 4)) &&
    v.effective === v.remaining * 2 ** v.twos
  );
}
function validTiles(v: unknown, n: number): v is Tile[] {
  return (
    list(v, tile) &&
    v.every((t) => t.number <= n) &&
    new Set(v.map((t) => t.number * 4 + t.suit)).size === v.length
  );
}
function play(v: unknown, n: number, order: readonly SeatId[]): v is LastPlay {
  return (
    shape(v, ["turnId", "seatId", "tiles"]) &&
    integer(v.turnId, 1) &&
    hasSeat(order, v.seatId) &&
    validTiles(v.tiles, n) &&
    [1, 2, 3, 5].includes(v.tiles.length)
  );
}
function history(
  v: Record<string, unknown>,
  n: number,
  order: readonly SeatId[],
  paid: boolean,
): boolean {
  const last = v.lastPlay,
    action = v.lastAction,
    table = v.tableHand;
  if (v.phase === "LOBBY" || v.phase === "ROUND_START" || last === null) {
    return !paid && last === null && action === null && table === null;
  }
  if (
    !play(last, n, order) ||
    !shape(action, ["turnId", "seatId", "type", "automatic"]) ||
    typeof action.automatic !== "boolean"
  )
    return false;
  if (action.type === "PASS") {
    if (
      paid ||
      !integer(action.turnId, last.turnId + 1) ||
      !hasSeat(order, action.seatId)
    )
      return false;
  } else if (
    action.type !== "PLAY" ||
    action.turnId !== last.turnId ||
    action.seatId !== last.seatId
  )
    return false;
  if (
    v.phase === "TURN_ACTIVE" &&
    !(typeof v.turnId === "number" && v.turnId > action.turnId)
  )
    return false;
  if (table === null) return action.type === "PASS";
  return (
    validTiles(table, n) &&
    table.length === last.tiles.length &&
    table.every((t) =>
      last.tiles.some((p) => p.number === t.number && p.suit === t.suit),
    )
  );
}
const fields = [
  "slots",
  "seatOrder",
  "activePlayers",
  "consecutivePasses",
  "maxRounds",
  "tableHand",
  "lastPlay",
  "lastAction",
  "lastSettlement",
  "phase",
  "round",
  "maxNumber",
  "currentTurn",
  "ranking",
  "turnId",
  "deadline",
];
function validView(v: unknown, recipient: SeatId): v is PlayerView {
  if (
    !record(v) ||
    !list(
      v.slots,
      (s): s is PublicSeat | null => s === null || publicSeat(s),
    ) ||
    v.slots.length !== 5 ||
    !seats(v.seatOrder) ||
    !seats(v.activePlayers)
  )
    return false;
  const slots = v.slots,
    order = v.seatOrder,
    active = v.activePlayers,
    self = slots[recipient];
  if (!self || slots.some((s, i) => (s !== null) !== hasSeat(order, i)))
    return false;
  const lobby = v.phase === "LOBBY",
    start = v.phase === "ROUND_START",
    running = v.phase === "TURN_ACTIVE",
    over = v.phase === "GAME_OVER",
    paid = over || v.phase === "ROUND_SETTLEMENT";
  if (!lobby && !start && !running && !paid) return false;
  if (
    !integer(v.maxRounds, 1) ||
    !integer(v.round, lobby ? 0 : 1, lobby ? 0 : v.maxRounds) ||
    !integer(v.consecutivePasses, 0, start || lobby ? 0 : 4)
  )
    return false;
  const survivors = lobby ? [] : order.filter((id) => !slots[id]?.isOut);
  if (
    active.length !== survivors.length ||
    active.some((id, i) => id !== survivors[i])
  )
    return false;
  const settled = v.lastSettlement,
    paidRound = paid ? v.round : v.round - 1;
  let count = active.length;
  if (paidRound > 0) {
    if (!settlement(settled, paidRound, order, active)) return false;
    if (paid) count = settled.results.length;
  } else if (settled !== null) return false;
  const n = count === 3 ? 9 : count === 4 ? 13 : count === 5 ? 15 : null;
  if ((!lobby && n === null) || v.maxNumber !== n) return false;
  const hasOwnResult = !self.isOut && paidRound > 0;
  if (
    !onlyKeys(v, [
      ...fields,
      ...(lobby ? ["hostSeatId", "canStart"] : []),
      ...(self.isOut ? [] : ["ownHand"]),
      ...(hasOwnResult ? ["ownSettlement"] : []),
    ])
  )
    return false;
  if (!self.isOut) {
    if (
      !validTiles(v.ownHand, n ?? 0) ||
      v.ownHand.length !== self.remainingTileCount
    )
      return false;
    if (hasOwnResult) {
      if (!ownResult(v.ownSettlement, paidRound)) return false;
      if (
        paid &&
        (v.ownSettlement.remaining !== v.ownHand.length ||
          v.ownSettlement.twos !==
            v.ownHand.filter((t) => t.number === 2).length)
      )
        return false;
    }
  }
  if (!history(v, n ?? 0, order, paid)) return false;
  if (
    over
      ? !ranking(v.ranking, order)
      : !(Array.isArray(v.ranking) && v.ranking.length === 0)
  )
    return false;
  if (
    running
      ? !(integer(v.turnId, 1) && integer(v.deadline))
      : !(v.turnId === null && v.deadline === null)
  )
    return false;
  if (
    start || running ? !hasSeat(active, v.currentTurn) : v.currentTurn !== null
  )
    return false;
  if (lobby)
    return (
      v.hostSeatId === order[0] &&
      v.canStart ===
        (recipient === v.hostSeatId &&
          order.length >= 3 &&
          order.every((id) => slots[id]?.isConnected)) &&
      slots.every((s) => !s || (!s.isOut && s.remainingTileCount === 0))
    );
  if (start)
    return active.every(
      (id) => slots[id]?.remainingTileCount === (active.length === 4 ? 13 : 12),
    );
  return !over || v.round === v.maxRounds || active.length < 3;
}
/** Check SNAPSHOT privacy against the socket's bound seat. The server sends SEATED before its first SNAPSHOT. */
export function decodeServerMessage(
  frame: unknown,
  recipient: SeatId | null,
): Message | "INVALID_MESSAGE" {
  const v = read(frame);
  if (record(v)) {
    if (
      v.type === "ERROR" &&
      onlyKeys(v, ["type", "code"]) &&
      isErrorCode(v.code)
    )
      return { type: v.type, code: v.code };
    if (
      v.type === "SEATED" &&
      onlyKeys(v, ["type", "roomCode", "seatId", "token"]) &&
      isRoomCode(v.roomCode) &&
      seat(v.seatId) &&
      (recipient === null || v.seatId === recipient) &&
      token(v.token)
    )
      return {
        type: v.type,
        roomCode: v.roomCode,
        seatId: v.seatId,
        token: v.token,
      };
    if (
      v.type === "SNAPSHOT" &&
      recipient !== null &&
      onlyKeys(v, ["type", "revision", "serverNow", "view"]) &&
      integer(v.revision) &&
      integer(v.serverNow) &&
      validView(v.view, recipient)
    )
      return {
        type: v.type,
        revision: v.revision,
        serverNow: v.serverNow,
        view: v.view,
      };
  }
  return "INVALID_MESSAGE";
}
