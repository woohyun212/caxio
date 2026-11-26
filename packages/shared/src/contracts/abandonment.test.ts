import { expect, test } from "bun:test";
import type { SeatId } from "./domain";
import {
  abandonmentLobbyExamples,
  abandonmentLobbyResume,
  abandonmentResults,
  invalidAbandonmentExamples,
  phaseExamples,
  abandonmentRestart as replay,
} from "./fixtures";
import {
  ABANDONMENT_NOTICE,
  type Command,
  decodeCommand,
  decodeServerMessage,
  LAST_GAME_RANKING_TITLE,
  LEAVER_SEAT_PREFIX,
  type Message,
  type Snapshot,
} from "./wire";

function accept(frame: Message, recipient: SeatId | null) {
  expect(decodeServerMessage(JSON.stringify(frame), recipient)).toEqual(frame);
}
function command(value: Command) {
  expect(decodeCommand(JSON.stringify(value))).toEqual(value);
}
test("visual spec quotes the three frozen abandonment labels", async () => {
  const spec = await Bun.file(
    new URL("../../../../docs/design/visual-spec.md", import.meta.url),
  ).text();
  for (const label of [
    ABANDONMENT_NOTICE,
    `${LEAVER_SEAT_PREFIX} N번`,
    LAST_GAME_RANKING_TITLE,
  ])
    expect(spec).toContain(`‘${label}’`);
});

test("finished seat order breaks display ties, chips decide competition ranks and the leaver alone comes last", () => {
  const legacy = phaseExamples[0];
  expect(legacy.view).not.toHaveProperty("lastGameResult");
  accept(legacy, 0);
  const out = abandonmentResults.previouslyOut;
  expect(out.seatOrder).toEqual([2, 0, 1, 3]);
  expect(
    out.result.ranking.find((row) => row.seatId === out.outSeatId)?.chips,
  ).toBe(0);
  expect(out.seatOrder.at(-1)).toBe(out.result.leaverSeatId);
  const expected = [
    [
      [1, 1, 64],
      [2, 1, 64],
      [0, 3, 64],
    ],
    [
      [2, 1, 60],
      [0, 1, 60],
      [1, 3, 0],
      [3, 4, 136],
    ],
    [
      [1, 1, 64],
      [2, 1, 64],
      [3, 1, 64],
      [0, 4, 64],
    ],
    [
      [1, 1, 103],
      [2, 2, 51],
      [3, 2, 51],
      [0, 4, 51],
    ],
  ];
  for (const [index, { result, seatOrder }] of Object.values(
    abandonmentResults,
  ).entries()) {
    const rows = result.ranking;
    expect(rows.map((r) => [r.seatId, r.rank, r.chips])).toEqual(
      expected[index] ?? [],
    );
    expect(new Set(rows.map((r) => r.seatId))).toEqual(new Set(seatOrder));
    expect(rows.at(-1)).toMatchObject({
      seatId: result.leaverSeatId,
      rank: rows.length,
    });
    const joinOrder: readonly SeatId[] = seatOrder;
    for (const [i, row] of rows.slice(0, -1).entries()) {
      const previous = rows[i - 1];
      if (previous?.chips === row.chips)
        expect(joinOrder.indexOf(previous.seatId)).toBeLessThan(
          joinOrder.indexOf(row.seatId),
        );
    }
    if (legacy.view.phase !== "LOBBY") throw Error("expected legacy lobby");
    accept({ ...legacy, view: { ...legacy.view, lastGameResult: result } }, 0);
  }
});

test("five historical seats and safe synthetic chip balances decode independently of current occupancy", () => {
  const { frame, recipient } = abandonmentLobbyExamples[0];
  if (frame.view.phase !== "LOBBY") throw Error("expected lobby");
  const result = {
    reason: "ABANDONMENT",
    leaverSeatId: 4,
    ranking: [
      { seatId: 2, rank: 1, chips: Number.MAX_SAFE_INTEGER },
      { seatId: 1, rank: 1, chips: Number.MAX_SAFE_INTEGER },
      { seatId: 0, rank: 3, chips: 7 },
      { seatId: 3, rank: 4, chips: 0 },
      { seatId: 4, rank: 5, chips: 900 },
    ],
  } as const;
  accept(
    { ...frame, view: { ...frame.view, lastGameResult: result } },
    recipient,
  );
});

