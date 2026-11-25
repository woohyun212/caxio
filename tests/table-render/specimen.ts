import { mkdir } from "node:fs/promises";
import { atlases, backRect, tileRect } from "../../apps/web/src/visual/assets";
import { palette, tile } from "../../apps/web/src/visual/tokens";
import { encode } from "./png";
export async function generate(dir: string) {
  const { width, height } = atlases.wide,
    data = new Uint8Array(width * height * 4);
  const inks = [palette.cloud, palette.star, palette.moon, palette.sun];
  for (const [s, ink] of inks.entries())
    for (let n = 1; n <= 15; n++) {
      const r = tileRect(n, s, "wide");
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const edge = x === 0 || x === r.w - 1 || y === 0 || y === r.h - 1;
          if ((y === 0 || y === r.h - 1) && (x === 0 || x === r.w - 1))
            continue;
          const c = edge
            ? palette.ink
            : y >= tile.faceHeight
              ? palette.pine
              : x >= 3 && x < 3 + n && y >= 4 && y < 10
                ? ink
                : palette.paper;
          data.set([...c, 255], ((r.y + y) * width + r.x + x) * 4);
        }
    }
  for (let y = 0; y < backRect.h; y++)
    for (let x = 0; x < backRect.w; x++)
      data.set([...palette.sage, 255], ((backRect.y + y) * width + x) * 4);
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/atlas-wide.png`, encode({ width, height, data }));
}
if (import.meta.main)
  await generate(Bun.argv[2] ?? "tests/table-render/specimen");
