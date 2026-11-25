import { expect, mock, spyOn, test } from "bun:test";
import type {
  Preview,
  PreviewResult,
  Tile,
} from "@caxio/shared/contracts/domain";
import {
  a4Settlement,
  deadlines,
  dealExamples,
  epoch,
  gameOverExamples,
  lastPlaySequence,
  previewExamples,
  previewRejectionOrder,
  representativeExamples,
  roomCode,
  roomCodeExamples,
  seatReuse,
  spectatorExamples,
  tiedRankingExample,
} from "@caxio/shared/contracts/fixtures";
import {
  ERROR_TEXT,
  type PlayerView,
  UNKNOWN_ERROR_TEXT,
} from "@caxio/shared/contracts/wire";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientModel, GameControlsProps } from "../contracts";
import { atlases, fontFiles, tileRect } from "../visual/assets";
import { handOrder, layout } from "../visual/layout";
import { frame, palette } from "../visual/tokens";
import { GameControls } from "./index";
import { Action, EndScreen, Panel } from "./screens";
import {
  automaticSettlement,
  clockText,
  describe,
  enterCode,
  locks,
  nextFocusSlot,
  nextNotice,
  nextPanel,
  type PanelState,
  passedSeats,
  requestTurn,
  seconds,
  tileName,
} from "./state";
import { Tiles } from "./tiles";

const pair = previewExamples[0];
const lead = deadlines.before.view;
if (lead.phase !== "TURN_ACTIVE") throw Error("expected turn fixture");
const follow = {
  ...lead,
  tableHand: pair.tableHand,
  lastPlay: { turnId: 1, seatId: 2, tiles: pair.tableHand },
  ownHand: pair.selected,
} as const;
const noop = () => {};
const pairPreview: Preview = (selected) =>
  selected === pair.tableHand
    ? { ok: true, kind: "PAIR", representative: { number: 4, suit: 3 } }
    : pair.result;
function props(
  view: PlayerView | null = follow,
  patch: Partial<ClientModel> = {},
  k = 3,
  preview: Preview = pairPreview,
): GameControlsProps {
  const model: ClientModel = {
    view,
    seatId: 0,
    connection: "CONNECTED",
    revision: 1,
    credential: { roomCode, token: "test" },
    pending: null,
    errorCode: null,
    muted: false,
    selected: pair.selected,
    timeAnchor: { serverNow: epoch, receivedAt: performance.now() },
    ...patch,
  };
  return {
    model,
    k,
    preview,
    graphicsReady: true,
    layout: layout(
      view?.seatOrder ?? [],
      model.seatId ?? 0,
      view?.ownHand?.length ?? 0,
      view?.tableHand?.length ?? 0,
    ),
    createRoom: noop,
    joinRoom: noop,
    resume: noop,
    startGame: noop,
    play: noop,
    pass: noop,
    toggleTile: noop,
    setMuted: noop,
  };
}
const render = (p: GameControlsProps) =>
  renderToStaticMarkup(<GameControls {...p} />);
const tags = (html: string, pattern: RegExp) =>
  Array.from(html.matchAll(pattern), (m) => m[0]);
function actionTag(html: string, kind: "submit" | "pass") {
  const tag = html.match(
    new RegExp(`<button[^>]*class="gc-${kind}"[^>]*>`),
  )?.[0];
  if (!tag) throw Error(kind);
  return tag;
}
function expectLock(html: string, tag: string, reason: string) {
  expect(tag).toContain('aria-disabled="true"');
  expect(tag).not.toMatch(/ disabled(?:[ =>])|tabindex="-1"/i);
  const id = tag.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  expect(html).toMatch(new RegExp(`id="${id}"[^>]*>${reason}<`));
}
// Inspect native click callbacks from the same hook-free button components used by the board.
function click(node: ReactNode) {
  if (!isValidElement<{ onClick: () => void }>(node))
    throw Error("expected button");
  node.props.onClick();
}
function handClick(p: GameControlsProps) {
  const { model, preview } = p,
    v = model.view;
  if (!v?.maxNumber || !v.ownHand) throw Error("expected hand");
  const hand = handOrder(v.ownHand, v.maxNumber);
  const reason = locks(
    model,
    preview(model.selected, v.tableHand, v.maxNumber),
    30,
  ).hand;
  const element = Tiles({
    tiles: hand,
    mode: p.k >= frame.wideMinScale ? "wide" : "compact",
    slots: p.layout.hand,
    hand: {
      selected: model.selected,
      reason,
      describedBy: "test-reason",
      toggle: p.toggleTile,
    },
  });
  if (!isValidElement<{ children: ReactNode }>(element))
    throw Error("expected row");
  click(Children.toArray(element.props.children)[0]);
}
const css = await Bun.file(new URL("./controls.css", import.meta.url)).text();

