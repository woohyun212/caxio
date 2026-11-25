import { crc32, deflateSync, inflateSync } from "node:zlib";
export type Raster = { width: number; height: number; data: Uint8Array };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function chunk(type: string, body: Uint8Array) {
  const tag = Buffer.from(type),
    buf = Buffer.alloc(body.length + 12);
  buf.writeUInt32BE(body.length);
  tag.copy(buf, 4);
  buf.set(body, 8);
  buf.writeUInt32BE(crc32(buf.subarray(4, -4)), buf.length - 4);
  return buf;
}
export function encode({ width, height, data }: Raster) {
  if (data.length !== width * height * 4) throw Error("Unexpected RGBA length");
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 6;
  const stride = width * 4,
    rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    rows.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    signature,
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
export function decode(input: Uint8Array): Raster {
  const buf = Buffer.from(input);
  if (!buf.subarray(0, 8).equals(signature))
    throw Error("Invalid PNG signature");
  let w = 0,
    h = 0,
    bits = 0,
    type = 0,
    palette: Buffer | undefined,
    alpha: Buffer | undefined;
  const parts: Buffer[] = [];
  for (let p = 8; p < buf.length; ) {
    const size = buf.readUInt32BE(p),
      tag = buf.toString("ascii", p + 4, p + 8),
      body = buf.subarray(p + 8, p + 8 + size);
    if (
      buf.readUInt32BE(p + 8 + size) !==
      crc32(buf.subarray(p + 4, p + 8 + size))
    )
      throw Error("PNG CRC mismatch");
    if (tag === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      bits = body.readUInt8(8);
      type = body.readUInt8(9);
      if (
        body[10] ||
        body[11] ||
        body[12] ||
        !(type === 3
          ? [1, 2, 4, 8].includes(bits)
          : (type === 2 || type === 6) && bits === 8)
      )
        throw Error("Unsupported PNG format");
    } else if (tag === "PLTE") palette = body;
    else if (tag === "tRNS") alpha = body;
    else if (tag === "IDAT") parts.push(body);
    else if (tag === "IEND") break;
    p += 12 + size;
  }
  const channels = type === 3 ? 1 : type === 2 ? 3 : 4,
    stride = Math.ceil((w * bits * channels) / 8);
  const scan = inflateSync(Buffer.concat(parts)),
    data = new Uint8Array(w * h * 4);
  if (!w || !h || scan.length !== (stride + 1) * h)
    throw Error("Invalid scanlines");
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const start = y * (stride + 1),
      filter = scan[start],
      row = Buffer.from(scan.subarray(start + 1, start + 1 + stride));
    if (filter === undefined || filter > 4) throw Error("Invalid PNG filter");
    for (let i = 0; i < stride; i++) {
      const a = row[i - channels] ?? 0,
        b = prev[i] ?? 0,
        c = prev[i - channels] ?? 0;
      row[i] =
        row.readUInt8(i) +
        ([0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter] ?? 0);
    }
    for (let x = 0; x < w; x++) {
      const out = (y * w + x) * 4;
      if (type === 3) {
        const bit = x * bits,
          idx =
            (row.readUInt8(Math.floor(bit / 8)) >> (8 - bits - (bit % 8))) &
            ((1 << bits) - 1);
        if (!palette || idx * 3 + 2 >= palette.length)
          throw Error("Invalid palette index");
        data.set(palette.subarray(idx * 3, idx * 3 + 3), out);
        data[out + 3] = alpha?.[idx] ?? 255;
      } else {
        data.set(row.subarray(x * channels, x * channels + channels), out);
        if (type === 2)
          data[out + 3] =
            alpha &&
            row[x * 3] === alpha.readUInt16BE(0) &&
            row[x * 3 + 1] === alpha.readUInt16BE(2) &&
            row[x * 3 + 2] === alpha.readUInt16BE(4)
              ? 0
              : 255;
      }
    }
    prev = row;
  }
  return { width: w, height: h, data };
}
