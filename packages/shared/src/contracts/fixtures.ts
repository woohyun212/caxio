import type {
  GameState,
  PreviewResult,
  SeatId,
  Slots,
  Suit,
  Tile,
} from "./domain";
import type {
  Command,
  ErrorCode,
  PlayerView,
  PublicSeat,
  Seated,
  Snapshot,
} from "./wire";

export const roomCode = "ABCD23";
export const epoch = 1800000000000;
const suits: readonly Suit[] = [0, 1, 2, 3];
const deck = Array.from({ length: 9 }, (_, i) =>
  suits.map((suit) => ({ number: i + 1, suit })),
).flat();
const tile = (number: number, suit: Suit): Tile => ({ number, suit });
export const normalCommands: readonly Command[] = [
  { type: "CREATE_ROOM" },
  { type: "JOIN_ROOM", roomCode },
  { type: "RESUME", roomCode, token: "fixture-A" },
  { type: "START_GAME" },
  { type: "PLAY", turnId: 1, tiles: [tile(3, 0)] },
  { type: "PASS", turnId: 2 },
];
export const roomCodeExamples = {
  valid: [roomCode, "ZZZZ99", "222222", "HJKL89"],
  normalize: [" abcd23 ", "abcd23", "AbCd23"],
  invalid: [
    "",
    "ABCDE",
    "ABCDEFG",
    "ABCDI2",
    "ABCDO2",
    "ABCD02",
    "ABCD12",
    "ABCDＡ2",
    "ABCD한2",
    null,
    123456,
    {},
    [],
  ],
};
const tablePair = [tile(4, 1), tile(4, 3)];
export const previewExamples = [
  {
    selected: [tile(7, 0), tile(7, 2)],
    tableHand: tablePair,
    maxNumber: 9,
    result: { ok: true, kind: "PAIR", representative: tile(7, 2) },
  },
  {
    selected: suits.map((s) => tile(7, s)),
    tableHand: tablePair,
    maxNumber: 9,
    result: { ok: false, reason: "COUNT" },
  },
  {
    selected: [tile(3, 0), tile(3, 2)],
    tableHand: tablePair,
    maxNumber: 9,
    result: { ok: false, reason: "NOT_HIGHER" },
  },
] as const satisfies readonly {
  selected: readonly Tile[];
  tableHand: readonly Tile[];
  maxNumber: 9;
  result: PreviewResult;
}[];

export const representativeExamples = [
  {
    selected: [tile(3, 0), tile(3, 1), tile(3, 2)],
    tableHand: null,
    maxNumber: 9,
    result: { ok: true, kind: "TRIPLE", representative: 3 },
  },
  {
    selected: [tile(1, 0), tile(2, 1), tile(3, 2), tile(4, 3), tile(5, 0)],
    tableHand: null,
    maxNumber: 9,
    result: { ok: true, kind: "STRAIGHT", representative: tile(2, 1) },
  },
] as const satisfies readonly {
  selected: readonly Tile[];
  tableHand: null;
  maxNumber: 9;
  result: PreviewResult;
}[];

