import { expect, mock, test } from "bun:test";
import type { Tile } from "@caxio/shared/contracts/domain";
import {
  abandonmentRestart,
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
  ABANDONMENT_NOTICE,
  type Command,
  type Credential,
  errorText,
  type Snapshot,
  WS_PATH,
} from "@caxio/shared/contracts/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import viteConfig from "../vite.config";
import { createClientSession } from "./client";
import type {
  ClientEffect,
  ClientSession,
  CreateClientSession,
  TableProps,
} from "./contracts";
import {
  browserSocket,
  createScene,
  GameApp,
  listenForAudioUnlock,
  listenForSeatRecovery,
  pageSockets,
  preview,
  scheduleSeatRecovery,
  startSession,
} from "./main";
import { TableLifecycle } from "./table";
import { linkedRoom, requestTurn } from "./ui/state";

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

function harness(
  origin = "https://game.test",
  restore: boolean | Credential = false,
  wrap = (open: ReturnType<typeof browserSocket>) => open,
  search = "",
) {
  const connect = mock((_url: string) => new Socket());
  function socket(index = 0) {
    const opened = connect.mock.results[index];
    if (opened?.type !== "return") throw Error(`Missing socket ${index}`);
    return opened.value;
  }
  const audio = {
    play: mock((_events: readonly ClientEffect[]) => {}),
    unlock: mock(),
    dispose: mock(),
  };
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
  const values = new Map<string, string>();
  if (restore)
    values.set(
      "caxio.credential",
      JSON.stringify(
        restore === true ? { roomCode, token: "testing" } : restore,
      ),
    );
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  const session = startSession(
    wrap(browserSocket(origin, connect)),
    storage,
    audio,
    create,
    linkedRoom(search),
  );
  function seated(snapshot: Snapshot, seatId = 0) {
    if (!restore) session.createRoom();
    socket().dispatchEvent(new Event("open"));
    socket().receive({ type: "SEATED", seatId, token: "testing", roomCode });
    socket().receive(snapshot);
    expect(session.getState().view).toEqual(snapshot.view);
  }
  return { session, socket, connect, audio, resume, seated, storage };
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
    expect(h.socket().commands[0]?.type).toBe(
      restore ? "RESUME" : "CREATE_ROOM",
    );
    expect(h.audio.play).not.toHaveBeenCalled();
    h.session.setMuted(restore);
    for (const frame of later) {
      h.socket().receive(frame);
      h.socket().receive(frame);
    }
    const batches: (readonly ClientEffect[])[] = h.audio.play.mock.calls.map(
      ([batch]) => batch.filter((event) => event.type !== "MY_TURN"),
    );
    expect(batches.filter((batch) => batch.length)).toEqual(
      restore ? [] : [effectBatches[3]],
    );
    if (restore) expect(h.audio.play).not.toHaveBeenCalled();
  }
});

const recoveryEvents = ["online", "focus", "visibilitychange"] as const;
function recoveryListeners(session: ClientSession) {
  const page = new EventTarget();
  const doc = new EventTarget();
  let visible = true;
  const cleanup = listenForSeatRecovery(page, doc, () => visible, session);
  function dispatch(event: (typeof recoveryEvents)[number], isVisible = true) {
    visible = isVisible;
    (event === "visibilitychange" ? doc : page).dispatchEvent(new Event(event));
  }
  return { dispatch, cleanup };
}

