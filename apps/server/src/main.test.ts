import { expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { rules } from "@caxio/shared";
import type { Action, GameState, SeatId } from "@caxio/shared/contracts/domain";
import {
  epoch,
  turnErrorExamples,
  turnValidationOrder,
} from "@caxio/shared/contracts/fixtures";
import type { RoomSettings } from "@caxio/shared/contracts/settings";
import {
  decodeCommand,
  decodeServerMessage,
  type ErrorCode,
  isRoomCode,
  type Message,
  type Seated,
  type Snapshot,
  WS_PATH,
} from "@caxio/shared/contracts/wire";
import { DEFAULT_TURN_LIMIT_MS } from "./contracts";
import { abandonmentShuffle } from "./fixtures/abandonment-shuffle";
import actions from "./fixtures/four-player-actions.json";
import { makeRandom, seed } from "./fixtures/four-player-seed";
import {
  abandonmentRestart,
  deadlines,
  lostResume,
  seatReuse,
  spectatorExamples,
} from "./fixtures/server-snapshots";
import { startGameServer } from "./main";

function need<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing test value");
  return value;
}

class Client {
  readonly ws: WebSocket;
  credential?: Seated;
  readonly reader;
  invalidFrame = false;
  readonly opened: Promise<void>;
  readonly closed: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(new URL(WS_PATH, url.replace(/^http/, "ws")));
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(Error("WebSocket open failed"));
    });
    this.closed = new Promise((resolve) =>
      this.ws.addEventListener("close", () => resolve(), { once: true }),
    );
    this.reader = new ReadableStream<Message>({
      start: (controller) => {
        this.ws.onmessage = ({ data }) => {
          const message = decodeServerMessage(
            data,
            this.credential?.seatId ?? null,
          );
          if (message === "INVALID_MESSAGE") {
            this.invalidFrame = true;
            controller.error(Error("Invalid server frame"));
            return;
          }
          if (message.type === "SEATED") this.credential = message;
          controller.enqueue(message);
        };
        this.ws.onclose = () => controller.close();
      },
    }).getReader();
  }
  send(command: unknown) {
    this.ws.send(
      command instanceof Uint8Array || typeof command === "string"
        ? command
        : JSON.stringify(command),
    );
  }
  async next() {
    return need((await this.reader.read()).value);
  }
  async snapshot() {
    const frame = await this.next();
    if (frame.type !== "SNAPSHOT")
      throw Error(`Expected SNAPSHOT, received ${JSON.stringify(frame)}`);
    return frame;
  }
  async bind(cmd: unknown) {
    this.send(cmd);
    const frame = await this.next();
    if (frame.type !== "SEATED") throw Error("Expected SEATED");
    return this.snapshot();
  }
  async reject(command: unknown, code: ErrorCode) {
    this.send(command);
    expect(await this.next()).toEqual({ type: "ERROR", code });
  }
}

class Table {
  readonly server: ReturnType<typeof startGameServer>;
  sockets: Client[] = [];
  seats: Client[] = [];
  constructor(options: Partial<Parameters<typeof startGameServer>[0]>) {
    this.server = startGameServer({
      port: 0,
      staticRoot: ".",
      random: makeRandom(seed),
      ...options,
    });
  }
  async open() {
    const c = new Client(this.server.url);
    this.sockets.push(c);
    await c.opened;
    return c;
  }
  async lobby(count: number, settings: RoomSettings = {}) {
    for (let i = 0; i < count; i++) {
      const c = await this.open();
      const cmd =
        i === 0
          ? { type: "CREATE_ROOM", ...settings }
          : {
              type: "JOIN_ROOM",
              roomCode: need(this.seats[0]?.credential).roomCode,
            };
      const [frame] = await Promise.all([
        c.bind(cmd),
        ...this.seats.map((p) => p.snapshot()),
      ]);
      expect(frame.revision).toBe(i + 1);
      expect(i).toBe(need(c.credential).seatId);
      this.seats.push(c);
    }
    expect(new Set(this.seats.map((c) => c.credential?.token)).size).toBe(
      count,
    );
  }
  async snapshots() {
    return Promise.all(this.seats.map((c) => c.snapshot()));
  }
  async start() {
    need(this.seats[0]).send({ type: "START_GAME" });
    for (const f of await this.snapshots())
      expect(f.view.phase).toBe("ROUND_START");
    return this.snapshots();
  }
  async replace(seat: SeatId) {
    const old = need(this.seats[seat]),
      cred = need(old.credential);
    const c = await this.open();
    const frame = await c.bind({
      type: "RESUME",
      token: cred.token,
      roomCode: cred.roomCode,
    });
    expect(c.credential).toEqual(cred);
    this.seats[seat] = c;
    return { old, frame };
  }
}

