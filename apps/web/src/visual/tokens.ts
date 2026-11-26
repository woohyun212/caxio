export const palette = {
  ink: [0x15, 0x2b, 0x26],
  pine: [0x38, 0x57, 0x47],
  sage: [0x82, 0x97, 0x69],
  paper: [0xdc, 0xe7, 0xb1],
  cloud: [0x2a, 0x78, 0xb8],
  star: [0x2c, 0x54, 0x0c],
  moon: [0xb2, 0x6e, 0x00],
  sun: [0xa1, 0x2b, 0x1c],
} as const;

export const frame = {
  width: 416,
  height: 250,
  statusHeight: 16,
  sceneHeight: 196,
  messageHeight: 16,
  commandHeight: 22,
  wideMinScale: 2,
} as const;

export const sceneZones = {
  racks: { x: 0, y: 0, w: frame.width, h: 30 },
  nameplates: { x: 0, y: 30, w: frame.width, h: 16 },
  table: { x: 0, y: 46, w: frame.width, h: 98 },
  hand: { x: 0, y: 144, w: frame.width, h: 52 },
} as const;

export const stage = {
  caption: { x: 130, y: 59, w: 156, h: 16 },
  stadium: {
    x: 208,
    y: 98,
    halfHeight: 44,
    centerSpacing: 300,
    inkWidth: 1,
    paperWidth: 1,
    sageWidth: 3,
  },
  rackCenterY: 26,
  rackWidth: 92,
  rackHeight: 7,
  rackDepth: 12,
  nameplateInset: 4,
  maxNameplateTextWidth: 92,
  backY: 1,
  backWidth: 20,
  backHeight: 26,
  backPitch: 6,
  backMesh: { width: 20, height: 30, depth: 2, rotationX: -0.42 },
} as const;

export const tile = {
  wideWidth: 28,
  compactWidth: 24,
  height: 40,
  compactScale: 2,
  faceHeight: 36,
  ledgeHeight: 3,
  bottomY: 39,
  pitch: 30,
  handY: 151,
  tableY: 83,
  selectedLift: 5,
  // The scene and DOM draw the same ink underline at the bottom of the un-lifted slot.
  underline: { dy: 38, h: 2, inset: 0 },
  footprint: { dx: 2, dy: 2, band: 1 },
} as const;

// Indexed from the lower left of the render target.
export const bayer = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

export function bayerThreshold(x: number, y: number): number {
  const rank = bayer[y % 4]?.[x % 4];
  if (rank === undefined || x < 0 || y < 0)
    throw new RangeError(
      "Bayer target coordinates must be nonnegative integers",
    );
  return (rank + 0.5) / 16;
}

export function bayerLight(x: number, y: number, coverage: number): boolean {
  return coverage > bayerThreshold(x, y);
}

export const feltBands = {
  outerEnd: 12,
  middleEnd: 28,
  outerCoverage: 2 / 16,
  middleCoverage: 5 / 16,
  innerCoverage: 8 / 16,
  dark: palette.ink,
  light: palette.pine,
} as const;

export function feltCoverage(distance: number): number {
  if (distance < feltBands.outerEnd) return feltBands.outerCoverage;
  if (distance < feltBands.middleEnd) return feltBands.middleCoverage;
  return feltBands.innerCoverage;
}

export function targetY(height: number, pngY: number): number {
  return height - 1 - pngY;
}

export const motion = {
  selectionLambda: 25,
  playDealReorderLambda: 14,
  snapError: 0.001,
} as const;
