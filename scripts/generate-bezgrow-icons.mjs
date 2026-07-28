import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const publicDir = join(root, "public")
const publicIconsDir = join(publicDir, "icons")
const publicBrandDir = join(publicDir, "brand")
const desktopShellDir = join(root, "desktop-shell")
const tauriIconsDir = join(root, "src-tauri", "icons")
const sourceLogo = join(publicBrandDir, "bezgrow-growth-logo.png")
const nativeSourceLogo = join(publicBrandDir, "bezgrow-logo-3d.png")

for (const requiredLogo of [sourceLogo, nativeSourceLogo]) {
  if (!existsSync(requiredLogo)) {
    throw new Error(`Missing official Bezgrow source logo at ${requiredLogo}`)
  }
}

for (const directory of [
  publicDir,
  publicIconsDir,
  publicBrandDir,
  desktopShellDir,
  tauriIconsDir,
]) {
  mkdirSync(directory, { recursive: true })
}

async function resizePng(size, outputPath, inputPath = sourceLogo) {
  await sharp(inputPath)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false,
    })
    .ensureAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath)
}

function iconEntrySize(size) {
  return size >= 256 ? 0 : size
}

function writeIco(outputPath, iconPaths) {
  const images = iconPaths.map(({ size, path }) => ({
    size,
    buffer: readFileSync(path),
  }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(images.length * 16)
  let offset = header.length + directory.length
  images.forEach((image, index) => {
    const entry = index * 16
    directory[entry] = iconEntrySize(image.size)
    directory[entry + 1] = iconEntrySize(image.size)
    directory[entry + 2] = 0
    directory[entry + 3] = 0
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.buffer.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.buffer.length
  })

  writeFileSync(
    outputPath,
    Buffer.concat([header, directory, ...images.map((image) => image.buffer)])
  )
}

function writeIcns(outputPath, entries) {
  const chunks = entries.map(([type, path]) => {
    const data = readFileSync(path)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, "ascii")
    header.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([header, data])
  })
  const totalLength = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.alloc(8)
  header.write("icns", 0, 4, "ascii")
  header.writeUInt32BE(totalLength, 4)
  writeFileSync(outputPath, Buffer.concat([header, ...chunks]))
}

const publicTargets = [
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
]
for (const [size, outputPath] of publicTargets) {
  await resizePng(size, outputPath)
}

const windowsIconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
for (const size of windowsIconSizes) {
  await resizePng(size, join(tauriIconsDir, `${size}x${size}.png`), nativeSourceLogo)
}
for (const size of [512, 1024]) {
  await resizePng(size, join(tauriIconsDir, `${size}x${size}.png`), nativeSourceLogo)
}
await resizePng(512, join(tauriIconsDir, "icon.png"), nativeSourceLogo)

writeIco(join(publicDir, "favicon.ico"), [
  { size: 16, path: join(publicDir, "favicon-16x16.png") },
  { size: 32, path: join(publicDir, "favicon-32x32.png") },
  { size: 48, path: join(publicDir, "favicon-48x48.png") },
])
writeIco(join(desktopShellDir, "favicon.ico"), [
  { size: 16, path: join(publicDir, "favicon-16x16.png") },
  { size: 32, path: join(publicDir, "favicon-32x32.png") },
  { size: 48, path: join(publicDir, "favicon-48x48.png") },
])
writeIco(
  join(tauriIconsDir, "icon.ico"),
  windowsIconSizes.map((size) => ({
    size,
    path: join(tauriIconsDir, `${size}x${size}.png`),
  }))
)
writeIcns(join(tauriIconsDir, "icon.icns"), [
  ["icp4", join(tauriIconsDir, "16x16.png")],
  ["icp5", join(tauriIconsDir, "32x32.png")],
  ["icp6", join(tauriIconsDir, "64x64.png")],
  ["ic07", join(tauriIconsDir, "128x128.png")],
  ["ic08", join(tauriIconsDir, "256x256.png")],
  ["ic09", join(tauriIconsDir, "512x512.png")],
  ["ic10", join(tauriIconsDir, "1024x1024.png")],
])

rmSync(join(tauriIconsDir, "icon.iconset"), { recursive: true, force: true })
console.log(
  `Generated Bezgrow browser/PWA icons and a ${windowsIconSizes.length}-resolution Windows icon.`
)
