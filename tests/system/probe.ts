import { atlases, fontFiles } from "../../apps/web/src/visual/assets";
import { HEALTH_PATH } from "../../packages/shared/src/contracts/wire";
import { probeChat } from "./chat";
import { Game } from "./game";
import {
  type Asset,
  judgeAsset,
  judgeHtml,
  judgeMissing,
  loadAssets,
} from "./http";
import { errorName, ProbeFailure, requireCheck } from "./judges";

export { judgeAsset, judgeHtml, judgeMissing, loadAssets } from "./http";
export {
  checkAction,
  checkDeal,
  checkFinal,
  checkPublic,
  isPresence,
  judgeFrame,
} from "./judges";

type Options = {
  readinessMs?: number;
  frameMs?: number;
  totalMs?: number;
  manifest?: string;
  assets?: readonly Asset[];
  log?: (line: string) => void;
};
export async function runProbe(
  origin: string,
  options: Options = {},
): Promise<0 | 1> {
  const log = options.log ?? console.log;
  const end = performance.now() + (options.totalMs ?? 90000);
  let good = 0,
    bad = 0;
  function pass(id: string) {
    good++;
    log(`${id} PASS ok`);
  }
  async function check(id: string, work: () => Promise<void>) {
    try {
      await work();
      pass(id);
    } catch (e) {
      fail(id, e);
    }
  }
  function fail(id: string, e: unknown) {
    const reason =
      e instanceof ProbeFailure
        ? e.message
        : performance.now() >= end
          ? `total budget exceeded (${errorName(e)})`
          : `request failed (${errorName(e)})`;
    bad++;
    log(`${id} FAIL ${reason}`);
  }
  function get(path: string | URL, headers?: HeadersInit, until = end) {
    const left = Math.ceil(until - performance.now());
    requireCheck(left > 0, "request budget exceeded");
    return fetch(new URL(path, origin), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(left),
    });
  }
  await check("http.ready", async () => {
    const until = Math.min(
      end,
      performance.now() + (options.readinessMs ?? 15000),
    );
    while (performance.now() < until) {
      try {
        const r = await get(HEALTH_PATH, undefined, until);
        await r.body?.cancel();
        if (r.status === 200) return;
      } catch {}
      await Bun.sleep(Math.max(0, Math.min(100, until - performance.now())));
    }
    throw new ProbeFailure("readiness budget exceeded");
  });
  let assets = options.assets;
  await check("assets.manifest", async () => {
    assets ??= await loadAssets(options.manifest);
  });
  await Promise.all([
    check("http.html", async () =>
      judgeHtml(origin, await get("/"), (url) => get(url)),
    ),
    check("http.missing", async () => {
      const r = await get(`/art/missing-${crypto.randomUUID()}.png`);
      await r.body?.cancel();
      judgeMissing(r.status);
    }),
    check("http.health", async () => {
      const r = await get(HEALTH_PATH);
      await r.body?.cancel();
      requireCheck(r.status === 200, `health status ${r.status}`);
    }),
    ...(assets ?? [atlases.wide, atlases.compact, ...fontFiles]).map((asset) =>
      check(`asset${asset.url}`, async () => {
        const headers = { "Accept-Encoding": "identity" };
        const r = await get(asset.url, headers);
        requireCheck("sha256" in asset, "manifest expectation unavailable");
        const cached = await get(asset.url, {
          ...headers,
          "If-None-Match": `"${asset.sha256}"`,
        });
        await judgeAsset(asset, r, cached);
      }),
    ),
  ]);
  const game = new Game(origin, options.frameMs ?? 5000, end, pass);
  try {
    await game.run();
    pass("ws.game");
  } catch (error) {
    fail(game.currentCheck, error);
  }
  await probeChat(origin, options.frameMs ?? 5000, end, check);
  log(`summary ${bad ? "FAIL" : "PASS"} ${good} passed, ${bad} failed`);
  return bad ? 1 : 0;
}
export function cliOrigin(args: readonly string[]) {
  try {
    const arg = args[0];
    if (arg && args.length === 1) {
      const url = new URL(arg);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      )
        return url.origin;
    }
  } catch {}
}
if (import.meta.main) {
  const origin = cliOrigin(process.argv.slice(2));
  if (origin) process.exitCode = await runProbe(origin);
  else {
    console.error("Usage: bun tests/system/probe.ts <origin>");
    process.exitCode = 2;
  }
}
