import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { compare, judgeColor, mask, median } from "./judge";
import { chunk, decode, encode } from "./png";

function png(
  w: number,
  h: number,
  bits: number,
  type: number,
  rows: number[],
  palette?: number[],
  alpha?: number[],
) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w);
  head.writeUInt32BE(h, 4);
  head[8] = bits;
  head[9] = type;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    ...(palette ? [chunk("PLTE", Buffer.from(palette))] : []),
    ...(alpha ? [chunk("tRNS", Buffer.from(alpha))] : []),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("RGBA encoding and all five RGB scanline predictors", () => {
  const data = Uint8Array.from([3, 8, 10, 255, 30, 18, 12, 0]);
  expect(decode(encode({ width: 2, height: 1, data })).data).toEqual(data);
  const im = decode(
    png(
      2,
      5,
      8,
      2,
      [
        0, 3, 6, 9, 6, 12, 18, 1, 3, 6, 9, 3, 6, 9, 2, 0, 0, 0, 0, 0, 0, 3, 2,
        3, 5, 2, 3, 5, 4, 0, 0, 0, 0, 0, 0,
      ],
    ),
  );
  for (let row = 0; row < 5; row++)
    expect([...im.data.slice(row * 8, (row + 1) * 8)]).toEqual([
      3, 6, 9, 255, 6, 12, 18, 255,
    ]);
});
test("indexed 1/2/4/8 bpp with palette transparency and row padding", () => {
  for (const bits of [1, 2, 4, 8]) {
    const row =
      bits === 8
        ? [0, 1, 0]
        : bits === 4
          ? [0x01, 0]
          : bits === 2
            ? [0x10]
            : [0x40];
    const img = decode(
      png(
        3,
        2,
        bits,
        3,
        [0, ...row, 2, ...row.map(() => 0)],
        [20, 30, 40, 90, 80, 70],
        [0, 255],
      ),
    );
    expect([...img.data]).toEqual(
      Array.from({ length: 2 }, () => [
        20, 30, 40, 0, 90, 80, 70, 255, 20, 30, 40, 0,
      ]).flat(),
    );
  }
  expect(() => decode(png(1, 1, 8, 3, [0, 2], [1, 2, 3]))).toThrow("palette");
});
function raster(width: number, height: number, values: number[]) {
  return {
    width,
    height,
    data: Uint8Array.from(values.flatMap((v) => [v, v, v, 255])),
  };
}
test("physical centres at half boundaries belong to left/top; mixed cells fail", () => {
  const source = raster(2, 2, [1, 2, 3, 4]);
  const scaled = raster(3, 3, [1, 1, 2, 1, 1, 2, 3, 3, 4]);
  expect(compare(source, scaled, 1.5)).toEqual({ difference: 0, mixed: 0 });
  scaled.data[16] = 10;
  expect(compare(source, scaled, 1.5)).toEqual({ difference: 1, mixed: 1 });
  expect(() => compare(source, scaled, 2)).toThrow("size");
});
test("palette masks count stray colors and medians retain fractional samples", () => {
  const m = mask();
  judgeColor(m, 2, [1, 2]);
  judgeColor(m, 9, [1, 2]);
  expect(m).toEqual({ pixels: 2, difference: 1 });
  expect(median([5, 4, 9])).toBe(5);
  expect(median([5, 4, 9, 6])).toBe(5.5);
});
