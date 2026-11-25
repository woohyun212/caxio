import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  atlases,
  backColors,
  backRect,
  faceColors,
  fontFiles,
  glyphBoxes,
  tileRect,
} from "../../apps/web/src/visual/assets";
import { bayerThreshold, palette } from "../../apps/web/src/visual/tokens";
import { applyOverrides, decodeRGB, generate, sha256 } from "./build";
import manifest from "./manifest.json";
import overrides from "./overrides.json";
import provenance from "./raw/provenance.json";
import record from "./record.json";

const root = join(import.meta.dir, "../..");
const q2 = join(root, "docs/design/q2-source");
const rawFile = (id: string) =>
  readFileSync(join(import.meta.dir, "raw", `${id}.png`));
const raw = {
  digits: rawFile("digits"),
  suits: rawFile("suits"),
  back: rawFile("back"),
};
const fresh = generate(raw, overrides);
function checksums(name: string) {
  return new Map(
    readFileSync(join(q2, name), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, path] = line.split(/\s+/);
        assert(path && hash);
        return [path, hash];
      }),
  );
}
// Decode the exact indexed, unfiltered PNG format emitted by the encoder.
function readPNG(name: string) {
  const file = readFileSync(join(root, name));
  expect(file.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const chunks = new Map<string, Buffer>();
  for (let pos = 8; pos < file.length; ) {
    const end = pos + 8 + file.readUInt32BE(pos);
    expect(crc32(file.subarray(pos + 4, end))).toBe(file.readUInt32BE(end));
    chunks.set(
      file.toString("ascii", pos + 4, pos + 8),
      file.subarray(pos + 8, end),
    );
    pos = end + 4;
  }
  function chunk(tag: string) {
    const bytes = chunks.get(tag);
    if (!bytes) throw Error(tag);
    return bytes;
  }
  const header = chunk("IHDR"),
    w = header.readUInt32BE(),
    h = header.readUInt32BE(4);
  expect([...header.subarray(8)]).toEqual([8, 3, 0, 0, 0]);
  const colorBytes = chunk("PLTE"),
    colors = Array.from(
      { length: colorBytes.length / 3 },
      (_, i) =>
        "#" +
        colorBytes
          .subarray(i * 3, i * 3 + 3)
          .toString("hex")
          .toUpperCase(),
    );
  assert.deepEqual(colors.slice(1), atlases.wide.allowedColors);
  expect([...chunk("tRNS")]).toEqual([0]);
  const decoded = inflateSync(chunk("IDAT"));
  expect(decoded.length).toBe(h * (w + 1));
  const rows = Array.from({ length: h }, (_, y) => {
    const i = y * (w + 1);
    expect(decoded[i]).toBe(0);
    return decoded.subarray(i + 1, i + 1 + w);
  });
  const cell = (x: number, y: number, cw: number, ch: number) =>
    Buffer.concat(rows.slice(y, y + ch).map((row) => row.subarray(x, x + cw)));
  const alpha = chunk("tRNS");
  function texel(index: number) {
    const color = colors[index];
    assert(color, "palette index");
    return { color, alpha: alpha[index] ?? 255 };
  }
  return { w, h, cell, texel, bytes: file.length };
}
test("stored mask sheets have distinct, nonempty binary cells", () => {
  for (const [name, w, h, n] of [
    ["digits", 9, 13, 10],
    ["suits", 16, 14, 4],
    ["back", 12, 12, 1],
  ] as const) {
    const image = readPNG(`design/assets/outputs/mask-${name}.png`);
    expect([image.w, image.h]).toEqual([w * n, h]);
    const cells = new Set<string>();
    for (let i = 0; i < n; i++) {
      const c = image.cell(i * w, 0, w, h);
      expect([...new Set(c)].sort()).toEqual([0, 1]);
      cells.add(c.toString("hex"));
    }
    expect(cells.size).toBe(n);
  }
});
test("originals preserve Q2 provenance, input hashes and shipped font identities", () => {
  const published = checksums("inputs.sha256");
  const source = JSON.parse(
    readFileSync(join(q2, "raw/provenance.json"), "utf8"),
  );
  expect(provenance.map(({ sha256: _, ...item }) => item)).toEqual(source);
  for (const item of provenance) {
    expect(sha256(rawFile(item.id))).toBe(item.sha256);
    assert.equal(item.sha256, published.get(`raw/${item.path}`));
  }
  for (const font of fontFiles) {
    const bytes = readFileSync(join(root, `apps/web/public${font.url}`));
    expect(bytes.length).toBe(font.bytes);
    expect(sha256(bytes)).toBe(font.sha256);
  }
});

test("in-memory regeneration matches each committed output and its published Q2 checksum", () => {
  assert.deepEqual(fresh.manifest, manifest);
  expect(fresh.record).toEqual(record);
  const published = checksums("hashes.sha256");
  expect(fresh.outputs.size).toBe(18);
  for (const [path, data] of fresh.outputs) {
    expect(data.equals(readFileSync(join(root, path)))).toBe(true);
    assert.equal(sha256(data), published.get(`outputs/${basename(path)}`));
  }
  expect(manifest.cells).toHaveLength(15);
  for (const { id, foreground, overrideCount } of manifest.cells) {
    const mask = fresh.masks.get(id);
    assert(mask);
    expect(overrideCount).toBe(0);
    expect(foreground).toBe(mask.pixels.reduce((a, b) => a + b, 0));
  }
});

test("manifest lists exactly two shipped atlases with frozen metadata, sizes and hashes", () => {
  expect(Object.keys(manifest)).toEqual(["files", "cells"]);
  expect(manifest.files.map((f) => f.url)).toEqual([
    atlases.wide.url,
    atlases.compact.url,
  ]);
  for (const [mode, size] of [
    ["wide", 1173],
    ["compact", 955],
  ] as const) {
    const { url, width, height, allowedColors, alpha } = atlases[mode];
    const path = `apps/web/public${url}`,
      file = readFileSync(join(root, path)),
      png = readPNG(path);
    assert.deepEqual(
      manifest.files.find((f) => f.url === url),
      {
        url,
        path,
        width,
        height,
        allowedColors,
        alpha,
        sha256: sha256(file),
        bytes: file.length,
      },
    );
    expect([png.w, png.h, png.bytes]).toEqual([width, height, size]);
    expect(Math.max(png.w, png.h)).toBeLessThanOrEqual(512);
  }
  expect(
    manifest.files.reduce((sum, f) => sum + f.bytes, 0),
  ).toBeLessThanOrEqual(50000);
});

test("all 60 faces preserve glyph masks, colour roles, alpha and the two-digit gap in both widths", () => {
  for (const mode of ["wide", "compact"] as const) {
    const png = readPNG(`apps/web/public${atlases[mode].url}`),
      boxes = glyphBoxes(mode),
      distinct = new Set<string>();
    for (let s = 0; s < 4; s++)
      for (let n = 1; n <= 15; n++) {
        const rect = tileRect(n, s, mode),
          face = png.cell(rect.x, rect.y, rect.w, rect.h);
        distinct.add(face.toString("hex"));
        const allowed = faceColors(s);
        const digits = Array.from(String(n), (v) =>
          fresh.masks.get(`digits-${v}`),
        );
        const start = boxes.number.x + (n < 10 ? 5 : 0);
        const suit = fresh.masks.get(`suits-${s}`);
        assert(suit);
        for (let y = 0; y < rect.h; y++)
          for (let x = 0; x < rect.w; x++) {
            const pixel = png.texel(face.readUInt8(y * rect.w + x));
            const corner =
              (x === 0 || x === rect.w - 1) && (y === 0 || y === rect.h - 1);
            expect(pixel.alpha).toBe(corner ? 0 : 255);
            if (!corner) expect(allowed).toContain(pixel.color);
            if (
              y >= boxes.number.y &&
              y < boxes.number.y + boxes.number.h &&
              x >= boxes.number.x &&
              x < boxes.number.x + boxes.number.w
            ) {
              const dx = x - start,
                digit = digits[Math.floor(dx / 10)];
              const on =
                digit && dx % 10 < 9 && digit.get(dx % 10, y - boxes.number.y);
              assert.equal(pixel.color, on ? allowed[0] : allowed[2]);
            }
            if (
              y >= boxes.suit.y &&
              y < boxes.suit.y + boxes.suit.h &&
              x >= boxes.suit.x &&
              x < boxes.suit.x + boxes.suit.w
            ) {
              assert.equal(
                pixel.color,
                suit.get(x - boxes.suit.x, y - boxes.suit.y)
                  ? allowed[3]
                  : allowed[2],
              );
            }
          }
        if (n >= 10) {
          const glyph = png.cell(
            rect.x + start,
            rect.y + boxes.number.y,
            19,
            boxes.number.h,
          );
          const occupied = Array.from({ length: 19 }, (_, x) =>
            glyph.some(
              (v, i) => i % 19 === x && png.texel(v).color === allowed[0],
            ),
          );
          expect(occupied).toEqual(
            Array.from({ length: 19 }, (_, x) => x !== 9),
          );
        }
      }
    expect(distinct.size).toBe(60);
    if (mode === "wide") {
      for (let y = backRect.y; y < png.h; y++)
        for (let x = 0; x < png.w; x++) {
          const pixel = png.texel(png.cell(x, y, 1, 1).readUInt8(0));
          const within =
            x >= backRect.x &&
            x < backRect.x + backRect.w &&
            y < backRect.y + backRect.h;
          expect(pixel.alpha).toBe(within ? 255 : 0);
          if (within) expect(backColors).toContain(pixel.color);
        }
    }
  }
});

test("mask geometry has thick strokes, full suit bounds, a disk and eight rays", () => {
  expect(record.digitRuns).toHaveLength(10);
  for (const pair of fresh.record.digitRuns)
    expect(Math.min(...pair)).toBeGreaterThanOrEqual(2);
  for (const [id, c] of fresh.masks)
    if (id.startsWith("suits-")) {
      const pts = Array.from(c.pixels.keys()).filter((i) => c.pixels[i]);
      const xs = pts.map((i) => i % c.w),
        ys = pts.map((i) => Math.floor(i / c.w));
      expect(Math.max(...xs) - Math.min(...xs) + 1).toBeGreaterThanOrEqual(14);
      expect(Math.max(...ys) - Math.min(...ys) + 1).toBeGreaterThanOrEqual(12);
    }
  expect(fresh.record.sunComponents).toEqual([36, 5, 5, 4, 4, 4, 4, 4, 4]);
  expect(
    new Set([...fresh.masks.values()].map((c) => c.pixels.join(""))).size,
  ).toBe(15);
});

test("Bayer inspection PNG rows follow top-left matrix order (render captures use targetY)", () => {
  const thresholds = Array.from({ length: 16 }, (_, i) =>
    bayerThreshold(i % 4, Math.floor(i / 4)),
  );
  expect(new Set(thresholds).size).toBe(16);
  for (let n = 0; n <= 16; n++)
    expect(thresholds.filter((t) => n / 16 > t)).toHaveLength(n);
  for (const n of [2, 5, 8]) {
    const png = readPNG(`design/assets/outputs/bayer-${n}.png`);
    expect([png.w, png.h]).toEqual([4, 4]);
    let pine = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        // The inspection sheet shows rank row zero at its top; a render capture shows it at its bottom.
        const light = n / 16 > bayerThreshold(x, y);
        const pixel = png.texel(png.cell(x, y, 1, 1).readUInt8(0));
        assert.deepEqual(pixel, {
          color: backColors[light ? 1 : 0],
          alpha: 255,
        });
        if (pixel.color === backColors[1]) pine++;
      }
    expect(pine).toBe(n);
  }
});