function slot(
  remainingTileCount = 0,
  chips = 64,
  isConnected = true,
  isOut = false,
): PublicSeat {
  return { remainingTileCount, chips, isConnected, isOut };
}
function seated<S extends SeatId>(
  seatId: S,
  name: string,
  code = roomCode,
): Seated & { seatId: S } {
  return { type: "SEATED", seatId, roomCode: code, token: `fixture-${name}` };
}
function lobby(
  seatOrder: readonly SeatId[],
  own: SeatId,
  offline: readonly SeatId[] = [],
): PlayerView {
  const at = (id: SeatId) =>
    seatOrder.includes(id) ? slot(0, 64, !offline.includes(id)) : null;
  return {
    phase: "LOBBY",
    round: 0,
    maxRounds: 5,
    maxNumber: null,
    seatOrder,
    slots: [at(0), at(1), at(2), at(3), at(4)],
    hostSeatId: seatOrder[0] ?? null,
    canStart:
      seatOrder[0] === own && seatOrder.length >= 3 && offline.length === 0,
    currentTurn: null,
    turnId: null,
    deadline: null,
    activePlayers: [],
    consecutivePasses: 0,
    ranking: [],
    tableHand: null,
    lastAction: null,
    lastPlay: null,
    lastSettlement: null,
    ownHand: [],
  };
}
function snap(
  view: PlayerView,
  revision: number,
  serverNow = epoch + revision,
): Snapshot {
  return { type: "SNAPSHOT", revision, serverNow, view };
}
function error(code: ErrorCode) {
  return { type: "ERROR", code } as const;
}
const order = [0, 1, 2] as const;
const dealtDeck = deck.map((t) =>
  t.suit === 0 && t.number === 9
    ? tile(1, 1)
    : t.suit === 1 && t.number === 1
      ? tile(9, 0)
      : t,
);
const initialHands = [
  dealtDeck.slice(0, 12),
  dealtDeck.slice(12, 24),
  dealtDeck.slice(24),
] as const;
const player = (hand: readonly Tile[]) => ({
  hand,
  chips: 64,
  isOut: false,
  eliminatedRound: null,
  eliminatedEffectiveTiles: null,
});
const start = {
  phase: "ROUND_START",
  round: 1,
  maxRounds: 5,
  maxNumber: 9,
  currentTurn: 0,
  seatOrder: order,
  activePlayers: order,
  slots: [slot(12), slot(12), slot(12), null, null],
  ranking: [],
  turnId: null,
  deadline: null,
  tableHand: null,
  lastPlay: null,
  lastAction: null,
  lastSettlement: null,
  consecutivePasses: 0,
  ownHand: initialHands[0],
} as const satisfies PlayerView;
const active = {
  ...start,
  phase: "TURN_ACTIVE",
  turnId: 1,
  deadline: epoch + 30000,
} as const;
const lastTile = tile(1, 0);
const penultimate = { turnId: 60, seatId: 0, tiles: [tile(9, 0)] } as const;
const beforeClear = {
  ...active,
  slots: [slot(1), slot(1), slot(2), null, null],
  ownHand: [lastTile],
  turnId: 61,
  currentTurn: 1,
  deadline: epoch + 60000,
  tableHand: penultimate.tiles,
  lastPlay: penultimate,
  lastAction: { type: "PLAY", automatic: false, turnId: 60, seatId: 0 },
} as const;
const passed = {
  ...beforeClear,
  currentTurn: 2,
  turnId: 62,
  deadline: epoch + 61000,
  consecutivePasses: 1,
  lastAction: { type: "PASS", turnId: 61, seatId: 1, automatic: false },
} as const;
const cleared = {
  ...passed,
  currentTurn: 0,
  turnId: 63,
  deadline: epoch + 62000,
  consecutivePasses: 0,
  tableHand: null,
  lastAction: { type: "PASS", turnId: 62, seatId: 2, automatic: false },
} as const;
const lastPlay = { turnId: 63, seatId: 0, tiles: [lastTile] } as const;
export const a4Settlement = {
  round: 1,
  results: [
    { rank: 1, seatId: 0, chipChange: 3 },
    { rank: 2, seatId: 1, chipChange: 0 },
    { rank: 3, seatId: 2, chipChange: -3 },
  ],
  details: [
    { round: 1, remaining: 0, twos: 0, effective: 0 },
    { round: 1, remaining: 1, twos: 0, effective: 1 },
    { round: 1, remaining: 2, twos: 0, effective: 2 },
    null,
    null,
  ],
  payments: [
    { from: 1, to: 0, amount: 1 },
    { from: 2, to: 0, amount: 2 },
    { from: 2, to: 1, amount: 1 },
  ],
} as const;
const summary = { round: 1, results: a4Settlement.results };
const paid = {
  ...cleared,
  phase: "ROUND_SETTLEMENT",
  currentTurn: null,
  turnId: null,
  deadline: null,
  lastPlay,
  lastAction: { type: "PLAY", automatic: false, turnId: 63, seatId: 0 },
  tableHand: lastPlay.tiles,
  lastSettlement: summary,
  ownHand: [],
  ownSettlement: a4Settlement.details[0],
  slots: [slot(0, 67), slot(1, 64), slot(2, 61), null, null],
} as const;
const next = {
  ...start,
  round: 2,
  slots: [slot(12, 67), slot(12, 64), slot(12, 61), null, null],
  lastSettlement: summary,
  ownSettlement: a4Settlement.details[0],
} as const;
const ranking = [
  { seatId: 0, rank: 1 },
  { seatId: 1, rank: 2 },
  { seatId: 2, rank: 3 },
] as const;
const ended = { ...paid, maxRounds: 1, phase: "GAME_OVER", ranking } as const;
export const firstDealState = {
  phase: "ROUND_START",
  round: 1,
  maxRounds: 5,
  maxNumber: 9,
  seatOrder: order,
  activePlayers: order,
  players: [
    player(initialHands[0]),
    player(initialHands[1]),
    player(initialHands[2]),
    null,
    null,
  ],
  roundLeader: 0,
  currentTurn: 0,
  lastPlayedBy: 0,
  turnId: 0,
  consecutivePasses: 0,
  tableHand: null,
  lastAction: null,
  lastPlay: null,
  lastSettlement: null,
  ranking: [],
} as const satisfies GameState;
export const settledState = {
  ...firstDealState,
  phase: "ROUND_SETTLEMENT",
  players: [
    { ...player([]), chips: 67 },
    player([tile(4, 0)]),
    { ...player([tile(7, 0), tile(8, 2)]), chips: 61 },
    null,
    null,
  ],
  currentTurn: null,
  turnId: lastPlay.turnId,
  tableHand: lastPlay.tiles,
  lastPlay,
  lastAction: { type: "PLAY", automatic: false, turnId: 63, seatId: 0 },
  lastSettlement: a4Settlement,
} as const satisfies GameState;
export const gameOverState = {
  ...settledState,
  maxRounds: 1,
  phase: "GAME_OVER",
  ranking,
} as const satisfies GameState;
export const lastPlaySequence = {
  recipient: 0,
  continuing: [
    snap(beforeClear, 61),
    snap(passed, 62),
    snap(cleared, 63),
    snap(paid, 64),
    snap(next, 65),
  ],
  ending: [
    snap({ ...cleared, maxRounds: 1 }, 63),
    snap({ ...paid, maxRounds: 1 }, 64),
    snap(ended, 65),
  ],
} as const;
// Effects for a new socket observing continuing[] in order. A repeated revision stays silent.
export const effectBatches = [
  [],
  [],
  [],
  [
    { type: "PLAY", turnId: 63 },
    { type: "SETTLEMENT", round: 1 },
  ],
  [],
] as const;
export const phaseExamples = [
  snap(lobby(order, 0), 3),
  snap(start, 4),
  snap(active, 5),
  snap(paid, 64),
  snap(ended, 65),
] as const;
const current = snap(lobby(order, 0), 3);
export const seatedRejections = (
  [{ type: "CREATE_ROOM" }, { type: "JOIN_ROOM", roomCode: "WXYZ89" }] as const
).map((command) => ({
  recipient: 0,
  before: current,
  command,
  response: error("INVALID_PHASE"),
  after: current,
}));
const fresh = seated(0, "new", "WXYZ89");
export const newRoomSequence = {
  finished: snap(ended, 65),
  previous: seated(0, "A"),
  command: { type: "CREATE_ROOM" },
  connection: "new",
  response: fresh,
  lobby: snap(lobby([0], 0), 1),
  resume: { type: "RESUME", roomCode: fresh.roomCode, token: fresh.token },
  storedBefore: { roomCode, token: "fixture-A" },
  storedAfter: { roomCode: fresh.roomCode, token: fresh.token },
  clearOn: [error("RESUME_DENIED"), error("ROOM_NOT_FOUND")],
  storedAfterDenial: null,
} as const;

