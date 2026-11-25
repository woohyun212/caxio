import type { Tile } from "@caxio/shared/contracts/domain";
import type { Rect, TableProps } from "../contracts";
import { handOrder } from "../visual/layout";
import { frame, motion, stage, tile } from "../visual/tokens";

export function phaseTransform(k: number, dpr: number) {
  return Number.isInteger(k * dpr)
    ? "none"
    : "translate(0.015625px, 0.015625px)";
}
export function damp(
  value: number,
  goal: number,
  lambda: number,
  dt: number,
  reduced: boolean,
) {
  const error = (value - goal) * Math.exp(-lambda * dt);
  return reduced || Math.abs(error) < motion.snapError ? goal : goal + error;
}
export type Face = {
  key: string;
  tile: Tile;
  hand: boolean;
  slot: Rect;
  selected: boolean;
  x: number;
  y: number;
  lift: number;
};
export type TableModel = ReturnType<typeof model>;
export function model(
  props: TableProps,
  previous?: { round: number; faces: Face[] },
) {
  const { view, layout, selected } = props;
  const racks = layout.seats.map((s) => ({
    seatId: s.seatId,
    x: s.centerX,
    count: view.slots[s.seatId]?.remainingTileCount ?? 0,
  }));
  const faces: Face[] = [];
  function assign(
    tiles: readonly Tile[],
    slots: readonly Rect[],
    hand: boolean,
  ) {
    if (!view.maxNumber) return;
    for (const [i, t] of handOrder(tiles, view.maxNumber).entries()) {
      const slot = slots[i];
      if (!slot) continue;
      const key = `${t.number}/${t.suit}`;
      const old =
        previous?.round === view.round
          ? previous.faces.find((f) => f.key === key)
          : undefined;
      const rack =
        !hand && racks.find((r) => r.seatId === view.lastPlay?.seatId);
      const chosen =
        hand &&
        selected.some((s) => s.number === t.number && s.suit === t.suit);
      let x = slot.x,
        y = slot.y;
      if (previous) {
        x = old?.x ?? (rack ? rack.x : stage.stadium.x) - slot.w / 2;
        y = old
          ? old.y - (old.hand && !hand ? old.lift : 0)
          : (rack ? stage.rackCenterY : stage.stadium.y) - slot.h / 2;
      }
      faces.push({
        key,
        tile: t,
        hand,
        slot,
        selected: chosen,
        x,
        y,
        lift:
          old?.hand && hand
            ? old.lift
            : !previous && chosen
              ? tile.selectedLift
              : 0,
      });
    }
  }
  assign(view.tableHand ?? [], layout.table, false);
  assign(view.ownHand ?? [], layout.hand, true);
  return { round: view.round, racks, faces };
}
export function advance(m: TableModel, dt: number, reduced: boolean) {
  let moving = false;
  for (const f of m.faces) {
    f.x = damp(f.x, f.slot.x, motion.playDealReorderLambda, dt, reduced);
    f.y = damp(f.y, f.slot.y, motion.playDealReorderLambda, dt, reduced);
    const lift = f.selected ? tile.selectedLift : 0;
    f.lift = damp(f.lift, lift, motion.selectionLambda, dt, reduced);
    moving ||= f.x !== f.slot.x || f.y !== f.slot.y || f.lift !== lift;
  }
  return moving;
}
export function footprint(slot: Rect): Rect {
  return {
    ...slot,
    x: slot.x + tile.footprint.dx,
    y: slot.y + tile.footprint.dy,
  };
}
export function underline(slot: Rect): Rect {
  return {
    x: slot.x + tile.underline.inset,
    y: slot.y + tile.underline.dy,
    w: slot.w - 2 * tile.underline.inset,
    h: tile.underline.h,
  };
}
export const pitch = (55 * Math.PI) / 180;
export function worldAt(
  x: number,
  y: number,
  height: number,
): [number, number, number] {
  return [
    x - frame.width / 2,
    height,
    (height * Math.cos(pitch) + y - frame.sceneHeight / 2) / Math.sin(pitch),
  ];
}
