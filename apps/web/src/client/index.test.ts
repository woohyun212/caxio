import { expect, mock, setSystemTime, test } from "bun:test";
import {
  abandonmentLobbyExamples,
  abandonmentLobbyResume,
  abandonmentRestart,
  abandonmentResults,
  deadlines,
  dealExamples,
  effectBatches,
  epoch,
  invalidAbandonmentExamples,
  lastPlaySequence,
  leaveExamples,
  lostResume,
  newRoomSequence,
  nonHostAbandonmentLobby,
  phaseExamples,
  roomCode,
  seatReuse,
  spectatorExamples,
  turnErrorExamples,
} from "@caxio/shared/contracts/fixtures";
import type {
  Command,
  Credential,
  Seated,
  Snapshot,
} from "@caxio/shared/contracts/wire";
import type {
  ClientDependencies,
  ClientEffect,
  CreateClientSession,
} from "../contracts";
import { createClientSession } from "./index";

const key = "caxio.credential";
const tile = deadlines.stale.command.tiles[0];
function required<T>(value: T | null | undefined): T {
  if (value == null) throw Error("missing test fixture");
  return value;
}
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
function harness(
  saved = storage(),
  overrides: Partial<ClientDependencies> = {},
) {
  type Events = Parameters<ClientDependencies["openSocket"]>[0];
  function socket(events: Events) {
    const sent: Command[] = [];
    return {
      events,
      sent,
      frame: (message: unknown) => events.message(JSON.stringify(message)),
      send: (frame: string) => sent.push(JSON.parse(frame)),
      close: mock(() => events.close()),
    };
  }
  const sockets: ReturnType<typeof socket>[] = [];
  const effects = mock((_events: readonly ClientEffect[]) => {});
  const clock = { now: 10 };
  const create: CreateClientSession = createClientSession;
  const session = create({
    storage: saved,
    monotonicNow: () => clock.now,
    effects,
    openSocket(events) {
      const s = socket(events);
      sockets.push(s);
      return s;
    },
    ...overrides,
  });
  const latest = () => required(sockets.at(-1));
  function enter(
    snapshot: Snapshot,
    seated: Seated = newRoomSequence.previous,
  ) {
    session.joinRoom(seated.roomCode);
    const s = latest();
    s.events.open();
    s.frame(seated);
    s.frame(snapshot);
    expect(session.getState().view).toEqual(snapshot.view);
    return s;
  }
  return { saved, sockets, session, effects, clock, latest, enter };
}
function stored(credential: Credential) {
  const saved = storage();
  saved.setItem(
    key,
    JSON.stringify({ roomCode: credential.roomCode, token: credential.token }),
  );
  return saved;
}

test("accepted snapshots renew the monotonic anchor under either wall clock skew", () => {
  function sample(offset: number) {
    setSystemTime(epoch + offset);
    const h = harness();
    const s = h.enter(deadlines.before);
    expect(h.session.getState().timeAnchor).toEqual({
      serverNow: deadlines.before.serverNow,
      receivedAt: 10,
    });
    h.clock.now = 2010;
    s.frame(deadlines.presence);
    const model = h.session.getState();
    const anchor = required(model.timeAnchor);
    expect(anchor).toEqual({
      serverNow: deadlines.presence.serverNow,
      receivedAt: 2010,
    });
    h.clock.now += 500;
    const remaining =
      required(model.view?.deadline) -
      anchor.serverNow -
      (h.clock.now - anchor.receivedAt);
    expect(remaining).toBe(29494);
    return { model, remaining };
  }
  try {
    expect(sample(30000)).toEqual(sample(-30000));
  } finally {
    setSystemTime();
  }
});

test("tab mute persists independently and muted events never replay", () => {
  const seeded = storage();
  seeded.setItem("caxio.muted", "true");
  expect(harness(seeded).session.getState().muted).toBe(true);

  const h = harness();
  expect(h.session.getState().muted).toBe(false);
  const [first, , , paid, next] = lastPlaySequence.continuing;
  const s = h.enter(deadlines.before);
  const credential = required(h.saved.getItem(key));
  h.session.setMuted(true);
  expect(h.saved.values).toEqual(
    new Map([
      [key, credential],
      ["caxio.muted", "true"],
    ]),
  );
  expect(harness(h.saved).session.getState().muted).toBe(true);
  s.frame(deadlines.stale.after);
  h.session.setMuted(false);
  expect(harness(h.saved).session.getState().muted).toBe(false);
  s.frame({
    ...deadlines.stale.after,
    revision: deadlines.stale.after.revision + 1,
  });
  expect(h.effects).not.toHaveBeenCalled();
  s.frame(first);
  expect(h.effects.mock.calls).toEqual([
    [[{ type: "PLAY", turnId: required(first.view.lastPlay).turnId }]],
  ]);

  h.effects.mockClear();
  h.session.setMuted(true);
  s.frame(paid);
  h.session.setMuted(false);
  s.frame(next);
  expect(h.effects).not.toHaveBeenCalled();
});

