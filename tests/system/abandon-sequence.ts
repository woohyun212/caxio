import { isDeepStrictEqual as equal } from "node:util";
import type { SeatId } from "../../packages/shared/src/contracts/domain";
import type {
  LastGameRankingRow,
  LastGameResult,
  Message,
  PlayerView,
} from "../../packages/shared/src/contracts/wire";
import { isPresence, need, requireCheck } from "./judges";

export const seats = [0, 1, 2, 3] as const;
export const remaining = [1, 2, 3] as const;
export const joined = [...remaining, 0] as const;
type Turn = Extract<PlayerView, { phase: "TURN_ACTIVE" }>;

// Rows copy each seat's confirmed chips and, when it has one, its name.
function rank(turn: PlayerView, leaver: SeatId = 0): LastGameResult {
  const row = (seatId: SeatId, rank: number): LastGameRankingRow => {
    const { chips, name } = need(turn.slots[seatId], "missing pre-turn chips");
    return name === undefined
      ? { seatId, rank, chips }
      : { seatId, rank, chips, name };
  };
  const chips = (seat: SeatId) =>
    need(turn.slots[seat], "missing pre-turn chips").chips;
  const others = turn.seatOrder
    .filter((id) => id !== leaver)
    .sort((a, b) => chips(b) - chips(a));
  let previous = -1,
    place = 0;
  const ranking = others.map((seatId, i) => {
    const value = chips(seatId);
    if (value !== previous) place = i + 1;
    previous = value;
    return row(seatId, place);
  });
  ranking.push(row(leaver, turn.seatOrder.length));
  return { reason: "ABANDONMENT", leaverSeatId: leaver, ranking };
}
// An explicit leave from a running game ends it at once, ranked from the last view before it.
export function checkLeave(
  before: PlayerView,
  after: PlayerView,
  leaver: SeatId,
) {
  const result = rank(before, leaver);
  requireCheck(
    after.phase === "LOBBY" && equal(after.lastGameResult, result),
    "leave ranking, chips, names or leaver mismatch",
  );
  checkLobby(
    after,
    before.seatOrder.filter((id) => id !== leaver),
    result,
  );
  return result;
}

export function checkLobby(
  v: PlayerView,
  order: readonly SeatId[],
  result?: LastGameResult,
  offline?: SeatId,
) {
  requireCheck(
    v.phase === "LOBBY" &&
      equal(v.seatOrder, order) &&
      v.hostSeatId === order[0],
    "lobby slots, join order or host succession",
  );
  requireCheck(
    order.every((id) => v.slots[id]?.isConnected === (id !== offline)),
    "lobby presence mismatch",
  );
  requireCheck(
    equal(v.lastGameResult, result),
    "past result missing or changed",
  );
}
export function checkRestart(v: PlayerView) {
  requireCheck(
    (v.phase === "ROUND_START" || v.phase === "TURN_ACTIVE") &&
      !("lastGameResult" in v) &&
      v.round === 1 &&
      equal(v.seatOrder, joined) &&
      equal(v.activePlayers, joined) &&
      joined.every(
        (id) =>
          v.slots[id]?.chips === 64 &&
          !v.slots[id]?.isOut &&
          v.slots[id]?.isConnected,
      ),
    "restart round, seats, chips or result",
  );
}

