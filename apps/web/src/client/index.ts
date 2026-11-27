import type { Tile } from "@caxio/shared/contracts/domain";
import {
  type ChatRequest,
  type Command,
  type Credential,
  decodeChatMessage,
  decodeServerMessage,
  isChatText,
  isRoomCode,
} from "@caxio/shared/contracts/wire";
import { createStore } from "zustand/vanilla";
import type {
  ClientDependencies,
  ClientEffect,
  ClientModel,
  CreateClientSession,
} from "../contracts";
import { CHAT_HISTORY_LIMIT } from "../contracts";

import { entryName } from "./name";

const credentialKey = "caxio.credential";
const muteKey = "caxio.muted";

function bestEffort<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    // Storage, rendering and audio failures must not interrupt the session.
    return undefined;
  }
}

function readCredential(
  storage: ClientDependencies["storage"],
): Credential | null {
  const raw = bestEffort(() => storage.getItem(credentialKey));
  if (raw == null) return null;
  const value: unknown = bestEffort(() => JSON.parse(raw));
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    "roomCode" in value &&
    isRoomCode(value.roomCode) &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0
  )
    return { roomCode: value.roomCode, token: value.token };
  bestEffort(() => storage.removeItem(credentialKey));
  return null;
}

function sameTile(a: Tile, b: Tile) {
  return a.number === b.number && a.suit === b.suit;
}

const empty = {
  chat: [],
  chatErrorCode: null,
  connection: "DISCONNECTED",
  seatId: null,
  view: null,
  revision: null,
  timeAnchor: null,
  selected: [],
  pending: null,
  errorCode: null,
} as const;

