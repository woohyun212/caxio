import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import manifest from "./outputs/manifest.json";

// Read the exact indexed, unfiltered PNG format emitted by the dry run.
function readPNG(name: string) {
  const file = readFileSync(join(import.meta.dir, "outputs", name));
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
  expect(colors.slice(1)).toEqual(manifest.palette);
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
  return { w, h, cell, colors, bytes: file.length };
}
test("committed PNGs match their manifest, budget, and per-face colour roles", () => {
  let total = 0;
  for (const [name, entry] of Object.entries(manifest.assets)) {
    const image = readPNG(name);
    total += image.bytes;
    expect([image.w, image.h, image.bytes]).toEqual([
      entry.width,
      entry.height,
      entry.bytes,
    ]);
    const pixels = image.cell(0, 0, image.w, image.h),
      used = [...new Set(pixels)].sort();
    expect(used.filter(Boolean).map((i) => image.colors[i])).toEqual(
      entry.allowed,
    );
    expect(used.includes(0) ? [0, 255] : [255]).toEqual(entry.alpha);
    if (name.startsWith("atlas")) {
      const cw = image.w / 15,
        distinct = new Set<string>();
      for (let s = 0; s < 4; s++)
        for (let n = 0; n < 15; n++) {
          const face = image.cell(n * cw, s * 40, cw, 40);
          distinct.add(face.toString("hex"));
          expect([...new Set(face)].sort()).toEqual([0, 1, 2, 4, 5 + s]);
          expect(
            [...new Set(image.cell(n * cw + 1, s * 40 + 1, cw - 2, 34))].sort(),
          ).toEqual([1, 4, 5 + s]);
        }
      expect(distinct.size).toBe(60);
    } else {
      const n = Number(name.slice(6, -4));
      expect([...pixels]).toEqual(
        [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((rank) =>
          rank < n ? 2 : 1,
        ),
      );
    }
  }
  expect(Object.keys(manifest.assets)).toHaveLength(5);
  expect(total).toBeLessThanOrEqual(50000);
});
test("stored mask sheets have distinct, nonempty binary cells", () => {
  for (const [name, w, h, n] of [
    ["digits", 9, 13, 10],
    ["suits", 16, 14, 4],
    ["back", 12, 12, 1],
  ] as const) {
    const image = readPNG(`mask-${name}.png`);
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
