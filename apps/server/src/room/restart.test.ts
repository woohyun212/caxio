import { expect, mock, spyOn, test } from "bun:test";
import { rules } from "@caxio/shared";
import { abandonmentResults, roomCode } from "@caxio/shared/contracts/fixtures";
import type { Message, Snapshot } from "@caxio/shared/contracts/wire";
import { ROOM_DISPOSAL_MS } from "../contracts";
import { abandonmentShuffle } from "../fixtures/abandonment-shuffle";
import {
  abandonmentLobbyExamples,
  abandonmentLobbyResume,
  abandonmentRestart as replay,
} from "../fixtures/server-snapshots";
import { at } from "./rules.fixture";
import { harness } from "./service.fixture";

const observed: readonly Message[] = replay.observed;
function replayThrough(lastRevision: number) {
  const random = mock(abandonmentShuffle());
  const h = harness(5, undefined, random);
  const record = (s: NonNullable<typeof h.calls.state>) => (h.calls.state = s);
  Object.assign(h.rules, rules);
  h.rules.startRound = (...args) => record(rules.startRound(...args));
  h.rules.advance = (...args) => record(rules.advance(...args));
  h.rules.applyTurn = (...args) => {
    const result = rules.applyTurn(...args);
    if (result.ok) record(result.state);
    return result;
  };
  const names = ["A", "B", "C", "D"];
  h.tokens[4] = replay.exchanges.joined.replies[0].token;
  h.start(4);
  for (const { frame, recipient } of replay.firstActive)
    expect(h.latest(at(names[recipient]))).toEqual(frame);
  expect(h.messages("A")[0]).toEqual(replay.oldHost);
  expect(h.messages("B")[0]).toEqual(replay.observer);
  const start = h.messages("B").length - 1;
  const snapshots = observed.filter(
    (m): m is Snapshot => m.type === "SNAPSHOT",
  );
  const { revoked, joined, rejectedStart, acceptedStart, stale } =
    replay.exchanges;
  for (const frame of snapshots.slice(1)) {
    if (frame.revision > lastRevision) break;
    h.clock.time = frame.serverNow;
    if (frame.revision === 7) h.close("A");
    else if (frame.revision === 19) {
      h.timer().fire();
      for (const { frame, recipient } of replay.abandoned)
        expect(h.latest(at(names[recipient]))).toEqual(frame);
      h.request("revoked", revoked.command);
      expect(h.messages("revoked")).toEqual([...revoked.replies]);
    } else if (frame.revision === 20) {
      names[0] = "replacement";
      h.request("replacement", joined.command);
      expect(h.messages("replacement")).toEqual([...joined.replies]);
      h.request("replacement", rejectedStart.command);
      expect(h.messages("replacement").slice(2)).toEqual([
        ...rejectedStart.replies,
      ]);
      expect(h.latest("replacement")).toEqual(rejectedStart.after);
    } else if (frame.revision === 21) {
      const index = h.messages("B").length;
      h.request("B", acceptedStart.command);
      expect(h.messages("B").slice(index)).toEqual([...acceptedStart.replies]);
      for (const { frame, recipient } of replay.restartDeal)
        expect(h.snaps(at(names[recipient])).at(-2)).toEqual(frame);
      for (const exchange of stale) {
        h.request("B", exchange.command);
        expect(h.messages("B").at(-1)).toEqual(exchange.reply);
      }
    } else if (frame.view.lastAction) {
      const action = frame.view.lastAction;
      if (action.automatic) h.timer().fire();
      else
        h.request(
          at(names[action.seatId]),
          action.type === "PASS"
            ? { type: "PASS", turnId: action.turnId }
            : {
                type: "PLAY",
                turnId: action.turnId,
                tiles: at(frame.view.lastPlay).tiles,
              },
        );
    }
  }
  return { h, start, random };
}