test("token contrast on paper reaches 7:1 for digits and 3:1 for each suit", () => {
  function luminance(rgb: readonly number[]) {
    const [r, g, b] = rgb.map((byte) => {
      const v = byte / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    assert(r !== undefined && g !== undefined && b !== undefined);
    return r * 0.2126 + g * 0.7152 + b * 0.0722;
  }
  for (const key of ["ink", "cloud", "star", "moon", "sun"] as const) {
    const ratio =
      (luminance(palette.paper) + 0.05) / (luminance(palette[key]) + 0.05);
    expect(record.contrastOnPaper[key]).toBeCloseTo(ratio, 12);
    expect(ratio).toBeGreaterThanOrEqual(key === "ink" ? 7 : 3);
  }
});

test("overrides enforce cell identity, coordinate uniqueness, binary change and budget", () => {
  const cell = "back-0",
    c = fresh.masks.get(cell);
  assert(c);
  const edit = (i: number) => ({
    cell,
    x: i % c.w,
    y: Math.floor(i / c.w),
    value: 1 - c.get(i % c.w, Math.floor(i / c.w)),
  });
  const first = edit(0),
    run = (edits: (typeof first)[]) => applyOverrides(fresh.masks, edits);
  expect(() => run([{ ...first, cell: "missing" }])).toThrow("unknown cell");
  for (const change of [{ x: -1 }, { x: c.w }, { y: c.h }, { y: 0.5 }])
    expect(() => run([{ ...first, ...change }])).toThrow("coordinate range");
  expect(() => run([{ ...first, value: 2 }])).toThrow("binary value");
  expect(() => run([{ ...first, value: 1 - first.value }])).toThrow(
    "same value",
  );
  expect(() => run([first, { ...first, value: 1 - first.value }])).toThrow(
    "duplicate coordinate",
  );
  const limit = Math.floor(c.pixels.reduce((a, b) => a + b, 0) / 10);
  const permitted = Array.from({ length: limit }, (_, i) => edit(i));
  expect(() => run([...permitted, edit(limit)])).toThrow("override cap");
  const changed = run(permitted);
  expect(changed.cells.find((item) => item.id === cell)).toEqual({
    id: cell,
    foreground: 68,
    overrideCount: limit,
  });
  expect(changed.masks.get(cell)?.get(0, 0)).toBe(first.value);
  expect(c.get(0, 0)).toBe(1 - first.value);
});

test("raw and edited masks must both pass geometry checks", () => {
  const cell = "digits-0",
    c = fresh.masks.get(cell);
  assert(c);
  const edit = { cell, x: 1, y: 0, value: 0 };
  expect(() => applyOverrides(fresh.masks, [edit])).toThrow("thin stroke");
  const { masks } = applyOverrides(fresh.masks, []);
  const bad = masks.get(cell);
  assert(bad);
  bad.pixels[1] = 0;
  expect(() => applyOverrides(masks, [{ ...edit, value: 1 }])).toThrow(
    "thin stroke",
  );
});

// Independently prefiltered two-row RGB fixture, including left/up/corner Paeth cases.
const samples = [
  "0064e63c5028a0824620000af0465a0a8c8c1e46",
  "0164e63cec4264321e80010af046501a463214ba",
  "0264e63c5028a082462002a60a0a0ae2ec0ad826",
  "0364e63c1eb5825a32d003d87d282d7e191ef6f0",
  "0464e63cec4264321e8004a60a0a50e2ec0af626",
] as const;
function fixture(rows: Buffer, format = [8, 2, 0, 0, 0]) {
  function chunk(tag: string, data: Buffer) {
    const buf = Buffer.alloc(data.length + 12);
    buf.writeUInt32BE(data.length);
    buf.write(tag, 4);
    data.copy(buf, 8);
    buf.writeUInt32BE(crc32(buf.subarray(4, -4)), buf.length - 4);
    return buf;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(3);
  header.writeUInt32BE(2, 4);
  header.set(format, 8);
  const compressed = deflateSync(rows);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("caBX", Buffer.from("proof")),
    chunk("IDAT", compressed.subarray(0, 7)),
    chunk("IDAT", compressed.subarray(7)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const [filter, sample] of samples.entries())
  test(
    "RGB decoder reverses PNG filter " +
      filter +
      " across multiple IDAT chunks",
    () => {
      const { w, h, rgb } = decodeRGB(fixture(Buffer.from(sample, "hex")));
      expect([w, h]).toEqual([3, 2]);
      expect(rgb.toString("hex")).toBe("64e63c5028a08246200af0465a0a8c8c1e46");
    },
  );
test("RGB decoder rejects bad signature, ancillary CRC, format, filter and row length", () => {
  const rows = Buffer.from(samples[0], "hex");
  const sig = fixture(rows);
  sig[0] = 0;
  expect(() => decodeRGB(sig)).toThrow("PNG signature");
  const crc = fixture(rows);
  crc[crc.indexOf("proof")] = 0;
  expect(() => decodeRGB(crc)).toThrow("caBX CRC");
  for (const format of [
    [16, 2, 0, 0, 0],
    [8, 6, 0, 0, 0],
    [8, 2, 0, 0, 1],
  ])
    expect(() => decodeRGB(fixture(rows, format))).toThrow(
      "unsupported PNG format",
    );
  expect(() => decodeRGB(fixture(rows.subarray(1)))).toThrow("row length");
  expect(() =>
    decodeRGB(fixture(Buffer.concat([rows, Buffer.alloc(1)]))),
  ).toThrow();
  rows[10] = 5;
  expect(() => decodeRGB(fixture(rows))).toThrow("unknown row filter");
});
