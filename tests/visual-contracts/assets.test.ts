import { expect, test } from "bun:test";
import {
  atlases,
  backColors,
  backRect,
  faceColors,
  fontFiles,
  glyphBoxes,
  tileRect,
} from "../../apps/web/src/visual/assets";

test("sixty face addresses per atlas match the PNG grid and exclude the shared back", () => {
  expect(backRect).toEqual({ x: 0, y: 160, w: 20, h: 26 });
  expect(backRect.x + backRect.w).toBeLessThanOrEqual(atlases.wide.width);
  expect(backRect.y + backRect.h).toBeLessThanOrEqual(atlases.wide.height);
  expect(backRect.y).toBeGreaterThanOrEqual(atlases.compact.height);
  for (const [mode, width, columns] of [
    [
      "wide",
      28,
      [0, 28, 56, 84, 112, 140, 168, 196, 224, 252, 280, 308, 336, 364, 392],
    ],
    [
      "compact",
      24,
      [0, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288, 312, 336],
    ],
  ] as const) {
    const seen = new Set<string>();
    for (const [i, x] of columns.entries())
      for (const [suit, y] of [0, 40, 80, 120].entries()) {
        const rect = tileRect(i + 1, suit, mode);
        expect(rect).toEqual({ x, y, w: width, h: 40 });
        seen.add(`${rect.x},${rect.y}`);
        expect(rect.x + rect.w).toBeLessThanOrEqual(atlases[mode].width);
        expect(rect.y + rect.h).toBeLessThanOrEqual(atlases[mode].height);
        if (mode === "wide")
          expect(rect.y + rect.h).toBeLessThanOrEqual(backRect.y);
      }
    expect(seen.size).toBe(60);
  }
});

test("atlas metadata, cell palettes, glyph boxes and font identities are frozen", () => {
  const ramp = ["#152B26", "#385747", "#829769", "#DCE7B1"];
  const faceBase = ["#152B26", "#385747", "#DCE7B1"];
  const inks = ["#65C5FF", "#FFE22E", "#38B84E", "#F05246"];
  expect(backColors).toEqual(ramp);
  expect(atlases.wide).toEqual({
    url: "/art/atlas-wide.png",
    width: 420,
    height: 186,
    cellWidth: 28,
    cellHeight: 40,
    allowedColors: [...ramp, ...inks],
    alpha: [0, 255],
  });
  expect(atlases.compact).toEqual({
    url: "/art/atlas-compact.png",
    width: 360,
    height: 160,
    cellWidth: 24,
    cellHeight: 40,
    allowedColors: [...faceBase, ...inks],
    alpha: [0, 255],
  });
  for (const [i, ink] of inks.entries())
    expect(faceColors(i)).toEqual([...faceBase, ink]);
  expect(glyphBoxes("wide")).toEqual({
    number: { x: 4, y: 3, w: 20, h: 13 },
    suit: { x: 6, y: 19, w: 16, h: 14 },
  });
  expect(glyphBoxes("compact")).toEqual({
    number: { x: 2, y: 3, w: 20, h: 13 },
    suit: { x: 4, y: 19, w: 16, h: 14 },
  });
  expect(fontFiles).toEqual([
    {
      url: "/fonts/Galmuri11.woff2",
      bytes: 505400,
      sha256:
        "8bad9322b3340bfb5cb26cb00f4752bf4c8e7d1b526bb07205f4af458eebed31",
    },
    {
      url: "/fonts/ofl.md",
      bytes: 4266,
      sha256:
        "9a9e5a342c430c3fcf01a408b680f4405d5bf4ac659c931be35f8a1b27ea69c9",
    },
  ]);
});

test("invalid atlas numbers and suit ranks throw RangeError", () => {
  for (const n of [0, 16, 3.5, NaN, Infinity])
    expect(() => tileRect(n, 0, "wide")).toThrow(RangeError);
  for (const s of [-1, 4, 1.5, NaN, Infinity]) {
    expect(() => tileRect(1, s, "compact")).toThrow(RangeError);
    expect(() => faceColors(s)).toThrow(RangeError);
  }
});
