import { expect, test } from "bun:test";
import {
  fitScale,
  handOrder,
  layout,
  type Rect,
  seatLabel,
} from "../../apps/web/src/visual/layout";
import { stage, tile } from "../../apps/web/src/visual/tokens";

type ConsumerRect = Readonly<{ x: number; y: number; w: number; h: number }>;
type ConsumerLayout = Readonly<{
  seats: readonly Readonly<{
    seatId: number;
    centerX: number;
    rack: ConsumerRect;
    nameplate: ConsumerRect;
  }>[];
  hand: readonly ConsumerRect[];
  table: readonly ConsumerRect[];
  felt: ConsumerRect;
}>;

test("layout is assignable to the table and controls consumer shape", () => {
  const consumed: ConsumerLayout = layout([0, 1, 2, 3], 0, 13, 5);
  expect(consumed.seats.map((seat) => seat.centerX)).toEqual([70, 208, 346]);
  expect(stage.rackCenterY).toBe(26);
});

test("entry and lobby layout supports zero, one and two occupants", () => {
  const empty = {
    seats: [],
    hand: [],
    table: [],
    felt: { x: 0, y: 46, w: 416, h: 98 },
  };
  expect(layout([], -1, 0, 0)).toEqual(empty);
  expect(layout([], NaN, 0, 0)).toEqual(empty);
  expect(layout([2], 2, 0, 0)).toEqual(empty);
  expect(layout([3, 1], 1, 0, 0)).toEqual({
    ...empty,
    seats: [
      {
        seatId: 3,
        centerX: 208,
        rack: { x: 0, y: 0, w: 416, h: 30 },
        nameplate: { x: 4, y: 30, w: 408, h: 16 },
      },
    ],
  });
});

test("opponent columns wrap after self and preserve starting order", () => {
  for (const [order, self, ids, centers, starts, column, boxWidth] of [
    [[2, 0, 4], 0, [4, 2], [104, 312], [0, 208], 208, 200],
    [[0, 2, 3, 1], 3, [1, 0, 2], [70, 208, 346], [1, 139, 277], 138, 130],
    [
      [0, 1, 2, 3, 4],
      4,
      [0, 1, 2, 3],
      [52, 156, 260, 364],
      [0, 104, 208, 312],
      104,
      96,
    ],
  ] as const) {
    const { seats } = layout(order, self, 13, 5);
    expect(seats.map((s) => s.seatId)).toEqual([...ids]);
    expect(seats.map((s) => s.centerX)).toEqual([...centers]);
    expect(seats.map((s) => s.rack)).toEqual(
      starts.map((x) => ({ x, y: 0, w: column, h: 30 })),
    );
    expect(seats.map((s) => s.nameplate)).toEqual(
      starts.map((x) => ({ x: x + 4, y: 30, w: boxWidth, h: 16 })),
    );
    expect(layout(order, self, 0, 0).seats).toEqual(seats);
  }
});

test("three-digit chip label fits every column", () => {
  expect(stage.maxNameplateTextWidth).toBe(92);
  for (const [order, width] of [
    [[0, 2, 4], 200],
    [[0, 1, 2, 3], 130],
    [[4, 3, 2, 1, 0], 96],
  ] as const) {
    for (const seat of layout(order, 0, 0, 0).seats) {
      expect(seat.nameplate.w).toBe(width);
      expect(seat.nameplate.w).toBeGreaterThanOrEqual(
        stage.maxNameplateTextWidth,
      );
      if (order.length === 5) expect(seat.rack.w).toBe(104);
    }
  }
});

test("12/13 hand and five table slots match measured widths and anchors", () => {
  const { hand, table } = layout([0, 1, 2, 3], 0, 13, 5);
  for (const [slots, left, y, width, count] of [
    [hand, 14, 151, 388, 13],
    [table, 134, 83, 148, 5],
    [layout([0, 1, 2, 3, 4], 0, 12, 5).hand, 29, 151, 358, 12],
  ] as const) {
    expect(slots.length).toBe(count);
    expect(slots.at(-1)?.x).toBe(left + width - 28);
    for (const [i, rect] of slots.entries())
      expect(rect).toEqual({ x: left + i * 30, y, w: 28, h: 40 });
  }
});

