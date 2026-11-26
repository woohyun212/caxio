import { expect, test } from "bun:test";
import {
  epoch,
  phaseAndResumeErrors,
  roomCode,
} from "@caxio/shared/contracts/fixtures";
import { ROOM_DISPOSAL_MS, SEAT_RESERVATION_MS } from "../contracts";
import {
  dealExamples,
  lostResume,
  seatedRejections,
  seatReuse,
} from "../fixtures/server-snapshots";
import { at } from "./rules.fixture";
import { harness } from "./service.fixture";

test("bound CREATE, JOIN and RESUME preserve the seat and revision", () => {
  const h = harness();
  h.clock.time = epoch + 3;
  h.lobby();
  for (const f of seatedRejections) {
    expect(h.latest()).toEqual(f.before);
    h.reject("A", f.command, f.response.code);
    expect(h.latest()).toEqual(f.after);
  }
  h.reject("A", lostResume.command, "INVALID_PHASE");
  expect(h.codes).toEqual(["WXYZ89"]);
  h.resume("retry", "A");
  expect(h.latest("retry")).toEqual(at(seatedRejections[0]).after);
});
test("code collision retries without disturbing the live room", () => {
  const h = harness();
  h.codes.splice(1, 0, roomCode, "bad");
  h.create();
  const before = h.messages("A");
  h.request("new", { type: "CREATE_ROOM" });
  expect(h.messages("new")[0]).toMatchObject({
    type: "SEATED",
    roomCode: "WXYZ89",
    seatId: 0,
  });
  expect(h.latest("new").revision).toBe(1);
  expect(h.messages("A")).toEqual(before);
  h.join("guest");
  expect(h.latest().view.seatOrder).toEqual([0, 1]);
});
test("room rejections reach only the requester in binding, phase and host order", () => {
  const h = harness();
  h.reject(
    "A",
    phaseAndResumeErrors[4].command,
    phaseAndResumeErrors[4].reply.code,
  );
  h.reject("B", { type: "JOIN_ROOM", roomCode }, "ROOM_NOT_FOUND");
  for (const command of [
    { type: "START_GAME" },
    { type: "PASS", turnId: 12 },
    { type: "PLAY", turnId: 1, tiles: [] },
  ])
    h.reject("B", command, "NOT_SEATED");
  h.create();
  h.reject("A", { type: "START_GAME" }, "NOT_READY");
  h.reject("A", { type: "PASS", turnId: 12 }, "INVALID_PHASE");
  h.join("B");
  h.reject("B", { type: "START_GAME" }, "NOT_HOST");
  h.join("C");
  h.join("D");
  h.join("E");
  h.close("B");
  h.reject("outsider", { type: "JOIN_ROOM", roomCode }, "ROOM_FULL");
  h.reject("A", { type: "START_GAME" }, "NOT_READY");
  h.reject(
    "outsider",
    { type: "RESUME", roomCode, token: "revoked" },
    "RESUME_DENIED",
  );
  expect(h.calls.deals).toBe(0);
});
test("W1 seat reuse, host succession, revoked tokens and lost delivery retry", () => {
  const h = harness();
  const f = seatReuse;
  for (const [i, name] of ["A", "B", "C", "D"].entries()) {
    const frame = at(f.joins[i]);
    h.clock.time = frame.serverNow;
    if (i === 0) h.create();
    else h.join(name);
    expect(h.latest()).toEqual(frame);
  }
  h.clock.time = f.bDisconnected.serverNow;
  h.close("B");
  const oldB = h.timer();
  expect(h.latest()).toEqual(f.bDisconnected);
  h.reject("A", f.reservedStart.request, f.reservedStart.reply.code);
  expect(h.calls.deals).toBe(0);
  h.clock.time = f.bReturned.serverNow;
  oldB.fire();
  expect(h.latest()).toEqual(f.bReturned);
  h.clock.time = f.eJoined.serverNow;
  h.join("E");
  expect(h.latest()).toEqual(f.eJoined);
  const before = h.log.length;
  oldB.fire();
  expect(h.log.length).toBe(before);
  h.clock.time = f.aDisconnected.serverNow;
  h.close("A");
  expect(h.latest("C")).toEqual(f.aDisconnected);
  h.clock.time = f.aReturned.serverNow;
  h.timer().fire();
  expect(h.latest("C")).toEqual(f.aReturned);
  for (const { command, reply } of f.revoked)
    h.reject("outsider", command, reply.code);
  for (const [name, seated] of Object.entries(f.credentials))
    expect(h.messages(name)[0]).toEqual(seated);
  h.clock.time = epoch + 60013;
  for (const attempt of f.startAttempts) {
    if ("reply" in attempt)
      h.reject(attempt.from, f.startCommand, attempt.reply.code);
    else h.request(attempt.from, f.startCommand);
    expect(h.calls.deals).toBe(attempt.deals);
  }
  for (const { recipient, frame } of f.started) {
    const name = recipient === 2 ? "C" : recipient === 3 ? "D" : "E";
    expect(h.snaps(name).at(-2)).toEqual(frame);
  }
  h.clock.time++;
  h.close("C");
  h.clock.time++;
  h.request("lost", lostResume.command);
  expect(h.messages("lost")[0]).toEqual(lostResume.lost);
  h.clock.time++;
  h.request("retry", lostResume.retry);
  expect(h.messages("retry")).toEqual([
    lostResume.received,
    lostResume.snapshot,
  ]);
  h.reject("lost", lostResume.replaced.command, "NOT_SEATED");
  h.reject("lost", lostResume.retry, "NOT_SEATED");
  const count = h.log.length;
  h.close("lost");
  expect(h.log.length).toBe(count);
  expect(h.calls.manual).toBe(lostResume.replaced.accepted);
  h.reject(
    "outsider",
    lostResume.returned.command,
    lostResume.returned.reply.code,
  );
});
test("reservation can resume one millisecond before expiry and ignores previous generation", () => {
  const h = harness();
  h.lobby();
  h.close("A");
  const old = h.timer();
  expect(old.delay).toBe(SEAT_RESERVATION_MS);
  h.clock.time += old.delay - 1;
  h.resume("retry", "A");
  expect(h.messages("retry")[0]).toEqual(seatReuse.credentials.A);
  expect(h.latest("retry").view).toMatchObject({
    hostSeatId: 0,
    canStart: true,
  });
  expect(old.cancelled).toBe(true);
  h.close("retry");
  const next = h.timer();
  h.clock.time++;
  const count = h.log.length;
  old.fire();
  expect(h.log.length).toBe(count);
  h.clock.time += SEAT_RESERVATION_MS - 1;
  next.fire();
  expect(h.latest("B").view).toMatchObject({
    hostSeatId: 1,
    seatOrder: [1, 2],
  });
  h.reject(
    "x",
    { type: "RESUME", roomCode, token: "fixture-A" },
    "RESUME_DENIED",
  );
});
test("empty lobby can elect a new host and cancels grace on join", () => {
  const h = harness();
  h.create();
  h.close("A");
  const [reserve, dispose] = h.timers;
  h.clock.time += SEAT_RESERVATION_MS;
  at(reserve).fire();
  h.join("B");
  expect(h.latest("B").view).toMatchObject({ hostSeatId: 0, seatOrder: [0] });
  expect(at(dispose).cancelled).toBe(true);
  h.clock.time += ROOM_DISPOSAL_MS;
  const count = h.log.length;
  at(dispose).fire();
  at(reserve).fire();
  expect(h.log.length).toBe(count);
  h.join("C");
  expect(h.latest("B").view.seatOrder).toEqual([0, 1]);
});
test("empty room expiry boundary and stale callbacks after code reuse", () => {
  const h = harness();
  h.create();
  h.close("A");
  const [reserve, dispose] = h.timers;
  h.clock.time += ROOM_DISPOSAL_MS - 1;
  at(reserve).fire();
  at(dispose).fire();
  h.reject(
    "x",
    { type: "RESUME", roomCode, token: "fixture-A" },
    "RESUME_DENIED",
  );
  expect(h.timer().delay).toBe(1);
  h.clock.time++;
  h.timer().fire();
  h.reject(
    "x",
    { type: "RESUME", roomCode, token: "fixture-A" },
    "ROOM_NOT_FOUND",
  );
  h.codes.unshift(roomCode);
  h.request("new", { type: "CREATE_ROOM" });
  const count = h.log.length;
  at(dispose).fire();
  at(reserve).fire();
  expect(h.log.length).toBe(count);
  h.join("B");
  expect(h.latest("new").view.seatOrder).toEqual([0, 1]);
});
test("reservation and disposal boundaries serialize at the scheduled callback", () => {
  const h = harness();
  h.create();
  h.close("A");
  const [reservation, empty] = h.timers;
  h.clock.time += ROOM_DISPOSAL_MS;
  h.resume("new", "A");
  expect(h.messages("new")[0]).toEqual(seatReuse.credentials.A);
  at(reservation).fire();
  at(empty).fire();
  h.join("B");
  expect(h.latest("new").view.seatOrder).toEqual([0, 1]);
});

test("five connected occupants start with their own twelve tiles", () => {
  const h = harness();
  h.start(5);
  expect(h.calls.deals).toBe(1);
  expect(h.snaps("A").at(-2)).toEqual({
    ...at(dealExamples[2]),
    revision: 6,
    serverNow: epoch,
  });
  for (const name of ["A", "B", "C", "D", "E"])
    expect(h.latest(name).revision).toBe(7);
});
