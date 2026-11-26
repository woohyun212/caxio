import { isDeepStrictEqual as equal } from "node:util";
import { handOrder } from "../../apps/web/src/visual/layout";
import type {
  Action,
  SeatId,
} from "../../packages/shared/src/contracts/domain";
import {
  type Command,
  type ErrorCode,
  type Message,
  type PlayerView,
  type Request,
  type Seated,
  type Snapshot,
  WS_PATH,
} from "../../packages/shared/src/contracts/wire";
import {
  checkAction,
  checkDeal,
  checkFinal,
  checkNames,
  checkPublic,
  errorName,
  isPresence,
  judgeFrame,
  need,
  ProbeFailure,
  publicTable,
  requireCheck,
} from "./judges";

export class Client {
  readonly ws: WebSocket;
  credential?: Seated;
  previous?: Snapshot;
  view?: PlayerView;
  queue: Message[] = [];
  ignored = false;
  replacing = false;
  left = false;
  wake?: () => void;
  constructor(
    url: URL,
    readonly room: SocketRoom,
  ) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.wake?.();
    this.ws.onclose = () => {
      if (!this.ignored && !this.replacing)
        room.fail(new ProbeFailure("unexpected socket close"));
    };
    this.ws.onerror = () => {
      if (!this.ignored && !this.replacing)
        room.fail(new ProbeFailure("socket connection failed"));
    };
    this.ws.onmessage = ({ data }) => {
      if (this.ignored || room.failure) return;
      try {
        room.receive(this, data);
      } catch (error) {
        room.fail(error);
      }
    };
  }
  async wait(predicate: () => boolean, label: string, extraMs = 0) {
    const end = Math.min(
      performance.now() + this.room.frameMs + extraMs,
      this.room.end,
    );
    while (!predicate()) {
      this.room.check();
      requireCheck(performance.now() < end, `frame budget exceeded (${label})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, end - performance.now()));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    this.room.check();
  }
  async next<T extends Message["type"]>(
    type: T,
    extraMs = 0,
  ): Promise<Extract<Message, { type: T }>> {
    await this.wait(() => this.queue.length > 0, type, extraMs);
    const m = this.queue.shift();
    requireCheck(
      m?.type === type,
      `expected ${type}, received ${m?.type ?? "nothing"}`,
    );
    if (m.type === "SNAPSHOT")
      this.view =
        this.queue.length === 0 && this.previous ? this.previous.view : m.view;
    return m as Extract<Message, { type: T }>;
  }
  send(command: Request | string) {
    this.ws.send(
      typeof command === "string" ? command : JSON.stringify(command),
    );
  }
  close() {
    this.ignored = true;
    this.ws.close();
  }
}
const codes = [
  "INVALID_MESSAGE",
  "NOT_YOUR_TURN",
  "STALE_TURN",
  "NOT_OWNED",
  "DUPLICATE_TILE",
  "ILLEGAL_HAND",
  "NOT_HIGHER",
] as const;
// Seat 1 stays unnamed; seat 2 takes the widest legal name, then a new one after leaving the lobby.
const joinNames = ["철수", undefined, "가나다라마바"] as const;
const rejoinName = "Bob7";
const naming = (name?: string) => (name === undefined ? {} : { name });
export abstract class SocketRoom {
  abstract receive(client: Client, data: string): void;
  clients: Client[] = [];
  failure?: Error;
  url: URL;
  constructor(
    origin: string,
    readonly frameMs: number,
    readonly end: number,
  ) {
    this.url = new URL(WS_PATH, origin);
    this.url.protocol = this.url.protocol === "https:" ? "wss:" : "ws:";
  }
  fail(error: unknown) {
    this.failure ??=
      error instanceof ProbeFailure
        ? error
        : new ProbeFailure(`socket failure (${errorName(error)})`);
    for (const c of this.clients) c.wake?.();
  }
  check() {
    if (this.failure) throw this.failure;
    requireCheck(performance.now() < this.end, "total budget exceeded");
  }
  idle() {
    this.check();
    requireCheck(
      this.clients.every((c) => c.ignored || !c.queue.length),
      "unexpected unrequested frame",
    );
  }
  async open() {
    const client = new Client(this.url, this);
    this.clients.push(client);
    await client.wait(() => client.ws.readyState === WebSocket.OPEN, "open");
    return client;
  }
  closeAll() {
    this.fail(new ProbeFailure("game finished"));
    for (const client of this.clients) client.close();
  }
}
export class Game extends SocketRoom {
  live: Client[] = [];
  tokens = new Map<SeatId, string>();
  history: [SeatId | null, string][] = [];
  publics = new Map<number, ReturnType<typeof publicTable>>();
  currentCheck = "ws.open";
  connected?: SeatId;
  exercised = new Set<string>();
  names = new Map<SeatId, string | undefined>();
  // Every credential ever issued, revoked ones included; only its own holder may see one.
  issued = new Set<string>();
  constructor(
    origin: string,
    frameMs: number,
    end: number,
    readonly passed: (id: string) => void,
  ) {
    super(origin, frameMs, end);
  }
  receive(client: Client, data: string) {
    const message = judgeFrame(
      data,
      client.credential?.seatId ?? null,
      this.tokens,
      client.previous,
    );
    if (!message) return;
    requireCheck(!client.left, "frame sent to the leaver");
    const own =
      message.type === "SEATED" ? message.token : client.credential?.token;
    for (const token of this.issued)
      requireCheck(
        token === own || !data.includes(token),
        "foreign seat token in frame",
      );
    if (message.type === "SEATED") {
      this.issued.add(message.token);
      if (!this.tokens.has(message.seatId)) {
        requireCheck(
          this.history.every(
            ([seat, raw]) =>
              seat === message.seatId || !raw.includes(message.token),
          ),
          "foreign seat token in earlier frame",
        );
        this.tokens.set(message.seatId, message.token);
      }
      client.credential = message;
    }
    // Once all tokens are known, the inline check covers future frames.
    if (this.tokens.size < 3)
      this.history.push([client.credential?.seatId ?? null, data]);
    else this.history.length = 0;
    if (message.type === "SNAPSHOT") {
      checkPublic(this.publics, message);
      checkNames(message.view, this.names);
      if (this.connected !== undefined)
        requireCheck(
          message.view.slots[this.connected]?.isConnected,
          "replaced socket disconnected live seat",
        );
      const prev = client.previous;
      client.previous = message;
      if (prev && isPresence(prev.view, message.view)) {
        // Consume presence in wire order even when game transitions are already queued.
        if (client.queue.length === 0 && client.view)
          client.view = message.view;
        return;
      }
    }
    client.queue.push(message);
    client.wake?.();
  }
  async seat(client: Client, cmd: Command, expected?: Seated) {
    this.idle();
    client.send(cmd);
    const seated = await client.next("SEATED");
    if (expected)
      requireCheck(equal(seated, expected), "resume credential mismatch");
    return (await client.next("SNAPSHOT")).view;
  }
  async lobby() {
    let code = "";
    for (let i = 0; i < 3; i++) {
      const c = await this.open();
      if (i === 0) {
        this.passed("ws.open");
        this.currentCheck = "ws.game";
        await this.reject(c, "NOT_SEATED", { type: "LEAVE_ROOM" });
        await this.reject(
          c,
          "INVALID_MESSAGE",
          { type: "CREATE_ROOM", name: "가나다라마바사" },
          "name.CREATE_ROOM",
        );
      }
      if (i === 1)
        await this.reject(
          c,
          "INVALID_MESSAGE",
          { type: "JOIN_ROOM", roomCode: code, name: "Bob!" },
          "name.JOIN_ROOM",
        );
      this.idle();
      const old = [...this.live];
      const name = joinNames[i];
      await Promise.all([
        this.seat(
          c,
          i === 0
            ? { type: "CREATE_ROOM", ...naming(name) }
            : { type: "JOIN_ROOM", roomCode: code, ...naming(name) },
        ),
        ...old.map((p) => p.next("SNAPSHOT")),
      ]);
      this.live.push(c);
      const cred = need(c.credential, "missing seat");
      requireCheck(!i || code === cred.roomCode, "joined wrong room");
      code = cred.roomCode;
      this.names.set(cred.seatId, name);
      for (const p of this.live) checkNames(this.state(p), this.names);
      const seats = this.live.map(
        (p) => need(p.credential, "missing seat").seatId,
      );
      requireCheck(
        new Set(seats).size === seats.length &&
          this.live.every(
            (p) => p.view?.phase === "LOBBY" && equal(p.view.seatOrder, seats),
          ),
        "unexpected lobby transition",
      );
    }
    await this.leaveLobby(code);
    this.idle();
    need(
      this.live.find((c) => c.view?.phase === "LOBBY" && c.view.canStart),
      "missing ready host",
    ).send({ type: "START_GAME" });
    await this.snapshots();
  }
  // Until forget(), the leaver may only receive replays of revisions it already saw.
  leave(c: Client) {
    this.idle();
    c.left = true;
    c.send({ type: "LEAVE_ROOM" });
    return need(c.credential, "missing leaving seat");
  }
  forget(c: Client) {
    c.left = false;
    c.credential = undefined;
    c.previous = undefined;
    c.view = undefined;
  }
  async departed(seat: SeatId) {
    await Promise.all(
      this.live.map((p) =>
        p.wait(
          () =>
            p.queue.length > 0 || p.view?.slots[seat]?.isConnected === false,
          "leave broadcast",
        ),
      ),
    );
  }
  async leaveLobby(code: string) {
    this.currentCheck = "leave.lobby";
    const c = need(this.live.pop(), "missing leaving seat");
    const old = this.leave(c);
    this.names.delete(old.seatId);
    await this.departed(old.seatId);
    requireCheck(
      this.live.every((p) => p.queue.length > 0),
      "left seat not vacated",
    );
    await this.snapshots();
    const remaining = this.live.map((p) => this.id(p));
    for (const p of this.live) {
      const v = this.state(p);
      requireCheck(
        v.phase === "LOBBY" &&
          equal(v.seatOrder, remaining) &&
          v.slots[old.seatId] === null,
        "left seat not vacated",
      );
    }
    this.idle();
    this.forget(c);
    await this.reject(
      c,
      "RESUME_DENIED",
      { type: "RESUME", roomCode: code, token: old.token },
      "RESUME_DENIED.lobby",
    );
    const others = [...this.live];
    await Promise.all([
      this.seat(c, { type: "JOIN_ROOM", roomCode: code, name: rejoinName }),
      ...others.map((p) => p.next("SNAPSHOT")),
    ]);
    const cred = need(c.credential, "missing rejoined seat");
    requireCheck(
      cred.roomCode === code && cred.token !== old.token,
      "rejoin reused the revoked credential",
    );
    this.live.push(c);
    this.names.set(cred.seatId, rejoinName);
    const order = this.live.map((p) => this.id(p));
    for (const p of this.live) {
      const v = this.state(p);
      requireCheck(
        v.phase === "LOBBY" && equal(v.seatOrder, order),
        "unexpected rejoin lobby",
      );
      checkNames(v, this.names);
    }
    this.idle();
    this.passed("leave.lobby");
    this.currentCheck = "ws.game";
  }
  // Leaving GAME_OVER only disconnects the seat; its name stays (checked on every SNAPSHOT).
  async leaveFinal(code: string) {
    this.currentCheck = "leave.final";
    this.connected = undefined; // that seat may be the one leaving now
    const c = need(this.live.pop(), "missing leaving seat");
    const old = this.leave(c);
    await this.departed(old.seatId);
    for (const p of this.live) {
      requireCheck(
        !p.queue.length,
        "GAME_OVER leave changed more than presence",
      );
      checkFinal(this.state(p));
    }
    this.idle();
    this.forget(c);
    await this.reject(
      c,
      "RESUME_DENIED",
      { type: "RESUME", roomCode: code, token: old.token },
      "RESUME_DENIED.final",
    );
    this.passed("leave.final");
  }
  async snapshots() {
    await Promise.all(this.live.map((c) => c.next("SNAPSHOT")));
  }
  id(c: Client) {
    return need(c.credential, "missing credential").seatId;
  }
  state(c: Client) {
    return need(c.view, "missing current view");
  }
  async reject(
    c: Client,
    code: ErrorCode,
    command: Request | string,
    id: string = code,
  ) {
    if (this.exercised.has(id)) return;
    this.idle();
    const enclosing = this.currentCheck;
    this.currentCheck = `reject.${id}`;
    c.send(command);
    const error = await c.next("ERROR");
    requireCheck(error.code === code, `expected ERROR(${code})`);
    this.idle();
    this.exercised.add(id);
    this.passed(this.currentCheck);
    this.currentCheck = enclosing;
  }
  async resume(c: Client, action: Action & { turnId: number }) {
    const cred = need(c.credential, "missing resume credential");
    const before = this.state(c);
    const cmd = {
      type: "RESUME",
      roomCode: cred.roomCode,
      token: cred.token,
    } as const;
    const lost = await this.open();
    this.idle();
    c.ignored = true;
    lost.send(cmd);
    lost.close();
    const replacement = await this.open();
    const view = await this.seat(replacement, cmd, cred);
    requireCheck(
      view.phase === "TURN_ACTIVE" && isPresence(before, view),
      "resume changed active turn or hand",
    );
    this.idle();
    this.live[this.live.indexOf(c)] = replacement;
    const second = need(
      handOrder(need(view.ownHand, "missing resumed hand"), view.maxNumber)[1],
      "missing second tile",
    );
    if (c.ws.readyState === WebSocket.OPEN)
      c.send({ type: "PLAY", turnId: action.turnId, tiles: [second] });
    return { replacement, old: c };
  }
  async run() {
    try {
      await this.lobby();
      requireCheck(
        this.live.every((c) => this.state(c).phase === "ROUND_START"),
        "missing first ROUND_START",
      );
      let lastTurn = 0,
        round = 0,
        resumed = false;
      while (true) {
        this.check();
        const view = this.state(need(this.live[0], "missing client"));
        if (view.phase === "ROUND_START") {
          requireCheck(view.round === round + 1, "unexpected round");
          checkDeal(new Map(this.live.map((c) => [this.id(c), this.state(c)])));
          round = view.round;
          const before = this.live.map((c) => this.state(c));
          await this.snapshots();
          for (const [i, c] of this.live.entries()) {
            const v = this.state(c);
            requireCheck(
              v.phase === "TURN_ACTIVE" &&
                isPresence(
                  { ...v, phase: "ROUND_START", deadline: null, turnId: null },
                  need(before[i], "missing deal"),
                ),
              "unexpected opening turn",
            );
          }
          continue;
        }
        if (view.phase === "GAME_OVER") break;
        requireCheck(
          view.phase === "TURN_ACTIVE" &&
            view.round === round &&
            view.turnId > lastTurn,
          "expected new active turn",
        );
        lastTurn = view.turnId;
        let actor = need(
          this.live.find((c) => this.id(c) === view.currentTurn),
          "missing actor",
        );
        const hand = handOrder(
          need(this.state(actor).ownHand, "missing acting hand"),
          view.maxNumber,
        );
        const lowest = need(hand[0], "empty acting hand");
        const turnId = view.turnId;
        const action: Action & { turnId: number } = view.tableHand
          ? { type: "PASS", turnId }
          : { type: "PLAY", turnId, tiles: [lowest] };
        let old: Client | undefined;
        if (round === 1) {
          const other = need(
            this.live.find((c) => c !== actor),
            "missing other seat",
          );
          const foreign = need(
            handOrder(
              need(this.state(other).ownHand, "missing other hand"),
              view.maxNumber,
            )[0],
            "empty other hand",
          );
          await this.reject(actor, "INVALID_MESSAGE", "invalid JSON");
          await this.reject(other, "NOT_YOUR_TURN", {
            type: "PLAY",
            turnId,
            tiles: [foreign],
          });
          if (turnId >= 2)
            await this.reject(actor, "STALE_TURN", {
              ...action,
              turnId: turnId - 1,
            });
          await this.reject(actor, "NOT_OWNED", {
            type: "PLAY",
            turnId,
            tiles: [foreign],
          });
          await this.reject(actor, "DUPLICATE_TILE", {
            type: "PLAY",
            turnId,
            tiles: [lowest, lowest],
          });
          const different = hand.find((t) => t.number !== lowest.number);
          if (!view.tableHand && different)
            await this.reject(actor, "ILLEGAL_HAND", {
              type: "PLAY",
              turnId,
              tiles: [lowest, different],
            });
          const table = view.tableHand?.[0];
          if (table && handOrder([lowest, table], view.maxNumber)[0] === lowest)
            await this.reject(actor, "NOT_HIGHER", {
              type: "PLAY",
              turnId,
              tiles: [lowest],
            });
          if (!resumed && !table) {
            this.currentCheck = "resume.active";
            const retry = await this.resume(actor, action);
            old = retry.old;
            actor = retry.replacement;
            resumed = true;
          }
        }
        this.idle();
        const before = this.live.map((c) => this.state(c));
        requireCheck(
          before.every(
            (v) =>
              v.currentTurn === this.id(actor) && v.turnId === action.turnId,
          ),
          "active seats disagree on command",
        );
        actor.send(action);
        await this.snapshots();
        for (const [i, c] of this.live.entries())
          checkAction(
            need(before[i], "missing prior turn"),
            this.state(c),
            this.id(c),
            action,
          );
        if (old) {
          this.connected = this.id(actor);
          old.close();
          const invalid = await this.open();
          const cred = need(actor.credential, "missing credential");
          let wrong = crypto.randomUUID() as string;
          while ([...this.tokens.values()].includes(wrong)) wrong += "!";
          await this.reject(invalid, "RESUME_DENIED", {
            type: "RESUME",
            roomCode: cred.roomCode,
            token: wrong,
          });
          invalid.close();
          this.passed("resume.active");
          this.currentCheck = "ws.game";
        }
        if (this.state(actor).phase === "ROUND_SETTLEMENT") {
          const settlement = this.state(actor);
          const end =
            settlement.round === settlement.maxRounds ||
            settlement.activePlayers.length < 3;
          const paid = this.live.map((c) => this.state(c));
          await this.snapshots();
          for (const [i, c] of this.live.entries()) {
            const next = this.state(c),
              prior = need(paid[i], "missing settlement");
            requireCheck(
              next.phase === (end ? "GAME_OVER" : "ROUND_START") &&
                equal(next.ownSettlement, prior.ownSettlement) &&
                equal(next.lastSettlement, prior.lastSettlement),
              "unexpected settlement successor",
            );
            if (next.phase === "GAME_OVER")
              requireCheck(
                isPresence(
                  { ...next, phase: "ROUND_SETTLEMENT", ranking: [] },
                  prior,
                ),
                "final state differs from settlement",
              );
          }
        }
      }
      this.currentCheck = "game.final";
      for (const c of this.live) checkFinal(this.state(c));
      for (const code of codes) {
        if (!this.exercised.has(code)) {
          this.currentCheck = `reject.${code}`;
          throw new ProbeFailure(`unexercised ${code}`);
        }
      }
      this.passed("game.final");
      this.currentCheck = "resume.final";
      for (const [i, c] of this.live.entries()) {
        this.idle();
        const final = this.state(c),
          cred = need(c.credential, "missing credential");
        const fresh = await this.open();
        c.replacing = true;
        const view = await this.seat(
          fresh,
          { type: "RESUME", roomCode: cred.roomCode, token: cred.token },
          cred,
        );
        checkFinal(view);
        requireCheck(
          equal(publicTable(final), publicTable(view)),
          "final resume public table mismatch",
        );
        this.idle();
        c.close();
        this.live[i] = fresh;
      }
      this.idle();
      this.passed("resume.final");
      await this.leaveFinal(
        need(this.live[0]?.credential, "missing room").roomCode,
      );
    } finally {
      this.closeAll();
    }
  }
}