test("lobby presence, expiry, host succession, slot reuse and resume preserve the past result", () => {
  const expected = [
    [[1, 2, 3], true],
    [[1, 2, 3], false],
    [[1, 3], false],
    [[1, 2, 3, 0], false],
    [[1, 2, 3, 0, 4], false],
  ] as const;
  for (const [i, { frame, recipient }] of abandonmentLobbyExamples.entries()) {
    accept(frame, recipient);
    expect(frame.view).toMatchObject({
      phase: "LOBBY",
      ranking: [],
      ownHand: [],
      lastSettlement: null,
      lastPlay: null,
      lastAction: null,
      turnId: null,
      deadline: null,
      hostSeatId: 1,
      lastGameResult: abandonmentResults.afterRoundOne.result,
    });
    if (frame.view.phase !== "LOBBY") throw Error("expected lobby");
    expect<readonly unknown[]>([
      frame.view.seatOrder,
      frame.view.canStart,
    ]).toEqual(expected[i] ?? []);
  }
  const [empty, offline, expired, reused, newSeat] = abandonmentLobbyExamples;
  expect(empty.frame.view.slots[0]).toBeNull();
  expect(offline.frame.view.slots[2]?.isConnected).toBe(false);
  expect(expired.frame.view.slots[2]).toBeNull();
  expect(reused.frame.view.slots[0]?.isConnected).toBe(true);
  expect(
    abandonmentResults.afterRoundOne.result.ranking.map((r) => r.seatId),
  ).not.toContain(newSeat.recipient);
  const resume = abandonmentLobbyResume;
  command(resume.command);
  const [seated, restored] = resume.replies;
  accept(seated, null);
  accept(restored, resume.recipient);
  expect(seated).toMatchObject({
    type: "SEATED",
    seatId: resume.recipient,
    token: resume.command.token,
    roomCode: resume.command.roomCode,
  });
  expect(resume.before).toEqual(offline);
  expect(restored.revision).toBe(offline.frame.revision + 1);
  expect(restored.view.slots[resume.recipient]?.isConnected).toBe(true);
  expect(restored.view).toMatchObject({
    lastGameResult: abandonmentResults.afterRoundOne.result,
  });
});

for (const { violation, frame, recipient } of invalidAbandonmentExamples) {
  test(`rejects ${violation}`, () => {
    expect(decodeServerMessage(JSON.stringify(frame), recipient)).toBe(
      "INVALID_MESSAGE",
    );
  });
}

const observed: readonly Message[] = replay.observed;
const snapshots = observed.filter((m): m is Snapshot => m.type === "SNAPSHOT");
function at(revision: number) {
  const frame = snapshots.find((f) => f.revision === revision);
  if (!frame) throw Error(`missing revision ${revision}`);
  return frame;
}

test("all four see the first active turn, then presence, two automatic passes and third expiry directly to lobby", () => {
  accept(replay.observer, null);
  accept(replay.oldHost, null);
  expect(replay.firstActive.map((f) => f.recipient)).toEqual([0, 1, 2, 3]);
  for (const { frame, recipient } of replay.firstActive) {
    accept(frame, recipient);
    expect({ ...frame, view: { ...frame.view, ownHand: [] } }).toEqual({
      ...at(6),
      view: { ...at(6).view, ownHand: [] },
    });
  }
  expect(at(6).view).toMatchObject({
    phase: "TURN_ACTIVE",
    turnId: 1,
    seatOrder: [0, 1, 2, 3],
  });
  expect(at(6).view.slots[0]?.isConnected).toBe(true);
  expect(at(7).view).toEqual({ ...at(6).view, slots: at(7).view.slots });
  const host = at(6).view.slots[0];
  if (!host) throw Error("missing host");
  expect(at(7).view.slots[0]).toEqual({
    ...host,
    isConnected: false,
  });
  const actions = snapshots.filter((f) => f.view.lastAction?.automatic);
  expect(actions.map((f) => f.view.lastAction)).toEqual(
    [4, 8].map((turnId) => ({
      type: "PASS",
      seatId: 0,
      automatic: true,
      turnId,
    })),
  );
  for (const f of actions) {
    const previous = at(f.revision - 1);
    expect(previous.view.currentTurn).toBe(0);
    expect(previous.view.turnId).toBe(f.view.lastAction?.turnId ?? -1);
    expect(previous.view.deadline).toBe(f.serverNow);
  }
  const third = at(18),
    lobby = at(19);
  expect(third.view).toMatchObject({
    phase: "TURN_ACTIVE",
    round: 2,
    currentTurn: 0,
    turnId: 10,
  });
  expect(third.view.deadline).toBe(lobby.serverNow);
  expect(snapshots[snapshots.indexOf(third) + 1]).toEqual(lobby);
  expect(snapshots[snapshots.indexOf(lobby) + 1]?.revision).toBe(20);
  expect(replay.abandoned.map((f) => f.recipient)).toEqual([1, 2, 3]);
  for (const { frame, recipient } of replay.abandoned) {
    accept(frame, recipient);
    expect(frame.revision).toBe(lobby.revision);
    expect(frame.view).toMatchObject({
      phase: "LOBBY",
      lastGameResult: abandonmentResults.afterRoundOne.result,
      hostSeatId: 1,
      canStart: recipient === 1,
    });
    expect(frame.view.slots[0]).toBeNull();
  }
  for (const row of abandonmentResults.afterRoundOne.result.ranking)
    expect(third.view.slots[row.seatId]?.chips).toBe(row.chips);
});

