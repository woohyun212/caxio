import { expect, test } from "bun:test";
import type { SeatId } from "./domain";
import * as fixtures from "./fixtures";

const { chatFrames, chatTextExamples } = fixtures;

import type { Assert, Exact } from "./type-check";
import {
  CHAT_ERROR_TEXT,
  type CHAT_RATE_LIMIT_COUNT,
  type CHAT_RATE_LIMIT_WINDOW_MS,
  type CHAT_TEXT_MAX_CODE_UNITS,
  type CHAT_TEXT_MAX_LENGTH,
  type ChatError,
  type ChatErrorCode,
  type ChatMessage,
  type ChatRequest,
  type ClientRequest,
  decodeChatMessage,
  decodeClientRequest,
  decodeCommand,
  decodeRequest,
  decodeServerMessage,
  type ErrorCode,
  errorText,
  isChatText,
  type PLAYER_NAME_MAX_CODE_UNITS,
  type PLAYER_NAME_MAX_LENGTH,
  type Request,
} from "./wire";

type ChatContract = Assert<
  Exact<
    [
      ChatRequest,
      ChatMessage,
      ChatError,
      ChatErrorCode,
      Extract<ErrorCode, ChatErrorCode>,
      typeof decodeClientRequest,
      ClientRequest,
      typeof decodeChatMessage,
      typeof PLAYER_NAME_MAX_LENGTH,
      typeof PLAYER_NAME_MAX_CODE_UNITS,
      typeof CHAT_TEXT_MAX_LENGTH,
      typeof CHAT_TEXT_MAX_CODE_UNITS,
      typeof CHAT_RATE_LIMIT_COUNT,
      typeof CHAT_RATE_LIMIT_WINDOW_MS,
    ],
    [
      { type: "CHAT"; text: string },
      { type: "CHAT"; seatId: SeatId; text: string },
      { type: "CHAT_ERROR"; code: "CHAT_RATE_LIMITED" },
      "CHAT_RATE_LIMITED",
      never,
      (frame: unknown) => ClientRequest | "INVALID_MESSAGE",
      Request | ChatRequest,
      (frame: unknown) => ChatMessage | ChatError | null,
      6,
      66,
      100,
      1100,
      5,
      5000,
    ]
  >
>;

test("chat request and delivery validate the same free text without changing it", () => {
  const exact: ChatContract = true;
  expect(exact).toBe(true);
  for (const text of chatTextExamples.valid) {
    const request = { ...chatFrames.request, text };
    const delivery = { ...chatFrames.delivery, text };
    expect(isChatText(text)).toBe(true);
    expect(decodeClientRequest(JSON.stringify(request))).toEqual(request);
    expect(decodeRequest(JSON.stringify(request))).toBe("INVALID_MESSAGE");
    expect(decodeCommand(JSON.stringify(request))).toBe("INVALID_MESSAGE");
    expect(decodeChatMessage(JSON.stringify(delivery))).toEqual(delivery);
  }
  for (const text of chatTextExamples.invalid) {
    expect(isChatText(text)).toBe(false);
    expect(
      decodeClientRequest(JSON.stringify({ ...chatFrames.request, text })),
    ).toBe("INVALID_MESSAGE");
    expect(
      decodeChatMessage(JSON.stringify({ ...chatFrames.delivery, text })),
    ).toBeNull();
  }
});

test("chat request accepts only the body and each decoder accepts only its own frames", () => {
  for (const extra of [{ seatId: 0 }, { name: "철수" }, { revision: 1 }]) {
    expect(
      decodeClientRequest(JSON.stringify({ ...chatFrames.request, ...extra })),
    ).toBe("INVALID_MESSAGE");
  }
  expect(decodeClientRequest(JSON.stringify({ type: "CHAT" }))).toBe(
    "INVALID_MESSAGE",
  );
  const { delivery, rateLimited } = chatFrames;
  for (const frame of [delivery, rateLimited]) {
    expect(decodeChatMessage(JSON.stringify(frame))).toEqual(frame);
    expect(decodeClientRequest(JSON.stringify(frame))).toBe("INVALID_MESSAGE");
    expect(decodeServerMessage(JSON.stringify(frame), 0)).toBe(
      "INVALID_MESSAGE",
    );
    expect(
      decodeChatMessage(JSON.stringify({ ...frame, name: "철수" })),
    ).toBeNull();
    expect(decodeChatMessage(frame)).toBeNull();
  }
  for (const frame of [
    chatFrames.request,
    { ...delivery, seatId: "0" },
    { ...delivery, seatId: 5 },
    { type: "CHAT", seatId: 0 },
    { type: "CHAT_ERROR" },
    { ...rateLimited, code: 0 },
    { ...rateLimited, code: "INVALID_MESSAGE" },
    { ...rateLimited, code: "toString" },
    { type: "ERROR", code: "CHAT_RATE_LIMITED" },
  ]) {
    expect(decodeChatMessage(JSON.stringify(frame))).toBeNull();
  }
  expect(decodeChatMessage("{")).toBeNull();
  expect(errorText(rateLimited.code)).toBe(CHAT_ERROR_TEXT.CHAT_RATE_LIMITED);
});

test("legacy and chat-aware decoders agree on every non-chat frame in the shared fixtures", () => {
  function check(value: unknown) {
    if (!value || typeof value !== "object") return;
    if ("type" in value && value.type !== "CHAT") {
      const frame = JSON.stringify(value);
      expect(decodeClientRequest(frame)).toEqual(decodeRequest(frame));
    }
    for (const child of Object.values(value)) check(child);
  }
  check(fixtures);
});
