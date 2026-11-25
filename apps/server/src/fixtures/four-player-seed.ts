import type { Rng } from "@caxio/shared/contracts/engine";

export const seed = 2;
export function makeRandom(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