test("storage failures leave mute and the resume credential usable in memory", () => {
  const fail = () => {
    throw Error("storage unavailable");
  };
  const h = harness(storage(), {
    storage: { getItem: fail, setItem: fail, removeItem: fail },
  });
  h.session.setMuted(true);
  const s = h.enter(deadlines.before);
  s.events.close();
  h.latest().events.open();
  expect(h.latest().sent).toEqual([
    { type: "RESUME", ...newRoomSequence.storedBefore },
  ]);
  h.latest().frame(newRoomSequence.clearOn[0]);
  expect(h.session.getState()).toMatchObject({ muted: true, credential: null });
});

test("pending play survives presence and blocks duplicate turns and selection changes", () => {
  const h = harness();
  const s = h.enter(deadlines.before);
  h.session.toggleTile(tile);
  h.session.play();
  const command = deadlines.stale.command;
  expect(s.sent.at(-1)).toEqual(command);
  expect(h.session.getState()).toMatchObject({
    pending: command,
    view: deadlines.before.view,
    selected: [tile],
  });
  s.frame(deadlines.presence);
  h.session.play();
  h.session.pass();
  h.session.toggleTile(tile);
  expect(s.sent).toHaveLength(2);
  expect(h.session.getState()).toMatchObject({
    pending: command,
    selected: [tile],
    view: deadlines.presence.view,
  });
  s.frame({ ...deadlines.stale.after, revision: 7 });
  expect(h.session.getState()).toMatchObject({
    pending: null,
    selected: [],
    view: deadlines.stale.after.view,
  });
});

test("pending pass keeps the surviving selection after a rejection", () => {
  const follower = turnErrorExamples[5];
  const h = harness();
  const s = h.enter(follower.before, seatReuse.credentials.B);
  const hand = required(follower.before.view.ownHand);
  const first = required(hand[0]),
    second = required(hand[1]);
  h.session.toggleTile(first);
  h.session.toggleTile(second);
  h.session.pass();
  const command: Command = {
    type: "PASS",
    turnId: required(follower.before.view.turnId),
  };
  expect(s.sent.at(-1)).toEqual(command);
  h.session.pass();
  h.session.play();
  h.session.toggleTile(first);
  expect(s.sent).toHaveLength(2);
  const locked = h.session.getState();
  s.events.message("broken JSON");
  expect(h.session.getState()).toEqual({
    ...locked,
    errorCode: "INVALID_MESSAGE",
  });
  const view = {
    ...follower.before.view,
    ownHand: hand.slice(1),
    slots: follower.before.view.slots.map((slot, id) =>
      id === 1 ? { ...slot, remainingTileCount: hand.length - 1 } : slot,
    ),
  };
  s.frame({ ...follower.before, revision: 7, view });
  expect(h.session.getState()).toMatchObject({
    pending: command,
    selected: [second],
  });
  s.frame(follower.reply);
  expect(h.session.getState()).toMatchObject({
    pending: null,
    selected: [second],
    errorCode: follower.reply.code,
  });
  h.session.pass();
  expect(h.session.getState().pending).toEqual(command);
  const passed = lastPlaySequence.continuing[1];
  s.frame({ ...passed, view: { ...passed.view, ownHand: [second] } });
  expect(h.session.getState()).toMatchObject({
    pending: null,
    selected: [second],
    errorCode: null,
  });
});

