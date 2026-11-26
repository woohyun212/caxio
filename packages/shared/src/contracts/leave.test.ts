import { expect, test } from "bun:test";
import type { SeatId } from "./domain";
import {
  leaveExamples,
  namedViews,
  playerNameExamples,
  roomCode,
} from "./fixtures";
import {
  type Command,
  decodeCommand,
  decodeRequest,
  decodeServerMessage,
  isPlayerName,
  type Message,
  PLAYER_NAME_MAX_LENGTH,
  type PlayerView,
  type Snapshot,
} from "./wire";

const invalid = "INVALID_MESSAGE";
const json = (v: unknown) => JSON.stringify(v);
function checkFrame(frame: Message, seat: SeatId | null) {
  expect(decodeServerMessage(json(frame), seat)).toEqual(frame);
}
function lobbyOf(frame: Snapshot) {
  const view = frame.view;
  if (view.phase !== "LOBBY") throw Error("expected a lobby");
  return view;
}
function resultOf(frame: Snapshot) {
  const result = lobbyOf(frame).lastGameResult;
  if (!result) throw Error("expected a last game result");
  return result;
}
const names = (view: PlayerView) => view.slots.map((s) => s?.name ?? null);
const disconnect = (view: PlayerView, seat: SeatId) =>
  view.slots.map((s, i) =>
    i === seat && s ? { ...s, isConnected: false } : s,
  );
function patched(frame: Snapshot, view: Record<string, unknown>) {
  return json({ ...frame, view: { ...frame.view, ...view } });
}

test("names are 1–6 Hangul, jamo, ASCII letters or digits and the wire never trims", () => {
  expect(PLAYER_NAME_MAX_LENGTH).toBe(6);
  for (const name of playerNameExamples.valid)
    expect(isPlayerName(name)).toBe(true);
  for (const name of playerNameExamples.normalize) {
    expect(isPlayerName(name)).toBe(false);
    expect(isPlayerName(name.trim())).toBe(true);
  }
  for (const name of playerNameExamples.invalid)
    expect(isPlayerName(name)).toBe(false);
});

test("CREATE_ROOM and JOIN_ROOM carry an optional canonical name; LEAVE_ROOM is a request only", () => {
  for (const name of playerNameExamples.valid) {
    const named: Command[] = [
      { type: "CREATE_ROOM", name },
      { type: "JOIN_ROOM", roomCode, name },
    ];
    for (const c of named) {
      expect(decodeCommand(json(c))).toEqual(c);
      expect(decodeRequest(json(c))).toEqual(c);
    }
  }
  for (const name of [
    ...playerNameExamples.invalid,
    ...playerNameExamples.normalize,
  ]) {
    expect(decodeRequest(json({ type: "CREATE_ROOM", name }))).toBe(invalid);
    expect(decodeRequest(json({ type: "JOIN_ROOM", roomCode, name }))).toBe(
      invalid,
    );
  }
  for (const c of [
    { type: "RESUME", roomCode, token: "fixture-A", name: "철수" },
    { type: "START_GAME", name: "철수" },
    { type: "LEAVE_ROOM", name: "철수" },
    { type: "LEAVE_ROOM", roomCode },
  ])
    expect(decodeRequest(json(c))).toBe(invalid);
  expect(decodeRequest(json(leaveExamples.command))).toEqual({
    type: "LEAVE_ROOM",
  });
  expect(decodeCommand(json(leaveExamples.command))).toBe(invalid);
});

test("public seats and abandonment rows carry only valid names", () => {
  for (const { recipient, frame } of [namedViews.lobby, namedViews.game]) {
    checkFrame(frame, recipient);
    expect(names(frame.view)).toEqual([
      "철수",
      null,
      "Bob7",
      "ㅋㅋ",
      "가나다라마바",
    ]);
    expect(Object.hasOwn(frame.view.slots[1] ?? {}, "name")).toBe(false);
    for (const name of playerNameExamples.invalid) {
      const slots = frame.view.slots.map((s, i) => (i ? s : { ...s, name }));
      expect(decodeServerMessage(patched(frame, { slots }), recipient)).toBe(
        invalid,
      );
    }
  }
  expect(namedViews.game.frame.view.currentTurn).toBe(4);
  const { recipient, frame } = leaveExamples.game.after[0];
  const result = resultOf(frame);
  for (const name of playerNameExamples.invalid) {
    const ranking = result.ranking.map((row, i) =>
      i ? row : { ...row, name },
    );
    const lastGameResult = { ...result, ranking };
    expect(
      decodeServerMessage(patched(frame, { lastGameResult }), recipient),
    ).toBe(invalid);
  }
});

