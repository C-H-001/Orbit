import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

function generateIcon(size: number) {
  const png = new PNG({ width: size, height: size });
  const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    const offset = (y * size + x) * 4;
    png.data.set([r, g, b, a], offset);
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / Math.max(1, 2 * size - 2);
      set(x, y, Math.round(59 + 40 * t), Math.round(130 - 28 * t), Math.round(246 - 5 * t));
    }
  }

  const left = Math.round(size * 0.22);
  const right = Math.round(size * 0.78);
  const top = Math.round(size * 0.28);
  const bottom = Math.round(size * 0.72);
  const center = Math.floor(size / 2);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const page = x < center - 1 || x > center + 1;
      if (page) set(x, y, 255, 255, 255, 235);
    }
  }

  return PNG.sync.write(png);
}

const output = path.resolve("extension/assets");
mkdirSync(output, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(output, `icon-${size}.png`), generateIcon(size));
}
