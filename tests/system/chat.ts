import { isDeepStrictEqual as equal } from "node:util";
import {
  chatFrames,
  chatTextExamples,
  playerNameExamples,
} from "../../packages/shared/src/contracts/fixtures";
import {
  CHAT_RATE_LIMIT_COUNT,
  decodeChatMessage,
  decodeServerMessage,
  type ErrorCode,
} from "../../packages/shared/src/contracts/wire";
import { type Client, SocketRoom } from "./game";
import { need, requireCheck } from "./judges";

function seat(c: Client) {
  return need(c.credential, "missing seat");
}
class ChatRoom extends SocketRoom {
  receive(c: Client, raw: string) {
    const msg =
      decodeChatMessage(raw) ??
      decodeServerMessage(raw, c.credential?.seatId ?? null);
    requireCheck(
      msg !== "INVALID_MESSAGE",
      "invalid server frame or recipient",
    );
    if (msg.type === "SEATED") c.credential = msg;
    if (msg.type === "SNAPSHOT") {
      if (msg.revision === c.previous?.revision) {
        requireCheck(
          equal(msg.view, c.previous.view),
          "view changed at repeated revision",
        );
        return;
      }
      c.previous = msg;
    }
    c.queue.push(msg);
    c.wake?.();
  }
  async join(occupants: Client[], name?: string) {
    const c = await this.open();
    const host = occupants[0];
    c.send(
      host
        ? { type: "JOIN_ROOM", roomCode: seat(host).roomCode, name }
        : { type: "CREATE_ROOM", name },
    );
    const seated = await c.next("SEATED");
    requireCheck(
      !host ||
        (seated.roomCode === seat(host).roomCode &&
          occupants.every((p) => seat(p).seatId !== seated.seatId)),
      "unexpected room or duplicate seat",
    );
    occupants.push(c);
    for (const p of occupants) {
      const { view } = await p.next("SNAPSHOT");
      requireCheck(
        view.phase === "LOBBY" &&
          equal(
            view.seatOrder,
            occupants.map((o) => seat(o).seatId),
          ),
        "unexpected lobby seats",
      );
      requireCheck(
        view.slots[seated.seatId]?.name === name,
        "new seat name mismatch",
      );
    }
    await this.quiet();
    return c;
  }
  async pair() {
    const occupants: Client[] = [];
    const host = await this.join(occupants);
    const guest = await this.join(occupants);
    return { occupants, host, guest };
  }
  // Get a distinct reply on each socket after the action. Ordered WebSocket frames expose
  // unsolicited deliveries and snapshots even when another socket received the echo first.
  async quiet() {
    await Promise.all(
      this.clients.map(async (c) => {
        if (c.credential)
          await reject(c, { type: "CREATE_ROOM" }, "INVALID_PHASE");
        else await reject(c, {}, "INVALID_MESSAGE");
      }),
    );
    this.idle();
    for (const c of this.clients) c.previous = undefined;
  }
}
async function reject(c: Client, command: unknown, code: ErrorCode) {
  c.send(JSON.stringify(command));
  requireCheck(
    (await c.next("ERROR")).code === code,
    `expected ERROR(${code})`,
  );
}
async function delivery(c: Client, sender: Client, text: string) {
  requireCheck(
    equal(await c.next("CHAT"), {
      type: "CHAT",
      seatId: seat(sender).seatId,
      text,
    }),
    "chat sender or text mismatch",
  );
}
async function chat(
  sender: Client,
  occupants: Client[],
  text = need(chatTextExamples.valid[0], "missing chat example"),
) {
  sender.send({ type: "CHAT", text });
  await Promise.all(occupants.map((c) => delivery(c, sender, text)));
}
const checks = {
  async "chat.roundtrip"(room: ChatRoom) {
    const { host, occupants } = await room.pair();
    for (const text of [
      chatFrames.request.text,
      need(
        chatTextExamples.valid.find((t) => t.includes("👋")),
        "missing emoji chat",
      ),
    ]) {
      await chat(host, occupants, text);
      await room.quiet();
    }
  },
  async "chat.game"(room: ChatRoom) {
    const { host, occupants } = await room.pair();
    await room.join(occupants);
    host.send({ type: "START_GAME" });
    for (const c of occupants) {
      requireCheck(
        (await c.next("SNAPSHOT")).view.phase === "ROUND_START",
        "missing deal",
      );
      requireCheck(
        (await c.next("SNAPSHOT")).view.phase === "TURN_ACTIVE",
        "missing active game",
      );
    }
    await room.quiet();
    await chat(host, occupants);
    await room.quiet();
  },
  async "chat.forged"(room: ChatRoom) {
    const { host, guest, occupants } = await room.pair();
    for (const extra of [{ seatId: seat(host).seatId }, { name: "Bob7" }]) {
      await reject(
        guest,
        { ...chatFrames.request, ...extra },
        "INVALID_MESSAGE",
      );
      await room.quiet();
    }
    await chat(guest, occupants, chatFrames.request.text);
    await room.quiet();
  },
  async "chat.room"(room: ChatRoom) {
    const { host, occupants } = await room.pair();
    const others: Client[] = [];
    const second = await room.join(others);
    requireCheck(
      seat(second).roomCode !== seat(host).roomCode,
      "rooms share a code",
    );
    await room.open(); // An unseated observer must also stay silent in both directions.
    await chat(host, occupants);
    await room.quiet();
    await chat(second, others);
    await room.quiet();
  },
  async "chat.unseated"(room: ChatRoom) {
    const { host, guest } = await room.pair();
    await reject(await room.open(), chatFrames.request, "NOT_SEATED");
    await room.quiet();
    guest.send({ type: "LEAVE_ROOM" });
    requireCheck(
      (await host.next("SNAPSHOT")).view.slots[seat(guest).seatId] === null,
      "left seat not vacated",
    );
    guest.credential = undefined;
    await room.quiet();
    await reject(guest, chatFrames.request, "NOT_SEATED");
    await room.quiet();
  },
  async "chat.invalid"(room: ChatRoom) {
    const { host, guest, occupants } = await room.pair();
    const invalid = ["", " 안녕", "a\nb", "a\u202Eb", "a".repeat(101), null];
    for (const [i, text] of invalid.entries()) {
      requireCheck(
        chatTextExamples.invalid.includes(text),
        "missing invalid chat fixture",
      );
      await reject(
        i % 2 === 0 ? host : guest,
        { type: "CHAT", text },
        "INVALID_MESSAGE",
      );
      await room.quiet();
    }
    await chat(host, occupants);
    await chat(guest, occupants);
    await room.quiet();
  },
  async "chat.rate"(room: ChatRoom) {
    const { host, guest, occupants } = await room.pair();
    await reject(
      host,
      { type: "CHAT", text: chatTextExamples.invalid[0] },
      "INVALID_MESSAGE",
    );
    const texts = chatTextExamples.valid.slice(-CHAT_RATE_LIMIT_COUNT);
    requireCheck(
      texts.length === CHAT_RATE_LIMIT_COUNT,
      "missing rate fixtures",
    );
    for (const text of texts) host.send({ type: "CHAT", text });
    host.send(chatFrames.request);
    await Promise.all(
      occupants.map(async (c) => {
        for (const text of texts) await delivery(c, host, text);
      }),
    );
    requireCheck(
      equal(await host.next("CHAT_ERROR"), chatFrames.rateLimited),
      "wrong rate error",
    );
    await room.quiet();
    await chat(guest, occupants);
    await room.quiet();
  },
  async "name.unicode"(room: ChatRoom) {
    const occupants: Client[] = [];
    const names = playerNameExamples.valid.filter(
      (n) =>
        n === "名字" ||
        n === "かな" ||
        n === "🇰🇷".repeat(6) ||
        n === "👨‍👩‍👧‍👦".repeat(6),
    );
    requireCheck(names.length === 4, "missing Unicode names");
    for (const name of names) {
      await room.join(occupants, name);
      for (const c of occupants) {
        for (const [i, p] of occupants.entries())
          requireCheck(
            c.view?.slots[seat(p).seatId]?.name === names[i],
            "occupant name mismatch",
          );
      }
    }
  },
  async "name.reject"(room: ChatRoom) {
    const host = await room.join([]);
    const c = await room.open();
    for (const name of ["a\u202Eb", "철 수", "e\u0301", "\u3164", "ABCDEFG"]) {
      requireCheck(
        playerNameExamples.invalid.includes(name),
        "missing invalid name fixture",
      );
      for (const cmd of [
        { type: "CREATE_ROOM" },
        { type: "JOIN_ROOM", roomCode: seat(host).roomCode },
      ]) {
        await reject(c, { ...cmd, name }, "INVALID_MESSAGE");
        await reject(c, { type: "LEAVE_ROOM" }, "NOT_SEATED");
      }
    }
    await room.quiet();
  },
};
export async function probeChat(
  origin: string,
  frameMs: number,
  end: number,
  check: (id: string, work: () => Promise<void>) => Promise<void>,
) {
  for (const [id, work] of Object.entries(checks))
    await check(id, async () => {
      const room = new ChatRoom(origin, frameMs, end);
      try {
        await work(room);
      } finally {
        room.closeAll();
      }
    });
}
