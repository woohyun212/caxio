import { expect, mock, test } from "bun:test";
import type { Tile } from "@caxio/shared/contracts/domain";
import {
  effectBatches,
  lastPlaySequence,
  phaseExamples,
  previewExamples,
  previewRejectionOrder,
  representativeExamples,
  roomCode,
  spectatorExamples,
} from "@caxio/shared/contracts/fixtures";
import {
  type Command,
  errorText,
  type Snapshot,
} from "@caxio/shared/contracts/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import viteConfig from "../vite.config";
import { createClientSession } from "./client";
import type {
  ClientSession,
  CreateClientSession,
  TableProps,
} from "./contracts";
import {
  browserSocket,
  createScene,
  GameApp,
  preview,
  startSession,
} from "./main";
import { TableLifecycle } from "./table";
import { requestTurn } from "./ui/state";

test("preview replays every frozen example and prioritizes competing rejections", () => {
  for (const ex of [...previewExamples, ...representativeExamples])
    expect(preview(ex.selected, ex.tableHand, ex.maxNumber)).toEqual(ex.result);
  const low: Tile = { number: 3, suit: 0 };
  const high: Tile = { number: 7, suit: 1 };
  const cases = [
    [],
    [low, low, low, low],
    [low, high],
    [low, { ...low, suit: 2 }],
    [low],
  ] as const;
  for (const [i, reason] of previewRejectionOrder.entries()) {
    const selected = cases[i];
    if (!selected) throw Error("Missing precedence case");
    expect(preview(selected, [high], 9)).toEqual({
      ok: false,
      reason,
    });
  }
  expect(preview([{ number: 10, suit: 1 }], null, 9)).toEqual({
    ok: false,
    reason: "ILLEGAL_HAND",
  });
  expect(preview([low], [{ number: 10, suit: 1 }], 9)).toEqual({
    ok: false,
    reason: "ILLEGAL_HAND",
  });
});

class Socket extends EventTarget {
  commands: Command[] = [];
  send(raw: string) {
    this.commands.push(JSON.parse(raw));
  }
  close() {}
  receive(frame: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }
}

function harness(origin = "https://game.test", restore = false) {
  const socket = new Socket();
  const connect = mock((_url: string) => socket);
  const audio = { play: mock(), unlock: mock(), dispose: mock() };
  const resume = mock();
  const create: CreateClientSession = (deps) => {
    const session = createClientSession(deps);
    return {
      ...session,
      resume() {
        resume();
        session.resume();
      },
    };
  };
  const storage = {
    getItem(key: string) {
      return restore && key === "caxio.credential"
        ? JSON.stringify({ roomCode, token: "testing" })
        : null;
    },
    setItem() {},
    removeItem() {},
  };
  const session = startSession(
    browserSocket(origin, connect),
    storage,
    audio,
    create,
  );
  function seated(snapshot: Snapshot, seatId = 0) {
    if (!restore) session.createRoom();
    socket.dispatchEvent(new Event("open"));
    socket.receive({ type: "SEATED", seatId, token: "testing", roomCode });
    socket.receive(snapshot);
    expect(session.getState().view).toEqual(snapshot.view);
  }
  return { session, socket, connect, audio, resume, seated };
}

const wide = { width: 1281, height: 801 };
const compact = { width: 360, height: 640 };
function markup(
  session: ClientSession,
  scene = createScene(),
  viewport = wide,
) {
  return renderToStaticMarkup(
    createElement(GameApp, {
      session,
      scene,
      ...viewport,
      reducedMotion: false,
    }),
  );
}
const canvas = () => createElement("canvas");

test("tab startup resumes once, derives both socket schemes and delivers only audible effect batches", () => {
  for (const restore of [false, true]) {
    const host = restore ? "https://game.test" : "http://game.test";
    const h = harness(host, restore);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(restore ? 1 : 0);
    const [first, ...later] = lastPlaySequence.continuing;
    h.seated(first);
    expect(h.connect.mock.calls).toEqual([
      [`${restore ? "wss" : "ws"}://game.test/ws`],
    ]);
    expect(h.socket.commands[0]?.type).toBe(restore ? "RESUME" : "CREATE_ROOM");
    expect(h.audio.play).not.toHaveBeenCalled();
    h.session.setMuted(restore);
    for (const frame of later) {
      h.socket.receive(frame);
      h.socket.receive(frame);
    }
    expect(h.audio.play.mock.calls).toEqual(
      restore ? [] : [[effectBatches[3]]],
    );
  }
});

test("blocked tab storage still permits startup and room creation", () => {
  const blocked = () => {
    throw Error("storage blocked");
  };
  const open = mock(() => new Socket());
  const session = startSession(
    open,
    { getItem: blocked, setItem: blocked, removeItem: blocked },
    { play() {}, unlock() {}, dispose() {} },
  );
  expect(open).not.toHaveBeenCalled();
  session.createRoom();
  expect(open).toHaveBeenCalledTimes(1);
});

test("scene import waits for a wide lobby and loads once", async () => {
  const load = mock(async () => ({ GameTable: canvas }));
  const scene = createScene(load);
  for (const frame of phaseExamples) await scene.prepare("compact", frame.view);
  await scene.prepare("wide", null);
  expect(load).not.toHaveBeenCalled();
  await scene.prepare("wide", phaseExamples[0].view);
  await scene.prepare("wide", phaseExamples[2].view);
  expect(load).toHaveBeenCalledTimes(1);
});

