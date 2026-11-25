import { isDeepStrictEqual as equal } from "node:util";
import { handOrder } from "../../apps/web/src/visual/layout";
import type {
  Action,
  SeatId,
  Tile,
} from "../../packages/shared/src/contracts/domain";
import {
  decodeServerMessage,
  type PlayerView,
  type Snapshot,
} from "../../packages/shared/src/contracts/wire";

export function requireCheck(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new ProbeFailure(reason);
}
// Only locally authored diagnostics may reach the CLI.
export class ProbeFailure extends Error {}
export function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}
export function need<T>(value: T | null | undefined, reason: string): T {
  requireCheck(value != null, reason);
  return value;
}
export function publicTable({
  ownHand: _hand,
  ownSettlement: _settlement,
  ...view
}: PlayerView) {
  if (view.phase === "LOBBY") {
    const { canStart: _can, ...rest } = view;
    return rest;
  }
  return view;
}
function withoutPresence(v: PlayerView) {
  return {
    ...publicTable(v),
    ownHand: v.ownHand && handOrder(v.ownHand, v.maxNumber ?? 9),
    ownSettlement: v.ownSettlement,
    turnId: null,
    deadline: null,
    slots: v.slots.map((s) => s && { ...s, isConnected: true }),
  };
}
export function isPresence(before: PlayerView, after: PlayerView) {
  if (!equal(withoutPresence(before), withoutPresence(after))) return false;
  requireCheck(
    before.turnId === after.turnId && before.deadline === after.deadline,
    "presence changed turnId or deadline",
  );
  return true;
}
export function judgeFrame(
  raw: unknown,
  seat: SeatId | null,
  tokens: ReadonlyMap<SeatId, string>,
  previous?: Snapshot,
) {
  const message = decodeServerMessage(raw, seat);
  const owner =
    message !== "INVALID_MESSAGE" && message.type === "SEATED"
      ? message.seatId
      : seat;
  if (typeof raw === "string")
    for (const [id, token] of tokens)
      requireCheck(
        id === owner || !raw.includes(token),
        "foreign seat token in frame",
      );
  requireCheck(
    message !== "INVALID_MESSAGE",
    "invalid server frame or recipient",
  );
  requireCheck(message.type !== "SEATED" || seat === null, "unexpected SEATED");
  if (message.type === "SNAPSHOT" && previous) {
    requireCheck(message.revision >= previous.revision, "revision decreased");
    if (message.revision === previous.revision) {
      requireCheck(
        equal(message.view, previous.view),
        "view changed at repeated revision",
      );
      return null;
    }
  }
  return message;
}
export function checkPublic(
  seen: Map<number, ReturnType<typeof publicTable>>,
  frame: Snapshot,
) {
  const table = publicTable(frame.view),
    old = seen.get(frame.revision);
  requireCheck(
    !old || equal(old, table),
    "public table mismatch at shared revision",
  );
  seen.set(frame.revision, table);
}
export function checkDeal(views: ReadonlyMap<SeatId, PlayerView>) {
  const first = need(views.values().next().value, "missing deal");
  requireCheck(first.phase === "ROUND_START", "expected ROUND_START");
  const deck = new Set<number>();
  for (const id of first.activePlayers) {
    const v = need(views.get(id), "missing dealt seat");
    requireCheck(
      v.phase === "ROUND_START" &&
        v.round === first.round &&
        v.currentTurn === first.currentTurn &&
        v.maxNumber === first.maxNumber,
      "inconsistent deal",
    );
    for (const tile of need(v.ownHand, "missing hand")) {
      const key = tile.number * 4 + tile.suit;
      requireCheck(!deck.has(key), "overlapping deal");
      deck.add(key);
      if (tile.number === 3 && tile.suit === 0)
        requireCheck(id === v.currentTurn, "leader does not hold cloud 3");
    }
  }
  requireCheck(deck.size === 4 * first.maxNumber, "incomplete deck");
}
export function checkFinal(v: PlayerView) {
  requireCheck(v.phase === "GAME_OVER", "expected GAME_OVER");
  requireCheck(
    equal(v.ranking.map((r) => r.seatId).sort(), [...v.seatOrder].sort()),
    "ranking coverage",
  );
  requireCheck(
    v.slots.reduce((sum, s) => sum + (s?.chips ?? 0), 0) ===
      64 * v.seatOrder.length,
    "chip total",
  );
}
export function sameTile(a: Tile, b: Tile) {
  return a.number === b.number && a.suit === b.suit;
}
export function checkAction(
  before: PlayerView,
  after: PlayerView,
  seat: SeatId,
  action: Action,
) {
  requireCheck(before.phase === "TURN_ACTIVE", "expected active turn");
  const actor = before.currentTurn,
    turnId = before.turnId;
  requireCheck(
    equal(after.lastAction, {
      type: action.type,
      seatId: actor,
      turnId,
      automatic: false,
    }),
    "lastAction mismatch",
  );
  const played = action.type === "PLAY" ? action.tiles : [];
  requireCheck(
    equal(
      after.lastPlay,
      action.type === "PASS"
        ? before.lastPlay
        : { turnId, seatId: actor, tiles: played },
    ),
    "lastPlay mismatch",
  );
  const count =
    need(before.slots[actor], "missing actor").remainingTileCount -
    played.length;
  requireCheck(
    after.phase === (count === 0 ? "ROUND_SETTLEMENT" : "TURN_ACTIVE") &&
      after.round === before.round,
    "unexpected action phase",
  );
  for (const id of before.activePlayers)
    requireCheck(
      after.slots[id]?.remainingTileCount ===
        (id === actor ? count : before.slots[id]?.remainingTileCount),
      "remaining hand count",
    );
  if (after.ownHand) {
    const expected = need(before.ownHand, "missing previous hand").filter(
      (t) => seat !== actor || !played.some((p) => sameTile(t, p)),
    );
    requireCheck(
      equal(
        handOrder(expected, before.maxNumber),
        handOrder(after.ownHand, before.maxNumber),
      ),
      "private hand mismatch",
    );
  }
  const passes = action.type === "PASS" ? before.consecutivePasses + 1 : 0;
  const clear = passes === before.activePlayers.length - 1;
  requireCheck(
    after.consecutivePasses === (clear ? 0 : passes) &&
      equal(
        after.tableHand,
        clear ? null : action.type === "PLAY" ? played : before.tableHand,
      ),
    "trick clear or table mismatch",
  );
  if (after.phase === "TURN_ACTIVE") {
    const next =
      before.activePlayers[
        (before.activePlayers.indexOf(actor) + 1) % before.activePlayers.length
      ];
    requireCheck(
      after.turnId > turnId &&
        after.currentTurn === (clear ? before.lastPlay?.seatId : next),
      "next active turn mismatch",
    );
    requireCheck(
      equal(before.activePlayers, after.activePlayers) &&
        equal(before.seatOrder, after.seatOrder) &&
        before.maxRounds === after.maxRounds &&
        equal(before.lastSettlement, after.lastSettlement) &&
        equal(before.ownSettlement, after.ownSettlement) &&
        before.slots.every((s, i) => s?.chips === after.slots[i]?.chips),
      "unrelated active turn change",
    );
  }
}
