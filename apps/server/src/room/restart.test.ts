import { expect, test } from "bun:test";
import { rules } from "@caxio/shared";
import { abandonmentRestart as replay } from "@caxio/shared/contracts/fixtures";
import type { Message, Snapshot } from "@caxio/shared/contracts/wire";
import { abandonmentShuffle } from "../fixtures/abandonment-shuffle";
import { at } from "./rules.fixture";
import { harness } from "./service.fixture";

test("A17 A20 A21 A22 room emits the frozen abandonment and restart replay exactly", () => {
  const h = harness(5, undefined, abandonmentShuffle());
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
  const observed: readonly Message[] = replay.observed;
  const snapshots = observed.filter(
    (m): m is Snapshot => m.type === "SNAPSHOT",
  );
  const { revoked, joined, rejectedStart, acceptedStart, stale } =
    replay.exchanges;
  for (const frame of snapshots.slice(1)) {
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
