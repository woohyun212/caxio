import { expect, test } from "bun:test";
import type { SeatId, Tile } from "./domain";
import * as fixtures from "./fixtures";
import type { Message, Snapshot } from "./wire";
import {
  decodeCommand,
  decodeServerMessage,
  ERROR_TEXT,
  errorText,
  HEALTH_PATH,
  isRoomCode,
  UNKNOWN_ERROR_TEXT,
  WS_PATH,
} from "./wire";

const {
  phaseExamples,
  normalCommands,
  roomCodeExamples,
  previewExamples,
  errorExamples,
} = fixtures;
const invalid = "INVALID_MESSAGE";
const command = (v: unknown) => decodeCommand(JSON.stringify(v));
function checkFrame(frame: Message, seat: SeatId | null) {
  expect(decodeServerMessage(JSON.stringify(frame), seat)).toEqual(frame);
}
test("fixture modules survive a JSON round trip", () => {
  for (const value of Object.values(fixtures))
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
});
test("six normal text commands and structural limits", () => {
  expect(normalCommands.map((c) => c.type)).toEqual([
    "CREATE_ROOM",
    "JOIN_ROOM",
    "RESUME",
    "START_GAME",
    "PLAY",
    "PASS",
  ]);
  for (const c of normalCommands) {
    expect(command(c)).toEqual(c);
    expect(command({ ...c, seatId: 0 })).toBe(invalid);
  }
  const tile = { number: 15, suit: 3 } as const;
  for (const count of [0, 2, 4, 6, 13]) {
    const play = {
      type: "PLAY",
      turnId: 1,
      tiles: Array.from({ length: count }, () => tile),
    } as const;
    expect(command(play)).toEqual(play);
  }
  for (const tiles of [
    Array(14).fill(tile),
    null,
    [{ ...tile, number: 16 }],
    [{ ...tile, suit: 4 }],
    [{ ...tile, rank: 0 }],
    [{ number: 0, suit: 0 }],
    [{ number: 1.5, suit: 0 }],
  ])
    expect(command({ type: "PLAY", turnId: 1, tiles })).toBe(invalid);
  for (const turnId of [0, -1, 1.5, null, "1", 2 ** 53])
    expect(command({ type: "PASS", turnId })).toBe(invalid);
  for (const v of [
    "",
    null,
    {},
    [],
    1,
    { type: "RESUME", roomCode: fixtures.roomCode, token: "" },
    { type: "RESUME", roomCode: fixtures.roomCode, token: ["x"] },
    { type: "PLAY", turnId: 2 },
    { type: "UNKNOWN" },
  ])
    expect(command(v)).toBe(invalid);
  expect(decodeCommand("{")).toBe(invalid);
  expect(decodeCommand({ type: "START_GAME" })).toBe(invalid);
});
test("canonical six-character room codes", () => {
  for (const code of roomCodeExamples.valid) {
    expect(isRoomCode(code)).toBe(true);
    expect(command({ type: "JOIN_ROOM", roomCode: code })).toEqual({
      type: "JOIN_ROOM",
      roomCode: code,
    });
  }
  for (const code of roomCodeExamples.normalize)
    expect(isRoomCode(code.trim().toUpperCase())).toBe(true);
  for (const code of [
    ...roomCodeExamples.normalize,
    ...roomCodeExamples.invalid,
  ]) {
    expect(isRoomCode(code)).toBe(false);
    expect(command({ type: "JOIN_ROOM", roomCode: code })).toBe(invalid);
    expect(command({ type: "RESUME", roomCode: code, token: "A" })).toBe(
      invalid,
    );
  }
});
test("per-phase fields and nested privacy whitelists", () => {
  const rejects = (frame: Snapshot, patch: Record<string, unknown>) =>
    expect(
      decodeServerMessage(
        JSON.stringify({ ...frame, view: { ...frame.view, ...patch } }),
        0,
      ),
    ).toBe(invalid);
  expect(phaseExamples.map((f) => f.view.phase)).toEqual([
    "LOBBY",
    "ROUND_START",
    "TURN_ACTIVE",
    "ROUND_SETTLEMENT",
    "GAME_OVER",
  ]);
  for (const f of phaseExamples) {
    checkFrame(f, 0);
    const v = f.view;
    expect(v.slots.length).toBe(5);
    expect(Object.keys(v.slots[0] ?? {}).sort()).toEqual([
      "chips",
      "isConnected",
      "isOut",
      "remainingTileCount",
    ]);
    for (const key of Object.keys(v)) {
      const copy = { ...v };
      Reflect.deleteProperty(copy, key);
      expect(decodeServerMessage(JSON.stringify({ ...f, view: copy }), 0)).toBe(
        invalid,
      );
    }
    for (const patch of [
      { token: "secret" },
      { otherHand: [] },
      { slots: v.slots.map((s) => (s ? { ...s, hand: [] } : s)) },
      { roomCode: fixtures.roomCode },
      { seatOrder: [0, 1, 1] },
      { slots: [...v.slots, null] },
    ])
      rejects(f, patch);
    expect(
      decodeServerMessage(JSON.stringify({ ...f, token: "secret" }), 0),
    ).toBe(invalid);
    expect(decodeServerMessage(JSON.stringify(f), null)).toBe(invalid);
    if (v.phase !== "LOBBY") {
      rejects(f, { hostSeatId: 0, canStart: true });
      rejects(f, { round: 0 });
      rejects(f, { maxNumber: null });
    }
    if (v.phase !== "TURN_ACTIVE") {
      rejects(f, { deadline: f.serverNow + 30000 });
      rejects(f, { turnId: 42 });
    }
    if (v.phase !== "GAME_OVER")
      rejects(f, { ranking: [{ seatId: 0, rank: 1 }] });
    rejects(f, { currentTurn: v.currentTurn === null ? 0 : null });
  }
  const paid = phaseExamples[3];
  if (!paid?.view.lastSettlement) throw Error("missing settlement");
  rejects(paid, {
    lastSettlement: {
      ...paid.view.lastSettlement,
      results: paid.view.lastSettlement.results.map((r) => ({
        ...r,
        effective: 0,
      })),
    },
  });
  rejects(paid, {
    ownSettlement: { ...paid.view.ownSettlement, effective: 123 },
  });
  rejects(paid, { lastAction: { ...paid.view.lastAction, token: "secret" } });
  rejects(paid, { lastPlay: { ...paid.view.lastPlay, hand: [] } });
  checkFrame(fixtures.tiedRankingExample, 0);
  expect(fixtures.tiedRankingExample.view.ranking.map((r) => r.rank)).toEqual([
    1, 1, 3,
  ]);
});
test("error vocabulary and triggers match all visual-spec rows in order", async () => {
  const spec = await Bun.file(
    new URL("../../../../docs/design/visual-spec.md", import.meta.url),
  ).text();
  const rows = Array.from(
    spec.matchAll(/^\| ([A-Z_]+|기타) \| ([^|]+?) \|/gm),
    (m) => [m[1], m[2]],
  );
  expect(rows).toEqual([
    ...Object.entries(ERROR_TEXT),
    ["기타", UNKNOWN_ERROR_TEXT],
  ]);
  expect(Object.keys(ERROR_TEXT)).toEqual(
    errorExamples.map((e) => e.reply.code),
  );
  for (const e of errorExamples) {
    checkFrame(e.reply, null);
    if ("when" in e) expect(e.when.length).toBeGreaterThan(0);
    expect(command(e.command)).toEqual(
      e.reply.code === invalid ? invalid : e.command,
    );
    expect(errorText(e.reply.code)).toBe(ERROR_TEXT[e.reply.code]);
  }
  expect(errorText("toString")).toBe(UNKNOWN_ERROR_TEXT);
  expect(errorText("FUTURE")).toBe(UNKNOWN_ERROR_TEXT);
});
test("preview specimens and rejection precedence", () => {
  expect(fixtures.previewRejectionOrder).toEqual([
    "EMPTY",
    "COUNT",
    "ILLEGAL_HAND",
    "WRONG_COUNT",
    "NOT_HIGHER",
  ]);
  const [pair, count, lower] = previewExamples;
  expect(pair.tableHand).toEqual([
    { number: 4, suit: 1 },
    { number: 4, suit: 3 },
  ]);
  expect(pair.selected).toEqual([
    { number: 7, suit: 0 },
    { number: 7, suit: 2 },
  ]);
  expect(pair.result).toEqual({
    ok: true,
    kind: "PAIR",
    representative: { number: 7, suit: 2 },
  });
  expect(count.selected.length).toBe(4);
  expect(count.result.reason).toBe("COUNT");
  expect(lower.selected).toEqual([
    { number: 3, suit: 0 },
    { number: 3, suit: 2 },
  ]);
  expect(lower.result.reason).toBe("NOT_HIGHER");
  const [triple, straight] = fixtures.representativeExamples;
  expect([triple.tableHand, straight.tableHand]).toEqual([null, null]);
  expect([triple.maxNumber, straight.maxNumber]).toEqual([9, 9]);
  expect(triple.selected).toEqual([
    { number: 3, suit: 0 },
    { number: 3, suit: 1 },
    { number: 3, suit: 2 },
  ]);
  expect(triple.result).toEqual({
    ok: true,
    kind: "TRIPLE",
    representative: 3,
  });
  expect(straight.selected).toEqual([
    { number: 1, suit: 0 },
    { number: 2, suit: 1 },
    { number: 3, suit: 2 },
    { number: 4, suit: 3 },
    { number: 5, suit: 0 },
  ]);
  expect(straight.result).toEqual({
    ok: true,
    kind: "STRAIGHT",
    representative: { number: 2, suit: 1 },
  });
});
test("app ports use only shared type imports", async () => {
  for (const app of ["web", "server"]) {
    const source = await Bun.file(
      new URL(`../../../../apps/${app}/src/contracts.ts`, import.meta.url),
    ).text();
    const imports = source.match(/\bimport\s+[^;]+;/gs) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports)
      expect(i).toMatch(
        /^import type\s*\{[^}]+\}\s*from "@caxio\/shared\/contracts\/[\w-]+";$/s,
      );
  }
});

