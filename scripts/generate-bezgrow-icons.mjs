import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");
const publicIconsDir = join(publicDir, "icons");
const desktopShellDir = join(root, "desktop-shell");
const tauriIconsDir = join(root, "src-tauri", "icons");

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);

  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function pngFromRgba(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, rowOffset + 1);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function mix(a, b, ratio) {
  return Math.round(a + (b - a) * ratio);
}

function backgroundColor(nx, ny) {
  const diagonal = Math.min(1, Math.max(0, (nx + ny) / 2));
  const left = [8, 47, 125];
  const middle = [37, 99, 235];
  const right = [5, 194, 218];
  const first = diagonal < 0.58;
  const local = first ? diagonal / 0.58 : (diagonal - 0.58) / 0.42;
  const from = first ? left : middle;
  const to = first ? middle : right;
  const light = 14 * Math.max(0, 1 - Math.hypot(nx - 0.28, ny - 0.18) * 2.2);

  return [
    Math.min(255, mix(from[0], to[0], local) + light),
    Math.min(255, mix(from[1], to[1], local) + light),
    Math.min(255, mix(from[2], to[2], local) + light),
    255,
  ];
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;

  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }

  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;

  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function compositePixel(rgba, index, color) {
  const alpha = color[3] / 255;
  const inverse = 1 - alpha;
  const existingAlpha = rgba[index + 3] / 255;
  const nextAlpha = alpha + existingAlpha * inverse;

  if (nextAlpha <= 0) {
    return;
  }

  rgba[index] = Math.round((color[0] * alpha + rgba[index] * existingAlpha * inverse) / nextAlpha);
  rgba[index + 1] = Math.round((color[1] * alpha + rgba[index + 1] * existingAlpha * inverse) / nextAlpha);
  rgba[index + 2] = Math.round((color[2] * alpha + rgba[index + 2] * existingAlpha * inverse) / nextAlpha);
  rgba[index + 3] = Math.round(nextAlpha * 255);
}

function drawRoundedRect(rgba, width, height, rect, color, offsetX = 0, offsetY = 0) {
  const left = (rect.x + offsetX) * width;
  const top = (rect.y + offsetY) * height;
  const rectWidth = rect.w * width;
  const rectHeight = rect.h * height;
  const radius = rect.r * Math.min(width, height);
  const x1 = Math.max(0, Math.floor(left - 1));
  const x2 = Math.min(width - 1, Math.ceil(left + rectWidth + 1));
  const y1 = Math.max(0, Math.floor(top - 1));
  const y2 = Math.min(height - 1, Math.ceil(top + rectHeight + 1));

  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      if (!insideRoundedRect(px, py, left, top, rectWidth, rectHeight, radius)) {
        continue;
      }

      const index = (y * width + x) * 4;
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      compositePixel(rgba, index, typeof color === "function" ? color(nx, ny) : color);
    }
  }
}

