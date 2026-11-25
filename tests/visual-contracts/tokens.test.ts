import { expect, test } from "bun:test";
import {
  bayer,
  feltBands,
  feltCoverage,
  motion,
  palette,
  targetY,
  tile,
} from "../../apps/web/src/visual/tokens";

test("sRGB palette, tile dimensions and motion match the locked values", () => {
  expect(palette).toEqual({
    ink: [21, 43, 38],
    pine: [56, 87, 71],
    sage: [130, 151, 105],
    paper: [220, 231, 177],
    cloud: [42, 120, 184],
    star: [87, 48, 122],
    moon: [178, 110, 0],
    sun: [161, 43, 28],
  });
  expect(motion).toEqual({
    selectionLambda: 25,
    playDealReorderLambda: 14,
    snapError: 0.001,
  });
  expect([
    tile.wideWidth,
    tile.compactWidth,
    tile.height,
    tile.compactScale,
    tile.faceHeight,
    tile.ledgeHeight,
    tile.bottomY,
  ]).toEqual([28, 24, 40, 2, 36, 3, 39]);
});

test("Bayer ranks and felt coverage use the lower-left target origin", () => {
  const ranks = bayer.flat();
  expect(bayer).toEqual([
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ]);
  expect([...ranks].sort((a, b) => a - b)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  const lightCells = (coverage: number) =>
    ranks.filter((rank) => coverage > (rank + 0.5) / 16).length;
  for (let n = 0; n <= 16; n++) expect(lightCells(n / 16)).toBe(n);
  expect(
    [0, 11, 11.99, 12, 27, 27.99, 28, 100].map((d) =>
      lightCells(feltCoverage(d)),
    ),
  ).toEqual([2, 2, 2, 5, 5, 5, 8, 8]);
  expect([0, 11, 12, 27, 28].map(feltCoverage)).toEqual([
    2 / 16,
    2 / 16,
    5 / 16,
    5 / 16,
    8 / 16,
  ]);
  expect([feltBands.dark, feltBands.light]).toEqual([
    palette.ink,
    palette.pine,
  ]);
  expect(targetY(196, 0)).toBe(195);
  expect(targetY(196, 195)).toBe(0);
  expect(bayer[targetY(196, 0) % 4]).toEqual([15, 7, 13, 5]);
});
