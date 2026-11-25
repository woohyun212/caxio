import type {
  Action,
  GameOverReason,
  GameState,
  HandKey,
  MaxNumber,
  RankingRow,
  SeatId,
  Tile,
  TileRank,
  TransitionResult,
} from "./domain";
export type Rng = () => number; // uniform [0,1), used only for shuffling
export type RankTile = (tile: Tile, maxNumber: MaxNumber) => TileRank;
export type Classify = (
  tiles: readonly Tile[],
  maxNumber: MaxNumber,
) => HandKey | null;
/** True iff challenger beats table, including the same-count requirement. */
export type Compare = (challenger: HandKey, table: HandKey) => boolean;
export interface HandRules {
  rankTile: RankTile;
  classify: Classify;
  compare: Compare;
}
/** Pay once, attach the ordered settlement, update balances and remove OUT from activePlayers. */
export type Settle = (state: GameState) => GameState;
export type Rank = (state: GameState) => readonly RankingRow[];
/** After settlement, check last round before survivor count. */
export type IsGameOver = (state: GameState) => false | GameOverReason;
export interface SettlementRules {
  settle: Settle;
  rank: Rank;
  isGameOver: IsGameOver;
}
export const INITIAL_CHIPS = 64;
export const DEFAULT_MAX_ROUNDS = 5;
/** First deal for 3–5 distinct seats in join order. Round 1 starts at 64 chips each, default five rounds. */
export type StartRound = (
  seatOrder: readonly SeatId[],
  rng: Rng,
  maxRounds?: number,
) => GameState;
/** Winning PLAY returns a paid ROUND_SETTLEMENT for broadcast before advance. */
export type ApplyTurn = (
  state: GameState,
  seat: SeatId,
  action: Action,
  automatic?: boolean,
) => TransitionResult;
export type TimeoutAction = (state: GameState) => Action;
/** ROUND_START opens the lead turn. Only advance deals subsequent rounds, after the nonterminal settlement. */
export type Advance = (state: GameState, rng: Rng) => GameState;
export interface RoundRules {
  startRound: StartRound;
  applyTurn: ApplyTurn;
  timeoutAction: TimeoutAction;
  advance: Advance;
}
export type CreateRoundRules = (
  hands: HandRules,
  settlement: SettlementRules,
) => RoundRules;
export interface RulesApi extends HandRules, SettlementRules, RoundRules {}
