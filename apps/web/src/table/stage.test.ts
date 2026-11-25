import { expect, test } from "bun:test";
import {
  phaseExamples,
  spectatorExamples,
} from "@caxio/shared/contracts/fixtures";
import type { PlayerView } from "@caxio/shared/contracts/wire";
import * as T from "three";
import type { TableProps } from "../contracts";
import { atlases, backRect, tileRect } from "../visual/assets";
import { layout } from "../visual/layout";
import { frame, motion, stage } from "../visual/tokens";
import { TableLifecycle, watchCanvasPhase } from "./index";
import {
  advance,
  damp,
  footprint,
  model,
  phaseTransform,
  underline,
  worldAt,
} from "./model";
import { atlasUV, cameraForTable, TableStage } from "./stage";
import { loadLayout, loadView } from "./verify/specimen";

function props(view: PlayerView = loadView): TableProps {
  return {
    view,
    layout: layout(
      view.seatOrder,
      view.seatOrder[0] ?? 0,
      view.ownHand?.length ?? 0,
      view.tableHand?.length ?? 0,
    ),
    selected: [],
    reducedMotion: false,
    k: 1,
    onReady() {},
    onFailure() {},
  };
}
function need<T>(v: T | undefined) {
  if (v === undefined) throw Error("Missing fixture");
  return v;
}
test("both damp rates are independent of refresh rate and stop at rest", () => {
  for (const lambda of [motion.selectionLambda, motion.playDealReorderLambda]) {
    const values = [30, 60, 120].map((hz) => {
      let x = -500;
      for (let i = 0; i < hz / 2; i++) x = damp(x, 3, lambda, 1 / hz, false);
      return x;
    });
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(
      0.001,
    );
  }
  const m = model(props()),
    f = need(m.faces[0]);
  f.x += 0.0009;
  f.y -= 0.0008;
  f.lift = 0.0001;
  expect(advance(m, 0, false)).toBe(false);
  expect(f.x).toBe(f.slot.x);
  expect(f.y).toBe(f.slot.y);
  f.x += 15;
  expect(advance(m, 0, false)).toBe(true);
  expect(advance(m, 0, true)).toBe(false);
  expect(f.x).toBe(f.slot.x);
});
test("wire arrays are sorted by round rank into layout slots without mutation", () => {
  for (const max of [9, 13, 15] as const) {
    const tiles = [
      { number: 2, suit: 1 },
      { number: 3, suit: 1 },
      { number: max, suit: 3 },
      { number: 1, suit: 2 },
      { number: 3, suit: 0 },
    ] as const;
    const p = props({
        ...loadView,
        maxNumber: max,
        ownHand: tiles,
        tableHand: tiles,
      }),
      saved = JSON.stringify(p.view);
    const m = model({ ...p, selected: [tiles[4]] });
    for (const hand of [true, false]) {
      const group = m.faces.filter((f) => f.hand === hand);
      expect(group.map((f) => f.tile)).toEqual([
        tiles[4],
        tiles[1],
        tiles[2],
        tiles[3],
        tiles[0],
      ]);
      expect(group.map((f) => f.slot)).toEqual([
        ...(hand ? p.layout.hand : p.layout.table),
      ]);
      group.forEach((f) => {
        expect(f.x).toBe(f.slot.x);
        expect(f.y).toBe(f.slot.y);
      });
    }
    const f = need(m.faces.find((f) => f.selected));
    expect(f.y - f.lift).toBe(146);
    expect(underline(f.slot)).toEqual({ ...f.slot, y: 189, h: 2 });
    expect(footprint(f.slot)).toEqual({ ...f.slot, x: f.slot.x + 2, y: 153 });
    expect(JSON.stringify(p.view)).toBe(saved);
  }
});
test("slot extents, empty hands, zero backs, missing slots", () => {
  for (const [count, span] of [
    [12, 358],
    [13, 388],
  ] as const) {
    const l = layout(loadView.seatOrder, 0, count, 5);
    for (const [rects, width] of [
      [l.hand, span],
      [l.table, 148],
    ] as const) {
      const first = need(rects[0]),
        last = need(rects.at(-1));
      expect(last.x + last.w - first.x).toBe(width);
      rects.slice(1).forEach((r, i) => {
        const prev = need(rects[i]);
        expect(prev.x + prev.w).toBeLessThan(r.x);
      });
    }
  }
  expect(
    model(props(spectatorExamples.following.view)).faces.filter((f) => f.hand),
  ).toHaveLength(0);
  expect(model(props(phaseExamples[0].view)).faces).toEqual([]);
  expect(
    model({ ...props(), layout: { ...loadLayout, hand: [] } }).faces.filter(
      (f) => f.hand,
    ),
  ).toEqual([]);
  expect(
    model(props({ ...loadView, tableHand: null })).faces.every((f) => f.hand),
  ).toBe(true);
  expect(model(props()).racks.map((r) => r.count)).toEqual([12, 12, 12, 12]);
  expect(
    model(props(phaseExamples[0].view)).racks.every((r) => r.count === 0),
  ).toBe(true);
});
test("play and deal start at previous hand, reduced rack, and centre", () => {
  const p = props(),
    old = model(p),
    f = need(old.faces.find((f) => f.hand)),
    t = f.tile;
  const base = {
    ...loadView,
    tableHand: [t],
    ownHand: loadView.ownHand?.filter((s) => s !== t) ?? [],
  };
  const me = need(
    model(
      props({ ...base, lastPlay: { turnId: 2, seatId: 0, tiles: [t] } }),
      old,
    ).faces[0],
  );
  expect([me.x, me.y]).toEqual([f.x, f.y]);
  const newTile = { number: 15, suit: 3 } as const;
  const seat = need(loadView.slots[1] ?? undefined);
  const opp = model(
    props({
      ...base,
      slots: [
        loadView.slots[0],
        { ...seat, remainingTileCount: 11 },
        loadView.slots[2],
        loadView.slots[3],
        loadView.slots[4],
      ],
      tableHand: [newTile],
      lastPlay: { turnId: 2, seatId: 1, tiles: [newTile] },
    }),
    old,
  );
  const played = need(opp.faces[0]),
    rack = need(opp.racks[0]);
  expect([played.x + 14, played.y + 20, rack.count]).toEqual([rack.x, 26, 11]);
  const next = model(props({ ...loadView, round: 2, tableHand: null }), old);
  expect(
    next.faces.every(
      (f) => f.x + 14 === stage.stadium.x && f.y + 20 === stage.stadium.y,
    ),
  ).toBe(true);
});
test("pitched world coordinates project into seat columns and integer face corners", () => {
  const camera = cameraForTable();
  function projected(v: T.Vector3) {
    const p = v.project(camera);
    return [
      ((p.x + 1) * frame.width) / 2,
      ((1 - p.y) * frame.sceneHeight) / 2,
    ] as const;
  }
  expect(loadLayout.seats.map((s) => s.centerX)).toEqual([52, 156, 260, 364]);
  for (let n = 3; n <= 5; n++)
    for (const s of layout(loadView.seatOrder.slice(0, n), 0, 0, 0).seats) {
      const [x, y] = projected(
        new T.Vector3(...worldAt(s.centerX, stage.rackCenterY, 1)),
      );
      expect(x).toBeCloseTo(s.centerX, 9);
      expect(y).toBeCloseTo(26, 9);
      expect(x - stage.rackWidth / 2).toBeGreaterThanOrEqual(s.rack.x);
      expect(x + stage.rackWidth / 2).toBeLessThanOrEqual(s.rack.x + s.rack.w);
    }
  const st = new TableStage(new T.Texture()),
    r = need(loadLayout.hand[0]),
    mesh = st.plane(st.scene, r, 201, st.atlas);
  mesh.updateMatrixWorld();
  for (const sign of [-1, 1]) {
    const [x, y] = projected(
      mesh.localToWorld(new T.Vector3((sign * r.w) / 2, (-sign * r.h) / 2, 0)),
    );
    expect(x).toBeCloseTo(r.x + ((sign + 1) * r.w) / 2, 9);
    expect(y).toBeCloseTo(r.y + ((sign + 1) * r.h) / 2, 9);
  }
  st.dispose();
});
test("face and back texel centres, phase correction", () => {
  const rects = [backRect];
  const cells = [
    ...rects.map(
      (r) => ({ ...r }) as { x: number; y: number; w: number; h: number },
    ),
  ];
  for (let s = 0; s < 4; s++)
    for (let n = 1; n <= 15; n++) cells.push(tileRect(n, s, "wide"));
  for (const r of cells)
    for (const x of [0, r.w - 1])
      for (const y of [0, r.h - 1]) {
        const [u, v] = atlasUV(r, (x + 0.5) / r.w, (y + 0.5) / r.h);
        expect(u * atlases.wide.width).toBeCloseTo(r.x + x + 0.5, 9);
        expect((1 - v) * atlases.wide.height).toBeCloseTo(r.y + y + 0.5, 9);
      }
  for (const k of [1, 2, 3, 4])
    for (const dpr of [1, 1.25, 2])
      expect(phaseTransform(k, dpr)).toBe(
        dpr === 1.25 && k < 4 ? "translate(0.015625px, 0.015625px)" : "none",
      );
});
test.each([1, 4])(
  "canvas phase at k=%i follows current resolution and resize until cleanup",
  (k) => {
    const queries: { query: string; events: EventTarget }[] = [];
    const viewport = Object.assign(new EventTarget(), {
      devicePixelRatio: 1,
      matchMedia(query: string) {
        const events = new EventTarget();
        queries.push({ query, events });
        return events;
      },
    });
    const style = { imageRendering: "", transform: "" };
    const cleanup = watchCanvasPhase(style, k, viewport);
    const translated = "translate(0.015625px, 0.015625px)";
    expect(style).toEqual({ imageRendering: "pixelated", transform: "none" });
    for (const [i, dpr] of [1.25, 2].entries()) {
      const oldQuery = need(queries[i]).events;
      viewport.devicePixelRatio = dpr;
      oldQuery.dispatchEvent(new Event("change"));
      expect(style.transform).toBe(
        k === 1 && dpr === 1.25 ? translated : "none",
      );
      expect(need(queries[i + 1]).query).toBe(`(resolution: ${dpr}dppx)`);
      oldQuery.dispatchEvent(new Event("change"));
      expect(queries).toHaveLength(i + 2);
    }
    viewport.devicePixelRatio = 1.125;
    viewport.dispatchEvent(new Event("resize"));
    expect(style.transform).toBe(translated);
    expect(queries.map((q) => q.query)).toEqual([
      "(resolution: 1dppx)",
      "(resolution: 1.25dppx)",
      "(resolution: 2dppx)",
      "(resolution: 1.125dppx)",
    ]);
    need(queries[2]).events.dispatchEvent(new Event("change"));
    expect(queries).toHaveLength(4);
    cleanup();
    viewport.devicePixelRatio = 1;
    viewport.dispatchEvent(new Event("resize"));
    need(queries[3]).events.dispatchEvent(new Event("change"));
    expect(style.transform).toBe(translated);
    expect(queries).toHaveLength(4);
  },
);
test("initialization, display and terminal failure use one-shot notifications", () => {
  for (const scenario of [
    "preflight",
    "factory",
    "loss-before",
    "loss-after",
    "success",
  ]) {
    let failures = 0,
      ready = 0,
      calls = 0;
    const l = new TableLifecycle({
      onFailure: () => failures++,
      onReady: () => ready++,
    });
    const events = new EventTarget();
    const cleanup = l.watchContext(events);
    const init = () =>
      l.renderer({} as HTMLCanvasElement, {
        preflight: () => scenario !== "preflight",
        createRenderer: () => {
          calls++;
          if (scenario === "factory") throw Error("factory");
          return {} as T.WebGLRenderer;
        },
      });
    if (["preflight", "factory"].includes(scenario)) expect(init).toThrow();
    else init();
    if (scenario === "loss-before")
      events.dispatchEvent(new Event("webglcontextlost"));
    l.ready();
    l.ready();
    if (scenario !== "success") {
      events.dispatchEvent(new Event("webglcontextlost"));
      events.dispatchEvent(new Event("webglcontextlost"));
      l.ready();
    }
    cleanup();
    expect(calls).toBe(scenario === "preflight" ? 0 : 1);
    expect(ready).toBe(["success", "loss-after"].includes(scenario) ? 1 : 0);
    expect(failures).toBe(scenario === "success" ? 0 : 1);
  }
});
test("stage disposal releases every allocated scene resource", () => {
  const st = new TableStage(new T.Texture());
  st.update(props());
  const resources = new Set<
    T.Material | T.BufferGeometry | T.Texture | T.WebGLRenderTarget
  >([st.target, st.texture]);
  for (const s of [st.scene, st.copyScene])
    s.traverse((o) => {
      if (o instanceof T.Mesh) {
        resources.add(o.geometry);
        resources.add(o.material);
      }
    });
  const disposed = new Set();
  for (const r of resources)
    r.addEventListener("dispose", () => disposed.add(r));
  st.dispose();
  expect(disposed.size).toBe(resources.size);
});