test("server rejection keeps the selected faces and the model error", () => {
  const p = props(follow, { errorCode: "NOT_HIGHER" });
  for (const html of [
    render(p),
    render({ ...p, model: { ...p.model, revision: 2 } }),
  ]) {
    expect(html).toContain(`id="gc-live-text">${ERROR_TEXT.NOT_HIGHER}</span>`);
    expect(tags(html, /aria-pressed="true"/g)).toHaveLength(2);
    expect(tags(html, /aria-live="polite"/g)).toHaveLength(1);
  }
});
test("all wire errors and unknown codes use the entry and game message", () => {
  expect(Object.keys(ERROR_TEXT)).toHaveLength(18);
  for (const [errorCode, message] of [
    ...Object.entries(ERROR_TEXT),
    ["NEW_CODE", UNKNOWN_ERROR_TEXT],
  ]) {
    if (!errorCode || !message) throw Error("missing error");
    const entry = render(
      props(null, { errorCode, connection: "DISCONNECTED", credential: null }),
    );
    expect(entry).toContain(message);
    expect(entry).toContain(">방 만들기<");
    expect(render(props(follow, { errorCode }))).toContain(
      `id="gc-live-text">${message}</span>`,
    );
  }
});
test("opponent turn previews selection and dispatches only tile toggles", () => {
  const toggleTile = mock(noop),
    p = { ...props({ ...follow, currentTurn: 1 }), toggleTile };
  const html = render(p);
  expect(html).toContain("페어 · 달 7");
  expect(html).toContain("3번 · 페어 · 해 4");
  for (const kind of ["submit", "pass"] as const)
    expectLock(html, actionTag(html, kind), "내 차례를 기다려 주세요");
  handClick(p);
  expect(toggleTile).toHaveBeenCalledWith(pair.selected[0]);
});
test("follow permits pass, lead explains the lock, pass labels follow the active trick", () => {
  expect(actionTag(render(props()), "pass")).not.toContain("aria-disabled");
  const html = render(props(lead));
  expectLock(html, actionTag(html, "pass"), "선은 패스할 수 없어요");
  const [before, pass, clear, play] = lastPlaySequence.continuing;
  for (const [snap, expected] of [
    [before, []],
    [pass, [1]],
    [clear, []],
    [play, []],
  ] as const) {
    expect([...passedSeats(snap.view)]).toEqual([...expected]);
    expect(
      tags(render(props(snap.view)), /class="gc-seat-state"[^>]*>패스</g),
    ).toHaveLength(expected.length);
  }
});
test("monotonic deadline, urgent clock and zero are independent of wall time", () => {
  const anchor = { serverNow: epoch, receivedAt: 100 },
    deadline = epoch + 6000;
  for (const offset of [-30000, 30000]) {
    const wall = spyOn(Date, "now").mockReturnValue(epoch + offset);
    try {
      for (const [elapsed, left, text] of [
        [0, 6, "6초"],
        [999, 6, "6초"],
        [1000, 5, "마감 5초"],
        [5500, 1, "마감 1초"],
        [6000, 0, "0초 · 처리 중"],
        [6050, 0, "0초 · 처리 중"],
      ] as const) {
        expect(seconds(deadline, anchor, anchor.receivedAt + elapsed)).toBe(
          left,
        );
        expect(clockText(left)).toBe(text);
      }
    } finally {
      wall.mockRestore();
    }
  }
  for (const n of [4, 0]) {
    const html = render(props({ ...follow, deadline: epoch + n * 1000 }));
    expect(html).toContain("gc-status gc-urgent");
    expect(html).toContain(clockText(n));
    expect(html.match(/class="gc-message".*?<\/div>/)?.[0]).not.toContain(
      clockText(n),
    );
  }
});
test("automatic PLAY and PASS announce once across presence and resume baselines", () => {
  const initial = props(lead).model;
  for (const type of ["PLAY", "PASS"] as const) {
    const m = props({
      ...follow,
      currentTurn: 1,
      turnId: 2,
      lastAction: { type, turnId: 1, automatic: true, seatId: 0 },
    }).model;
    const text = nextNotice(initial, m, "");
    expect(text).toBe(
      type === "PLAY"
        ? "시간 초과로 최저 싱글을 냈어요"
        : "시간 초과로 패스했어요",
    );
    const presence = { ...m, revision: 3 };
    expect(nextNotice(m, presence, text)).toBe(text);
    expect(nextNotice(m, presence, "")).toBe("");
    expect(nextNotice({ ...initial, connection: "RESTORING" }, m, text)).toBe(
      "",
    );
    expect(nextNotice(null, m, "")).toBe("");
  }
});
test("OUT snapshots render public seats and chips without private controls or settlement", () => {
  for (const snap of [
    spectatorExamples.transition,
    spectatorExamples.following,
    spectatorExamples.restored,
    spectatorExamples.gameOver,
  ]) {
    const html = render(
      props(snap.view, { seatId: spectatorExamples.recipient, selected: [] }),
    );
    expect(html).toContain("탈락 · 관전 중");
    expect(html).toContain("1번");
    expect(html).toContain("칩");
    expect(html).toContain('class="gc-center"');
    for (const token of [
      "data-slot=",
      'class="gc-submit"',
      'class="gc-pass"',
      "배(2가",
    ])
      expect(html).not.toContain(token);
  }
});
test("shuffled hand and center bind sorted identities, hit boxes and atlas cells at every N", () => {
  for (const maxNumber of [9, 13, 15] as const) {
    const tiles: Tile[] = [
      { number: 2, suit: 0 },
      { number: maxNumber, suit: 3 },
      { number: 1, suit: 1 },
      { number: 3, suit: 3 },
      { number: 3, suit: 0 },
    ];
    const v = {
      ...follow,
      ownHand: tiles,
      tableHand: tiles.toReversed(),
      lastPlay: { ...follow.lastPlay, tiles },
    };
    const p = props({ ...v, maxNumber }),
      html = render(p),
      sorted = handOrder(tiles, maxNumber);
    for (const [pattern, slots] of [
      [/<button[^>]+data-slot=[^>]+>/g, p.layout.hand],
      [/<span class="gc-tile"[^>]*role="img"[^>]*>/g, p.layout.table],
    ] as const) {
      const nodes = tags(html, pattern);
      expect(nodes).toHaveLength(sorted.length);
      sorted.forEach((t, i) => {
        const r = slots[i];
        if (!r) throw Error("missing slot");
        expect(nodes[i]).toContain(`aria-label="${tileName(t)}"`);
        expect(nodes[i]).toContain(
          `left:${r.x}px;top:${r.y}px;width:28px;height:40px`,
        );
        const cell = tileRect(t.number, t.suit, "wide");
        expect(html).toContain(`background-position:${-cell.x}px ${-cell.y}px`);
      });
    }
  }
});
test("locked native actions stay focusable, describe their reason and dispatch nothing", () => {
  for (const [patch, reason, kinds] of [
    [
      { pending: { type: "PASS", turnId: 1 } },
      "서버 응답 대기",
      ["play", "pass"],
    ],
    [
      {
        timeAnchor: {
          serverNow: follow.deadline,
          receivedAt: performance.now(),
        },
      },
      "시간이 지났어요",
      ["play", "pass"],
    ],
    [{ timeAnchor: null }, "서버 응답 대기", ["play", "pass"]],
    [{ seatId: 1 }, "내 차례를 기다려 주세요", ["play", "pass"]],
    [{ connection: "DISCONNECTED" }, "연결이 끊겼어요", ["play", "pass"]],
    [{ connection: "RESTORING" }, "자리 복구 중", ["play", "pass"]],
    [{ selected: [] }, "패를 골라 주세요", ["play"]],
  ] as const) {
    const result =
      "selected" in patch
        ? ({ ok: false, reason: "EMPTY" } as const)
        : pair.result;
    const send = mock(noop),
      p = { ...props(follow, patch, 3, () => result), toggleTile: send };
    const html = render(p);
    for (const kind of kinds) {
      expectLock(
        html,
        actionTag(html, kind === "play" ? "submit" : "pass"),
        reason,
      );
      click(Action({ children: kind, reason, onClick: send }));
      requestTurn(p.model, result, kind, performance.now(), send);
    }
    if ("pending" in patch || "connection" in patch) {
      for (const tag of tags(html, /<button[^>]*data-slot[^>]*>/g))
        expectLock(html, tag, reason);
      handClick(p);
    }
    expect(send).toHaveBeenCalledTimes(0);
  }
  const p = props(follow, {
    pending: { type: "PASS", turnId: 1 },
    errorCode: "INVALID_MESSAGE",
    connection: "DISCONNECTED",
  });
  expect(render(p)).toContain('id="gc-live-text">연결이 끊겼어요</span>');
});
test("settlement opens through the next deal and first lead remains playable", () => {
  const [, , , paid, next] = lastPlaySequence.continuing;
  const html = render(props(paid.view));
  expect(html).toContain('aria-label="직전 정산"');
  for (const text of [
    "1위 1번 +3칩 → 67칩",
    "2위 2번 0칩 → 64칩",
    "3위 3번 −3칩 → 61칩",
  ])
    expect(html).toContain(text);
  const detail = a4Settlement.details[0];
  expect(html).toContain(
    `남은 ${detail.remaining}장 × 1배(2가 0장) = ${detail.effective}`,
  );
  const nextTurn = {
    ...next.view,
    phase: "TURN_ACTIVE",
    turnId: 64,
    deadline: epoch + 30000,
    currentTurn: 0,
    maxNumber: 9,
    ranking: [],
  } as const;
  const representative = nextTurn.ownHand?.find(
    (t) => t.number === 3 && t.suit === 0,
  );
  if (!representative) throw Error("expected starting tile");
  const selected = [representative],
    single = { ok: true, kind: "SINGLE", representative } as const;
  const p = props(nextTurn, { selected }, 3, () => single),
    first = render(p);
  expect(first).toContain('class="gc-panel"');
  expect(tags(first, /<button[^>]*data-slot[^>]*>/g)).toHaveLength(12);
  expect(actionTag(first, "submit")).not.toContain("aria-disabled");
  expectLock(first, actionTag(first, "pass"), "선은 패스할 수 없어요");
  const send = mock(noop);
  requestTurn(p.model, single, "play", performance.now(), send);
  expect(send).toHaveBeenCalledTimes(1);
  const after = {
    ...nextTurn,
    tableHand: selected,
    lastPlay: { turnId: 64, seatId: 0, tiles: selected },
  } as const;
  expect(automaticSettlement(after)).toBe(false);
  expect(render(props(after))).not.toContain('class="gc-panel"');
});
test("injected preview specimens and all rejection reasons are displayed verbatim", () => {
  const expected = [
    "페어 · 달 7",
    "1·2·3·5장만 낼 수 있어요",
    "바닥보다 높은 조합이 필요해요",
    "트리플 · 3",
    "스트레이트 · 별 2",
  ];
  for (const [i, example] of [
    ...previewExamples,
    ...representativeExamples,
  ].entries()) {
    const { selected, tableHand, result, maxNumber } = example;
    const preview = mock<Preview>((tiles) =>
      tiles === selected ? result : pair.result,
    );
    const html = render(
      props(
        { ...follow, tableHand, ownHand: selected, maxNumber },
        { selected },
        3,
        preview,
      ),
    );
    expect(preview).toHaveBeenCalledWith(selected, tableHand, maxNumber);
    expect(preview).toHaveBeenCalledWith(
      follow.lastPlay.tiles,
      null,
      maxNumber,
    );
    expect(html).toContain(expected[i] ?? "absent");
    expect(actionTag(html, "submit").includes("aria-disabled")).toBe(
      !result.ok,
    );
    if (i === 0) expect(html).toContain(">제출 2장<");
  }
  expect(
    previewRejectionOrder.map((reason) => describe({ ok: false, reason })),
  ).toEqual([
    "패를 골라 주세요",
    "1·2·3·5장만 낼 수 있어요",
    "조합이 아니에요",
    "같은 장수로 내세요",
    "바닥보다 높은 조합이 필요해요",
  ]);
});
test("compact, wide canvas and wide fallback share selection, play and pass", () => {
  for (const [k, graphicsReady, mode] of [
    [0, false, "compact"],
    [1, true, "compact"],
    [3, false, "wide"],
    [3, true, "wide"],
  ] as const) {
    const send = mock(noop),
      p = { ...props(follow, {}, k), graphicsReady, toggleTile: send };
    const html = render(p);
    expect(html).toContain(`class="gc gc-${mode}"`);
    expect(html).toContain(atlases[mode].url);
    expect(html.includes("gc-board gc-opaque")).toBe(
      mode === "compact" || !graphicsReady,
    );
    expect(
      html.includes("그래픽을 사용할 수 없어 기본 화면으로 진행해요"),
    ).toBe(k === 3 && !graphicsReady);
    handClick(p);
    for (const kind of ["play", "pass"] as const) {
      expect(
        actionTag(html, kind === "play" ? "submit" : "pass"),
      ).not.toContain("aria-disabled");
      requestTurn(p.model, pair.result, kind, performance.now(), send);
    }
    expect(send).toHaveBeenCalledTimes(3);
  }
});
test("entry normalizes codes and lobby follows host transfer and start permission", () => {
  for (const input of [
    ...roomCodeExamples.valid,
    ...roomCodeExamples.normalize,
  ]) {
    const join = mock(noop);
    expect(enterCode(input, join)).toBe(true);
    expect(join).toHaveBeenCalledWith(input.trim().toUpperCase());
  }
  for (const input of roomCodeExamples.invalid) {
    if (typeof input === "string") {
      const join = mock(noop);
      expect(enterCode(input, join)).toBe(false);
      expect(join).not.toHaveBeenCalled();
    }
  }
  for (const [v, reason] of [
    [seatReuse.joins[0].view, "한 명 더 필요"],
    [seatReuse.bDisconnected.view, "2번 복귀 대기"],
  ] as const) {
    const html = render(props(v));
    expect(html).toContain(`id="gc-start-reason">${reason}`);
    expect(html).toContain('aria-describedby="gc-start-reason">시작');
    expect(html).toContain(roomCode);
  }
  expect(render(props(seatReuse.aReturned.view, { seatId: 2 }))).toContain(
    'type="button">시작',
  );
  const guest = render(props(seatReuse.aReturned.view, { seatId: 1 }));
  expect(guest).toContain("3번이 방장이에요");
  expect(guest).toContain("방장의 시작을 기다려 주세요");
  expect(guest).not.toContain(">시작<");
});
test("end reason prioritizes the last round, preserves tied ranks and creates a new room", () => {
  for (const { snapshot, reason } of gameOverExamples)
    expect(render(props(snapshot.view))).toContain(
      reason === "LAST_ROUND" ? "마지막 라운드 종료" : "생존자 3명 미만",
    );
  const v = tiedRankingExample.view,
    html = render(props(v));
  expect(html).toMatch(/1위 1번 65칩.*1위 2번 65칩.*3위 3번 62칩/);
  expect(html).toContain(">새 방 만들기<");
  const createRoom = mock(noop),
    end = EndScreen({
      view: v,
      seatId: 0,
      createRoom,
      reason: "마지막 라운드 종료",
      openSettlement: noop,
    });
  if (!isValidElement<{ children: ReactNode }>(end))
    throw Error("missing ranking");
  const actions = Children.toArray(end.props.children).at(-1);
  if (!isValidElement<{ children: ReactNode }>(actions))
    throw Error("missing end actions");
  const newRoom = Children.toArray(actions.props.children).at(-1);
  if (!isValidElement<Parameters<typeof Action>[0]>(newRoom))
    throw Error("missing action");
  click(Action(newRoom.props));
  expect(createRoom).toHaveBeenCalledTimes(1);
});
test("trick clear keeps a sorted text record and the next round retains settlement in the menu", () => {
  const clear = lastPlaySequence.continuing[2].view;
  const html = render(
    props(clear, {}, 3, () => ({
      ok: true,
      kind: "SINGLE",
      representative: { number: 9, suit: 0 },
    })),
  );
  expect(html).toContain("직전 제출 · 1번 · 싱글 · 구름 9");
  expect(html).toMatch(/class="gc-turn"[^>]*>▶ 내 차례 · 선</);
  expect(html).not.toContain('role="img"');
  const next = lastPlaySequence.continuing[4].view;
  expect(render(props(next))).not.toContain("직전 제출 ·");
  const menu = renderToStaticMarkup(
    <Panel
      view={next}
      kind="menu"
      page={0}
      open={noop}
      close={noop}
      setPage={noop}
    />,
  );
  expect(menu).toContain(">직전 정산<");
  expect(menu).toContain(">족보<");
});
test("wide frame and compact wrapping consume the specified slot and control dimensions", () => {
  for (const { view } of dealExamples) {
    const v = { ...view, tableHand: representativeExamples[1].selected },
      p = props(v);
    const html = render(p),
      first = p.layout.hand.at(0),
      last = p.layout.hand.at(-1),
      firstTable = p.layout.table.at(0),
      lastTable = p.layout.table.at(-1);
    if (!first || !last || !firstTable || !lastTable)
      throw Error("missing geometry");
    expect(last.x + last.w - first.x).toBe(
      p.layout.hand.length === 13 ? 388 : 358,
    );
    expect(lastTable.x + lastTable.w - firstTable.x).toBe(148);
    expect(html).toContain("zoom:3;width:416px;height:250px");
    expect(html).toContain(
      `left:${first.x}px;top:151px;width:28px;height:40px`,
    );
    expect(html).toContain(`left:${last.x}px;top:151px;width:28px;height:40px`);
    if (view.seatOrder.length === 5) {
      expect(html).toContain("width:96px;height:16px");
      expect(html).toContain("2번 12장 64칩");
    }
    const compact = render(props(v, {}, 0));
    expect(compact).toContain("width:48px;height:80px");
    expect(compact).toContain("--gc-hit:44px");
  }
  // These flex constraints implement floor((W+2)/50); centered lines shrink to the available width.
  expect(css).toMatch(
    /\.gc-compact \.gc-hand\s*\{[^}]*flex-wrap: wrap;[^}]*gap: 2px;[^}]*max-width: 348px;/,
  );
  expect(css).toMatch(
    /@media \(min-width: 648px\)[\s\S]*?\.gc-compact \.gc-hand\s*\{\s*max-width: 648px/,
  );
  expect(css).toMatch(/\.gc-compact \.gc-time\s*\{[^}]*min-height: 24px/);
  expect(css).toContain("min-height: var(--gc-hit)");
  expect(css).toContain("row-gap: 10px");
  const narrow = Number(css.match(/max-width: (348)px/)?.[1]),
    wide = Number(css.match(/max-width: (648)px/)?.[1]);
  const gap = Number(
    css.match(/flex-wrap: wrap;\s*gap: (2)px;\s*max-width: 348px/)?.[1],
  );
  const cell = Number(
    render(props(dealExamples[1].view, {}, 0)).match(
      /data-slot="0" style="width:(\d+)px/,
    )?.[1],
  );
  for (const [w, expected] of [
    [180, 3],
    [297, 5],
    [298, 6],
    [348, 7],
    [360, 7],
    [647, 7],
    [648, 13],
    [844, 13],
  ] as const) {
    const columns = Math.max(
      1,
      Math.floor((Math.min(w, w >= 648 ? wide : narrow) + gap) / (cell + gap)),
    );
    expect(columns).toBe(expected);
    if (w === 360) expect([columns, 13 - columns]).toEqual([7, 6]);
  }
});
test("text uses the three contrast pairs and the frozen Galmuri font", () => {
  const html = render(props());
  for (const name of ["ink", "paper", "sage", "pine"] as const)
    expect(html).toContain(`--gc-${name}:rgb(${palette[name].join(",")})`);
  expect(css).toContain(`url("${fontFiles[0].url}")`);
  expect(css).toContain("font-display: swap;");
  expect(css).toContain("font-weight: 400;");
  expect(css).toContain("font-style: normal;");
  expect(css).toMatch(/Galmuri11,\s*sans-serif/);
  for (const [, color] of css.matchAll(/(?:^|\n)\s*color:\s*([^;]+);/g))
    expect(["var(--gc-ink)", "var(--gc-paper)"]).toContain(color ?? "");
  const pairs = new Set<string>();
  for (const [, rule] of css.matchAll(/\{([^{}]+)\}/g)) {
    const fg = rule?.match(/(?:^|;)\s*color: var\(--gc-(\w+)\)/)?.[1];
    const bg = rule?.match(/(?:^|;)\s*background: var\(--gc-(\w+)\)/)?.[1];
    if (fg && bg) pairs.add([fg, bg].sort().join("/"));
  }
  expect([...pairs].sort()).toEqual(["ink/paper", "ink/sage", "paper/pine"]);
});
test("deal, mute state, three rule pages and keyboard focus fallback are available", () => {
  for (const { view } of dealExamples) {
    const html = render(props(view, { muted: true }));
    expect(html).toContain(
      `R1 · 숫자 1~${view.maxNumber} · ${view.ownHand?.length}장씩 · 선 1번(구름 3)`,
    );
    expect(html).toContain('aria-pressed="true">무음');
  }
  for (const [page, phrase] of [
    "1·2·3·5장",
    "플러시는 숫자 먼저",
    "남은 장수",
  ].entries()) {
    const html = renderToStaticMarkup(
      <Panel
        view={lead}
        kind="rules"
        page={page}
        open={noop}
        setPage={noop}
        close={noop}
      />,
    );
    expect(html).toContain(phrase);
    expect(html).toContain(`족보 ${page + 1}/3`);
    expect(html).toMatch(/이전.*다음.*닫기/);
  }
  expect(nextFocusSlot(["a", "b", "c", "d", "e"], 2, ["b", "d", "e"])).toBe(1);
  expect(nextFocusSlot(["a", "b", "c"], 2, ["a", "b"])).toBe(1);
  expect(nextFocusSlot(["a"], 0, [])).toBeNull();
});

