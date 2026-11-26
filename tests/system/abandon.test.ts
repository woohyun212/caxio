import { expect, test } from "bun:test";
import {
  abandonmentLobbyExamples,
  abandonmentLobbyResume,
  abandonmentRestart,
  abandonmentResults,
  invalidAbandonmentExamples,
  nonHostAbandonmentLobby,
} from "../../packages/shared/src/contracts/fixtures";
import type { Message } from "../../packages/shared/src/contracts/wire";
import { runAbandonProbe } from "./abandon";
import { abandonFixture, type Fault } from "./abandon-fixture";
import { checkAbandonmentSequence } from "./abandon-sequence";
import { judgeFrame, need } from "./judges";

async function run(fault?: Fault, rng?: () => number) {
  const peer = abandonFixture(fault, 60, rng),
    lines: string[] = [];
  try {
    const code = await runAbandonProbe(peer.origin, {
      frameMs: 35,
      totalMs: 2000,
      log: (line) => lines.push(line),
    });
    const until = performance.now() + 500;
    while (peer.sockets() > 0 && performance.now() < until) await Bun.sleep(2);
    expect(peer.sockets()).toBe(0);
    const output = lines.join("\n");
    for (const token of peer.tokens) expect(output).not.toContain(token);
    return { code, output, observed: peer.observed };
  } finally {
    await peer.stop();
  }
}
for (const [rng, turnIds] of [
  [0.99, [1, 5, 9]],
  [0.4, [4, 8, 12]],
] as const)
  test(`host expires leading or following, deal RNG ${rng}`, async () => {
    const { code, output, observed } = await run(undefined, () => rng);
    expect(code).toBe(0);
    expect(output).toContain("abandon.first PASS ok turnId=1 revision=12");
    expect(output).toContain(
      `abandon.automatic.1 PASS ok turnId=${turnIds[0]}`,
    );
    expect(output).toContain(
      `abandon.automatic.2 PASS ok turnId=${turnIds[1]}`,
    );
    expect(output).toContain(
      `abandon.third.open PASS ok seat=0 turnId=${turnIds[2]} deadline=`,
    );
    expect(output).toContain("credential=denied");
    expect(output).toContain("credential=same");
    expect(output).toContain("credential=replaced");
    expect(output).toContain("summary PASS");
    for (const { command, expected } of observed)
      expect(command).toEqual(expected);
  });

const faults = {
  chips: "abandon.third FAIL abandonment ranking",
  leaver: "abandon.third FAIL abandonment ranking",
  tie: "abandon.third FAIL abandonment ranking",
  invalid: "invalid server frame or recipient",
  "accept-revoked": "abandon.revoked FAIL expected ERROR, received SEATED",
  "reuse-turn": "abandon.restart FAIL reused restart turnId",
  "third-action": "abandon.third FAIL third host automatic PLAY applied",
  settlement: "abandon.third FAIL third host turn followed by ROUND_SETTLEMENT",
  "game-over": "abandon.third FAIL third host turn followed by GAME_OVER",
  "early-count": "missing automatic host action or premature lobby",
  "early-time": "abandon.third FAIL host expiry before deadline",
  "keep-slot": "abandon.third FAIL lobby slots",
  "drop-presence": "abandon.lobby.presence FAIL past result",
  "change-resume": "abandon.lobby.resume FAIL past result",
  "drop-join": "abandon.lobby.join FAIL past result",
  "change-rejected":
    "abandon.lobby.rejected-start FAIL rejected start changed lobby result",
  "restart-result": "abandon.restart FAIL invalid server frame",
  "restart-chips": "abandon.restart FAIL restart round, seats, chips or result",
  "reject-opening":
    "abandon.restart.action FAIL expected SNAPSHOT, received ERROR",
  "approve-play": "abandon.stale.PLAY FAIL expected ERROR, received SNAPSHOT",
  "approve-pass": "abandon.stale.PASS FAIL expected ERROR, received SNAPSHOT",
  "old-token":
    "abandon.lobby.join FAIL replacement received revoked credential",
  "leak-revoked": "abandon.lobby.join FAIL foreign credential",
  silent: "abandon.seating FAIL frame budget exceeded",
  "silent-active": "abandon.automatic.1 FAIL frame budget exceeded",
  "duplicate-lobby": "duplicate snapshot revision",
  "split-revision": "abandon.third FAIL broadcast revision",
} satisfies Record<Fault, string>;
for (const [fault, diagnostic] of Object.entries(faults))
  test(`abandonment probe rejects ${fault}`, async () => {
    const { code, output } = await run(fault as Fault);
    expect(output).toContain(diagnostic);
    expect(code).toBe(1);
    expect(output).toContain("summary FAIL");
  });
test("refused connection resolves to 1", async () => {
  const peer = abandonFixture();
  await peer.stop();
  const lines: string[] = [];
  expect(
    await runAbandonProbe(peer.origin, {
      frameMs: 100,
      totalMs: 300,
      log: (l) => lines.push(l),
    }),
  ).toBe(1);
  expect(lines.join("\n")).toContain("abandon.seating FAIL");
});

test("frozen lobby frames and resume replies use the probe frame judge", () => {
  for (const { recipient, frame } of [
    ...abandonmentLobbyExamples,
    nonHostAbandonmentLobby,
  ])
    expect(judgeFrame(JSON.stringify(frame), recipient, new Map())).toEqual(
      frame,
    );
  for (const reply of abandonmentLobbyResume.replies)
    expect(
      judgeFrame(
        JSON.stringify(reply),
        reply.type === "SEATED" ? null : abandonmentLobbyResume.recipient,
        new Map(),
      ),
    ).toEqual(reply);
  for (const { recipient, frame } of invalidAbandonmentExamples)
    expect(() =>
      judgeFrame(JSON.stringify(frame), recipient, new Map()),
    ).toThrow("invalid server frame");
});

