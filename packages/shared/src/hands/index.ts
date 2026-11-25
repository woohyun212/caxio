import type { MaxNumber, Tile } from "../contracts/domain";
import type { Classify, Compare, RankTile } from "../contracts/engine";

function validTile(tile: Tile, max: MaxNumber): boolean {
  return (
    Number.isInteger(tile?.number) &&
    tile.number >= 1 &&
    tile.number <= max &&
    Number.isInteger(tile.suit) &&
    tile.suit >= 0 &&
    tile.suit <= 3
  );
}

function numberRank(number: number, max: MaxNumber): number {
  return number < 3 ? max + number - 3 : number - 3;
}

export const rankTile: RankTile = (tile, max) => {
  if (!validTile(tile, max))
    throw new RangeError("Tile is outside the round deck");
  return { numRank: numberRank(tile.number, max), suitRank: tile.suit };
};

export const classify: Classify = (tiles, max) => {
  const count = tiles.length;
  if (count !== 1 && count !== 2 && count !== 3 && count !== 5) return null;

  const frequencies = new Map<number, number>();
  const seen = new Set<number>();
  for (const tile of tiles) {
    if (!validTile(tile, max)) return null;
    const id = tile.number * 4 + tile.suit;
    if (seen.has(id)) return null;
    seen.add(id);
    frequencies.set(tile.number, (frequencies.get(tile.number) ?? 0) + 1);
  }

  const sorted = tiles.toSorted(
    (a, b) =>
      numberRank(b.number, max) - numberRank(a.number, max) || b.suit - a.suit,
  );
  const [top, second] = sorted;
  if (!top) return null;
  const rank = numberRank(top.number, max);
  if (count === 1)
    return {
      kind: "SINGLE",
      count,
      representative: top,
      key: [rank, top.suit],
    };
  if (count < 5 && frequencies.size !== 1) return null;
  if (count === 2)
    return { kind: "PAIR", count, representative: top, key: [rank, top.suit] };
  if (count === 3)
    return { kind: "TRIPLE", count, representative: top.number, key: [rank] };
  if (!second) return null;

  const numbers = [...frequencies.keys()];
  // Consecutive face numbers include 1..5 and 2..6. Only the run ending at 1 may wrap.
  const straight =
    numbers.length === 5 &&
    (Math.max(...numbers) - Math.min(...numbers) === 4 ||
      (frequencies.has(1) && numbers.every((n) => n === 1 || n >= max - 3)));
  const flush = tiles.every((tile) => tile.suit === top.suit);
  const straightKey = [rank, numberRank(second.number, max), top.suit];
  if (straight && flush)
    return {
      kind: "STRAIGHT_FLUSH",
      count,
      representative: top,
      key: [4, ...straightKey],
    };
  for (const [number, frequency] of frequencies) {
    if (frequency === 4)
      return {
        kind: "FOUR_OF_A_KIND",
        count,
        representative: number,
        key: [3, numberRank(number, max)],
      };
    if (frequency === 3 && frequencies.size === 2)
      return {
        kind: "FULL_HOUSE",
        count,
        representative: number,
        key: [2, numberRank(number, max)],
      };
  }
  if (flush)
    return {
      kind: "FLUSH",
      count,
      representative: top,
      key: [1, ...sorted.map((tile) => numberRank(tile.number, max)), top.suit],
    };
  if (straight)
    return {
      kind: "STRAIGHT",
      count,
      representative: top,
      key: [0, ...straightKey],
    };
  return null;
};

export const compare: Compare = (challenger, table) => {
  if (challenger.count !== table.count) return false;
  for (const [i, value] of challenger.key.entries()) {
    const other = table.key[i];
    if (other === undefined) return true;
    if (value !== other) return value > other;
  }
  return false;
};