test("deal sizes and game-over reason precedence", () => {
  const deals = fixtures.dealExamples.map((f) => {
    checkFrame(f, 0);
    expect(f.view.ownHand).toContainEqual({ number: 3, suit: 0 });
    const occupied = f.view.slots.flatMap((s) => (s ? [s] : []));
    expect(
      occupied.every(
        (s) =>
          s.chips === 64 && s.remainingTileCount === f.view.ownHand?.length,
      ),
    ).toBe(true);
    return [occupied.length, f.view.maxNumber, f.view.ownHand?.length];
  });
  expect(deals).toEqual([
    [3, 9, 12],
    [4, 13, 13],
    [5, 15, 12],
  ]);
  const cases = fixtures.gameOverExamples.map(({ snapshot, reason }) => {
    checkFrame(snapshot, 0);
    return [
      snapshot.view.round === snapshot.view.maxRounds,
      snapshot.view.activePlayers.length,
      reason,
    ];
  });
  expect(cases).toEqual([
    [true, 3, "LAST_ROUND"],
    [false, 2, "FEWER_THAN_THREE"],
    [true, 2, "LAST_ROUND"],
  ]);
});
test("turn error examples replay the first violation from the recipient snapshot", () => {
  const codes = fixtures.turnErrorExamples.map((r) => r.reply.code);
  expect(codes).toEqual([
    "NOT_YOUR_TURN",
    "STALE_TURN",
    "TIME_EXPIRED",
    "NOT_OWNED",
    "DUPLICATE_TILE",
    "ILLEGAL_HAND",
    "WRONG_COUNT",
    "NOT_HIGHER",
    "LEAD_PASS",
  ]);
  for (const r of fixtures.turnErrorExamples) {
    checkFrame(r.before, r.recipient);
    checkFrame(r.reply, r.recipient);
    expect(command(r.command)).toEqual(r.command);
    const v = r.before.view;
    if (v.phase !== "TURN_ACTIVE" || !v.ownHand)
      throw Error("missing active hand");
    const c = r.command,
      code = r.reply.code;
    expect(r.now).toBeGreaterThanOrEqual(r.before.serverNow);
    if (c.turnId !== v.turnId) {
      expect(code).toBe("STALE_TURN");
      continue;
    }
    if (r.now >= v.deadline) {
      expect(code).toBe("TIME_EXPIRED");
      continue;
    }
    if (r.recipient !== v.currentTurn) {
      expect(code).toBe("NOT_YOUR_TURN");
      continue;
    }
    if (c.type === "PASS") {
      expect(v.tableHand).toBeNull();
      expect(code).toBe("LEAD_PASS");
      continue;
    }
    const tiles: readonly Tile[] = c.tiles;
    if (
      !tiles.every((t) =>
        v.ownHand?.some((p) => p.number === t.number && p.suit === t.suit),
      )
    ) {
      expect(code).toBe("NOT_OWNED");
      continue;
    }
    if (
      new Set(tiles.map((t) => t.number * 4 + t.suit)).size !== tiles.length
    ) {
      expect(code).toBe("DUPLICATE_TILE");
      continue;
    }
    if (code === "ILLEGAL_HAND") {
      expect(tiles.map((t) => t.number)).toEqual([4, 5]);
      continue;
    }
    if (code === "WRONG_COUNT") {
      expect(tiles.map((t) => t.number)).toEqual([4, 4]);
      expect(v.tableHand).toHaveLength(1);
      continue;
    }
    expect(code).toBe("NOT_HIGHER");
    expect(tiles).toEqual([{ number: 4, suit: 0 }]);
    expect(v.tableHand).toEqual([{ number: 9, suit: 0 }]);
  }
});