for (const trigger of [...recoveryEvents, "cleanup"] as const) {
  test(
    trigger === "cleanup"
      ? "cleanup removes all seat recovery listeners"
      : `${trigger} resumes the same seat after an exhausted retry`,
    () => {
      const h = harness();
      const { dispatch, cleanup } = recoveryListeners(h.session);
      const snapshot = phaseExamples[2];
      h.seated(snapshot);
      const credential = h.session.getState().credential;
      expect(credential).toEqual({ roomCode, token: "testing" });
      h.socket(0).dispatchEvent(new Event("close"));
      expect(h.session.getState().connection).toBe("RESTORING");
      expect(h.connect).toHaveBeenCalledTimes(2);
      for (const event of recoveryEvents) dispatch(event);
      expect(h.resume).toHaveBeenCalledTimes(1); // Startup only during the in-flight retry.
      h.socket(1).dispatchEvent(new Event("close"));
      expect(h.session.getState()).toMatchObject({
        connection: "DISCONNECTED",
        view: null,
        credential,
      });
      expect(h.connect).toHaveBeenCalledTimes(2);
      if (trigger === "cleanup") {
        cleanup();
        for (const event of recoveryEvents) dispatch(event);
        expect(h.connect).toHaveBeenCalledTimes(2);
        return;
      }
      dispatch("visibilitychange", false);
      expect(h.connect).toHaveBeenCalledTimes(2);
      dispatch(trigger);
      expect(h.connect).toHaveBeenCalledTimes(3);
      const recovered = h.socket(2);
      recovered.dispatchEvent(new Event("open"));
      expect(recovered.commands).toEqual([
        { type: "RESUME", roomCode, token: "testing" },
      ]);
      recovered.receive({
        type: "SEATED",
        roomCode,
        token: "testing",
        seatId: 0,
      });
      recovered.receive(snapshot);
      expect(h.session.getState()).toMatchObject({
        connection: "CONNECTED",
        view: snapshot.view,
        credential,
      });
      cleanup();
    },
  );
}

test("page recovery events preserve connected errors and skip sessions without credentials", () => {
  const h = harness();
  const { dispatch, cleanup } = recoveryListeners(h.session);
  for (const event of recoveryEvents) dispatch(event);
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.connect).not.toHaveBeenCalled();

  h.seated(phaseExamples[2]);
  h.socket().receive({ type: "ERROR", code: "NOT_HIGHER" });
  for (const event of recoveryEvents) {
    dispatch(event);
    expect(h.session.getState().errorCode).toBe("NOT_HIGHER");
  }
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.connect).toHaveBeenCalledTimes(1);
  cleanup();
});

test("a page hidden into the back/forward cache drops its socket and resumes the seat when shown", () => {
  for (const closeArrives of ["while hidden", "after shown"] as const) {
    let sockets: ReturnType<typeof pageSockets> | undefined;
    const h = harness("https://game.test", false, (open) => {
      sockets = pageSockets(open);
      return sockets.openSocket;
    });
    if (!sockets) throw Error("unwired");
    const page = new EventTarget();
    const stop = sockets.listen(page, h.session);
    h.seated(phaseExamples[2]);
    const credential = h.session.getState().credential;
    const close = mock();
    h.socket(0).close = close;
    page.dispatchEvent(new Event("pagehide"));
    expect(close).toHaveBeenCalledTimes(1);
    if (closeArrives === "while hidden") {
      h.socket(0).dispatchEvent(new Event("close"));
      // The immediate RESUME retry opens nothing while hidden, so the server sees the seat leave.
      expect(h.connect).toHaveBeenCalledTimes(1);
      expect(h.session.getState()).toMatchObject({
        connection: "DISCONNECTED",
        credential,
      });
    }
    page.dispatchEvent(new Event("pageshow"));
    if (closeArrives === "after shown")
      h.socket(0).dispatchEvent(new Event("close"));
    expect(h.connect).toHaveBeenCalledTimes(2);
    h.socket(1).dispatchEvent(new Event("open"));
    expect(h.socket(1).commands).toEqual([
      { type: "RESUME", roomCode, token: "testing" },
    ]);
    stop();
    const later = mock();
    h.socket(1).close = later;
    page.dispatchEvent(new Event("pagehide"));
    expect(later).not.toHaveBeenCalled();
  }
});

function recoveryClock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  return {
    timers,
    schedule(delay: number, callback: () => void) {
      timers.set(callback, now + delay);
      return () => timers.delete(callback);
    },
    advance(ms: number) {
      now += ms;
      for (const [callback, deadline] of timers) {
        if (deadline <= now) {
          timers.delete(callback);
          callback();
        }
      }
    },
  };
}