test("private settlement arithmetic and paged public OUT rows stay separate", () => {
  const survivor = spectatorExamples.survivor.frame.view;
  if (!survivor.ownHand) throw Error("missing private hand");
  const html = render(
    props(
      {
        ...survivor,
        ownSettlement: { round: 1, remaining: 3, twos: 2, effective: 12 },
      },
      { seatId: 1 },
    ),
  );
  expect(html).toContain("남은 3장 × 4배(2가 2장) = 12");
  const pages = [0, 1].map((page) =>
    renderToStaticMarkup(
      <Panel
        view={spectatorExamples.transition.view}
        kind="settlement"
        page={page}
        open={noop}
        close={noop}
        setPage={noop}
      />,
    ),
  );
  expect(pages[0]).toContain("1위");
  expect(pages[0]).not.toContain("4위");
  expect(pages[1]).toContain("4위");
  expect(pages[1]).toContain("탈락 · 다음 판 관전");
  for (const page of pages) expect(page).not.toContain("배(2가");
});
test("a click at the deadline cannot send an action rendered enabled earlier", () => {
  const p = props(follow, {
      timeAnchor: {
        serverNow: epoch,
        receivedAt: Math.floor(performance.now()),
      },
    }),
    anchor = p.model.timeAnchor;
  if (!anchor) throw Error("missing clock");
  const send = mock(noop);
  expect(actionTag(render(p), "submit")).not.toContain("aria-disabled");
  requestTurn(
    p.model,
    pair.result,
    "play",
    anchor.receivedAt + (follow.deadline - anchor.serverNow),
    send,
  );
  expect(send).not.toHaveBeenCalled();
});

