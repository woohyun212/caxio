import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Component,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as T from "three";
import type { TableProps } from "../contracts";
import { atlases } from "../visual/assets";
import { frame } from "../visual/tokens";
import { phaseTransform } from "./model";
import { TableStage } from "./stage";

export interface TableDependencies {
  preflight(canvas: HTMLCanvasElement): boolean;
  createRenderer(canvas: HTMLCanvasElement): T.WebGLRenderer;
  observe?(stage: TableStage, renderer: T.WebGLRenderer, k: number): void;
}
const defaults: TableDependencies = {
  preflight: (canvas) =>
    !!canvas.getContext("webgl2", { alpha: false, antialias: false }),
  createRenderer: (canvas) =>
    new T.WebGLRenderer({ canvas, alpha: false, antialias: false }),
};

export class TableLifecycle {
  failed = false;
  displayed = false;
  constructor(private callbacks: Pick<TableProps, "onFailure" | "onReady">) {}
  failure = () => {
    if (!this.failed) {
      this.failed = true;
      this.callbacks.onFailure();
    }
  };
  ready = () => {
    if (!this.failed && !this.displayed) {
      this.displayed = true;
      this.callbacks.onReady();
    }
  };
  watchContext(canvas: EventTarget) {
    const lost = (event: Event) => {
      event.preventDefault();
      this.failure();
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => canvas.removeEventListener("webglcontextlost", lost);
  }
  renderer(canvas: HTMLCanvasElement, deps: TableDependencies) {
    try {
      if (!deps.preflight(canvas)) throw Error("WebGL2 unavailable");
      return deps.createRenderer(canvas);
    } catch (error) {
      this.failure();
      throw error;
    }
  }
}
class Boundary extends Component<
  { failure: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.failure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
function Draw({
  table,
  life,
  deps,
}: {
  table: TableProps;
  life: TableLifecycle;
  deps: TableDependencies;
}) {
  const { invalidate, gl } = useThree();
  const stage = useRef<TableStage | null>(null);
  const current = useRef(table);
  const displayFrame = useRef(0);
  const moving = useRef(false);
  const updatedAt = useRef(0);
  useLayoutEffect(() => {
    const previous = current.current;
    current.current = table;
    if (stage.current) {
      try {
        if (
          previous.view !== table.view ||
          previous.layout !== table.layout ||
          previous.selected !== table.selected
        )
          stage.current.update(table);
        updatedAt.current = performance.now();
        invalidate();
      } catch {
        life.failure();
      }
    }
  }, [table, life, invalidate]);
  useEffect(() => {
    let live = true;
    new T.TextureLoader().load(
      atlases.wide.url,
      (texture) => {
        if (!live) {
          texture.dispose();
          return;
        }
        try {
          stage.current = new TableStage(texture);
          stage.current.update(current.current);
          invalidate();
        } catch {
          life.failure();
        }
      },
      undefined,
      () => {
        if (live) life.failure();
      },
    );
    return () => {
      live = false;
      cancelAnimationFrame(displayFrame.current);
      displayFrame.current = 0;
      stage.current?.dispose();
      stage.current = null;
    };
  }, [invalidate, life]);
  useFrame((_, delta) => {
    if (!stage.current || life.failed) return;
    try {
      const dt = moving.current
        ? delta
        : (performance.now() - updatedAt.current) / 1000;
      moving.current = stage.current.step(dt, table.reducedMotion);
      stage.current.draw(gl, table.k);
      deps.observe?.(stage.current, gl, table.k);
      if (!life.displayed && !displayFrame.current)
        displayFrame.current = requestAnimationFrame(life.ready);
      if (moving.current) invalidate();
    } catch {
      life.failure();
    }
  }, 1);
  return null;
}
function Table({
  props,
  deps,
}: {
  props: TableProps;
  deps: TableDependencies;
}) {
  const [failed, setFailed] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const [life] = useState(
    () =>
      new TableLifecycle({
        onReady: () => latest.current.onReady(),
        onFailure: () => {
          setFailed(true);
          latest.current.onFailure();
        },
      }),
  );
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    if (!canvas) return;
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";
    const unwatch = life.watchContext(canvas);
    let media: MediaQueryList;
    const update = () => {
      media?.removeEventListener("change", update);
      canvas.style.imageRendering = "pixelated";
      canvas.style.transform = phaseTransform(props.k, window.devicePixelRatio);
      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", update);
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      unwatch();
    };
  }, [canvas, props.k, life]);
  const { view, layout, selected, k, reducedMotion } = props;
  const visual = useMemo(
    () => ({
      view,
      layout,
      selected,
      k,
      reducedMotion,
      onReady: life.ready,
      onFailure: life.failure,
    }),
    [view, layout, selected, k, reducedMotion, life],
  );
  if (failed) return null;
  return (
    <Boundary failure={life.failure}>
      <Canvas
        ref={setCanvas}
        aria-hidden="true"
        style={{
          width: frame.width * props.k,
          height: frame.sceneHeight * props.k,
          pointerEvents: "none",
        }}
        dpr={1}
        flat
        frameloop="demand"
        gl={(options) => {
          if (!(options.canvas instanceof HTMLCanvasElement))
            throw Error("Expected HTML canvas");
          const gl = life.renderer(options.canvas, deps);
          const ctx = gl.getContext();
          ctx.disable(ctx.DITHER);
          gl.info.autoReset = false;
          return gl;
        }}
      >
        <Draw table={visual} deps={deps} life={life} />
      </Canvas>
    </Boundary>
  );
}
export function createGameTable(overrides: Partial<TableDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  return (props: TableProps) => <Table props={props} deps={deps} />;
}
export const GameTable = createGameTable();
