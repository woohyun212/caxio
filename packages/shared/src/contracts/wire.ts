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
import {
  isMaxRounds,
  isTurnLimitSeconds,
  type RoomSettings,
  type TurnLimitSeconds,
} from "./settings";
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
export const ABANDONMENT_NOTICE = "참가자 이탈로 게임이 종료되었습니다";
export const LEAVER_SEAT_PREFIX = "이탈한 좌석";
export const LAST_GAME_RANKING_TITLE = "직전 게임 순위";
/** Grapheme limits count user-perceived characters. The independent UTF-16 caps fit
 * that many 11-unit family emoji and bound the cost of normalization and segmentation. */
export const PLAYER_NAME_MAX_LENGTH = 6;
export const PLAYER_NAME_MAX_CODE_UNITS = 66;
export const CHAT_TEXT_MAX_LENGTH = 100;
export const CHAT_TEXT_MAX_CODE_UNITS = 1_100;
/** Per room occupant, count accepted sends in (now - window, now]. Rejections do not
 * count. Preserve timestamps on reconnect and discard them when the seat is vacated. */
export const CHAT_RATE_LIMIT_COUNT = 5;
export const CHAT_RATE_LIMIT_WINDOW_MS = 5_000;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// In Unicode mode paired surrogates form one scalar. The surrogate range matches only lone halves.
// Bidi controls and emoji tags are Cf. ZWJ is the sole Cf exception.
const forbidden =
  /[\uD800-\uDFFF\p{Cc}\p{Co}\p{Cn}\u115F\u1160\u3164\uFFA0]|(?!\u200D)\p{Cf}/u;
const visible = /[^\p{M}\p{Default_Ignorable_Code_Point}\p{White_Space}]/u;
function nameCluster(cluster: string): boolean {
  if (/^[#*0-9]\uFE0F?\u20E3$/u.test(cluster)) return true;
  if (/^\p{Regional_Indicator}{2}$/u.test(cluster)) return true;
  return (
    /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D]+$/u.test(
      cluster,
    ) &&
    /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(cluster) &&
    visible.test(cluster)
  );
}

/** Optional, duplicate names allowed. Client trims and normalizes to NFC before sending.
 * Each cluster needs a visible letter, number or emoji base. Reject standalone marks,
 * Hangul fillers, whitespace, ordinary punctuation and non-emoji symbols. */
export function isPlayerName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > PLAYER_NAME_MAX_CODE_UNITS ||
    forbidden.test(value) ||
    value !== value.normalize("NFC")
  )
    return false;
  let count = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (++count > PLAYER_NAME_MAX_LENGTH || !nameCluster(segment)) return false;
  }
  return true;
}

/** Free text, including punctuation and markup-looking literals. The wire preserves
 * normalization. The client trims first; only inner U+0020 spaces are accepted. */
export function isChatText(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > CHAT_TEXT_MAX_CODE_UNITS ||
    value !== value.trim() ||
    forbidden.test(value) ||
    /(?! )[\p{White_Space}\p{Z}]/u.test(value) ||
    !visible.test(value)
  )
    return false;
  return Array.from(graphemes.segment(value)).length <= CHAT_TEXT_MAX_LENGTH;
}
export type ErrorCode = keyof typeof ERROR_TEXT;
export const CHAT_ERROR_TEXT = {
  CHAT_RATE_LIMITED: "채팅을 너무 빨리 보냈어요. 잠시 후 다시 보내 주세요.",
} as const;
export type ChatErrorCode = keyof typeof CHAT_ERROR_TEXT;
export const UNKNOWN_ERROR_TEXT = "요청을 처리하지 못했어요.";
export function errorText(code: string): string {
  if (isErrorCode(code)) return ERROR_TEXT[code];
  return isChatErrorCode(code) ? CHAT_ERROR_TEXT[code] : UNKNOWN_ERROR_TEXT;
}
function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === "string" && Object.hasOwn(CHAT_ERROR_TEXT, value);
}
function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_TEXT, value);
}
export type Credential = Readonly<{ roomCode: string; token: string }>;
// Omit name for an unnamed seat. The seat keeps it until it is vacated; RESUME keeps the stored name.
type Naming = { name?: string };
export type Command =
  | ({ type: "CREATE_ROOM" } & Naming & RoomSettings)
  | ({ type: "JOIN_ROOM"; roomCode: string } & Naming)
  | ({ type: "RESUME" } & Credential)
  | { type: "START_GAME" }
  | (Action & { turnId: number });
/** Explicit leave (docs/lexio-rules.md §5). A seated connection gets no reply; the server unbinds it and
 * revokes its credential, so the same connection may CREATE_ROOM or JOIN_ROOM next. Unbound: NOT_SEATED. */
export type LeaveRoom = { type: "LEAVE_ROOM" };
/** Sender identity is determined exclusively from the server-side connection binding. */
export type ChatRequest = { type: "CHAT"; text: string };
export type Request = Command | LeaveRoom;
export type ClientRequest = Request | ChatRequest;
export type PublicSeat = Readonly<{
  remainingTileCount: number;
  chips: number;
  isOut: boolean;
  isConnected: boolean;
  // Present only when the occupant set a name; clients then show it instead of seatLabel(seatId).
  name?: string;
}>;
// name is the seat's name when the game ended, omitted for an unnamed seat.
export type LastGameRankingRow = RankingRow & {
  readonly chips: number;
  readonly name?: string;
};
/** Confirmed chips in the finished game. The server preserves its join order within ties;
 * the current lobby may have different occupants. The leaver alone occupies the last place. */
