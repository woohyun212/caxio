import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atlases, fontFiles } from "../../apps/web/src/visual/assets";
import { assets, digest, payload } from "./fixture";
import { judgeAsset, judgeHtml, judgeMissing, loadAssets } from "./http";

const asset = { url: atlases.wide.url, bytes: payload.length, sha256: digest };
const etag = `"${digest}"`,
  cache = "public, max-age=0, must-revalidate";
function response(
  status: number,
  body: string,
  cacheControl: string | null,
  tag: string | null,
) {
  const headers = new Headers();
  if (cacheControl !== null) headers.set("Cache-Control", cacheControl);
  if (tag !== null) headers.set("ETag", tag);
  return {
    status,
    headers,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}
describe("asset judge", () => {
  const ok = response(200, payload, cache, etag),
    cached = response(304, "", null, null);
  test("valid GET and revalidation", async () => {
    await judgeAsset(asset, ok, cached);
  });
  for (const [cause, get, conditional] of [
    ["GET status", response(404, payload, cache, etag), cached],
    ["length", response(200, "", cache, etag), cached],
    ["SHA", response(200, payload.toUpperCase(), cache, etag), cached],
    ...[null, "private"].map(
      (v) =>
        ["Cache-Control", response(200, payload, v, etag), cached] as const,
    ),
    ...[null, `W/${etag}`, '"wrong"'].map(
      (v) => ["ETag", response(200, payload, cache, v), cached] as const,
    ),
    ["revalidation", ok, response(200, "", null, null)],
    ["304 body", ok, response(304, "x", null, null)],
  ] as const)
    test(`reject ${cause}`, async () => {
      await expect(judgeAsset(asset, get, conditional)).rejects.toThrow(
        `${asset.url} ${cause}`,
      );
    });
});
test("manifest path, JSON, exact atlas set, integrity fields and contract fonts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caxio-assets-")),
    path = join(dir, "manifest.json");
  const files = assets.slice(0, 2).map((a, i) => ({
    ...a,
    path: `apps/web/public${a.url}`,
    width: i ? 360 : 420,
    height: i ? 160 : 186,
    alpha: [0, 255],
    allowedColors: ["#000000"],
  }));
  const cells = Array.from({ length: 15 }, (_, i) => ({
    id: String(i),
    foreground: 0,
    overrideCount: 0,
  }));
  const json = (files: unknown) => JSON.stringify({ files, cells });
  try {
    await expect(loadAssets(path)).rejects.toThrow(path);
    for (const data of [
      "?",
      json(files.slice(1)),
      json([...files, { ...asset, url: "/extra" }]),
      json([{ ...files[0], bytes: 0 }, files[1]]),
      json([{ ...files[0], sha256: "oops" }, files[1]]),
    ]) {
      await Bun.write(path, data);
      await expect(loadAssets(path)).rejects.toThrow(path);
    }
    await Bun.write(path, json(files));
    expect(await loadAssets(path)).toEqual([
      ...assets.slice(0, 2),
      ...fontFiles,
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
describe("HTML and missing path", () => {
  for (const [html, status, body, reason] of [
    ["<!-- <script src='x'></script> -->", 200, "x", "no script"],
    ['<script src="//other.invalid/x">', 200, "x", "cross-origin"],
    [
      '<base href="//other.invalid/"><script src="x">',
      200,
      "x",
      "cross-origin",
    ],
    ['<script src="x">', 404, "x", "script status"],
    ['<script src="x">', 200, "", "empty script"],
  ] as const)
    test(reason, async () => {
      await expect(
        judgeHtml(
          "https://host.invalid",
          new Response(html),
          async () => new Response(body, { status }),
        ),
      ).rejects.toThrow(reason);
    });
  test("SPA fallback is not a missing asset", () =>
    expect(() => judgeMissing(200)).toThrow("200"));
});
