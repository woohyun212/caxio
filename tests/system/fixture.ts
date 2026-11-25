import type { ServerWebSocket } from "bun";
import { atlases, fontFiles } from "../../apps/web/src/visual/assets";
import { handOrder } from "../../apps/web/src/visual/layout";
import type {
  LastAction,
  LastPlay,
  LastSettlement,
  SeatId,
  Slots,
  Tile,
} from "../../packages/shared/src/contracts/domain";
import {
  firstDealState,
  phaseExamples,
  roomCode,
} from "../../packages/shared/src/contracts/fixtures";
import {
  decodeCommand,
  decodeServerMessage,
  type ErrorCode,
  HEALTH_PATH,
  type Message,
  type PlayerView,
  type PublicSeat,
  WS_PATH,
} from "../../packages/shared/src/contracts/wire";
import { need, sameTile } from "./judges";
export const payload = "asset fixture";
export const digest = new Bun.CryptoHasher("sha256")
  .update(payload)
  .digest("hex");
export const assets = [atlases.wide, atlases.compact, ...fontFiles].map(
  (a) => ({ url: a.url, bytes: payload.length, sha256: digest }),
);
type Socket = ServerWebSocket<{ id: SeatId | null }>;
export type Fault =
  | "asset"
  | "leak"
  | "missing"
  | "approve"
  | "silent"
  | "endless"
  | "unready"
  | "old-play"
  | "elimination"
  | "old-close"
  | "no-lower";
