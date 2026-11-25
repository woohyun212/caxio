import { surfaceColor } from "../../apps/web/src/table/verify/coverage";
import {
  loadLayout,
  loadView,
  patch,
  sheetCells,
} from "../../apps/web/src/table/verify/specimen";
import { tileRect } from "../../apps/web/src/visual/assets";
import { handOrder, type Rect } from "../../apps/web/src/visual/layout";
import {
  bayerLight,
  frame,
  palette,
  stage,
  targetY,
  tile,
} from "../../apps/web/src/visual/tokens";
import type { Raster } from "./png";

export function median(a: readonly number[]) {
  if (!a.length) throw Error("No samples");
  const s = a.toSorted((x, y) => x - y),
    i = Math.floor(s.length / 2);
  const high = s[i],
    low = s[s.length % 2 ? i : i - 1];
  if (high === undefined || low === undefined) throw Error("Missing median");
  return (low + high) / 2;
}
export function rgb(a: ArrayLike<number>, i = 0) {
  const r = a[i],
    g = a[i + 1],
    b = a[i + 2];
  if (r === undefined || g === undefined || b === undefined)
    throw Error("Missing RGB");
  return (r << 16) | (g << 8) | b;
}
const colors = Object.values(palette).map((c) => rgb(c)),
  [ink, pine, sage, paper] = colors as [
    number,
    number,
    number,
    number,
    ...number[],
  ];
export function pixel(im: Raster, x: number, y: number) {
  return rgb(im.data, (y * im.width + x) * 4);
}
export function compare(logical: Raster, actual: Raster, scale: number) {
  if (
    actual.width !== logical.width * scale ||
    actual.height !== logical.height * scale
  )
    throw Error(
      "Unexpected capture size " +
        actual.width +
        "x" +
        actual.height +
        " at " +
        scale,
    );
  const first = new Int32Array(logical.width * logical.height).fill(-1),
    mixed = new Set<number>();
  let difference = 0;
  for (let y = 0; y < actual.height; y++)
    for (let x = 0; x < actual.width; x++) {
      const lx = Math.ceil((x + 0.5) / scale) - 1,
        ly = Math.ceil((y + 0.5) / scale) - 1,
        idx = ly * logical.width + lx,
        v = pixel(actual, x, y);
      if (v !== pixel(logical, lx, ly)) difference++;
      if (first[idx] === -1) first[idx] = v;
      else if (first[idx] !== v) mixed.add(idx);
    }
  return { difference, mixed: mixed.size };
}
function inRect(x: number, y: number, r: Rect, b = 0) {
  return x >= r.x - b && x < r.x + r.w + b && y >= r.y - b && y < r.y + r.h + b;
}
export function sheetReference(atlas: Raster): Raster {
  const width = frame.width,
    height = frame.sceneHeight,
    data = new Uint8Array(width * height * 4);
  function fill(r: Rect, paint: (x: number, y: number) => number) {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = paint(x, y),
          i = (y * width + x) * 4;
        data[i] = c >> 16;
        data[i + 1] = c >> 8;
        data[i + 2] = c;
        data[i + 3] = 255;
      }
  }
  fill({ x: 0, y: 0, w: width, h: height }, () => sage);
  for (const { dest, source } of sheetCells)
    fill(dest, (x, y) => {
      const ax = source.x + x - dest.x,
        ay = source.y + y - dest.y;
      return atlas.data[(ay * atlas.width + ax) * 4 + 3] === 255
        ? pixel(atlas, ax, ay)
        : sage;
    });
  colors.forEach((c, i) => {
    fill(patch(i, 0), () => c);
    fill(patch(i, 24), () => c);
  });
  for (let i = 0; i <= 16; i++)
    fill(patch(i, 48), (x, y) =>
      bayerLight(x, targetY(height, y), i / 16) ? pine : ink,
    );
  return { width, height, data };
}
export function sheetLayers(reference: Raster, actual: Raster) {
  function check(rects: Rect[]) {
    const m = mask();
    for (const r of rects)
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++)
          judgeColor(m, pixel(actual, x, y), [pixel(reference, x, y)]);
    return m;
  }
  return {
    faces: check(sheetCells.map((c) => c.dest)),
    coverageSwatches: check(colors.map((_, i) => patch(i, 0))),
    atlasSwatches: check(colors.map((_, i) => patch(i, 24))),
    bayer: check(Array.from({ length: 17 }, (_, i) => patch(i, 48))),
  };
}
export function mask() {
  return { pixels: 0, difference: 0 };
}
export function judgeColor(
  m: ReturnType<typeof mask>,
  c: number,
  allowed: readonly number[],
) {
  m.pixels++;
  if (!allowed.includes(c)) m.difference++;
}
const faces = (selected: boolean) =>
  [false, true].flatMap((hand) =>
    handOrder(
      hand ? (loadView.ownHand ?? []) : (loadView.tableHand ?? []),
      15,
    ).map((t, i) => {
      const slot = (hand ? loadLayout.hand : loadLayout.table)[i];
      if (!slot) throw Error("Missing slot");
      const lifted =
        selected &&
        hand &&
        t.number === loadView.ownHand?.[0]?.number &&
        t.suit === loadView.ownHand?.[0]?.suit;
      return {
        slot,
        rect: { ...slot, y: slot.y - (lifted ? tile.selectedLift : 0) },
        source: tileRect(t.number, t.suit, "wide"),
        shadow: {
          ...slot,
          x: slot.x + tile.footprint.dx,
          y: slot.y + tile.footprint.dy,
        },
        hand,
        lifted,
      };
    }),
  );
