import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  atlases,
  backRect,
  glyphBoxes,
  tileRect,
} from "../../apps/web/src/visual/assets";
import { bayer, palette, tile } from "../../apps/web/src/visual/tokens";
import provenance from "./raw/provenance.json";

const [ink, pine, sage, paper] = [1, 2, 3, 4] as const;
export function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function light(channel: number) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luma([r, g, b]: readonly [number, number, number]) {
  return light(r) * 0.2126 + light(g) * 0.7152 + light(b) * 0.0722;
}
const luminance = Object.values(palette).map(luma);
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
    const pixel = this.pixels[y * this.w + x];
    assert(pixel !== undefined);
    return pixel;
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
  png(colors: readonly string[] = atlases.wide.allowedColors) {
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
}

function paeth(left: number, up: number, corner: number) {
  const p = left + up - corner,
    a = Math.abs(p - left),
    b = Math.abs(p - up),
    c = Math.abs(p - corner);
  if (a <= b && a <= c) return left;
  return b <= c ? up : corner;
}
export function decodeRGB(file: Buffer) {
  assert.equal(
    file.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    "PNG signature",
  );
  let w = 0,
    h = 0,
    ended = false;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < file.length; ) {
    const end = pos + 8 + file.readUInt32BE(pos);
    assert(end + 4 <= file.length, "truncated chunk");
    const tag = file.toString("ascii", pos + 4, pos + 8);
    const body = file.subarray(pos + 8, end);
    assert.equal(
      crc32(file.subarray(pos + 4, end)),
      file.readUInt32BE(end),
      `${tag} CRC`,
    );
    if (pos === 8) assert.equal(tag, "IHDR");
    switch (tag) {
      case "IHDR":
        assert(pos === 8 && body.length === 13, "IHDR length or order");
        assert.deepEqual(
          [...body.subarray(8)],
          [8, 2, 0, 0, 0],
          "unsupported PNG format",
        );
        w = body.readUInt32BE();
        h = body.readUInt32BE(4);
        assert(w > 0 && h > 0, "empty image");
        break;
      case "IDAT":
        idat.push(body);
        break;
      case "IEND":
        assert(body.length === 0 && end + 4 === file.length, "invalid IEND");
        ended = true;
        break;
      case "PLTE":
        break; // Optional suggested palette in truecolour PNG.
      default:
        assert(/^[a-z]/.test(tag), `unknown critical chunk ${tag}`);
    }
    pos = end + 4;
  }
  assert(ended && idat.length > 0, "incomplete PNG");
  const stride = w * 3,
    length = h * (stride + 1);
  const filtered = inflateSync(Buffer.concat(idat), {
    maxOutputLength: length,
  });
  assert.equal(filtered.length, length, "row length");
  const rgb = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1),
      filter = filtered.readUInt8(start);
    assert(filter <= 4, "unknown row filter");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        left = x >= 3 ? rgb.readUInt8(i - 3) : 0,
        up = y ? rgb.readUInt8(i - stride) : 0;
      let predictor = 0;
      switch (filter) {
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = Math.floor((left + up) / 2);
          break;
        case 4:
          predictor = paeth(
            left,
            up,
            y && x >= 3 ? rgb.readUInt8(i - stride - 3) : 0,
          );
          break;
      }
      rgb[i] = filtered.readUInt8(start + 1 + x) + predictor;
    }
  }
  return { w, h, rgb };
}
function clean(
  file: Buffer,
  id: string,
  cols: number,
  rows: number,
  w: number,
  h: number,
) {
  const src = decodeRGB(file);
  assert.deepEqual(
    [src.w, src.h],
    provenance.find((item) => item.id === id)?.size,
  );
  function black(x: number, y: number) {
    const i = (y * src.w + x) * 3;
    return (
      src.rgb.readUInt8(i) +
        src.rgb.readUInt8(i + 1) +
        src.rgb.readUInt8(i + 2) <
      384
    );
  }
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
            if (x <= right && y <= bottom && black(x, y))
              area +=
                (Math.min(b, x + 1) - Math.max(a, x)) *
                (Math.min(d, y + 1) - Math.max(c, y));
        cell.pixels[j * w + i] = Number(area >= (sx * sy) / 2);
      }
    cells.push(cell);
  }
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
    const start = remaining.values().next().value;
    assert(start !== undefined);
    const queue = [start];
    remaining.delete(start);
    for (const pos of queue) {
      const x = pos % c.w,
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

function validate(id: string, c: Raster) {
  assert(c.pixels.some(Boolean), `${id} empty mask`);
  if (id.startsWith("digits-"))
    assert(Math.min(runs(c, false), runs(c, true)) >= 2, `${id} thin stroke`);
  if (id.startsWith("suits-")) {
    const pts = Array.from(c.pixels.keys()).filter((i) => c.pixels[i]);
    const x = pts.map((i) => i % c.w),
      y = pts.map((i) => Math.floor(i / c.w));
    assert(
      Math.max(...x) - Math.min(...x) + 1 >= 14 &&
        Math.max(...y) - Math.min(...y) + 1 >= 12,
      `${id} visible bounds`,
    );
  }
  if (id === "suits-3") {
    const sun = islands(c),
      [disk, ray] = sun;
    assert(
      sun.length === 9 &&
        disk !== undefined &&
        ray !== undefined &&
        disk > ray &&
        c.get(8, 7),
      "sun disk and eight detached rays",
    );
  }
}
type Edit = { cell: string; x: number; y: number; value: number };
function validateMasks(masks: Map<string, Raster>) {
  const identities = new Set<string>();
  for (const [id, mask] of masks) {
    validate(id, mask);
    const identity = mask.pixels.join("");
    assert(!identities.has(identity), `${id} duplicate mask`);
    identities.add(identity);
  }
}
export function applyOverrides(
  raw: Map<string, Raster>,
  edits: readonly Edit[],
) {
  validateMasks(raw);
  const masks = new Map<string, Raster>(),
    cells = [];
  for (const e of edits) assert(raw.has(e.cell), "unknown cell");
  for (const [id, c] of raw) {
    const foreground = c.pixels.reduce((a, b) => a + b, 0);
    const changes = edits.filter((e) => e.cell === id),
      seen = new Set<number>();
    assert(changes.length <= Math.floor(foreground / 10), `${id} override cap`);
    const mask = new Raster(c.w, c.h);
    mask.pixels.set(c.pixels);
    for (const { x, y, value } of changes) {
      assert(
        Number.isInteger(x) &&
          x >= 0 &&
          x < c.w &&
          Number.isInteger(y) &&
          y >= 0 &&
          y < c.h,
        `${id} coordinate range`,
      );
      assert(value === 0 || value === 1, `${id} binary value`);
      const index = y * c.w + x;
      assert(!seen.has(index), `${id} duplicate coordinate`);
      seen.add(index);
      assert(mask.get(x, y) !== value, `${id} same value`);
      mask.rect(x, y, 1, 1, value);
    }
    masks.set(id, mask);
    cells.push({ id, foreground, overrideCount: seen.size });
  }
  validateMasks(masks);
  return { masks, cells };
}
function rear(mark: Raster) {
  const c = new Raster(backRect.w, backRect.h, ink);
  c.rect(1, 1, 18, 24, pine);
  c.rect(2, 2, 16, 21, sage);
  for (let y = 2; y < 23; y++)
    for (let x = 2; x < 18; x++)
      if ((x === 2 || x === 17 || y === 2 || y === 22) && (x + y) % 2 === 0)
        c.rect(x, y, 1, 1, paper);
  c.blit(mark, 4, 6, 1, ink);
  return c;
}

type RawFiles = { digits: Buffer; suits: Buffer; back: Buffer };
export function generate(raw: RawFiles, edits: readonly Edit[]) {
  const boxes = glyphBoxes("wide");
  const groups = [
    ["digits", 5, 2, 9, boxes.number.h],
    ["suits", 2, 2, boxes.suit.w, boxes.suit.h],
    ["back", 1, 1, 12, 12],
  ] as const;
  const original = new Map<string, Raster>();
  for (const [id, cols, rows, w, h] of groups) {
    for (const [i, c] of clean(raw[id], id, cols, rows, w, h).entries())
      original.set(`${id}-${i}`, c);
  }
  const { masks, cells } = applyOverrides(original, edits);
  function mask(id: string) {
    const c = masks.get(id);
    assert(c, id);
    return c;
  }
  const outputs = new Map<string, Buffer>();
  function inspect(name: string, bytes: Buffer) {
    outputs.set(`design/assets/outputs/${name}.png`, bytes);
  }
  for (const [id, cols, rows, w, h] of groups) {
    const strip = new Raster(cols * rows * w, h);
    for (let i = 0; i < cols * rows; i++)
      strip.blit(mask(`${id}-${i}`), i * w, 0);
    inspect(`mask-${id}`, strip.png());
  }
  const files = [];
  for (const mode of ["wide", "compact"] as const) {
    const {
      url,
      width,
      height,
      allowedColors,
      alpha,
      cellWidth: w,
    } = atlases[mode];
    const atlas = new Raster(width, height),
      contact = new Raster(15 * (w + 2) + 2, 202, sage);
    const boxes = glyphBoxes(mode);
    for (let suit = 0; suit < 4; suit++)
      for (let n = 1; n <= 15; n++) {
        const rect = tileRect(n, suit, mode),
          c = new Raster(w, rect.h);
        c.rect(1, 0, w - 2, c.h, ink);
        c.rect(0, 1, w, c.h - 2, ink);
        c.rect(1, 1, w - 2, tile.faceHeight - 2, paper);
        c.rect(1, tile.faceHeight, w - 2, tile.ledgeHeight, pine);
        const digits = String(n);
        for (const [i, v] of Array.from(digits).entries())
          c.blit(
            mask(`digits-${v}`),
            Math.floor((w - (digits.length * 10 - 1)) / 2) + i * 10,
            boxes.number.y,
          );
        c.blit(mask(`suits-${suit}`), boxes.suit.x, boxes.suit.y, 1, 5 + suit);
        atlas.blit(c, rect.x, rect.y);
        contact.blit(c, 2 + (n - 1) * (w + 2), 2 + suit * (rect.h + 2));
      }
    const back = rear(mask("back-0"));
    if (mode === "wide") atlas.blit(back, backRect.x, backRect.y);
    contact.blit(back, 2, 172);
    if (mode === "wide") {
      // A diagnostic removes the hue cue entirely and keeps each silhouette at 1x.
      const mono = new Raster(contact.w, contact.h);
      mono.pixels.set(contact.pixels.map((v) => (v >= 5 ? ink : v)));
      inspect("contact-shapes-1x", mono.png());
      const gray = luminance.map((v) => {
        const srgb =
          v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
        return `#${Math.round(srgb * 255)
          .toString(16)
          .padStart(2, "0")
          .repeat(3)}`;
      });
      inspect("contact-gray-1x", contact.png(gray));
    }

    const path = `apps/web/public${url}`,
      bytes = atlas.png();
    outputs.set(path, bytes);
    files.push({
      url,
      path,
      width,
      height,
      bytes: bytes.length,
      sha256: sha256(bytes),
      allowedColors,
      alpha,
    });
    for (const k of [1, 2, 3, 4]) {
      const sheet = new Raster(contact.w * k, contact.h * k);
      sheet.blit(contact, 0, 0, k);
      inspect(`contact-${mode}-${k}x`, sheet.png());
    }
  }
  for (const n of [2, 5, 8]) {
    const c = new Raster(bayer.length, bayer.length, ink);
    bayer.flat().forEach((rank, i) => {
      if (rank < n) c.pixels[i] = pine;
    });
    inspect(`bayer-${n}`, c.png());
  }
  const record = {
    inspection: Array.from(outputs, ([path, data]) => ({
      path,
      bytes: data.length,
      sha256: sha256(data),
    })).filter((item) => item.path.startsWith("design/")),
    digitRuns: Array.from({ length: 10 }, (_, i) => {
      const c = mask(`digits-${i}`);
      return [runs(c, false), runs(c, true)];
    }),
    sunComponents: islands(mask("suits-3")),
    contrastOnPaper: Object.fromEntries(
      (["ink", "cloud", "star", "moon", "sun"] as const).map((key) => [
        key,
        (luma(palette.paper) + 0.05) / (luma(palette[key]) + 0.05),
      ]),
    ),
  };
  return { outputs, manifest: { files, cells }, record, masks };
}
if (import.meta.main) {
  const root = join(import.meta.dir, "../..");
  const read = (id: string) =>
    readFileSync(join(import.meta.dir, "raw", `${id}.png`));
  const edits = JSON.parse(
    readFileSync(join(import.meta.dir, "overrides.json"), "utf8"),
  );
  const { outputs, manifest, record } = generate(
    { digits: read("digits"), suits: read("suits"), back: read("back") },
    edits,
  );
  for (const [path, data] of outputs) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }

  for (const [name, data] of Object.entries({ manifest, record })) {
    const path = join(import.meta.dir, `${name}.json`);
    // Biome keeps the short numeric arrays (alpha, runs, components) on one line.
    const json = JSON.stringify(data, null, 2).replace(
      /\[\s*(\d+(?:,\s*\d+)*)\s*\]/g,
      (_, numbers: string) => `[${numbers.replace(/,\s*/g, ", ")}]`,
    );
    writeFileSync(path, `${json}\n`);
  }
}
