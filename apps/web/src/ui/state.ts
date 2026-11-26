import type {
  HandKind,
  PreviewResult,
  Tile,
} from "@caxio/shared/contracts/domain";
import {
  ABANDONMENT_NOTICE,
  isPlayerName,
  isRoomCode,
  type PlayerView,
} from "@caxio/shared/contracts/wire";
import type { ClientModel } from "../contracts";
import { seatLabel } from "../visual/layout";

const kinds: Record<HandKind, string> = {
  SINGLE: "싱글",
  PAIR: "페어",
  TRIPLE: "트리플",
  STRAIGHT: "스트레이트",
  FLUSH: "플러시",
  FULL_HOUSE: "풀하우스",
  FOUR_OF_A_KIND: "포카드",
  STRAIGHT_FLUSH: "스트레이트 플러시",
};
const reasons = {
  EMPTY: "패를 골라 주세요",
  COUNT: "1·2·3·5장만 낼 수 있어요",
  ILLEGAL_HAND: "조합이 아니에요",
  WRONG_COUNT: "같은 장수로 내세요",
  NOT_HIGHER: "바닥보다 높은 조합이 필요해요",
};
export function tileName(t: Tile) {
  return `${["구름", "별", "달", "해"][t.suit]} ${t.number}`;
}
const shortReasons = {
  ...reasons,
  COUNT: "1·2·3·5장만",
  WRONG_COUNT: "바닥과 같은 장수",
  NOT_HIGHER: "바닥보다 높게",
};
export function describe(result: PreviewResult, short = false) {
  if (!result.ok) return (short ? shortReasons : reasons)[result.reason];
  const kind =
    short && result.kind === "STRAIGHT_FLUSH" ? "스티플" : kinds[result.kind];
  const representative =
    typeof result.representative === "number"
      ? result.representative
      : tileName(result.representative);
  return `${kind}${short ? " " : " · "}${representative}`;
}
/** The seat's name, or seatLabel when it is unnamed or vacant. */
export function seatName(view: PlayerView, id: number) {
  return view.slots[id]?.name ?? seatLabel(id);
}
/** Leaving from an active seat in a running game ends it at once, so the UI confirms first. */
export function confirmsLeave(view: PlayerView, seatId: number | null) {
  const self = seatId === null ? null : view.slots[seatId];
  return (
    view.phase !== "LOBBY" &&
    view.phase !== "GAME_OVER" &&
    !!self &&
    !self.isOut
  );
}
export const nameHint = "이름은 한글·영문·숫자로 6자까지 쓸 수 있어요.";
const nameKey = "caxio.name";
/** The trimmed entry name, undefined when empty, false when the server would reject it. */
export function entryName(input: string): string | undefined | false {
  const name = input.trim();
  return !name ? undefined : isPlayerName(name) ? name : false;
}
// localStorage may be missing or throw; the name is only a convenience.
export function recallName() {
  try {
    return globalThis.localStorage.getItem(nameKey) ?? "";
  } catch {
    return "";
  }
}
export function rememberName(name: string | undefined) {
  try {
    if (name) globalThis.localStorage.setItem(nameKey, name);
    else globalThis.localStorage.removeItem(nameKey);
  } catch {}
}
export async function copyRoomLink(code: string) {
  const link = `${location.origin}/?room=${code}`;
  try {
    await navigator.clipboard.writeText(link);
    return "";
  } catch {
    return link;
  }
}
export function linkedRoom(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("room")?.trim().toUpperCase() ?? null;
}
export function enterCode(input: string, join: (code: string) => void) {
  const code = input.trim().toUpperCase();
  if (!isRoomCode(code)) return false;
  join(code);
  return true;
}
export function submitEntryCode(
  reason: string,
  input: string,
  joinRoom: (code: string) => void,
): boolean | undefined {
  if (reason) return undefined;
  return enterCode(input, joinRoom);
}
export function seconds(
  deadline: number | null,
  anchor: ClientModel["timeAnchor"],
  now: number,
) {
  if (deadline === null || !anchor) return null;
  return Math.ceil(
    Math.max(0, deadline - anchor.serverNow - (now - anchor.receivedAt)) / 1000,
  );
}
export function clockText(left: number) {
  return left === 0
    ? "0초 · 처리 중"
    : left <= 5
      ? `마감 ${left}초`
      : `${left}초`;
}
export function outage(model: ClientModel) {
  if (model.connection === "RESTORING") return "자리 복구 중";
  if (
    (model.view && model.connection !== "CONNECTED") ||
    (model.credential && model.connection === "DISCONNECTED")
  )
    return "연결이 끊겼어요";
  return "";
}
export function locks(
  model: ClientModel,
  result: PreviewResult,
  left: number | null,
) {
  const hand = outage(model) || (model.pending ? "서버 응답 대기" : "");
  const common =
    hand ||
    (model.view?.phase !== "TURN_ACTIVE" || left === null
      ? "서버 응답 대기"
      : left === 0
        ? "시간이 지났어요"
        : model.seatId !== model.view.currentTurn
          ? "내 차례를 기다려 주세요"
          : "");
  const play = common || (!result.ok ? describe(result) : "");
  const pass =
    common || (!model.view?.tableHand ? "선은 패스할 수 없어요" : "");
  return {
    hand,
    play,
    pass,
    standing:
      common ||
      `내 차례 · ${!result.ok && result.reason !== "EMPTY" ? describe(result) : model.view?.tableHand ? "높게 내거나 패스하세요" : "먼저 내세요"}`,
  };
}
export function activate(reason: string, action: () => void) {
  if (!reason) action();
}
export function requestTurn(
  model: ClientModel,
  result: PreviewResult,
  kind: "play" | "pass",
  now: number,
  send: () => void,
) {
  const left = seconds(model.view?.deadline ?? null, model.timeAnchor, now);
  activate(locks(model, result, left)[kind], send);
}
export function passedSeats(view: PlayerView) {
  const passed = new Set<number>();
  if (!view.tableHand || !view.lastPlay || view.currentTurn === null)
    return passed;
  const active = view.seatOrder.filter((id) => view.activePlayers.includes(id));
  const start = active.indexOf(view.lastPlay.seatId);
  for (let i = 1; i <= view.consecutivePasses; i++) {
    const id = active[(start + i) % active.length];
    if (
      id === undefined ||
      id === view.currentTurn ||
      id === view.lastPlay.seatId
    )
      break;
    passed.add(id);
  }
  return passed;
}
export function dealText(view: PlayerView, compact = false) {
  if (view.currentTurn === null) return "";
  if (compact)
    return `R${view.round}/${view.maxRounds} 1~${view.maxNumber} ${view.slots[view.currentTurn]?.remainingTileCount}장씩 선 ${seatName(view, view.currentTurn)} 구름3`;
  return `R${view.round}/${view.maxRounds} · 숫자 1~${view.maxNumber} · ${view.slots[view.currentTurn]?.remainingTileCount}장씩 · 선 ${seatName(view, view.currentTurn)}(구름 3)`;
}
function timeoutNotice(type: "PLAY" | "PASS") {
  return type === "PLAY"
    ? "시간 초과로 최저 싱글을 냈어요"
    : "시간 초과로 패스했어요";
}
export function abandonmentNotice(
  before: ClientModel | null,
  model: ClientModel,
) {
  // SEATED creates a fresh credential object even when restoring the same token.
  return before?.connection === "CONNECTED" &&
    model.connection === "CONNECTED" &&
    before.credential !== null &&
    before.credential === model.credential &&
    before.view &&
    before.view.phase !== "LOBBY" &&
    model.view?.phase === "LOBBY" &&
    model.view.lastGameResult
    ? ABANDONMENT_NOTICE
    : "";
}