function follow() {
  const h = harness();
  const initial = lastPlaySequence.continuing[0];
  const tile: Tile = { number: 1, suit: 0 };
  h.seated({ ...initial, view: { ...initial.view, ownHand: [tile] } }, 1);
  h.session.toggleTile(tile);
  return { ...h, tile };
}

function clickAction(session: ClientSession, kind: "play" | "pass") {
  const model = session.getState();
  const view = model.view;
  if (!view?.maxNumber) throw Error("Expected game");
  requestTurn(
    model,
    preview(model.selected, view.tableHand, view.maxNumber),
    kind,
    performance.now(),
    session[kind],
  );
}

test("first-frame readiness, centered frame and mode changes preserve pending selection", async () => {
  const h = follow();
  const scene = createScene(async () => ({ GameTable: canvas }));
  await scene.prepare("wide", h.session.getState().view);
  const before = markup(h.session, scene);
  for (const part of [
    "gc-opaque",
    "data-slot=",
    "gc-submit",
    "gc-pass",
    "width:1248px",
    "height:750px",
    "left:16px",
    "top:25px",
  ])
    expect(before).toContain(part);
  scene.onReady();
  expect(markup(h.session, scene)).toContain("gc-canvas");
  clickAction(h.session, "play");
  const pending = h.session.getState().pending;
  expect(pending?.type).toBe("PLAY");
  scene.hide();
  for (const viewport of [compact, wide]) {
    const html = markup(h.session, scene, viewport);
    expect(html).toContain("gc-opaque");
    expect(html).toContain('aria-pressed="true"');
    expect(h.session.getState().pending).toBe(pending);
    expect(h.session.getState().selected).toEqual([h.tile]);
  }
});

for (const path of [
  "preflight",
  "renderer",
  "contextlost",
  "import",
] as const) {
  test(`${path} failure removes canvas once and preserves DOM PLAY/PASS`, async () => {
    const h = follow();
    const Table = mock((_props: TableProps) => canvas());
    const scene = createScene(async () => {
      if (path === "import") throw Error("chunk unavailable");
      return { GameTable: Table };
    });
    const failures = mock();
    scene.subscribe((state, prev) => {
      if (state.failed && !prev.failed) failures();
    });
    await scene.prepare("wide", h.session.getState().view);
    if (path !== "import") {
      expect(markup(h.session, scene)).toContain("<canvas");
      const props = Table.mock.calls[0]?.[0];
      if (!props) throw Error("table missing");
      const life = new TableLifecycle(props);
      const target = new EventTarget();
      if (path === "contextlost") {
        life.ready();
        expect(markup(h.session, scene)).toContain("gc-canvas");
        const unwatch = life.watchContext(target);
        target.dispatchEvent(new Event("webglcontextlost"));
        target.dispatchEvent(new Event("webglcontextlost"));
        unwatch();
      } else {
        const createRenderer = mock(() => {
          throw Error("no renderer");
        });
        expect(() =>
          life.renderer(target as HTMLCanvasElement, {
            preflight: () => path === "renderer",
            createRenderer,
          }),
        ).toThrow();
        expect(createRenderer).toHaveBeenCalledTimes(
          path === "renderer" ? 1 : 0,
        );
        life.failure();
      }
    }
    await scene.prepare("wide", h.session.getState().view);
    expect(failures).toHaveBeenCalledTimes(1);
    expect(scene.getState().ready).toBe(false);
    const html = markup(h.session, scene);
    expect(html).not.toContain("<canvas");
    for (const part of [
      "gc-opaque",
      "data-slot=",
      "gc-submit",
      "gc-pass",
      'aria-pressed="true"',
    ])
      expect(html).toContain(part);
    clickAction(h.session, "play");
    expect(h.session.getState().pending?.type).toBe("PLAY");
    h.socket.receive({ type: "ERROR", code: "NOT_HIGHER" });
    expect(h.session.getState().pending).toBeNull();
    expect(h.session.getState().selected).toEqual([h.tile]);
    expect(markup(h.session, scene)).toContain(errorText("NOT_HIGHER"));
    clickAction(h.session, "pass");
    expect(h.socket.commands.slice(-2).map((c) => c.type)).toEqual([
      "PLAY",
      "PASS",
    ]);
  });
}

test("eliminated spectator has no hand tiles or turn controls", () => {
  const h = harness();
  h.seated(spectatorExamples.restored, spectatorExamples.recipient);
  const html = markup(h.session);
  expect(html).toContain("탈락 · 관전 중");
  for (const part of ["data-slot=", "gc-submit", "gc-pass"])
    expect(html).not.toContain(part);
});

test("development WS proxy uses the supplied origin and is omitted when unset", () => {
  const previous = process.env.CAXIO_DEV_SERVER_ORIGIN;
  const env = { command: "serve", mode: "development" } as const;
  try {
    process.env.CAXIO_DEV_SERVER_ORIGIN = "https://dev.test";
    expect(viteConfig(env).server?.proxy).toEqual({
      "/ws": { target: "https://dev.test", ws: true },
    });
    delete process.env.CAXIO_DEV_SERVER_ORIGIN;
    expect(viteConfig(env).server?.proxy).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.CAXIO_DEV_SERVER_ORIGIN;
    else process.env.CAXIO_DEV_SERVER_ORIGIN = previous;
  }
});

test("entry preloads the same-origin Galmuri11 font", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain(
    '<link rel="preload" href="/fonts/Galmuri11.woff2" as="font" type="font/woff2" crossorigin="anonymous">',
  );
});
