import { expect, test } from "bun:test";
import { epoch, roomCode } from "@caxio/shared/contracts/fixtures";
import type { PlayerView } from "@caxio/shared/contracts/wire";
import { leaveExamples } from "../fixtures/server-snapshots";
import { at } from "./rules.fixture";
import { finish, harness } from "./service.fixture";

type Harness = ReturnType<typeof harness>;
const leave = leaveExamples.command;
const names = ["A", "B", "C", "D"];
function expire(h: Harness) {
  h.clock.time += h.timer().delay;
  h.timer().fire();
}
function pass(h: Harness) {
  const g = at(h.calls.state);
  h.request(at(names[at(g.currentTurn)]), { type: "PASS", turnId: g.turnId });
}
function active(view: PlayerView) {
  if (view.phase !== "TURN_ACTIVE") throw new Error("Expected a turn");
  return view;
}
// The leaver's socket receives nothing for its own LEAVE_ROOM.
function silentLeave(h: Harness, name: string) {
  const count = h.messages(name).length;
  h.request(name, leave);
  expect(h.messages(name)).toHaveLength(count);
}

test("leaving the lobby vacates the seat at once, moves the host and frees the connection", () => {
  const f = leaveExamples.lobby;
  const h = harness();
  h.reject("X", leaveExamples.unseated.command, "NOT_SEATED");
  for (const [i, { command, replies }] of f.joins.entries()) {
    h.clock.time = replies[1].serverNow;
    h.request(at(names[i]), command);
    expect(h.messages(at(names[i]))).toEqual([...replies]);
  }
  h.clock.time = at(f.after[0]).frame.serverNow;
  silentLeave(h, "A");
  for (const { recipient, frame } of f.after)
    expect(h.latest(at(names[recipient]))).toEqual(frame);
  h.reject("revoked", f.revoked.command, "RESUME_DENIED");
  h.tokens.unshift("fixture-A2");
  const count = h.messages("A").length;
  h.clock.time = f.rejoin.replies[1].serverNow;
  h.request("A", f.rejoin.command);
  expect(h.messages("A").slice(count)).toEqual([...f.rejoin.replies]);
});

test("an active seat leaving a running game ends it by abandonment with its current chips", () => {
  const f = leaveExamples.game;
  const h = harness();
  h.request("A", { type: "CREATE_ROOM", name: "철수" });
  h.join("B");
  h.request("C", { type: "JOIN_ROOM", roomCode, name: "Bob7" });
  h.request("A", { type: "START_GAME" });
  for (const { recipient, frame } of f.before)
    expect(h.latest(at(names[recipient]))).toEqual({
      ...frame,
      serverNow: epoch,
    });
  const rankings = h.calls.rankings;
  h.clock.time = f.now;
  silentLeave(h, "C");
  for (const { recipient, frame } of f.after)
    expect(h.latest(at(names[recipient]))).toEqual(frame);
  expect(h.calls.rankings).toBe(rankings + 1);
  expect(h.timer().cancelled).toBe(true);
  h.reject("revoked", f.revoked.command, "RESUME_DENIED");
  h.request("C", { type: "CREATE_ROOM" });
  expect(h.messages("C").at(-2)).toMatchObject({
    type: "SEATED",
    roomCode: "WXYZ89",
    seatId: 0,
  });
});

test("an OUT spectator's leave keeps the game and its seat is vacated, never reserved, on the return to the lobby", () => {
  const f = leaveExamples.spectator;
  const h = harness(2);
  h.start(4);
  finish(h);
  const before = h.latest("B");
  const { turnId, deadline } = active(before.view);
  expect(before.view).toEqual({ ...active(f.before.view), turnId, deadline });
  h.clock.time++;
  silentLeave(h, "D");
  const after = h.latest("B");
  expect(after.revision).toBe(before.revision + 1);
  expect(after.view).toEqual({ ...active(f.after.view), turnId, deadline });
  h.reject("revoked", f.revoked.command, "RESUME_DENIED");
  const timers = h.timers.length;
  h.clock.time++;
  silentLeave(h, "A");
  for (const { recipient, frame } of f.thenLeaves.after)
    expect(h.latest(at(names[recipient]))).toEqual({
      ...frame,
      revision: after.revision + 1,
      serverNow: h.clock.time,
    });
  expect(h.timers).toHaveLength(timers);
  expect(h.timer().cancelled).toBe(true);
});

