export const TURN_LIMIT_SECONDS = [15, 30, 45, 60, 90] as const;
export const MAX_ROUNDS = [3, 5, 7, 10] as const;
export type TurnLimitSeconds = (typeof TURN_LIMIT_SECONDS)[number];
export type MaxRounds = (typeof MAX_ROUNDS)[number];
export const DEFAULT_TURN_LIMIT_SECONDS = 30 satisfies TurnLimitSeconds;
export const DEFAULT_MAX_ROUNDS = 5 satisfies MaxRounds;

export type RoomSettings = {
  turnLimitSeconds?: TurnLimitSeconds;
  maxRounds?: MaxRounds;
};

export function isTurnLimitSeconds(value: unknown): value is TurnLimitSeconds {
  return TURN_LIMIT_SECONDS.some((seconds) => seconds === value);
}
export function isMaxRounds(value: unknown): value is MaxRounds {
  return MAX_ROUNDS.some((rounds) => rounds === value);
}
