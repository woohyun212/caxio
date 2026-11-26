import type { ServerWebSocket } from "bun";
import type {
  Action,
  GameState,
  SeatId,
} from "../../packages/shared/src/contracts/domain";
import {
  abandonmentRestart,
  abandonmentResults,
  phaseExamples,
  roomCode,
} from "../../packages/shared/src/contracts/fixtures";
import {
  decodeRequest,
  decodeServerMessage,
  type ErrorCode,
  type LastGameRankingRow,
  type LastGameResult,
  WS_PATH,
} from "../../packages/shared/src/contracts/wire";
import { rules } from "../../packages/shared/src/index";
import { need } from "./judges";

export type Fault =
  | "chips"
  | "leaver"
  | "tie"
  | "invalid"
  | "accept-revoked"
  | "reuse-turn"
  | "third-action"
  | "settlement"
  | "game-over"
  | "early-count"
  | "early-time"
  | "keep-slot"
  | "drop-presence"
  | "change-resume"
  | "drop-join"
  | "change-rejected"
  | "restart-result"
  | "restart-chips"
  | "approve-play"
  | "approve-pass"
  | "old-token"
  | "leak-revoked"
  | "silent"
  | "reject-opening"
  | "silent-active"
  | "duplicate-lobby"
  | "split-revision"
  | "drop-name"
  | "keep-name"
  | "leave-ignored"
  | "leave-unnamed"
  | "leave-chips"
  | "leave-notify"
  | "leave-accept"
  | "leave-busy";
