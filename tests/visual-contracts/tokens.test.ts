import { expect, test } from "bun:test";
import {
  bayer,
  bayerLight,
  bayerThreshold,
  feltBands,
  feltCoverage,
  frame,
  motion,
  palette,
  sceneZones,
  targetY,
  tile,
} from "../../apps/web/src/visual/tokens";

test("sRGB palette, tile dimensions and motion match the locked values", () => {
  expect(palette).toEqual({
    ink: [21, 43, 38],
    pine: [56, 87, 71],
    sage: [130, 151, 105],
    paper: [220, 231, 177],
    cloud: [101, 197, 255],
    star: [255, 226, 46],
    moon: [56, 184, 78],
    sun: [240, 82, 70],
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
  expect(bayerThreshold(0, 0)).toBe(0.5 / 16);
  expect(bayerThreshold(1, 0)).toBe(8.5 / 16);
  expect(bayerThreshold(0, 1)).toBe(12.5 / 16);
  expect(bayerThreshold(3, 3)).toBe(5.5 / 16);
  expect(bayerThreshold(5, 6)).toBe(11.5 / 16);

  const axis = [0, 1, 2, 3];
  const cells = axis.flatMap((y) => axis.map((x) => ({ x, y })));
  expect(new Set(cells.map(({ x, y }) => bayerThreshold(x, y))).size).toBe(16);
  const lightCells = (coverage: number, left = 0, bottom = 0) =>
    cells.filter(({ x, y }) => bayerLight(left + x, bottom + y, coverage))
      .length;
  for (let n = 0; n <= 16; n++) {
    expect(lightCells(n / 16)).toBe(n);
    expect(lightCells(n / 16, 8, 12)).toBe(n);
  }
  expect(lightCells(0.5 / 16)).toBe(0);
  expect(lightCells(2.5 / 16)).toBe(2);
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
  expect(axis.map((x) => bayerThreshold(x, targetY(196, 0)))).toEqual([
    15.5 / 16,
    7.5 / 16,
    13.5 / 16,
    5.5 / 16,
  ]);
});

test("Bayer target coordinates reject negative, fractional and nonfinite inputs", () => {
  for (const value of [-4, -1, 0.5, NaN, Infinity]) {
    expect(() => bayerThreshold(value, 0)).toThrow(RangeError);
    expect(() => bayerLight(0, value, 0.5)).toThrow(RangeError);
  }
});

test("frame bands and scene zones use their respective coordinate spaces", () => {
  expect(frame).toEqual({
    width: 416,
    height: 250,
    statusHeight: 16,
    sceneHeight: 196,
    messageHeight: 16,
    commandHeight: 22,
    wideMinScale: 2,
  });
  expect(sceneZones).toEqual({
    racks: { x: 0, y: 0, w: 416, h: 30 },
    nameplates: { x: 0, y: 30, w: 416, h: 16 },
    table: { x: 0, y: 46, w: 416, h: 98 },
    hand: { x: 0, y: 144, w: 416, h: 52 },
  });
});