test("lost RESUME response retries the same credential and waits for both frames", () => {
  const h = harness(stored(lostResume.credential));
  expect(h.sockets).toHaveLength(0);
  h.session.resume();
  expect(h.session.getState().connection).toBe("RESTORING");
  const old = h.latest();
  old.events.open();
  expect(old.sent).toEqual([lostResume.command]);
  expect(h.session.getState().pending).toEqual(lostResume.command);
  old.events.close();
  const retry = h.latest();
  expect(retry).not.toBe(old);
  expect(h.session.getState().pending).toBeNull();
  retry.events.open();
  expect(retry.sent).toEqual([lostResume.retry]);
  retry.frame(lostResume.snapshot);
  expect(h.session.getState()).toMatchObject({
    errorCode: "INVALID_MESSAGE",
    view: null,
  });
  retry.frame(lostResume.received);
  expect(h.session.getState()).toMatchObject({
    connection: "RESTORING",
    pending: null,
    view: null,
  });
  retry.frame(lostResume.snapshot);
  expect(h.session.getState()).toMatchObject({
    connection: "CONNECTED",
    seatId: lostResume.recipient,
    credential: { roomCode, token: lostResume.credential.token },
    view: { ownHand: lostResume.originalHand },
  });
});

test("create, join and reconnect ignore every callback on the replaced socket", () => {
  for (const replace of ["create", "join", "reconnect"]) {
    const h = harness();
    const old = h.enter(lastPlaySequence.continuing[0]);
    if (replace === "create") h.session.createRoom();
    else if (replace === "join")
      h.session.joinRoom(newRoomSequence.response.roomCode);
    else old.events.close();
    expect(old.close).toHaveBeenCalledTimes(1);
    const s = h.latest();
    s.events.open();
    const restored = replace === "reconnect";
    const snapshot = restored
      ? lastPlaySequence.continuing[0]
      : newRoomSequence.lobby;
    s.frame(restored ? newRoomSequence.previous : newRoomSequence.response);
    s.frame(snapshot);
    const state = h.session.getState();
    expect(state.revision).toBe(snapshot.revision);
    const saved = [...h.saved.values];
    old.frame(restored ? newRoomSequence.response : newRoomSequence.previous);
    old.frame(lastPlaySequence.continuing[3]);
    old.frame(newRoomSequence.clearOn[0]);
    old.events.close();
    expect(h.session.getState()).toBe(state);
    expect([...h.saved.values]).toEqual(saved);
    expect(h.sockets).toHaveLength(2);
    expect(h.effects).not.toHaveBeenCalled();
  }
});

test("GAME_OVER creates a new room and refresh restores only its credential", () => {
  for (const denial of newRoomSequence.clearOn) {
    const h = harness();
    const old = h.enter(newRoomSequence.finished);
    expect(JSON.parse(required(h.saved.getItem(key)))).toEqual(
      newRoomSequence.storedBefore,
    );
    h.session.createRoom();
    expect(old.close).toHaveBeenCalledTimes(1);
    const s = h.latest();
    s.events.open();
    expect(s.sent).toEqual([newRoomSequence.command]);
    expect(h.session.getState()).toMatchObject({
      pending: newRoomSequence.command,
      connection: "CONNECTING",
    });
    s.frame(newRoomSequence.response);
    expect(h.session.getState()).toMatchObject({
      pending: null,
      connection: "CONNECTING",
    });
    expect([...h.saved.values]).toEqual([
      [key, JSON.stringify(newRoomSequence.storedAfter)],
    ]);
    s.frame(newRoomSequence.lobby);
    expect(h.session.getState().view).toEqual(newRoomSequence.lobby.view);
    h.session.dispose();
    const refresh = harness(h.saved);
    refresh.session.resume();
    const resumed = refresh.latest();
    resumed.events.open();
    expect(resumed.sent).toEqual([newRoomSequence.resume]);
    resumed.frame(newRoomSequence.response);
    resumed.frame(newRoomSequence.lobby);
    expect(refresh.session.getState().view).toEqual(newRoomSequence.lobby.view);
    resumed.frame(denial);
    expect(refresh.session.getState()).toMatchObject({
      credential: newRoomSequence.storedAfterDenial,
      view: null,
      seatId: null,
      connection: "DISCONNECTED",
      pending: null,
      errorCode: denial.code,
    });
    expect(h.saved.values.size).toBe(0);
  }
});

test("round advance and GAME_OVER preserve the server's play and settlement history", () => {
  for (const sequence of [
    lastPlaySequence.continuing,
    lastPlaySequence.ending,
  ]) {
    const h = harness();
    const s = h.enter(sequence[0]);
    for (const snapshot of sequence.slice(1)) {
      s.frame(snapshot);
      expect(h.session.getState().view).toEqual(snapshot.view);
      expect(h.session.getState().revision).toBe(snapshot.revision);
    }
  }
});

