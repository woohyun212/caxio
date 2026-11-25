import { fileURLToPath } from "node:url";
import { atlases, fontFiles } from "../../apps/web/src/visual/assets";
import { ProbeFailure, requireCheck } from "./judges";
export type Asset = { url: string; bytes: number; sha256: string };
export const manifestPath = fileURLToPath(
  new URL("../../design/assets/manifest.json", import.meta.url),
);
export async function loadAssets(path = manifestPath): Promise<Asset[]> {
  try {
    const data: unknown = await Bun.file(path).json();
    requireCheck(
      data &&
        typeof data === "object" &&
        "files" in data &&
        Array.isArray(data.files),
      "missing files",
    );
    const expected = new Set<string>([atlases.wide.url, atlases.compact.url]);
    const result: Asset[] = [];
    for (const entry of data.files) {
      requireCheck(
        entry && expected.delete(entry.url),
        "extra or repeated atlas URL",
      );
      requireCheck(
        Number.isSafeInteger(entry.bytes) && entry.bytes > 0,
        "invalid bytes",
      );
      requireCheck(
        typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256),
        "invalid sha256",
      );
      result.push({ url: entry.url, bytes: entry.bytes, sha256: entry.sha256 });
    }
    requireCheck(!expected.size, "missing atlas URL");
    return [...result, ...fontFiles];
  } catch (e) {
    throw new ProbeFailure(
      path +
        " " +
        (e instanceof ProbeFailure ? e.message : "missing or unreadable JSON"),
    );
  }
}
type BodyResponse = Pick<Response, "status" | "headers" | "arrayBuffer">;
export async function judgeAsset(
  asset: Asset,
  response: BodyResponse,
  cached: BodyResponse,
) {
  function check(ok: unknown, cause: string) {
    requireCheck(ok, `${asset.url} ${cause}`);
  }
  check(response.status === 200, `GET status ${response.status}`);
  const body = await response.arrayBuffer();
  check(body.byteLength === asset.bytes, "length mismatch");
  check(
    new Bun.CryptoHasher("sha256").update(body).digest("hex") === asset.sha256,
    "SHA mismatch",
  );
  check(
    response.headers.get("cache-control") ===
      "public, max-age=0, must-revalidate",
    "Cache-Control mismatch",
  );
  check(response.headers.get("etag") === `"${asset.sha256}"`, "ETag mismatch");
  check(cached.status === 304, `revalidation status ${cached.status}`);
  check((await cached.arrayBuffer()).byteLength === 0, "304 body");
}
export async function judgeHtml(
  origin: string,
  page: Response,
  get: (url: URL) => Promise<Response>,
) {
  requireCheck(page.status === 200, `root status ${page.status}`);
  const sources: string[] = [];
  let base: string | null = null;
  await new HTMLRewriter()
    .on("script[src]", {
      element(e) {
        sources.push(e.getAttribute("src") ?? "");
      },
    })
    .on("base[href]", {
      element(e) {
        base ??= e.getAttribute("href");
      },
    })
    .transform(page)
    .text();
  requireCheck(sources.length, "no script reference");
  const failures = await Promise.allSettled(
    sources.map(async (src) => {
      requireCheck(src.trim(), "empty script reference");
      const url = new URL(src, new URL(base ?? "/", origin));
      requireCheck(url.origin === origin, "cross-origin script");
      const r = await get(url);
      requireCheck(r.status === 200, `script status ${r.status}`);
      requireCheck((await r.arrayBuffer()).byteLength > 0, "empty script");
    }),
  );
  for (const result of failures)
    if (result.status === "rejected") throw result.reason;
}
export function judgeMissing(status: number) {
  requireCheck(status === 404, `missing asset status ${status}`);
}