// A live prefix may end while the host timer is running. A completed replay must have the lobby.
export function checkAbandonmentSequence(
  record: readonly Message[],
  prefix = false,
) {
  const opening = record[0];
  requireCheck(
    opening?.type === "SNAPSHOT" &&
      opening.view.phase === "TURN_ACTIVE" &&
      opening.view.slots[0]?.isConnected === true &&
      equal(opening.view.seatOrder, seats),
    "missing first active turn",
  );
  let prior = opening,
    maxTurn = opening.view.turnId,
    disconnected = false;
  const automatic: number[] = [];
  let third: Turn | undefined, result: LastGameResult | undefined;
  let restartTurn: number | undefined,
    restarted = false,
    openingApproved = false,
    stale = 0;
  for (const message of record.slice(1)) {
    if (message.type !== "SNAPSHOT") {
      requireCheck(
        restartTurn !== undefined &&
          !openingApproved &&
          message.type === "ERROR" &&
          message.code === "STALE_TURN",
        "unexpected reply in sequence",
      );
      stale++;
      continue;
    }
    const { view, revision, serverNow } = message;
    requireCheck(
      revision > prior.revision,
      "duplicate or older broadcast revision",
    );
    const before = prior.view;
    prior = message;
    if (result) {
      if (!restarted && view.phase === "LOBBY") {
        requireCheck(
          equal(view.lastGameResult, result),
          "past result missing or changed",
        );
      } else if (!restarted) {
        requireCheck(view.phase === "ROUND_START", "missing restart deal");
        checkRestart(view);
        restarted = true;
      } else if (restartTurn === undefined) {
        checkRestart(view);
        requireCheck(
          view.phase === "TURN_ACTIVE" && view.turnId > maxTurn,
          "reused restart turnId",
        );
        restartTurn = view.turnId;
      } else if (!openingApproved) {
        requireCheck(
          view.lastAction?.turnId === restartTurn &&
            !view.lastAction.automatic &&
            view.lastAction.seatId === before.currentTurn &&
            view.lastAction.type === "PLAY",
          "restart opening action not approved",
        );
        openingApproved = true;
      }
      continue;
    }
    if (!disconnected) {
      requireCheck(
        isPresence(before, view) &&
          view.slots[0]?.isConnected === false &&
          remaining.every((id) => view.slots[id]?.isConnected),
        "missing host disconnect presence",
      );
      disconnected = true;
      continue;
    }
    if (before.phase === "TURN_ACTIVE" && before.currentTurn === 0) {
      requireCheck(serverNow >= before.deadline, "host expiry before deadline");
      if (automatic.length === 2) {
        requireCheck(
          view.lastAction?.turnId !== before.turnId ||
            !view.lastAction.automatic ||
            view.lastAction.seatId !== 0,
          `third host automatic ${view.lastAction?.type} applied; received ${view.phase}`,
        );
        requireCheck(
          view.phase === "LOBBY",
          `third host turn followed by ${view.phase} instead of abandonment lobby`,
        );
        result = rank(before);
        requireCheck(
          equal(view.lastGameResult, result),
          "abandonment ranking, chips, tie order or leaver mismatch",
        );
        checkLobby(view, remaining, result);
        continue;
      }
      const type = before.tableHand ? "PASS" : "PLAY";
      requireCheck(
        equal(view.lastAction, {
          seatId: 0,
          turnId: before.turnId,
          type,
          automatic: true,
        }),
        "missing automatic host action or premature lobby",
      );
      if (type === "PLAY")
        requireCheck(
          view.lastPlay?.tiles.length === 1 &&
            view.lastPlay.seatId === 0 &&
            view.lastPlay.turnId === before.turnId,
          "automatic host lead was not a single",
        );
      requireCheck(
        view.slots[0]?.remainingTileCount ===
          need(before.slots[0], "missing host").remainingTileCount -
            (type === "PLAY" ? 1 : 0) &&
          (type !== "PASS" || equal(view.lastPlay, before.lastPlay)),
        "automatic host action changed the wrong tiles",
      );
      automatic.push(before.turnId);
    }
    requireCheck(
      view.phase !== "LOBBY" &&
        view.phase !== "GAME_OVER" &&
        equal(view.seatOrder, seats) &&
        view.slots[0]?.isConnected === false,
      "premature end or changed game occupants",
    );
    if (view.phase === "TURN_ACTIVE") {
      requireCheck(view.turnId > maxTurn, "repeated active turnId");
      maxTurn = view.turnId;
      if (view.currentTurn === 0 && automatic.length === 2) third = view;
    }
  }
  if (!prefix) {
    requireCheck(result && third, "incomplete abandonment sequence");
    if (restarted)
      requireCheck(
        openingApproved && stale === 2,
        "incomplete restart sequence",
      );
  }
  return { automatic, third, result, maxTurn };
}