test("reused seats restore the dealt hand and revoked credentials return to entry", () => {
  for (const started of seatReuse.started) {
    const seated = required(
      Object.values(seatReuse.credentials).find(
        (c) => c.seatId === started.recipient && c !== seatReuse.credentials.B,
      ),
    );
    const h = harness();
    h.enter(started.frame, seated);
    expect(h.session.getState()).toMatchObject({
      seatId: started.recipient,
      view: { ownHand: seatReuse.hands[started.recipient] },
      credential: { roomCode, token: seated.token },
    });
  }
  for (const { command, reply } of seatReuse.revoked) {
    const h = harness(stored(command));
    h.session.resume();
    const s = h.latest();
    s.events.open();
    expect(s.sent).toEqual([command]);
    s.frame(reply);
    expect(h.session.getState()).toMatchObject({
      errorCode: "RESUME_DENIED",
      credential: null,
    });
    expect(h.saved.getItem(key)).toBeNull();
  }
});

test("effect batches follow accepted identifiers and each connection starts silently", () => {
  const h = harness();
  const [first, , , paid] = lastPlaySequence.continuing;
  const s = h.enter(first);
  lastPlaySequence.continuing.forEach((snapshot, i) => {
    if (i > 0) s.frame(snapshot);
    const expected = required(effectBatches[i]);
    expect(h.effects.mock.calls).toEqual(expected.length ? [[expected]] : []);
    h.effects.mockClear();
    const accepted = h.session.getState();
    s.frame(snapshot);
    s.frame({ ...snapshot, revision: snapshot.revision - 1 });
    expect(h.session.getState()).toBe(accepted);
    expect(h.effects).not.toHaveBeenCalled();
  });
  const other = harness();
  const old = other.enter(deadlines.before);
  old.frame(deadlines.presence);
  old.events.close();
  const retry = other.latest();
  retry.events.open();
  retry.frame(newRoomSequence.previous);
  retry.frame(paid);
  expect(other.session.getState().revision).toBe(paid.revision);
  expect(other.effects).not.toHaveBeenCalled();
});

test("OUT removes both private fields and selection; spectator restore rejects a survivor frame", () => {
  const f = spectatorExamples;
  const h = harness();
  function expectPublicView(snapshot: Snapshot) {
    const view = required(h.session.getState().view);
    expect(view).toEqual(snapshot.view);
    expect(Object.hasOwn(view, "ownHand")).toBe(false);
    expect(Object.hasOwn(view, "ownSettlement")).toBe(false);
  }
  const dealt = dealExamples[1];
  if (dealt.view.phase !== "ROUND_START" || !dealt.view.ownHand)
    throw Error("expected a dealt hand");
  const view = {
    ...dealt.view,
    round: 2,
    lastSettlement: f.transition.view.lastSettlement,
    ownSettlement: required(f.survivor.frame.view.ownSettlement),
  };
  const s = h.enter({ ...dealt, view }, f.resume);
  const owned = required(view.ownHand?.[0]);
  h.session.toggleTile(owned);
  expect(h.session.getState().selected).toEqual([owned]);
  s.frame(f.transition);
  expectPublicView(f.transition);
  expect(h.session.getState().selected).toEqual([]);
  s.frame(f.following);
  expectPublicView(f.following);
  s.events.close();
  const retry = h.latest();
  retry.events.open();
  retry.frame(f.resume);
  retry.frame(f.restored);
  expectPublicView(f.restored);
  retry.frame(f.gameOver);
  expectPublicView(f.gameOver);
  const before = h.session.getState();
  const calls = h.effects.mock.calls.length;
  retry.frame(f.survivor.frame);
  expect(h.session.getState()).toEqual({
    ...before,
    errorCode: "INVALID_MESSAGE",
  });
  expect(h.effects.mock.calls).toHaveLength(calls);
});

