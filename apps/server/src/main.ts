import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rules } from "@caxio/shared";
import type { Rng } from "@caxio/shared/contracts/engine";
import { ROOM_ALPHABET } from "@caxio/shared/contracts/wire";
import { DEFAULT_TURN_LIMIT_MS, type RoomDependencies } from "./contracts";
import { startHttpServer } from "./http";
import { createRoomService } from "./room";

interface Options {
  port: number;
  staticRoot: string;
  random?: Rng;
  turnTimeoutMs?: number;
  now?: RoomDependencies["now"];
  schedule?: RoomDependencies["schedule"];
}

function contain(operation: () => void) {
  try {
    operation();
  } catch (error) {
    console.error("Game server event failed", error);
  }
}

const timer: RoomDependencies["schedule"] = (delay, callback) => {
  // The room re-arms an early callback for the remaining delay.
  const handle = setTimeout(callback, Math.min(delay, 2 ** 31 - 1));
  return () => clearTimeout(handle);
};

export function startGameServer({
  port,
  staticRoot,
  random = () => randomInt(2 ** 32) / 2 ** 32,
  turnTimeoutMs = DEFAULT_TURN_LIMIT_MS,
  now = Date.now,
  schedule = timer,
}: Options) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError("PORT must be an integer between 0 and 65535");
  const deadline = now() + turnTimeoutMs;
  if (
    !Number.isSafeInteger(turnTimeoutMs) ||
    turnTimeoutMs <= 0 ||
    deadline <= 0 ||
    !Number.isSafeInteger(deadline)
  )
    throw new RangeError(
      "turnTimeoutMs must produce a positive safe integer deadline",
    );
  const timers = new Set<() => void>();
  let stopped = false;
  const room = createRoomService({
    rules,
    dealRng: random,
    newRoomCode: () =>
      Array.from({ length: 6 }, () =>
        ROOM_ALPHABET.charAt(randomInt(ROOM_ALPHABET.length)),
      ).join(""),
    newToken: randomUUID,
    now,
    schedule(delay, callback) {
      const cancel = schedule(delay, () => {
        timers.delete(cancel);
        if (!stopped) contain(callback);
      });
      timers.add(cancel);
      return () => {
        timers.delete(cancel);
        cancel();
      };
    },
    send: (connection, message) => connection.send(message),
    turnLimitMs: turnTimeoutMs,
  });
  const server = startHttpServer(
    {
      receive: (connection, frame) => {
        if (!stopped) contain(() => room.receive(connection, frame));
      },
      close: (connection) => {
        if (!stopped) contain(() => room.close(connection));
      },
    },
    staticRoot,
    port,
  );
  return {
    url: server.url,
    stop() {
      stopped = true;
      for (const cancel of timers) cancel();
      timers.clear();
      return server.stop();
    },
  };
}

if (import.meta.main) {
  const port = process.env.PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) > 65535) {
    console.error("PORT must be set to an integer between 0 and 65535");
    process.exitCode = 1;
  } else {
    const staticRoot = resolve(
      import.meta.dir,
      import.meta.file.endsWith(".ts") ? "../../web/dist" : "../web/dist",
    );
    console.log(
      `listening on ${startGameServer({ port: Number(port), staticRoot }).url}`,
    );
  }
}
