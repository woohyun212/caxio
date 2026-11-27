import { expect, test } from "bun:test";
import type { SeatId } from "@caxio/shared/contracts/domain";
import {
  chatFrames,
  chatTextExamples,
  playerNameExamples,
  roomCode,
} from "@caxio/shared/contracts/fixtures";
import { at } from "./rules.fixture";
import { finish, harness } from "./service.fixture";

type Harness = ReturnType<typeof harness>;

function deliver(
  h: Harness,
  sender: string,
  seatId: SeatId,
  recipients: string[],
  text = "hi",
) {
  const before = h.log.length;
  h.request(sender, { type: "CHAT", text });
  const deliveries = h.log.slice(before);
  expect(deliveries.map((row) => row.name).sort()).toEqual(
    [...recipients].sort(),
  );
  for (const row of deliveries)
    expect(row.message).toEqual({ type: "CHAT", seatId, text });
}

function limited(h: Harness, sender: string) {
  const before = h.log.length;
  h.request(sender, chatFrames.request);
  expect(h.log.slice(before)).toEqual([
    { name: sender, message: chatFrames.rateLimited },
  ]);
}

test("chat derives the sender from its binding and reaches only its room", () => {
  const h = harness();
  h.lobby(2);
  const otherRoom = at(h.codes[0]);
  h.request("C", { type: "CREATE_ROOM" });
  h.request("D", { type: "JOIN_ROOM", roomCode: otherRoom });
  deliver(h, "B", 1, ["A", "B"]);
  deliver(h, "C", 0, ["C", "D"]);
  for (const extra of [{ seatId: 0 }, { name: "A" }, { revision: 1 }])
    h.reject("B", { ...chatFrames.request, ...extra }, "INVALID_MESSAGE");
});

test("unbound, departed and replaced sockets cannot chat or spend lookup attempts on chat", () => {
  const h = harness();
  h.lobby(2);
  h.reject("guest", { type: "CHAT", text: "" }, "INVALID_MESSAGE");
  for (let i = 0; i < 8; i++)
    h.reject("guest", chatFrames.request, "NOT_SEATED");
  h.join("guest");
  deliver(h, "guest", 2, ["A", "B", "guest"]);
  h.request("guest", { type: "LEAVE_ROOM" });
  h.reject("guest", chatFrames.request, "NOT_SEATED");
  h.resume("B2", "B");
  h.reject("B", chatFrames.request, "NOT_SEATED");
  deliver(h, "B2", 1, ["A", "B2"]);
});

test("offline and late seats get no chat history on resume or join", () => {
  const h = harness();
  h.lobby(2);
  h.close("B");
  deliver(h, "A", 0, ["A"]);
  h.resume("B2", "B");
  h.join("C");
  expect(h.messages("B2").map((m) => m.type)).toEqual([
    "SEATED",
    "SNAPSHOT",
    "SNAPSHOT",
  ]);
  expect(h.messages("C").map((m) => m.type)).toEqual(["SEATED", "SNAPSHOT"]);
  deliver(h, "A", 0, ["A", "B2", "C"]);
});

test("chat preserves the lobby, active turn, OUT spectator and end screen", () => {
  const h = harness(2);
  h.lobby(4);
  let observer = "B";
  function check(phase: "LOBBY" | "TURN_ACTIVE" | "GAME_OVER", out: boolean) {
    const before = h.latest(observer);
    expect(before.view.phase).toBe(phase);
    expect(before.view.slots[3]?.isOut).toBe(out);
    const timers = h.timers.map((t) => ({ ...t }));
    const calls = structuredClone(h.calls);
    deliver(h, "D", 3, ["A", observer, "C", "D"]);
    expect(h.timers).toEqual(timers);
    expect(h.calls).toEqual(calls);
    observer += "2";
    h.resume(observer, "B");
    expect(h.latest(observer)).toEqual(before);
  }
  check("LOBBY", false);
  h.request("A", { type: "START_GAME" });
  check("TURN_ACTIVE", false);
  finish(h, ["A", observer, "C", "D"]);
  check("TURN_ACTIVE", true);
  finish(h, ["A", observer, "C", "D"]);
  check("GAME_OVER", true);
});

test("invalid chat uses no budget and valid chat is delivered verbatim", () => {
  const h = harness();
  h.lobby(2);
  for (const text of chatTextExamples.invalid)
    h.reject("B", { type: "CHAT", text }, "INVALID_MESSAGE");
  for (const [i, text] of chatTextExamples.valid.entries()) {
    if (i === 5) h.clock.time += 5000;
    deliver(h, "B", 1, ["A", "B"], text);
  }
});

test("chat limits each occupant by accepted sends in the rolling window", () => {
  const h = harness();
  h.lobby(2);
  deliver(h, "B", 1, ["A", "B"]);
  h.clock.time += 100;
  for (let i = 0; i < 4; i++) deliver(h, "B", 1, ["A", "B"]);
  limited(h, "B");
  deliver(h, "A", 0, ["A", "B"]);
  h.close("B");
  h.resume("B2", "B");
  h.clock.time += 4899;
  limited(h, "B2");
  h.clock.time++;
  deliver(h, "B2", 1, ["A", "B2"]);
  limited(h, "B2");
  h.request("B2", { type: "LEAVE_ROOM" });
  h.join("new");
  for (let i = 0; i < 5; i++) deliver(h, "new", 1, ["A", "new"]);
  limited(h, "new");
});

test("a backwards clock adjustment excludes future sends until the clock catches up", () => {
  const h = harness();
  h.lobby(2);
  for (let i = 0; i < 5; i++) deliver(h, "B", 1, ["A", "B"]);
  h.clock.time--;
  deliver(h, "B", 1, ["A", "B"]);
  h.clock.time++;
  limited(h, "B");
});

test("create and join store duplicate Unicode names verbatim for every seat", () => {
  for (const name of playerNameExamples.valid) {
    const h = harness();
    h.request("A", { type: "CREATE_ROOM", name });
    h.request("B", { type: "JOIN_ROOM", roomCode, name });
    for (const recipient of ["A", "B"])
      expect(
        h
          .latest(recipient)
          .view.slots.slice(0, 2)
          .map((s) => s?.name),
      ).toEqual([name, name]);
  }
});

test("forbidden names on create or join allocate no seat", () => {
  const h = harness();
  for (const name of playerNameExamples.invalid)
    h.reject("A", { type: "CREATE_ROOM", name }, "INVALID_MESSAGE");
  h.create();
  for (const name of playerNameExamples.invalid)
    h.reject("B", { type: "JOIN_ROOM", roomCode, name }, "INVALID_MESSAGE");
  h.join("B");
  expect(h.latest().view.seatOrder).toEqual([0, 1]);
  expect(at(h.latest().view.slots[1])).not.toHaveProperty("name");
  expect(h.latest().revision).toBe(2);
});