test("store delivers previous and current state; unsubscribe and dispose end updates", () => {
  const h = harness();
  const listener = mock((_state: unknown, _previous: unknown) => {});
  const before = h.session.getState();
  const unsubscribe = h.session.subscribe(listener);
  h.session.createRoom();
  expect(listener.mock.calls).toEqual([[h.session.getState(), before]]);
  unsubscribe();
  const s = h.latest();
  s.events.open();
  s.frame(newRoomSequence.previous);
  s.frame(deadlines.before);
  expect(listener).toHaveBeenCalledTimes(1);
  h.session.dispose();
  h.session.dispose();
  const stopped = h.session.getState();
  const saved = [...h.saved.values];
  s.frame(newRoomSequence.clearOn[0]);
  s.events.close();
  h.session.resume();
  h.session.createRoom();
  h.session.joinRoom(roomCode);
  h.session.startGame();
  h.session.toggleTile(tile);
  h.session.play();
  h.session.pass();
  h.session.setMuted(true);
  expect(s.close).toHaveBeenCalledTimes(1);
  expect(h.session.getState()).toBe(stopped);
  expect([...h.saved.values]).toEqual(saved);
  expect(h.sockets).toHaveLength(1);
});

test("malformed stored credentials are removed and resume without a credential is idle", () => {
  for (const raw of [
    "{",
    "null",
    '{"roomCode":"X","token":"a"}',
    JSON.stringify({ roomCode, token: "" }),
    JSON.stringify({ roomCode, token: "a", seatId: 1 }),
  ]) {
    const saved = storage();
    saved.setItem(key, raw);
    const h = harness(saved);
    h.session.resume();
    expect(h.sockets).toHaveLength(0);
    expect(h.session.getState()).toMatchObject({
      credential: null,
      connection: "DISCONNECTED",
    });
    expect(saved.getItem(key)).toBeNull();
  }
});

test("join requires a canonical code and losing an unseated socket returns to entry", () => {
  const h = harness();
  h.session.joinRoom(roomCode);
  expect(h.session.getState().connection).toBe("CONNECTING");
  h.session.joinRoom(` ${roomCode.toLowerCase()} `);
  h.session.resume();
  const s = h.latest();
  s.events.open();
  expect(s.sent).toEqual([{ type: "JOIN_ROOM", roomCode }]);
  expect(h.session.getState().pending).toEqual(s.sent[0] ?? null);
  s.events.close();
  expect(h.session.getState()).toMatchObject({
    connection: "DISCONNECTED",
    pending: null,
    view: null,
  });
  expect(h.sockets).toHaveLength(1);
  h.session.joinRoom(roomCode);
  h.latest().events.open();
  h.latest().frame({ type: "ERROR", code: "GAME_STARTED" });
  expect(h.session.getState()).toMatchObject({
    connection: "DISCONNECTED",
    errorCode: "GAME_STARTED",
    pending: null,
  });
});

test("synchronous open or send failure consumes one immediate retry per explicit resume", () => {
  for (const moment of ["openSocket", "send"]) {
    let attempts = 0;
    const sent: string[] = [];
    const h = harness(stored(lostResume.credential), {
      openSocket(events) {
        attempts++;
        if (attempts > 4) throw Error("retry budget exceeded");
        if (moment === "openSocket") events.close();
        else events.open();
        return {
          send(frame) {
            sent.push(frame);
            events.close();
          },
          close: events.close,
        };
      },
    });
    for (const count of [2, 4]) {
      h.session.resume();
      expect(attempts).toBe(count);
      expect(sent.map((s) => JSON.parse(s))).toEqual(
        moment === "send" ? Array(count).fill(lostResume.command) : [],
      );
      expect(h.session.getState()).toMatchObject({
        connection: "DISCONNECTED",
        pending: null,
        credential: { roomCode, token: lostResume.credential.token },
      });
    }
  }
});

test("a restored connection can recover again and intersects the disconnected selection", () => {
  const h = harness();
  const s = h.enter(deadlines.before);
  h.session.toggleTile(tile);
  h.session.play();
  s.events.close();
  h.session.toggleTile(tile);
  h.session.play();
  h.session.pass();
  h.session.startGame();
  expect(h.session.getState()).toMatchObject({
    connection: "RESTORING",
    pending: null,
    selected: [tile],
    view: null,
  });
  const r = h.latest();
  r.events.open();
  r.frame(newRoomSequence.previous);
  r.frame(deadlines.stale.after);
  expect(h.session.getState().selected).toEqual([]);
  r.events.close();
  expect(h.sockets).toHaveLength(3);
});