type Socket = ServerWebSocket<{ id: SeatId | null }>;
export function abandonFixture(fault?: Fault, limit = 60, rng = () => 0.99) {
  const tokens = [
    "fixture-alpha-secret",
    "fixture-beta-secret",
    "fixture-gamma-secret",
    "fixture-delta-secret",
    "fixture-replacement-secret",
    "fixture-other-room-secret",
  ] as const;
  const order: SeatId[] = [];
  const names = new Map<SeatId, string>();
  let leaver: SeatId | undefined;
  const bound = new Map<SeatId, Socket>();
  let revision = 0,
    deadline = 0,
    maxId = 0,
    misses = 0,
    abandoned = false;
  let state: GameState | undefined, result: LastGameResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sockets = 0;
  let stage = "",
    stopped = false;
  const observed: { command: Action; expected: Action }[] = [];
  function token(id: SeatId) {
    return need(
      tokens[abandoned && id === 0 && fault !== "old-token" ? 4 : id],
      "unknown seat",
    );
  }
  function send(ws: Socket, msg: unknown, invalid = false) {
    const raw = JSON.stringify(msg);
    if (!invalid && decodeServerMessage(raw, ws.data.id) === "INVALID_MESSAGE")
      throw new Error("fixture generated invalid frame");
    ws.send(raw);
  }
  function snapshot(ws: Socket) {
    const id = need(ws.data.id, "unbound mock peer"),
      g = state;
    // JSON.stringify drops the name of an unnamed seat.
    const slots = ([0, 1, 2, 3, 4] as const).map((i) =>
      order.includes(i)
        ? {
            name: names.get(i),
            chips: g?.players[i]?.chips ?? 64,
            isOut: false,
            isConnected: bound.has(i),
            remainingTileCount: g?.players[i]?.hand.length ?? 0,
          }
        : null,
    );
    let view: Record<string, unknown>;
    if (!g) {
      view = {
        ...phaseExamples[0].view,
        hostSeatId: order[0],
        canStart:
          id === order[0] &&
          order.length >= 3 &&
          order.every((s) => bound.has(s)),
        slots,
        seatOrder: order,
        ...(result ? { lastGameResult: result } : {}),
      };
    } else {
      view = {
        ...need(abandonmentRestart.firstActive[0], "missing opening").frame
          .view,
        phase: g.phase,
        round: g.round,
        maxRounds: g.maxRounds,
        slots,
        seatOrder: order,
        activePlayers: g.activePlayers,
        currentTurn: g.currentTurn,
        turnId: g.phase === "TURN_ACTIVE" ? g.turnId : null,
        deadline: g.phase === "TURN_ACTIVE" ? deadline : null,
        ownHand: g.players[id]?.hand,
        tableHand: g.tableHand,
        lastPlay: g.lastPlay,
        lastAction: g.lastAction,
        consecutivePasses: g.consecutivePasses,
        ...(abandoned && fault === "restart-result"
          ? { lastGameResult: abandonmentResults.fourTied.result }
          : {}),
      };
    }
    const invalid =
      (!g && result && fault === "invalid") ||
      (abandoned && !!g && fault === "restart-result");
    const msg = {
      type: "SNAPSHOT",
      revision:
        revision +
        (fault === "split-revision" && stage === "abandoned" && id === 3
          ? 1
          : 0),
      serverNow:
        stage === "abandoned" && fault === "early-time"
          ? deadline - 1
          : Date.now(),
      view: invalid && !g ? { ...view, unexpected: true } : view,
    };
    send(ws, msg, !!invalid);
    if (fault === "duplicate-lobby" && stage === "abandoned") send(ws, msg);
  }
  function broadcast() {
    revision += 2;
    for (const ws of bound.values()) snapshot(ws);
  }
  function withName(row: LastGameRankingRow): LastGameRankingRow {
    const name = names.get(row.seatId);
    return name === undefined ? row : { ...row, name };
  }
  function wrongChips(r: LastGameResult) {
    return {
      ...r,
      ranking: r.ranking.map((row) => ({ ...row, chips: row.chips + 1 })),
    };
  }
  function end() {
    const original = abandonmentResults.fourTied.result,
      [one, two, three, host] = original.ranking;
    result = original;
    if (fault === "chips") result = wrongChips(original);
    if (fault === "tie")
      result = { ...original, ranking: [two, one, three, host] };
    if (fault === "leaver")
      result = {
        ...original,
        leaverSeatId: 1,
        ranking: [{ ...one, seatId: 0 }, two, three, { ...host, seatId: 1 }],
      };
    if (fault === "settlement" || fault === "game-over") {
      const paid = abandonmentRestart.observed.find(
        (f) => f.type === "SNAPSHOT" && f.view.phase === "ROUND_SETTLEMENT",
      );
      if (paid?.type !== "SNAPSHOT") throw new Error("missing payment");
      revision += 2;
      for (const [id, ws] of bound) {
        const ownHand =
          id === 1
            ? []
            : need(
                abandonmentRestart.firstActive.find((f) => f.recipient === id),
                "missing hand",
              ).frame.view.ownHand;
        if (!ownHand) throw new Error("missing paid hand");
        const remaining = ownHand.length,
          twos = ownHand.filter((t) => t.number === 2).length;
        send(ws, {
          ...paid,
          revision,
          serverNow: Date.now(),
          view: {
            ...paid.view,
            ownHand,
            ownSettlement: {
              round: 1,
              remaining,
              twos,
              effective: remaining * 2 ** twos,
            },
            ...(fault === "game-over"
              ? {
                  phase: "GAME_OVER",
                  maxRounds: 1,
                  ranking: original.ranking.map(({ seatId, rank }) => ({
                    seatId,
                    rank,
                  })),
                }
              : {}),
          },
        });
      }
    }
    result = { ...result, ranking: result.ranking.map(withName) };
    if (fault !== "keep-name") names.delete(0);
    if (fault !== "keep-slot") order.shift();
    abandoned = true;
    state = undefined;
    stage = "abandoned";
    broadcast();
  }
  // Only disconnected turns race a clock in this fixture.
  function scheduleExpiry(g: GameState) {
    const actor = need(g.currentTurn, "missing actor");
    if (bound.has(actor)) return;
    function expire() {
      if (stopped || state !== g || bound.size === 0 || bound.has(actor))
        return;
      if (Date.now() < deadline) {
        timer = setTimeout(expire, deadline - Date.now());
        return;
      }
      if (actor === 0) {
        misses++;
        if (fault === "silent-active") return;
        if (
          misses === (fault === "early-count" ? 2 : 3) &&
          fault !== "third-action"
        )
          return end();
      }
      const r = rules.applyTurn(g, actor, rules.timeoutAction(g), true);
      if (r.ok) commit(r.state);
    }
    clearTimeout(timer);
    timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
  }
  function commit(g: GameState) {
    clearTimeout(timer);
    state = g;
    if (g.phase === "ROUND_START") {
      broadcast();
      commit(rules.advance(g, rng));
      return;
    }
    deadline = Date.now() + limit;
    maxId = g.turnId;
    broadcast();
    scheduleExpiry(g);
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      if (
        new URL(req.url).pathname === WS_PATH &&
        server.upgrade(req, { data: { id: null } })
      )
        return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      data: {} as { id: SeatId | null },
      open() {
        sockets++;
      },
      close(ws) {
        sockets--;
        const id = ws.data.id;
        if (stopped || id === null || bound.get(id) !== ws) return;
        bound.delete(id);
        stage = "presence";
        if (abandoned && fault === "drop-presence") result = undefined;
        broadcast();
        if (state?.currentTurn === id) scheduleExpiry(state);
      },
      message(ws, raw) {
        const cmd = decodeRequest(raw);
        const reject = (code: ErrorCode) => send(ws, { type: "ERROR", code });
        if (cmd === "INVALID_MESSAGE") return reject(cmd);
        if (fault === "silent") return;
        // The leaver's same connection opens a second, one-seat room that this fixture never broadcasts.
        if (cmd.type === "CREATE_ROOM" && order.length) {
          if (fault === "leave-busy") return reject("INVALID_PHASE");
          ws.data.id = 0;
          send(ws, {
            type: "SEATED",
            roomCode: "ZZZZ99",
            seatId: 0,
            token: tokens[5],
          });
          send(ws, {
            type: "SNAPSHOT",
            revision: 1,
            serverNow: Date.now(),
            view: {
              ...phaseExamples[0].view,
              hostSeatId: 0,
              canStart: false,
              seatOrder: [0],
              slots: [
                {
                  chips: 64,
                  isOut: false,
                  isConnected: true,
                  remainingTileCount: 0,
                },
                null,
                null,
                null,
                null,
              ],
            },
          });
          return;
        }
        if (
          cmd.type === "CREATE_ROOM" ||
          cmd.type === "JOIN_ROOM" ||
          cmd.type === "RESUME"
        ) {
          if (cmd.type !== "CREATE_ROOM" && cmd.roomCode !== roomCode)
            return reject("ROOM_NOT_FOUND");
          const id =
            cmd.type === "RESUME"
              ? order.find((s) => token(s) === cmd.token)
              : ([0, 1, 2, 3] as const).find((s) => !order.includes(s));
          if (id === undefined) {
            const revived =
              fault === "accept-revoked"
                ? 0
                : fault === "leave-accept"
                  ? leaver
                  : undefined;
            if (revived !== undefined)
              send(ws, {
                type: "SEATED",
                seatId: revived,
                roomCode,
                token: tokens[revived],
              });
            else reject("RESUME_DENIED");
            return;
          }
          const liveResume = bound.has(id);
          if (cmd.type !== "RESUME") {
            order.push(id);
            if (cmd.name !== undefined && fault !== "drop-name")
              names.set(id, cmd.name);
          }
          bound.set(id, ws);
          ws.data.id = id;
          send(ws, {
            type: "SEATED",
            roomCode,
            seatId: id,
            token:
              abandoned && id === 0 && fault === "leak-revoked"
                ? tokens[0] + token(id)
                : token(id),
          });
          if (cmd.type === "JOIN_ROOM" && abandoned && fault === "drop-join")
            result = undefined;
          if (
            cmd.type === "RESUME" &&
            result &&
            !liveResume &&
            fault === "change-resume"
          )
            result = wrongChips(result);
          if (liveResume) snapshot(ws);
          else {
            stage = "bound";
            broadcast();
          }
          return;
        }
        const id = need(ws.data.id, "unseated mock command");
        if (cmd.type === "LEAVE_ROOM") {
          const g = need(state, "leave outside a running game");
          if (fault === "leave-notify") {
            revision += 2;
            snapshot(ws);
          }
          bound.delete(id);
          ws.data.id = null;
          if (fault === "leave-ignored") return;
          const chips = (s: SeatId) =>
            need(g.players[s], "missing player").chips +
            (fault === "leave-chips" ? 1 : 0);
          const others = order
            .filter((s) => s !== id)
            .sort((a, b) => chips(b) - chips(a));
          result = {
            reason: "ABANDONMENT",
            leaverSeatId: id,
            ranking: [...others, id].map((seatId) => {
              const row = {
                seatId,
                rank:
                  seatId === id
                    ? order.length
                    : others.findIndex((s) => chips(s) === chips(seatId)) + 1,
                chips: chips(seatId),
              };
              return fault === "leave-unnamed" ? row : withName(row);
            }),
          };
          leaver = id;
          order.splice(order.indexOf(id), 1);
          names.delete(id);
          state = undefined;
          clearTimeout(timer);
          stage = "left";
          // Delay the others so the leaver's frame lands while the probe still expects silence.
          if (fault === "leave-notify") setTimeout(broadcast, 20);
          else broadcast();
          return;
        }
        if (cmd.type === "START_GAME") {
          if (id !== order[0]) {
            if (result && fault === "change-rejected")
              result = wrongChips(result);
            return reject("NOT_HOST");
          }
          const g = rules.startRound(order, rng);
          if (abandoned && fault === "restart-chips") {
            const p = need(g.players[0], "missing player");
            commit({
              ...g,
              turnId: maxId,
              players: [
                { ...p, chips: 65 },
                g.players[1],
                g.players[2],
                g.players[3],
                null,
              ],
            });
          } else commit({ ...g, turnId: fault === "reuse-turn" ? 0 : maxId });
          result = undefined;
          return;
        }
        const g = need(state, "game not started");
        const stale = cmd.turnId !== g.turnId;
        if (
          stale &&
          !(fault === "approve-play" && cmd.type === "PLAY") &&
          !(fault === "approve-pass" && cmd.type === "PASS")
        )
          return reject("STALE_TURN");
        if (abandoned && !stale && fault === "reject-opening")
          return reject("STALE_TURN");
        const r = rules.applyTurn(
          g,
          id,
          stale && cmd.type === "PASS" ? rules.timeoutAction(g) : cmd,
        );
        if (!r.ok) return reject(r.code);
        observed.push({
          command:
            cmd.type === "PLAY"
              ? { type: cmd.type, tiles: cmd.tiles }
              : { type: cmd.type },
          expected: rules.timeoutAction(g),
        });
        commit(r.state);
      },
    },
  });
  return {
    origin: server.url.origin,
    tokens,
    observed,
    sockets: () => sockets,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return server.stop(true);
    },
  };
}
