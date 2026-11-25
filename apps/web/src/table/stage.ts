import * as T from "three";
import type { Rect, TableProps } from "../contracts";
import { atlases, tileRect } from "../visual/assets";
import {
  bayer,
  feltBands,
  frame,
  palette,
  stage,
  tile,
} from "../visual/tokens";
import {
  advance,
  footprint,
  model,
  pitch,
  type TableModel,
  underline,
  worldAt,
} from "./model";

const { width: W, sceneHeight: H } = frame;
const deck = stage.stadium;
const rim = deck.inkWidth + deck.paperWidth + deck.sageWidth;
const tones = Object.values(palette).map(
  (rgb) => `vec3(${rgb.join(",")})/255.`,
);
const coverageFragment = `
const vec3 tones[8]=vec3[8](${tones.join(",")});
const int ranks[16]=int[16](${bayer.flat().join(",")});
uniform int kind,lo,hi;
uniform float coverage;
varying vec3 point,n;
varying float light;
void main(){
  vec2 pixel=vec2(gl_FragCoord.x,${H}.-gl_FragCoord.y);
  vec2 offset=abs(pixel-vec2(${deck.x},${deck.y}));
  float edge=${deck.halfHeight}.-length(vec2(max(offset.x-${deck.centerSpacing / 2}.,0.),offset.y));
  float felt=edge<${rim + feltBands.outerEnd}. ? ${feltBands.outerCoverage} : edge<${rim + feltBands.middleEnd}. ? ${feltBands.middleCoverage} : ${feltBands.innerCoverage};
  int a=lo,b=hi;
  float c=coverage;
  if(kind==1){
    if(n.z<.5){c=light;}
    else if(edge<${deck.inkWidth}.){b=a=0;}
    else if(edge<${deck.inkWidth + deck.paperWidth}.){b=a=3;}
    else if(edge<${rim}.){b=a=2;}
    else{c=felt;}
  }else if(kind==2){c=light;}
  else if(kind==3){a=b=(n.z<.5 || abs(point.x)>${stage.backMesh.width / 2 - 1}. || abs(point.y)>${stage.backMesh.height / 2 - 1}.)?0:2;}
  else if(kind==4 || kind==5){
    bool inside=abs(point.x)<${tile.wideWidth / 2}. && abs(point.y)<${tile.height / 2}.;
    c=inside?0.:(kind==4?.5:felt*.5);
  }
  ivec2 cell=ivec2(gl_FragCoord.xy)%4;
  gl_FragColor=vec4(tones[c*16.>float(ranks[cell.y*4+cell.x])+.5?b:a],1.);
}`;
const vertex = `varying vec3 point,n;
varying float light;
void main(){
 point=position;n=normal;
 light=clamp(.45+.35*dot(normalize(mat3(modelMatrix)*normal),normalize(vec3(-.4,.7,1.))),0.,1.);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`;
export function cameraForTable() {
  const camera = new T.OrthographicCamera(
    -W / 2,
    W / 2,
    H / 2,
    -H / 2,
    0.1,
    1600,
  );
  camera.position.set(0, 600 * Math.sin(pitch), 600 * Math.cos(pitch));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}
