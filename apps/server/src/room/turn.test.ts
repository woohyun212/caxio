import { expect, test } from "bun:test";
import {
  deadlines,
  epoch,
  errorExamples,
  phaseAndResumeErrors,
  roomCode,
  turnErrorExamples,
} from "@caxio/shared/contracts/fixtures";
import { at } from "./rules.fixture";
import { finish, harness, penultimate } from "./service.fixture";

for (const c of deadlines.cases)
  for (const order of c.reply ? ["request", "timer"] : ["request"]) {
    test(`deadline ${c.now - epoch - 30000}ms, ${order} first, commits once`, () => {
      const h = harness();
      h.start();
      expect(h.latest()).toEqual({ ...deadlines.before, serverNow: epoch });
      const timer = h.timer();
      h.clock.time = c.now;
      if (order === "timer") timer.fire();
      const count = h.log.length;
      h.request("A", c.command);
      if (order === "timer")
        expect(h.log.slice(count)).toEqual([
          { name: "A", message: deadlines.stale.reply },
        ]);
      else {
        const expected = [
          ...["A", "B", "C"].map((name) => ({ name, message: h.latest(name) })),
          ...(c.reply ? [{ name: "A", message: c.reply }] : []),
        ];
        expect(h.log.slice(count)).toEqual(expected);
      }
      expect(h.latest()).toEqual(c.after);
      expect(timer.cancelled).toBe(true);
      const after = h.log.length;
      timer.fire();
      expect(h.log.length).toBe(after);
      expect([h.calls.manual, h.calls.automatic, h.calls.attempts]).toEqual([
        c.manual,
        c.automatic,
        1,
      ]);
    });
  }
test("early callback rearms remaining time and replay of early callback is inert", () => {
  const h = harness(5, 53);
  h.start();
  const old = h.timer();
  expect(old.delay).toBe(53);
  h.clock.time += 52;
  const count = h.log.length;
  old.fire();
  const next = h.timer();
  expect(next.delay).toBe(1);
  expect(h.log.length).toBe(count);
  expect(h.calls.attempts).toBe(0);
  h.clock.time++;
  old.fire();
  expect(h.calls.attempts).toBe(0);
  next.fire();
  expect(h.calls.automatic).toBe(1);
  expect(h.latest().view.deadline).toBe(h.clock.time + 53);
});
test("presence preserves the original clock and a late non-current seat gets TIME_EXPIRED", () => {
  const h = harness();
  h.start();
  const timer = h.timer();
  h.clock.time = deadlines.presence.serverNow;
  h.close("B");
  expect(h.latest()).toEqual(deadlines.presence);
  h.clock.time++;
  h.resume("B2", "B");
  expect(h.latest()).toEqual({
    ...deadlines.before,
    revision: 7,
    serverNow: h.clock.time,
  });
  expect(h.timer()).toBe(timer);
  expect(timer.cancelled).toBe(false);
  const c = turnErrorExamples[2];
  h.clock.time = c.now;
  const count = h.log.length;
  h.request("B2", c.command);
  expect(h.log.slice(count).map((row) => [row.name, row.message.type])).toEqual(
    [
      ["A", "SNAPSHOT"],
      ["B2", "SNAPSHOT"],
      ["C", "SNAPSHOT"],
      ["B2", "ERROR"],
    ],
  );
  expect(h.messages("B2").at(-1)).toEqual(c.reply);
  timer.fire();
  expect(h.calls.automatic).toBe(1);
  expect(h.calls.manual).toBe(0);
});
test("turn validation returns fixture errors with no transition or revision", () => {
  const h = harness();
  h.start();
  const first = h.latest();
  h.clock.time += 100;
  for (const i of [0, 3, 4, 8] as const) {
    const c = turnErrorExamples[i];
    h.reject(c.recipient === 0 ? "A" : "B", c.command, c.reply.code);
  }
  h.reject("B", phaseAndResumeErrors[3].command, "INVALID_PHASE");
  h.reject("x", { type: "JOIN_ROOM", roomCode }, "GAME_STARTED");
  h.reject("A", at(errorExamples.at(-1)).command, "INVALID_MESSAGE");
  h.reject("A", "{", "INVALID_MESSAGE");
  expect(h.latest()).toEqual(first);
  expect(h.calls.attempts).toBe(4);
  const c = at(deadlines.cases[0]);
  h.clock.time = c.now;
  h.request("A", c.command);
  expect(h.latest()).toEqual(deadlines.stale.before);
  for (const i of [5, 6] as const) {
    const e = turnErrorExamples[i];
    h.reject("B", e.command, e.reply.code);
  }
  h.clock.time = turnErrorExamples[1].now;
  h.reject("A", deadlines.stale.command, deadlines.stale.reply.code);
  h.reject("B", { type: "PASS", turnId: 999 }, "STALE_TURN");
  expect(h.latest()).toEqual(deadlines.stale.after);
  expect(h.calls.attempts).toBe(7);
  h.resume("retry", "C");
  expect(h.latest("retry").revision).toBe(c.after.revision);
  const tail = harness();
  tail.start();
  penultimate(tail);
  const e = turnErrorExamples[7];
  tail.reject(
    "B",
    { ...e.command, turnId: tail.latest().view.turnId },
    e.reply.code,
  );
});
for (const scenario of ["previous turn", "previous round", "replaced socket"])
  test(`stale ${scenario} before and after a current event matches baseline`, () => {
    function run(order: "before" | "after" | "baseline") {
      const h = harness();
      h.start();
      const timer = h.timer();
      h.clock.time += 10;
      if (scenario === "previous round") finish(h);
      else if (scenario === "previous turn")
        h.request("A", at(deadlines.cases[0]).command);
      else h.resume("new", "A");
      if (scenario !== "replaced socket") h.clock.time = epoch + timer.delay;
      const stale = () =>
        scenario === "replaced socket" ? h.close("A") : timer.fire();
      const count = h.log.length;
      if (order === "before") stale();
      const v = h.latest("C").view;
      const name =
        scenario === "previous turn"
          ? "B"
          : scenario === "replaced socket"
            ? "new"
            : "A";
      h.request(
        name,
        v.tableHand
          ? { type: "PASS", turnId: v.turnId }
          : { ...at(deadlines.cases[0]).command, turnId: v.turnId },
      );
      if (order === "after") stale();
      expect(h.calls.state?.turnId).toBe(at(v.turnId) + 1);
      return {
        messages: h.log.slice(count),
        timers: h.timers.map(({ delay, cancelled }) => ({ delay, cancelled })),
      };
    }
    const baseline = run("baseline");
    expect(run("before")).toEqual(baseline);
    expect(run("after")).toEqual(baseline);
  });