test("only applicable commands send; start waits for the phase and guests can preselect", () => {
  const h = harness();
  h.session.play();
  h.session.pass();
  h.session.startGame();
  h.session.toggleTile(tile);
  expect(h.sockets).toHaveLength(0);
  const s = h.enter(phaseExamples[0]);
  h.session.startGame();
  h.session.startGame();
  s.frame({ ...phaseExamples[0], revision: 4 });
  expect(h.session.getState().pending).toEqual(seatReuse.startCommand);
  s.frame({ ...phaseExamples[1], revision: 5 });
  expect(h.session.getState().pending).toBeNull();
  h.session.play();
  h.session.pass();
  h.session.startGame();
  s.frame({ ...deadlines.before, revision: 6 });
  h.session.toggleTile({ number: 15, suit: 3 });
  h.session.play();
  h.session.pass();
  expect(h.session.getState().selected).toEqual([]);
  expect(s.sent).toEqual([
    { type: "JOIN_ROOM", roomCode },
    seatReuse.startCommand,
  ]);
  s.frame(lastPlaySequence.continuing[0]);
  const owned = required(h.session.getState().view?.ownHand?.[0]);
  h.session.toggleTile(owned);
  h.session.play();
  h.session.pass();
  expect(h.session.getState().selected).toEqual([owned]);
  h.session.toggleTile({ ...owned });
  expect(h.session.getState().selected).toEqual([]);
  expect(s.sent).toHaveLength(2);
});

test("only turn changes and user actions other than mute dismiss errors", () => {
  const h = harness();
  const s = h.enter(deadlines.before);
  const reject = () => s.frame(deadlines.stale.reply);
  reject();
  s.frame(deadlines.presence);
  h.session.setMuted(true);
  expect(h.session.getState().errorCode).toBe("STALE_TURN");
  s.frame({ ...deadlines.stale.after, revision: 7 });
  expect(h.session.getState().errorCode).toBeNull();
  for (const action of [
    h.session.play,
    h.session.pass,
    h.session.startGame,
    h.session.resume,
    () => h.session.toggleTile(tile),
    () => h.session.joinRoom("invalid"),
  ]) {
    reject();
    action();
    expect(h.session.getState().errorCode).toBeNull();
  }
  expect(h.sockets).toHaveLength(1);
  reject();
  h.session.createRoom();
  expect(h.session.getState().errorCode).toBeNull();
});

test("throwing subscribers and audio do not interrupt updates or replay effects", () => {
  const fail = mock(() => {
    throw Error("consumer failed");
  });
  const h = harness(storage(), { effects: fail });
  h.session.subscribe(() => {
    throw Error("view failed");
  });
  const listener = mock(() => {});
  h.session.subscribe(listener);
  const s = h.enter(lastPlaySequence.continuing[0]);
  s.frame(lastPlaySequence.continuing[3]);
  s.frame(lastPlaySequence.continuing[4]);
  expect(h.session.getState().view).toEqual(
    lastPlaySequence.continuing[4].view,
  );
  expect(fail).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalled();
});

test("first result snapshots include the completed game and malformed results preserve the accepted revision", () => {
  for (const { frame, recipient } of [
    ...abandonmentLobbyExamples,
    nonHostAbandonmentLobby,
  ]) {
    const h = harness();
    h.enter(frame, { ...abandonmentRestart.observer, seatId: recipient });
    expect(h.session.getState().revision).toBe(frame.revision);
    expect(h.effects).not.toHaveBeenCalled();
  }
  for (const { recipient, frame } of invalidAbandonmentExamples) {
    const h = harness();
    const s =
      recipient === 0
        ? h.enter(phaseExamples[0])
        : h.enter(
            abandonmentLobbyExamples[0].frame,
            abandonmentRestart.observer,
          );
    const previous = h.session.getState();
    s.frame(frame);
    expect(h.session.getState().view).toBe(previous.view);
    expect(h.session.getState().revision).toBe(previous.revision);
    expect(h.session.getState().errorCode).toBe("INVALID_MESSAGE");
  }
});

test("survivor resumes directly into a silent result lobby with the same credential", () => {
  const { command, replies } = abandonmentLobbyResume;
  const h = harness(stored(command));
  h.session.resume();
  const socket = h.latest();
  socket.events.open();
  expect(socket.sent).toEqual([command]);
  for (const reply of replies) socket.frame(reply);
  expect(h.session.getState()).toMatchObject({
    view: replies[1].view,
    connection: "CONNECTED",
    credential: { token: command.token, roomCode },
  });
  expect(h.saved.getItem(key)).toBe(stored(command).getItem(key));
  expect(h.effects).not.toHaveBeenCalled();
});

