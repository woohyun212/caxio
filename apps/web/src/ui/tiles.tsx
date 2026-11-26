import type { Tile } from "@caxio/shared/contracts/domain";
import type { PlayerView } from "@caxio/shared/contracts/wire";
import type { CSSProperties } from "react";
import { atlases, backRect, tileRect } from "../visual/assets";
import type { Layout, Mode, Rect } from "../visual/layout";
import { stage, tile } from "../visual/tokens";
import { activate, passedSeats, seatName, tileName } from "./state";

export function box(rect: Rect | undefined): CSSProperties | undefined {
  return (
    rect && {
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
    }
  );
}
function sprite(mode: Mode, r: Rect): CSSProperties {
  const scale = mode === "wide" ? 1 : tile.compactScale,
    a = atlases[mode];
  return {
    backgroundImage: `url(${a.url})`,
    backgroundSize: `${a.width * scale}px ${a.height * scale}px`,
    backgroundPosition: `${-r.x * scale}px ${-r.y * scale}px`,
  };
}
export function Tiles({
  tiles,
  slots,
  mode,
  hand,
}: {
  tiles: readonly Tile[];
  slots: readonly Rect[];
  mode: Mode;
  hand?: {
    selected: readonly Tile[];
    reason: string;
    describedBy: string;
    toggle: (t: Tile) => void;
  };
}) {
  return (
    <div className={hand ? "gc-hand" : "gc-table"}>
      {tiles.map((t, i) => {
        const name = tileName(t),
          cell = tileRect(t.number, t.suit, mode),
          style =
            mode === "wide"
              ? box(slots[i])
              : {
                  width: cell.w * tile.compactScale,
                  height: cell.h * tile.compactScale,
                };
        const face = (
          <span key={name} className="gc-face">
            <span>{name}</span>
            <span className="gc-sprite" style={sprite(mode, cell)} />
          </span>
        );
        return hand ? (
          <button
            type="button"
            className="gc-tile"
            data-slot={i}
            key={name}
            style={style}
            aria-label={name}
            aria-pressed={hand.selected.some(
              (s) => s.number === t.number && s.suit === t.suit,
            )}
            aria-disabled={hand.reason ? true : undefined}
            aria-describedby={hand.reason ? hand.describedBy : undefined}
            onClick={() => activate(hand.reason, () => hand.toggle(t))}
          >
            {face}
          </button>
        ) : (
          <span
            className="gc-tile"
            key={name}
            style={style}
            role="img"
            aria-label={name}
          >
            {face}
          </span>
        );
      })}
    </div>
  );
}
export function Seats({
  view,
  layout,
  mode,
  opaque,
}: {
  view: PlayerView;
  layout: Layout;
  mode: Mode;
  opaque: boolean;
}) {
  const passed = passedSeats(view);
  return (
    <div className="gc-seats">
      {layout.seats.map(({ seatId, centerX, nameplate, rack }) => {
        const s = view.slots[seatId];
        if (!s) return null;
        const active = seatId === view.currentTurn;
        const state = s.isOut
          ? "탈락"
          : !s.isConnected
            ? "끊김"
            : passed.has(seatId)
              ? "패스"
              : "";
        const name = seatName(view, seatId),
          label = `${name} ${s.remainingTileCount}장 ${s.chips}칩`;
        const wide = mode === "wide";
        return (
          <section
            className="gc-seat"
            key={seatId}
            aria-label={[
              label,
              s.isConnected ? "접속" : "끊김",
              state,
              active ? "차례" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {wide &&
              opaque &&
              Array.from({ length: s.remainingTileCount }, (_, i) => {
                const x =
                  Math.floor(
                    centerX -
                      (stage.backWidth +
                        stage.backPitch * (s.remainingTileCount - 1)) /
                        2,
                  ) +
                  stage.backPitch * i;
                return (
                  <span
                    key={x}
                    className="gc-back"
                    style={{
                      ...box({ ...backRect, x, y: stage.backY }),
                      ...sprite("wide", backRect),
                    }}
                  />
                );
              })}
            <span
              className={active ? "gc-plate gc-current" : "gc-plate"}
              style={wide ? box(nameplate) : undefined}
            >
              {wide ? name : label}
              {!wide && active ? " 차례" : ""}
            </span>
            {state && (
              <span
                className="gc-seat-state"
                style={wide ? box({ ...rack, h: 14 }) : undefined}
              >
                {state}
              </span>
            )}
          </section>
        );
      })}
    </div>
  );
}
