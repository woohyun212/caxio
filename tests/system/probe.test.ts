import { expect, test } from "bun:test";
import { handOrder } from "../../apps/web/src/visual/layout";
import { firstDealState } from "../../packages/shared/src/contracts/fixtures";
import { assets, type Fault, fixture } from "./fixture";
import { Game } from "./game";
import { runProbe } from "./probe";

async function run(fault?: Fault) {
  const server = fixture(fault),
    lines: string[] = [];
  try {
    const code = await runProbe(server.origin, {
      assets,
      log: (line) => lines.push(line),
      readinessMs: 70,
      frameMs: fault === "silent" ? 45 : 1000,
      totalMs: 3000,
    });
    for (const token of server.tokens)
      expect(lines.join("\n")).not.toContain(token);
    return {
      code,
      output: lines.join("\n"),
      observations: server.observations,
    };
  } finally {
    await server.stop();
  }
}
test("three real sockets, seven rejections, lost and final resumes", async () => {
  const { code, output, observations } = await run();
  const ordered = handOrder(firstDealState.players[0].hand, 9);
  const { leads, lowestAtLead, ...resumes } = observations;
  expect(resumes).toEqual({
    activeResumes: 2,
    finalResumes: [0, 1, 2],
    replacedPlays: ordered.slice(1, 2),
  });
  expect(leads).toEqual(lowestAtLead);
  expect(leads[0]).toEqual(ordered[0]);
  expect(output).toContain("summary PASS");
  expect(code).toBe(0);
  for (const id of [
    "http.ready",
    "http.html",
    "http.missing",
    "http.health",
    ...assets.map((a) => `asset${a.url}`),
    "ws.open",
    "resume.active",
    "resume.final",
    "game.final",
    "game.settings",
    "game.deadline",
    "game.max-rounds",
    "reject.turnLimitSeconds",
    "reject.maxRounds",
    "leave.lobby",
    "leave.final",
    "reject.NOT_SEATED",
    "reject.name.CREATE_ROOM",
    "reject.name.JOIN_ROOM",
    "reject.RESUME_DENIED.lobby",
    "reject.RESUME_DENIED.final",
    ...[
      "INVALID_MESSAGE",
      "NOT_YOUR_TURN",
      "STALE_TURN",
      "NOT_OWNED",
      "DUPLICATE_TILE",
      "ILLEGAL_HAND",
      "NOT_HIGHER",
      "RESUME_DENIED",
    ].map((s) => `reject.${s}`),
  ])
    expect(output).toContain(`${id} PASS`);
});
for (const [fault, reason] of [
  [
    "accept-limit",
    "reject.turnLimitSeconds FAIL expected ERROR, received SEATED",
  ],
  ["accept-rounds", "reject.maxRounds FAIL expected ERROR, received SEATED"],
  [
    "default-settings",
    "game.settings FAIL expected turnLimitSeconds=45 in LOBBY",
  ],
  ["missing-limit", "game.settings FAIL expected turnLimitSeconds=45 in LOBBY"],
  [
    "replaced-settings",
    "game.settings FAIL expected turnLimitSeconds=45 in TURN_ACTIVE",
  ],
  ["wrong-joiner", "game.settings FAIL expected turnLimitSeconds=45 in LOBBY"],
  ["short-deadline", "game.deadline FAIL new turn has less than 44750 ms"],
  ["early-end", "game.max-rounds FAIL GAME_OVER before round 3"],
  [
    "early-elimination",
    "game.max-rounds FAIL max rounds not observed: early elimination",
  ],
  ["wrong-error", "reject.DUPLICATE_TILE FAIL expected ERROR(DUPLICATE_TILE)"],
  ["extra-error", "unexpected unrequested frame"],
  ["resume-token", "resume.active FAIL resume credential mismatch"],
  ["resume-hand", "resume.active FAIL resume changed active turn or hand"],
  [
    "accepted-token",
    "reject.RESUME_DENIED FAIL expected ERROR, received SEATED",
  ],
  ["split-table", "public table mismatch at shared revision"],
  ["wrong-leader", "leader does not hold cloud 3"],
  ["chip-total", "game.final FAIL chip total"],
  ["final-table", "resume.final FAIL final resume public table mismatch"],
  ["asset", "atlas-wide.png FAIL"],
  ["leak", "foreign seat token"],
  ["missing", "http.missing FAIL"],
  ["approve", "expected ERROR"],
  ["silent", "frame budget"],
  ["endless", "game.max-rounds FAIL round beyond configured maximum"],
  ["wrong-rounds", "game.settings FAIL expected maxRounds=3 in LOBBY"],
  ["overlong-replay", "game.deadline FAIL active deadline exceeds 45000 ms"],
  ["unready", "readiness budget"],
  ["old-play", "lastPlay mismatch"],
  ["old-close", "disconnected live seat"],
  [
    "accept-name",
    "reject.name.CREATE_ROOM FAIL expected ERROR, received SEATED",
  ],
  ["drop-name", "seat 2 name mismatch"],
  ["resume-name", "resume.active FAIL seat 0 name mismatch"],
  ["keep-leaver", "leave.lobby FAIL left seat not vacated"],
  ["reuse-token", "leave.lobby FAIL rejoin reused the revoked credential"],
  ["notify-leaver", "leave.lobby FAIL frame sent to the leaver"],
  [
    "accept-left",
    "reject.RESUME_DENIED.final FAIL expected ERROR, received SEATED",
  ],
] as const)
  test(`detect ${fault}`, async () => {
    const { code, output } = await run(fault);
    expect(output).toContain(reason);
    expect(code).toBe(1);
    if (fault === "unready")
      expect(output).toContain("http.health FAIL health status 503");
    expect(output).toContain("http.health ");
    expect(output).toContain("asset/fonts/ofl.md ");
  });