test("restart replay preserves every accepted frame and emits exactly the per-game effect batches", () => {
  const { observer, observed, effectBatches, exchanges } = abandonmentRestart;
  for (const muted of [false, true]) {
    const h = harness();
    h.session.setMuted(muted);
    const socket = h.enter(observed[0], observer);
    const listen = mock();
    h.session.subscribe(listen);
    let oldTurn = 0;
    for (const [i, frame] of observed.entries()) {
      const before = h.session.getState();
      h.effects.mockClear();
      if (frame.type === "ERROR") {
        expect(before.revision).toBe(exchanges.stale[0].atRevision);
        if (!before.selected.length)
          h.session.toggleTile(required(before.view?.ownHand?.[0]));
        h.session.play();
        expect(h.session.getState().pending?.type).toBe("PLAY");
      }
      if (i !== 0) socket.frame(frame);
      const state = h.session.getState();
      const batch = required(effectBatches[i]);
      expect(h.effects.mock.calls).toEqual(
        muted || !batch.length ? [] : [[batch]],
      );
      if (frame.type === "ERROR") {
        expect(state.view).toBe(before.view);
        expect(state.revision).toBe(before.revision);
        expect(state.pending).toBeNull();
        expect(state.errorCode).toBe("STALE_TURN");
        continue;
      }
      expect(state.view).toEqual(frame.view);
      expect(state.revision).toBe(frame.revision);
      if (frame.revision < 19)
        oldTurn = Math.max(oldTurn, frame.view.turnId ?? 0);
      if (frame.revision === 18)
        h.session.toggleTile(required(frame.view.ownHand?.[0]));
      if (frame.revision === 19) {
        expect(before.view?.phase).toBe("TURN_ACTIVE");
        expect(state.view?.phase).toBe("LOBBY");
        expect(before.selected.length).toBe(1);
        expect(state.selected).toEqual([]);
        expect(state.muted).toBe(muted);
        expect(state.credential).toBe(before.credential);
        expect(h.saved.getItem(key)).toBe(JSON.stringify(state.credential));
        listen.mockClear();
        socket.frame(frame);
        socket.frame({ ...frame, revision: frame.revision - 1 });
        expect(h.session.getState()).toBe(state);
        expect(listen).not.toHaveBeenCalled();
        expect(h.effects).not.toHaveBeenCalled();
      }
      if (frame.revision === 20) {
        expect(
          state.view?.phase === "LOBBY" && state.view.lastGameResult,
        ).toEqual(before.view?.phase === "LOBBY" && before.view.lastGameResult);
        h.session.startGame();
        expect(socket.sent.at(-1)).toEqual(exchanges.acceptedStart.command);
      }
      if (frame.revision >= 21)
        expect(state.view).not.toHaveProperty("lastGameResult");
      if (frame.revision === 21) {
        expect(state.pending).toBeNull();
        expect(state.view?.round).toBe(1);
        for (const seat of frame.view.slots)
          if (seat) expect(seat).toMatchObject({ chips: 64, isOut: false });
      }
      if (frame.revision === 22) {
        expect(oldTurn).toBe(10);
        expect(state.view?.turnId).toBe(oldTurn + 1);
      }
    }
  }
});

test("an abandonment lobby clears an outstanding turn command and selection", () => {
  const { observed, observer } = abandonmentRestart;
  for (const [before, command] of [
    [observed[0], "PLAY"],
    [turnErrorExamples[5].before, "PASS"],
  ] as const) {
    const h = harness();
    const s = h.enter(before, observer);
    h.session.toggleTile(required(before.view.ownHand?.[0]));
    if (command === "PLAY") h.session.play();
    else h.session.pass();
    expect(h.session.getState().pending?.type).toBe(command);
    s.frame(abandonmentLobbyExamples[0].frame);
    expect(h.session.getState()).toMatchObject({
      pending: null,
      selected: [],
      view: abandonmentLobbyExamples[0].frame.view,
    });
  }
});