export const createClientSession: CreateClientSession = (deps) => {
  const store = createStore<ClientModel>(() => ({
    ...empty,
    credential: readCredential(deps.storage),
    muted: bestEffort(() => deps.storage.getItem(muteKey)) === "true",
  }));
  const { getState, setState } = store;
  let disposed = false;
  type Socket = ReturnType<ClientDependencies["openSocket"]>;
  interface Connection {
    socket?: Socket;
    opened: boolean;
    lost(): void;
  }
  let current: Connection | null = null;

  function detach() {
    const old = current;
    current = null;
    old?.socket?.close();
  }

  function beginAction() {
    if (disposed) return false;
    if (getState().errorCode !== null) setState({ errorCode: null });
    return !disposed;
  }

  function send(command: Command) {
    const connection = current;
    if (!connection?.socket) return;
    setState({ pending: command });
    if (current !== connection) return;
    try {
      connection.socket.send(JSON.stringify(command));
    } catch {
      connection.lost();
    }
  }

  function retainedChat() {
    const { chat, chatErrorCode } = getState();
    return { chat, chatErrorCode };
  }

  function connect(
    request: Extract<Command, { type: "CREATE_ROOM" | "JOIN_ROOM" | "RESUME" }>,
    retry = false,
  ) {
    detach();
    const restoring = request.type === "RESUME";
    let sent = false;
    let establishing = true;
    let lastPlayId = 0;
    let lastSettlementRound = 0;
    let lastOwnTurnId = 0;
    const connection: Connection = {
      opened: false,
      lost() {
        if (current !== connection) return;
        const { credential, revision, selected } = getState();
        detach();
        // One immediate retry per outage. A successful asynchronous restore rearms it.
        if (credential && (!retry || (revision !== null && !establishing))) {
          connect({ type: "RESUME", ...credential }, true);
        } else {
          setState({
            ...empty,
            ...(credential && retainedChat()),
            selected: credential ? selected : [],
          });
        }
      },
    };
    current = connection;
    setState({
      ...empty,
      ...(restoring && retainedChat()),
      selected: restoring ? getState().selected : [],
      connection: restoring ? "RESTORING" : "CONNECTING",
    });
    if (current !== connection) return;

    function handshake() {
      if (
        current !== connection ||
        !connection.opened ||
        !connection.socket ||
        sent
      )
        return;
      sent = true;
      establishing = true;
      try {
        send(request);
      } finally {
        establishing = false;
      }
    }

    try {
      const socket = deps.openSocket({
        open() {
          connection.opened = true;
          handshake();
        },
        close: connection.lost,
        message(frame) {
          if (current !== connection) return;
          const state = getState();
          const chat = decodeChatMessage(frame);
          if (chat) {
            if (state.seatId === null) return;
            if (chat.type === "CHAT_ERROR")
              setState({ chatErrorCode: chat.code });
            else {
              const { seatId, text } = chat;
              const name = state.view?.slots[seatId]?.name;
              const entry =
                name === undefined ? { seatId, text } : { seatId, text, name };
              setState({
                chat: [...(state.chat ?? []), entry].slice(-CHAT_HISTORY_LIMIT),
              });
            }
            return;
          }
          const message = decodeServerMessage(frame, state.seatId);
          if (message === "INVALID_MESSAGE") {
            setState({ errorCode: message });
            return;
          }
          if (message.type === "SEATED") {
            const credential = {
              roomCode: message.roomCode,
              token: message.token,
            };
            bestEffort(() =>
              deps.storage.setItem(credentialKey, JSON.stringify(credential)),
            );
            setState({
              ...(state.credential &&
                state.credential.roomCode !== credential.roomCode && {
                  chat: [],
                  chatErrorCode: null,
                }),
              credential,
              seatId: message.seatId,
              pending: state.pending === request ? null : state.pending,
            });
            return;
          }
          if (message.type === "ERROR") {
            if (
              message.code === "RESUME_DENIED" ||
              message.code === "ROOM_NOT_FOUND"
            ) {
              detach();
              bestEffort(() => deps.storage.removeItem(credentialKey));
              setState({ ...empty, credential: null, errorCode: message.code });
            } else if (state.seatId === null) {
              detach();
              setState({
                ...empty,
                ...(restoring && retainedChat()),
                errorCode: message.code,
              });
            } else {
              setState({ pending: null, errorCode: message.code });
            }
            return;
          }

          const { view, revision, serverNow } = message;
          if (state.revision !== null && revision <= state.revision) return;
          if (view.phase === "LOBBY") lastSettlementRound = 0;
          const events: ClientEffect[] = [];
          if (view.lastPlay && view.lastPlay.turnId > lastPlayId) {
            lastPlayId = view.lastPlay.turnId;
            events.push({ type: "PLAY", turnId: lastPlayId });
          }
          if (
            view.lastSettlement &&
            view.lastSettlement.round > lastSettlementRound
          ) {
            lastSettlementRound = view.lastSettlement.round;
            events.push({ type: "SETTLEMENT", round: lastSettlementRound });
          }
          if (
            view.phase === "TURN_ACTIVE" &&
            view.currentTurn === state.seatId &&
            view.turnId > lastOwnTurnId
          ) {
            lastOwnTurnId = view.turnId;
            events.push({ type: "MY_TURN", turnId: view.turnId });
          }
          let pending = state.pending;
          if (
            (pending?.type === "START_GAME" && view.phase !== "LOBBY") ||
            ((pending?.type === "PLAY" || pending?.type === "PASS") &&
              (pending.turnId !== view.turnId || !view.ownHand))
          )
            pending = null;
          setState({
            view,
            revision,
            connection: "CONNECTED",
            pending,
            timeAnchor: { serverNow, receivedAt: deps.monotonicNow() },
            selected: state.selected.filter((tile) =>
              view.ownHand?.some((owned) => sameTile(tile, owned)),
            ),
            errorCode:
              (state.view?.currentTurn ?? null) === view.currentTurn
                ? state.errorCode
                : null,
          });
          if (
            current === connection &&
            state.revision !== null &&
            !state.muted &&
            !getState().muted &&
            events.length
          )
            bestEffort(() => deps.effects(events));
        },
      });
      if (current !== connection) socket.close();
      else {
        connection.socket = socket;
        handshake();
      }
    } catch {
      connection.lost();
    } finally {
      establishing = false;
    }
  }

  function turnCommand(type: "PLAY" | "PASS") {
    if (!beginAction()) return;
    const { connection, view, pending, seatId, selected } = getState();
    if (
      connection !== "CONNECTED" ||
      pending ||
      view?.phase !== "TURN_ACTIVE" ||
      view.currentTurn !== seatId ||
      !view.ownHand
    )
      return;
    if (type === "PLAY" && selected.length)
      send({ type, turnId: view.turnId, tiles: selected });
    if (type === "PASS" && view.tableHand) send({ type, turnId: view.turnId });
  }

  return {
    getState,
    subscribe: (listener) =>
      store.subscribe((state, previous) => {
        bestEffort(() => listener(state, previous));
      }),
    createRoom(input, settings) {
      const name = entryName(input);
      if (beginAction() && name !== false)
        connect(
          name === undefined
            ? { type: "CREATE_ROOM", ...settings }
            : { type: "CREATE_ROOM", name, ...settings },
        );
    },
    joinRoom(roomCode, input) {
      const name = entryName(input);
      if (beginAction() && isRoomCode(roomCode) && name !== false)
        connect(
          name === undefined
            ? { type: "JOIN_ROOM", roomCode }
            : { type: "JOIN_ROOM", roomCode, name },
        );
    },
    sendChat(input) {
      const connection = current;
      const text = input.trim();
      if (
        !connection?.opened ||
        !connection.socket ||
        getState().seatId === null ||
        !isChatText(text)
      )
        return;
      if (getState().chatErrorCode) setState({ chatErrorCode: null });
      if (current !== connection) return;
      try {
        connection.socket.send(
          JSON.stringify({ type: "CHAT", text } satisfies ChatRequest),
        );
      } catch {
        connection.lost();
      }
    },
    leaveRoom() {
      if (disposed) return;
      if (getState().seatId !== null)
        bestEffort(() =>
          current?.socket?.send(JSON.stringify({ type: "LEAVE_ROOM" })),
        );
      detach();
      bestEffort(() => deps.storage.removeItem(credentialKey));
      setState({ ...empty, credential: null });
    },
    resume() {
      if (!beginAction()) return;
      const { credential } = getState();
      if (!current && credential) connect({ type: "RESUME", ...credential });
    },
    startGame() {
      if (!beginAction()) return;
      const { connection, view, pending } = getState();
      if (
        connection === "CONNECTED" &&
        !pending &&
        view?.phase === "LOBBY" &&
        view.canStart
      )
        send({ type: "START_GAME" });
    },
    toggleTile(tile) {
      if (!beginAction()) return;
      const { connection, view, selected, pending } = getState();
      if (
        connection !== "CONNECTED" ||
        pending ||
        (view?.phase !== "ROUND_START" && view?.phase !== "TURN_ACTIVE")
      )
        return;
      const owned = view.ownHand?.find((t) => sameTile(t, tile));
      if (!owned) return;
      setState({
        selected: selected.some((t) => sameTile(t, owned))
          ? selected.filter((t) => !sameTile(t, owned))
          : [...selected, owned],
      });
    },
    play() {
      turnCommand("PLAY");
    },
    pass() {
      turnCommand("PASS");
    },
    setMuted(muted) {
      if (disposed) return;
      bestEffort(() => deps.storage.setItem(muteKey, String(muted)));
      setState({ muted });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      setState(empty);
    },
  };
};