function touchesInterior(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

test("all game counts stay centered, integral, disjoint and inside the scene", () => {
  for (const order of [
    [0, 1, 2],
    [0, 2, 3, 1],
    [0, 1, 2, 3, 4],
  ]) {
    for (let n = 0; n <= 13; n++)
      for (const m of [0, 1, 2, 3, 5]) {
        const { seats, hand, table } = layout(order, 1, n, m);
        for (const [slots, count] of [
          [hand, n],
          [table, m],
        ] as const) {
          expect(slots.length).toBe(count);
          const first = slots.at(0),
            last = slots.at(-1);
          if (first && last) expect(first.x + last.x + last.w).toBe(416);
        }
        const boxes = [
          ...hand,
          ...table,
          ...seats.flatMap((s) => [s.rack, s.nameplate]),
        ];
        for (const [i, rect] of boxes.entries()) {
          expect(Object.values(rect).every(Number.isInteger)).toBe(true);
          expect(
            rect.x >= 0 &&
              rect.y >= 0 &&
              rect.x + rect.w <= 416 &&
              rect.y + rect.h <= 196,
          ).toBe(true);
          expect(
            boxes.slice(i + 1).some((other) => touchesInterior(rect, other)),
          ).toBe(false);
        }
      }
  }
});

test("fitScale matches fourteen viewports and both wide boundaries", () => {
  for (const [w, h, k, mode] of [
    [360, 640, 0, "compact"],
    [390, 844, 0, "compact"],
    [430, 932, 1, "compact"],
    [768, 1024, 1, "compact"],
    [844, 390, 1, "compact"],
    [1024, 768, 2, "wide"],
    [1103, 719, 2, "wide"],
    [1280, 680, 2, "wide"],
    [1366, 650, 2, "wide"],
    [1536, 730, 2, "wide"],
    [1280, 800, 3, "wide"],
    [1440, 780, 3, "wide"],
    [1920, 950, 3, "wide"],
    [1920, 1080, 4, "wide"],
    [831, 500, 1, "compact"],
    [832, 500, 2, "wide"],
    [832, 499, 1, "compact"],
    [831.99, 500, 1, "compact"],
    [0, 0, 0, "compact"],
  ] as const)
    expect(fitScale(w, h)).toEqual({ k, mode });
});

test("Q3 selection lifts the face and keeps the ground at the target slot", () => {
  const { hand, table, felt } = layout([0, 1, 2, 3], 0, 13, 5);
  const slot = hand.at(0);
  if (!slot) throw new Error("Expected first slot");
  expect(slot.y).toBe(151);
  expect(table.at(0)?.y).toBe(83);
  expect(slot.y - tile.selectedLift).toBe(146);
  expect(tile.underline).toEqual({ dy: 38, h: 2, inset: 0 });
  const { dy, h, inset } = tile.underline;
  const underline = {
    x: slot.x + inset,
    y: slot.y + dy,
    w: slot.w - 2 * inset,
    h,
  };
  expect(underline).toEqual({ x: 14, y: 189, w: 28, h: 2 });
  expect(underline.y + underline.h).toBe(slot.y + slot.h);
  expect(tile.underline.h * tile.compactScale).toBe(4);
  expect({
    ...slot,
    x: slot.x + tile.footprint.dx,
    y: slot.y + tile.footprint.dy,
  }).toEqual({ x: 16, y: 153, w: 28, h: 40 });
  expect(tile.footprint.band).toBe(1);
  expect(stage.backMesh).toEqual({
    width: 20,
    height: 30,
    depth: 2,
    rotationX: -0.42,
  });
  expect([stage.rackWidth, stage.rackHeight, stage.rackDepth]).toEqual([
    92, 7, 12,
  ]);
  expect(felt).toEqual({ x: 0, y: 46, w: 416, h: 98 });
  expect(stage.caption).toEqual({ x: 130, y: 59, w: 156, h: 16 });
  expect(stage.stadium).toEqual({
    x: 208,
    y: 98,
    halfHeight: 44,
    centerSpacing: 300,
    inkWidth: 1,
    paperWidth: 1,
    sageWidth: 3,
  });
  expect([
    stage.backY,
    stage.backWidth,
    stage.backHeight,
    stage.backPitch,
  ]).toEqual([1, 20, 26, 6]);
  expect(
    [12, 13].map((n) => stage.backWidth + (n - 1) * stage.backPitch),
  ).toEqual([86, 92]);
});

test("hand and center share number-first order for every round maximum without mutating tiles", () => {
  for (const n of [9, 13, 15] as const) {
    const tiles = Object.freeze([
      { number: 2, suit: 0 },
      { number: n, suit: 3 },
      { number: 4, suit: 2 },
      { number: 1, suit: 3 },
      { number: 3, suit: 1 },
      { number: 4, suit: 0 },
      { number: 4, suit: 3 },
      { number: 4, suit: 1 },
      { number: 2, suit: 2 },
      { number: 1, suit: 1 },
    ] as const);
    const before = structuredClone(tiles);
    const ordered = handOrder(tiles, n);
    expect(ordered).not.toBe(tiles);
    expect(ordered.map((t) => [t.number, t.suit])).toEqual([
      [3, 1],
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
      [n, 3],
      [1, 1],
      [1, 3],
      [2, 0],
      [2, 2],
    ]);
    for (const [i, original] of [4, 5, 7, 2, 6, 1, 9, 3, 0, 8].entries())
      expect(ordered[i]).toBe(tiles[original]);
    expect(tiles).toEqual(before);
    const center = [1, 2, 3, 4, 5].map((number) => ({
      number,
      suit: 0 as const,
    }));
    expect(handOrder(center, n).map((t) => t.number)).toEqual([3, 4, 5, 1, 2]);
  }
});

test("seat labels use one-based Korean numbering", () => {
  expect([0, 1, 2, 3, 4].map(seatLabel)).toEqual([
    "1번",
    "2번",
    "3번",
    "4번",
    "5번",
  ]);
});

test("invalid layout, viewport and round inputs throw RangeError", () => {
  for (const order of [
    [1],
    [1, 2],
    [1, 2, 3],
    [0, 1, 1],
    [0, 1, 2, 3, 4, 5],
    [0, 1, 5],
    [0, 1, 1.5],
    [0, -1],
  ])
    expect(() => layout(order, 0, 0, 0)).toThrow(RangeError);
  const missingId = new Array<number>(2);
  missingId[0] = 0;
  expect(() => layout(missingId, 0, 0, 0)).toThrow(RangeError);
  expect(() => layout([], -1, -1, 0)).toThrow(RangeError);
  expect(() => layout([], -1, 0, 4)).toThrow(RangeError);
  for (const count of [-1, 1.5, 14, NaN, Infinity])
    expect(() => layout([0, 1, 2], 0, count, 0)).toThrow(RangeError);
  for (const count of [-1, 1.5, 4, 6, NaN, Infinity])
    expect(() => layout([0, 1, 2], 0, 0, count)).toThrow(RangeError);
  for (const value of [NaN, Infinity, -1]) {
    expect(() => fitScale(value, 500)).toThrow(RangeError);
    expect(() => fitScale(832, value)).toThrow(RangeError);
  }
  for (const max of [9, 13, 15] as const)
    for (const number of [0, max + 1, 3.5, NaN, Infinity])
      expect(() => handOrder([{ number, suit: 0 }], max)).toThrow(RangeError);
});