export type LastGameResult = Readonly<{
  reason: "ABANDONMENT";
  leaverSeatId: SeatId;
  ranking: readonly LastGameRankingRow[];
}>;
type TableFields = Readonly<{
  slots: Slots<PublicSeat>;
  seatOrder: readonly SeatId[];
  // [] in LOBBY; otherwise join order without OUT seats, including immediately after payment in ROUND_SETTLEMENT.
  activePlayers: readonly SeatId[];
  consecutivePasses: number;
  maxRounds: number;
  turnLimitSeconds?: TurnLimitSeconds;
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
          // Omit in a fresh room and from the next successful start.
          lastGameResult?: LastGameResult;
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
export type ChatMessage = { type: "CHAT"; seatId: SeatId; text: string };
export type ChatError = { type: "CHAT_ERROR"; code: ChatErrorCode };
export type ServerMessage = Message | ChatMessage | ChatError;

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
function named(v: Record<string, unknown>): boolean {
  return !Object.hasOwn(v, "name") || isPlayerName(v.name);
}
function request(v: unknown): v is Request {
  if (!record(v)) return false;
  switch (v.type) {
    case "CREATE_ROOM":
      return (
        onlyKeys(v, ["type", "name", "turnLimitSeconds", "maxRounds"]) &&
        named(v) &&
        (!Object.hasOwn(v, "turnLimitSeconds") ||
          isTurnLimitSeconds(v.turnLimitSeconds)) &&
        (!Object.hasOwn(v, "maxRounds") || isMaxRounds(v.maxRounds))
      );
    case "START_GAME":
    case "LEAVE_ROOM":
      return onlyKeys(v, ["type"]);
    case "JOIN_ROOM":
      return (
        onlyKeys(v, ["type", "roomCode", "name"]) &&
        isRoomCode(v.roomCode) &&
        named(v)
      );
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
/** Text JSON with exact keys, canonical names and 0–13 tiles. Ownership, duplicates, count and hand strength belong to the rules. */
export function decodeRequest(frame: unknown): Request | "INVALID_MESSAGE" {
  const v = read(frame);
  return request(v) ? v : "INVALID_MESSAGE";
}
/** Room services accept legacy requests plus a CHAT carrying only validated text. */
export function decodeClientRequest(
  frame: unknown,
): ClientRequest | "INVALID_MESSAGE" {
  const v = read(frame);
  if (
    record(v) &&
    v.type === "CHAT" &&
    onlyKeys(v, ["type", "text"]) &&
    isChatText(v.text)
  )
    return { type: "CHAT", text: v.text };
  return request(v) ? v : "INVALID_MESSAGE";
}
/** Legacy commands exclude LEAVE_ROOM and CHAT. */
export function decodeCommand(frame: unknown): Command | "INVALID_MESSAGE" {
  const r = decodeRequest(frame);
  return r !== "INVALID_MESSAGE" && r.type === "LEAVE_ROOM"
    ? "INVALID_MESSAGE"
    : r;
}

/** Decode a separate chat delivery or sender-only rate error from text JSON.
 * On null the client falls back to decodeServerMessage for legacy frames. */
export function decodeChatMessage(
  frame: unknown,
): ChatMessage | ChatError | null {
  const v = read(frame);
  if (!record(v)) return null;
  if (
    v.type === "CHAT" &&
    onlyKeys(v, ["type", "seatId", "text"]) &&
    seat(v.seatId) &&
    isChatText(v.text)
  )
    return { type: "CHAT", seatId: v.seatId, text: v.text };
  if (
    v.type === "CHAT_ERROR" &&
    onlyKeys(v, ["type", "code"]) &&
    isChatErrorCode(v.code)
  )
    return { type: "CHAT_ERROR", code: v.code };
  return null;
}

function publicSeat(v: unknown): v is PublicSeat {
  return (
    shape(v, ["remainingTileCount", "chips", "isOut", "isConnected", "name"]) &&
    named(v) &&
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
function lastGameResult(v: unknown): v is LastGameResult {
  if (
    !shape(v, ["reason", "leaverSeatId", "ranking"]) ||
    v.reason !== "ABANDONMENT" ||
    !seat(v.leaverSeatId) ||
    !Array.isArray(v.ranking) ||
    !integer(v.ranking.length, 3, 5)
  )
    return false;
  const seen = new Set<SeatId>();
  let previousChips = Infinity;
  let previousRank = 0;
  for (const [i, row] of v.ranking.entries()) {
    if (
      !shape(row, ["seatId", "rank", "chips", "name"]) ||
      !named(row) ||
      !seat(row.seatId) ||
      seen.has(row.seatId) ||
      !integer(row.chips)
    )
      return false;
    const place = i + 1;
    if (place === v.ranking.length)
      return row.seatId === v.leaverSeatId && row.rank === place;
    if (row.chips > previousChips) return false;
    if (row.chips !== previousChips) previousRank = place;
    if (row.rank !== previousRank) return false;
    previousChips = row.chips;
    seen.add(row.seatId);
  }
  return false;
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
  "turnLimitSeconds",
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
    (Object.hasOwn(v, "turnLimitSeconds") &&
      !isTurnLimitSeconds(v.turnLimitSeconds)) ||
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
      ...(lobby ? ["hostSeatId", "canStart", "lastGameResult"] : []),
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
      (!Object.hasOwn(v, "lastGameResult") ||
        lastGameResult(v.lastGameResult)) &&
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
