import type { ServerWebSocket } from "bun";
import { atlases, fontFiles } from "../../apps/web/src/visual/assets";
import { handOrder } from "../../apps/web/src/visual/layout";
import type {
  LastAction,
  LastPlay,
  LastSettlement,
  OwnSettlement,
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
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TURN_LIMIT_SECONDS,
  type MaxRounds,
  type TurnLimitSeconds,
} from "../../packages/shared/src/contracts/settings";
import {
  decodeRequest,
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
  | "accept-limit"
  | "accept-rounds"
  | "default-settings"
  | "missing-limit"
  | "wrong-joiner"
  | "short-deadline"
  | "early-end"
  | "early-elimination"
  | "replay"
  | "replaced-notice"
  | "replaced-settings"
  | "wrong-error"
  | "extra-error"
  | "resume-token"
  | "resume-hand"
  | "accepted-token"
  | "split-table"
  | "wrong-leader"
  | "chip-total"
  | "final-table"
  | "asset"
  | "leak"
  | "missing"
  | "approve"
  | "silent"
  | "endless"
  | "overlong-replay"
  | "wrong-rounds"
  | "unready"
  | "old-play"
  | "elimination"
  | "old-close"
  | "accept-name"
  | "drop-name"
  | "resume-name"
  | "keep-leaver"
  | "reuse-token"
  | "notify-leaver"
  | "accept-left";
function withoutKey(raw: string | Buffer, key: string) {
  try {
    const { [key]: _ignored, ...rest } = JSON.parse(String(raw));
    return JSON.stringify(rest);
  } catch {
    return raw;
  }
}
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
  let maxRounds: MaxRounds = DEFAULT_MAX_ROUNDS,
    turnLimitSeconds: TurnLimitSeconds = DEFAULT_TURN_LIMIT_SECONDS;
  let details: OwnSettlement[] = [];
  const seats: SeatId[] = [],
    bound = new Map<SeatId, Socket>();
  let hands: Tile[][] = [];
  const names: (string | undefined)[] = [];
  const chips = [64, 64, 64],
    tokens = [
      "protected-credential-alpha",
      "protected-credential-beta",
      "protected-credential-gamma",
    ],
    revoked: string[] = [];
  const observations = {
    activeResumes: 0,
    finalResumes: [] as SeatId[],
    replacedPlays: [] as Tile[],
    leads: [] as Tile[],
    lowestAtLead: [] as Tile[],
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
    // JSON.stringify drops the name of an unnamed seat.
    const slot = (i: SeatId): PublicSeat | null =>
      seats.includes(i)
        ? {
            name: names[i],
            remainingTileCount: hands[i]?.length ?? 0,
            chips: need(chips[i], "missing chips"),
            isConnected:
              bound.has(i) &&
              !(
                fault === "split-table" &&
                phase === "ROUND_START" &&
                id === 1 &&
                i === 2
              ),
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
      maxRounds:
        fault === "default-settings" || fault === "wrong-rounds"
          ? DEFAULT_MAX_ROUNDS
          : fault === "early-end" && phase === "GAME_OVER"
            ? round
            : Math.max(round, maxRounds),
      turnLimitSeconds:
        fault === "missing-limit"
          ? undefined
          : fault === "default-settings" ||
              (fault === "wrong-joiner" && id === 1 && phase === "LOBBY")
            ? DEFAULT_TURN_LIMIT_SECONDS
            : turnLimitSeconds,
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
    const base = {
      ...common,
      ownSettlement: details[id],
      maxNumber: 9 as const,
    };
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
        deadline:
          now +
          (fault === "short-deadline"
            ? DEFAULT_TURN_LIMIT_SECONDS
            : turnLimitSeconds) *
            1000,
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
    else {
      send(ws, frame);
      if (fault === "overlong-replay" && phase === "TURN_ACTIVE")
        send(ws, { ...frame, serverNow: now - 1 });
      if (fault === "replay") send(ws, { ...frame, serverNow: now + 1 });
    }
  }
  function broadcast() {
    revision += 2;
    for (const ws of bound.values()) snapshot(ws);
  }
  function deal() {
    round++;
    phase = "ROUND_START";
    current = fault === "wrong-leader" ? 1 : 0;
    lastAction = null;
    lastPlay = null;
    tableHand = null;
    passes = 0;
    hands = firstDealState.players.flatMap((p) => (p ? [[...p.hand]] : []));
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
        const reject = (code: ErrorCode) => {
          if (code === "DUPLICATE_TILE" && fault === "wrong-error")
            code = "NOT_OWNED";
          if (code === "DUPLICATE_TILE" && fault === "extra-error") {
            send(need(bound.get(2), "missing spectator socket"), {
              type: "ERROR",
              code,
            });
            setTimeout(() => send(ws, { type: "ERROR", code }), 5);
          } else if (
            code === "RESUME_DENIED" &&
            fault === "accepted-token" &&
            phase === "TURN_ACTIVE"
          ) {
            // Inject the wire reply a client would observe if an invalid credential were accepted.
            send(ws, { type: "SEATED", roomCode, seatId: 0, token: token(0) });
          } else send(ws, { type: "ERROR", code });
        };
        const cmd = decodeRequest(
          fault === "accept-name"
            ? withoutKey(raw, "name")
            : fault === "accept-limit"
              ? withoutKey(raw, "turnLimitSeconds")
              : fault === "accept-rounds"
                ? withoutKey(raw, "maxRounds")
                : raw,
        );
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
          if (cmd.type === "CREATE_ROOM") {
            turnLimitSeconds =
              cmd.turnLimitSeconds ?? DEFAULT_TURN_LIMIT_SECONDS;
            maxRounds = cmd.maxRounds ?? DEFAULT_MAX_ROUNDS;
          }
          if (cmd.type !== "RESUME") {
            seats.push(id);
            names[id] =
              fault === "drop-name" && cmd.type === "JOIN_ROOM"
                ? undefined
                : cmd.name;
          } else {
            if (fault === "resume-name") names[id] = undefined;
            if (phase === "GAME_OVER") observations.finalResumes.push(id);
            else observations.activeResumes++;
          }
          if (
            fault === "replaced-settings" &&
            observations.activeResumes === 1
          ) {
            const old = bound.get(id);
            if (old)
              send(old, {
                type: "SNAPSHOT",
                revision,
                serverNow: now,
                view: {
                  ...view(id),
                  turnLimitSeconds: DEFAULT_TURN_LIMIT_SECONDS,
                },
              });
          }
          if (fault === "replaced-notice" && observations.activeResumes === 1) {
            const old = bound.get(id);
            if (old) send(old, { type: "ERROR", code: "NOT_SEATED" });
          }
          if (
            cmd.type === "RESUME" &&
            observations.activeResumes === 2 &&
            phase === "TURN_ACTIVE" &&
            fault === "resume-hand"
          ) {
            const a = hand(id),
              b = hand(1);
            [a[0], b[0]] = [
              need(b[0], "fixture tile"),
              need(a[0], "fixture tile"),
            ];
          }
          if (
            cmd.type === "RESUME" &&
            phase === "GAME_OVER" &&
            fault === "final-table"
          )
            chips.splice(0, 3, 87, 53, 52);
          bound.set(id, ws);
          ws.data.id = id;
          const echoed =
            fault === "resume-token" && observations.activeResumes === 2
              ? "changed-credential"
              : token(id);
          send(ws, { type: "SEATED", roomCode, seatId: id, token: echoed });
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
        if (cmd.type === "LEAVE_ROOM") {
          if (fault === "notify-leaver") {
            revision += 2;
            snapshot(ws);
          }
          bound.delete(id);
          ws.data.id = null;
          if (phase === "LOBBY" && fault !== "keep-leaver")
            seats.splice(seats.indexOf(id), 1);
          if (fault !== (phase === "LOBBY" ? "reuse-token" : "accept-left")) {
            revoked.push(token(id));
            tokens[id] = `protected-credential-reissued-${revoked.length}`;
          }
          // Delay the others so the leaver's frame lands while the probe still expects silence.
          if (fault === "notify-leaver") setTimeout(broadcast, 20);
          else broadcast();
          return;
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
          if (!previous) {
            observations.leads.push(next);
            observations.lowestAtLead.push(
              need(handOrder(hand(id), 9)[0], "empty leading hand"),
            );
          }
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
          const before = [...chips];
          // Synthetic payments isolate phase, conservation and OUT-recipient checks.
          if (
            (fault === "elimination" && round === maxRounds) ||
            fault === "early-elimination"
          )
            chips.splice(0, 3, 140, 52, 0);
          else
            chips.splice(0, 3, 64 + round * 8, 64 - round * 4, 64 - round * 4);
          details = hands.map((h) => {
            const remaining = h.length,
              twos = h.filter((t) => t.number === 2).length;
            return { round, remaining, twos, effective: remaining * 2 ** twos };
          });
          settlement = {
            round,
            results: seats.map((seatId, i) => ({
              seatId,
              rank: i + 1,
              chipChange:
                need(chips[i], "missing chips") -
                need(before[i], "missing prior chips"),
            })),
          };
          if (fault === "chip-total" && round === maxRounds) chips[0] = 89;
          phase = "ROUND_SETTLEMENT";
          broadcast();
          if (
            fault === "endless" ||
            (round < maxRounds && fault !== "early-end" && !chips.includes(0))
          )
            deal();
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
    get tokens() {
      return [...tokens, ...revoked];
    },
    observations,
    stop: () => server.stop(true),
  };
}