const occupants = {
  A: seated(0, "A"),
  B: seated(1, "B"),
  C: seated(2, "C"),
  D: seated(3, "D"),
  E: seated(1, "E"),
};
const fixed = [2, 3, 1] as const;
const hands = [
  null,
  initialHands[2],
  initialHands[0],
  initialHands[1],
  null,
] as const satisfies Slots<readonly Tile[]>;
const reusedStart = {
  ...start,
  seatOrder: fixed,
  activePlayers: fixed,
  currentTurn: 2,
  slots: [null, slot(12), slot(12), slot(12), null],
} as const;
export const seatReuse = {
  credentials: occupants,
  joins: [
    snap(lobby([0], 0), 1),
    snap(lobby([0, 1], 0), 2),
    snap(lobby([0, 1, 2], 0), 3),
    snap(lobby([0, 1, 2, 3], 0), 4),
  ],
  bDisconnected: snap(lobby([0, 1, 2, 3], 0, [1]), 5, epoch + 10),
  reservedStart: {
    request: { type: "START_GAME" },
    from: "A",
    reply: error("NOT_READY"),
    deals: 0,
  },
  bReturned: snap(lobby([0, 2, 3], 0), 6, epoch + 30010),
  eJoined: snap(lobby([0, 2, 3, 1], 0), 7, epoch + 30011),
  aDisconnected: snap(lobby([0, 2, 3, 1], 2, [0]), 8, epoch + 30012),
  aReturned: snap(lobby(fixed, 2), 9, epoch + 60012),
  startCommand: { type: "START_GAME" },
  startAttempts: [
    { from: "D", reply: error("NOT_HOST"), deals: 0 },
    { from: "E", reply: error("NOT_HOST"), deals: 0 },
    { from: "C", deals: 1 },
  ],
  hands,
  started: fixed.map((id) => ({
    recipient: id,
    frame: snap({ ...reusedStart, ownHand: hands[id] }, 10, epoch + 60013),
  })),
  revoked: [occupants.A, occupants.B].map((c) => ({
    command: { type: "RESUME" as const, roomCode, token: c.token },
    reply: error("RESUME_DENIED"),
  })),
} as const;

