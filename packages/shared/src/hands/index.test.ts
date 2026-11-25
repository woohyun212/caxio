import { describe, expect, test } from "bun:test";
import type { HandKey, MaxNumber, Suit, Tile } from "../contracts/domain";
import type { HandRules } from "../contracts/engine";
import { previewExamples, representativeExamples } from "../contracts/fixtures";
import { classify, compare, rankTile } from "./index";

const rules: HandRules = { rankTile, classify, compare };
const suits = [0, 1, 2, 3] as const;
const tile = (number: number, suit: Suit = 0): Tile => ({ number, suit });
const group = (number: number, size: number) =>
  suits.slice(0, size).map((s) => tile(number, s));
const run = (start: number, length = 5) =>
  Array.from({ length }, (_, i) => start + i);
const suited = (numbers: readonly number[], suit: Suit) =>
  numbers.map((n) => tile(n, suit));
function hand(tiles: readonly Tile[], max: MaxNumber): HandKey {
  const result = rules.classify(tiles, max);
  if (!result)
    throw new Error(
      `Expected a legal hand: ${JSON.stringify(tiles)} at N=${max}`,
    );
  return result;
}
function beats(stronger: HandKey, weaker: HandKey) {
  expect(compare(stronger, weaker)).toBe(true);
  expect(compare(weaker, stronger)).toBe(false);
}

