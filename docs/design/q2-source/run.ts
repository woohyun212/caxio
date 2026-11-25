import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import overrides from "./overrides.json";
import provenance from "./raw/provenance.json";

process.chdir(import.meta.dir);
const palette = [
  "#152B26",
  "#385747",
  "#829769",
  "#DCE7B1",
  "#2A78B8",
  "#57307A",
  "#B26E00",
  "#A12B1C",
];
const [ink, pine, sage, paper] = [1, 2, 3, 4];
function linearRGB(hex: string) {
  return [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}
function dot(a: number[], b: number[]) {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}
const luminance = palette.map((c) =>
  dot(linearRGB(c), [0.2126, 0.7152, 0.0722]),
);
function paletteChecks() {
  function contrast(i: number, j: number) {
    const a = luminance[i - 1],
      b = luminance[j - 1];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  const hud = [
    contrast(ink, paper),
    contrast(paper, pine),
    contrast(ink, sage),
  ];
  const suitContrast = [5, 6, 7, 8].map((i) => contrast(i, paper));
  assert(
    hud.every((v) => v >= 4.5) &&
      hud[0] >= 7 &&
      suitContrast.every((v) => v >= 3),
  );
  // Machado et al., 2009. Full severity, display-clipped linear sRGB, D65 Lab.
  const matrices = [
    [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.01182, 0.04294, 0.968881],
    ],
    [
      [1.255528, -0.076749, -0.178779],
      [-0.078411, 0.930809, 0.147602],
      [0.004733, 0.691367, 0.3039],
    ],
  ];
  const cvd = matrices.map((m) => {
    const labs = palette.slice(4).map((hex) => {
      const rgb = m.map((row) =>
        Math.max(0, Math.min(1, dot(row, linearRGB(hex)))),
      );
      const xyz = [
        dot(rgb, [0.4124564, 0.3575761, 0.1804375]) / 0.95047,
        dot(rgb, [0.2126729, 0.7151522, 0.072175]),
        dot(rgb, [0.0193339, 0.119192, 0.9503041]) / 1.08883,
      ];
      const [x, y, z] = xyz.map((v) =>
        v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29,
      );
      return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    });
    const delta = (a: number, b: number) =>
      Math.hypot(...labs[a].map((v, i) => v - labs[b][i]));
    const minimum = Math.min(
      ...labs.flatMap((_, i) =>
        labs.slice(i + 1).map((_, j) => delta(i, i + j + 1)),
      ),
    );
    assert(minimum >= 20);
    return { minimum, starSun: delta(1, 3) };
  });
  return { hud, suitContrast, cvd };
}
const ranks = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const manifest: Record<string, object> = {};
class Raster {
  pixels: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    color = 0,
  ) {
    this.pixels = new Uint8Array(w * h).fill(color);
  }
  get(x: number, y: number) {
    return this.pixels[y * this.w + x];
  }
  rect(x: number, y: number, w: number, h: number, color: number) {
    assert(x >= 0 && y >= 0 && x + w <= this.w && y + h <= this.h);
    for (let row = y; row < y + h; row++)
      this.pixels.fill(color, row * this.w + x, row * this.w + x + w);
  }
  blit(src: Raster, x: number, y: number, scale = 1, tint = 0) {
    for (let j = 0; j < src.h; j++)
      for (let i = 0; i < src.w; i++) {
        const c = src.get(i, j);
        if (c) this.rect(x + i * scale, y + j * scale, scale, scale, tint || c);
      }
  }
  png(colors = palette) {
    // Filter 0 and one byte per palette index keep encoding independent of browser versions.
    function chunk(type: string, bytes: Buffer) {
      const body = Buffer.concat([Buffer.from(type), bytes]);
      const len = Buffer.alloc(4),
        sum = Buffer.alloc(4);
      len.writeUInt32BE(bytes.length);
      sum.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, sum]);
    }
    const hdr = Buffer.alloc(13);
    hdr.writeUInt32BE(this.w);
    hdr.writeUInt32BE(this.h, 4);
    hdr[8] = 8;
    hdr[9] = 3;
    const lines = Buffer.alloc((this.w + 1) * this.h);
    for (let y = 0; y < this.h; y++)
      lines.set(
        this.pixels.subarray(y * this.w, (y + 1) * this.w),
        y * (this.w + 1) + 1,
      );
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", hdr),
      chunk(
        "PLTE",
        Buffer.from(`000000${colors.map((c) => c.slice(1)).join("")}`, "hex"),
      ),
      chunk("tRNS", Buffer.from([0])),
      chunk("IDAT", deflateSync(lines, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
  save(name: string) {
    writeFileSync(`outputs/${name}.png`, this.png());
  }
}
mkdirSync("outputs", { recursive: true });
const profile = mkdtempSync(join(import.meta.dir, ".chrome-"));
const chrome = Bun.spawn(
  [
    process.env.CHROME_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "--headless",
    "--disable-gpu",
    "--disable-lcd-text",
    "--disable-font-subpixel-positioning",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
async function connect() {
  const active = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(active); i++) await Bun.sleep(50);
  const port = readFileSync(active, "utf8").split("\n")[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(
    tabs.find((tab: { type: string }) => tab.type === "page")
      .webSocketDebuggerUrl,
  );
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map<
    number,
    (r: {
      result: Record<string, unknown>;
      error?: { message: string };
    }) => void
  >();
  socket.onmessage = ({ data }) => {
    const r = JSON.parse(String(data));
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  };
  return async function command(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const key = ++id;
    return new Promise((resolve, reject) => {
      pending.set(key, (r) =>
        r.error ? reject(new Error(r.error.message)) : resolve(r.result),
      );
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  };
}
type Command = Awaited<ReturnType<typeof connect>>;
let command: Command;
async function evaluate<T>(expression: string): Promise<T> {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw Error(JSON.stringify(result.exceptionDetails));
  return (result.result as { value: T }).value;
}
function dataURL(path: string, mime = "image/png") {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}
async function decode(url: string) {
  return evaluate<{ w: number; h: number; data: string }>(`(async()=>{
    const img=new Image();img.src=${JSON.stringify(url)};await img.decode();
    const c=document.createElement("canvas");c.width=img.width;c.height=img.height;
    const ctx=c.getContext("2d");ctx.drawImage(img,0,0);
    const rgba=ctx.getImageData(0,0,c.width,c.height).data;
    let binary="";for(let i=0;i<rgba.length;i+=8192) binary+=String.fromCharCode(...rgba.subarray(i,i+8192));
    return {w:c.width,h:c.height,data:btoa(binary)}
  })()`);
}
type Edit = { cell: string; x: number; y: number; value: number };
const metrics: Record<
  string,
  { foreground: number; overrides: number; minRuns?: number[] }
> = {};
async function clean(
  id: string,
  cols: number,
  rows: number,
  w: number,
  h: number,
) {
  const src = await decode(dataURL(`raw/${id}.png`));
  assert.deepEqual(
    [src.w, src.h],
    provenance.find((item) => item.id === id)?.size,
  );
  const rgba = Buffer.from(src.data, "base64");
  function black(x: number, y: number) {
    const i = 4 * (y * src.w + x);
    return rgba[i] + rgba[i + 1] + rgba[i + 2] < 384;
  }
  const rawIdentities = new Set<string>();
  const cells: Raster[] = [];
  for (let k = 0; k < cols * rows; k++) {
    const x0 = Math.floor(((k % cols) * src.w) / cols),
      x1 = Math.floor((((k % cols) + 1) * src.w) / cols);
    const y0 = Math.floor((Math.floor(k / cols) * src.h) / rows),
      y1 = Math.floor(((Math.floor(k / cols) + 1) * src.h) / rows);
    let left = x1,
      right = x0,
      top = y1,
      bottom = y0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (black(x, y)) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    assert(right >= left && bottom >= top, `${id} empty crop`);
    const cell = new Raster(w, h),
      sx = (right - left + 1) / w,
      sy = (bottom - top + 1) / h;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const a = left + i * sx,
          b = left + (i + 1) * sx,
          c = top + j * sy,
          d = top + (j + 1) * sy;
        let area = 0;
        for (let y = Math.floor(c); y < Math.ceil(d); y++)
          for (let x = Math.floor(a); x < Math.ceil(b); x++)
            if (black(x, y))
              area +=
                (Math.min(b, x + 1) - Math.max(a, x)) *
                (Math.min(d, y + 1) - Math.max(c, y));
        cell.pixels[j * w + i] = Number(area >= (sx * sy) / 2);
      }
    if (id === "digits")
      assert(
        Math.min(runs(cell, false), runs(cell, true)) >= 2,
        `raw digit strokes ${k}`,
      );
    if (id === "suits" && k === 3)
      assert.equal(islands(cell).length, 9, "raw sun rays");
    const key = `${id}-${k}`,
      foreground = cell.pixels.reduce((a, b) => a + b, 0);
    const identity = cell.pixels.join("");
    assert(!rawIdentities.has(identity), `${id} duplicate raw mask`);
    rawIdentities.add(identity);
    const changes = (overrides as Edit[]).filter((e) => e.cell === key);
    assert(
      changes.length <= Math.floor(foreground / 10),
      `${key} override cap`,
    );
    metrics[key] = { foreground, overrides: changes.length };
    for (const e of changes) {
      assert(
        Number.isInteger(e.x) &&
          Number.isInteger(e.y) &&
          [0, 1].includes(e.value) &&
          cell.get(e.x, e.y) !== e.value,
      );
      cell.rect(e.x, e.y, 1, 1, e.value);
    }
    assert(cell.pixels.some(Boolean));
    cells.push(cell);
  }
  const strip = new Raster(w * cells.length, h);
  cells.forEach((c, i) => {
    strip.blit(c, i * w, 0);
  });
  strip.save(`mask-${id}`);
  assert.equal(new Set(cells.map((c) => c.pixels.join(""))).size, cells.length);
  return cells;
}
function runs(c: Raster, vertical: boolean) {
  let minimum = Infinity;
  for (let line = 0; line < (vertical ? c.w : c.h); line++) {
    let length = 0;
    for (let i = 0; i <= (vertical ? c.h : c.w); i++) {
      if (
        i < (vertical ? c.h : c.w) &&
        (vertical ? c.get(line, i) : c.get(i, line))
      )
        length++;
      else if (length) {
        minimum = Math.min(length, minimum);
        length = 0;
      }
    }
  }
  return minimum;
}
function islands(c: Raster) {
  const remaining = new Set<number>();
  c.pixels.forEach((v, i) => {
    if (v) remaining.add(i);
  });
  const sizes: number[] = [];
  while (remaining.size) {
    const start = remaining.values().next().value as number,
      queue = [start];
    remaining.delete(start);
    for (let i = 0; i < queue.length; i++) {
      const pos = queue[i],
        x = pos % c.w,
        y = Math.floor(pos / c.w);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= c.w || y + dy < 0 || y + dy >= c.h)
            continue;
          const n = (y + dy) * c.w + x + dx;
          if (remaining.delete(n)) queue.push(n);
        }
    }
    sizes.push(queue.length);
  }
  return sizes.sort((a, b) => b - a);
}
function face(
  w: number,
  n: number,
  suit: number,
  digits: Raster[],
  suits: Raster[],
) {
  const c = new Raster(w, 40);
  c.rect(1, 0, w - 2, 40, ink);
  c.rect(0, 1, w, 38, ink);
  c.rect(1, 1, w - 2, 34, paper);
  c.rect(1, 36, w - 2, 3, pine);
  const numbers = String(n).split("").map(Number);
  numbers.forEach((v, i) => {
    c.blit(
      digits[v],
      Math.floor((w - (numbers.length * 10 - 1)) / 2) + i * 10,
      3,
    );
  });
  c.blit(suits[suit], (w - 16) / 2, 19, 1, 5 + suit);
  assert(
    [...c.pixels].every((v) => [0, ink, pine, paper, 5 + suit].includes(v)),
  );
  return c;
}
function rear(mark: Raster) {
  const c = new Raster(20, 26, ink);
  c.rect(1, 1, 18, 24, pine);
  c.rect(2, 2, 16, 21, sage);
  for (let y = 2; y < 23; y++)
    for (let x = 2; x < 18; x++)
      if ((x === 2 || x === 17 || y === 2 || y === 22) && (x + y) % 2 === 0)
        c.rect(x, y, 1, 1, paper);
  c.blit(mark, 4, 6, 1, ink);
  return c;
}
function emit(name: string, c: Raster, layout: string) {
  c.save(name);
  const allowed = [...new Set(c.pixels)]
    .filter(Boolean)
    .sort()
    .map((i) => palette[i - 1]);
  manifest[`${name}.png`] = {
    width: c.w,
    height: c.h,
    layout,
    allowed,
    alpha: c.pixels.includes(0) ? [0, 255] : [255],
    bytes: c.png().length,
  };
}
function atlases(digits: Raster[], suits: Raster[], mark: Raster) {
  for (const w of [28, 24]) {
    const name = w === 28 ? "wide" : "compact";
    const atlas = new Raster(w * 15, w === 28 ? 186 : 160),
      contact = new Raster(15 * (w + 2) + 2, 202, sage);
    const distinct = new Set<string>();
    for (let s = 0; s < 4; s++)
      for (let n = 1; n <= 15; n++) {
        const c = face(w, n, s, digits, suits);
        distinct.add(c.pixels.join(""));
        atlas.blit(c, (n - 1) * w, s * 40);
        contact.blit(c, 2 + (n - 1) * (w + 2), 2 + s * 42);
      }
    assert.equal(distinct.size, 60);
    const back = rear(mark);
    if (w === 28) atlas.blit(back, 0, 160);
    contact.blit(back, 2, 172);
    if (w === 28) {
      // A diagnostic removes the hue cue entirely and keeps each silhouette at 1x.
      const mono = new Raster(contact.w, contact.h);
      mono.pixels.set(contact.pixels.map((v) => (v >= 5 ? ink : v)));
      mono.save("contact-shapes-1x");
      const gray = luminance.map((v) => {
        const srgb =
          v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return `#${Math.round(srgb * 255)
          .toString(16)
          .padStart(2, "0")
          .repeat(3)}`;
      });
      writeFileSync("outputs/contact-gray-1x.png", contact.png(gray));
    }
    emit(
      `atlas-${name}`,
      atlas,
      "15 columns (1..15), 4 rows (cloud, star, moon, sun); cell " +
        w +
        "x40" +
        (w === 28 ? "; back (0,160,20,26)" : ""),
    );
    for (const k of [1, 2, 3, 4]) {
      const sheet = new Raster(contact.w * k, contact.h * k);
      sheet.blit(contact, 0, 0, k);
      sheet.save(`contact-${name}-${k}x`);
    }
  }
  for (let n = 0; n <= 16; n++)
    assert.equal(ranks.filter((v) => v < n).length, n);
  for (const n of [2, 5, 8]) {
    const c = new Raster(4, 4, ink);
    ranks.forEach((v, i) => {
      if (v < n) c.pixels[i] = pine;
    });
    emit(`bayer-${n}`, c, `${n}/16 pine, top-left origin`);
  }
}

type Tile = readonly [number, number];
const hand: Tile[] = [
  [3, 0],
  [4, 2],
  [5, 1],
  [6, 3],
  [7, 0],
  [7, 2],
  [9, 3],
  [10, 1],
  [11, 3],
  [12, 0],
  [1, 2],
  [2, 1],
];
const straight: Tile[] = [
  [3, 2],
  [4, 1],
  [5, 3],
  [6, 0],
  [7, 1],
];
const pair: Tile[] = [
  [4, 0],
  [4, 3],
];
const cssColor = (i: number) => palette[i - 1];
const inkCSS = cssColor(ink);
function scene(faces: Tile[], played: Tile[]) {
  const bg = new Raster(416, 196, sage);
  function cover(x: number, y: number, c: number, dark: number, light: number) {
    return ranks[(y % 4) * 4 + (x % 4)] + 0.5 < c ? light : dark;
  }
  for (let y = 0; y < 98; y++)
    for (let x = 0; x < 416; x++) {
      const dx = Math.max(52 - x, x - 363, 0),
        dy = y - 48.5;
      const depth = 46 - Math.hypot(dx, dy);
      if (depth < 0) continue;
      const atY = y + 46;
      const tone =
        depth < 1
          ? ink
          : depth < 2
            ? paper
            : depth < 4
              ? sage
              : depth < 5
                ? ink
                : cover(x, atY, depth < 17 ? 2 : depth < 33 ? 5 : 8, ink, pine);
      bg.rect(x, atY, 1, 1, tone);
    }
  // Straight-on projected feet share the texel phase of the whole scene.
  function shadow(x: number, y: number, w: number, felt: boolean) {
    for (let j = -1; j < 4; j++)
      for (let i = -1; i <= w; i++) {
        const edge = i === -1 || i === w || j === -1 || j === 3;
        const depth =
          46 -
          Math.hypot(Math.max(52 - x - i, x + i - 363, 0), y + j - 46 - 48.5);
        const coverage = depth < 17 ? 2 : depth < 33 ? 5 : 8;
        const color = felt
          ? cover(x + i, y + j, edge ? coverage / 2 : 0, ink, pine)
          : cover(x + i, y + j, edge ? 8 : 0, pine, sage);
        bg.rect(x + i, y + j, 1, 1, color);
      }
  }
  played.forEach((_, i) => {
    shadow((416 - (played.length * 30 - 2)) / 2 + i * 30, 123, 28, true);
  });
  faces.forEach((_, i) => {
    shadow((416 - (faces.length * 30 - 2)) / 2 + i * 30, 189, 28, false);
  });
  return `data:image/png;base64,${bg.png().toString("base64")}`;
}
type Box = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  size?: number;
  fg?: number;
  bg?: number;
  style?: string;
  button?: boolean;
  layer?: boolean;
  tile?: boolean;
  selected?: boolean;
};
function layout(
  width: number,
  height: number,
  players: number,
  compact: boolean,
  stress = false,
) {
  const five = players === 5;
  const faces = [...hand];
  if (!five) faces.splice(10, 0, [13, 3]);
  const played = five ? straight : pair;
  const counts = five ? [12, 12, 12, stress ? 12 : 7] : [13, 13, 11];
  const chips = five ? [101, 50, 63, 42] : [101, 49, 42];
  const caption = five ? "5번 · 스트레이트 · 별 7" : "4번 · 페어 · 해 4";
  const turn = five ? "2번 차례 · 받기" : "▶ 내 차례 · 받기";
  const message = five ? "내 차례가 아니에요" : "7 페어를 낼 수 있어요";
  const boxes: Box[] = [];
  function box(
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    options: Partial<Box> = {},
  ) {
    boxes.push({ name, x, y, w, h, ...options });
  }
  function band(name: string, y: number, h: number, bg: number) {
    box(name, 0, y, width, h, { bg, layer: true });
  }
  function txt(
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    fg = ink,
    bg?: number,
    size = 12,
    button = false,
  ) {
    box(text, x, y, w, h, { text, fg, bg, size, button });
  }
  const cellWidth = compact ? 24 : 28,
    k = compact ? 2 : 1;
  const atlas = dataURL(`outputs/atlas-${compact ? "compact" : "wide"}.png`);
  const sprite = (x: number, y: number) =>
    `background-image:url('${atlas}');background-size:${cellWidth * 15 * k}px ${(compact ? 160 : 186) * k}px;background-position:-${x * k}px -${y * k}px;image-rendering:pixelated`;
  function tiles(list: Tile[], startY: number, columns: number, own: boolean) {
    for (let row = 0; row < Math.ceil(list.length / columns); row++) {
      const group = list.slice(row * columns, (row + 1) * columns);
      const cw = cellWidth * k,
        startX = Math.floor((width - ((cw + 2) * group.length - 2)) / 2);
      group.forEach(([n, s], i) => {
        const x = startX + i * (cw + 2),
          y = startY + row * 90;
        const selected = own && n === 7;
        const name = `${(own ? "hand-" : "table-") + n}-${s}`;
        if (selected)
          box(`${name}-line`, x, y + 40 * k - 2 * k, cw, 2 * k, { bg: ink });
        box(name, x, y - (selected ? 5 * k : 0), cw, 40 * k, {
          tile: true,
          selected,
          button: own,
          style: sprite((n - 1) * cellWidth, s * 40),
        });
      });
    }
  }
  if (!compact) {
    box("floor", 0, 16, 416, 196, {
      layer: true,
      style: `background-image:url('${scene(faces, played)}')`,
    });
    band("status", 0, 16, paper);
    txt("caxio", 1, 0, 40, 16);
    txt(turn, 42, 0, 99, 16, paper, ink);
    txt("18초 · 초과 시 패스", 142, 0, 139, 16);
    txt("R2/5", 282, 0, 42, 16);
    txt("소리", 325, 0, 43, 16, paper, pine, 12, true);
    txt("메뉴", 370, 0, 44, 16, paper, pine, 12, true);
    const col = Math.floor(width / counts.length),
      inset = Math.floor((width - col * counts.length) / 2);
    counts.forEach((count, i) => {
      const stack = 20 + 6 * (count - 1),
        left = inset + i * col + Math.floor((col - stack) / 2);
      box(`rack-${i}`, left - 2, 43, stack + 4, 3, { bg: pine });
      // Stacks are the single intentional sprite-to-sprite overlap.
      box(`stack-${i}`, left, 17, stack, 26, {
        style: "display:flex",
        layer: false,
      });
      for (let j = 0; j < count; j++)
        box(`back-${i}-${j}`, left + j * 6, 17, 20, 26, {
          style: sprite(0, 160),
          layer: true,
        });
      txt(
        `${i + 2}번 ${count}장 ${chips[i]}칩`,
        inset + i * col + 4,
        46,
        col - 8,
        16,
        five && i === 0 ? ink : paper,
        five && i === 0 ? paper : pine,
      );
    });
    txt(caption, 130, 75, 156, 16, paper, ink);
    tiles(played, 99, 5, false);
    tiles(faces, 167, 13, true);
    band("message", 212, 16, pine);
    txt(message, 0, 212, width, 16, paper);
    band("commands", 228, 22, paper);
    txt("나 1번 · 칩 64", 2, 228, 97, 22);
    txt("선택 2장 · 7 페어", 100, 228, 140, 22);
    txt(
      "제출 2장",
      243,
      228,
      101,
      22,
      five ? ink : paper,
      five ? sage : ink,
      12,
      true,
    );
    txt("패스", 346, 228, 68, 22, ink, five ? sage : paper, 12, true);
    return { boxes, total: 250, rows: [16, 30, 16, 98, 52, 16, 22] };
  }
  const portrait = width < 648;
  const status = portrait ? 68 : 44,
    seats = portrait ? 24 * counts.length : 24,
    handHeight = portrait ? 180 : 90;
  const summary = portrait ? 24 : 0,
    rows = [status, seats, 24, 80, handHeight, 24, summary, 44];
  const total = rows.reduce((a, b) => a + b, 0);
  let y = Math.floor((height - total) / 2);
  band("status", y, status, paper);
  if (portrait) {
    txt("caxio", 0, y, 76, 24, ink, undefined, 24);
    txt("18초 · 초과 시 패스", 76, y, width - 76, 24, ink, paper, 24);
    txt(turn, 0, y + 24, width - 166, 44, paper, ink, 24);
    txt("R2/5", width - 166, y + 24, 62, 44, ink, paper, 24);
    txt("소리", width - 104, y + 24, 50, 44, paper, pine, 24, true);
    txt("메뉴", width - 52, y + 24, 52, 44, paper, pine, 24, true);
  } else {
    const items: [string, number][] = [
      ["caxio", 84],
      [turn, 194],
      ["18초 · 초과 시 패스", 248],
      ["R2/5", 88],
      ["소리", 78],
      ["메뉴", 78],
    ];
    let x = Math.floor(
      (width - items.reduce((sum, v) => sum + v[1] + 2, 0) + 2) / 2,
    );
    items.forEach(([s, w], i) => {
      txt(
        s,
        x,
        y,
        w,
        44,
        i === 1 || i > 3 ? paper : ink,
        i === 1 ? ink : i > 3 ? pine : paper,
        24,
        i > 3,
      );
      x += w + 2;
    });
  }
  y += status;
  band("seats", y, seats, pine);
  counts.forEach((count, i) => {
    const w = portrait ? width : Math.floor(width / counts.length);
    txt(
      `${i + 2}번 ${count}장 ${chips[i]}칩`,
      portrait ? 0 : i * w,
      portrait ? y + i * 24 : y,
      w,
      24,
      five && i === 0 ? ink : paper,
      five && i === 0 ? paper : pine,
      12,
    );
  });
  y += seats;
  box("table-strip", 0, y, width, 104, {
    layer: true,
    style: `background-image:url('${dataURL("outputs/bayer-5.png")}');background-size:8px 8px;image-rendering:pixelated`,
  });
  txt(caption, 0, y, width, 24, paper, ink, 24);
  tiles(played, y + 24, 5, false);
  y += 104;
  band("hand", y, handHeight, sage);
  tiles(faces, y + 10, portrait ? 7 : 13, true);
  y += handHeight;
  band("message", y, 24, pine);
  txt(message, 0, y, width, 24, paper, undefined, 24);
  y += 24;
  band("commands", y, summary + 44, paper);
  const info = "나 1번 · 칩 64",
    selection = "선택 2장 · 7 페어";
  if (portrait) {
    txt(selection, 0, y, width, 24, ink, undefined, 24);
    y += 24;
    txt(info, 0, y, 184, 44, ink, undefined, 24);
    txt(
      "제출 2장",
      186,
      y,
      width - 248,
      44,
      five ? ink : paper,
      five ? sage : ink,
      24,
      true,
    );
    txt("패스", width - 60, y, 60, 44, ink, five ? sage : paper, 24, true);
  } else {
    txt(info, 0, y, 200, 44, ink, undefined, 24);
    txt(selection, 200, y, 236, 44, ink, undefined, 24);
    txt(
      "제출 2장",
      width - 310,
      y,
      186,
      44,
      five ? ink : paper,
      five ? sage : ink,
      24,
      true,
    );
    txt("패스", width - 122, y, 122, 44, ink, five ? sage : paper, 24, true);
  }
  return { boxes, total, rows };
}

async function frames() {
  const reports = [];
  for (const [width, height, players, compact, stress] of [
    [416, 250, 5, 0],
    [416, 250, 5, 0, 1],
    [416, 250, 4, 0],
    [360, 640, 5, 1],
    [360, 640, 4, 1],
    [390, 844, 5, 1],
    [844, 390, 5, 1],
  ]) {
    const { boxes, rows, total } = layout(
      width,
      height,
      players,
      Boolean(compact),
      Boolean(stress),
    );
    const name = compact
      ? `compact-${width}x${height}${players === 4 ? "-4p" : ""}`
      : `wide-${players}${stress ? "-stress" : ""}`;
    await command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const font = dataURL("font/Galmuri11.woff2", "font/woff2");
    const html =
      `<style>@font-face{font-family:Galmuri;src:url('${font}') format('woff2')}*{-webkit-font-smoothing:none;box-sizing:border-box}body{margin:0;background:${inkCSS}}button,div{position:absolute;margin:0;padding:0;border:0;border-radius:0;appearance:none;font-family:Galmuri;font-weight:normal;text-align:left}button[data-name="패스"]{outline:1px solid ${inkCSS};outline-offset:-1px}span{position:absolute;white-space:pre}</style>` +
      boxes
        .map((b) => {
          const tag = b.button ? "button" : "div",
            style = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;color:${b.fg ? cssColor(b.fg) : inkCSS};background-color:${b.bg ? cssColor(b.bg) : "transparent"};font-size:${b.size || 12}px;line-height:${b.size || 12}px;${b.style || ""}`;
          return `<${tag} data-name="${b.name}" data-layer="${!!b.layer}" style="${style}" ${b.tile && b.button ? `aria-pressed="${!!b.selected}"` : ""}>${b.text ? `<span>${b.text}</span>` : ""}</${tag}>`;
        })
        .join("");
    await evaluate(
      `document.documentElement.innerHTML=${JSON.stringify(`<head><meta charset=utf-8></head><body>${html}</body>`)};true`,
    );
    const measured = await evaluate<{
      errors: string[];
      textWidths: Record<string, number>;
      naturalStatus: number;
      maxPlate: number;
      maxPlateText: string;
    }>(`(async()=>{
      await document.fonts.load("12px Galmuri");await document.fonts.ready;
      if(![...document.fonts].some(f=>f.status==="loaded"))throw Error("Galmuri failed");
      const errors=[],textWidths={},elements=[...document.querySelectorAll("[data-name]")];
      for(const el of elements){
        const a=el.getBoundingClientRect(),span=el.querySelector("span");
        if(a.x<0||a.y<0||a.right>innerWidth||a.bottom>innerHeight) errors.push(el.dataset.name+" outside viewport");
        if(span){const s=span.getBoundingClientRect();
          textWidths[span.textContent]=s.width;
          span.style.left=Math.floor((a.width-s.width)/2)+"px";span.style.top=Math.floor((a.height-s.height)/2)+"px";
          if(s.width>a.width||s.height>a.height) errors.push(span.textContent+" overflow "+s.width+" / "+a.width);
        }
      }
      const content=elements.filter(el=>el.dataset.layer==="false");
      for(let i=0;i<content.length;i++)for(let j=0;j<i;j++){
        const a=content[i].getBoundingClientRect(),b=content[j].getBoundingClientRect();
        if(a.left<b.right && b.left<a.right && a.top<b.bottom && b.top<a.bottom)errors.push(content[i].dataset.name+" overlaps "+content[j].dataset.name);
      }
      if(${compact} && elements.some(e=>e.tagName==="BUTTON" && (e.offsetWidth<44||e.offsetHeight<44))) errors.push("small touch target");
      const probe=document.createElement("span");probe.style.font="12px Galmuri";document.body.appendChild(probe);
      // Width is additive for this bitmap font; measure the complete widest string in the DOM.
      const widest=(start,end)=>{let best="",w=-1;for(let i=start;i<=end;i++){probe.textContent=String(i);const v=probe.getBoundingClientRect().width;if(v>w){w=v;best=String(i)}}return best};
      const maxPlateText=widest(1,5)+"번 "+widest(0,13)+"장 "+widest(0,320)+"칩";
      probe.textContent=maxPlateText;const maxPlate=probe.getBoundingClientRect().width;probe.remove();
      return {errors,textWidths,maxPlate,maxPlateText,naturalStatus:Object.entries(textWidths).filter(([s])=>["caxio","R2/5","소리","메뉴","▶ 내 차례 · 받기","2번 차례 · 받기","18초 · 초과 시 패스"].includes(s)).reduce((sum,[s,w])=>sum+w,0)};
    })()`);
    assert.deepEqual(measured.errors, [], name);
    await evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
    );
    const shot = await command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const file = `outputs/frame-${name}.png`;
    writeFileSync(file, Buffer.from(shot.data as string, "base64"));
    const rgb = await decode(dataURL(file));
    assert.deepEqual([rgb.w, rgb.h], [width, height]);
    const pixels = Buffer.from(rgb.data, "base64"),
      used = new Set<string>();
    for (let i = 0; i < pixels.length; i += 4) {
      used.add(
        "#" +
          pixels
            .subarray(i, i + 3)
            .toString("hex")
            .toUpperCase(),
      );
      assert.equal(pixels[i + 3], 255);
    }
    assert.deepEqual(
      [...used].sort(),
      [...palette].sort(),
      `${name} screenshot RGB`,
    );
    // False-colour glyph pass detects painted text crossing its own box, including font overhang.
    const labels = boxes.filter((b) => b.text);
    await evaluate(
      `[...document.querySelectorAll("span")].forEach((s,i)=>s.style.color="#f000"+i.toString(16).padStart(2,"0"));true`,
    );
    const diagnostic = await command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const colored = Buffer.from(
      (await decode(`data:image/png;base64,${diagnostic.data}`)).data,
      "base64",
    );
    const glyphCounts = labels.map(() => 0);
    for (let pos = 0; pos < width * height; pos++) {
      const offset = pos * 4;
      if (colored[offset] !== 240 || colored[offset + 1] !== 0) continue;
      const i = colored[offset + 2],
        b = labels[i],
        x = pos % width,
        y = Math.floor(pos / width);
      assert(
        b && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h,
        `${name} glyph outside ${b?.text} at ${x},${y}`,
      );
      glyphCounts[i]++;
    }
    assert(glyphCounts.every(Boolean), "missing rendered label");
    assert(measured.maxPlate <= 96);
    reports.push({
      name,
      width,
      height,
      rows,
      total,
      colors: used.size,
      compactFitScale: compact
        ? Math.min(Math.floor(width / 416), Math.floor(height / 250))
        : null,
      glyphPixels: glyphCounts.reduce((a, b) => a + b, 0),
      ...measured,
    });
  }
  writeFileSync("outputs/layout.json", `${JSON.stringify(reports, null, 2)}\n`);
  console.log(
    "Q3",
    reports.map((r) => [r.name, r.total, r.errors.length, r.colors]),
  );
}

try {
  command = await connect();
  const digits = await clean("digits", 5, 2, 9, 13);
  const suits = await clean("suits", 2, 2, 16, 14);
  const [mark] = await clean("back", 1, 1, 12, 12);
  assert((overrides as Edit[]).every((e) => Object.hasOwn(metrics, e.cell)));
  digits.forEach((c, i) => {
    const minRuns = [runs(c, false), runs(c, true)];
    metrics[`digits-${i}`].minRuns = minRuns;
    assert(
      minRuns.every((v) => v >= 2),
      `digit ${i} thin stroke: ${minRuns}`,
    );
  });
  for (const c of suits) {
    const pts = Array.from(c.pixels.keys()).filter((i) => c.pixels[i]);
    const x = pts.map((i) => i % c.w),
      y = pts.map((i) => Math.floor(i / c.w));
    assert(
      Math.max(...x) - Math.min(...x) + 1 >= 14 &&
        Math.max(...y) - Math.min(...y) + 1 >= 12,
    );
  }
  const sun = islands(suits[3]);
  assert.equal(sun.length, 9, `8 detached rays + disk: ${sun}`);
  assert(suits[3].get(8, 7) && sun[0] > sun[1]);
  atlases(digits, suits, mark);
  assert(
    Object.values(manifest).reduce(
      (s, m) => s + (m as { bytes: number }).bytes,
      0,
    ) <= 50000,
  );
  writeFileSync(
    "outputs/manifest.json",
    `${JSON.stringify(
      {
        palette,
        assets: manifest,
        cells: metrics,
        contrastAndColorVision: paletteChecks(),
        sunComponents: sun,
      },
      null,
      2,
    )}\n`,
  );
  console.log("Q2: passed all 15 generated masks; 8 rays plus disk", sun);
  await frames();
  const fmt = Bun.spawnSync([
    join(import.meta.dir, "../../node_modules/.bin/biome"),
    "format",
    "--write",
    "outputs/manifest.json",
    "outputs/layout.json",
  ]);
  assert.equal(fmt.exitCode, 0, fmt.stderr.toString());
} finally {
  chrome.kill();
  await chrome.exited;
  rmSync(profile, { recursive: true, force: true });
}