test("seat recovery without a browser event backs off to eight seconds and resets after a snapshot", () => {
  const h = harness();
  const clock = recoveryClock();
  const stop = scheduleSeatRecovery(h.session, clock.schedule);
  h.seated(phaseExamples[2]);
  function loseConnectionAndRetry() {
    h.socket(h.connect.mock.calls.length - 1).dispatchEvent(new Event("close"));
    expect(h.session.getState().connection).toBe("RESTORING");
    expect(clock.timers.size).toBe(0);
    h.socket(h.connect.mock.calls.length - 1).dispatchEvent(new Event("close"));
    expect(h.session.getState().connection).toBe("DISCONNECTED");
    expect(clock.timers.size).toBe(1);
  }
  function advanceToResume(delay: number) {
    const count = h.connect.mock.calls.length;
    clock.advance(delay - 1);
    expect(h.connect).toHaveBeenCalledTimes(count);
    clock.advance(1);
    expect(h.connect).toHaveBeenCalledTimes(count + 1);
    expect(clock.timers.size).toBe(0);
    const socket = h.socket(count);
    socket.dispatchEvent(new Event("open"));
    expect(socket.commands).toEqual([
      { type: "RESUME", roomCode, token: "testing" },
    ]);
    return socket;
  }
  for (const delay of [1000, 2000, 4000, 8000, 8000]) {
    loseConnectionAndRetry();
    advanceToResume(delay);
  }
  const restored = h.socket(h.connect.mock.calls.length - 1);
  restored.receive({ type: "SEATED", seatId: 0, roomCode, token: "testing" });
  restored.receive(phaseExamples[2]);
  expect(h.session.getState().connection).toBe("CONNECTED");
  expect(clock.timers.size).toBe(0);
  loseConnectionAndRetry();
  advanceToResume(1000);
  stop();
});

test("seat recovery timers preserve errors while connected, restoring or without a credential", () => {
  const h = harness();
  const clock = recoveryClock();
  const stop = scheduleSeatRecovery(h.session, clock.schedule);
  function assertIdle(code: string | null) {
    const count = h.connect.mock.calls.length;
    const resumes = h.resume.mock.calls.length;
    expect(clock.timers.size).toBe(0);
    clock.advance(30000);
    expect(h.connect).toHaveBeenCalledTimes(count);
    expect(h.resume).toHaveBeenCalledTimes(resumes);
    expect(h.session.getState().errorCode).toBe(code);
  }
  assertIdle(null);
  h.seated(phaseExamples[2]);
  h.socket().receive({ type: "ERROR", code: "NOT_HIGHER" });
  assertIdle("NOT_HIGHER");
  h.socket().dispatchEvent(new Event("close"));
  h.socket(1).dispatchEvent(new Event("close"));
  clock.advance(1000);
  const restoring = h.socket(2);
  restoring.dispatchEvent(new Event("open"));
  restoring.receive("invalid frame");
  expect(h.session.getState().connection).toBe("RESTORING");
  assertIdle("INVALID_MESSAGE");
  restoring.receive({ type: "ERROR", code: "RESUME_DENIED" });
  expect(h.session.getState().credential).toBeNull();
  assertIdle("RESUME_DENIED");
  stop();
});

