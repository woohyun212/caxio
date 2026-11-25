import { expect, test } from "bun:test";
import {
  epoch,
  lastPlaySequence,
  newRoomSequence,
  phaseAndResumeErrors,
  phaseExamples,
  roomCode,
  spectatorExamples,
} from "@caxio/shared/contracts/fixtures";
import { ROOM_DISPOSAL_MS } from "../contracts";
import { at, tile } from "./rules.fixture";
import { finish, harness, penultimate } from "./service.fixture";

for (const ending of [false, true])
  test(`winning play publishes settlement before ${ending ? "game over" : "next round"}`, () => {
    const h = harness(ending ? 1 : 5);
    h.start();
    expect(h.snaps("A").at(-2)?.view).toEqual({
      ...phaseExamples[1].view,
      maxRounds: ending ? 1 : 5,
    });
    expect(h.latest().view).toEqual({
      ...phaseExamples[2].view,
      maxRounds: ending ? 1 : 5,
    });
    penultimate(h);
    const [before, pass, clear, paid, next] = lastPlaySequence.continuing;
    const lead = at(h.latest().view.turnId),
      last = { ...at(before.view.lastPlay), turnId: lead - 1 };
    const frames = [before, pass, clear];
    for (const [i, f] of frames.entries()) {
      if (f.view.phase !== "TURN_ACTIVE")
        throw new Error("Expected active fixture");
      if (i)
        h.request(i === 1 ? "B" : "C", { type: "PASS", turnId: lead + i - 1 });
      expect(h.latest().view).toEqual({
        ...f.view,
        maxRounds: ending ? 1 : 5,
        turnId: lead + i,
        deadline: epoch + 30000,
        lastPlay: last,
        lastAction: { ...at(f.view.lastAction), turnId: lead + i - 1 },
      });
    }
    const beforeRevision = h.latest().revision;
    const count = h.snaps("A").length;
    h.clock.time++;
    h.request("A", { type: "PLAY", turnId: lead + 2, tiles: [tile(1)] });
    const sequence = h.snaps("A").slice(count);
    expect(sequence.map((s) => s.revision)).toEqual(
      ending
        ? [beforeRevision + 1, beforeRevision + 2]
        : [beforeRevision + 1, beforeRevision + 2, beforeRevision + 3],
    );
    const winning = {
      lastPlay: { ...at(paid.view.lastPlay), turnId: lead + 2 },
      lastAction: { ...at(paid.view.lastAction), turnId: lead + 2 },
    };
    const expected = ending ? lastPlaySequence.ending[1] : paid;
    expect(sequence[0]?.view).toEqual({ ...expected.view, ...winning });
    if (ending) {
      expect(sequence[1]?.view).toEqual({
        ...phaseExamples[4].view,
        ...winning,
      });
      h.reject("B", phaseAndResumeErrors[2].command, "INVALID_PHASE");
    } else {
      expect(sequence[1]?.view).toEqual(next.view);
      if (next.view.phase !== "ROUND_START")
        throw new Error("Expected start fixture");
      expect(sequence[2]?.view).toEqual({
        ...next.view,
        phase: "TURN_ACTIVE",
        turnId: lead + 3,
        deadline: h.clock.time + 30000,
      });
    }
  });
test("OUT transition, next round, spectator resume and final ranking have public results only", () => {
  const h = harness(2);
  h.start(4);
  finish(h);
  const f = spectatorExamples;
  const [paid, next, active] = h.snaps("D").slice(-3);
  const paidView = at(paid).view;
  const winId = at(at(active).view.turnId) - 1;
  const winning = {
    lastPlay: { ...at(f.transition.view.lastPlay), turnId: winId },
    lastAction: { ...at(f.transition.view.lastAction), turnId: winId },
  };
  expect(paidView).toEqual({ ...f.transition.view, ...winning });
  expect(at(next).view).toEqual(f.following.view);
  expect(h.snaps("B").at(-3)?.view).toEqual({
    ...f.survivor.frame.view,
    ...winning,
  });
  h.clock.time++;
  h.close("D");
  h.resume("spectator", "D");
  expect(h.messages("spectator")[0]).toEqual(f.resume);
  if (f.restored.view.phase !== "TURN_ACTIVE")
    throw new Error("Expected active fixture");
  expect(h.latest("spectator").view).toEqual({
    ...f.restored.view,
    turnId: winId + 1,
    deadline: epoch + 30000,
  });
  h.close("B");
  h.resume("survivor", "B");
  expect(h.latest("survivor").view.ownSettlement).toEqual(
    f.survivor.frame.view.ownSettlement,
  );
  finish(h, ["A", "survivor", "C", "spectator"]);
  const final = h.latest("spectator").view;
  expect(final).toEqual({
    ...f.gameOver.view,
    lastPlay: {
      ...at(f.gameOver.view.lastPlay),
      turnId: at(h.calls.state).turnId,
    },
    lastAction: {
      ...at(f.gameOver.view.lastAction),
      turnId: at(h.calls.state).turnId,
    },
  });
  expect(h.latest("survivor").view.ownSettlement).toEqual({
    ...at(f.survivor.frame.view.ownSettlement),
    round: 2,
  });
  expect(h.snaps("survivor").at(-2)?.view.ownSettlement).toEqual(
    h.latest("survivor").view.ownSettlement,
  );
});
test("finished room keeps original expiry across close, resume and fresh CREATE", () => {
  const h = harness(1);
  h.start();
  finish(h);
  const finished = h.latest(),
    timer = h.timer();
  expect(timer.delay).toBe(ROOM_DISPOSAL_MS);
  expect(finished.view.phase).toBe("GAME_OVER");
  h.clock.time += 42;
  h.close("B");
  expect(h.latest().view).toEqual({
    ...finished.view,
    slots: [
      finished.view.slots[0],
      { ...at(finished.view.slots[1]), isConnected: false },
      finished.view.slots[2],
      finished.view.slots[3],
      finished.view.slots[4],
    ] as const,
  });
  h.close("C");
  h.close("A");
  h.clock.time = finished.serverNow + ROOM_DISPOSAL_MS - 1;
  h.resume("resumed", "A");
  expect(h.latest("resumed").view.phase).toBe("GAME_OVER");
  expect(h.latest("resumed").view.ownSettlement).toEqual(
    finished.view.ownSettlement,
  );
  h.reject("visitor", { type: "JOIN_ROOM", roomCode }, "GAME_STARTED");
  h.tokens.splice(0, h.tokens.length, "fixture-new", "fixture-guest");
  h.request("new", newRoomSequence.command);
  expect(h.messages("new")).toEqual([
    newRoomSequence.response,
    { ...newRoomSequence.lobby, serverNow: h.clock.time },
  ]);
  expect(timer.cancelled).toBe(false);
  expect(h.timer()).toBe(timer);
  h.clock.time++;
  timer.fire();
  h.reject(
    "outsider",
    { type: "RESUME", roomCode, token: "fixture-A" },
    "ROOM_NOT_FOUND",
  );
  h.reject("resumed", { type: "START_GAME" }, "NOT_SEATED");
  h.request("resumed", {
    type: "JOIN_ROOM",
    roomCode: newRoomSequence.response.roomCode,
  });
  expect(h.latest("resumed").view.seatOrder).toEqual([0, 1]);
});