export function fixture(fault?: Fault) {
  let revision = 0,
    turnId = 0,
    round = 0,
    passes = 0,
    now = 1700000000000;
  let current: SeatId = 0,
    phase: PlayerView["phase"] = "LOBBY";
  let lastAction: LastAction | null = null,
    lastPlay: LastPlay | null = null,
    tableHand: readonly Tile[] | null = null,
    settlement: LastSettlement | null = null;
  const maxRounds = fault === "endless" ? 1_000_000 : 1;
  const seats: SeatId[] = [],
    bound = new Map<SeatId, Socket>();
  let hands: Tile[][] = [];
  const chips = [64, 64, 64],
    tokens = [
      "protected-credential-alpha",
      "protected-credential-beta",
      "protected-credential-gamma",
    ];
  const observations = {
    activeResumes: 0,
    finalResumes: [] as SeatId[],
    replacedPlays: [] as Tile[],
    leads: [] as Tile[],
  };
  const token = (id: SeatId) => need(tokens[id], "invalid seat");
  const hand = (id: SeatId) => need(hands[id], "invalid hand");
  function send(ws: Socket, m: Message) {
    const raw = JSON.stringify(m);
    if (
      decodeServerMessage(raw, m.type === "SEATED" ? null : ws.data.id) ===
      "INVALID_MESSAGE"
    )
      throw new Error(`invalid fixture message ${m.type}`);
    ws.send(raw);
  }
  function view(id: SeatId): PlayerView {
    const slot = (i: SeatId): PublicSeat | null =>
      seats.includes(i)
        ? {
            remainingTileCount: hands[i]?.length ?? 0,
            chips: need(chips[i], "missing chips"),
            isConnected: bound.has(i),
            isOut: chips[i] === 0,
          }
        : null;
    const slots: Slots<PublicSeat> = [slot(0), slot(1), slot(2), null, null];
    const ownHand = hands[id] ?? [];
    const common = {
      slots,
      seatOrder: seats,
      activePlayers:
        phase === "LOBBY" ? [] : seats.filter((s) => chips[s] !== 0),
      round,
      maxRounds,
      consecutivePasses: passes,
      tableHand,
      lastPlay,
      lastAction,
      lastSettlement: settlement,
      ownHand,
    };
    if (phase === "LOBBY")
      return {
        ...phaseExamples[0].view,
        ...common,
        phase,
        round: 0,
        maxNumber: null,
        hostSeatId: 0,
        canStart:
          id === 0 && seats.length === 3 && seats.every((s) => bound.has(s)),
        currentTurn: null,
        deadline: null,
        turnId: null,
        ranking: [],
      };
    const remaining =
      phase === "ROUND_SETTLEMENT" || phase === "GAME_OVER"
        ? ownHand.length
        : id === 0
          ? 0
          : 12;
    const twos =
      phase === "ROUND_SETTLEMENT" || phase === "GAME_OVER"
        ? ownHand.filter((t) => t.number === 2).length
        : 0;
    const details =
      settlement && chips[id] !== 0
        ? {
            ownSettlement: {
              round: settlement.round,
              remaining,
              twos,
              effective: remaining * 2 ** twos,
            },
          }
        : {};
    const base = { ...common, ...details, maxNumber: 9 as const };
    if (phase === "ROUND_START")
      return {
        ...base,
        phase,
        currentTurn: current,
        turnId: null,
        deadline: null,
        ranking: [],
      };
    if (phase === "TURN_ACTIVE")
      return {
        ...base,
        phase,
        currentTurn: current,
        turnId,
        deadline: now + 30000,
        ranking: [],
      };
    const paid = { ...base, currentTurn: null, turnId: null, deadline: null };
    if (phase === "ROUND_SETTLEMENT") return { ...paid, phase, ranking: [] };
    return {
      ...paid,
      phase: "GAME_OVER",
      ranking: seats.map((seatId, i) => ({ rank: i + 1, seatId })),
    };
  }
  function snapshot(ws: Socket) {
    const id = need(ws.data.id, "missing seat");
    const projected = view(id);
    const { ownHand: _hand, ownSettlement: _details, ...table } = projected;
    const frame = {
      type: "SNAPSHOT",
      view: chips[id] === 0 ? table : projected,
      revision,
      serverNow: now,
    } as const;
    if (fault === "leak" && id === 0 && seats.length === 3)
      ws.send(JSON.stringify({ ...frame, leak: token(1) }));
    else send(ws, frame);
  }
  function broadcast() {
    revision += 2;
    for (const ws of bound.values()) snapshot(ws);
  }
  function deal() {
    round++;
    phase = "ROUND_START";
    current = 0;
    lastAction = null;
    lastPlay = null;
    tableHand = null;
    passes = 0;
    hands = firstDealState.players.flatMap((p) => (p ? [[...p.hand]] : []));
    if (fault === "elimination") {
      const leader = hand(0),
        follower = hand(2);
      const twos = leader.filter((t) => t.number === 2).slice(0, 3);
      hands[0] = [
        ...leader.filter((t) => !twos.includes(t)),
        ...follower.slice(0, 3),
      ];
      hands[2] = [...twos, ...follower.slice(3)];
    }
    if (fault === "no-lower") {
      const deck = handOrder(hands.flat(), 9);
      hands = [deck.slice(0, 12), deck.slice(12, 24), deck.slice(24)];
    }
    broadcast();
    phase = "TURN_ACTIVE";
    turnId++;
    now++;
    broadcast();
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === WS_PATH && server.upgrade(req, { data: { id: null } }))
        return;
      if (path === HEALTH_PATH)
        return new Response(null, { status: fault === "unready" ? 503 : 200 });
      if (path === "/")
        return new Response('<script type="module" src="/entry.js"></script>');
      if (path === "/entry.js") return new Response("void 0");
      if (assets.some((a) => a.url === path)) {
        if (req.headers.get("accept-encoding") !== "identity")
          return new Response(null, { status: 400 });
        const headers = {
          "cache-control": "public, max-age=0, must-revalidate",
          etag: `"${digest}"`,
        };
        if (req.headers.get("if-none-match") === headers.etag)
          return new Response(null, { status: 304, headers });
        return new Response(
          fault === "asset" && path === atlases.wide.url ? "bad" : payload,
          { headers },
        );
      }
      return new Response(null, { status: fault === "missing" ? 200 : 404 });
    },
    websocket: {
      data: {} as { id: SeatId | null },
      close(ws) {
        const id = ws.data.id;
        if (id !== null && (bound.get(id) === ws || fault === "old-close")) {
          bound.delete(id);
          broadcast();
        }
      },
      message(ws, raw) {
        const reject = (code: ErrorCode) => send(ws, { type: "ERROR", code });
        const cmd = decodeCommand(raw);
        if (cmd === "INVALID_MESSAGE") return reject(cmd);
        if (
          cmd.type === "CREATE_ROOM" ||
          cmd.type === "JOIN_ROOM" ||
          cmd.type === "RESUME"
        ) {
          const id =
            cmd.type === "RESUME"
              ? seats.find((id) => token(id) === cmd.token)
              : firstDealState.seatOrder[seats.length];
          if (
            id === undefined ||
            (cmd.type !== "CREATE_ROOM" && cmd.roomCode !== roomCode)
          )
            return reject("RESUME_DENIED");
          if (cmd.type !== "RESUME") seats.push(id);
          else if (phase === "GAME_OVER") observations.finalResumes.push(id);
          else observations.activeResumes++;
          bound.set(id, ws);
          ws.data.id = id;
          send(ws, { type: "SEATED", roomCode, seatId: id, token: token(id) });
          broadcast();
          return;
        }
        if (fault === "silent") return;
        const id = ws.data.id;
        if (id === null) return reject("NOT_SEATED");
        if (bound.get(id) !== ws) {
          if (cmd.type === "PLAY")
            observations.replacedPlays.push(...cmd.tiles);
          if (fault !== "old-play") return reject("NOT_SEATED");
        }
        if (cmd.type === "START_GAME") {
          if (id !== seats[0]) return reject("NOT_HOST");
          deal();
          return;
        }
        if (cmd.turnId !== turnId) return reject("STALE_TURN");
        if (id !== current && fault !== "approve")
          return reject("NOT_YOUR_TURN");
        if (cmd.type === "PLAY") {
          if (cmd.tiles.some((t) => !hand(id).some((p) => sameTile(t, p))))
            return reject("NOT_OWNED");
          if (
            cmd.tiles.some((t, i) =>
              cmd.tiles.slice(0, i).some((p) => sameTile(p, t)),
            )
          )
            return reject("DUPLICATE_TILE");
          if (cmd.tiles.length !== 1) return reject("ILLEGAL_HAND");
          const previous = tableHand?.[0],
            next = need(cmd.tiles[0], "missing tile");
          if (previous && handOrder([next, previous], 9)[0] === next)
            return reject("NOT_HIGHER");
          if (!previous) observations.leads.push(next);
          hands[id] = hand(id).filter((t) => !sameTile(t, next));
          tableHand = cmd.tiles;
          lastPlay = { seatId: id, turnId, tiles: cmd.tiles };
          passes = 0;
        } else {
          passes++;
          if (passes === 2) {
            passes = 0;
            tableHand = null;
          }
        }
        lastAction = { seatId: id, turnId, type: cmd.type, automatic: false };
        if (hand(id).length === 0) {
          // Fixed payouts for these deals: seat 2 pays twelve or goes OUT paying its remaining 64.
          if (fault === "no-lower" || fault === "elimination")
            chips.splice(0, 3, 140, 52, 0);
          else if (fault !== "endless") chips.splice(0, 3, 88, 52, 52);
          settlement = {
            round,
            results: seats.map((seatId, i) => ({
              seatId,
              rank: i + 1,
              chipChange: need(chips[i], "missing chips") - 64,
            })),
          };
          phase = "ROUND_SETTLEMENT";
          broadcast();
          if (round < maxRounds) deal();
          else {
            phase = "GAME_OVER";
            broadcast();
          }
        } else {
          current = need(
            seats[(seats.indexOf(id) + 1) % seats.length],
            "missing next seat",
          );
          turnId++;
          now++;
          broadcast();
        }
      },
    },
  });
  return {
    origin: server.url.origin,
    tokens,
    observations,
    stop: () => server.stop(true),
  };
}
