import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as T from "three";
import { frame, palette } from "../../visual/tokens";
import { createGameTable } from "../index";
import type { TableStage } from "../stage";
import { loadLayout, loadView, patch, sheetCells } from "./specimen";

function buildSheet(stage: TableStage) {
  const scene = new T.Scene();
  stage.plane(
    scene,
    { x: 0, y: 0, w: frame.width, h: frame.sceneHeight },
    -200,
    stage.coverage(0, 2),
  );
  for (const { source, dest } of sheetCells)
    stage.plane(scene, dest, 1, stage.atlas, source);
  const image = stage.texture.image;
  if (!(image instanceof HTMLImageElement))
    throw Error("Expected image texture");
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("Cannot read swatches");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  for (const [i, rgb] of Object.values(palette).entries()) {
    let p = 0;
    while (
      p < data.length &&
      !(
        data[p] === rgb[0] &&
        data[p + 1] === rgb[1] &&
        data[p + 2] === rgb[2] &&
        data[p + 3] === 255
      )
    )
      p += 4;
    if (p === data.length) throw Error(`Atlas lacks swatch ${i}`);
    stage.plane(scene, patch(i, 0), 1, stage.coverage(0, i));
    stage.plane(scene, patch(i, 24), 1, stage.atlas, {
      x: (p / 4) % image.width,
      y: Math.floor(p / 4 / image.width),
      w: 1,
      h: 1,
    });
  }
  for (let i = 0; i <= 16; i++)
    stage.plane(scene, patch(i, 48), 1, stage.coverage(0, 0, 1, i / 16));
  return scene;
}
const container = document.getElementById("root");
if (!container) throw Error("Missing root");
const root = createRoot(container);
let current: { stage: TableStage; gl: T.WebGLRenderer; k: number } | undefined;
let frames = 0,
  ready = 0,
  failure = 0,
  sheet: T.Scene | undefined,
  sheetMode = false;
let copied: Uint8Array<ArrayBuffer> | undefined;
const Table = createGameTable({
  observe(stage, gl, k) {
    current = { stage, gl, k };
    frames++;
    if (sheetMode) {
      sheet ??= buildSheet(stage);
      stage.draw(gl, k, sheet);
    }
    const ctx = gl.getContext();
    copied = pixels(ctx.drawingBufferWidth, ctx.drawingBufferHeight, (b) =>
      ctx.readPixels(
        0,
        0,
        ctx.drawingBufferWidth,
        ctx.drawingBufferHeight,
        ctx.RGBA,
        ctx.UNSIGNED_BYTE,
        b,
      ),
    );
  },
});
function show(
  k: number,
  asSheet: boolean,
  selected = false,
  reducedMotion = true,
) {
  sheetMode = asSheet;
  root.render(
    <StrictMode>
      <Table
        view={loadView}
        layout={loadLayout}
        k={k}
        selected={selected ? (loadView.ownHand?.slice(0, 1) ?? []) : []}
        reducedMotion={reducedMotion}
        onReady={() => {
          ready++;
        }}
        onFailure={() => {
          failure++;
        }}
      />
    </StrictMode>,
  );
}
function actual() {
  if (!current) throw Error("Table not ready");
  return current;
}
function pixels(
  w: number,
  h: number,
  read: (buffer: Uint8Array<ArrayBuffer>) => void,
) {
  const data = new Uint8Array(w * h * 4);
  read(data);
  const flip = new Uint8Array(data.length);
  for (let y = 0; y < h; y++)
    flip.set(data.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
  return flip;
}
async function capture() {
  const { gl, stage } = actual();
  const ctx = gl.getContext();
  const logical = pixels(frame.width, frame.sceneHeight, (b) =>
    gl.readRenderTargetPixels(
      stage.target,
      0,
      0,
      frame.width,
      frame.sceneHeight,
      b,
    ),
  );
  const screen = copied;
  if (!screen) throw Error("Frame has not been copied");
  for (const [name, buf] of [
    ["logical", logical],
    ["copy", screen],
  ] as const) {
    const res = await fetch(`/capture/${name}`, { method: "POST", body: buf });
    if (!res.ok) throw Error("Capture storage failed");
  }
  const canvas = gl.domElement;
  const box = canvas.getBoundingClientRect();
  return {
    calls: gl.info.render.calls,
    dither: ctx.isEnabled(ctx.DITHER),
    transform: gl.domElement.style.transform,
    canvas: {
      ariaHidden: canvas.getAttribute("aria-hidden"),
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      width: box.width,
      height: box.height,
    },
    gpu: ctx.getParameter(
      ctx.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL ??
        ctx.RENDERER,
    ),
  };
}
async function timing() {
  const { gl, stage, k } = actual();
  const submit: number[] = [],
    sync: number[] = [];
  let maxCalls = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise(requestAnimationFrame);
    const ms = stage.draw(gl, k, stage.scene, true, i >= 140);
    maxCalls = Math.max(maxCalls, gl.info.render.calls);
    if (i >= 140) sync.push(ms);
    else if (i >= 20) submit.push(ms);
  }
  return { submit, sync, maxCalls };
}
const rejectPreflight = createGameTable({ preflight: () => false });
const rejectFactory = createGameTable({
  preflight: () => true,
  createRenderer: () => {
    throw Error("Injected renderer failure");
  },
});

function fail(mode: string) {
  ready = 0;
  failure = 0;
  if (mode === "loss") {
    const ctx = actual().gl.getContext();
    const extension = ctx.getExtension("WEBGL_lose_context");
    if (!extension) throw Error("Missing WebGL_lose_context");
    extension.loseContext();
    return;
  }
  const FailureTable = mode === "factory" ? rejectFactory : rejectPreflight;
  root.render(
    <FailureTable
      key={mode}
      view={loadView}
      layout={loadLayout}
      k={1}
      selected={[]}
      reducedMotion
      onReady={() => {
        ready++;
      }}
      onFailure={() => {
        failure++;
      }}
    />,
  );
}
Object.assign(window, {
  probe: {
    show,
    fail,
    capture,
    timing,
    status: () => ({
      frames,
      ready,
      failure,
      canvas: !!document.querySelector("canvas"),
      k: current?.k,
      width: current?.gl.domElement.width,
      dpr: devicePixelRatio,
      transform: current?.gl.domElement.style.transform,
    }),
  },
});
show(1, true);
