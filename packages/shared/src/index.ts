import type { RulesApi } from "./contracts/engine";
import { classify, compare, rankTile } from "./hands";
import { createRoundRules } from "./round";
import { isGameOver, rank, settle } from "./settlement";

export { classify, compare, isGameOver, rank, rankTile, settle };

const hands = { rankTile, classify, compare };
const settlement = { settle, rank, isGameOver };
const round = createRoundRules(hands, settlement);
export const { startRound, applyTurn, timeoutAction, advance } = round;
export const rules: RulesApi = { ...hands, ...settlement, ...round };
