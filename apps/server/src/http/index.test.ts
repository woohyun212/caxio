import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  HEALTH_PATH,
  type Message,
  WS_PATH,
} from "@caxio/shared/contracts/wire";
import type { RoomConnection } from "../contracts";
import { startHttpServer } from "./index";

const reply: Message = { type: "ERROR", code: "INVALID_MESSAGE" };
let parent: string;
let root: string;
let server: ReturnType<typeof startHttpServer>;
let received: { connection: RoomConnection; frame: unknown }[];
let closed: RoomConnection[];

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "caxio-http-"));
  root = join(parent, "web");
  received = [];
  closed = [];
  server = startHttpServer(
    {
      receive(connection, frame) {
        received.push({ connection, frame });
        connection.send(reply);
      },
      close(connection) {
        closed.push(connection);
      },
    },
    root,
    0,
  );
});

afterEach(async () => {
  try {
    await server.stop();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function get(path: string, options?: RequestInit) {
  return fetch(new URL(path, server.url), options);
}

async function openSocket() {
  const url = new URL(WS_PATH, server.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  const messages: unknown[] = [];
  ws.onmessage = (event) => messages.push(event.data);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  return { ws, messages };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for socket event");
    await Bun.sleep(5);
  }
}

// Fetch normalizes dot segments before sending. Write the request target verbatim.
function rawHeaders(path: string) {
  const url = new URL(server.url);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        resolve(response);
        socket.destroy();
      }
    });
    socket.on("end", () => reject(new Error("Incomplete HTTP headers")));
    socket.on("error", reject);
    socket.setTimeout(2000, () => socket.destroy(new Error("HTTP timeout")));
  });
}

