import type { Mode, Rect } from "./layout";
import { palette, stage, tile } from "./tokens";

export type AssetSpec = {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
  readonly allowedColors: readonly string[];
  readonly alpha: readonly number[];
};

function hex(bytes: readonly number[]): string {
  return (
    "#" +
    bytes
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}
const suits = [palette.cloud, palette.star, palette.moon, palette.sun].map(hex);
const faceBase = [palette.ink, palette.pine, palette.paper].map(hex);
export const backColors: readonly string[] = [
  palette.ink,
  palette.pine,
  palette.sage,
  palette.paper,
].map(hex);
export function faceColors(suitRank: number): readonly string[] {
  const suit = suits[suitRank];
  if (suit === undefined) throw new RangeError("Invalid suit rank");
  return [...faceBase, suit];
}

// Only the wide atlas contains a back. The compact atlas contains faces only.
export const backRect = {
  x: 0,
  y: 160,
  w: stage.backWidth,
  h: stage.backHeight,
} as const satisfies Rect;

export const atlases = {
  wide: {
    url: "/art/atlas-wide.png",
    width: 420,
    height: 186,
    cellWidth: tile.wideWidth,
    cellHeight: tile.height,
    allowedColors: [...backColors, ...suits],
    alpha: [0, 255],
  },
  compact: {
    url: "/art/atlas-compact.png",
    width: 360,
    height: 160,
    cellWidth: tile.compactWidth,
    cellHeight: tile.height,
    allowedColors: [...faceBase, ...suits],
    alpha: [0, 255],
  },
} as const satisfies Record<Mode, AssetSpec>;

export function tileRect(number: number, suitRank: number, mode: Mode): Rect {
  if (
    !Number.isInteger(number) ||
    number < 1 ||
    number > 15 ||
    !Number.isInteger(suitRank) ||
    suitRank < 0 ||
    suitRank > 3 ||
    (mode !== "wide" && mode !== "compact")
  )
    throw new RangeError("Invalid atlas address");
  const { cellWidth: w, cellHeight: h } = atlases[mode];
  return { x: (number - 1) * w, y: suitRank * h, w, h };
}
export function glyphBoxes(mode: Mode): {
  readonly number: Rect;
  readonly suit: Rect;
} {
  const mid = atlases[mode].cellWidth / 2;
  return {
    number: { x: mid - 10, y: 3, w: 20, h: 13 },
    suit: { x: mid - 8, y: 19, w: 16, h: 14 },
  };
}
export const fontFiles = [
  {
    url: "/fonts/Galmuri11.woff2",
    bytes: 505400,
    sha256: "8bad9322b3340bfb5cb26cb00f4752bf4c8e7d1b526bb07205f4af458eebed31",
  },
  {
    url: "/fonts/ofl.md",
    bytes: 4266,
    sha256: "9a9e5a342c430c3fcf01a408b680f4405d5bf4ac659c931be35f8a1b27ea69c9",
  },
] as const;
