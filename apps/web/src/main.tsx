import type { Preview } from "@caxio/shared/contracts/domain";
import { type PlayerView, WS_PATH } from "@caxio/shared/contracts/wire";
import { classify, compare } from "@caxio/shared/hands";
import {
  type ComponentType,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { createClientSession } from "./client";
import type {
  AudioEffects,
  ClientDependencies,
  ClientModel,
  ClientSession,
  TableProps,
} from "./contracts";
import { createAudioEffects } from "./table/audio";
import { GameControls } from "./ui";
import { fitScale, layout, type Mode } from "./visual/layout";
import { frame, palette } from "./visual/tokens";

export const preview: Preview = (selected, table, max) => {
  if (!selected.length) return { ok: false, reason: "EMPTY" };
  if (![1, 2, 3, 5].includes(selected.length))
    return { ok: false, reason: "COUNT" };
  const hand = classify(selected, max);
  if (!hand) return { ok: false, reason: "ILLEGAL_HAND" };
  if (table !== null) {
    if (table.length !== selected.length)
      return { ok: false, reason: "WRONG_COUNT" };
    const previous = classify(table, max);
    if (!previous) return { ok: false, reason: "ILLEGAL_HAND" };
    if (!compare(hand, previous)) return { ok: false, reason: "NOT_HIGHER" };
  }
  return { ok: true, kind: hand.kind, representative: hand.representative };
};

export function browserSocket(
  origin: string,
  connect: (
    url: string,
  ) => Pick<WebSocket, "addEventListener" | "send" | "close"> = (url) =>
    new WebSocket(url),
): ClientDependencies["openSocket"] {
  const url = new URL(WS_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return (events) => {
    const socket = connect(url.href);
    socket.addEventListener("open", events.open);
    socket.addEventListener("message", (e) => events.message(e.data));
    socket.addEventListener("close", events.close);
    return socket;
  };
}

export function startSession(
  openSocket: ClientDependencies["openSocket"],
  storage: ClientDependencies["storage"],
  audio: AudioEffects,
  create = createClientSession,
) {
  const session = create({
    openSocket,
    storage,
    monotonicNow: () => performance.now(),
    effects: (events) => audio.play(events),
  });
  session.resume();
  return session;
}

type SceneModule = { GameTable: ComponentType<TableProps> };
export function createScene(
  load: () => Promise<SceneModule> = () => import("./table"),
) {
  const store = createStore(() => ({
    Table: null as ComponentType<TableProps> | null,
    ready: false,
    failed: false,
  }));
  let loading: Promise<void> | undefined;
  const onFailure = () => {
    if (!store.getState().failed)
      store.setState({ Table: null, failed: true, ready: false });
  };
  return {
    ...store,
    prepare(mode: Mode, view: PlayerView | null) {
      if (mode === "wide" && view)
        loading ??= load().then(
          ({ GameTable }) => store.setState({ Table: GameTable }),
          onFailure,
        );
      return loading;
    },
    onReady() {
      if (store.getState().Table) store.setState({ ready: true });
    },
    onFailure,
    hide() {
      if (store.getState().ready) store.setState({ ready: false });
    },
  };
}

export function GameApp({
  session,
  scene,
  width,
  height,
  reducedMotion,
}: {
  session: ClientSession;
  scene: ReturnType<typeof createScene>;
  width: number;
  height: number;
  reducedMotion: boolean;
}) {
  const model = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState,
  );
  const { Table, ready } = useSyncExternalStore(
    scene.subscribe,
    scene.getState,
    scene.getState,
  );
  const { view, seatId, selected } = model;
  const { mode, k } = fitScale(width, height);
  const wide = mode === "wide";
  const game = wide && view !== null && view.phase !== "LOBBY";
  useLayoutEffect(() => {
    void scene.prepare(mode, view);
  }, [scene, mode, view]);
  useLayoutEffect(() => {
    if (game) return scene.hide;
  }, [scene, game]);
  // Snapshot decoding allocates a fresh seatOrder even for a presence-only change.
  const order = view?.seatOrder.join(",") ?? "";
  const handCount = view?.ownHand?.length ?? 0;
  const tableCount = view?.tableHand?.length ?? 0;
  const slots = useMemo(
    () =>
      layout(
        order ? order.split(",").map(Number) : [],
        seatId ?? 0,
        handCount,
        tableCount,
      ),
    [order, seatId, handCount, tableCount],
  );
  return (
    <main
      style={
        wide
          ? {
              position: "absolute",
              width: frame.width * k,
              height: frame.height * k,
              left: Math.floor((width - frame.width * k) / 2),
              top: Math.floor((height - frame.height * k) / 2),
            }
          : undefined
      }
    >
      {game && Table && (
        <div
          style={{
            position: "absolute",
            top: frame.statusHeight * k,
            left: 0,
            pointerEvents: "none",
          }}
        >
          <Table
            view={view}
            selected={selected}
            layout={slots}
            k={k}
            reducedMotion={reducedMotion}
            onReady={scene.onReady}
            onFailure={scene.onFailure}
          />
        </div>
      )}
      <GameControls
        {...session}
        model={model}
        layout={slots}
        k={k}
        graphicsReady={game && ready}
        preview={preview}
      />
    </main>
  );
}

export function listenForAudioUnlock(
  target: EventTarget,
  audio: Pick<AudioEffects, "unlock">,
) {
  const listeners = new AbortController();
  for (const event of ["click", "keydown"]) {
    target.addEventListener(event, () => audio.unlock(), {
      capture: true,
      signal: listeners.signal,
    });
  }
  return () => listeners.abort();
}

function needsSeatRecovery({ connection, credential }: ClientModel) {
  return connection === "DISCONNECTED" && credential !== null;
}

export function listenForSeatRecovery(
  windowTarget: EventTarget,
  documentTarget: EventTarget,
  isVisible: () => boolean,
  session: ClientSession,
) {
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  function resumeIfDisconnected() {
    if (needsSeatRecovery(session.getState())) session.resume();
  }
  windowTarget.addEventListener("online", resumeIfDisconnected, options);
  windowTarget.addEventListener("focus", resumeIfDisconnected, options);
  documentTarget.addEventListener(
    "visibilitychange",
    () => {
      if (isVisible()) resumeIfDisconnected();
    },
    options,
  );
  return () => listeners.abort();
}

// Chrome keeps a page left by navigation in its back/forward cache with the WebSocket open, so the
// server would keep the seat connected and never count its expiries toward abandonment. Close the
// socket on pagehide, open none while hidden, and resume the seat on pageshow.
export function pageSockets(openSocket: ClientDependencies["openSocket"]) {
  let hidden = false;
  let latest: ReturnType<typeof openSocket> | undefined;
  return {
    openSocket: ((events) => {
      if (hidden) throw Error("The page is hidden");
      latest = openSocket(events);
      return latest;
    }) satisfies typeof openSocket,
    listen(windowTarget: EventTarget, session: ClientSession) {
      const listeners = new AbortController();
      const options = { signal: listeners.signal };
      windowTarget.addEventListener(
        "pagehide",
        () => {
          hidden = true;
          latest?.close();
        },
        options,
      );
      windowTarget.addEventListener(
        "pageshow",
        () => {
          hidden = false;
          if (needsSeatRecovery(session.getState())) session.resume();
        },
        options,
      );
      return () => listeners.abort();
    },
  };
}

export function scheduleSeatRecovery(
  session: ClientSession,
  schedule: (delayMs: number, retry: () => void) => () => void = (
    delayMs,
    retry,
  ) => {
    const timer = setTimeout(retry, delayMs);
    return () => clearTimeout(timer);
  },
) {
  const firstDelay = 1000;
  let delay = firstDelay;
  let cancel: (() => void) | undefined;
  function update() {
    const state = session.getState();
    if (!needsSeatRecovery(state)) {
      cancel?.();
      cancel = undefined;
      if (state.connection === "CONNECTED" || !state.credential)
        delay = firstDelay;
      return;
    }
    cancel ??= schedule(delay, () => {
      cancel = undefined;
      if (needsSeatRecovery(session.getState())) {
        delay = Math.min(delay * 2, 8000);
        session.resume();
      }
    });
  }
  const unsubscribe = session.subscribe(update);
  update();
  return () => {
    unsubscribe();
    cancel?.();
  };
}

function bootstrap(element: HTMLElement) {
  document.body.style.margin = "0";
  document.body.style.backgroundColor = `rgb(${palette.ink.join(",")})`;
  const audio = createAudioEffects(() => new AudioContext());
  const sockets = pageSockets(browserSocket(location.origin));
  const session = startSession(
    sockets.openSocket,
    {
      // Access the storage getter inside the client's best-effort operations.
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
    },
    audio,
  );
  const stopAudioUnlock = listenForAudioUnlock(window, audio);
  const stopRecoveryTimer = scheduleSeatRecovery(session);
  const stopPageSockets = sockets.listen(window, session);
  const stopSeatRecovery = listenForSeatRecovery(
    window,
    document,
    () => document.visibilityState === "visible",
    session,
  );
  const scene = createScene();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const root = createRoot(element);
  const render = () =>
    root.render(
      <GameApp
        session={session}
        scene={scene}
        width={window.innerWidth}
        height={window.innerHeight}
        reducedMotion={motion.matches}
      />,
    );
  render();
  window.addEventListener("resize", render);
  motion.addEventListener("change", render);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("resize", render);
    motion.removeEventListener("change", render);
    stopAudioUnlock();
    stopSeatRecovery();
    stopRecoveryTimer();
    stopPageSockets();
    root.unmount();
    session.dispose();
    audio.dispose();
  });
}

if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) bootstrap(root);
}