test("HTTP adapter, client and probe share WebSocket and health paths", () => {
  expect(WS_PATH).toBe("/ws");
  expect(HEALTH_PATH).toBe("/healthz");
});
test("seated actions check phase first and resume distinguishes a missing room", () => {
  const cases = fixtures.phaseAndResumeErrors;
  expect(
    cases.map((e) =>
      "before" in e
        ? [e.before.view.phase, e.command.type]
        : [e.when, e.command.type],
    ),
  ).toEqual([
    ["ROUND_START", "PLAY"],
    ["ROUND_SETTLEMENT", "PASS"],
    ["GAME_OVER", "PLAY"],
    ["TURN_ACTIVE", "START_GAME"],
    ["room no longer exists", "RESUME"],
  ]);
  for (const e of cases) {
    expect(command(e.command)).toEqual(e.command);
    if ("before" in e) {
      checkFrame(e.before, e.recipient);
      checkFrame(e.reply, e.recipient);
      expect(e.before.view.slots[e.recipient]).not.toBeNull();
      expect(e.now).toBeGreaterThanOrEqual(e.before.serverNow);
      expect(e.before.view.phase).not.toBe(
        e.command.type === "START_GAME" ? "LOBBY" : "TURN_ACTIVE",
      );
      expect(e.reply.code).toBe("INVALID_PHASE");
    } else {
      checkFrame(e.reply, null);
      expect(e.reply.code).toBe("ROOM_NOT_FOUND");
    }
  }
});
