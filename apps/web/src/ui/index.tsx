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
import {
  Action,
  EndScreen,
  Entry,
  Lobby,
  Panel,
  type PanelKind,
} from "./screens";
import {
  automaticSettlement,
  clockText,
  describe,
  locks,
  nextFocusSlot,
  nextNotice,
  outage,
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
}: {
  props: GameControlsProps;
  view: GameView;
  mode: Mode;
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
    [notice, setNotice] = useState(() => nextNotice(null, model, ""));
  const [panel, setPanel] = useState<PanelKind | null>(() =>
      automaticSettlement(view) ? "settlement" : null,
    ),
    [page, setPage] = useState(0);
  if (old !== model) {
    setOld(model);
    setNotice(nextNotice(old, model, notice));
    if (view.phase === "GAME_OVER" && old.view?.phase !== view.phase)
      setPanel(null);
    else if (
      view.lastSettlement?.round !== old.view?.lastSettlement?.round &&
      automaticSettlement(view)
    ) {
      setPanel("settlement");
      setPage(0);
    } else if (
      panel === "settlement" &&
      automaticSettlement(old.view) &&
      !automaticSettlement(view)
    )
      setPanel(null);
  }
  const focusPanel = useRef(false),
    insidePanel = useRef(false);
  const open = (kind: PanelKind) => {
    focusPanel.current = !!root.current?.querySelector(".gc-panel :focus");
    setPage(0);
    setPanel(kind);
  };
  const close = () => {
    setPanel(null);
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
        ?.querySelector<HTMLButtonElement>(".gc-panel button:not(:disabled)")
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
    !view.tableHand && last && view.currentTurn !== null
      ? `새 선 · ${seatLabel(view.currentTurn)}`
      : "";
  const selfText =
    model.seatId === null
      ? ""
      : `나 ${seatLabel(model.seatId)} ${self?.chips ?? 0}칩`;
  const publicStatus = out
    ? "탈락 · 관전 중"
    : model.seatId !== null && passedSeats(view).has(model.seatId)
      ? "패스"
      : "";
  const message =
    outage(model) ||
    (model.errorCode !== null
      ? errorText(model.errorCode)
      : notice || (out || end ? "" : lock.standing));
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
  const explanation = extra && (
    <aside id="gc-extra" className="gc-extra">
      {extra}
    </aside>
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
          {clear || turn}
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
          {!wide && !panel && explanation}
        </div>
        {wide && opaque && (
          <span
            className="gc-fallback"
            style={{ top: layout.felt.y + layout.felt.h - 14 }}
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
          {message}
        </span>
      </div>
      <div className="gc-command">
        <span className="gc-self">
          {selfText} {publicStatus}
        </span>
        {!out && !end && (
          <>
            <span className="gc-selected">
              {model.selected.length}장 · <span id="gc-preview">{summary}</span>
            </span>
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
          }}
        />
      )}
      {(panel || (wide && extra)) && (
        <div
          className="gc-panel-slot"
          style={
            wide
              ? box({ ...layout.felt, y: frame.statusHeight + layout.felt.y })
              : undefined
          }
        >
          {explanation}
          {panel && (
            <Panel
              kind={panel}
              page={page}
              view={view}
              open={open}
              setPage={setPage}
              close={close}
            />
          )}
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
  const style = {
    ...colors,
    "--gc-unit": wide ? "1px" : `${tile.compactScale}px`,
    "--gc-lift": `${tile.selectedLift * (wide ? 1 : tile.compactScale)}px`,
    "--gc-hit": wide ? `${44 / props.k}px` : "44px",
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
      {!view ? (
        <Entry {...props} message={message} />
      ) : view.phase === "LOBBY" ? (
        <Lobby {...props} view={view} message={message} />
      ) : (
        <Board
          key={props.model.credential?.token}
          props={props}
          mode={wide ? "wide" : "compact"}
          view={view}
        />
      )}
    </div>
  );
};
