import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_TURN_LIMIT_SECONDS,
  isMaxRounds,
  isTurnLimitSeconds,
  MAX_ROUNDS,
  type MaxRounds,
  TURN_LIMIT_SECONDS,
  type TurnLimitSeconds,
} from "@caxio/shared/contracts/settings";
import {
  ABANDONMENT_NOTICE,
  LAST_GAME_RANKING_TITLE,
  LEAVER_SEAT_PREFIX,
  type PlayerView,
} from "@caxio/shared/contracts/wire";
import { type ReactNode, useState } from "react";
import type { GameControlsProps } from "../contracts";
import { seatLabel } from "../visual/layout";
import { settlementCounts } from "./settlement";
import {
  activate,
  copyRoomLink,
  entryName,
  linkedRoom,
  nameHint,
  outage,
  type PanelKind,
  recallName,
  rememberName,
  seatName,
  submitEntryCode,
} from "./state";

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
  const [code, setCode] = useState(() => linkedRoom() ?? ""),
    [turnLimitSeconds, setSeconds] = useState<TurnLimitSeconds>(
      DEFAULT_TURN_LIMIT_SECONDS,
    ),
    [maxRounds, setRounds] = useState<MaxRounds>(DEFAULT_MAX_ROUNDS),
    [name, setName] = useState(recallName),
    [invalid, setInvalid] = useState<"" | "name" | "code">("");
  const busy =
    outage(model) ||
    (model.pending || model.connection === "CONNECTING"
      ? "서버 응답 대기"
      : "");
  const notice =
    message ||
    (invalid === "name"
      ? nameHint
      : invalid === "code"
        ? "6자리 방 코드를 확인해 주세요."
        : busy);
  // Returns the name to request with, or false after showing the name hint.
  const named = () => {
    const n = entryName(name);
    if (n === false) setInvalid("name");
    return n;
  };
  return (
    <div className="gc-entry">
      <h1>caxio</h1>
      <div className="gc-name">
        <label htmlFor="gc-name">이름</label>
        <input
          id="gc-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setInvalid("");
          }}
          aria-invalid={invalid === "name"}
          spellCheck={false}
        />
      </div>
      <div className="gc-settings">
        <label>
          턴 제한시간{" "}
          <select
            value={turnLimitSeconds}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (isTurnLimitSeconds(value)) setSeconds(value);
            }}
          >
            {TURN_LIMIT_SECONDS.map((n) => (
              <option key={n} value={n}>
                {n}초
              </option>
            ))}
          </select>
        </label>
        <label>
          최대 라운드{" "}
          <select
            value={maxRounds}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (isMaxRounds(value)) setRounds(value);
            }}
          >
            {MAX_ROUNDS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Action
        className="gc-primary"
        reason={busy}
        describedBy="gc-entry-status"
        onClick={() => {
          const n = named();
          if (n === false) return;
          rememberName(n);
          createRoom(n, { turnLimitSeconds, maxRounds });
        }}
      >
        방 만들기
      </Action>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          const n = named();
          if (n === false) return;
          const valid = submitEntryCode(busy, code, (roomCode) => {
            rememberName(n);
            joinRoom(roomCode, n);
          });
          if (valid !== undefined) setInvalid(valid ? "" : "code");
        }}
      >
        <label htmlFor="gc-code">방 코드</label>
        <input
          id="gc-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setInvalid("");
          }}
          aria-invalid={invalid === "code"}
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
  leaveRoom,
  message,
}: {
  model: GameControlsProps["model"];
  view: Extract<PlayerView, { phase: "LOBBY" }>;
  startGame: () => void;
  leaveRoom?: () => void;
  message: string;
}) {
  const [manualLink, setManualLink] = useState("");
  const offline = view.seatOrder.find((id) => !view.slots[id]?.isConnected);
  const host = view.hostSeatId === model.seatId,
    last = view.lastGameResult;
  const reason =
    outage(model) ||
    (model.pending
      ? "서버 응답 대기"
      : view.canStart
        ? ""
        : offline === undefined
          ? "한 명 더 필요"
          : `${seatName(view, offline)} 복귀 대기`);
  return (
    <section className="gc-lobby">
      <div className="gc-room-code">
        <label>
          방 코드{" "}
          <input
            value={model.credential?.roomCode ?? ""}
            readOnly
            onFocus={(e) => e.target.select()}
          />
        </label>
        <Action
          onClick={async () => {
            setManualLink(await copyRoomLink(model.credential?.roomCode ?? ""));
          }}
        >
          링크 복사
        </Action>
        <Action onClick={() => leaveRoom?.()}>나가기</Action>
      </div>
      <div className="gc-room-settings">
        <span>
          턴 제한시간 {view.turnLimitSeconds ?? DEFAULT_TURN_LIMIT_SECONDS}초
        </span>
        {" · "}
        <span>최대 {view.maxRounds}라운드</span>
      </div>
      {manualLink && (
        <div role="status">
          링크를 복사할 수 없어요.{" "}
          <textarea
            className="gc-manual-link"
            aria-label="초대 링크"
            rows={2}
            readOnly
            value={manualLink}
            onFocus={(e) => e.target.select()}
          />
        </div>
      )}
      <ul className="gc-lobby-seats" aria-label="현재 좌석">
        {view.slots.map((s, id) => (
          <li key={seatLabel(id)}>
            {seatName(view, id)}{" "}
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
              ? `방장 · ${seatName(view, view.hostSeatId)}`
              : "")}
        </div>
      </div>
      {last && (
        <section className="gc-last-result" aria-labelledby="gc-last-ranking">
          <div>{ABANDONMENT_NOTICE}</div>
          <div>
            {LEAVER_SEAT_PREFIX}{" "}
            {last.ranking.find((r) => r.seatId === last.leaverSeatId)?.name ??
              seatLabel(last.leaverSeatId)}
          </div>
          <h2 id="gc-last-ranking">{LAST_GAME_RANKING_TITLE}</h2>
          <ol>
            {last.ranking.map(({ seatId, rank, chips, name }) => (
              <li key={seatId}>
                {rank}위 {name ?? seatLabel(seatId)} {chips}칩
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
  seatId,
  kind,
  page,
  view,
  open,
  setPage,
  close,
  leave = () => {},
}: {
  compact?: boolean;
  seatId?: number | null;
  kind: PanelKind;
  page: number;
  view: PlayerView;
  open: (kind: PanelKind) => void;
  setPage: (n: number) => void;
  close: () => void;
  // The menu's [나가기]: leaves at once or opens the "leave" confirmation.
  leave?: () => void;
}) {
  const s = view.lastSettlement,
    counts = settlementCounts(view);
  const rowsPerPage = compact && s ? s.results.length : 3;
  const pages =
    kind === "rules"
      ? 3
      : kind === "settlement" && s
        ? Math.ceil(s.results.length / rowsPerPage)
        : 1;
  // Resizing to wide can put the compact page past the last wide page.
  const current = Math.min(page, pages - 1);
  return (
    <section
      className="gc-panel"
      data-panel={kind}
      aria-label={
        kind === "menu"
          ? "메뉴"
          : kind === "rules"
            ? "족보"
            : kind === "leave"
              ? "나가기"
              : "직전 정산"
      }
    >
      {kind === "menu" ? (
        <div className="gc-actions">
          <Action onClick={() => open("rules")}>족보</Action>
          {s && <Action onClick={() => open("settlement")}>직전 정산</Action>}
          <Action onClick={leave}>나가기</Action>
        </div>
      ) : kind === "leave" ? (
        <div>지금 나가면 게임이 바로 끝나고 내가 최하위가 돼요.</div>
      ) : kind === "rules" ? (
        <>
          <strong>족보 {page + 1}/3</strong>
          <div>{rules[page]}</div>
        </>
      ) : (
        s && (
          <>
            <strong>
              R{s.round}/{view.maxRounds} 정산
            </strong>
            {s.results
              .toSorted((a, b) => a.rank - b.rank)
              .slice(current * rowsPerPage, (current + 1) * rowsPerPage)
              .map((r) => (
                <div key={r.seatId}>
                  {r.rank === 1 ? <u>1위</u> : `${r.rank}위`}{" "}
                  {seatName(view, r.seatId)}
                  {seatId === r.seatId ? "(나)" : ""}{" "}
                  {counts?.[r.seatId] !== undefined
                    ? `${counts[r.seatId]}장 `
                    : ""}
                  {r.chipChange > 0 ? "+" : r.chipChange < 0 ? "−" : ""}
                  {Math.abs(r.chipChange)}칩 {view.slots[r.seatId]?.chips}칩
                </div>
              ))}
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
        {kind === "leave" ? (
          <>
            <Action onClick={leave}>나가기</Action>
            <Action className="gc-keep" onClick={close}>
              계속하기
            </Action>
          </>
        ) : (
          <Action onClick={close}>닫기</Action>
        )}
      </div>
    </section>
  );
}

export function EndScreen({
  view,
  seatId,
  reason,
  openEntry,
  leave,
  openSettlement,
}: {
  view: PlayerView;
  seatId: GameControlsProps["model"]["seatId"];
  reason: string;
  openEntry: () => void;
  leave: () => void;
  openSettlement: (button: HTMLButtonElement) => void;
}) {
  return (
    <section className="gc-end">
      <strong>{reason}</strong>
      {view.ranking.map((r) => (
        <div key={r.seatId}>
          {r.rank}위 {seatName(view, r.seatId)} {view.slots[r.seatId]?.chips}칩{" "}
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
        <Action className="gc-primary" onClick={openEntry}>
          새 방 만들기
        </Action>
        <Action onClick={leave}>나가기</Action>
      </div>
    </section>
  );
}
