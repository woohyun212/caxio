import type { PlayerView } from "@caxio/shared/contracts/wire";

import type { ClientModel } from "../contracts";

// A settlement and the next deal can both arrive before React renders.
const counts = new WeakMap<PlayerView, readonly (number | undefined)[]>();
export function settlementCounts(view: PlayerView) {
  if (
    (view.phase === "ROUND_SETTLEMENT" || view.phase === "GAME_OVER") &&
    view.lastSettlement?.round === view.round
  )
    return view.slots.map((slot) => slot?.remainingTileCount);
  return counts.get(view);
}
export function rememberSettlement() {
  let saved:
    | { token: string; round: number; counts: readonly (number | undefined)[] }
    | undefined;
  return ({ view, credential }: ClientModel) => {
    if (!credential || (saved && saved.token !== credential.token))
      saved = undefined;
    if (!view || !credential) return;
    const round = view.lastSettlement?.round;
    if (saved?.round !== round) saved = undefined;
    if (round === undefined) return;
    if (view.phase === "ROUND_SETTLEMENT" || view.phase === "GAME_OVER") {
      const observed = settlementCounts(view);
      if (observed)
        saved = { token: credential.token, round, counts: observed };
    } else if (saved) counts.set(view, saved.counts);
  };
}