export function judgeLoad(im: Raster, atlas: Raster, selected = false) {
  const m = {
    whole: mask(),
    faces: mask(),
    handFaces: mask(),
    tableFaces: mask(),
    felt: mask(),
    floor: mask(),
    feltInside: mask(),
    feltBand: mask(),
    floorInside: mask(),
    floorBand: mask(),
    rim: mask(),
    tableSide: mask(),
    rackSide: mask(),
    backs: mask(),
    underline: mask(),
  };
  const cards = faces(selected),
    deck = stage.stadium,
    pitch = (55 * Math.PI) / 180;
  const rackHalf =
    (stage.rackDepth * Math.sin(pitch) + stage.rackHeight * Math.cos(pitch)) /
    2;
  const backHalf =
    (stage.backMesh.height * Math.cos(pitch + stage.backMesh.rotationX) +
      stage.backMesh.depth * Math.sin(pitch + stage.backMesh.rotationX)) /
    2;
  // Three samples each ellipse at twice curveSegments. Interpolate the projected silhouette between vertices.
  const halfHeights = Array.from({ length: im.width }, (_, x) => {
    const dx = Math.max(0, Math.abs(x + 0.5 - deck.x) - deck.centerSpacing / 2);
    if (dx >= deck.halfHeight) return -1;
    if (dx === 0) return deck.halfHeight;
    const angle = Math.asin(dx / deck.halfHeight),
      step = Math.PI / 20;
    const a = Math.floor(angle / step) * step,
      b = a + step;
    const t =
      (dx / deck.halfHeight - Math.sin(a)) / (Math.sin(b) - Math.sin(a));
    return deck.halfHeight * ((1 - t) * Math.cos(a) + t * Math.cos(b));
  });
  for (let y = 0; y < im.height; y++)
    for (let x = 0; x < im.width; x++) {
      const c = pixel(im, x, y),
        px = x + 0.5,
        py = y + 0.5;
      judgeColor(m.whole, c, colors);
      const under = cards.find(
        (f) =>
          f.lifted &&
          inRect(x, y, {
            ...f.slot,
            y: f.slot.y + tile.underline.dy,
            h: tile.underline.h,
          }),
      );
      if (under) {
        judgeColor(m.underline, c, [ink]);
        continue;
      }
      const face = cards.find((f) => inRect(x, y, f.rect));
      if (face) {
        const ax = face.source.x + x - face.rect.x,
          ay = face.source.y + y - face.rect.y;
        if (atlas.data[(ay * atlas.width + ax) * 4 + 3] === 255) {
          const allowed = [pixel(atlas, ax, ay)];
          judgeColor(m.faces, c, allowed);
          judgeColor(face.hand ? m.handFaces : m.tableFaces, c, allowed);
          continue;
        }
      }
      const rack = loadLayout.seats.find(
        (s) => Math.abs(px - s.centerX) < stage.rackWidth / 2,
      );
      if (rack) {
        const half = (stage.backWidth + (12 - 1) * stage.backPitch) / 2;
        if (
          Math.abs(px - rack.centerX) < half &&
          Math.abs(py - stage.backY - stage.backHeight / 2) < backHalf
        ) {
          judgeColor(m.backs, c, [ink, sage]);
          continue;
        }
        if (
          py >
            stage.rackCenterY + rackHalf - stage.rackHeight * Math.cos(pitch) &&
          py < stage.rackCenterY + rackHalf
        ) {
          judgeColor(m.rackSide, c, [ink, pine]);
          continue;
        }
        if (Math.abs(py - stage.rackCenterY) < rackHalf) continue;
      }
      const dx = Math.max(Math.abs(px - deck.x) - deck.centerSpacing / 2, 0),
        dy = py - deck.y,
        edge = deck.halfHeight - Math.hypot(dx, dy);
      const inside = cards.some((f) => inRect(x, y, f.shadow)),
        band =
          !inside &&
          cards.some((f) => inRect(x, y, f.shadow, tile.footprint.band));
      const half = halfHeights[x] ?? -1,
        top = half >= 0 && Math.abs(dy) < half;
      const side = half >= 0 && dy >= half && dy < half + 9 * Math.cos(pitch);
      if (edge > 6 || (!top && !side)) {
        const floor = !top,
          expected = rgb(surfaceColor(x, y, edge, floor, inside, band));
        judgeColor(floor ? m.floor : m.felt, c, [expected]);
        if (inside || band)
          judgeColor(
            floor
              ? inside
                ? m.floorInside
                : m.floorBand
              : inside
                ? m.feltInside
                : m.feltBand,
            c,
            [expected],
          );
      } else if (top) {
        judgeColor(m.rim, c, [ink, paper, sage, pine]);
      } else if (side) {
        judgeColor(m.tableSide, c, [ink, pine]);
      }
    }
  return m;
}
export function faceAnchors(im: Raster, atlas: Raster, selected: boolean) {
  return faces(selected).map((f) => {
    let bestY = f.rect.y,
      bestError = Infinity;
    // Register the opaque atlas pixels to the target, including the four ledge rows.
    for (let dy = -tile.selectedLift - 1; dy <= tile.selectedLift + 1; dy++) {
      const top = f.slot.y + dy;
      let error = 0;
      for (let y = 0; y < f.source.h; y++)
        for (let x = 0; x < f.source.w; x++) {
          const ax = f.source.x + x,
            ay = f.source.y + y;
          if (
            atlas.data[(ay * atlas.width + ax) * 4 + 3] === 255 &&
            (top + y >= im.height ||
              pixel(atlas, ax, ay) !== pixel(im, f.rect.x + x, top + y))
          )
            error++;
        }
      if (error < bestError || (error === bestError && top === f.rect.y)) {
        bestError = error;
        bestY = top;
      }
    }
    return {
      layer: f.hand ? "hand" : "table",
      selected: f.lifted,
      x: f.rect.x,
      y: bestY,
      expectedY: f.rect.y,
      difference: bestError,
    };
  });
}
export function movedOutside(before: Raster, after: Raster) {
  const face = faces(true).find((f) => f.lifted);
  if (!face) throw Error("Missing selected face");
  let outside = 0,
    changed = 0;
  for (let y = 0; y < before.height; y++)
    for (let x = 0; x < before.width; x++)
      if (pixel(before, x, y) !== pixel(after, x, y)) {
        changed++;
        if (
          !inRect(x, y, face.slot) &&
          !inRect(x, y, face.rect) &&
          !inRect(x, y, face.shadow, tile.footprint.band)
        )
          outside++;
      }
  return { outside, changed };
}