function styleRule(selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw Error(`missing CSS rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

test("wide HUD and command cells occupy their exact horizontal intervals", () => {
  const cells = (selector: string, indices: number[]) => {
    const rule = styleRule(selector),
      tracks = rule
        .match(/grid-template-columns: ([^;]+);/)?.[1]
        ?.split(" ")
        .map((n) => Number.parseInt(n, 10));
    if (!tracks) throw Error("missing tracks");
    const gap = Number.parseInt(
        rule.match(/column-gap: (\d+)/)?.[1] ?? "0",
        10,
      ),
      start = Number.parseInt(
        rule.match(/padding-left: (\d+)/)?.[1] ?? "0",
        10,
      );
    return indices.map((i) => [
      start + tracks.slice(0, i).reduce((x, w) => x + w + gap, 0),
      tracks[i],
    ]);
  };
  expect(cells(".gc-wide .gc-status", [0, 1, 2, 3, 4, 6])).toEqual([
    [1, 40],
    [42, 99],
    [142, 139],
    [282, 42],
    [325, 43],
    [370, 44],
  ]);
  expect(styleRule(".gc-wide :where(.gc-status) button:last-child")).toContain(
    "grid-column: 7",
  );
  expect(cells(".gc-wide .gc-command", [0, 2, 4, 6])).toEqual([
    [2, 97],
    [100, 140],
    [243, 101],
    [346, 68],
  ]);
});

test("wide status text stays in its 16px row while k=2 buttons extend their hit height", () => {
  const html = render(props(follow, {}, 2));
  expect(html).toContain("--gc-status:16px");
  expect(html).toContain("--gc-hit:22px");
  expect(styleRule(".gc-wide .gc-status")).toContain(
    "grid-template-rows: var(--gc-status)",
  );
  expect(styleRule(".gc-wide .gc-status button")).toContain(
    "grid-template-rows: var(--gc-status)",
  );
});
test("end screen keeps the full reason in the ranking and clears the message and command rows", () => {
  const html = render(props(gameOverExamples[0].snapshot.view));
  expect(html).toMatch(/class="gc-turn"[^>]*>대국 종료</);
  expect(html).toContain("<strong>마지막 라운드 종료</strong>");
  expect(styleRule(".gc-wide .gc-end").replace(/\s+/g, "")).toContain(
    "bottom:calc(var(--gc-message)+var(--gc-command)+var(--gc-fallback-height))",
  );
});
test("wide felt panels reserve the fallback notice and the panel shadow", () => {
  expect(styleRule(".gc-wide .gc-opaque")).toContain(
    "--gc-fallback-height: 14px",
  );
  expect(styleRule(".gc-wide .gc-panel-slot")).toContain(
    "padding-bottom: calc(var(--gc-fallback-height) + 2px)",
  );
  const paid = lastPlaySequence.continuing[3].view;
  expect(render({ ...props(paid), graphicsReady: false })).toContain(
    "top:calc(144px - var(--gc-fallback-height))",
  );
  expect(
    render({
      ...props(gameOverExamples[0].snapshot.view),
      graphicsReady: false,
    }),
  ).toContain("top:calc(196px - var(--gc-fallback-height))");
});
test("wide lobby fits all five seat columns and preserves whole seat words", () => {
  expect(styleRule(".gc-wide .gc-lobby-seats")).toContain(
    "grid-template-columns: repeat(5, 76px)",
  );
  expect(styleRule(".gc-wide .gc-lobby-seats")).toContain(
    "word-break: keep-all",
  );
  expect(css).toMatch(/\.gc-wide \.gc-lobby \{\s*width: 412px;/);
  expect(render(props(seatReuse.bDisconnected.view))).toContain(
    "2번 복귀 대기",
  );
});

test("compact status, command, end and page buttons use adjacent 2px action groups", () => {
  const groups = (html: string) =>
    Array.from(html.matchAll(/<div class="gc-actions">(.*?)<\/div>/g), (m) =>
      Array.from(
        (m[1] ?? "").matchAll(/<button[^>]*>([^<]*)<\/button>/g),
        (b) => b[1],
      ),
    );
  expect(groups(render(props(follow, {}, 0)))).toEqual([
    ["소리", "메뉴"],
    ["제출 2장", "패스"],
  ]);
  expect(
    groups(render(props(gameOverExamples[0].snapshot.view, {}, 0))),
  ).toContainEqual(["직전 정산", "새 방 만들기"]);
  const panel = renderToStaticMarkup(
    <Panel
      view={follow}
      kind="rules"
      page={1}
      open={noop}
      setPage={noop}
      close={noop}
    />,
  );
  expect(groups(panel)).toEqual([["이전", "다음", "닫기"]]);
  expect(styleRule(".gc-actions")).toContain("gap: 2px");
  expect(styleRule(".gc-actions")).toContain("justify-content: flex-end");
});
test("create room uses the primary ink button on entry and final ranking", () => {
  for (const view of [null, gameOverExamples[0].snapshot.view])
    expect(render(props(view))).toMatch(
      /<button[^>]*class="gc-primary"[^>]*>(?:새 )?방 만들기<\/button>/,
    );
  const style = styleRule(
    '.gc .gc-primary:where(:not([aria-disabled="true"]))',
  );
  expect(style).toContain("color: var(--gc-paper)");
  expect(style).toContain("background: var(--gc-ink)");
});

test("trick clear marks my lead, names another leader and announces the new lead", () => {
  const [, before, clear] = lastPlaySequence.continuing;
  for (const [seatId, turn] of [
    [0, "▶ 내 차례 · 선"],
    [1, "새 선 · 1번"],
  ] as const) {
    const p = props(clear.view, { seatId });
    expect(render(p).match(/class="gc-turn"[^>]*>([^<]+)</)?.[1]).toBe(turn);
    expect(nextNotice(props(before.view, { seatId }).model, p.model, "")).toBe(
      "패스 · 새 선 · 1번",
    );
  }
});
test("continuing and ending snapshots open, retain and close the settlement panel", () => {
  const closed: PanelState = { kind: null, page: 0 },
    opened: PanelState = { kind: "settlement", page: 0 };
  function replay(
    sequence:
      | typeof lastPlaySequence.continuing
      | typeof lastPlaySequence.ending,
  ) {
    let previous: PlayerView | null = null,
      panel = closed;
    return sequence.map(({ view }) => {
      panel = nextPanel(previous, view, panel);
      previous = view;
      return panel;
    });
  }
  expect(replay(lastPlaySequence.continuing)).toEqual([
    closed,
    closed,
    closed,
    opened,
    opened,
  ]);
  expect(replay(lastPlaySequence.ending)).toEqual([closed, opened, closed]);
  const [, , , paid, next] = lastPlaySequence.continuing;
  const firstPlay = {
    ...follow,
    round: 2,
    lastSettlement: next.view.lastSettlement,
  };
  expect(nextPanel(next.view, firstPlay, opened)).toEqual(closed);
  expect(nextPanel(paid.view, { ...paid.view }, closed)).toEqual(closed);
  expect(nextPanel(paid.view, next.view, closed)).toEqual(closed);
  expect(nextPanel(next.view, firstPlay, closed)).toEqual(closed);
  if (paid.view.phase !== "ROUND_SETTLEMENT")
    throw Error("expected settlement fixture");
  const newSettlement = {
    ...paid.view,
    round: 2,
    lastSettlement: { round: 2, results: a4Settlement.results },
  };
  expect(nextPanel(firstPlay, newSettlement, closed)).toEqual(opened);
  expect(
    nextPanel(firstPlay, newSettlement, { kind: "rules", page: 2 }),
  ).toEqual(opened);
  const end = lastPlaySequence.ending[2].view;
  expect(render(props(end))).toContain(">직전 정산</button>");
  expect(nextPanel(end, end, opened)).toEqual(opened);
});
test("Tab order runs from status through the sorted hand and actions to settlement paging", () => {
  const ownHand = lastPlaySequence.continuing[4].view.ownHand;
  if (!ownHand) throw Error("expected a dealt hand");
  const view = {
    ...spectatorExamples.restored.view,
    ownHand: ownHand.toReversed(),
  };
  if (!view.maxNumber) throw Error("expected round maximum");
  const html = render(props(view, { selected: [] }));
  const order = Array.from(
    html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
    ([, attrs, content]) => {
      expect(attrs).not.toMatch(/\sdisabled(?:=|\s|$)|tabindex="-1"/i);
      return attrs?.match(/aria-label="([^"]+)"/)?.[1] ?? content;
    },
  );
  expect(order).toEqual([
    "소리",
    "메뉴",
    ...handOrder(view.ownHand, view.maxNumber).map(tileName),
    "제출 0장",
    "패스",
    "이전",
    "다음",
    "닫기",
  ]);
});
test("entry leaves restoration to the client session", () => {
  for (const connection of ["DISCONNECTED", "RESTORING"] as const) {
    const html = render(props(null, { connection }));
    expect(html).toContain(">방 만들기</button>");
    expect(html).toContain(">입장</button>");
    expect(html).not.toContain(">자리 복구</button>");
    if (connection === "RESTORING") expect(html).toContain("자리 복구 중");
  }
});
test("idle round phases use the server wait lock and a zero-two settlement shows the unit multiplier", () => {
  const [, , , paid, next] = lastPlaySequence.continuing;
  for (const { view } of [paid, next]) {
    const html = render(props(view));
    for (const action of ["submit", "pass"] as const)
      expectLock(html, actionTag(html, action), "서버 응답 대기");
  }
  expect(render(props(paid.view))).toContain("남은 0장 × 1배(2가 0장) = 0");
});

test("wide selection shows short text and preserves the full accessible preview for counts 0 through 13", () => {
  const largestTile = { suit: 0, number: 15 } as const;
  const cases: [PreviewResult, string, string][] = [
    [
      { ok: true, kind: "SINGLE", representative: largestTile },
      "싱글 구름 15",
      "싱글 · 구름 15",
    ],
    [
      { ok: true, kind: "PAIR", representative: largestTile },
      "페어 구름 15",
      "페어 · 구름 15",
    ],
    [
      { ok: true, kind: "TRIPLE", representative: 15 },
      "트리플 15",
      "트리플 · 15",
    ],
    [
      { ok: true, kind: "STRAIGHT", representative: largestTile },
      "스트레이트 구름 15",
      "스트레이트 · 구름 15",
    ],
    [
      { ok: true, kind: "FLUSH", representative: largestTile },
      "플러시 구름 15",
      "플러시 · 구름 15",
    ],
    [
      { ok: true, kind: "FULL_HOUSE", representative: 15 },
      "풀하우스 15",
      "풀하우스 · 15",
    ],
    [
      { ok: true, kind: "FOUR_OF_A_KIND", representative: 15 },
      "포카드 15",
      "포카드 · 15",
    ],
    [
      { ok: true, kind: "STRAIGHT_FLUSH", representative: largestTile },
      "스티플 구름 15",
      "스트레이트 플러시 · 구름 15",
    ],
    [{ ok: false, reason: "EMPTY" }, "패를 골라 주세요", "패를 골라 주세요"],
    [{ ok: false, reason: "COUNT" }, "1·2·3·5장만", "1·2·3·5장만 낼 수 있어요"],
    [
      { ok: false, reason: "ILLEGAL_HAND" },
      "조합이 아니에요",
      "조합이 아니에요",
    ],
    [
      { ok: false, reason: "WRONG_COUNT" },
      "바닥과 같은 장수",
      "같은 장수로 내세요",
    ],
    [
      { ok: false, reason: "NOT_HIGHER" },
      "바닥보다 높게",
      "바닥보다 높은 조합이 필요해요",
    ],
  ];
  const ownHand = Array.from(
    { length: 13 },
    (_, i) => ({ suit: 0, number: i + 1 }) as const,
  );
  const view = { ...follow, maxNumber: 15 as const, ownHand };
  for (const [result, short, full] of cases) {
    for (let n = 0; n <= ownHand.length; n++) {
      const selected = ownHand.slice(0, n);
      // A concurrent wire error occupies the live text, so a selection lock must describe the preview itself.
      const html = render(
        props(view, { selected, errorCode: "STALE_TURN" }, 3, () => result),
      );
      expect(html).toContain(
        `<span aria-hidden="true" title="${full}">${n}장 ${short}</span>`,
      );
      expect(html).toContain(
        `<span class="gc-selected" aria-describedby="gc-preview"><span class="gc-sr">${n}장 · <span id="gc-preview">${full}</span></span>`,
      );
      if (!result.ok) {
        const submit = actionTag(html, "submit");
        expect(submit).toContain('aria-describedby="gc-preview"');
        expectLock(html, submit, full);
      }
    }
    const compact = render(props(view, { selected: ownHand }, 0, () => result));
    expect(compact).toContain(
      `<span>13장 · <span id="gc-preview">${full}</span></span>`,
    );
  }
  expect(styleRule(".gc-wide .gc-command")).toContain(
    "grid-template-rows: var(--gc-command)",
  );
  expect(styleRule(".gc-wide :is(.gc-self, .gc-selected)")).toContain(
    "white-space: nowrap",
  );
});

test("wide self cell preserves seat, balance and pass or spectating status", () => {
  const passed = lastPlaySequence.continuing[1].view;
  const [a, b, c, d, e] = passed.slots;
  if (!b) throw Error("expected a passed seat");
  for (const chips of [0, 9, 10, 99, 100, 320]) {
    const html = render(
      props({ ...passed, slots: [a, { ...b, chips }, c, d, e] }, { seatId: 1 }),
    );
    expect(html).toContain(
      `<span class="gc-self"><span class="gc-sr">나 </span>2번 ${chips}칩 패스</span>`,
    );
    for (const { view } of [
      spectatorExamples.following,
      spectatorExamples.gameOver,
    ]) {
      const [a, b, c, out, e] = view.slots;
      if (!out?.isOut) throw Error("expected an OUT seat");
      const html = render(
        props(
          { ...view, slots: [a, b, c, { ...out, chips }, e] },
          { seatId: 3 },
        ),
      );
      expect(html).toContain(
        `<div class="gc-command"><span class="gc-self"><span>나 </span>4번 ${chips}칩 탈락 · 관전 중</span></div>`,
      );
    }
  }
  expect(styleRule(".gc-wide .gc-self:only-child")).toContain(
    "grid-column: 1 / -1",
  );
});
test("wide caption expands in height inside the felt for a five-tile previous play", () => {
  const tiles = [11, 12, 13, 14, 15].map(
    (number) => ({ number, suit: 0 }) as const,
  );
  const v: PlayerView = {
    ...follow,
    tableHand: null,
    maxNumber: 15,
    lastPlay: { turnId: 1, seatId: 2, tiles },
  };
  const html = render(
    props(v, {}, 3, () => ({
      ok: true,
      kind: "STRAIGHT_FLUSH",
      representative: { number: 15, suit: 0 },
    })),
  );
  const caption = html.match(
    /<span class="gc-caption"[^>]*>[^<]*<\/span>/,
  )?.[0];
  expect(caption).toContain("height:auto");
  expect(caption).toContain("min-height:16px");
  expect(caption).toContain("max-width:416px");
  expect(caption).toContain(
    "직전 제출 · 3번 · 스트레이트 플러시 · 구름 11, 구름 12, 구름 13, 구름 14, 구름 15",
  );
});