test("all-left game keeps timing turns, permits resume and cancels empty expiry", () => {
  const h = harness();
  h.start();
  const active = h.timer();
  for (const name of ["A", "B", "C"]) h.close(name);
  const disposal = h.timer();
  expect(h.timers.length).toBe(2);
  h.clock.time += active.delay;
  active.fire();
  expect(h.calls.automatic).toBe(1);
  const follower = h.timer();
  h.clock.time += follower.delay;
  follower.fire();
  expect(h.calls.automatic).toBe(2);
  h.resume("retry", "A");
  expect(h.latest("retry").view.lastAction).toMatchObject({
    automatic: true,
    type: "PASS",
  });
  expect(disposal.cancelled).toBe(true);
  h.clock.time += disposal.delay;
  const count = h.log.length;
  disposal.fire();
  expect(h.log.length).toBe(count);
  h.resume("B2", "B");
  expect(h.latest("B2").view.seatOrder).toEqual([0, 1, 2]);
});

test("disposing an offline game revokes its seats and cancels its live turn", () => {
  const h = harness();
  h.start();
  const turn = h.timer();
  for (const name of ["A", "B", "C"]) h.close(name);
  const empty = h.timer();
  h.clock.time += empty.delay;
  empty.fire();
  expect(turn.cancelled).toBe(true);
  h.reject(
    "retry",
    { type: "RESUME", roomCode, token: "fixture-A" },
    "ROOM_NOT_FOUND",
  );
  h.codes.unshift(roomCode);
  h.request("fresh", { type: "CREATE_ROOM" });
  const count = h.log.length;
  turn.fire();
  empty.fire();
  expect(h.log.length).toBe(count);
  expect(h.calls.attempts).toBe(0);
  h.join("visitor");
  expect(h.latest("fresh").view.seatOrder).toEqual([0, 1]);
});
