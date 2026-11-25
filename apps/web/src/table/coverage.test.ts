import { expect, test } from "bun:test";
import { bayerLight, frame, palette, targetY } from "../visual/tokens";
import { surfaceColor } from "./verify/coverage";

test("bottom-left Bayer origin and exact counts at every step", () => {
  expect(bayerLight(0, 0, 1 / 16)).toBe(true);
  expect(bayerLight(0, 1, 1 / 16)).toBe(false);
  expect(targetY(frame.sceneHeight, 195)).toBe(0);
  for (let n = 0; n <= 16; n++) {
    let count = 0;
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 4; y++) count += Number(bayerLight(x, y, n / 16));
    expect(count).toBe(n);
  }
});
test("aligned felt samples and footprint interiors and transition bands", () => {
  for (const [top, n] of [
    [60, 2],
    [74, 5],
    [92, 8],
  ] as const) {
    let count = 0;
    for (let x = 96; x < 100; x++)
      for (let y = top; y < top + 4; y++) {
        const edge = 44 - Math.abs(y + 0.5 - 98);
        if (surfaceColor(x, y, edge, false, false, false) === palette.pine)
          count++;
      }
    expect(count).toBe(n);
  }
  for (const floor of [true, false]) {
    expect(surfaceColor(136, 95, 41, floor, true, false)).toBe(
      floor ? palette.pine : palette.ink,
    );
    expect(surfaceColor(136, 95, 41, floor, false, true)).toBe(
      floor ? palette.sage : palette.pine,
    );
    expect(surfaceColor(137, 95, 41, floor, false, true)).toBe(
      floor ? palette.pine : palette.ink,
    );
  }
});