test("leaving the lobby vacates the seat at once, moves the host and frees the connection", () => {
  const { joins, leaver, after, revoked, rejoin } = leaveExamples.lobby;
  for (const { recipient, command, replies } of joins) {
    expect(decodeRequest(json(command))).toEqual(command);
    for (const reply of replies) checkFrame(reply, recipient);
  }
  const before = joins[2].replies[1];
  expect(names(before.view)).toEqual(["철수", null, "Bob7", null, null]);
  for (const { recipient, frame } of after) {
    checkFrame(frame, recipient);
    expect(frame.revision).toBe(before.revision + 1);
    expect(frame.view.seatOrder).toEqual([1, 2]);
    expect(lobbyOf(frame).hostSeatId).toBe(1);
    expect(frame.view.slots[leaver.seatId]).toBeNull();
    expect(names(frame.view)).toEqual([null, null, "Bob7", null, null]);
  }
  expect(revoked.command.token).toBe(leaver.token);
  checkFrame(revoked.reply, null);
  expect(revoked.reply.code).toBe("RESUME_DENIED");
  const [seated, lobby] = rejoin.replies;
  checkFrame(seated, null);
  checkFrame(lobby, seated.seatId);
  expect(seated.token).not.toBe(leaver.token);
  expect(lobby.view.seatOrder).toEqual([1, 2, 0]);
  expect(lobby.revision).toBe(after[0].frame.revision + 1);
});

test("an active seat leaving a running game ends it by abandonment with current chips", () => {
  const { before, leaver, now, after, revoked } = leaveExamples.game;
  for (const { recipient, frame } of before) {
    checkFrame(frame, recipient);
    expect(frame.view.phase).toBe("TURN_ACTIVE");
    expect(frame.serverNow).toBeLessThanOrEqual(now);
  }
  const game = before[0].frame.view;
  expect(game.slots[leaver.seatId]?.isOut).toBe(false);
  expect(game.currentTurn).not.toBe(leaver.seatId);
  for (const { recipient, frame } of after) {
    checkFrame(frame, recipient);
    expect(frame.revision).toBe(before[0].frame.revision + 1);
    expect(frame.serverNow).toBe(now);
    expect(frame.view.seatOrder).toEqual(
      game.seatOrder.filter((id) => id !== leaver.seatId),
    );
    const result = resultOf(frame);
    expect(result.leaverSeatId).toBe(leaver.seatId);
    expect(result.ranking.at(-1)?.seatId).toBe(leaver.seatId);
    for (const row of result.ranking) {
      expect(row.chips).toBe(game.slots[row.seatId]?.chips ?? -1);
      expect(row.name ?? null).toBe(game.slots[row.seatId]?.name ?? null);
    }
  }
  expect(revoked.command.token).toBe(leaver.token);
  expect(revoked.reply.code).toBe("RESUME_DENIED");
});

test("an OUT spectator's leave keeps the game and vacates the seat on the next return to the lobby", () => {
  const { recipient, before, leaver, after, revoked, thenLeaves } =
    leaveExamples.spectator;
  checkFrame(before, recipient);
  checkFrame(after, recipient);
  expect(before.view.slots[leaver.seatId]?.isOut).toBe(true);
  expect(after.revision).toBe(before.revision + 1);
  expect({ ...after.view, slots: null }).toEqual({
    ...before.view,
    slots: null,
  });
  expect([...after.view.slots]).toEqual(disconnect(before.view, leaver.seatId));
  expect(revoked.command.token).toBe(leaver.token);
  expect(revoked.reply.code).toBe("RESUME_DENIED");
  for (const { recipient: r, frame } of thenLeaves.after) {
    checkFrame(frame, r);
    expect(frame.revision).toBe(after.revision + 1);
    expect(frame.view.seatOrder).toEqual([1, 2]);
    const { ranking, leaverSeatId } = resultOf(frame);
    expect(leaverSeatId).toBe(thenLeaves.leaver.seatId);
    expect(ranking.map((row) => [row.seatId, row.chips])).toEqual(
      [1, 2, 3, 0].map((id) => [id, after.view.slots[id]?.chips ?? -1]),
    );
  }
});

test("leaving GAME_OVER only disconnects the seat; an unbound LEAVE_ROOM is NOT_SEATED", () => {
  const { before, leaver, after, revoked } = leaveExamples.finished;
  checkFrame(before, 0);
  for (const { recipient, frame } of after) {
    checkFrame(frame, recipient);
    expect(frame.revision).toBe(before.revision + 1);
    expect(frame.view.phase).toBe("GAME_OVER");
    expect([...frame.view.slots]).toEqual(
      disconnect(before.view, leaver.seatId),
    );
  }
  expect(revoked.command.token).toBe(leaver.token);
  expect(revoked.reply.code).toBe("RESUME_DENIED");
  checkFrame(leaveExamples.unseated.reply, null);
  expect(leaveExamples.unseated.reply.code).toBe("NOT_SEATED");
});