test("presence and rejected start preserve the completed game", () => {
  const [first, offline, returned] = abandonmentLobbyExamples;
  const h = harness();
  const s = h.enter(first.frame, abandonmentRestart.observer);
  h.session.startGame();
  expect(h.session.getState().pending).toEqual({ type: "START_GAME" });
  s.frame(abandonmentRestart.exchanges.rejectedStart.replies[0]);
  expect(h.session.getState()).toMatchObject({
    pending: null,
    errorCode: "NOT_HOST",
    view: first.frame.view,
  });
  for (const { frame } of [offline, returned]) {
    s.frame(frame);
    expect(h.session.getState().view).toEqual(frame.view);
    expect(h.session.getState().view).toHaveProperty(
      "lastGameResult",
      abandonmentResults.afterRoundOne.result,
    );
  }
});

test("a revoked or disposed seat returns to entry and can join the result lobby anew", () => {
  const { revoked, joined, rejectedStart } = abandonmentRestart.exchanges;
  for (const error of [
    revoked.replies[0],
    { type: "ERROR", code: "ROOM_NOT_FOUND" },
  ]) {
    const h = harness(stored(revoked.command));
    h.session.resume();
    const s = h.latest();
    s.events.open();
    expect(s.sent).toEqual([revoked.command]);
    s.frame(error);
    expect(h.session.getState()).toMatchObject({
      view: null,
      connection: "DISCONNECTED",
      credential: null,
      errorCode: error.code,
    });
    expect(h.saved.getItem(key)).toBeNull();
    expect(s.close).toHaveBeenCalledTimes(1);
    h.session.joinRoom(roomCode);
    const next = h.latest();
    next.events.open();
    expect(next.sent).toEqual([joined.command]);
    for (const reply of joined.replies) next.frame(reply);
    expect(h.session.getState()).toMatchObject({
      view: joined.replies[1].view,
      credential: { roomCode, token: joined.replies[0].token },
      errorCode: null,
    });
    expect(h.saved.getItem(key)).toBe(stored(joined.replies[0]).getItem(key));
    next.frame(rejectedStart.replies[0]);
    expect(h.session.getState()).toMatchObject({
      view: rejectedStart.after.view,
      errorCode: "NOT_HOST",
      pending: null,
    });
  }
});

test("names ride on create and join, and leaving revokes the seat and returns to entry keeping mute", () => {
  const { joins, after, rejoin } = leaveExamples.lobby;
  const h = harness();
  h.session.setMuted(true);
  h.session.createRoom("철수");
  const host = h.latest();
  host.events.open();
  expect(host.sent).toEqual([joins[0].command]);
  for (const reply of joins[0].replies) host.frame(reply);
  expect(h.saved.getItem(key)).not.toBeNull();
  h.session.leaveRoom?.();
  expect<unknown>(host.sent.at(-1)).toEqual(leaveExamples.command);
  expect(host.close).toHaveBeenCalledTimes(1);
  expect(h.saved.getItem(key)).toBeNull();
  expect(h.session.getState()).toEqual({
    connection: "DISCONNECTED",
    seatId: null,
    view: null,
    revision: null,
    timeAnchor: null,
    selected: [],
    pending: null,
    errorCode: null,
    credential: null,
    muted: true,
  });
  host.frame(after[0].frame);
  expect(h.session.getState().view).toBeNull();
  h.session.joinRoom(roomCode, "철수");
  const again = h.latest();
  again.events.open();
  expect(again.sent).toEqual([rejoin.command]);
  for (const reply of rejoin.replies) again.frame(reply);
  expect(h.session.getState().view).toEqual(rejoin.replies[1].view);
  h.session.joinRoom(roomCode);
  h.latest().events.open();
  expect(h.latest().sent).toEqual([joins[1].command]);
  // Unseated: nothing to revoke on the wire, but the socket still closes.
  h.session.leaveRoom?.();
  expect(h.latest().sent).toEqual([joins[1].command]);
  expect(h.latest().close).toHaveBeenCalledTimes(1);
  expect(h.session.getState().connection).toBe("DISCONNECTED");
});

test("only CREATE_ROOM carries its supplied settings", () => {
  const h = harness();
  for (const settings of [
    undefined,
    { turnLimitSeconds: 15 },
    { maxRounds: 10 },
    { turnLimitSeconds: 45, maxRounds: 3 },
  ] as const) {
    h.session.createRoom("별", settings);
    h.latest().events.open();
    expect(h.latest().sent).toEqual([
      { type: "CREATE_ROOM", name: "별", ...settings },
    ]);
  }
  h.session.joinRoom(roomCode, "별");
  h.latest().events.open();
  expect(h.latest().sent).toEqual([
    { type: "JOIN_ROOM", roomCode, name: "별" },
  ]);
});
