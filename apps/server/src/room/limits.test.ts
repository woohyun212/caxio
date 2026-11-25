import { expect, test } from "bun:test";
import { roomCode } from "@caxio/shared/contracts/fixtures";
import { ROOM_DISPOSAL_MS, SEAT_RESERVATION_MS } from "../contracts";
import { at } from "./rules.fixture";
import { harness } from "./service.fixture";

const create = { type: "CREATE_ROOM" };
const join = { type: "JOIN_ROOM", roomCode };
const missing = { type: "JOIN_ROOM", roomCode: "ZZZZ99" };

test("the 1000th room succeeds and disposal releases capacity", () => {
  const h = harness();
  h.codes.length = 0;
  h.tokens.length = 0;
  for (let i = 0; i < 1000; i++) {
    const code = Array.from(
      i.toString(8).padStart(6, "0"),
      (digit) => Number(digit) + 2,
    ).join("");
    h.codes.push(code);
    h.tokens.push(`fixture-${i}`);
    h.request(`owner-${i}`, create);
  }
  expect(h.messages("owner-999")[0]).toMatchObject({
    type: "SEATED",
    token: "fixture-999",
  });
  expect(h.latest("owner-999").revision).toBe(1);
  h.codes.push("WXYZ89");
  h.tokens.push("fixture-next");
  h.reject("owner-999", create, "INVALID_PHASE");
  h.reject("next", create, "ROOM_FULL");
  expect(h.codes).toEqual(["WXYZ89"]);
  expect(h.tokens).toEqual(["fixture-next"]);

  h.close("owner-0");
  const [reservation, disposal] = h.timers;
  h.clock.time += SEAT_RESERVATION_MS;
  at(reservation).fire();
  h.reject("next", create, "ROOM_FULL");
  h.clock.time += ROOM_DISPOSAL_MS - SEAT_RESERVATION_MS;
  at(disposal).fire();
  h.request("next", create);
  expect(h.messages("next").at(-2)).toEqual({
    type: "SEATED",
    roomCode: "WXYZ89",
    seatId: 0,
    token: "fixture-next",
  });
  expect(h.latest("next").revision).toBe(1);
  const previous = at(h.messages("owner-999")[0]);
  if (previous.type !== "SEATED")
    throw new Error("Expected live room credential");
  h.request("other", {
    type: "RESUME",
    roomCode: previous.roomCode,
    token: previous.token,
  });
  expect(h.latest("other")).toEqual({
    ...h.latest("owner-999"),
    serverNow: h.clock.time,
  });
});

test("four lookup misses and unrelated errors still allow a correct join", () => {
  const h = harness();
  h.create();
  for (let i = 0; i < 4; i++) h.reject("guest", missing, "ROOM_NOT_FOUND");
  h.reject("guest", "{", "INVALID_MESSAGE");
  h.reject("guest", { type: "START_GAME" }, "NOT_SEATED");
  h.join("guest");
  expect(h.messages("guest").at(-2)).toMatchObject({
    type: "SEATED",
    seatId: 1,
    roomCode,
  });
  expect(h.latest().revision).toBe(2);
});

test("five mixed lookup misses block join and resume only on that socket", () => {
  const h = harness();
  h.create();
  for (let i = 0; i < 3; i++) h.reject("guest", missing, "ROOM_NOT_FOUND");
  const resume = { type: "RESUME", roomCode, token: "fixture-A" };
  for (let i = 0; i < 2; i++)
    h.reject("guest", { ...resume, token: "wrong" }, "RESUME_DENIED");
  h.reject("guest", join, "INVALID_PHASE");
  h.reject("guest", resume, "INVALID_PHASE");
  h.reject("guest", { ...resume, roomCode: missing.roomCode }, "INVALID_PHASE");
  h.reject("guest", { type: "START_GAME" }, "NOT_SEATED");
  expect(h.messages("A")).toHaveLength(2);
  h.join("fresh");
  expect(h.latest().revision).toBe(2);
  expect(h.latest().view.seatOrder).toEqual([0, 1]);
  h.request("guest", create);
  expect(h.latest("guest").revision).toBe(1);
});

test("a sixth unknown join and the subsequent correct join receive INVALID_PHASE", () => {
  const h = harness();
  h.create();
  for (let i = 0; i < 5; i++) h.reject("guest", missing, "ROOM_NOT_FOUND");
  h.reject("guest", missing, "INVALID_PHASE");
  h.reject("guest", join, "INVALID_PHASE");
  expect(h.latest().revision).toBe(1);
});
