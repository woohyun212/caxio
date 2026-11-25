import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { HEALTH_PATH, WS_PATH } from "@caxio/shared/contracts/wire";
import type { RoomConnection, StartHttpServer } from "../contracts";

function notFound() {
  return new Response(null, { status: 404 });
}

async function serveFile(
  staticRoot: string,
  pathname: string,
  request: Request,
) {
  const name = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  if (name.includes("\0") || name.split("/").includes("..")) return notFound();
  const root = await realpath(staticRoot);
  const path = await realpath(join(root, name));
  const within = relative(root, path);
  if (within === ".." || within.startsWith(`..${sep}`)) return notFound();

  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) return notFound();
    const bytes = await file.readFile();
    const headers = new Headers({ "Content-Type": Bun.file(name).type });
    if (
      [name, `/${within}`].some(
        (path) => path.startsWith("/art/") || path.startsWith("/fonts/"),
      )
    ) {
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const etag = `"${hash}"`;
      headers.set("ETag", etag);
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers });
      }
    }
    return new Response(bytes, { headers });
  } finally {
    await file.close();
  }
}

export const startHttpServer: StartHttpServer = (
  roomService,
  staticRoot,
  port,
) => {
  const server = Bun.serve<{ connection?: RoomConnection }>({
    port,
    error: notFound,
    fetch(request, server) {
      if (request.method !== "GET") return notFound();
      const { pathname } = new URL(request.url);
      if (pathname === HEALTH_PATH) return new Response("ok");
      if (pathname === WS_PATH) {
        if (server.upgrade(request, { data: {} })) return;
        return new Response(null, { status: 400 });
      }
      return serveFile(staticRoot, pathname, request);
    },
    websocket: {
      open(ws) {
        ws.data.connection = {
          send(message) {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify(message));
          },
        };
      },
      message(ws, frame) {
        if (ws.data.connection) roomService.receive(ws.data.connection, frame);
      },
      close(ws) {
        const connection = ws.data.connection;
        delete ws.data.connection;
        if (connection) roomService.close(connection);
      },
    },
  });
  return { url: server.url.href, stop: () => server.stop(true) };
};