const record = abandonmentRestart.observed.map((f) =>
  need(
    judgeFrame(JSON.stringify(f), abandonmentRestart.recipient, new Map()),
    "missing frozen frame",
  ),
);
test("same observer crosses round settlement before third host expiry", () => {
  const { automatic, third, maxTurn, result } =
    checkAbandonmentSequence(record);
  expect(automatic).toEqual([4, 8]);
  expect(third?.turnId).toBe(10);
  expect(maxTurn).toBe(10);
  expect(result).toEqual(abandonmentResults.afterRoundOne.result);
});
test("pre-turn chips yield competition ranks 1,1,3 and a richer leaver alone in fourth", () => {
  const turn = record[12],
    lobby = record[13];
  if (
    turn?.type !== "SNAPSHOT" ||
    lobby?.type !== "SNAPSHOT" ||
    lobby.view.phase !== "LOBBY"
  )
    throw new Error("missing frozen transition");
  const chips = [132, 60, 60, 4] as const;
  const slot = (id: 0 | 1 | 2 | 3) => ({
    ...need(turn.view.slots[id], "missing participant"),
    chips: chips[id],
  });
  const ranking = [
    { seatId: 1, rank: 1, chips: 60 },
    { seatId: 2, rank: 1, chips: 60 },
    { seatId: 3, rank: 3, chips: 4 },
    { seatId: 0, rank: 4, chips: 132 },
  ] as const;
  const observed = checkAbandonmentSequence([
    ...record.slice(0, 12),
    {
      ...turn,
      view: { ...turn.view, slots: [slot(0), slot(1), slot(2), slot(3), null] },
    },
    {
      ...lobby,
      view: {
        ...lobby.view,
        lastGameResult: { reason: "ABANDONMENT", leaverSeatId: 0, ranking },
      },
    },
  ]);
  expect(observed.result?.ranking).toEqual(ranking);
});
for (const [label, mutate, reason] of [
  [
    "manual host action",
    (r: Message[]) => {
      const f = r[5];
      if (f?.type === "SNAPSHOT" && f.view.lastAction)
        r[5] = {
          ...f,
          view: {
            ...f.view,
            lastAction: { ...f.view.lastAction, automatic: false },
          },
        };
    },
    "missing automatic host action",
  ],
  [
    "host pass removed a tile",
    (r: Message[]) => {
      const f = r[5];
      if (f?.type === "SNAPSHOT" && f.view.slots[0])
        r[5] = {
          ...f,
          view: {
            ...f.view,
            slots: [
              { ...f.view.slots[0], remainingTileCount: 12 },
              f.view.slots[1],
              f.view.slots[2],
              f.view.slots[3],
              null,
            ],
          },
        };
    },
    "wrong tiles",
  ],
  ["presence", (r: Message[]) => r.splice(1, 1), "missing host disconnect"],
  [
    "missing second expiry",
    (r: Message[]) => r.splice(9, 1),
    "missing automatic host action",
  ],
  [
    "early automatic",
    (r: Message[]) => {
      const f = r[5];
      if (f?.type === "SNAPSHOT") r[5] = { ...f, serverNow: 0 };
    },
    "host expiry before deadline",
  ],
  ["missing third turn", (r: Message[]) => r.splice(12, 1), "premature end"],
  [
    "different third chips",
    (r: Message[]) => {
      const f = r[12];
      if (f?.type === "SNAPSHOT" && f.view.slots[0])
        r[12] = {
          ...f,
          view: {
            ...f.view,
            slots: [
              { ...f.view.slots[0], chips: 100 },
              f.view.slots[1],
              f.view.slots[2],
              f.view.slots[3],
              null,
            ],
          },
        };
    },
    "abandonment ranking",
  ],
  [
    "incomplete lobby",
    (r: Message[]) => r.splice(13),
    "incomplete abandonment",
  ],
  ["stale accepted", (r: Message[]) => r.splice(17, 1), "incomplete restart"],
] as const)
  test(`record mutation: ${label}`, () => {
    const changed = [...record];
    mutate(changed);
    expect(() => checkAbandonmentSequence(changed)).toThrow(reason);
  });

const script = new URL("./abandon.ts", import.meta.url).pathname;
test("CLI requires exactly one bare HTTP(S) origin", () => {
  for (const args of [
    [],
    ["x"],
    ["ws://host"],
    ["http://a", "http://b"],
    ["http://u:p@host"],
    ["http://host/path"],
    ["https://host/?q"],
    ["https://host/#h"],
  ]) {
    const p = Bun.spawnSync([process.execPath, script, ...args]);
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("Usage:");
  }
});
for (const fault of [undefined, "leak-revoked"] as const)
  test(`CLI exit and redaction: ${fault ?? "healthy"}`, async () => {
    const peer = abandonFixture(fault);
    try {
      const child = Bun.spawn([process.execPath, script, peer.origin], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(fault ? 1 : 0);
      expect(out).toContain(fault ? "summary FAIL" : "summary PASS");
      for (const token of peer.tokens) expect(out + err).not.toContain(token);
    } finally {
      await peer.stop();
    }
  });