test("one assigned port serves the index, typed assets, health and a WebSocket reply", async () => {
  await mkdir(root);
  expect(new URL(server.url).protocol).toBe("http:");
  expect(Number(new URL(server.url).port)).toBeGreaterThan(0);
  await writeFile(join(root, "healthz"), "shadow");
  const health = await get(HEALTH_PATH);
  expect(health.status).toBe(200);
  expect(await health.text()).toBe("ok");
  for (const [file, type] of Object.entries({
    "index.html": "text/html",
    "app.js": "text/javascript",
    "app.css": "text/css",
    "tile.png": "image/png",
    "game.woff2": "font/woff2",
  })) {
    const bytes = Buffer.from([0, 127, 128, 255]);
    await writeFile(join(root, file), bytes);
    const response = await get(file === "index.html" ? "/" : `/${file}?v=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(type);
    expect(response.headers.get("Cache-Control")).toBeNull();
    expect(response.headers.get("ETag")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  }
  const { ws, messages } = await openSocket();
  ws.send("  invalid JSON  ");
  await until(() => messages.length > 0);
  expect(messages).toEqual([JSON.stringify(reply)]);
  expect(received.map((event) => event.frame)).toEqual(["  invalid JSON  "]);
});

test("missing files, directories, malformed paths and outside-root targets return 404", async () => {
  await mkdir(root);
  await writeFile(join(root, "index.html"), "no fallback");
  await writeFile(join(root, "%zz"), "invalid escape");
  await writeFile(join(parent, "outside"), "private marker");
  await mkdir(join(root, "dir"));
  await symlink(join(parent, "outside"), join(root, "leak"));
  await symlink(parent, join(root, "ancestor"));
  await symlink(join(root, "index.html"), join(root, "inside"));
  expect(await (await get("/inside")).text()).toBe("no fallback");
  for (const path of [
    "/missing",
    "/art/missing",
    "/fonts/missing",
    "/dir",
    "/leak",
    "/ancestor/outside",
    "/../outside",
    "/%2e%2e/outside",
    "/..%2foutside",
    "/%zz",
    "/%00",
  ]) {
    const response = await rawHeaders(path);
    expect(response.startsWith("HTTP/1.1 404 ")).toBe(true);
  }
  expect((await get("/", { method: "POST" })).status).toBe(404);
});

test("health and WebSockets work before the static root appears, then new files are served", async () => {
  const health = await get(HEALTH_PATH);
  expect(health.status).toBe(200);
  expect(await health.text()).toBe("ok");
  const { ws, messages } = await openSocket();
  ws.send("before build");
  await until(() => messages.length > 0);
  expect(messages).toEqual([JSON.stringify(reply)]);
  expect((await get("/")).status).toBe(404);
  expect((await get("/client.js")).status).toBe(404);
  await mkdir(root);
  await writeFile(join(root, "index.html"), "built client");
  await writeFile(join(root, "client.js"), "built script");
  for (const [path, body] of Object.entries({
    "/": "built client",
    "/client.js": "built script",
  })) {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  }
});

test("fetching a Unix socket returns a bare 404", async () => {
  await mkdir(root);
  const socket = createServer();
  socket.listen(join(root, "sock"));
  await once(socket, "listening");
  try {
    const response = await get("/sock");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  } finally {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
});

test.each(["art/atlas.png", "fonts/game.woff2"])(
  "%s revalidates the SHA-256 of current bytes only",
  async (path) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    const cache = "public, max-age=0, must-revalidate";
    let previous = '"outdated"';
    for (const bytes of [
      Buffer.from([255, 0, 17]),
      Buffer.from([0, 255, 17]),
    ]) {
      await writeFile(join(root, path), bytes);
      const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
      const raw = await rawHeaders(`//${path}`);
      expect(raw.startsWith("HTTP/1.1 200 ")).toBe(true);
      const lines = raw.split("\r\n");
      for (const [key, value] of Object.entries({
        "cache-control": cache,
        etag,
      })) {
        const prefix = `${key}: `;
        expect(
          lines
            .find((line) => line.toLowerCase().startsWith(prefix))
            ?.slice(prefix.length),
        ).toBe(value);
      }
      for (const validator of [
        undefined,
        previous,
        "*",
        `W/${etag}`,
        `${previous}, ${etag}`,
        etag,
      ]) {
        const response = await get(`/${path}`, {
          headers: validator ? { "If-None-Match": validator } : {},
        });
        expect(response.headers.get("Cache-Control")).toBe(cache);
        expect(response.headers.get("ETag")).toBe(etag);
        expect(response.status).toBe(validator === etag ? 304 : 200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          validator === etag ? Buffer.alloc(0) : bytes,
        );
      }
      previous = etag;
    }
  },
);

test("two clients keep separate connections, ordered frames and private replies through close", async () => {
  const a = await openSocket();
  const b = await openSocket();
  a.ws.send("first");
  a.ws.send("second");
  await until(() => a.messages.length === 2);
  b.ws.send(new Uint8Array([42]));
  await until(() => b.messages.length > 0);
  const [first, second, third] = received;
  if (!first || !second || !third) throw new Error("missing frame");
  expect(received.map((event) => event.frame)).toEqual([
    "first",
    "second",
    Buffer.from([42]),
  ]);
  expect(first.connection).toBe(second.connection);
  expect(first.connection).not.toBe(third.connection);
  expect(a.messages).toEqual([JSON.stringify(reply), JSON.stringify(reply)]);
  expect(b.messages).toEqual([JSON.stringify(reply)]);
  a.ws.close();
  await until(() => closed.length > 0);
  expect(closed[0]).toBe(first.connection);
  expect(() => first.connection.send(reply)).not.toThrow();
  b.ws.terminate();
  await until(() => closed.length === 2);
  expect(closed[1]).toBe(third.connection);
  await server.stop();
  expect(closed).toHaveLength(2);
  expect(received).toHaveLength(3);
});

test("a non-upgraded WebSocket request has no room lifecycle", async () => {
  await mkdir(root);
  await writeFile(join(root, WS_PATH), "shadow");
  expect((await get(WS_PATH)).status).toBe(400);
  await server.stop();
  expect(received).toEqual([]);
  expect(closed).toEqual([]);
});

test("stop reports active and silent sockets once and releases the listener", async () => {
  const active = await openSocket();
  const silent = await openSocket();
  active.ws.send("hello");
  await until(() => active.messages.length > 0);
  await server.stop();
  expect(closed).toHaveLength(2);
  expect(new Set(closed).size).toBe(2);
  expect(
    closed.some((connection) => connection === received[0]?.connection),
  ).toBe(true);
  await until(() =>
    [active, silent].every(
      (client) => client.ws.readyState === WebSocket.CLOSED,
    ),
  );
  await expect(rawHeaders(HEALTH_PATH)).rejects.toMatchObject({
    code: "ECONNREFUSED",
  });
  await server.stop();
  expect(closed).toHaveLength(2);
  expect(received).toHaveLength(1);
});
