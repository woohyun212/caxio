import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { atlases } from "../../apps/web/src/visual/assets";
import { frame } from "../../apps/web/src/visual/tokens";
import {
  compare,
  faceAnchors,
  judgeLoad,
  median,
  movedOutside,
  sheetLayers,
  sheetReference,
} from "./judge";
import { decode, encode, type Raster } from "./png";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    assets: { type: "string" },
    out: { type: "string" },
    chrome: { type: "string" },
  },
});
if (!values.assets || !values.out)
  throw Error("Expected --assets DIR --out DIR");
const assets = values.assets,
  out = values.out;
await mkdir(out, { recursive: true });
const atlas = decode(
  new Uint8Array(await Bun.file(join(assets, "atlas-wide.png")).arrayBuffer()),
);
if (atlas.width !== atlases.wide.width || atlas.height !== atlases.wide.height)
  throw Error("Wrong atlas size");
const reference = sheetReference(atlas);
const build = await Bun.build({
  entrypoints: ["apps/web/src/table/verify/page.tsx"],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!build.success || !build.outputs[0]) throw Error(build.logs.join("\n"));
const script = build.outputs[0];
let rejectAtlas = false;
let raw = new Map<string, Uint8Array>();
let profile: string | undefined;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/")
      return new Response(
        '<!doctype html><style>*{margin:0}body{overflow:hidden}</style><div id="root"></div><script type="module" src="/check.js"></script>',
        {
          headers: {
            "Content-Type": "text/html",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
          },
        },
      );
    if (path === "/check.js")
      return new Response(script, {
        headers: { "Content-Type": "text/javascript" },
      });
    if (path === atlases.wide.url && rejectAtlas)
      return new Response(null, { status: 404 });
    if (path === atlases.wide.url)
      return new Response(Bun.file(join(assets, "atlas-wide.png")), {
        headers: { "Cache-Control": "no-store" },
      });
    if (
      req.method === "POST" &&
      ["/capture/logical", "/capture/copy"].includes(path)
    ) {
      raw.set(path.slice(9), new Uint8Array(await req.arrayBuffer()));
      return new Response("ok");
    }
    return new Response(null, { status: 404 });
  },
});
let proc: ReturnType<typeof Bun.spawn> | undefined, ws: WebSocket | undefined;
const errors: string[] = [];
function requireCheck(ok: boolean, description: string) {
  if (!ok) errors.push(description);
}
async function until<T>(read: () => Promise<T | undefined>, label: string) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(40);
  }
  throw Error("Timed out waiting for " + label);
}
let closing: Promise<void> | undefined;
function close() {
  closing ??= (async () => {
    ws?.close();
    proc?.kill();
    if (proc) await proc.exited;
    await server.stop(true);
    if (profile)
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 100,
      });
  })();
  return closing;
}
function interrupted() {
  void close().finally(() => process.exit(130));
}
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  const activeProfile = await mkdtemp(join(tmpdir(), "caxio-table-"));
  profile = activeProfile;
  const chrome =
    values.chrome ??
    process.env.CHROME_BIN ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-allow-origins=*",
      "--hide-scrollbars",
      ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
      "--remote-debugging-port=0",
      "--user-data-dir=" + activeProfile,
      "about:blank",
    ],
    { stdout: "ignore", stderr: Bun.file(join(out, "chrome.log")) },
  );
  const port = await until(async () => {
    if (proc?.exitCode != null) throw Error("Chrome exited " + proc.exitCode);
    const file = Bun.file(join(activeProfile, "DevToolsActivePort"));
    if (await file.exists())
      return (await file.text()).split("\n")[0] || undefined;
    return undefined;
  }, "Chrome debug port");
  const endpoint = "http://127.0.0.1:" + port;
  const version = (await (await fetch(endpoint + "/json/version")).json())
    .Browser as string;
  const tabs = (await (await fetch(endpoint + "/json/list")).json()) as {
    webSocketDebuggerUrl: string;
    type: string;
  }[];
  const target = tabs.find((t) => t.type === "page");
  if (!target) throw Error("Missing page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  ws = socket;
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(Error("Chrome websocket failed"));
  });
  let id = 0;
  const pending = new Map<
    number,
    { ok: (v: unknown) => void; bad: (e: Error) => void }
  >();
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      if (msg.error) waiter.bad(Error(JSON.stringify(msg.error)));
      else waiter.ok(msg.result);
    } else if (
      msg.method === "Runtime.exceptionThrown" ||
      msg.method === "Log.entryAdded"
    )
      console.error(JSON.stringify(msg.params).slice(0, 1200));
  };
  function call<T>(method: string, params: object = {}): Promise<T> {
    const seq = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(seq);
        reject(Error("Chrome timeout: " + method));
      }, 30000);
      pending.set(seq, {
        ok: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        bad: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  }
  async function evaluate<T>(expression: string) {
    const res = await call<{
      result: { value: T };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  }
  await call("Network.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: true });
  await call("Runtime.enable");
  await call("Log.enable");
  const metrics = (k: number, dpr: number) =>
    call("Emulation.setDeviceMetricsOverride", {
      width: frame.width * k,
      height: frame.sceneHeight * k,
      deviceScaleFactor: dpr,
      mobile: false,
    });
  await metrics(1, 1);
  await call("Page.navigate", { url: server.url.href });
  await until(async () => {
    const s = await evaluate<{ ready: number; failure: number } | undefined>(
      "window.probe?.status()",
    );
    if (s?.failure) throw Error("GameTable failed");
    return s?.ready ? s : undefined;
  }, "first display");
  async function settle(k: number, sheet: boolean, selected = false) {
    const count = await evaluate<number>("probe.status().frames");
    await evaluate("probe.show(" + [k, sheet, selected].join(",") + ")");
    await until(async () => {
      const s = await evaluate<{ frames: number; width: number; k: number }>(
        "probe.status()",
      );
      return s.frames > count && s.width === frame.width * k && s.k === k
        ? s
        : undefined;
    }, "table frame");
    await evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
  }
  type Capture = {
    calls: number;
    dither: boolean;
    transform: string;
    gpu: string;
  };
  async function capture(name: string, k: number) {
    raw = new Map();
    const meta = await evaluate<Capture>("probe.capture()");
    const width = frame.width,
      height = frame.sceneHeight,
      logical: Raster = {
        width,
        height,
        data: raw.get("logical") ?? new Uint8Array(),
      };
    const copy: Raster = {
      width: width * k,
      height: height * k,
      data: raw.get("copy") ?? new Uint8Array(),
    };
    const snap = await call<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const png = Buffer.from(snap.data, "base64"),
      physical = decode(png);
    await Bun.write(join(out, name + "-logical.png"), encode(logical));
    await Bun.write(join(out, name + "-copy.png"), encode(copy));
    await Bun.write(join(out, name + "-physical.png"), png);
    requireCheck(
      meta.calls <= 150 && !meta.dither,
      name + " draw calls/DITHER",
    );
    return { logical, copy, physical, meta };
  }
  const rows = [];
  let liveDpr = false;
  for (const k of [1, 2, 3, 4])
    for (const dpr of [1, 2, 1.25]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width: frame.width * k,
        height: frame.sceneHeight * k + 1,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await evaluate("new Promise(requestAnimationFrame)");
      await metrics(k, dpr);
      if (k === 1 && dpr === 1.25) {
        const transform = await until(async () => {
          const s = await evaluate<{ transform: string }>("probe.status()");
          return s.transform.startsWith("translate") ? s.transform : undefined;
        }, "live DPR correction");
        liveDpr = !!transform;
      }
      await settle(k, true);
      const name = "sheet-k" + k + "-dpr" + dpr,
        shot = await capture(name, k);
      const logical = compare(reference, shot.logical, 1),
        copy = compare(shot.logical, shot.copy, k),
        physical = compare(shot.logical, shot.physical, k * dpr);
      const expected = Number.isInteger(k * dpr)
        ? "none"
        : "translate(0.015625px, 0.015625px)";
      requireCheck(
        [logical, copy, physical].every((v) => !v.difference && !v.mixed) &&
          shot.meta.transform === expected,
        name + " pixels/transform",
      );
      await settle(k, false);
      const specimen = await capture("load-k" + k + "-dpr" + dpr, k);
      const masks = judgeLoad(specimen.logical, atlas),
        loadCopy = compare(specimen.logical, specimen.copy, k),
        loadPhysical = compare(specimen.logical, specimen.physical, k * dpr);
      requireCheck(
        Object.entries(masks).every(
          ([key, m]) => key === "underline" || (m.pixels > 0 && !m.difference),
        ) && [loadCopy, loadPhysical].every((v) => !v.difference && !v.mixed),
        "load " + k + "/" + dpr,
      );
      rows.push({
        k,
        dpr,
        logical,
        layers: sheetLayers(reference, shot.logical),
        copy,
        physical,
        ...shot.meta,
        load: {
          masks,
          copy: loadCopy,
          physical: loadPhysical,
          ...specimen.meta,
        },
      });
    }
  await metrics(3, 1);
  await settle(3, false);
  const before = await capture("load", 3),
    load = judgeLoad(before.logical, atlas);
  const status = () =>
    evaluate<{ frames: number; ready: number; failure: number }>(
      "probe.status()",
    );
  const start = await status();
  await Bun.sleep(2000);
  const end = await status();
  const still = await capture("still", 3),
    stillLogical = compare(before.logical, still.logical, 1),
    stillPhysical = compare(before.physical, still.physical, 1);
  requireCheck(
    start.frames === end.frames &&
      !stillLogical.difference &&
      !stillPhysical.difference,
    "idle",
  );
  await settle(3, false, true);
  const selected = await capture("selected", 3),
    lift = judgeLoad(selected.logical, atlas, true);
  const anchors = [
    ...faceAnchors(before.logical, atlas, false),
    ...faceAnchors(selected.logical, atlas, true),
  ];
  requireCheck(
    anchors.every((a) => a.y === a.expectedY && !a.difference),
    "face anchors",
  );
  const movement = movedOutside(before.logical, selected.logical);
  requireCheck(movement.changed > 0 && !movement.outside, "selection bounds");
  for (const [label, masks] of [
    ["load", load],
    ["selected", lift],
  ] as const)
    for (const [key, m] of Object.entries(masks))
      if (label === "selected" || key !== "underline")
        requireCheck(m.pixels > 0 && !m.difference, label + " " + key);
  await settle(3, false);
  const timing = [];
  for (let i = 0; i < 3; i++) {
    const r = await evaluate<{
      submit: number[];
      sync: number[];
      maxCalls: number;
    }>("probe.timing()");
    timing.push({
      ...r,
      cpuMedian: median(r.submit),
      syncMedian: median(r.sync),
    });
  }
  const cpuMedian = median(timing.map((r) => r.cpuMedian)),
    syncMedian = median(timing.map((r) => r.syncMedian));
  const chip =
    process.platform === "darwin"
      ? Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"])
          .stdout.toString()
          .trim()
      : "";
  const referenceEnvironment =
    chip.startsWith("Apple M3") && version.startsWith("Chrome/");
  if (referenceEnvironment)
    requireCheck(
      cpuMedian <= 2 &&
        syncMedian <= 6 &&
        timing.every((r) => r.cpuMedian <= 2.5 && r.syncMedian <= 7),
      "M3 timing",
    );
  const maxCalls = Math.max(
    before.meta.calls,
    selected.meta.calls,
    ...timing.map((r) => r.maxCalls),
  );
  requireCheck(maxCalls <= 150, "load draw calls");
  requireCheck(start.ready === 1 && !end.failure && liveDpr, "lifecycle/DPR");
  const failureChecks = [];
  for (const mode of ["loss", "preflight", "factory", "atlas"]) {
    rejectAtlas = mode === "atlas";
    if (mode === "atlas")
      await call("Page.navigate", { url: server.url.href + "?missing-atlas" });
    else await evaluate("probe.fail(" + JSON.stringify(mode) + ")");
    const result = await until(async () => {
      const s = await evaluate<
        | {
            canvas: boolean;
            ready: number;
            failure: number;
          }
        | undefined
      >("window.probe?.status()");
      return s && !s.canvas && s.failure ? s : undefined;
    }, "fallback after " + mode);
    requireCheck(result.ready === 0 && result.failure === 1, "failure " + mode);
    failureChecks.push({ mode, ...result });
  }
  const hashes: Record<string, string> = {};
  for (const name of await readdir(assets))
    if (name.endsWith(".png"))
      hashes[name] = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(join(assets, name)).arrayBuffer())
        .digest("hex");
  const report = {
    sha: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    hashes,
    version,
    chip,
    gpu: before.meta.gpu,
    rows,
    liveDpr,
    failureChecks,
    load,
    lift,
    still: { start, end, stillLogical, stillPhysical },
    movement,
    anchors,
    maxCalls,
    dither: before.meta.dither,
    timing,
    maxSheetCalls: Math.max(...rows.map((r) => r.calls)),
    cpuMedian,
    syncMedian,
    referenceEnvironment,
    errors,
  };
  await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log({ cpuMedian, syncMedian, maxCalls, errors });
  if (errors.length) process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await close();
}