const leadCommand = { type: "PLAY", turnId: 1, tiles: [tile(3, 0)] } as const;
const playResponse = (automatic: boolean, now: number) =>
  snap(
    {
      ...active,
      currentTurn: 1,
      turnId: 2,
      deadline: now + 30000,
      lastPlay: {
        turnId: 1,
        seatId: 0,
        tiles: leadCommand.tiles,
      },
      tableHand: leadCommand.tiles,
      lastAction: { type: "PLAY", turnId: 1, seatId: 0, automatic },
      slots: [slot(11), slot(12), slot(12), null, null],
      ownHand: initialHands[0].filter((t) => t.number !== 3 || t.suit !== 0),
    },
    6,
    now,
  );
export const deadlines = {
  before: snap(active, 5),
  presence: snap(
    { ...active, slots: [slot(12), slot(12, 64, false), slot(12), null, null] },
    6,
  ),
  cases: [-1, 0, 1].map((offset) => {
    const now = active.deadline + offset;
    return {
      now,
      command: leadCommand,
      manual: offset < 0 ? 1 : 0,
      automatic: offset < 0 ? 0 : 1,
      reply: offset < 0 ? null : error("TIME_EXPIRED"),
      after: playResponse(offset >= 0, now),
    };
  }),
  stale: {
    before: playResponse(false, active.deadline - 1),
    command: leadCommand,
    reply: error("STALE_TURN"),
    after: playResponse(false, active.deadline - 1),
  },
} as const;

const sameSeat = occupants.C;

export const lostResume = {
  recipient: sameSeat.seatId,
  credential: sameSeat,
  command: { type: "RESUME", roomCode, token: sameSeat.token },
  lost: sameSeat,
  retry: { type: "RESUME", roomCode, token: sameSeat.token },
  received: sameSeat,
  originalHand: hands[2],
  snapshot: snap(
    {
      ...reusedStart,
      phase: "TURN_ACTIVE",
      turnId: 1,
      deadline: epoch + 90013,
      ownHand: initialHands[0],
    },
    13,
    epoch + 60016,
  ),
  replaced: { command: leadCommand, accepted: 0, closePresenceChanges: 0 },
  returned: {
    command: { type: "RESUME", roomCode, token: occupants.B.token },
    reply: error("RESUME_DENIED"),
  },
} as const;

