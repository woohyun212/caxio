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
/** Settle independently of phase. Change only chips, isOut, eliminatedRound, eliminatedEffectiveTiles,
 * activePlayers and lastSettlement; preserve hands and phase. */
export type Settle = (state: GameState) => GameState;
/** Without a leaver, use normal game-over ranking. For abandonment, include every seat in
 * state.seatOrder (including OUT). Order the others by confirmed chips descending with
 * competition ranks (1, 1, 3) and display ties in state.seatOrder. Append the leaver with
 * sole rank N = row count regardless of chips. Ignore isOut, E and elimination round. */
export type Rank = (
  state: GameState,
  leaverSeatId?: SeatId,
) => readonly RankingRow[];
/** After settlement, check last round before survivor count. */
export type IsGameOver = (state: GameState) => false | GameOverReason;
export interface SettlementRules {
  settle: Settle;
  rank: Rank;
  isGameOver: IsGameOver;
}
export const INITIAL_CHIPS = 64;
export { DEFAULT_MAX_ROUNDS } from "./settings";
/** First deal for 3–5 distinct seats in join order. Round 1 starts at 64 chips each, default five rounds.
 * startRound takes no turn-id seed and always returns turnId: 0. For a later game in the same room,
 * the room sets turnId on the returned state to its last issued id before the first commit.
 * advance then opens the first turn at that id plus one. */
export type StartRound = (
  seatOrder: readonly SeatId[],
  rng: Rng,
  maxRounds?: number,
) => GameState;
/** Winning PLAY records lastPlay, lastAction and tableHand, sets ROUND_SETTLEMENT and currentTurn=null, then returns settle(state). */
export type ApplyTurn = (
  state: GameState,
  seat: SeatId,
  action: Action,
  automatic?: boolean,
) => TransitionResult;
export type TimeoutAction = (state: GameState) => Action;
/** ROUND_START opens the lead turn. From settlement, a game-over reason sets GAME_OVER and ranking=rank(state),
 * preserving hands, tableHand, lastPlay, lastAction and currentTurn=null. Otherwise deal ROUND_START, clear those
 * three play records, reset consecutivePasses to 0, empty OUT hands and keep lastSettlement. */
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
