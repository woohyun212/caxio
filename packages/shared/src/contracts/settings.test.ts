import { expect, test } from "bun:test";
import {
  configuredRoom,
  normalCommands,
  phaseExamples,
  spectatorExamples,
} from "./fixtures";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TURN_LIMIT_SECONDS,
  MAX_ROUNDS,
  TURN_LIMIT_SECONDS,
} from "./settings";
import { decodeCommand, decodeRequest, decodeServerMessage } from "./wire";

test("creation accepts either setting independently and preserves exact values", () => {
  expect(TURN_LIMIT_SECONDS).toEqual([15, 30, 45, 60, 90]);
  expect(MAX_ROUNDS).toEqual([3, 5, 7, 10]);
  expect([DEFAULT_TURN_LIMIT_SECONDS, DEFAULT_MAX_ROUNDS]).toEqual([30, 5]);
  for (const settings of [
    {},
    ...TURN_LIMIT_SECONDS.map((turnLimitSeconds) => ({ turnLimitSeconds })),
    ...MAX_ROUNDS.map((maxRounds) => ({ maxRounds })),
    { turnLimitSeconds: 90, maxRounds: 10 } as const,
  ]) {
    for (const naming of [{}, { name: "달" }]) {
      const command = { type: "CREATE_ROOM", ...settings, ...naming } as const;
      expect(decodeCommand(JSON.stringify(command))).toEqual(command);
      expect(decodeRequest(JSON.stringify(command))).toEqual(command);
    }
  }
  expect(decodeRequest(JSON.stringify(configuredRoom.create))).toEqual(
    configuredRoom.create,
  );
});

test("creation rejects invalid settings and other requests reject setting keys", () => {
  for (const field of ["turnLimitSeconds", "maxRounds"]) {
    for (const value of [
      0,
      20,
      31,
      100,
      "30",
      30.5,
      null,
      [],
      field === "maxRounds" ? 30 : 5,
    ]) {
      const frame = JSON.stringify({ type: "CREATE_ROOM", [field]: value });
      expect(decodeRequest(frame)).toBe("INVALID_MESSAGE");
      expect(decodeCommand(frame)).toBe("INVALID_MESSAGE");
    }
    for (const other of [
      ...normalCommands.filter((c) => c.type !== "CREATE_ROOM"),
      { type: "LEAVE_ROOM" },
    ]) {
      expect(
        decodeRequest(
          JSON.stringify({ ...other, [field]: field === "maxRounds" ? 3 : 45 }),
        ),
      ).toBe("INVALID_MESSAGE");
    }
  }
  expect(
    decodeRequest(JSON.stringify({ ...configuredRoom.create, other: 1 })),
  ).toBe("INVALID_MESSAGE");
});

test("room turn limit is public, optional for compatibility and validated in snapshots", () => {
  for (const frame of [
    configuredRoom.lobby,
    configuredRoom.active,
    configuredRoom.ended,
  ]) {
    expect(frame.view.maxRounds).toBe(3);
    expect(frame.view.turnLimitSeconds).toBe(45);
    expect(decodeServerMessage(JSON.stringify(frame), 0)).toEqual(frame);
    for (const value of [20, "45", null, 45.5, []]) {
      expect(
        decodeServerMessage(
          JSON.stringify({
            ...frame,
            view: { ...frame.view, turnLimitSeconds: value },
          }),
          0,
        ),
      ).toBe("INVALID_MESSAGE");
    }
  }
  for (const frame of phaseExamples) {
    expect(frame.view).not.toHaveProperty("turnLimitSeconds");
    expect(decodeServerMessage(JSON.stringify(frame), 0)).toEqual(frame);
  }
  const out = spectatorExamples.transition;
  const frame = {
    ...out,
    view: { ...out.view, turnLimitSeconds: 90 },
  } as const;
  expect(
    decodeServerMessage(JSON.stringify(frame), spectatorExamples.recipient),
  ).toEqual(frame);
});