// Four players start at 64. D owes 8 × 2³ and pays its entire balance to A.
const outOrder = [0, 1, 2, 3] as const;
const outSummary = {
  round: 1,
  results: [
    { rank: 1, seatId: 0, chipChange: 67 },
    { rank: 2, seatId: 1, chipChange: 0 },
    { rank: 3, seatId: 2, chipChange: -3 },
    { rank: 4, seatId: 3, chipChange: -64 },
  ],
} as const;
const outPaid = {
  phase: "ROUND_SETTLEMENT",
  round: 1,
  maxRounds: 2,
  maxNumber: 13,
  currentTurn: null,
  turnId: null,
  deadline: null,
  ranking: [],
  activePlayers: order,
  seatOrder: outOrder,
  slots: [slot(0, 131), slot(1), slot(2, 61), slot(8, 0, true, true), null],
  consecutivePasses: 0,
  tableHand: lastPlay.tiles,
  lastPlay,
  lastAction: paid.lastAction,
  lastSettlement: outSummary,
} as const;
const following = {
  ...outPaid,
  phase: "ROUND_START",
  round: 2,
  maxNumber: 9,
  currentTurn: 0,
  lastPlay: null,
  lastAction: null,
  tableHand: null,
  slots: [slot(12, 131), slot(12), slot(12, 61), slot(0, 0, true, true), null],
} as const;
const outFinalPlay = { ...lastPlay, turnId: 125 };
const outFinal = {
  ...outPaid,
  round: 2,
  maxNumber: 9,
  phase: "GAME_OVER",
  lastPlay: outFinalPlay,
  lastAction: { ...paid.lastAction, turnId: 125 },
  slots: [slot(0, 134), slot(1), slot(2, 58), slot(0, 0, true, true), null],
  lastSettlement: { ...summary, round: 2 },
  ranking: [...ranking, { seatId: 3, rank: 4 }],
} as const;
export const spectatorExamples = {
  recipient: 3,
  transition: snap(outPaid, 70),
  following: snap(following, 71),
  resume: occupants.D,
  restored: snap(
    { ...following, phase: "TURN_ACTIVE", turnId: 64, deadline: epoch + 30071 },
    74,
  ),
  gameOver: snap(outFinal, 140),
  survivor: {
    recipient: 1,
    frame: snap(
      {
        ...outPaid,
        ownHand: [tile(7, 0)],
        ownSettlement: a4Settlement.details[1],
      },
      70,
    ),
  },
} as const;
const triggers = [
  ["ROOM_NOT_FOUND", { type: "JOIN_ROOM", roomCode: "ZZZZ99" }, "unknown room"],
  [
    "ROOM_FULL",
    { type: "JOIN_ROOM", roomCode },
    "all five lobby slots occupied",
  ],
  ["GAME_STARTED", { type: "JOIN_ROOM", roomCode }, "known active room"],
  [
    "RESUME_DENIED",
    { type: "RESUME", roomCode, token: "revoked" },
    "returned seat",
  ],
  ["NOT_SEATED", { type: "START_GAME" }, "unbound socket"],
  ["NOT_HOST", { type: "START_GAME" }, "lobby guest"],
  ["NOT_READY", { type: "START_GAME" }, "host while a slot is reserved"],
  ["INVALID_PHASE", { type: "CREATE_ROOM" }, "bound socket"],
] as const satisfies readonly (readonly [ErrorCode, unknown, string])[];
const roomErrors = triggers.map(([code, command, when]) => ({
  command,
  when,
  reply: error(code),
}));
export const turnValidationOrder = [
  "STALE_TURN",
  "TIME_EXPIRED",
  "NOT_YOUR_TURN",
  "NOT_OWNED",
  "DUPLICATE_TILE",
  "ILLEGAL_HAND",
  "WRONG_COUNT",
  "NOT_HIGHER",
] as const;
export const previewRejectionOrder = [
  "EMPTY",
  "COUNT",
  "ILLEGAL_HAND",
  "WRONG_COUNT",
  "NOT_HIGHER",
] as const;

export const tiedRankingExample = snap(
  {
    ...ended,
    lastPlay: { ...lastPlay, seatId: 2 },
    lastAction: { ...paid.lastAction, seatId: 2 },
    slots: [slot(1, 65), slot(1, 65), slot(0, 62), null, null],
    ownHand: [tile(6, 0)],
    ownSettlement: { round: 5, remaining: 1, twos: 0, effective: 1 },
    lastSettlement: {
      round: 5,
      results: [
        { seatId: 2, rank: 1, chipChange: 2 },
        { seatId: 0, rank: 2, chipChange: -1 },
        { seatId: 1, rank: 3, chipChange: -1 },
      ],
    },
    ranking: [
      { seatId: 0, rank: 1 },
      { seatId: 1, rank: 1 },
      { seatId: 2, rank: 3 },
    ],
    round: 5,
    maxRounds: 5,
  },
  150,
);

export const dealExamples = [
  snap(start, 4),
  snap(
    {
      ...start,
      maxNumber: 13,
      seatOrder: [0, 1, 2, 3],
      activePlayers: [0, 1, 2, 3],
      slots: [slot(13), slot(13), slot(13), slot(13), null],
      ownHand: deck.slice(0, 13),
    },
    5,
  ),
  snap(
    {
      ...start,
      maxNumber: 15,
      seatOrder: [0, 1, 2, 3, 4],
      activePlayers: [0, 1, 2, 3, 4],
      slots: [slot(12), slot(12), slot(12), slot(12), slot(12)],
      ownHand: deck.slice(0, 12),
    },
    6,
  ),
] as const;
const fewerSurvivors = {
  ...ended,
  maxRounds: 5,
  activePlayers: [0, 1],
  slots: [slot(0, 129), slot(1, 63), slot(8, 0, true, true), null, null],
  lastSettlement: {
    round: 1,
    results: [
      { seatId: 0, rank: 1, chipChange: 65 },
      { seatId: 1, rank: 2, chipChange: -1 },
      { seatId: 2, rank: 3, chipChange: -64 },
    ],
  },
} as const;
export const gameOverExamples = [
  { snapshot: snap(ended, 65), reason: "LAST_ROUND" },
  { snapshot: snap(fewerSurvivors, 65), reason: "FEWER_THAN_THREE" },
  {
    snapshot: snap({ ...fewerSurvivors, maxRounds: 1 }, 65),
    reason: "LAST_ROUND",
  },
] as const;