export function nextNotice(
  before: ClientModel | null,
  model: ClientModel,
  notice: string,
  seenTurn?: number | null,
) {
  const v = model.view,
    prev = before?.view;
  if (model.connection !== "CONNECTED" || !v) return "";
  if (
    !prev ||
    before?.connection !== "CONNECTED" ||
    before.credential?.token !== model.credential?.token
  ) {
    const action = v.lastAction;
    if (
      action?.automatic &&
      seenTurn !== undefined &&
      seenTurn !== action.turnId
    )
      return timeoutNotice(action.type);
    return v.phase === "ROUND_START" && before?.connection !== "RESTORING"
      ? dealText(v)
      : "";
  }
  const a = v.lastAction;
  if (a && a.turnId !== prev.lastAction?.turnId) {
    if (a.automatic) return timeoutNotice(a.type);
    if (a.type === "PASS")
      return v.tableHand
        ? "패스"
        : `패스 · 새 선 · ${seatName(v, v.currentTurn ?? a.seatId)}`;
  }
  if (v.round !== prev.round && v.currentTurn !== null && !v.lastPlay)
    return dealText(v);
  if (
    v.currentTurn !== prev.currentTurn ||
    (v.turnId !== prev.turnId && prev.phase === "TURN_ACTIVE") ||
    model.errorCode !== before.errorCode ||
    model.pending?.type !== before.pending?.type
  )
    return "";
  return notice;
}
export function automaticSettlement(view: PlayerView | null) {
  return (
    !!view?.lastSettlement &&
    view.phase !== "GAME_OVER" &&
    (view.round === view.lastSettlement.round || !view.lastPlay)
  );
}
export type PanelKind = "menu" | "rules" | "settlement" | "leave";
export type PanelState = { kind: PanelKind | null; page: number };
export function nextPanel(
  previous: PlayerView | null,
  view: PlayerView,
  current: PanelState,
): PanelState {
  if (view.phase === "GAME_OVER" && previous?.phase !== view.phase)
    return { kind: null, page: 0 };
  if (
    automaticSettlement(view) &&
    previous?.lastSettlement?.round !== view.lastSettlement?.round
  )
    return { kind: "settlement", page: 0 };
  if (
    current.kind === "settlement" &&
    automaticSettlement(previous) &&
    !automaticSettlement(view)
  )
    return { kind: null, page: 0 };
  return current;
}
export function nextFocusSlot(
  before: readonly string[],
  index: number,
  after: readonly string[],
) {
  // A single PLAY can remove slots on either side of the focused tile.
  for (const name of before.slice(index)) {
    const target = after.indexOf(name);
    if (target >= 0) return target;
  }
  return after.length ? Math.min(index, after.length - 1) : null;
}
