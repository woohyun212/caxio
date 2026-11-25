import { expect, test } from "bun:test";
import type { SeatId } from "./domain";
import {
  a4Settlement,
  deadlines,
  effectBatches,
  epoch,
  lastPlaySequence,
  lostResume,
  newRoomSequence,
  seatedRejections,
  seatReuse,
  spectatorExamples,
  turnValidationOrder,
} from "./fixtures";
import type { Message } from "./wire";
import { decodeCommand, decodeServerMessage } from "./wire";

function frame(f: Message, seat: SeatId | null) {
  expect(decodeServerMessage(JSON.stringify(f), seat)).toEqual(f);
}
function request(c: unknown) {
  expect(c).toEqual(decodeCommand(JSON.stringify(c)));
}
test("seated CREATE and JOIN preserve state and revision", () => {
  expect(seatedRejections.map((e) => e.command.type)).toEqual([
    "CREATE_ROOM",
    "JOIN_ROOM",
  ]);
  for (const e of seatedRejections) {
    request(e.command);
    frame(e.before, 0);
    frame(e.after, 0);
    frame(e.response, 0);
    expect(e.response.code).toBe("INVALID_PHASE");
    expect(e.after).toEqual(e.before);
  }
});
test("new SEATED replaces the single credential after GAME_OVER", () => {
  const s = newRoomSequence;
  frame(s.finished, 0);
  frame(s.previous, 0);
  request(s.command);
  frame(s.response, null);
  frame(s.lobby, 0);
  request(s.resume);
  expect(s.finished.view.phase).toBe("GAME_OVER");
  expect(s.connection).toBe("new");
  expect(s.command.type).toBe("CREATE_ROOM");
  expect(s.lobby.view.phase).toBe("LOBBY");
  expect(s.previous.roomCode).not.toBe(s.response.roomCode);
  expect(s.previous.token).not.toBe(s.response.token);
  expect(s.lobby.view).not.toHaveProperty("roomCode");
  expect({ roomCode: s.previous.roomCode, token: s.previous.token }).toEqual(
    s.storedBefore,
  );
  expect(s.storedAfter).toEqual({
    roomCode: s.response.roomCode,
    token: s.response.token,
  });
  expect(s.storedAfterDenial).toBeNull();
  expect(s.resume).toEqual({
    type: "RESUME",
    roomCode: s.response.roomCode,
    token: s.response.token,
  });
  expect(s.clearOn.map((e) => e.code)).toEqual([
    "RESUME_DENIED",
    "ROOM_NOT_FOUND",
  ]);
  for (const e of s.clearOn) frame(e, 0);
});
test("returned seats keep join order, host authority and private hands", () => {
  const s = seatReuse;
  expect(Object.values(s.credentials).map((c) => c.seatId)).toEqual([
    0, 1, 2, 3, 1,
  ]);
  for (const c of Object.values(s.credentials)) frame(c, c.seatId);
  expect(new Set(Object.values(s.credentials).map((c) => c.token)).size).toBe(
    5,
  );
  for (const f of [...s.joins, s.bDisconnected, s.bReturned, s.eJoined])
    frame(f, 0);
  for (const f of [s.aDisconnected, s.aReturned]) frame(f, 2);
  expect(s.joins.map((f) => f.view.seatOrder)).toEqual([
    [0],
    [0, 1],
    [0, 1, 2],
    [0, 1, 2, 3],
  ]);
  expect(s.bDisconnected.view.slots[1]?.isConnected).toBe(false);
  request(s.reservedStart.request);
  frame(s.reservedStart.reply, 0);
  expect(s.reservedStart).toMatchObject({
    from: "A",
    deals: 0,
    reply: { code: "NOT_READY" },
  });
  expect(s.bReturned.serverNow - s.bDisconnected.serverNow).toBe(30000);
  expect(s.bReturned.view.slots[1]).toBeNull();
  expect(s.eJoined.view.seatOrder).toEqual([0, 2, 3, 1]);
  expect(s.aReturned.serverNow - s.aDisconnected.serverNow).toBe(30000);
  expect(s.aReturned.view).toMatchObject({
    hostSeatId: 2,
    seatOrder: [2, 3, 1],
    canStart: true,
  });
  expect(s.startAttempts).toEqual([
    { from: "D", reply: { type: "ERROR", code: "NOT_HOST" }, deals: 0 },
    { from: "E", reply: { type: "ERROR", code: "NOT_HOST" }, deals: 0 },
    { from: "C", deals: 1 },
  ]);
  request(s.startCommand);
  for (const a of s.startAttempts)
    if ("reply" in a) frame(a.reply, s.credentials[a.from].seatId);
  expect(s.started.map((e) => e.recipient)).toEqual([
    s.credentials.C.seatId,
    s.credentials.D.seatId,
    s.credentials.E.seatId,
  ]);
  const dealt = s.hands.flatMap((h) => h ?? []);
  expect(dealt.length).toBe(36);
  expect(new Set(dealt.map((t) => JSON.stringify(t))).size).toBe(36);
  for (const e of s.started) {
    frame(e.frame, e.recipient);
    expect(e.frame.view.ownHand).toEqual(s.hands[e.recipient]);
    expect(e.frame.view.ownHand).toHaveLength(12);
    expect(e.frame.view.currentTurn).toBe(2);
  }
  expect(s.hands[2]).toContainEqual({ number: 3, suit: 0 });
  expect(s.revoked.map((e) => e.command.token)).toEqual([
    s.credentials.A.token,
    s.credentials.B.token,
  ]);
  for (const e of s.revoked) {
    request(e.command);
    frame(e.reply, null);
    expect(e.reply.code).toBe("RESUME_DENIED");
  }
});
test("deadline minus one, equality, plus one and stale turn", () => {
  const d = deadlines;
  frame(d.before, 0);
  frame(d.presence, 0);
  expect(d.presence.revision).toBe(d.before.revision + 1);
  expect(d.presence.view.turnId).toBe(d.before.view.turnId);
  expect(d.presence.view.deadline).toBe(d.before.view.deadline);
  expect(d.before.view.deadline).toBe(epoch + 30000);
  expect(d.before.serverNow).toBeGreaterThanOrEqual(epoch);
  expect(
    d.cases.map((e) => [
      e.now - (d.before.view.deadline ?? 0),
      e.manual,
      e.automatic,
      e.reply?.code ?? null,
    ]),
  ).toEqual([
    [-1, 1, 0, null],
    [0, 0, 1, "TIME_EXPIRED"],
    [1, 0, 1, "TIME_EXPIRED"],
  ]);
  for (const e of d.cases) {
    request(e.command);
    frame(e.after, 0);
    expect(e.after.view.lastAction?.automatic).toBe(e.automatic === 1);
    expect(e.after.revision).toBe(d.before.revision + 1);
    if (e.reply) frame(e.reply, 0);
  }
  request(d.stale.command);
  frame(d.stale.before, 0);
  frame(d.stale.after, 0);
  frame(d.stale.reply, 0);
  expect(d.stale.reply.code).toBe("STALE_TURN");
  expect(d.stale.before.view.turnId).not.toBe(d.stale.command.turnId);
  expect(d.stale.after).toEqual(d.stale.before);
  expect(turnValidationOrder).toEqual([
    "STALE_TURN",
    "TIME_EXPIRED",
    "NOT_YOUR_TURN",
    "NOT_OWNED",
    "DUPLICATE_TILE",
    "ILLEGAL_HAND",
    "WRONG_COUNT",
    "NOT_HIGHER",
  ]);
});
test("lost RESUME response restores the same credential and hand", () => {
  const r = lostResume;
  request(r.command);
  request(r.retry);
  request(r.replaced.command);
  request(r.returned.command);
  for (const s of [r.credential, r.lost, r.received, r.snapshot])
    frame(s, r.recipient);
  expect(r.retry).toEqual(r.command);
  expect(r.command.token).toBe(r.credential.token);
  expect(r.received).toEqual(r.credential);
  expect(r.lost).toEqual(r.received);
  expect(r.snapshot.view.ownHand).toEqual(r.originalHand);
  expect(r.replaced).toMatchObject({ accepted: 0, closePresenceChanges: 0 });
  frame(r.returned.reply, null);
  expect(r.returned.reply.code).toBe("RESUME_DENIED");
  expect(r.returned.command.token).toBe(seatReuse.credentials.B.token);
});
test("lastPlay survives pass, clear and final settlement before advance", () => {
  const seq = lastPlaySequence;
  for (const s of [...seq.continuing, ...seq.ending]) frame(s, 0);
  const [play, pass, clear, paid, next] = seq.continuing;
  const [endingClear, endingPaid, ended] = seq.ending;
  expect(pass.view.lastPlay).toEqual(play.view.lastPlay);
  expect(clear.view.tableHand).toBeNull();
  expect(clear.view.lastPlay).toEqual(play.view.lastPlay);
  expect(pass.view.consecutivePasses).toBe(1);
  expect(clear.view.consecutivePasses).toBe(0);
  if (!play.view.lastPlay || clear.view.phase !== "TURN_ACTIVE")
    throw Error("missing clear");
  expect(clear.view.currentTurn).toBe(play.view.lastPlay.seatId);
  expect(paid.view.phase).toBe("ROUND_SETTLEMENT");
  expect(paid.view.lastAction?.type).toBe("PLAY");
  expect(paid.view.lastPlay?.turnId).toBe(clear.view.turnId);
  expect(paid.view.lastSettlement?.round).toBe(paid.view.round);
  expect(next.view.phase).toBe("ROUND_START");
  expect(next.view.lastPlay).toBeNull();
  expect(next.view.round).toBe(paid.view.round + 1);
  expect(next.view.lastSettlement).toEqual(paid.view.lastSettlement);
  expect(next.view.ownSettlement).toEqual(paid.view.ownSettlement);
  expect(endingPaid.revision).toBeGreaterThan(endingClear.revision);
  expect(ended.revision).toBeGreaterThan(endingPaid.revision);
  expect(ended.view.phase).toBe("GAME_OVER");
  expect(ended.view.lastPlay).toEqual(endingPaid.view.lastPlay);
  expect(ended.view.lastSettlement).toEqual(endingPaid.view.lastSettlement);
  expect(effectBatches).toEqual([
    [],
    [],
    [],
    [
      { type: "PLAY", turnId: 63 },
      { type: "SETTLEMENT", round: 1 },
    ],
    [],
  ]);
  expect(paid.view.lastPlay?.turnId).toBe(effectBatches[3][0].turnId);
  expect(paid.view.lastSettlement?.round).toBe(effectBatches[3][1].round);
  expect(a4Settlement.payments).toEqual([
    { from: 1, to: 0, amount: 1 },
    { from: 2, to: 0, amount: 2 },
    { from: 2, to: 1, amount: 1 },
  ]);
  expect(a4Settlement.details.flatMap((d) => (d ? [d.effective] : []))).toEqual(
    [0, 1, 2],
  );
  expect(paid.view.slots.flatMap((s) => (s ? [s.chips] : []))).toEqual([
    67, 64, 61,
  ]);
});
test("four OUT projections omit both private keys, survivor retains own formula", () => {
  const s = spectatorExamples;
  frame(s.resume, 3);
  for (const f of [s.transition, s.following, s.restored, s.gameOver]) {
    frame(f, s.recipient);
    expect(f.view.slots[3]?.isOut).toBe(true);
    expect(
      f.view.slots
        .flatMap((p) => (p ? [p.chips] : []))
        .reduce((a, b) => a + b, 0),
    ).toBe(256);
    for (const key of ["ownHand", "ownSettlement"]) {
      expect(Object.hasOwn(f.view, key)).toBe(false);
      for (const value of [null, [], {}])
        expect(
          decodeServerMessage(
            JSON.stringify({ ...f, view: { ...f.view, [key]: value } }),
            3,
          ),
        ).toBe("INVALID_MESSAGE");
    }
  }
  expect(
    [s.transition, s.following, s.restored, s.gameOver].map(
      (f) => f.view.phase,
    ),
  ).toEqual(["ROUND_SETTLEMENT", "ROUND_START", "TURN_ACTIVE", "GAME_OVER"]);
  expect(s.transition.view.maxNumber).toBe(13);
  expect(s.following.view.maxNumber).toBe(9);
  const survivor = s.survivor;
  frame(survivor.frame, survivor.recipient);
  expect(survivor.frame.view.ownSettlement).toEqual({
    round: 1,
    remaining: 1,
    twos: 0,
    effective: 1,
  });
  expect(decodeServerMessage(JSON.stringify(survivor.frame), 3)).toBe(
    "INVALID_MESSAGE",
  );
  expect(decodeServerMessage(JSON.stringify(s.transition), 1)).toBe(
    "INVALID_MESSAGE",
  );
});