export function atlasUV(rect: Rect, u: number, v: number) {
  return [
    (rect.x + rect.w * u) / atlases.wide.width,
    1 - (rect.y + rect.h * v) / atlases.wide.height,
  ] as const;
}
export class TableStage {
  readonly camera = cameraForTable();
  readonly scene = new T.Scene();
  readonly copyScene = new T.Scene();
  readonly target = new T.WebGLRenderTarget(W, H, {
    colorSpace: T.NoColorSpace,
    minFilter: T.NearestFilter,
    magFilter: T.NearestFilter,
    generateMipmaps: false,
    samples: 0,
    internalFormat: "RGBA8",
  });
  private scale = { value: 1 };
  readonly copy = new T.ShaderMaterial({
    vertexShader: "void main(){gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader:
      "uniform sampler2D source; uniform int k; void main(){gl_FragColor=texelFetch(source,ivec2(gl_FragCoord.xy)/k,0);}",
    uniforms: { source: { value: this.target.texture }, k: this.scale },
    blending: T.NoBlending,
    toneMapped: false,
  });
  readonly atlas: T.MeshBasicMaterial;
  private geometries = new Map<string, T.BufferGeometry>();
  private materials = new Map<string, T.ShaderMaterial>();
  private dynamic = new T.Group();
  private cards: T.Mesh[] = [];
  private state?: TableModel;
  constructor(readonly texture: T.Texture) {
    texture.minFilter = texture.magFilter = T.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = T.NoColorSpace;
    this.atlas = new T.MeshBasicMaterial({
      map: texture,
      alphaTest: 0.5,
      blending: T.NoBlending,
      toneMapped: false,
    });
    this.copyScene.add(
      new T.Mesh(
        this.geometry("copy", () => new T.PlaneGeometry(2, 2)),
        this.copy,
      ),
    );
    this.plane(
      this.scene,
      { x: 0, y: 0, w: W, h: H },
      -300,
      this.coverage(0, 2),
    );
    const shape = new T.Shape(),
      r = deck.halfHeight,
      z = r / Math.sin(pitch),
      half = deck.centerSpacing / 2;
    shape.moveTo(-half, -z);
    shape.lineTo(half, -z);
    shape.absellipse(half, 0, r, z, -Math.PI / 2, Math.PI / 2, false, 0);
    shape.lineTo(-half, z);
    shape.absellipse(-half, 0, r, z, Math.PI / 2, 1.5 * Math.PI, false, 0);
    const body = new T.Mesh(
      this.geometry(
        "deck",
        () =>
          new T.ExtrudeGeometry(shape, {
            depth: 9,
            bevelEnabled: false,
            curveSegments: 10,
          }),
      ),
      this.coverage(1, 0, 1),
    );
    body.rotation.x = -Math.PI / 2;
    body.position.y = -9;
    this.scene.add(body, this.dynamic);
  }
  geometry(key: string, make: () => T.BufferGeometry) {
    let geo = this.geometries.get(key);
    if (!geo) {
      geo = make();
      this.geometries.set(key, geo);
    }
    return geo;
  }
  coverage(kind: number, lo: number, hi = lo, c = 0) {
    const key = [kind, lo, hi, c].join("/");
    let m = this.materials.get(key);
    if (!m) {
      m = new T.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: coverageFragment,
        blending: T.NoBlending,
        toneMapped: false,
        uniforms: {
          kind: { value: kind },
          lo: { value: lo },
          hi: { value: hi },
          coverage: { value: c },
        },
      });
      this.materials.set(key, m);
    }
    return m;
  }
  align(mesh: T.Mesh, x: number, y: number, depth: number) {
    mesh.position
      .set(x - W / 2, H / 2 - y, depth)
      .applyQuaternion(this.camera.quaternion);
    mesh.quaternion.copy(this.camera.quaternion);
  }
  plane(
    parent: T.Object3D,
    rect: Rect,
    depth: number,
    material: T.Material,
    source?: Rect,
  ) {
    const { w, h } = rect;
    const geometry = this.geometry(
      [w, h, source?.x, source?.y, source?.w, source?.h].join("/"),
      () => {
        const geo = new T.PlaneGeometry(w, h),
          uv = geo.getAttribute("uv");
        if (source)
          for (let i = 0; i < uv.count; i++)
            uv.setXY(i, ...atlasUV(source, uv.getX(i), 1 - uv.getY(i)));
        return geo;
      },
    );
    const mesh = new T.Mesh(geometry, material);
    this.align(mesh, rect.x + w / 2, rect.y + h / 2, depth);
    parent.add(mesh);
    return mesh;
  }
  update(props: TableProps) {
    this.state = model(props, this.state);
    this.dynamic.clear();
    this.cards = [];
    for (const rack of this.state.racks) {
      const mesh = new T.Mesh(
        this.geometry(
          "rack",
          () =>
            new T.BoxGeometry(
              stage.rackWidth,
              stage.rackHeight,
              stage.rackDepth,
            ),
        ),
        this.coverage(2, 0, 1),
      );
      mesh.position.set(...worldAt(rack.x, stage.rackCenterY, 1));
      this.dynamic.add(mesh);
      for (let i = 0; i < rack.count; i++) {
        const size = stage.backMesh;
        const back = new T.Mesh(
          this.geometry(
            "back",
            () => new T.BoxGeometry(size.width, size.height, size.depth),
          ),
          this.coverage(3, 0),
        );
        back.rotation.x = size.rotationX;
        back.position.set(
          ...worldAt(
            rack.x + (i - (rack.count - 1) / 2) * stage.backPitch,
            stage.backY + stage.backHeight / 2,
            17 + i * 0.08,
          ),
        );
        this.dynamic.add(back);
      }
    }
    for (const f of this.state.faces) {
      const shadow = footprint(f.slot),
        b = tile.footprint.band;
      this.plane(
        this.dynamic,
        {
          x: shadow.x - b,
          y: shadow.y - b,
          w: shadow.w + 2 * b,
          h: shadow.h + 2 * b,
        },
        100,
        f.hand ? this.coverage(4, 1, 2) : this.coverage(5, 0, 1),
      );
      this.cards.push(
        this.plane(
          this.dynamic,
          f.slot,
          f.hand ? 202 : 201,
          this.atlas,
          tileRect(f.tile.number, f.tile.suit, "wide"),
        ),
      );
      if (f.selected)
        this.plane(this.dynamic, underline(f.slot), 204, this.coverage(0, 0));
    }
  }
  step(dt: number, reduced: boolean) {
    if (!this.state) return false;
    const moving = advance(this.state, dt, reduced);
    for (const [i, f] of this.state.faces.entries()) {
      const mesh = this.cards[i];
      if (mesh)
        this.align(
          mesh,
          Math.round(f.x) + f.slot.w / 2,
          Math.round(f.y - f.lift) + f.slot.h / 2,
          f.hand ? 202 : 201,
        );
    }
    return moving;
  }
  draw(
    renderer: T.WebGLRenderer,
    k: number,
    scene = this.scene,
    measure = false,
    sync = false,
  ) {
    renderer.info.reset();
    this.scale.value = k;
    renderer.setRenderTarget(this.target);
    const start = measure ? performance.now() : 0;
    renderer.render(scene, this.camera);
    const mid = measure ? performance.now() : 0;
    renderer.setRenderTarget(null);
    const next = measure ? performance.now() : 0;
    renderer.render(this.copyScene, this.camera);
    if (sync) {
      const ctx = renderer.getContext();
      ctx.readPixels(
        0,
        0,
        1,
        1,
        ctx.RGBA,
        ctx.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
    }
    if (sync) return performance.now() - start;
    return measure ? mid - start + performance.now() - next : 0;
  }
  dispose() {
    this.target.dispose();
    this.texture.dispose();
    this.atlas.dispose();
    this.copy.dispose();
    for (const g of this.geometries.values()) g.dispose();
    for (const m of this.materials.values()) m.dispose();
  }
}
