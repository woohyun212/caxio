import { frame, sceneZones, stage, tile } from "./tokens";

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};
export type Seat = {
  readonly seatId: number;
  readonly centerX: number;
  readonly rack: Rect;
  readonly nameplate: Rect;
};
export type Layout = {
  readonly seats: readonly Seat[];
  readonly hand: readonly Rect[];
  readonly table: readonly Rect[];
  readonly felt: Rect;
};
export type Mode = "wide" | "compact";

export function fitScale(
  widthCss: number,
  heightCss: number,
): { k: number; mode: Mode } {
  if (
    !Number.isFinite(widthCss) ||
    !Number.isFinite(heightCss) ||
    widthCss < 0 ||
    heightCss < 0
  )
    throw new RangeError("Viewport dimensions must be finite and nonnegative");
  const k = Math.min(
    Math.floor(widthCss / frame.width),
    Math.floor(heightCss / frame.height),
  );
  return { k, mode: k >= frame.wideMinScale ? "wide" : "compact" };
}

function slots(count: number, y: number): readonly Rect[] {
  const width = tile.pitch * (count - 1) + tile.wideWidth;
  const left = Math.floor((frame.width - width) / 2);
  return Array.from({ length: count }, (_, i) => ({
    x: left + i * tile.pitch,
    y,
    w: tile.wideWidth,
    h: tile.height,
  }));
}

export function layout(
  seatOrder: readonly number[],
  self: number,
  handCount: number,
  tableCount: number,
): Layout {
  const selfIndex = seatOrder.indexOf(self);
  if (
    seatOrder.length > 5 ||
    (seatOrder.length > 0 && selfIndex < 0) ||
    new Set(seatOrder).size !== seatOrder.length ||
    [...seatOrder].some((id) => !Number.isInteger(id) || id < 0 || id > 4)
  )
    throw new RangeError(
      "Expected an empty order or distinct seat IDs 0–4 including self",
    );
  if (
    !Number.isInteger(handCount) ||
    handCount < 0 ||
    handCount > 13 ||
    ![0, 1, 2, 3, 5].includes(tableCount)
  )
    throw new RangeError("Invalid hand or table count");

  const opponents = [
    ...seatOrder.slice(selfIndex + 1),
    ...seatOrder.slice(0, selfIndex),
  ];
  const col = opponents.length ? Math.floor(frame.width / opponents.length) : 0;
  const margin = Math.floor((frame.width - col * opponents.length) / 2);
  const seats = opponents.map((seatId, i) => {
    const x = margin + i * col;
    return {
      seatId,
      centerX: x + col / 2,
      rack: { ...sceneZones.racks, x, w: col },
      nameplate: {
        x: x + stage.nameplateInset,
        y: sceneZones.nameplates.y,
        w: col - 2 * stage.nameplateInset,
        h: sceneZones.nameplates.h,
      },
    };
  });
  return {
    seats,
    hand: slots(handCount, tile.handY),
    table: slots(tableCount, tile.tableY),
    felt: sceneZones.table,
  };
}

export function seatLabel(id: number): string {
  return `${id + 1}번`;
}

export function handOrder<T extends { number: number; suit: 0 | 1 | 2 | 3 }>(
  tiles: readonly T[],
  maxNumber: 9 | 13 | 15,
): readonly T[] {
  if (
    ![9, 13, 15].includes(maxNumber) ||
    tiles.some(
      (t) =>
        !Number.isInteger(t.number) ||
        t.number < 1 ||
        t.number > maxNumber ||
        !Number.isInteger(t.suit) ||
        t.suit < 0 ||
        t.suit > 3,
    )
  )
    throw new RangeError("Invalid tile or round maximum");
  const rank = (n: number) => (n + maxNumber - 3) % maxNumber;
  return tiles.toSorted(
    (a, b) => rank(a.number) - rank(b.number) || a.suit - b.suit,
  );
}
