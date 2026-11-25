export type SeatId = 0 | 1 | 2 | 3 | 4;
export type Suit = 0 | 1 | 2 | 3;
export type MaxNumber = 9 | 13 | 15;
export type Tile = Readonly<{ number: number; suit: Suit }>;
export type Slots<T> = readonly [
  T | null,
  T | null,
  T | null,
  T | null,
  T | null,
];
export type Phase =
  | "LOBBY"
  | "ROUND_START"
  | "TURN_ACTIVE"
  | "ROUND_SETTLEMENT"
  | "GAME_OVER";
export type HandKind =
  | "SINGLE"
  | "PAIR"
  | "TRIPLE"
  | "STRAIGHT"
  | "FLUSH"
  | "FULL_HOUSE"
  | "FOUR_OF_A_KIND"
  | "STRAIGHT_FLUSH";
export type TileRank = Readonly<{ numRank: number; suitRank: Suit }>;
type Hand<
  K extends HandKind,
  C extends number,
  R extends Tile | number,
> = Readonly<{ kind: K; count: C; representative: R; key: readonly number[] }>;
/** The key orders equal-size hands lexicographically, with made tier first.
 * The display representative is the single tile or the higher-suit tile of a pair.
 * Triple, full house and four of a kind use the body's Tile.number.
 * Straight, flush and straight flush use the highest-numRank tile (the 2 in 1-2-3-4-5). See visual-spec §4.
 */
export type HandKey =
  | Hand<"SINGLE", 1, Tile>
  | Hand<"PAIR", 2, Tile>
  | Hand<"TRIPLE", 3, number>
  | Hand<"STRAIGHT" | "FLUSH" | "STRAIGHT_FLUSH", 5, Tile>
  | Hand<"FULL_HOUSE" | "FOUR_OF_A_KIND", 5, number>;
export type PreviewResult =
  | { ok: true; kind: HandKind; representative: Tile | number }
  | {
      ok: false;
      reason: "EMPTY" | "COUNT" | "ILLEGAL_HAND" | "WRONG_COUNT" | "NOT_HIGHER";
    };
export type Preview = (
  selected: readonly Tile[],
  tableHand: readonly Tile[] | null,
  maxNumber: MaxNumber,
) => PreviewResult;

export type Action =
  | { type: "PASS" }
  | { type: "PLAY"; tiles: readonly Tile[] };
export type LastAction = Readonly<{
  turnId: number;
  seatId: SeatId;
  type: Action["type"];
  automatic: boolean;
}>;
export type LastPlay = Readonly<{
  turnId: number;
  seatId: SeatId;
  tiles: readonly Tile[];
}>;
export type RankingRow = Readonly<{ seatId: SeatId; rank: number }>;
/** Unique payment rank 1..M by effective count, remaining count, then turn order from roundLeader. */
export type SettlementRow = RankingRow & { readonly chipChange: number };
export type LastSettlement = Readonly<{
  round: number;
  results: readonly SettlementRow[];
}>;
export type OwnSettlement = Readonly<{
  round: number;
  remaining: number;
  twos: number;
  effective: number;
}>;
export type Payment = Readonly<{ from: SeatId; to: SeatId; amount: number }>;
export type Settlement = LastSettlement &
  Readonly<{ details: Slots<OwnSettlement>; payments: readonly Payment[] }>;
export type PlayerState = Readonly<{
  hand: readonly Tile[];
  chips: number;
  isOut: boolean;
  eliminatedRound: number | null;
  eliminatedEffectiveTiles: number | null;
}>;
export type GameState = Readonly<{
  phase: Phase;
  round: number;
  maxRounds: number;
  maxNumber: MaxNumber | null;
  players: Slots<PlayerState>;
  seatOrder: readonly SeatId[];
  activePlayers: readonly SeatId[];
  roundLeader: SeatId | null;
  currentTurn: SeatId | null;
  lastPlayedBy: SeatId | null;
  // Numeric in every phase: 0 in the first ROUND_START, increment when opening each TURN_ACTIVE.
  // Room projection nulls turnId/deadline outside TURN_ACTIVE, projects settlement, and copies other same-named public fields.
  turnId: number;
  consecutivePasses: number;
  tableHand: readonly Tile[] | null;
  lastAction: LastAction | null;
  lastPlay: LastPlay | null;
  lastSettlement: Settlement | null;
  ranking: readonly RankingRow[];
}>;
export type TurnError =
  | "INVALID_PHASE"
  | "NOT_YOUR_TURN"
  | "NOT_OWNED"
  | "DUPLICATE_TILE"
  | "ILLEGAL_HAND"
  | "WRONG_COUNT"
  | "NOT_HIGHER"
  | "LEAD_PASS";
/** Failure returns the input state unchanged; success returns the new authoritative state. */
export type TransitionResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; code: TurnError };
export type GameOverReason = "LAST_ROUND" | "FEWER_THAN_THREE";