test("revoked resume, replacement join, start and stale commands use the same room and exact reply streams", () => {
  const { revoked, joined, rejectedStart, acceptedStart, stale } =
    replay.exchanges;
  for (const e of [revoked, joined, rejectedStart, acceptedStart]) {
    command(e.command);
    for (const frame of e.replies)
      accept(frame, frame.type === "SEATED" ? null : e.recipient);
  }
  expect<Command>(revoked.command).toEqual({
    type: "RESUME",
    roomCode: replay.oldHost.roomCode,
    token: replay.oldHost.token,
  });
  expect(revoked.replies).toEqual([{ type: "ERROR", code: "RESUME_DENIED" }]);
  const [newSeat, newLobby] = joined.replies;
  expect<Command>(joined.command).toEqual({
    type: "JOIN_ROOM",
    roomCode: replay.oldHost.roomCode,
  });
  expect(newSeat).toMatchObject({
    type: "SEATED",
    seatId: replay.oldHost.seatId,
    roomCode: replay.observer.roomCode,
  });
  expect(newSeat.token).not.toBe(replay.oldHost.token);
  expect([revoked.atRevision, joined.atRevision]).toEqual([19, 19]);
  expect(newLobby.revision).toBe(joined.atRevision + 1);
  expect(newLobby.view).toMatchObject({
    seatOrder: [1, 2, 3, 0],
    canStart: false,
    lastGameResult: abandonmentResults.afterRoundOne.result,
  });
  expect(rejectedStart.command).toEqual({ type: "START_GAME" });
  expect(rejectedStart.replies).toEqual([{ type: "ERROR", code: "NOT_HOST" }]);
  accept(rejectedStart.after, rejectedStart.recipient);
  expect(rejectedStart.after).toEqual(newLobby);
  if (newLobby.view.phase !== "LOBBY")
    throw Error("expected replacement lobby");
  expect(at(20).view).toEqual({ ...newLobby.view, canStart: true });
  expect(acceptedStart.command).toEqual({ type: "START_GAME" });
  expect([rejectedStart.atRevision, acceptedStart.atRevision]).toEqual([
    20, 20,
  ]);
  expect(acceptedStart.replies).toEqual([at(21), at(22)]);
  const allTiles = [];
  expect(replay.restartDeal.map((f) => f.recipient)).toEqual([0, 1, 2, 3]);
  for (const { recipient, frame } of replay.restartDeal) {
    accept(frame, recipient);
    expect(frame.view).toMatchObject({
      phase: "ROUND_START",
      round: 1,
      seatOrder: [1, 2, 3, 0],
      activePlayers: [1, 2, 3, 0],
      lastSettlement: null,
    });
    expect(frame.view).not.toHaveProperty("lastGameResult");
    expect(frame.revision).toBe(21);
    expect(frame.view.slots.slice(0, 4)).toEqual(
      Array(4).fill({
        isOut: false,
        isConnected: true,
        chips: 64,
        remainingTileCount: 13,
      }),
    );
    expect(frame.view.ownHand).toHaveLength(13);
    allTiles.push(...(frame.view.ownHand ?? []).map((t) => JSON.stringify(t)));
  }
  expect(new Set(allTiles).size).toBe(52);
  const oldIds = snapshots
    .filter((f) => f.revision < 19)
    .map((f) => f.view.turnId ?? 0);
  expect(at(22).view.phase).toBe("TURN_ACTIVE");
  expect(at(22).view.turnId).toBeGreaterThan(Math.max(...oldIds));
  expect(stale.map((e) => e.command.type)).toEqual(["PLAY", "PASS"]);
  for (const e of stale) {
    command(e.command);
    accept(e.reply, e.recipient);
    expect(e.atRevision).toBe(22);
    expect(oldIds).toContain(e.command.turnId);
    expect(e.reply).toEqual({ type: "ERROR", code: "STALE_TURN" });
  }
  expect(
    observed.slice(observed.indexOf(at(22)) + 1, observed.indexOf(at(23))),
  ).toEqual(stale.map((e) => e.reply));
});

test("observer sees consecutive revisions and one play/settlement batch per actual winning play, even across restart", () => {
  const expectedRevisions = Array.from({ length: 26 }, (_, i) => i + 6);
  expect(snapshots.map((f) => f.revision)).toEqual(expectedRevisions);
  expect(observed).toHaveLength(28);
  expect(replay.effectBatches).toHaveLength(observed.length);
  let previous: Snapshot | undefined;
  for (const [i, f] of observed.entries()) {
    accept(f, replay.recipient);
    const expected = [];
    if (f.type === "SNAPSHOT") {
      const play = f.view.lastPlay;
      if (previous && play && play.turnId !== previous.view.lastPlay?.turnId)
        expected.push({ type: "PLAY", turnId: play.turnId });
      if (f.view.phase === "ROUND_SETTLEMENT")
        expected.push({ type: "SETTLEMENT", round: f.view.round });
      previous = f;
    }
    expect<readonly unknown[] | undefined>(replay.effectBatches[i]).toEqual(
      expected,
    );
  }
  expect(
    snapshots
      .filter((f) => f.view.phase === "ROUND_SETTLEMENT")
      .map((f) => [f.revision, f.view.round]),
  ).toEqual([
    [16, 1],
    [31, 1],
  ]);
});
