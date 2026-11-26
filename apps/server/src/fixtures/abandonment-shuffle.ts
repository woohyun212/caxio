import type { Tile } from "@caxio/shared/contracts/domain";
import { abandonmentRestart } from "@caxio/shared/contracts/fixtures";

// Reverse each Fisher–Yates deal from its required deck order.
export function abandonmentShuffle() {
  const hands = abandonmentRestart.firstActive.map(({ frame }) => {
    if (!frame.view.ownHand) throw Error("Missing fixture hand");
    return frame.view.ownHand;
  });
  const draws: number[] = [];
  for (const order of [
    [0, 1, 2, 3],
    [1, 0, 2, 3],
    [1, 2, 3, 0],
  ]) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const target = order.flatMap((seat) => {
      const hand = hands[seat];
      if (!hand) throw Error("Missing fixture seat");
      return hand.map((t: Tile) => 4 * (t.number - 1) + t.suit);
    });
    for (let end = 51; end > 0; end--) {
      const wanted = target[end],
        last = deck[end];
      if (wanted === undefined || last === undefined)
        throw Error("Missing tile");
      const i = deck.indexOf(wanted);
      if (i < 0 || i > end) throw Error("Invalid deal");
      draws.push((i + 0.5) / (end + 1));
      deck[end] = wanted;
      deck[i] = last;
    }
  }
  let i = 0;
  return () => draws[i++] ?? 0.5;
}
