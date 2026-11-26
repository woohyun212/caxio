import { expect, spyOn, test } from "bun:test";
import { roomCode } from "@caxio/shared/contracts/fixtures";
import { at } from "./rules.fixture";
import { finish, harness } from "./service.fixture";

test("invalid room settings reject creation before allocating a code or seat", () => {
  const h = harness();
  for (const settings of [
    { turnLimitSeconds: 16 },
    { turnLimitSeconds: "15" },
    { maxRounds: 4 },
    { maxRounds: "3" },
  ])
    h.reject("A", { type: "CREATE_ROOM", ...settings }, "INVALID_MESSAGE");
  h.create();
  expect(h.messages("A").at(-2)).toEqual({
    type: "SEATED",
    roomCode,
    seatId: 0,
    token: "fixture-A",
  });
});

test("turn limit and maximum rounds default independently for each room", () => {
  const h = harness();
  h.create({ turnLimitSeconds: 60 });
  h.request("other", { type: "CREATE_ROOM", maxRounds: 7 });
  h.join("B");
  expect(h.latest("B").view).toMatchObject({
    turnLimitSeconds: 60,
    maxRounds: 5,
  });
  expect(h.latest("other").view).toMatchObject({
    turnLimitSeconds: 30,
    maxRounds: 7,
  });
  const defaults = harness();
  defaults.create();
  expect(defaults.latest().view).toMatchObject({
    turnLimitSeconds: 30,
    maxRounds: 5,
  });
});

test.each([15, 30] as const)(
  "explicit %i-second room limit overrides the service duration on successive turns",
  (seconds) => {
    const h = harness(undefined, 53);
    h.start(3, { turnLimitSeconds: seconds });
    for (const count of [1, 2]) {
      const frame = h.latest();
      expect(frame.view.deadline).toBe(frame.serverNow + seconds * 1000);
      expect(h.timer().delay).toBe(seconds * 1000);
      h.clock.time = at(frame.view.deadline) - 1;
      h.timer().fire();
      expect(h.latest()).toBe(frame);
      expect(h.timer().delay).toBe(1);
      h.clock.time++;
      h.timer().fire();
      expect(h.calls.automatic).toBe(count);
    }
  },
);

test("settings reach every phase, including the resumed OUT spectator", () => {
  const h = harness();
  const settings = { turnLimitSeconds: 45, maxRounds: 3 } as const;
  h.start(4, settings);
  finish(h);
  expect(h.latest("D").view.slots[3]?.isOut).toBe(true);
  h.resume("spectator", "D");
  finish(h);
  finish(h);
  for (const name of ["A", "B", "C", "D", "spectator"]) {
    for (const frame of h.snaps(name))
      expect(frame.view).toMatchObject(settings);
  }
  for (const name of ["A", "B", "C"])
    expect(new Set(h.snaps(name).map((f) => f.view.phase))).toEqual(
      new Set([
        "LOBBY",
        "ROUND_START",
        "TURN_ACTIVE",
        "ROUND_SETTLEMENT",
        "GAME_OVER",
      ]),
    );
  expect(h.latest("spectator").view).toMatchObject({
    phase: "GAME_OVER",
    round: 3,
  });
});

test("abandonment keeps the room settings for the lobby and next start", () => {
  const h = harness(undefined, 53);
  const start = spyOn(h.rules, "startRound");
  const settings = { turnLimitSeconds: 90, maxRounds: 10 } as const;
  h.start(4, settings);
  h.request("D", { type: "LEAVE_ROOM" });
  for (const name of ["A", "B", "C"])
    expect(h.latest(name).view).toMatchObject({
      ...settings,
      phase: "LOBBY",
      lastGameResult: { reason: "ABANDONMENT" },
    });
  h.clock.time++;
  h.request("A", { type: "START_GAME" });
  expect(start.mock.calls.map((args) => args[2])).toEqual([10, 10]);
  for (const name of ["A", "B", "C"]) {
    const frame = h.latest(name);
    expect(frame.view).toMatchObject({
      ...settings,
      phase: "TURN_ACTIVE",
      deadline: frame.serverNow + 90000,
    });
  }
  expect(h.timer().delay).toBe(90000);
});
