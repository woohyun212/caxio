import type { Tile } from "@caxio/shared/contracts/domain";
import { phaseExamples } from "@caxio/shared/contracts/fixtures";
import type { PlayerView } from "@caxio/shared/contracts/wire";
import { tileRect } from "../../visual/assets";
import { layout } from "../../visual/layout";
import { tile } from "../../visual/tokens";
export const allTiles: Tile[] = Array.from({ length: 60 }, (_, i) => ({
  number: (i % 15) + 1,
  suit: ([0, 1, 2, 3] as const)[Math.floor(i / 15)] ?? 0,
}));
const seat = {
  chips: 150,
  remainingTileCount: 12,
  isOut: false,
  isConnected: true,
};
export const loadView: Extract<
  PlayerView,
  { phase: "TURN_ACTIVE"; ownHand: readonly Tile[] }
> = {
  ...phaseExamples[2].view,
  phase: "TURN_ACTIVE",
  currentTurn: 0,
  round: 1,
  turnId: 1,
  deadline: 1,
  ranking: [],
  maxNumber: 15,
  slots: [seat, seat, seat, seat, seat],
  seatOrder: [0, 1, 2, 3, 4],
  activePlayers: [0, 1, 2, 3, 4],
  ownHand: allTiles.slice(0, 12),
  tableHand: allTiles.slice(15, 20),
};
export const loadLayout = layout(loadView.seatOrder, 0, 12, 5);
export const sheetCells = allTiles.map((t, i) => ({
  dest: {
    x: (i % 12) * tile.wideWidth,
    y: Math.floor(i / 12) * tile.faceHeight,
    w: tile.wideWidth,
    h: tile.faceHeight,
  },
  source: { ...tileRect(t.number, t.suit, "wide"), h: tile.faceHeight },
}));
export function patch(i: number, row: number) {
  return {
    x: 12 * tile.wideWidth + (i % 4) * 16,
    y: row + Math.floor(i / 4) * 12,
    w: 12,
    h: 8,
  };
}
