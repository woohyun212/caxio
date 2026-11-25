import {
  bayerLight,
  feltCoverage,
  frame,
  palette,
  stage,
  targetY,
} from "../../visual/tokens";
export function surfaceColor(
  x: number,
  y: number,
  edge: number,
  floor: boolean,
  inside: boolean,
  band: boolean,
) {
  if (floor && !inside && !band) return palette.sage;
  const deck = stage.stadium;
  const c = floor
    ? 0.5
    : feltCoverage(edge - deck.inkWidth - deck.paperWidth - deck.sageWidth);
  const light = bayerLight(
    x,
    targetY(frame.sceneHeight, y),
    inside ? 0 : band && !floor ? c / 2 : c,
  );
  return floor
    ? light
      ? palette.sage
      : palette.pine
    : light
      ? palette.pine
      : palette.ink;
}
