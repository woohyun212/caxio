import {
  ABANDONMENT_NOTICE,
  LAST_GAME_RANKING_TITLE,
  LEAVER_SEAT_PREFIX,
  type PlayerView,
} from "@caxio/shared/contracts/wire";
import { type ReactNode, useRef, useState } from "react";
import type { GameControlsProps } from "../contracts";
import { seatLabel } from "../visual/layout";
import { activate, outage, type PanelKind, submitEntryCode } from "./state";

export function Action({
  children,
  reason = "",
  describedBy,
  onClick,
  className,
}: {
  children: ReactNode;
  reason?: string;
  describedBy?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-disabled={reason ? true : undefined}
      aria-describedby={reason ? describedBy : undefined}
      onClick={() => activate(reason, onClick)}
    >
      {children}
    </button>
  );
}

export function Entry({
  model,
  createRoom,
  joinRoom,
  message,
}: Pick<GameControlsProps, "model" | "createRoom" | "joinRoom"> & {
  message: string;
}) {
  const [code, setCode] = useState(""),
    [invalid, setInvalid] = useState(false);
  const busy =
    outage(model) ||
    (model.pending || model.connection === "CONNECTING"
      ? "서버 응답 대기"
      : "");
  const notice = message || (invalid ? "6자리 방 코드를 확인해 주세요." : busy);
  return (
    <div className="gc-entry">
      <h1>caxio</h1>
      <Action
        className="gc-primary"
        reason={busy}
        describedBy="gc-entry-status"
        onClick={createRoom}
      >
        방 만들기
      </Action>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const valid = submitEntryCode(busy, code, joinRoom);
          if (valid !== undefined) setInvalid(!valid);
        }}
      >
        <label htmlFor="gc-code">방 코드</label>
        <input
          id="gc-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setInvalid(false);
          }}
          aria-invalid={invalid}
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button
          type="submit"
          aria-disabled={busy ? true : undefined}
          aria-describedby={busy ? "gc-entry-status" : undefined}
        >
          입장
        </button>
      </form>
      {busy && busy !== notice && <div id="gc-entry-status">{busy}</div>}
      <div
        id={busy === notice ? "gc-entry-status" : undefined}
        aria-live="polite"
      >
        {notice}
      </div>
    </div>
  );
}
export function Lobby({
  model,
  view,
  startGame,
  message,
}: {
  model: GameControlsProps["model"];
  view: Extract<PlayerView, { phase: "LOBBY" }>;
  startGame: () => void;
  message: string;
}) {
  const code = useRef<HTMLInputElement>(null);
  const offline = view.seatOrder.find((id) => !view.slots[id]?.isConnected);
  const host = view.hostSeatId === model.seatId;
  const reason =
    outage(model) ||
    (model.pending
      ? "서버 응답 대기"
      : view.canStart
        ? ""
        : offline === undefined
          ? "한 명 더 필요"
          : `${seatLabel(offline)} 복귀 대기`);
  return (
    <section className="gc-lobby">
      <div className="gc-room-code">
        <label>
          방 코드{" "}
          <input
            ref={code}
            value={model.credential?.roomCode ?? ""}
            readOnly
            onFocus={(e) => e.target.select()}
          />
        </label>
        <Action
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code.current?.value ?? "");
            } catch {
              code.current?.focus();
              code.current?.select();
            }
          }}
        >
          복사
        </Action>
      </div>
      <ul className="gc-lobby-seats" aria-label="현재 좌석">
        {view.slots.map((s, id) => (
          <li key={seatLabel(id)}>
            {seatLabel(id)}{" "}
            {s ? (s.isConnected ? "접속" : "복귀 대기") : "빈자리"}{" "}
            {id === view.hostSeatId ? "방장" : ""}{" "}
            {id === model.seatId ? "나" : ""}
          </li>
        ))}
      </ul>
      <div className="gc-lobby-actions">
        <div id="gc-start-reason">
          {host ? reason : "방장의 시작을 기다려 주세요"}
        </div>
        {host && (
          <Action
            onClick={startGame}
            reason={reason}
            describedBy="gc-start-reason"
          >
            시작
          </Action>
        )}
        <div aria-live="polite">
          {message ||
            (view.hostSeatId !== null
              ? `${seatLabel(view.hostSeatId)}이 방장이에요`
              : "")}
        </div>
      </div>
      {view.lastGameResult && (
        <section className="gc-last-result" aria-labelledby="gc-last-ranking">
          <div>{ABANDONMENT_NOTICE}</div>
          <div>
            {LEAVER_SEAT_PREFIX} {seatLabel(view.lastGameResult.leaverSeatId)}
          </div>
          <h2 id="gc-last-ranking">{LAST_GAME_RANKING_TITLE}</h2>
          <ol>
            {view.lastGameResult.ranking.map(({ seatId, rank, chips }) => (
              <li key={seatId}>
                {rank}위 {seatLabel(seatId)} {chips}칩
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

const rules = [
  "숫자 3..N<1<2 · 구름<별<달<해 · 1·2·3·5장",
  "스트레이트<플러시<풀하우스<포카드<스트레이트 플러시 · 플러시는 숫자 먼저",
  "일반 3..7부터 (N−4)..N · 특수 1·2·3·4·5, 2·3·4·5·6 · (N−3)..N 다음 1 허용 · (N−2)..N 다음 1·2 금지 · 남은 장수×2^(남은 2의 수)",
];
export function Panel({
  compact = false,
  kind,
  page,
  view,
  open,
  setPage,
  close,
}: {
  compact?: boolean;
  kind: PanelKind;
  page: number;
  view: PlayerView;
  open: (kind: PanelKind) => void;
  setPage: (n: number) => void;
  close: () => void;
}) {
  const s = view.lastSettlement,
    own =
      view.ownSettlement?.round === s?.round ? view.ownSettlement : undefined;
  const rowsPerPage = compact ? 1 : 3;
  const pages =
    kind === "rules"
      ? 3
      : kind === "settlement" && s
        ? Math.ceil((s.results.length + (compact && own ? 1 : 0)) / rowsPerPage)
        : 1;
  // Resizing to wide can put the compact page past the last wide page.
  const current = Math.min(page, pages - 1);
  return (
    <section
      className="gc-panel"
      data-panel={kind}
      aria-label={
        kind === "menu" ? "메뉴" : kind === "rules" ? "족보" : "직전 정산"
      }
    >
      {kind === "menu" ? (
        <div className="gc-actions">
          <Action onClick={() => open("rules")}>족보</Action>
          {s && <Action onClick={() => open("settlement")}>직전 정산</Action>}
        </div>
      ) : kind === "rules" ? (
        <>
          <strong>족보 {page + 1}/3</strong>
          <div>{rules[page]}</div>
        </>
      ) : (
        s && (
          <>
            <strong>R{s.round} 정산</strong>
            {s.results
              .slice(current * rowsPerPage, (current + 1) * rowsPerPage)
              .map((r) => (
                <div key={r.seatId}>
                  {r.rank}위 {seatLabel(r.seatId)}{" "}
                  {r.chipChange > 0 ? "+" : r.chipChange < 0 ? "−" : ""}
                  {Math.abs(r.chipChange)}칩 → {view.slots[r.seatId]?.chips}칩{" "}
                  {view.slots[r.seatId]?.isOut
                    ? view.phase === "GAME_OVER"
                      ? "탈락"
                      : "탈락 · 다음 판 관전"
                    : ""}
                </div>
              ))}
            {own && (!compact || current === s.results.length) && (
              <div>
                남은 {own.remaining}장 × {2 ** own.twos}배(2가 {own.twos}장) ={" "}
                {own.effective}
              </div>
            )}
          </>
        )
      )}
      <div className="gc-actions">
        {pages > 1 && (
          <>
            <Action
              reason={current === 0 ? "첫 쪽" : ""}
              onClick={() => setPage(current - 1)}
            >
              이전
            </Action>
            <Action
              reason={current + 1 >= pages ? "마지막 쪽" : ""}
              onClick={() => setPage(current + 1)}
            >
              다음
            </Action>
          </>
        )}
        <Action onClick={close}>닫기</Action>
      </div>
    </section>
  );
}

export function EndScreen({
  view,
  seatId,
  reason,
  createRoom,
  openSettlement,
}: {
  view: PlayerView;
  seatId: GameControlsProps["model"]["seatId"];
  reason: string;
  createRoom: () => void;
  openSettlement: (button: HTMLButtonElement) => void;
}) {
  return (
    <section className="gc-end">
      <strong>{reason}</strong>
      {view.ranking.map((r) => (
        <div key={r.seatId}>
          {r.rank}위 {seatLabel(r.seatId)} {view.slots[r.seatId]?.chips}칩{" "}
          {view.slots[r.seatId]?.isOut ? "탈락" : ""}{" "}
          {r.seatId === seatId ? "▶ 나" : ""}
        </div>
      ))}
      <div className="gc-actions">
        <button
          type="button"
          onClick={(e) => {
            openSettlement(e.currentTarget);
          }}
        >
          직전 정산
        </button>
        <Action className="gc-primary" onClick={createRoom}>
          새 방 만들기
        </Action>
      </div>
    </section>
  );
}