test("leaving GAME_OVER only disconnects the seat, keeps the disposal clock and frees the connection", () => {
  const f = leaveExamples.finished;
  const h = harness(1);
  h.start();
  finish(h);
  const before = h.latest("A");
  expect(before.view.phase).toBe("GAME_OVER");
  const timers = h.timers.length;
  h.clock.time++;
  silentLeave(h, "B");
  for (const { recipient, frame } of f.after) {
    const prior = at(h.snaps(at(names[recipient])).at(-2)).view;
    expect(h.latest(at(names[recipient]))).toEqual({
      ...frame,
      revision: before.revision + 1,
      serverNow: h.clock.time,
      view: {
        ...frame.view,
        lastPlay: prior.lastPlay,
        lastAction: prior.lastAction,
      },
    });
  }
  expect(h.timers).toHaveLength(timers);
  h.reject("revoked", f.revoked.command, "RESUME_DENIED");
  h.request("B", { type: "CREATE_ROOM" });
  expect(h.messages("B").at(-2)).toMatchObject({
    type: "SEATED",
    roomCode: "WXYZ89",
  });
});

test("a leave at the deadline handles the expired turn first and applies to the resulting lobby", () => {
  const h = harness();
  h.request("A", { type: "CREATE_ROOM", name: "철수" });
  h.join("B");
  h.join("C");
  h.request("A", { type: "START_GAME" });
  h.close("A");
  for (let i = 0; i < 2; i++) {
    expire(h);
    pass(h);
    pass(h);
  }
  expect(at(h.calls.state).currentTurn).toBe(0);
  h.clock.time += h.timer().delay;
  const automatic = h.calls.automatic;
  const count = h.messages("B").length;
  h.request("B", leave);
  // A's third disconnected expiry abandons first; B then leaves the lobby it produced.
  // B still sees that expiry's snapshot, as if the timer had fired first, and nothing for its leave.
  expect(h.messages("B")).toHaveLength(count + 1);
  expect(h.calls.automatic).toBe(automatic);
  const [abandoned, left] = h.snaps("C").slice(-2);
  expect(abandoned?.view).toMatchObject({
    phase: "LOBBY",
    seatOrder: [1, 2],
    lastGameResult: {
      leaverSeatId: 0,
      ranking: [
        { seatId: 1, rank: 1, chips: 64 },
        { seatId: 2, rank: 1, chips: 64 },
        { seatId: 0, rank: 3, chips: 64, name: "철수" },
      ],
    },
  });
  expect(left?.revision).toBe(at(abandoned).revision + 1);
  expect(left?.view).toMatchObject({ seatOrder: [2], hostSeatId: 2 });
  expect(h.latest("B").revision).toBe(at(abandoned).revision);
});

test("a name survives disconnection and RESUME, may repeat, and goes with the vacated seat", () => {
  const h = harness();
  const name = "가나다라마바";
  h.request("A", { type: "CREATE_ROOM", name });
  for (const bad of [`${name}사`, " 철수", "Bob!"])
    h.reject(
      "B",
      { type: "JOIN_ROOM", roomCode, name: bad },
      "INVALID_MESSAGE",
    );
  h.request("B", { type: "JOIN_ROOM", roomCode, name });
  const seat = { remainingTileCount: 0, chips: 64, isOut: false, name };
  expect(h.latest("B").view.slots.slice(0, 2)).toEqual([
    { ...seat, isConnected: true },
    { ...seat, isConnected: true },
  ]);
  h.close("A");
  expect(h.latest("B").view.slots[0]).toEqual({ ...seat, isConnected: false });
  h.resume("A2", "A");
  expect(h.latest("B").view.slots[0]).toEqual({ ...seat, isConnected: true });
  silentLeave(h, "A2");
  h.join("C");
  expect(h.messages("C")[0]).toMatchObject({ type: "SEATED", seatId: 0 });
  expect(h.latest("B").view.slots[0]).toEqual({
    remainingTileCount: 0,
    chips: 64,
    isOut: false,
    isConnected: true,
  });
});