for (const max of [9, 13, 15] as const) {
  describe(`N=${max}`, () => {
    const order = [...run(3, max - 2), 1, 2];
    const get = (tiles: readonly Tile[]) => hand(tiles, max);
    const runs = [
      ...run(3, max - 6).map((start) => run(start)),
      [...run(max - 3, 4), 1],
      run(2),
      run(1),
    ];

    test("rank every tile", () => {
      for (const [numRank, number] of order.entries())
        for (const suit of suits)
          expect(rules.rankTile(tile(number, suit), max)).toEqual({
            numRank,
            suitRank: suit,
          });
    });

    for (const size of [1, 2, 3] as const) {
      const kind = ({ 1: "SINGLE", 2: "PAIR", 3: "TRIPLE" } as const)[size];
      test(`${kind} keys, representatives and every matchup`, () => {
        const cases: { value: HandKey; strength: number }[] = [];
        for (const [rank, number] of order.entries()) {
          for (let mask = 1; mask < 16; mask++) {
            const selected = suits.filter((s) => (mask & (1 << s)) !== 0);
            const highest = selected.at(-1);
            if (selected.length !== size || highest === undefined) continue;
            const value = get(selected.map((s) => tile(number, s)));
            expect(value.kind).toBe(kind);
            expect(value.count).toBe(size);
            expect(value.representative).toEqual(
              size === 3 ? number : tile(number, highest),
            );
            expect(value.key).toEqual(size === 3 ? [rank] : [rank, highest]);
            cases.push({
              value,
              strength: rank * 4 + (size === 3 ? 0 : highest),
            });
          }
        }
        for (const a of cases)
          for (const b of cases)
            expect(compare(a.value, b.value)).toBe(a.strength > b.strength);
      });
    }

    test("straight and straight flush keys and complete strength chains", () => {
      for (const flush of [false, true]) {
        let previous: HandKey | undefined;
        for (const numbers of runs) {
          const [top, second] = order
            .filter((n) => numbers.includes(n))
            .reverse();
          if (top === undefined || second === undefined)
            throw new Error("Incomplete run");
          for (const suit of suits) {
            const tiles = numbers.map((n) =>
              tile(n, flush || n === top ? suit : n % 2 === 0 ? 0 : 1),
            );
            const value = get(tiles);
            expect(value).toEqual({
              kind: flush ? "STRAIGHT_FLUSH" : "STRAIGHT",
              count: 5,
              representative: tile(top, suit),
              key: [
                flush ? 4 : 0,
                order.indexOf(top),
                order.indexOf(second),
                suit,
              ],
            });
            if (previous) beats(value, previous);
            previous = value;
          }
        }
      }
    });

    test("only listed runs are straights across all five-number subsets", () => {
      const deckNumbers = run(1, max);
      let subsets = 0;
      let allowedSubsets = 0;
      for (let mask = 0; mask < 1 << max; mask++) {
        const numbers = deckNumbers.filter((_, i) => (mask & (1 << i)) !== 0);
        if (numbers.length !== 5) continue;
        subsets++;
        const allowed = runs.some((r) => r.every((n) => numbers.includes(n)));
        const mixed = numbers.map((n, i) => tile(n, i === 0 ? 1 : 0));
        if (allowed) {
          allowedSubsets++;
          expect(get(mixed).kind).toBe("STRAIGHT");
        } else {
          expect(classify(mixed, max)).toBeNull();
        }
        expect(get(suited(numbers, 0)).kind).toBe(
          allowed ? "STRAIGHT_FLUSH" : "FLUSH",
        );
      }
      expect(subsets).toBe({ 9: 126, 13: 1287, 15: 3003 }[max]);
      expect(allowedSubsets).toBe(max - 3);
    });

    test("replacing any run number with a neighbouring number rejects the hand", () => {
      for (const numbers of runs) {
        for (const [i, missing] of numbers.entries()) {
          for (const neighbour of [numbers[i - 1], numbers[i + 1]]) {
            if (neighbour === undefined) continue;
            const tiles = numbers.map((n) =>
              n === missing ? tile(neighbour, 1) : tile(n, 0),
            );
            expect(classify(tiles, max)).toBeNull();
          }
        }
      }
    });

    test("forbidden wraps and round-dependent wrap", () => {
      for (const highCount of [1, 2, 3]) {
        const numbers = [
          ...run(max - highCount + 1, highCount),
          ...run(1, 5 - highCount),
        ];
        expect(
          classify(
            numbers.map((n, i) => tile(n, i === 0 ? 1 : 0)),
            max,
          ),
        ).toBeNull();
        expect(get(suited(numbers, 3)).kind).toBe("FLUSH");
      }
      const wrapped = [tile(6, 1), ...suited([7, 8, 9, 1], 0)];
      expect(classify(wrapped, max)?.kind ?? null).toBe(
        max === 9 ? "STRAIGHT" : null,
      );
    });

    test("flush keys compare every number before suit", () => {
      function flush(ranks: number[], suit: Suit) {
        const numbers = ranks.map((r) => order[r]);
        const top = numbers[0];
        if (
          top === undefined ||
          !numbers.every((n): n is number => n !== undefined)
        )
          throw new Error("Invalid ranks");
        const value = get(suited(numbers, suit));
        expect(value).toEqual({
          kind: "FLUSH",
          count: 5,
          representative: tile(top, suit),
          key: [1, ...ranks, suit],
        });
        return value;
      }
      const table = [7, 5, 4, 2, 0];
      for (const challenger of [
        [8, 4, 3, 1, 0],
        [7, 6, 3, 1, 0],
        [7, 5, 4, 3, 0],
        [7, 5, 4, 2, 1],
      ])
        beats(flush(challenger, 0), flush(table, 3));
      beats(flush([7, 6, 5, 2, 0], 0), flush([7, 6, 4, 3, 1], 3));
      beats(flush(table, 3), flush(table, 0));
    });

    test("full house and four of a kind compare only the body", () => {
      for (const size of [3, 4]) {
        let previous: HandKey | undefined;
        for (const [rank, number] of order.entries()) {
          let sameBody: HandKey | undefined;
          for (const side of order.filter((n) => n !== number)) {
            const value = get([
              ...group(number, size),
              ...group(side, 5 - size),
            ]);
            expect(value).toEqual({
              kind: size === 3 ? "FULL_HOUSE" : "FOUR_OF_A_KIND",
              count: 5,
              representative: number,
              key: [size - 1, rank],
            });
            if (previous) beats(value, previous);
            if (sameBody) {
              expect(compare(value, sameBody)).toBe(false);
              expect(compare(sameBody, value)).toBe(false);
            }
            sameBody = value;
          }
          previous = sameBody;
        }
      }
    });

    test("weakest made beats the strongest of the preceding tier", () => {
      const highStraight = get([tile(2, 3), ...suited([1, 3, 4, 5], 0)]);
      const lowFlush = get(suited([3, 4, 5, 6, 8], 0));
      const highFlush = get(suited(order.slice(-5), 3));
      const lowHouse = get([...group(3, 3), ...group(4, 2)]);
      const highHouse = get([...group(2, 3), ...group(3, 2)]);
      const lowFour = get([...group(3, 4), tile(4)]);
      const highFour = get([...group(2, 4), tile(3)]);
      beats(lowFlush, highStraight);
      beats(lowHouse, highFlush);
      beats(lowFour, highHouse);
      beats(get(suited(run(3), 0)), highFour);
    });

    test("equal keys and different counts never win", () => {
      const values = [
        get(group(2, 1)),
        get(group(1, 2)),
        get(group(5, 3)),
        get(suited(run(3), 3)),
      ];
      for (const a of values)
        for (const b of values) expect(compare(a, b)).toBe(false);
    });

    test("reject bad counts, duplicates and unmatched combinations", () => {
      for (const tiles of [
        [],
        group(2, 4),
        suited(run(2, 4), 1),
        suited(run(1, 6), 0),
        [tile(7), tile(7)],
        [tile(7), tile(7, 1), tile(7)],
        [tile(7), ...group(7, 3), tile(8)],
        [tile(7), tile(8)],
        [...group(7, 2), tile(8)],
        [...group(7, 2), ...group(8, 2), tile(2)],
        [...group(7, 3), tile(8), tile(2)],
        [tile(3, 2), ...suited([4, 5, 6, 8], 1)],
      ])
        expect(classify(tiles, max)).toBeNull();
    });

    test("classification preserves frozen inputs across all permutations", () => {
      function* permutations(tiles: readonly Tile[]): Generator<Tile[]> {
        if (tiles.length === 0) yield [];
        for (const [i, first] of tiles.entries())
          for (const rest of permutations(tiles.filter((_, j) => j !== i)))
            yield [first, ...rest];
      }
      for (const sample of [
        group(3, 1),
        group(4, 2),
        group(5, 3),
        [tile(2, 2), ...suited([1, 3, 4, 5], 0)],
        suited([3, 5, 6, 7, 9], 2),
        [...group(1, 3), ...group(8, 2)],
        [...group(2, 4), tile(5)],
        suited(run(2), 3),
      ]) {
        const expected = get(sample);
        for (const permuted of permutations(
          sample.map((t) => Object.freeze(t)),
        )) {
          const before = permuted.map((t) => ({ ...t }));
          expect(get(Object.freeze(permuted))).toEqual(expected);
          expect(permuted).toEqual(before);
        }
      }
    });

    test("invalid tiles classify as null and ranking throws RangeError", () => {
      const bad = [0, -1, max + 1, 1.5, NaN, Infinity].map((n) => tile(n));
      // Simulate suit values arriving from an untyped caller.
      bad.push(...[-1, 4, 0.5, NaN].map((s) => tile(1, s as Suit)));
      for (const t of bad) {
        expect(classify([t], max)).toBeNull();
        expect(classify([...suited(run(3, 4), 0), t], max)).toBeNull();
        expect(() => rankTile(t, max)).toThrow(RangeError);
      }
    });
  });
}

test("replay frozen representative and preview fixtures", () => {
  for (const { selected, tableHand, maxNumber, result } of [
    ...representativeExamples,
    ...previewExamples,
  ]) {
    if (!result.ok && result.reason === "COUNT") {
      expect(classify(selected, maxNumber)).toBeNull();
      continue;
    }
    const value = hand(selected, maxNumber);
    if (result.ok) {
      expect(value.kind).toBe(result.kind);
      expect(value.representative).toEqual(result.representative);
    }
    if (tableHand)
      expect(compare(value, hand(tableHand, maxNumber))).toBe(result.ok);
  }
});