async function atTable(
  options: Partial<Parameters<typeof startGameServer>[0]>,
  run: (table: Table) => Promise<void>,
) {
  const table = new Table(options);
  const shutdown = () => {
    for (const c of table.sockets) c.ws.close();
  };
  const timeout = setTimeout(shutdown, 4000);
  try {
    await run(table);
  } finally {
    clearTimeout(timeout);
    shutdown();
    await table.server.stop();
    await Promise.all(table.sockets.map((c) => c.closed));
    expect(table.sockets.some((c) => c.invalidFrame)).toBe(false);
  }
}
function clock() {
  const timers: { delay: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    time: epoch,
    timers,
    get callbacks() {
      return timers.map((timer) => timer.fire);
    },
    schedule(delay: number, fire: () => void) {
      const timer = { delay, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
}

// Fisher–Yates identity except the cloud 9 / star 1 swap in firstDealState.
function fixtureShuffle() {
  let end = 35;
  return () => (end-- === 32 ? 1.5 / 33 : 0.999999);
}

for (const timerFirst of [false, true]) {
  for (const example of deadlines.cases) {
    test(`A6 deadline ${example.now - need(deadlines.before.view.deadline)}ms, ${timerFirst ? "timer" : "request"} first`, async () => {
      const fake = clock();
      await atTable(
        {
          now: () => fake.time,
          schedule: fake.schedule,
          random: fixtureShuffle(),
        },
        async (table) => {
          await table.lobby(3);
          const [frame] = await table.start();
          expect(frame).toEqual({ ...deadlines.before, serverNow: epoch });
          const timer = need(fake.callbacks.at(-1)),
            host = need(table.seats[0]);
          fake.time = example.now;
          if (timerFirst) timer();
          host.send(example.command);
          const next = await table.snapshots();
          expect(next[0]).toEqual(example.after);
          if (!timerFirst) timer();
          if (example.reply)
            expect(await host.next()).toEqual(
              timerFirst ? deadlines.stale.reply : example.reply,
            );
          // A response on each socket fences any queued second approval.
          await Promise.all(
            table.seats.map((c) => c.reject("?", "INVALID_MESSAGE")),
          );
          const resumed = await table.replace(0);
          expect(resumed.frame).toEqual(example.after);
          fake.time = need(example.after.view.deadline);
          need(fake.callbacks.at(-1))();
          for (const f of await table.snapshots())
            expect(f.view.lastAction).toEqual({
              type: "PASS",
              seatId: 1,
              turnId: 2,
              automatic: true,
            });
        },
      );
    });
  }
}

test("five sockets expire 15-second turns and finish round three with three survivors", async () => {
  const fake = clock();
  const settings = { turnLimitSeconds: 15, maxRounds: 3 } as const;
  await atTable(
    { now: () => fake.time, schedule: fake.schedule, random: makeRandom(1) },
    async (table) => {
      const invalid = await table.open();
      await invalid.reject(
        { type: "CREATE_ROOM", maxRounds: 4 },
        "INVALID_MESSAGE",
      );
      await table.lobby(5, settings);
      let frames = await table.start();
      for (;;) {
        const first = need(frames[0]);
        for (const frame of frames) {
          expect(frame.view).toMatchObject({
            ...settings,
            phase: first.view.phase,
          });
        }
        if (first.view.phase === "GAME_OVER") {
          for (const frame of frames) {
            expect(frame.view.round).toBe(3);
            expect(frame.view.activePlayers.length).toBeGreaterThanOrEqual(3);
          }
          return;
        }
        if (first.view.phase === "TURN_ACTIVE") {
          for (const frame of frames)
            expect(frame.view.deadline).toBe(frame.serverNow + 15000);
          fake.time = need(first.view.deadline);
          need(fake.timers.at(-1)).fire();
        }
        frames = await table.snapshots();
        if (first.view.phase === "TURN_ACTIVE") {
          for (const frame of frames) {
            expect(frame.serverNow).toBe(fake.time);
            expect(frame.view.lastAction).toMatchObject({
              turnId: first.view.turnId,
              automatic: true,
            });
          }
        }
      }
    },
  );
});

test("A6 five-minute turn limit reaches every seat and expires at the configured deadline", async () => {
  const fake = clock();
  const turnTimeoutMs = 300_000;
  await atTable(
    { now: () => fake.time, schedule: fake.schedule, turnTimeoutMs },
    async (table) => {
      await table.lobby(3);
      const opening = await table.start();
      for (const frame of opening) {
        expect(frame.view.phase).toBe("TURN_ACTIVE");
        expect(frame.view.deadline).toBe(frame.serverNow + turnTimeoutMs);
      }
      const first = need(opening[0]);
      fake.time = first.serverNow + DEFAULT_TURN_LIMIT_MS;
      need(fake.callbacks.at(-1))();
      expect((await table.replace(0)).frame).toEqual({
        ...first,
        serverNow: fake.time,
      });

      fake.time = need(first.view.deadline);
      need(fake.callbacks.at(-1))();
      for (const frame of await table.snapshots()) {
        expect(frame.serverNow).toBe(fake.time);
        expect(frame.revision).toBe(first.revision + 1);
        expect(frame.view.lastAction).toEqual({
          type: "PLAY",
          seatId: need(first.view.currentTurn),
          turnId: need(first.view.turnId),
          automatic: true,
        });
      }
    },
  );
});

test("A6 frozen validation precedence, binary and extra-key tile preserve state and revision", async () => {
  const fake = clock();
  await atTable(
    { random: fixtureShuffle(), now: () => fake.time, schedule: fake.schedule },
    async (table) => {
      await table.lobby(3);
      const [before] = await table.start();
      expect(before?.view).toEqual(deadlines.before.view);
      const host = need(table.seats[0]),
        guest = need(table.seats[1]);
      const checked = new Set<string>();
      for (const e of turnErrorExamples.filter(
        (e) => e.before.view.turnId === 1 && e.reply.code !== "TIME_EXPIRED",
      )) {
        await need(table.seats[e.recipient]).reject(e.command, e.reply.code);
        checked.add(e.reply.code);
      }
      await host.reject("invalid", "INVALID_MESSAGE");
      await host.reject(new Uint8Array([123, 125]), "INVALID_MESSAGE");
      await host.reject(
        { type: "PLAY", turnId: 1, tiles: [{ number: 3, suit: 0, rank: 99 }] },
        "INVALID_MESSAGE",
      );
      expect((await table.replace(0)).frame).toEqual(need(before));
      need(table.seats[0]).send({
        type: "PLAY",
        turnId: 1,
        tiles: [{ number: 9, suit: 0 }],
      });
      const following = await table.snapshots();
      expect(following[0]?.revision).toBe(need(before).revision + 1);
      for (const e of turnErrorExamples.filter((e) =>
        ["STALE_TURN", "ILLEGAL_HAND", "WRONG_COUNT", "NOT_HIGHER"].includes(
          e.reply.code,
        ),
      )) {
        await need(table.seats[e.recipient]).reject(
          e.reply.code === "NOT_HIGHER"
            ? { ...e.command, turnId: 2 }
            : e.command,
          e.reply.code,
        );
        checked.add(e.reply.code);
      }
      expect((await table.replace(1)).frame).toEqual(need(following[1]));
      await guest.reject({ type: "PASS", turnId: 2 }, "NOT_SEATED");
      need(table.seats[1]).send({ type: "PASS", turnId: 2 });
      await table.snapshots();
      const higher = [{ number: 1, suit: 1 }] as const;
      need(table.seats[2]).send({ type: "PLAY", turnId: 3, tiles: higher });
      for (const f of await table.snapshots())
        expect(f.view.lastPlay?.tiles).toEqual(higher);
      expect(
        turnValidationOrder
          .filter((code) => code !== "TIME_EXPIRED")
          .every((code) => checked.has(code)),
      ).toBe(true);
    },
  );
});

test("A7 lobby reservations revoke credentials, preserve join order and guard START", async () => {
  const fake = clock();
  let draws = 0;
  const random = fixtureShuffle();
  await atTable(
    {
      now: () => fake.time,
      schedule: fake.schedule,
      random: () => {
        draws++;
        return random();
      },
    },
    async (table) => {
      await table.lobby(1);
      const host = need(table.seats[0]),
        code = need(host.credential).roomCode;
      await host.reject({ type: "START_GAME" }, "NOT_READY");
      const room2 = await table.open();
      await room2.bind({ type: "CREATE_ROOM" });
      expect(isRoomCode(code)).toBe(true);
      expect(isRoomCode(room2.credential?.roomCode)).toBe(true);
      expect(room2.credential?.roomCode).not.toBe(code);
      for (const c of [host, room2])
        expect(c.credential?.token).toMatch(
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
      expect(room2.credential?.token).not.toBe(host.credential?.token);
      for (const fixture of seatReuse.joins.slice(1)) {
        const c = await table.open();
        await c.bind({ type: "JOIN_ROOM", roomCode: code });
        expect((await table.snapshots())[0]?.view).toEqual(fixture.view);
        table.seats.push(c);
      }
      const release = async (
        c: Client,
        offline: Snapshot,
        released: Snapshot,
      ) => {
        table.seats = table.seats.filter((p) => p !== c);
        fake.time = offline.serverNow;
        c.ws.close();
        expect((await table.snapshots())[0]).toEqual(offline);
        if (c !== host)
          await host.reject(
            seatReuse.reservedStart.request,
            seatReuse.reservedStart.reply.code,
          );
        fake.time = released.serverNow;
        need(fake.callbacks.at(-1))();
        expect((await table.snapshots())[0]).toEqual(released);
      };
      const b = need(table.seats[1]);
      await release(b, seatReuse.bDisconnected, seatReuse.bReturned);
      const e = await table.open();
      fake.time = seatReuse.eJoined.serverNow;
      await e.bind({ type: "JOIN_ROOM", roomCode: code });
      expect((await table.snapshots())[0]).toEqual(seatReuse.eJoined);
      table.seats.push(e);
      await release(host, seatReuse.aDisconnected, seatReuse.aReturned);
      const revoked = await table.open();
      for (const c of [host, b])
        await revoked.reject(
          { type: "RESUME", roomCode: code, token: need(c.credential).token },
          lostResume.returned.reply.code,
        );
      for (const c of table.seats.slice(1))
        await c.reject(seatReuse.startCommand, "NOT_HOST");
      expect(draws).toBe(0);
      fake.time = need(seatReuse.started[0]).frame.serverNow;
      need(table.seats[0]).send(seatReuse.startCommand);
      for (const [i, f] of (await table.snapshots()).entries())
        expect(f).toEqual(need(seatReuse.started[i]).frame);
      await table.snapshots();
      expect(draws).toBe(35);
    },
  );
});

test("A7 lost SEATED retry restores private hand; close and resume never extend the deadline", async () => {
  const fake = clock();
  await atTable(
    { now: () => fake.time, schedule: fake.schedule, random: fixtureShuffle() },
    async (table) => {
      await table.lobby(3);
      const frames = await table.start();
      const seat = lostResume.recipient,
        original = need(table.seats[seat]),
        cred = need(original.credential);
      const cmd = {
        ...lostResume.retry,
        roomCode: cred.roomCode,
        token: cred.token,
      };
      // Discard the binding response before the application reads or saves the credential.
      const lost = await table.open();
      const before = need(frames[seat]);
      lost.ws.addEventListener("message", () => lost.ws.close(), {
        once: true,
      });
      fake.time += 100;
      lost.send(cmd);
      await lost.closed;
      const peers = table.seats.filter((c) => c !== original);
      for (const f of await Promise.all(peers.map((c) => c.snapshot()))) {
        expect(f.revision).toBe(before.revision + 1);
        expect(f.view.deadline).toBe(before.view.deadline);
        expect(f.view.slots[seat]?.isConnected).toBe(false);
      }
      const fresh = await table.open();
      const restored = await fresh.bind(cmd);
      expect(restored.view).toEqual(need(frames[seat]).view);
      expect(restored.revision).toBe(before.revision + 2);
      for (const p of peers)
        expect((await p.snapshot()).view.deadline).toBe(before.view.deadline);
      await original.reject(lostResume.replaced.command, "NOT_SEATED");
      original.ws.close();
      await original.closed;
      await Promise.all(peers.map((c) => c.reject("?", "INVALID_MESSAGE")));
    },
  );
});

function checkGame(frames: Snapshot[], state: GameState, revision: number) {
  for (const [i, f] of frames.entries()) {
    const id = need(state.seatOrder[i]),
      player = need(state.players[id]),
      settlement = state.lastSettlement;
    expect(f.revision).toBe(revision);
    expect(Number.isSafeInteger(f.serverNow)).toBe(true);
    expect(f.view).toMatchObject({
      phase: state.phase,
      round: state.round,
      maxNumber: state.maxNumber,
      activePlayers: state.activePlayers,
      currentTurn: state.currentTurn,
      tableHand: state.tableHand,
      lastAction: state.lastAction,
      lastPlay: state.lastPlay,
      ranking: state.ranking,
      lastSettlement: settlement
        ? { round: settlement.round, results: settlement.results }
        : null,
    });
    if (f.view.phase === "TURN_ACTIVE")
      expect(Number.isSafeInteger(f.view.deadline)).toBe(true);
    expect(Object.hasOwn(f.view, "ownHand")).toBe(!player.isOut);
    expect(f.view.ownHand).toEqual(player.isOut ? undefined : player.hand);
    const detail = player.isOut ? undefined : settlement?.details[id];
    expect(Object.hasOwn(f.view, "ownSettlement")).toBe(Boolean(detail));
    expect(f.view.ownSettlement).toEqual(detail ?? undefined);
    expect([...f.view.slots]).toEqual(
      state.players.map(
        (p) =>
          p && {
            chips: p.chips,
            isOut: p.isOut,
            remainingTileCount: p.hand.length,
            isConnected: true,
          },
      ),
    );
  }
}

async function replay(
  table: Table,
  seats: readonly SeatId[],
  gameSeed: number,
  fake?: ReturnType<typeof clock>,
  closeFirst = false,
) {
  const rng = makeRandom(gameSeed);
  let state = rules.startRound(seats, rng),
    revision = seats.length,
    index = 0;
  await table.lobby(seats.length);
  need(table.seats[0]).send({ type: "START_GAME" });
  let firstTimer: (() => void) | undefined;
  let afterApproval: (() => Promise<void>) | undefined;
  for (;;) {
    const frames = await table.snapshots();
    checkGame(frames, state, ++revision);
    if (afterApproval) {
      await afterApproval();
      afterApproval = undefined;
    }
    if (state.phase === "GAME_OVER") {
      if (fake) {
        expect(index).toBe(actions.length);
        expect(frames[3]?.view.phase).toBe(
          spectatorExamples.gameOver.view.phase,
        );
        const restored = await table.replace(3);
        expect(restored.frame.view).toEqual(need(frames[3]).view);
      }
      return state;
    }
    if (state.phase === "ROUND_SETTLEMENT" || state.phase === "ROUND_START") {
      if (fake && state.round === 1 && state.phase === "ROUND_SETTLEMENT") {
        expect(index).toBe(actions.length);
        expect(state.activePlayers).toEqual(
          spectatorExamples.transition.view.activePlayers,
        );
      }
      if (state.phase === "ROUND_START") {
        expect(state.lastPlay).toBeNull();
        expect(state.players[need(state.currentTurn)]?.hand).toContainEqual({
          number: 3,
          suit: 0,
        });
        if (fake && state.round === 2) {
          expect(state.maxNumber).toBe(
            spectatorExamples.following.view.maxNumber,
          );
          expect(state.players.map((p) => p?.hand.length)).toEqual([
            12,
            12,
            12,
            0,
            undefined,
          ]);
        }
      }
      state = rules.advance(state, rng);
      continue;
    }
    const seat = need(state.currentTurn);
    if (fake) {
      firstTimer ??= need(fake.callbacks[0]);
      fake.time += 100;
      if (state.round === 2 && !state.lastAction) {
        const { old, frame } = await table.replace(3);
        expect(frame.view).toEqual(need(frames[3]).view);
        const survivor = await table.replace(seat);
        expect(survivor.frame.view.ownSettlement).toEqual(
          need(need(state.lastSettlement).details[seat]),
        );
        // The old callback is due, while the current round still has a legal manual turn.
        fake.time = need(frame.view.deadline) - 1;
        const stale = firstTimer;
        const closeOld = async () => {
          old.ws.close();
          await old.closed;
        };
        if (closeFirst) {
          await closeOld();
          afterApproval = async () => stale();
        } else {
          stale();
          afterApproval = closeOld;
        }
      }
    }
    let action: Action = rules.timeoutAction(state);
    if (fake && state.round === 1) {
      const { seatId, ...manual } = need(actions[index++]);
      expect(seatId).toBe(seat);
      expect(Object.hasOwn(manual, "turnId")).toBe(false);
      const cmd = decodeCommand(
        JSON.stringify({ ...manual, turnId: state.turnId }),
      );
      if (
        cmd === "INVALID_MESSAGE" ||
        !(cmd.type === "PASS" || cmd.type === "PLAY")
      )
        throw Error("Invalid action file");
      action = cmd;
    }
    need(table.seats[seat]).send({ ...action, turnId: state.turnId });
    const result = rules.applyTurn(state, seat, action);
    if (!result.ok) throw Error(result.code);
    state = result.state;
    expect(state.lastAction?.automatic).toBe(false);
  }
}

test("A7 three seeded sockets play from lobby to final ranking", async () => {
  await atTable({ random: makeRandom(7) }, async (table) => {
    const final = await replay(table, [0, 1, 2], 7);
    expect(final.round).toBe(2);
    expect(rules.isGameOver(final)).toBe("FEWER_THAN_THREE");
    expect(final.ranking.map((row) => row.seatId)).toEqual([2, 0, 1]);
  });
});

for (const closeFirst of [true, false]) {
  test(`A7 four seeded sockets, spectator resume and final; stale ${closeFirst ? "close" : "timer"} first`, async () => {
    const fake = clock();
    await atTable(
      {
        random: makeRandom(seed),
        schedule: fake.schedule,
        now: () => fake.time,
      },
      async (table) => {
        await replay(table, [0, 1, 2, 3], seed, fake, closeFirst);
      },
    );
  });
}

async function withFailedTurnTimer(
  check: (
    table: Table,
    before: Snapshot,
    fake: ReturnType<typeof clock>,
    fireWithClockFault: () => void,
  ) => Promise<void>,
) {
  const fake = clock();
  const failure = Error("turn clock failed");
  const report = spyOn(console, "error").mockImplementation(() => {});
  let fault = false;
  let throws = 0;
  function fireWithClockFault() {
    fault = true;
    need(fake.timers.at(-1)).fire();
    throws++;
    expect(report.mock.calls).toHaveLength(throws);
    expect(report.mock.calls.at(-1)?.[1]).toBe(failure);
  }
  try {
    await atTable(
      {
        now() {
          if (fault) {
            fault = false;
            throw failure;
          }
          return fake.time;
        },
        schedule: fake.schedule,
      },
      async (table) => {
        await table.lobby(3);
        const opening = await table.start();
        const before = need(opening[0]);
        const observer = before.view.currentTurn === 0 ? 1 : 0;
        fake.time = need(before.view.deadline);
        expect(fake.timers).toHaveLength(1);
        fireWithClockFault();
        expect(fake.timers.map((timer) => timer.delay)).toEqual([
          DEFAULT_TURN_LIMIT_MS,
          1000,
        ]);
        // Ordered replies on every socket expose any snapshot sent by the failed attempt.
        await Promise.all(
          table.seats.map((c) => c.reject("?", "INVALID_MESSAGE")),
        );
        expect((await table.replace(observer)).frame).toEqual({
          ...need(opening[observer]),
          serverNow: fake.time,
        });
        await check(table, before, fake, fireWithClockFault);
        expect(report.mock.calls).toHaveLength(throws);
      },
    );
  } finally {
    report.mockRestore();
  }
}

async function expectAutomaticPlay(table: Table, before: Snapshot) {
  for (const frame of await table.snapshots()) {
    expect(frame.revision).toBe(before.revision + 1);
    expect(frame.view.turnId).toBe(need(before.view.turnId) + 1);
    expect(frame.view.lastAction).toEqual({
      type: "PLAY",
      seatId: need(before.view.currentTurn),
      turnId: need(before.view.turnId),
      automatic: true,
    });
  }
}

async function expireByRequest(table: Table, before: Snapshot) {
  const actor = need(table.seats[need(before.view.currentTurn)]);
  actor.send({ type: "PASS", turnId: before.view.turnId });
  await expectAutomaticPlay(table, before);
  expect(await actor.next()).toEqual({ type: "ERROR", code: "TIME_EXPIRED" });
}

test("turn timer retry recovers the expired turn exactly once", async () => {
  await withFailedTurnTimer(async (table, before, fake) => {
    const retry = need(fake.timers[1]);
    retry.fire();
    await expectAutomaticPlay(table, before);
    retry.fire();
    need(fake.timers[0]).fire();
    await Promise.all(table.seats.map((c) => c.reject("?", "INVALID_MESSAGE")));
    expect((await table.replace(0)).frame.revision).toBe(before.revision + 1);
  });
});

test("late request cancels the turn timer retry and commits once", async () => {
  await withFailedTurnTimer(async (table, before, fake) => {
    const retry = need(fake.timers[1]);
    expect(retry.cancelled).toBe(false);
    await expireByRequest(table, before);
    expect(retry.cancelled).toBe(true);
    retry.fire();
    await Promise.all(table.seats.map((c) => c.reject("?", "INVALID_MESSAGE")));
    expect((await table.replace(0)).frame.revision).toBe(before.revision + 1);
  });
});

test("turn timer retry reports a second failure and leaves expiry to a request", async () => {
  await withFailedTurnTimer(async (table, before, fake, fireWithClockFault) => {
    fireWithClockFault();
    expect(fake.timers).toHaveLength(2);
    await expireByRequest(table, before);
  });
});

test("server stop cancels the pending turn timer retry", async () => {
  await withFailedTurnTimer(async (table, _before, fake) => {
    const retry = need(fake.timers[1]);
    expect(retry.cancelled).toBe(false);
    await table.server.stop();
    expect(retry.cancelled).toBe(true);
    retry.fire();
    expect(fake.timers).toHaveLength(2);
  });
});

test("server contains and reports failures in receive, timeout and close while other rooms keep serving", async () => {
  const fake = clock();
  let fault = false;
  const failure = Error("clock fault");
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    await atTable(
      {
        now: () => {
          if (fault) {
            fault = false;
            throw failure;
          }
          return fake.time;
        },
        schedule: fake.schedule,
      },
      async (table) => {
        await table.lobby(3);
        await table.start();
        const other = await table.open();
        fault = true;
        other.send({ type: "CREATE_ROOM" });
        await other.bind({ type: "CREATE_ROOM" });
        expect(report.mock.calls.map((args) => args[1])).toEqual([failure]);
        fault = true;
        need(fake.callbacks[0])();
        expect(report.mock.calls.map((args) => args[1])).toEqual([
          failure,
          failure,
        ]);
        fault = true;
        need(table.seats[0]).ws.close();
        await need(table.seats[0]).closed;
        const guest = await table.open();
        await guest.bind({
          type: "JOIN_ROOM",
          roomCode: need(other.credential).roomCode,
        });
        expect((await other.snapshot()).view.seatOrder).toEqual([0, 1]);
        expect(report.mock.calls.map((args) => args[1])).toEqual([
          failure,
          failure,
          failure,
        ]);
      },
    );
  } finally {
    report.mockRestore();
  }
});

test("server rejects invalid turn durations before binding", () => {
  for (const turnTimeoutMs of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(() =>
      startGameServer({ port: 0, staticRoot: ".", turnTimeoutMs }),
    ).toThrow(RangeError);
});

test("source import stays idle and direct run requires a valid PORT", () => {
  const entry = resolve(import.meta.dir, "main.ts");
  const env = { ...process.env };
  delete env.PORT;
  const imported = spawnSync(
    process.execPath,
    ["-e", `await import(${JSON.stringify(entry)})`],
    { env, encoding: "utf8", timeout: 2000 },
  );
  expect([imported.status, imported.stdout, imported.stderr]).toEqual([
    0,
    "",
    "",
  ]);
  for (const port of [undefined, "", "12.5", "-1", "65536", "12x"]) {
    const result = spawnSync(process.execPath, [entry], {
      env: port === undefined ? env : { ...env, PORT: port },
      encoding: "utf8",
      timeout: 2000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PORT");
  }
});

test.each(["source", "bundle"] as const)(
  "direct %s entry serves its default web/dist, health and WebSocket on the assigned port",
  async (layout) => {
    const scratch = resolve(import.meta.dir, "../../../.omc");
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, `${layout}-`));
    try {
      const appRoot = layout === "source" ? join(dir, "apps") : dir;
      const dist = join(appRoot, "web/dist");
      const entry = join(
        appRoot,
        layout === "source" ? "server/src/main.ts" : "server/main.js",
      );
      await mkdir(dist, { recursive: true });
      await Bun.write(join(dist, "index.html"), "layout check");
      if (layout === "source") {
        await cp(import.meta.dir, join(appRoot, "server/src"), {
          recursive: true,
        });
        await symlink(
          resolve(import.meta.dir, "../node_modules"),
          join(appRoot, "server/node_modules"),
          "dir",
        );
      } else {
        const build = spawnSync(
          process.execPath,
          [
            "build",
            resolve(import.meta.dir, "main.ts"),
            "--target=bun",
            `--outfile=${entry}`,
          ],
          { encoding: "utf8" },
        );
        expect(build.status).toBe(0);
      }
      const child = spawn(process.execPath, [entry], {
        env: { ...process.env, PORT: "0" },
        cwd: dir,
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
      const timeout = setTimeout(() => child.kill(), 3000);
      let client: Client | undefined;
      try {
        const lines = createInterface({ input: child.stdout });
        const first = await lines[Symbol.asyncIterator]().next();
        expect(first.done).toBe(false);
        const url = need(
          first.value?.match(/^listening on (http:\/\/\S+)$/)?.[1],
        );
        const html = await fetch(url),
          health = await fetch(new URL("/healthz", url));
        expect([html.status, health.status]).toEqual([200, 200]);
        expect(await html.text()).toBe("layout check");
        client = new Client(url);
        await client.opened;
        expect((await client.bind({ type: "CREATE_ROOM" })).view.phase).toBe(
          "LOBBY",
        );
      } finally {
        client?.ws.close();
        child.kill();
        clearTimeout(timeout);
        await exit;
        await client?.closed;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("A17–A22 real sockets observe abandonment, credential return and same-room restart", async () => {
  const fake = clock();
  await atTable(
    {
      now: () => fake.time,
      schedule: fake.schedule,
      random: abandonmentShuffle(),
    },
    async (table) => {
      const replay = abandonmentRestart;
      const observed: readonly Message[] = replay.observed;
      const snapshots = observed.filter(
        (m): m is Snapshot => m.type === "SNAPSHOT",
      );
      await table.lobby(4);
      expect(await table.start()).toEqual(
        replay.firstActive.map(({ frame }) => frame),
      );
      const host = need(table.seats[0]),
        old = need(host.credential);
      const peers = table.seats.slice(1);
      for (const frame of snapshots.filter(
        (f) => f.revision >= 7 && f.revision <= 19,
      )) {
        fake.time = frame.serverNow;
        if (frame.revision === 7) host.ws.close();
        else if (frame.revision === 19 || frame.view.lastAction?.automatic)
          need(fake.callbacks.at(-1))();
        else if (frame.view.lastAction) {
          const { type, turnId, seatId } = frame.view.lastAction;
          need(table.seats[seatId]).send(
            type === "PASS"
              ? { type, turnId }
              : { type, turnId, tiles: need(frame.view.lastPlay).tiles },
          );
        }
        const frames = await Promise.all(peers.map((c) => c.snapshot()));
        expect(frames[0]).toEqual(frame);
        if (frame.revision === 19)
          expect(frames).toEqual(replay.abandoned.map((f) => f.frame));
      }
      const revoked = await table.open();
      await revoked.reject(
        {
          ...replay.exchanges.revoked.command,
          roomCode: old.roomCode,
          token: old.token,
        },
        "RESUME_DENIED",
      );
      const replacement = await table.open();
      fake.time++;
      const joined = await replacement.bind({
        type: "JOIN_ROOM",
        roomCode: old.roomCode,
      });
      expect(joined).toEqual(replay.exchanges.joined.replies[1]);
      expect(replacement.credential).toMatchObject({
        roomCode: old.roomCode,
        seatId: 0,
      });
      expect(replacement.credential?.token).not.toBe(old.token);
      const afterJoin = await Promise.all(peers.map((c) => c.snapshot()));
      table.seats[0] = replacement;
      await replacement.reject(
        replay.exchanges.rejectedStart.command,
        "NOT_HOST",
      );
      expect((await table.replace(2)).frame).toEqual(need(afterJoin[1]));
      expect((await table.replace(0)).frame).toEqual(
        replay.exchanges.rejectedStart.after,
      );
      fake.time++;
      need(table.seats[1]).send(replay.exchanges.acceptedStart.command);
      expect(await table.snapshots()).toEqual(
        replay.restartDeal.map((f) => f.frame),
      );
      const restarted = await table.snapshots();
      expect(restarted[1]).toEqual(replay.exchanges.acceptedStart.replies[1]);
      for (const f of restarted) {
        expect(f.view).not.toHaveProperty("lastGameResult");
        expect(f.view.turnId).toBe(11);
      }
      for (const exchange of replay.exchanges.stale)
        await need(table.seats[exchange.recipient]).reject(
          exchange.command,
          exchange.reply.code,
        );
      await Promise.all(
        table.seats.map((c) => c.reject("?", "INVALID_MESSAGE")),
      );
    },
  );
});