test("a focus retry cancels the pending timer and cleanup cancels future retries", () => {
  const h = harness();
  const clock = recoveryClock();
  const stop = scheduleSeatRecovery(h.session, clock.schedule);
  const events = recoveryListeners(h.session);
  h.seated(phaseExamples[2]);
  h.socket(0).dispatchEvent(new Event("close"));
  h.socket(1).dispatchEvent(new Event("close"));
  expect(clock.timers.size).toBe(1);
  events.dispatch("focus");
  expect(clock.timers.size).toBe(0);
  clock.advance(20000);
  expect(h.connect).toHaveBeenCalledTimes(3);
  h.socket(2).dispatchEvent(new Event("close"));
  h.socket(3).dispatchEvent(new Event("close"));
  expect(clock.timers.size).toBe(1);
  stop();
  h.session.setMuted(true);
  expect(clock.timers.size).toBe(0);
  clock.advance(20000);
  expect(h.connect).toHaveBeenCalledTimes(4);
  events.cleanup();
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
    h.socket().receive({ type: "ERROR", code: "NOT_HIGHER" });
    expect(h.session.getState().pending).toBeNull();
    expect(h.session.getState().selected).toEqual([h.tile]);
    expect(markup(h.session, scene)).toContain(errorText("NOT_HIGHER"));
    clickAction(h.session, "pass");
    expect(
      h
        .socket()
        .commands.slice(-2)
        .map((c) => c.type),
    ).toEqual(["PLAY", "PASS"]);
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

test("audio unlock retries on keydown and click until cleanup", () => {
  const target = new EventTarget();
  const unlock = mock();
  const stop = listenForAudioUnlock(target, { unlock });
  target.dispatchEvent(new Event("keydown"));
  expect(unlock).toHaveBeenCalledTimes(1);
  target.dispatchEvent(new Event("click"));
  expect(unlock).toHaveBeenCalledTimes(2);
  stop();
  target.dispatchEvent(new Event("keydown"));
  target.dispatchEvent(new Event("click"));
  expect(unlock).toHaveBeenCalledTimes(2);
});

test("development WS proxy uses the supplied origin and is omitted when unset", () => {
  const previous = process.env.CAXIO_DEV_SERVER_ORIGIN;
  const env = { command: "serve", mode: "development" } as const;
  try {
    process.env.CAXIO_DEV_SERVER_ORIGIN = "https://dev.test";
    expect(viteConfig(env).server?.proxy).toEqual({
      [WS_PATH]: { target: "https://dev.test", ws: true },
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

test("entry declares an empty favicon", async () => {
  const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
  expect(html).toContain('<link rel="icon" href="data:,">');
});

test("GameApp removes the loaded table on abandonment and plays the restarted game's first settlement", async () => {
  const h = harness();
  const { observed, recipient } = abandonmentRestart;
  const scene = createScene(async () => ({ GameTable: canvas }));
  h.seated(observed[0], recipient);
  await scene.prepare("wide", h.session.getState().view);
  expect(markup(h.session, scene)).toContain("<canvas");
  for (const frame of observed.slice(1)) {
    h.audio.play.mockClear();
    h.socket().receive(frame);
    if (frame.type !== "SNAPSHOT") continue;
    if (frame.view.phase === "LOBBY") {
      const html = markup(h.session, scene);
      expect(html).toContain(ABANDONMENT_NOTICE);
      expect(html).toContain("gc-lobby");
      expect(html).not.toMatch(
        /<canvas|gc-board|gc-end|data-panel="settlement"/,
      );
      expect(h.audio.play).not.toHaveBeenCalled();
    }
    if (frame.view.phase === "ROUND_SETTLEMENT") {
      expect(h.audio.play).toHaveBeenCalledTimes(1);
      expect(h.audio.play).toHaveBeenCalledWith([
        { type: "PLAY", turnId: frame.view.lastPlay?.turnId },
        { type: "SETTLEMENT", round: 1 },
      ]);
    }
  }
});

test("startup sends one revoked resume and displays the denial at entry with cleared storage", () => {
  const { command, replies } = abandonmentRestart.exchanges.revoked;
  const h = harness(undefined, {
    roomCode: command.roomCode,
    token: command.token,
  });
  h.socket().dispatchEvent(new Event("open"));
  expect(h.socket().commands).toEqual([command]);
  h.socket().receive(replies[0]);
  const html = markup(h.session);
  expect(html).toContain("gc-entry");
  expect(html).toContain(errorText(replies[0].code));
  expect(h.storage.getItem("caxio.credential")).toBeNull();
  expect(h.connect).toHaveBeenCalledTimes(1);
});

test("invite startup normalizes the code, chooses the handshake and stops on rejection", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    for (const [restore, name, type, code] of [
      [true, "별", "RESUME", "RESUME_DENIED"],
      [true, "", "RESUME", "ROOM_NOT_FOUND"],
      [false, "달", "JOIN_ROOM", "ROOM_NOT_FOUND"],
      [false, "", "JOIN_ROOM", "ROOM_FULL"],
      [
        { roomCode: "WXYZ89", token: "other" },
        "invalid!",
        "JOIN_ROOM",
        "GAME_STARTED",
      ],
    ] as const) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => name },
      });
      const h = harness(undefined, restore, undefined, "?room=%20abcd23%20");
      h.socket().dispatchEvent(new Event("open"));
      expect(h.socket().commands).toEqual([
        type === "RESUME"
          ? { type, roomCode, token: "testing" }
          : { type, roomCode, ...(name === "달" ? { name } : {}) },
      ]);
      h.socket().receive({ type: "ERROR", code });
      expect(h.storage.getItem("caxio.credential")).toBeNull();
      expect(markup(h.session)).toContain(errorText(code));
      const schedule = mock(() => () => {});
      scheduleSeatRecovery(h.session, schedule)();
      expect(schedule).not.toHaveBeenCalled();
      expect(h.connect).toHaveBeenCalledTimes(1);
    }
    const h = harness(undefined, true, undefined, "?room=%20bad%20");
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.session.getState().credential).toBeNull();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("next-deal settlement retains the public counts only for a tab that saw settlement", () => {
  const [, , , paid, next] = lastPlaySequence.continuing;
  const h = harness();
  h.seated(paid);
  h.socket().receive(next);
  expect(markup(h.session)).toContain("1번(나) 0장 +3칩 67칩");
  const returning = harness(undefined, true);
  returning.seated(next);
  expect(markup(returning.session)).toContain("1번(나) +3칩 67칩");
});

test("the link value stays editable on rejection and leaving preserves other address components", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const originalHistory = Object.getOwnPropertyDescriptor(
    globalThis,
    "history",
  );
  try {
    let url = new URL("https://game.test/?x=1&room=%20bad%20#tab");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      get: () => url,
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: {
        state: "state",
        replaceState(state: string, _unused: string, next: URL) {
          expect(state).toBe("state");
          url = next;
        },
      },
    });
    const invalid = harness(undefined, false, undefined, url.search);
    expect(invalid.connect).not.toHaveBeenCalled();
    expect(markup(invalid.session)).toMatch(/id="gc-code"[^>]*value="BAD"/);
    url.searchParams.set("room", roomCode.toLowerCase());
    for (const code of [
      "ROOM_NOT_FOUND",
      "ROOM_FULL",
      "GAME_STARTED",
      "RESUME_DENIED",
    ] as const) {
      const h = harness(
        undefined,
        code === "RESUME_DENIED",
        undefined,
        url.search,
      );
      h.socket().dispatchEvent(new Event("open"));
      h.socket().receive({ type: "ERROR", code });
      const html = markup(h.session);
      expect(html).toMatch(/id="gc-code"[^>]*value="ABCD23"/);
      expect(html).toContain(errorText(code));
    }
    for (const [link, restore, rejection] of [
      ["ZZZZZZ", false, "ROOM_NOT_FOUND"],
      ["abc", false, null],
      ["ZZZZZZ", { roomCode: "ZZZZZZ", token: "denied" }, "RESUME_DENIED"],
    ] as const) {
      url.searchParams.set("room", link);
      const tab = harness(undefined, restore, undefined, url.search);
      if (rejection) {
        tab.socket().dispatchEvent(new Event("open"));
        tab.socket().receive({ type: "ERROR", code: rejection });
        tab.session.createRoom();
      } else tab.session.joinRoom(roomCode);
      expect(linkedRoom(url.search)).toBe(link.toUpperCase());
      const bound = tab.socket(rejection ? 1 : 0);
      bound.dispatchEvent(new Event("open"));
      const credential = { roomCode, token: "new-seat" };
      bound.receive({ type: "SEATED", seatId: 0, ...credential });
      expect(url.href).toBe("https://game.test/?x=1#tab");
      tab.session.dispose();
      const reloaded = new Socket();
      const resumed = startSession(
        browserSocket(url.origin, () => reloaded),
        tab.storage,
        { unlock: mock(), play: mock(), dispose: mock() },
      );
      reloaded.dispatchEvent(new Event("open"));
      expect(reloaded.commands).toEqual([{ type: "RESUME", ...credential }]);
      expect(resumed.getState().credential).toEqual(credential);
      expect(tab.storage.getItem("caxio.credential")).toBe(
        JSON.stringify(credential),
      );
      resumed.dispose();
    }
    url.searchParams.set("room", roomCode);
    const h = harness(undefined, true, undefined, url.search);
    h.session.leaveRoom?.();
    expect(url.href).toBe("https://game.test/?x=1#tab");
    expect(markup(h.session)).toMatch(/id="gc-code"[^>]*value=""/);
  } finally {
    for (const [key, original] of [
      ["location", originalLocation],
      ["history", originalHistory],
    ] as const) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
