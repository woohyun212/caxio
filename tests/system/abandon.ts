import { isDeepStrictEqual as equal } from "node:util";
import { handOrder } from "../../apps/web/src/visual/layout";
import type { SeatId } from "../../packages/shared/src/contracts/domain";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TURN_LIMIT_SECONDS,
} from "../../packages/shared/src/contracts/settings";
import type {
  Command,
  ErrorCode,
  Seated,
  Snapshot,
} from "../../packages/shared/src/contracts/wire";
import {
  checkAbandonmentSequence,
  checkLeave,
  checkLobby,
  checkRestart,
  joined,
  remaining,
  seats,
} from "./abandon-sequence";
import { type Client, SocketRoom } from "./game";
import {
  checkAction,
  checkDeadline,
  checkDeal,
  checkNames,
  checkSettings,
  isPresence,
  judgeFrame,
  need,
  ProbeFailure,
  publicTable,
  requireCheck,
} from "./judges";
import { cliOrigin } from "./probe";

// Seat 1 stays unnamed. Seat 0 is vacated by abandonment and its replacement joins unnamed.
const seatNames = ["철수", undefined, "Bob7", "ㅋㅋ"] as const;
const naming = (name?: string) => (name === undefined ? {} : { name });
export const abandonCreate = {
  type: "CREATE_ROOM",
  name: seatNames[0],
  turnLimitSeconds: 15,
  maxRounds: 10,
} as const;
export const bareCreate = { type: "CREATE_ROOM" } as const;
const defaults = {
  turnLimitSeconds: DEFAULT_TURN_LIMIT_SECONDS,
  maxRounds: DEFAULT_MAX_ROUNDS,
} as const;
class AbandonRoom extends SocketRoom {
  newRoomClient?: Client;
  live: Client[] = [];
  tokens = new Map<SeatId, string>();
  names = new Map<SeatId, string | undefined>();
  revoked: string[] = [];
  history: { owner?: string; raw: string }[] = [];
  receive(client: Client, raw: string) {
    const m = need(
      judgeFrame(
        raw,
        client.credential?.seatId ?? null,
        this.tokens,
        client.previous,
      ),
      "duplicate snapshot revision",
    );
    requireCheck(!client.left, "frame sent to the leaver");
    requireCheck(
      this.revoked.every((token) => !raw.includes(token)),
      "revoked credential in frame",
    );
    if (m.type === "SEATED") {
      requireCheck(
        this.history.every(
          (h) => h.owner === m.token || !h.raw.includes(m.token),
        ),
        "foreign credential in earlier frame",
      );
      client.credential = m;
      this.tokens.set(m.seatId, m.token);
    }
    const owner = client.credential?.token;
    // Seat 0 changes owners. Keep the revoked token in the privacy check too.
    for (const c of this.clients) {
      const token = c.credential?.token;
      requireCheck(
        !token || token === owner || !raw.includes(token),
        "foreign credential in frame",
      );
    }
    this.history.push({ owner, raw });
    if (m.type === "SNAPSHOT") {
      const settings = client === this.newRoomClient ? defaults : abandonCreate;
      checkSettings(m.view, settings);
      checkDeadline(m, settings.turnLimitSeconds, false);
      client.previous = m;
    }
    client.queue.push(m);
    client.wake?.();
  }
  async frames(previous: readonly Snapshot[] = []) {
    const frames = await Promise.all(
      this.live.map((c, i) => {
        const prev = previous[i];
        const extra =
          prev?.view.phase === "TURN_ACTIVE"
            ? Math.max(0, prev.view.deadline - prev.serverNow)
            : 0;
        return c.next("SNAPSHOT", extra);
      }),
    );
    const first = need(frames[0], "missing observer");
    requireCheck(
      frames.every(
        (f) =>
          f.revision === first.revision &&
          equal(publicTable(f.view), publicTable(first.view)),
      ),
      "broadcast revision or public table mismatch",
    );
    return frames;
  }
  async bind(command: Command, id: SeatId, expected?: Seated) {
    const c = await this.open();
    this.idle();
    c.send(command);
    const cred = await c.next("SEATED");
    requireCheck(
      cred.seatId === id &&
        (command.type === "CREATE_ROOM" ||
          ("roomCode" in command && cred.roomCode === command.roomCode)),
      "wrong seat or room code",
    );
    if (expected)
      requireCheck(equal(cred, expected), "remaining credential changed");
    this.live.push(c);
    return c;
  }
  async deny(c: Client, command: Command, code: ErrorCode, extra = 0) {
    this.idle();
    c.send(command);
    requireCheck(
      (await c.next("ERROR", extra)).code === code,
      `expected ERROR(${code})`,
    );
    this.idle();
  }
}
const credential = (c: Client) => need(c.credential, "missing seat credential");
function actionFor(room: AbandonRoom, frames: readonly Snapshot[]) {
  const i = room.live.findIndex(
    (c) => credential(c).seatId === frames[0]?.view.currentTurn,
  );
  const actor = need(room.live[i], "missing acting socket");
  const view = need(frames[i], "missing acting frame").view;
  requireCheck(view.phase === "TURN_ACTIVE", "missing active turn");
  const tile = need(
    handOrder(need(view.ownHand, "missing hand"), view.maxNumber)[0],
    "empty hand",
  );
  const action = view.tableHand
    ? ({ type: "PASS", turnId: view.turnId } as const)
    : ({ type: "PLAY", turnId: view.turnId, tiles: [tile] } as const);
  return { actor, action };
}
export async function runAbandonProbe(
  origin: string,
  options: {
    frameMs?: number;
    totalMs?: number;
    log?: (s: string) => void;
  } = {},
): Promise<0 | 1> {
  const log = options.log ?? console.log;
  let id = "abandon.seating",
    good = 0;
  const pass = (detail = "") => {
    good++;
    log(`${id} PASS ok${detail && ` ${detail}`}`);
  };
  let room: AbandonRoom | undefined;
  try {
    const game = new AbandonRoom(
      origin,
      options.frameMs ?? 5000,
      performance.now() + (options.totalMs ?? 150000),
    );
    room = game;
    let code = "";
    for (const seat of seats) {
      const name = seatNames[seat];
      const c = await game.bind(
        seat === 0
          ? abandonCreate
          : { type: "JOIN_ROOM", roomCode: code, ...naming(name) },
        seat,
      );
      code = credential(c).roomCode;
      game.names.set(seat, name);
      for (const f of await game.frames()) {
        checkLobby(f.view, seats.slice(0, seat + 1));
        checkNames(f.view, game.names);
      }
    }
    pass();
    id = "abandon.first";
    const host = need(game.live[0], "missing host"),
      old = credential(host);
    host.send({ type: "START_GAME" });
    const deal = await game.frames();
    requireCheck(
      deal.every((f) => f.view.phase === "ROUND_START"),
      "missing first deal",
    );
    let frames = await game.frames();
    const first = need(frames[0], "missing opening frame");
    requireCheck(
      first.view.phase === "TURN_ACTIVE",
      "missing first active turn",
    );
    pass(`turnId=${first.view.turnId} revision=${first.revision}`);
    host.close();
    game.live.shift();
    frames.shift();
    const records = frames.map((f) => [f]);
    id = "abandon.presence";
    frames = await game.frames(frames);
    function observe() {
      return frames.map((f, i) => {
        const record = need(records[i], "missing seat record");
        record.push(f);
        return checkAbandonmentSequence(record, true);
      });
    }
    let evidence = need(observe()[0], "missing evidence");
    pass();
    while (!evidence.result) {
      id = evidence.third
        ? "abandon.third"
        : `abandon.automatic.${evidence.automatic.length + 1}`;
      const before = frames,
        v = need(before[0], "missing observer").view;
      const move =
        v.phase === "TURN_ACTIVE" && v.currentTurn !== 0
          ? actionFor(game, before)
          : null;
      move?.actor.send(move.action);
      frames = await game.frames(before);
      const next = need(observe()[0], "missing evidence");
      if (move)
        for (const [i, f] of frames.entries())
          checkAction(
            need(before[i], "missing turn").view,
            f.view,
            credential(need(game.live[i], "missing seat")).seatId,
            move.action,
          );
      // Names persist while the host is away; checked after the sequence judge names its own faults.
      for (const f of frames) checkNames(f.view, game.names);
      if (next.automatic.length > evidence.automatic.length)
        pass(`turnId=${next.automatic.at(-1)}`);
      if (next.third && !evidence.third) {
        id = "abandon.third.open";
        pass(
          `seat=${next.third.currentTurn} turnId=${next.third.turnId} deadline=${next.third.deadline} chips=${JSON.stringify(next.third.slots.map((s) => s?.chips ?? null))}`,
        );
      }
      evidence = next;
    }
    const result = evidence.result;
    for (const record of records) checkAbandonmentSequence(record);
    pass(
      `revision=${frames[0]?.revision} ranking=${JSON.stringify(result.ranking)}`,
    );
    id = "abandon.revoked";
    const denied = await game.open();
    await game.deny(
      denied,
      { type: "RESUME", roomCode: code, token: old.token },
      "RESUME_DENIED",
    );
    pass("credential=denied");
    id = "abandon.lobby.presence";
    const lost = need(game.live.pop(), "missing reconnect seat"),
      saved = credential(lost);
    lost.close();
    for (const f of await game.frames())
      checkLobby(f.view, remaining, result, saved.seatId);
    pass();
    id = "abandon.lobby.resume";
    await game.bind(
      { type: "RESUME", roomCode: code, token: saved.token },
      saved.seatId,
      saved,
    );
    for (const f of await game.frames()) checkLobby(f.view, remaining, result);
    pass("credential=same");
    id = "abandon.lobby.join";
    game.names.set(0, undefined);
    const replacement = await game.bind(
      { type: "JOIN_ROOM", roomCode: code },
      0,
    );
    requireCheck(
      credential(replacement).token !== old.token,
      "replacement received revoked credential",
    );
    frames = await game.frames();
    for (const f of frames) {
      checkLobby(f.view, joined, result);
      checkNames(f.view, game.names);
    }
    pass("credential=replaced");
    id = "abandon.lobby.rejected-start";
    await game.deny(replacement, { type: "START_GAME" }, "NOT_HOST");
    // A rejected start has no broadcast. Read each current view via a live-socket replacement.
    for (const [i, c] of game.live.entries()) {
      const saved = credential(c);
      c.replacing = true;
      const fresh = await game.open();
      fresh.send({ type: "RESUME", roomCode: code, token: saved.token });
      requireCheck(
        equal(await fresh.next("SEATED"), saved),
        "live resume credential changed",
      );
      const after = await fresh.next("SNAPSHOT"),
        prior = need(frames[i], "missing joined lobby");
      requireCheck(
        after.revision === prior.revision && equal(after.view, prior.view),
        "rejected start changed lobby result or revision",
      );
      game.idle();
      c.close();
      game.live[i] = fresh;
    }
    game.idle();
    pass();
    id = "abandon.restart";
    need(game.live[0], "missing new host").send({ type: "START_GAME" });
    frames = await game.frames();
    for (const f of frames) checkRestart(f.view);
    checkDeal(
      new Map(
        frames.map((f, i) => [
          credential(need(game.live[i], "missing dealt seat")).seatId,
          f.view,
        ]),
      ),
    );
    const restartDeal = frames;
    frames = await game.frames();
    for (const [i, f] of frames.entries()) {
      checkRestart(f.view);
      requireCheck(
        f.view.phase === "TURN_ACTIVE" && f.view.turnId > evidence.maxTurn,
        "reused restart turnId",
      );
      requireCheck(
        isPresence(
          { ...f.view, phase: "ROUND_START", turnId: null, deadline: null },
          need(restartDeal[i], "missing restart deal").view,
        ),
        "restart opening differs from deal",
      );
    }
    pass(`turnId=${frames[0]?.view.turnId}`);
    const { actor, action } = actionFor(game, frames);
    requireCheck(action.type === "PLAY", "expected opening lead");
    const active = need(frames[0], "missing restart turn");
    const extra = Math.max(
      0,
      need(active.view.deadline, "missing restart deadline") - active.serverNow,
    );
    for (const type of ["PLAY", "PASS"] as const) {
      id = `abandon.stale.${type}`;
      await game.deny(
        actor,
        type === "PLAY"
          ? {
              ...action,
              turnId: need(evidence.automatic[1], "missing previous turn"),
            }
          : { type, turnId: evidence.maxTurn },
        "STALE_TURN",
        extra,
      );
      pass();
    }
    id = "abandon.restart.action";
    actor.send(action);
    const acted = await game.frames(frames);
    for (const [i, f] of acted.entries())
      checkAction(
        need(frames[i], "missing opening turn").view,
        f.view,
        credential(need(game.live[i], "missing seat")).seatId,
        action,
      );
    game.idle();
    pass();
    id = "abandon.leave";
    const turn = need(acted[0], "missing turn").view;
    const at = game.live.findIndex((c) => {
      const seat = credential(c).seatId;
      return seat !== turn.currentTurn && game.names.get(seat);
    });
    requireCheck(at >= 0, "missing named waiting seat");
    const leaver = need(game.live.splice(at, 1)[0], "missing leaver");
    const left = credential(leaver);
    leaver.left = true;
    leaver.send({ type: "LEAVE_ROOM" });
    let ranking: unknown;
    for (const f of await game.frames())
      ranking = checkLeave(turn, f.view, left.seatId).ranking;
    game.idle();
    pass(`seat=${left.seatId} ranking=${JSON.stringify(ranking)}`);
    id = "abandon.leave.revoked";
    game.revoked.push(left.token);
    leaver.left = false;
    leaver.credential = undefined;
    leaver.previous = undefined;
    await game.deny(
      leaver,
      { type: "RESUME", roomCode: code, token: left.token },
      "RESUME_DENIED",
    );
    pass("credential=denied");
    id = "abandon.leave.new-room";
    game.newRoomClient = leaver;
    leaver.send(bareCreate);
    const seated = await leaver.next("SEATED");
    requireCheck(seated.roomCode !== code, "leaver created no new room");
    const fresh = await leaver.next("SNAPSHOT");
    requireCheck(
      fresh.view.phase === "LOBBY" &&
        equal(fresh.view.seatOrder, [seated.seatId]),
      "new room is not a fresh lobby",
    );
    game.idle();
    pass();
    id = "abandon.settings";
    pass();
    id = "abandon.deadline";
    pass();
    log(`summary PASS ${good} passed, 0 failed`);
    return 0;
  } catch (error) {
    log(
      `${id} FAIL ${error instanceof ProbeFailure ? error.message : "socket request failed"}`,
    );
    log(`summary FAIL ${good} passed, 1 failed`);
    return 1;
  } finally {
    room?.closeAll();
  }
}
if (import.meta.main) {
  const origin = cliOrigin(process.argv.slice(2));
  if (origin) process.exitCode = await runAbandonProbe(origin);
  else {
    console.error("Usage: bun tests/system/abandon.ts <origin>");
    process.exitCode = 2;
  }
}