test("total budget bounds a silent socket even with a longer frame budget", async () => {
  const server = fixture("silent"),
    lines: string[] = [];
  try {
    const code = await runProbe(server.origin, {
      assets,
      frameMs: 1000,
      totalMs: 150,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("total budget exceeded");
  } finally {
    await server.stop();
  }
});
test("CLI usage exits 2", () => {
  for (const args of [[], ["invalid origin"]]) {
    const result = Bun.spawnSync([
      process.execPath,
      new URL("./probe.ts", import.meta.url).pathname,
      ...args,
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Usage:");
  }
});

test("CLI reports a leaking frame without printing credentials", async () => {
  const server = fixture("leak");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./probe.ts", import.meta.url).pathname,
        server.origin,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(out).toContain("foreign seat token");
    for (const token of server.tokens) expect(out + err).not.toContain(token);
  } finally {
    await server.stop();
  }
});

test("final resume for a seat eliminated at payment", async () => {
  const result = await run("elimination");
  expect(result.output).toContain("resume.final PASS");
  expect(result.code).toBe(0);
});

test("refused connection exhausts readiness and still reports HTTP and WebSocket checks", async () => {
  const server = fixture();
  await server.stop();
  const lines: string[] = [];
  const code = await runProbe(server.origin, {
    assets,
    readinessMs: 25,
    frameMs: 100,
    totalMs: 800,
    log: (line) => lines.push(line),
  });
  expect(code).toBe(1);
  expect(lines.find((l) => l.startsWith("http.health FAIL"))).toMatch(
    /request failed \([A-Za-z]+\)/,
  );
  for (const id of [
    "http.ready",
    "http.html",
    "http.missing",
    "http.health",
    ...assets.map((a) => `asset${a.url}`),
    "ws.open",
  ])
    expect(lines.some((l) => l.startsWith(`${id} FAIL`))).toBe(true);
});

for (const variant of ["replay", "replaced-notice"] as const)
  test(`tolerate ${variant}`, async () => {
    const { code, output } = await run(variant);
    expect(output).toContain("summary PASS");
    expect(code).toBe(0);
  });
test("socket failures report exception names without messages", () => {
  const game = new Game(
    "https://fixture.invalid",
    100,
    performance.now() + 500,
    () => {},
  );
  game.fail(new RangeError("protected-credential-alpha"));
  expect(game.failure?.message).toBe("socket failure (RangeError)");
});
