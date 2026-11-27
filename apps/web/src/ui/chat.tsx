import { errorText, isChatText } from "@caxio/shared/contracts/wire";
import { useLayoutEffect, useRef } from "react";
import type { ChatEntry, GameControlsProps } from "../contracts";
import { seatLabel } from "../visual/layout";

export function ChatLine({ entry, own }: { entry: ChatEntry; own: boolean }) {
  return (
    <>
      <span className="gc-chat-name" style={{ display: "inline-flex" }}>
        <span
          dir="auto"
          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {entry.name ?? seatLabel(entry.seatId)}
        </span>
        {!own && ":"}
      </span>
      {own && <span> (나):</span>}{" "}
      <span className="gc-chat-body" dir="auto">
        {entry.text}
      </span>
    </>
  );
}

export function Chat({
  model,
  sendChat,
  close,
}: Pick<GameControlsProps, "model" | "sendChat"> & { close?: () => void }) {
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (model.chat?.length && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [model.chat]);
  const widePanel = !!close;
  useLayoutEffect(() => {
    if (widePanel) input.current?.focus();
  }, [widePanel]);
  return (
    <section id="gc-chat" aria-label="방 채팅" className="gc-chat">
      <ul ref={list} aria-label="최근 메시지">
        {model.chat?.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: deliveries may be identical and rows have no local state.
          <li key={index} data-own={entry.seatId === model.seatId}>
            <ChatLine entry={entry} own={entry.seatId === model.seatId} />
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const field = input.current;
          if (
            !field ||
            !sendChat ||
            model.connection !== "CONNECTED" ||
            !isChatText(field.value.trim())
          )
            return;
          sendChat(field.value.trim());
          field.value = "";
        }}
      >
        <input
          ref={input}
          aria-label="채팅 메시지"
          placeholder="메시지 입력"
          aria-describedby={model.chatErrorCode ? "gc-chat-error" : undefined}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
        />
        <button
          type="submit"
          disabled={!sendChat || model.connection !== "CONNECTED"}
        >
          보내기
        </button>
        {close && (
          <button type="button" onClick={close}>
            닫기
          </button>
        )}
      </form>
      {model.chatErrorCode && (
        <div role="status" id="gc-chat-error">
          {errorText(model.chatErrorCode)}
        </div>
      )}
    </section>
  );
}