const followingFrame = deadlines.stale.before;
const follower = snap(
  { ...followingFrame.view, ownHand: initialHands[1] },
  6,
  followingFrame.serverNow,
);
const guest = snap({ ...active, ownHand: initialHands[1] }, 5);
export const turnErrorExamples = [
  {
    before: guest,
    recipient: 1,
    now: epoch + 100,
    command: leadCommand,
    reply: error("NOT_YOUR_TURN"),
  },
  {
    before: followingFrame,
    recipient: 0,
    now: active.deadline + 60000,
    command: leadCommand,
    reply: error("STALE_TURN"),
  },
  {
    before: guest,
    recipient: 1,
    now: active.deadline,
    command: leadCommand,
    reply: error("TIME_EXPIRED"),
  },
  {
    before: deadlines.before,
    recipient: 0,
    now: epoch + 100,
    command: { ...leadCommand, tiles: [tile(9, 3), tile(9, 3)] },
    reply: error("NOT_OWNED"),
  },
  {
    before: deadlines.before,
    recipient: 0,
    now: epoch + 100,
    command: { ...leadCommand, tiles: [tile(3, 0), tile(3, 0), tile(2, 0)] },
    reply: error("DUPLICATE_TILE"),
  },
  {
    // Rules §2: two different numbers are not a pair, before comparing the count to the table.
    before: follower,
    recipient: 1,
    now: followingFrame.serverNow,
    command: { ...leadCommand, turnId: 2, tiles: [tile(4, 0), tile(5, 0)] },
    reply: error("ILLEGAL_HAND"),
  },

  {
    before: follower,
    recipient: 1,
    now: follower.serverNow,
    command: { type: "PLAY", turnId: 2, tiles: [tile(4, 0), tile(4, 1)] },
    reply: error("WRONG_COUNT"),
  },
  // Rules §2: cloud 4 is weaker than cloud 9. At turn 61 seat 1 still holds one tile.
  {
    before: snap({ ...beforeClear, ownHand: [tile(4, 0)] }, 61),
    recipient: 1,
    now: epoch + 100,
    command: { type: "PLAY", turnId: 61, tiles: [tile(4, 0)] },
    reply: error("NOT_HIGHER"),
  },
  {
    before: deadlines.before,
    recipient: 0,
    now: epoch + 100,
    command: { type: "PASS", turnId: 1 },
    reply: error("LEAD_PASS"),
  },
] as const;
export const errorExamples = [
  ...roomErrors,
  ...turnErrorExamples,
  {
    command: { type: "JOIN_ROOM", roomCode: " abcd23 " },
    when: "noncanonical wire input",
    reply: error("INVALID_MESSAGE"),
  },
] as const;

export const phaseAndResumeErrors = [
  {
    before: phaseExamples[1],
    recipient: 0,
    now: phaseExamples[1].serverNow,
    command: { type: "PLAY", turnId: 1, tiles: [tile(3, 0)] },
    reply: error("INVALID_PHASE"),
  },
  {
    before: phaseExamples[3],
    recipient: 0,
    now: phaseExamples[3].serverNow,
    command: { type: "PASS", turnId: 63 },
    reply: error("INVALID_PHASE"),
  },
  {
    before: phaseExamples[4],
    recipient: 0,
    now: phaseExamples[4].serverNow,
    command: { type: "PLAY", turnId: 64, tiles: [lastTile] },
    reply: error("INVALID_PHASE"),
  },
  {
    before: phaseExamples[2],
    recipient: 0,
    now: phaseExamples[2].serverNow,
    command: { type: "START_GAME" },
    reply: error("INVALID_PHASE"),
  },
  {
    when: "room no longer exists",
    command: { type: "RESUME", roomCode: "ZZZZ99", token: "fixture-A" },
    reply: error("ROOM_NOT_FOUND"),
  },
] as const;