function renderIcon(size) {
  const scale = size < 96 ? 8 : 4;
  const width = size * scale;
  const height = size * scale;
  const high = new Uint8ClampedArray(width * height * 4);
  const outerRadius = 0.205 * width;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      if (!insideRoundedRect(px, py, 0, 0, width, height, outerRadius)) {
        continue;
      }

      const index = (y * width + x) * 4;
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const color = backgroundColor(nx, ny);
      high[index] = color[0];
      high[index + 1] = color[1];
      high[index + 2] = color[2];
      high[index + 3] = color[3];
    }
  }

  const letterShapes = [
    { x: 0.265, y: 0.195, w: 0.145, h: 0.61, r: 0.045 },
    { x: 0.355, y: 0.205, w: 0.345, h: 0.29, r: 0.145 },
    { x: 0.355, y: 0.505, w: 0.385, h: 0.30, r: 0.15 },
    { x: 0.315, y: 0.435, w: 0.31, h: 0.13, r: 0.045 },
  ];

  for (const shape of letterShapes) {
    drawRoundedRect(high, width, height, shape, [4, 18, 42, 52], 0.018, 0.02);
  }

  for (const shape of letterShapes) {
    drawRoundedRect(high, width, height, shape, [248, 252, 255, 255]);
  }

  const cutouts = [
    { x: 0.485, y: 0.305, w: 0.125, h: 0.105, r: 0.052 },
    { x: 0.49, y: 0.607, w: 0.155, h: 0.105, r: 0.052 },
  ];

  for (const shape of cutouts) {
    drawRoundedRect(high, width, height, shape, backgroundColor);
  }

  if (scale === 1) {
    return high;
  }

  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let yy = 0; yy < scale; yy += 1) {
        for (let xx = 0; xx < scale; xx += 1) {
          const source = ((y * scale + yy) * width + x * scale + xx) * 4;
          sums[0] += high[source];
          sums[1] += high[source + 1];
          sums[2] += high[source + 2];
          sums[3] += high[source + 3];
        }
      }

      const target = (y * size + x) * 4;
      const samples = scale * scale;
      out[target] = Math.round(sums[0] / samples);
      out[target + 1] = Math.round(sums[1] / samples);
      out[target + 2] = Math.round(sums[2] / samples);
      out[target + 3] = Math.round(sums[3] / samples);
    }
  }

  return out;
}

function pngBuffer(size) {
  return pngFromRgba(size, size, renderIcon(size));
}

function writePng(path, size) {
  writeFileSync(path, pngBuffer(size));
}

function icoBuffer(sizes) {
  const images = sizes.map((size) => ({ size, buffer: pngBuffer(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const entry = index * 16;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.buffer.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.buffer.length;
  }

  return Buffer.concat([header, directory, ...images.map((image) => image.buffer)]);
}

function icnsBuffer(entries) {
  const iconChunks = entries.map(([type, size]) => {
    const data = pngBuffer(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });

  const totalLength = 8 + iconChunks.reduce((sum, item) => sum + item.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);

  return Buffer.concat([header, ...iconChunks]);
}

mkdirSync(publicDir, { recursive: true });
mkdirSync(publicIconsDir, { recursive: true });
mkdirSync(desktopShellDir, { recursive: true });
mkdirSync(tauriIconsDir, { recursive: true });

writePng(join(publicDir, "favicon-16x16.png"), 16);
writePng(join(publicDir, "favicon-32x32.png"), 32);
writePng(join(publicDir, "favicon-48x48.png"), 48);
writePng(join(publicDir, "apple-touch-icon.png"), 180);
writePng(join(publicDir, "icon-192.png"), 192);
writePng(join(publicDir, "icon-512.png"), 512);
writePng(join(publicDir, "android-chrome-192x192.png"), 192);
writePng(join(publicDir, "android-chrome-512x512.png"), 512);
writePng(join(publicDir, "maskable-icon-512x512.png"), 512);
writeFileSync(join(publicDir, "favicon.ico"), icoBuffer([16, 32, 48]));

writePng(join(publicIconsDir, "apple-touch-icon.png"), 180);
writePng(join(publicIconsDir, "icon-96.png"), 96);
writePng(join(publicIconsDir, "icon-192.png"), 192);
writePng(join(publicIconsDir, "icon-512.png"), 512);
writePng(join(publicIconsDir, "maskable-512.png"), 512);

writePng(join(tauriIconsDir, "icon.png"), 512);
writeFileSync(join(tauriIconsDir, "icon.ico"), icoBuffer([16, 32, 48, 256]));
writeFileSync(
  join(tauriIconsDir, "icon.icns"),
  icnsBuffer([
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
  ]),
);
writeFileSync(join(desktopShellDir, "favicon.ico"), icoBuffer([16, 32, 48]));
rmSync(join(tauriIconsDir, "icon.iconset"), { recursive: true, force: true });

console.log("Generated Bezgrow app, browser, and PWA icons.");