test("A17 A20 A21 A22 room emits the frozen abandonment and restart replay exactly", () => {
  const { h, start } = replayThrough(31);
  expect(h.messages("B").slice(start, start + observed.length)).toEqual([
    ...observed,
  ]);
  // The frozen observation ends at the restart's first settlement; normal play continues.
  expect(
    h
      .messages("B")
      .slice(start + observed.length)
      .map((m) => m.type === "SNAPSHOT" && m.view.phase),
  ).toEqual(["ROUND_START", "TURN_ACTIVE"]);
});

test("A20 connected lobby survives five idle minutes and appends two joins in order", () => {
  const { h } = replayThrough(18);
  const scheduled = h.timers.length;
  h.clock.time = at(h.latest("B").view.deadline);
  h.timer().fire();
  const lobby = h.latest("B");
  expect(lobby.view).toEqual(abandonmentLobbyExamples[0].frame.view);
  expect(h.timers.slice(scheduled).map((t) => t.delay)).not.toContain(
    ROOM_DISPOSAL_MS,
  );

  h.clock.time += ROOM_DISPOSAL_MS;
  for (const timer of h.timers) timer.fire();
  expect(h.latest("B")).toEqual(lobby);

  const tokens = new Set(
    ["A", "B", "C", "D"].map((name) => {
      const m = at(h.messages(name)[0]);
      if (m.type !== "SEATED") throw Error("Missing original credential");
      return m.token;
    }),
  );
  for (const [name, example] of [
    ["E", abandonmentLobbyExamples[3]],
    ["F", abandonmentLobbyExamples[4]],
  ] as const) {
    h.join(name);
    const seated = h.messages(name)[0];
    if (seated?.type !== "SEATED") throw Error("Expected successful join");
    expect(seated).toMatchObject({ roomCode, seatId: example.recipient });
    expect(tokens.has(seated.token)).toBe(false);
    tokens.add(seated.token);
    expect(h.latest(name).view).toEqual(example.frame.view);
  }
  for (const name of ["B", "C", "D"]) {
    const restored = `${name}2`;
    h.resume(restored, name);
    expect(h.messages(restored)[0]).toEqual(at(h.messages(name)[0]));
    expect(h.latest(restored).view).toMatchObject({
      seatOrder: [1, 2, 3, 0, 4],
      lastGameResult: abandonmentResults.afterRoundOne.result,
    });
  }
});

test("A21 result survives lobby disconnect, host NOT_READY and authenticated return before restart", () => {
  const { h, random } = replayThrough(19);
  const before = h.latest("B");
  const index = h.log.length;
  h.close("C");
  const offline = abandonmentLobbyExamples[1].frame.view;
  expect(h.log.slice(index)).toEqual(
    ["B", "D"].map((name) => ({
      name,
      message: { ...before, revision: before.revision + 1, view: offline },
    })),
  );

  const startRound = spyOn(h.rules, "startRound");
  const draws = random.mock.calls.length;
  h.reject("B", { type: "START_GAME" }, "NOT_READY");
  expect(startRound).not.toHaveBeenCalled();
  expect(random.mock.calls).toHaveLength(draws);
  for (const name of ["B", "D"]) {
    const restored = `${name}2`;
    h.resume(restored, name);
    expect(h.latest(restored)).toEqual({
      ...before,
      revision: before.revision + 1,
      view: offline,
    });
  }
  const resume = abandonmentLobbyResume;
  h.request("C2", resume.command);
  expect(h.messages("C2")).toEqual([
    resume.replies[0],
    { ...before, revision: before.revision + 2, view: resume.replies[1].view },
  ]);
  h.request("B2", { type: "START_GAME" });
  expect(startRound).toHaveBeenCalledTimes(1);
  for (const name of ["B2", "C2", "D2"])
    expect(h.latest(name).view).toMatchObject({
      phase: "TURN_ACTIVE",
      round: 1,
      seatOrder: [1, 2, 3],
    });
});
