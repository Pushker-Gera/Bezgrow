import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");
const publicIconsDir = join(publicDir, "icons");
const publicBrandDir = join(publicDir, "brand");
const desktopShellDir = join(root, "desktop-shell");
const tauriIconsDir = join(root, "src-tauri", "icons");
const sourceLogo = join(publicBrandDir, "bezgrow-growth-logo.png");

if (!existsSync(sourceLogo)) {
  throw new Error(`Missing official Bezgrow source logo at ${sourceLogo}`);
}

function ensureDirectories() {
  for (const directory of [publicDir, publicIconsDir, publicBrandDir, desktopShellDir, tauriIconsDir]) {
    mkdirSync(directory, { recursive: true });
  }
}

function resizePng(size, outputPath) {
  const result = spawnSync("sips", ["-z", String(size), String(size), sourceLogo, "--out", outputPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Unable to create ${outputPath} with sips.\n${result.stderr || result.stdout}`);
  }

  normalizePngToRgba(outputPath);
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readPng(path) {
  const file = readFileSync(path);
  if (!file.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${path} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("ascii");
    const data = file.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(`${path} must be an 8-bit non-interlaced RGB/RGBA PNG.`);
  }

  const sourceBpp = colorType === 6 ? 4 : 3;
  const rowLength = width * sourceBpp;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const reconstructed = Buffer.alloc(rowLength * height);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * rowLength;
    const prevRowStart = rowStart - rowLength;

    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= sourceBpp ? reconstructed[rowStart + x - sourceBpp] : 0;
      const up = y > 0 ? reconstructed[prevRowStart + x] : 0;
      const upperLeft = y > 0 && x >= sourceBpp ? reconstructed[prevRowStart + x - sourceBpp] : 0;
      const current = raw[rawOffset + x];

      reconstructed[rowStart + x] = (
        filter === 0 ? current :
          filter === 1 ? current + left :
            filter === 2 ? current + up :
              filter === 3 ? current + Math.floor((left + up) / 2) :
                filter === 4 ? current + paeth(left, up, upperLeft) :
                  current
      ) & 0xff;
    }

    rawOffset += rowLength;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * sourceBpp;
    const target = pixel * 4;
    rgba[target] = reconstructed[source];
    rgba[target + 1] = reconstructed[source + 1];
    rgba[target + 2] = reconstructed[source + 2];
    rgba[target + 3] = colorType === 6 ? reconstructed[source + 3] : 255;
  }

  return { width, height, rgba };
}

function writePng(path, width, height, rgba) {
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
    rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  writeFileSync(path, Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function normalizePngToRgba(path) {
  const { width, height, rgba } = readPng(path);
  writePng(path, width, height, rgba);
}

function iconEntrySize(size) {
  return size >= 256 ? 0 : size;
}

function writeIco(outputPath, iconPaths) {
  const images = iconPaths.map(({ size, path }) => ({ size, buffer: readFileSync(path) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    directory[entry] = iconEntrySize(image.size);
    directory[entry + 1] = iconEntrySize(image.size);
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.buffer.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.buffer.length;
  });

  writeFileSync(outputPath, Buffer.concat([header, directory, ...images.map((image) => image.buffer)]));
}

function writeIcns(outputPath, entries) {
  const chunks = entries.map(([type, path]) => {
    const data = readFileSync(path);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(outputPath, Buffer.concat([header, ...chunks]));
}

ensureDirectories();

const pngTargets = [
  [16, join(publicDir, "favicon-16x16.png")],
  [32, join(publicDir, "favicon-32x32.png")],
  [48, join(publicDir, "favicon-48x48.png")],
  [180, join(publicDir, "apple-touch-icon.png")],
  [192, join(publicDir, "icon-192.png")],
  [512, join(publicDir, "icon-512.png")],
  [192, join(publicDir, "android-chrome-192x192.png")],
  [512, join(publicDir, "android-chrome-512x512.png")],
  [512, join(publicDir, "maskable-icon-512x512.png")],
  [180, join(publicIconsDir, "apple-touch-icon.png")],
  [96, join(publicIconsDir, "icon-96.png")],
  [192, join(publicIconsDir, "icon-192.png")],
  [512, join(publicIconsDir, "icon-512.png")],
  [512, join(publicIconsDir, "maskable-512.png")],
  [96, join(publicIconsDir, "shortcut-dashboard.png")],
  [96, join(publicIconsDir, "shortcut-products.png")],
  [96, join(publicIconsDir, "shortcut-invoices.png")],
  [512, join(desktopShellDir, "logo.png")],
  [32, join(tauriIconsDir, "32x32.png")],
  [64, join(tauriIconsDir, "64x64.png")],
  [128, join(tauriIconsDir, "128x128.png")],
  [256, join(tauriIconsDir, "256x256.png")],
  [512, join(tauriIconsDir, "512x512.png")],
  [512, join(tauriIconsDir, "icon.png")],
  [1024, join(tauriIconsDir, "1024x1024.png")],
];

for (const [size, path] of pngTargets) {
  resizePng(size, path);
}

writeIco(join(publicDir, "favicon.ico"), [
  { size: 16, path: join(publicDir, "favicon-16x16.png") },
  { size: 32, path: join(publicDir, "favicon-32x32.png") },
  { size: 48, path: join(publicDir, "favicon-48x48.png") },
]);

writeIco(join(desktopShellDir, "favicon.ico"), [
  { size: 16, path: join(publicDir, "favicon-16x16.png") },
  { size: 32, path: join(publicDir, "favicon-32x32.png") },
  { size: 48, path: join(publicDir, "favicon-48x48.png") },
]);

writeIco(join(tauriIconsDir, "icon.ico"), [
  { size: 16, path: join(publicDir, "favicon-16x16.png") },
  { size: 32, path: join(tauriIconsDir, "32x32.png") },
  { size: 48, path: join(publicDir, "favicon-48x48.png") },
  { size: 256, path: join(tauriIconsDir, "256x256.png") },
]);

writeIcns(join(tauriIconsDir, "icon.icns"), [
  ["icp4", join(publicDir, "favicon-16x16.png")],
  ["icp5", join(tauriIconsDir, "32x32.png")],
  ["icp6", join(tauriIconsDir, "64x64.png")],
  ["ic07", join(tauriIconsDir, "128x128.png")],
  ["ic08", join(tauriIconsDir, "256x256.png")],
  ["ic09", join(tauriIconsDir, "512x512.png")],
  ["ic10", join(tauriIconsDir, "1024x1024.png")],
]);

rmSync(join(tauriIconsDir, "icon.iconset"), { recursive: true, force: true });

console.log("Generated Bezgrow Growth Chart app, browser, and PWA icons.");
