import type { PlayerView } from "@caxio/shared/contracts/wire";
import { errorText } from "@caxio/shared/contracts/wire";
import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { GameControlsComponent, GameControlsProps } from "../contracts";
import { handOrder, type Mode, seatLabel } from "../visual/layout";
import { frame, palette, sceneZones, stage, tile } from "../visual/tokens";
import { Action, EndScreen, Entry, Lobby, Panel } from "./screens";
import {
  abandonmentNotice,
  clockText,
  dealText,
  describe,
  locks,
  nextFocusSlot,
  nextNotice,
  nextPanel,
  outage,
  type PanelKind,
  passedSeats,
  requestTurn,
  seconds,
  tileName,
} from "./state";
import { box, Seats, Tiles } from "./tiles";
import "./controls.css";

type GameView = Exclude<PlayerView, { phase: "LOBBY" }>;
function Board({
  props,
  view,
  mode,
  seenTurn,
}: {
  props: GameControlsProps;
  view: GameView;
  mode: Mode;
  seenTurn: number | null | undefined;
}) {
  const { model, layout, preview } = props;
  const wide = mode === "wide",
    opaque = !wide || !props.graphicsReady;
  const root = useRef<HTMLFieldSetElement>(null),
    heading = useRef<HTMLSpanElement>(null),
    menu = useRef<HTMLButtonElement>(null),
    caller = useRef<HTMLButtonElement>(null);
  const focused = useRef<{ names: readonly string[]; index: number } | null>(
    null,
  );
  const [old, setOld] = useState(model),
    [notice, setNotice] = useState(() => nextNotice(null, model, "", seenTurn));
  const [shown, setShown] = useState(() =>
    nextPanel(null, view, { kind: null, page: 0 }),
  );
  const { kind: panel, page } = shown;
  if (old !== model) {
    setOld(model);
    setNotice(nextNotice(old, model, notice, seenTurn));
    setShown(nextPanel(old.view, view, shown));
  }
  const focusPanel = useRef(false),
    insidePanel = useRef(false);
  const open = (kind: PanelKind) => {
    focusPanel.current = !!root.current?.querySelector(".gc-panel :focus");
    setShown({ kind, page: 0 });
  };
  const close = () => {
    setShown({ kind: null, page: 0 });
    (caller.current ?? menu.current)?.focus();
  };
  const hand = handOrder(view.ownHand ?? [], view.maxNumber);
  useLayoutEffect(() => {
    if (!panel && insidePanel.current) {
      insidePanel.current = false;
      (caller.current ?? menu.current)?.focus();
    }
    if (focusPanel.current) {
      focusPanel.current = false;
      root.current
        ?.querySelector<HTMLButtonElement>(
          ".gc-panel button:not([aria-disabled=true])",
        )
        ?.focus();
    }
    const f = focused.current;
    if (!f || !root.current) return;
    const names = view.phase === "GAME_OVER" ? [] : hand.map(tileName);
    const surviving = names.indexOf(f.names[f.index] ?? "");
    if (surviving >= 0) {
      focused.current = { names, index: surviving };
      return;
    }
    const buttons = Array.from(
      root.current.querySelectorAll<HTMLButtonElement>("[data-slot]"),
    );
    focused.current = null;
    const i = nextFocusSlot(f.names, f.index, buttons.length ? names : []);
    (i === null ? heading.current : buttons[i])?.focus();
  });
  const [, tick] = useState(0);
  useEffect(() => {
    if (view.deadline === null || !model.timeAnchor) return;
    const { serverNow, receivedAt } = model.timeAnchor;
    const deadline = view.deadline;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      tick((n) => n + 1);
      const ms = deadline - serverNow - (performance.now() - receivedAt);
      if (ms > 0) timer = setTimeout(schedule, Math.ceil(ms % 1000 || 1000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, [view.deadline, model.timeAnchor]);
  const remaining = () =>
    seconds(view.deadline, model.timeAnchor, performance.now());
  const left = remaining(),
    self = model.seatId === null ? null : view.slots[model.seatId];
  const out = !!self?.isOut || !view.ownHand,
    end = view.phase === "GAME_OVER";
  const result = preview(model.selected, view.tableHand, view.maxNumber);
  const lock = locks(model, result, left);
  const last = view.lastPlay;
  const center = handOrder(view.tableHand ?? [], view.maxNumber);
  const previous = last && handOrder(last.tiles, view.maxNumber);
  const lastResult = last && preview(last.tiles, null, view.maxNumber);
  const caption =
    last && lastResult?.ok
      ? view.tableHand
        ? `${seatLabel(last.seatId)} · ${describe(lastResult)}`
        : `직전 제출 · ${seatLabel(last.seatId)} · ${describe(lastResult).split(" · ")[0]} · ${previous?.map(tileName).join(", ")}`
      : "먼저 내세요";
  const turn = end
    ? view.round === view.maxRounds
      ? "마지막 라운드 종료"
      : "생존자 3명 미만"
    : view.currentTurn === null
      ? `R${view.round} 정산`
      : `${view.currentTurn === model.seatId ? "▶ 내 차례" : `${seatLabel(view.currentTurn)} 차례`} · ${view.tableHand ? "받기" : "선"}`;
  const clear =
    !view.tableHand &&
    last &&
    view.currentTurn !== null &&
    view.currentTurn !== model.seatId
      ? `새 선 · ${seatLabel(view.currentTurn)}`
      : "";
  const selfText =
    model.seatId === null
      ? ""
      : `${seatLabel(model.seatId)} ${self?.chips ?? 0}칩`;
  const publicStatus = out
    ? "탈락 · 관전 중"
    : model.seatId !== null && passedSeats(view).has(model.seatId)
      ? "패스"
      : "";
  const shortSelf = wide && publicStatus === "패스" && !end;
  const message =
    outage(model) ||
    (model.errorCode !== null
      ? errorText(model.errorCode)
      : notice || (out || end ? "" : lock.standing));
  const compactDeal = !wide && message && message === dealText(view);
  const summary = describe(result);
  const reasonId = (reason: string) =>
    reason === message
      ? "gc-live-text"
      : reason === summary
        ? "gc-preview"
        : "gc-extra";
  const extra =
    !out &&
    !end &&
    [lock.hand, lock.play, lock.pass].find(
      (reason) => reason && reasonId(reason) === "gc-extra",
    );
  const time = left === null ? "" : clockText(left);
  const forecast = view.tableHand ? "초과 시 패스" : "초과 시 최저 1장";
  const action = (kind: "play" | "pass") =>
    requestTurn(model, result, kind, performance.now(), props[kind]);
  return (
    <fieldset
      aria-label="대국"
      className={`gc-board ${opaque ? "gc-opaque" : "gc-canvas"}`}
      ref={root}
      onClickCapture={() => setNotice("")}
      onFocusCapture={(e) => {
        insidePanel.current = !!e.target.closest(".gc-panel");
        const index = e.target.dataset.slot;
        focused.current =
          index === undefined
            ? null
            : {
                index: Number(index),
                names: hand.map(tileName),
              };
      }}
      onBlurCapture={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
          focused.current = null;
          insidePanel.current = false;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && panel) {
          e.preventDefault();
          close();
        }
      }}
    >
      <header
        className={`gc-status ${left !== null && left <= 5 ? "gc-urgent" : ""}`}
      >
        <span className="gc-brand">caxio</span>
        <span className="gc-turn" tabIndex={-1} ref={heading}>
          {end ? "대국 종료" : clear || turn}
        </span>
        <span
          role="timer"
          className="gc-time"
          aria-label={time && `${time} · ${forecast}`}
        >
          {time}
          {left !== null && left > 0 && (
            <>
              <span className="gc-long"> · {forecast}</span>
              <span className="gc-short">
                {" "}
                · {view.tableHand ? "자동 패스" : "최저 1장 자동"}
              </span>
            </>
          )}
        </span>
        <span className="gc-round">R{view.round}</span>
        <div className="gc-actions">
          <button
            type="button"
            aria-pressed={model.muted}
            onClick={() => props.setMuted(!model.muted)}
          >
            {model.muted ? "무음" : "소리"}
          </button>
          <button
            type="button"
            ref={menu}
            aria-expanded={!!panel}
            onClick={(e) => {
              caller.current = e.currentTarget;
              if (panel === "menu") close();
              else open("menu");
            }}
          >
            메뉴
          </button>
        </div>
      </header>
      <div className="gc-scene">
        <Seats view={view} layout={layout} mode={mode} opaque={opaque} />
        <div className="gc-center" data-covered={!!panel || end}>
          <span
            className="gc-caption"
            style={
              wide
                ? {
                    ...box(stage.caption),
                    height: "auto",
                    minHeight: stage.caption.h,
                    width: "max-content",
                    minWidth: stage.caption.w,
                    maxWidth: layout.felt.w,
                    left: "50%",
                    transform: "translateX(-50%)",
                  }
                : undefined
            }
          >
            {caption}
          </span>
          <Tiles tiles={center} slots={layout.table} mode={mode} />
        </div>
        {wide && opaque && (
          <span
            className="gc-fallback"
            style={{
              top: `calc(${end ? frame.sceneHeight : layout.felt.y + layout.felt.h}px - var(--gc-fallback-height))`,
            }}
          >
            그래픽을 사용할 수 없어 기본 화면으로 진행해요
          </span>
        )}
        {!out && !end && (
          <Tiles
            tiles={hand}
            slots={layout.hand}
            mode={mode}
            hand={{
              selected: model.selected,
              reason: lock.hand,
              describedBy: reasonId(lock.hand),
              toggle: props.toggleTile,
            }}
          />
        )}
      </div>
      <div className="gc-message" aria-live="polite">
        <span className="gc-sr">
          {turn}{" "}
          {view.lastSettlement ? `R${view.lastSettlement.round} 정산` : ""}
        </span>
        <span
          id="gc-live-text"
          key={
            notice && message === notice ? view.lastAction?.turnId : "status"
          }
        >
          {compactDeal ? (
            <span role="note" aria-label={message}>
              {dealText(view, true)}
            </span>
          ) : (
            message
          )}
        </span>
      </div>
      <div className="gc-command">
        <span className="gc-self">
          {selfText && (
            <span className={shortSelf ? "gc-sr" : undefined}>나 </span>
          )}
          {selfText} {publicStatus}
        </span>
        {!out && !end && (
          <>
            <span
              className="gc-selected"
              aria-describedby={wide ? "gc-preview" : undefined}
            >
              <span className={wide ? "gc-sr" : undefined}>
                {model.selected.length}장 ·{" "}
                <span id="gc-preview">{summary}</span>
              </span>
              {wide && (
                <span aria-hidden="true" title={summary}>
                  {model.selected.length}장 {describe(result, true)}
                </span>
              )}
            </span>
            <div className="gc-actions">
              <Action
                className="gc-submit"
                reason={lock.play}
                describedBy={reasonId(lock.play)}
                onClick={() => action("play")}
              >
                제출 {model.selected.length}장
              </Action>
              <Action
                className="gc-pass"
                reason={lock.pass}
                describedBy={reasonId(lock.pass)}
                onClick={() => action("pass")}
              >
                패스
              </Action>
            </div>
          </>
        )}
      </div>
      {end && (
        <EndScreen
          view={view}
          seatId={model.seatId}
          reason={turn}
          createRoom={props.createRoom}
          openSettlement={(button) => {
            caller.current = button;
            open("settlement");
            focusPanel.current = true;
          }}
        />
      )}
      {extra && (
        <span id="gc-extra" hidden>
          {extra}
        </span>
      )}
      {panel && (
        <div
          className="gc-panel-slot"
          style={
            wide
              ? {
                  ...box({
                    x: stage.stadium.x - stage.stadium.centerSpacing / 2,
                    y: frame.statusHeight + stage.caption.y,
                    w: stage.stadium.centerSpacing,
                    h: 2 * (stage.stadium.y - stage.caption.y),
                  }),
                  maxHeight: `calc(${layout.felt.y + layout.felt.h - stage.caption.y}px - var(--gc-fallback-height))`,
                }
              : undefined
          }
        >
          <Panel
            compact={!wide}
            kind={panel}
            page={page}
            view={view}
            open={open}
            setPage={(n) => setShown({ kind: panel, page: n })}
            close={close}
          />
        </div>
      )}
    </fieldset>
  );
}
const colors = Object.fromEntries(
  Object.entries(palette).map(([key, rgb]) => [
    `--gc-${key}`,
    `rgb(${rgb.join(",")})`,
  ]),
);
export const GameControls: GameControlsComponent<ReactElement> = (props) => {
  const { view, errorCode } = props.model,
    wide = props.k >= frame.wideMinScale;
  const [previous, setPrevious] = useState(props.model);
  const [announcement, setAnnouncement] = useState("");
  if (previous !== props.model) {
    setPrevious(props.model);
    setAnnouncement(abandonmentNotice(previous, props.model));
  }
  // A cleared view unmounts the board; keep only the committed public action ID for this seat.
  const memory = useRef<{ token: string; turn: number | null } | null>(null);
  const token = props.model.credential?.token;
  useLayoutEffect(() => {
    if (!token || memory.current?.token !== token) memory.current = null;
    if (token && view && props.model.connection === "CONNECTED")
      memory.current = { token, turn: view.lastAction?.turnId ?? null };
  }, [token, view, props.model.connection]);
  const style = {
    ...colors,
    "--gc-unit": wide ? "1px" : `${tile.compactScale}px`,
    "--gc-lift": `${tile.selectedLift * (wide ? 1 : tile.compactScale)}px`,
    "--gc-hit": wide ? `${Math.ceil(44 / props.k)}px` : "44px",
    ...(wide
      ? {
          zoom: props.k,
          width: frame.width,
          height: frame.height,
          "--gc-status": `${frame.statusHeight}px`,
          "--gc-scene": `${frame.sceneHeight}px`,
          "--gc-hand-top": `${sceneZones.hand.y}px`,
          "--gc-message": `${frame.messageHeight}px`,
          "--gc-command": `${frame.commandHeight}px`,
        }
      : {}),
  } as CSSProperties;
  const message =
    outage(props.model) || (errorCode !== null ? errorText(errorCode) : "");
  return (
    <div className={`gc gc-${wide ? "wide" : "compact"}`} style={style}>
      <span className="gc-sr" role="status">
        {announcement}
      </span>
      {!view ? (
        <Entry {...props} message={message} />
      ) : view.phase === "LOBBY" ? (
        <Lobby {...props} view={view} message={message} />
      ) : (
        <Board
          key={token}
          seenTurn={
            memory.current?.token === token ? memory.current?.turn : undefined
          }
          props={props}
          mode={wide ? "wide" : "compact"}
          view={view}
        />
      )}
    </div>
  );
};
