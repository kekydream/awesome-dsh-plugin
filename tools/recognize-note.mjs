/**
 * End-to-end check of handwriting-worker.js against a real drawing.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Decodes a PNG with Node's own zlib (no image dependency), fits it to the graph's
 * 32-pixel height, packs it into the three chunks the graph requires, feeds the worker
 * over stdin, and prints what came back. Usage:
 *   <electron> hw-test.mjs <worker> <ortEntry> <model> <vocab> <image.png>
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { inflateSync } from 'node:zlib'

const [workerPath, ortPath, modelPath, vocabPath, imagePath] = process.argv.slice(2)

/**
 * Decode a non-interlaced 8-bit PNG into RGBA rows.
 * @param buffer - Whole PNG file.
 * @returns width, height, and RGBA pixels.
 */
function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`)
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported')
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      if (filter === 1) row[x] = (row[x] + left) & 0xff
      else if (filter === 2) row[x] = (row[x] + up) & 0xff
      else if (filter === 3) row[x] = (row[x] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels
      const r = row[source]
      const g = channels >= 3 ? row[source + 1] : r
      const b = channels >= 3 ? row[source + 2] : r
      const a = channels === 4 ? row[source + 3] : 255
      const target = (y * width + x) * 4
      pixels[target] = r
      pixels[target + 1] = g
      pixels[target + 2] = b
      pixels[target + 3] = a
    }
    previous = row
  }
  return { width, height, pixels }
}

const HEIGHT = 32
const WIDTH = 300
const CHUNKS = 3

const decoded = decodePng(readFileSync(imagePath))
console.log(JSON.stringify({ step: 'decoded', width: decoded.width, height: decoded.height }))

// Crop to the ink before scaling. Fitting a whole canvas that is mostly empty shrinks the
// writing to a few pixels, which the recognizer cannot read — the crop is what keeps the
// strokes at their drawn size.
let minX = decoded.width
let minY = decoded.height
let maxX = -1
let maxY = -1
for (let y = 0; y < decoded.height; y++) {
  for (let x = 0; x < decoded.width; x++) {
    const index = (y * decoded.width + x) * 4
    const alpha = decoded.pixels[index + 3]
    const luminance = 0.299 * decoded.pixels[index] + 0.587 * decoded.pixels[index + 1] + 0.114 * decoded.pixels[index + 2]
    if (alpha > 32 && luminance < 180) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
if (maxX < 0) {
  minX = 0
  minY = 0
  maxX = decoded.width - 1
  maxY = decoded.height - 1
}
const margin = 4
minX = Math.max(0, minX - margin)
minY = Math.max(0, minY - margin)
maxX = Math.min(decoded.width - 1, maxX + margin)
maxY = Math.min(decoded.height - 1, maxY + margin)
const cropWidth = maxX - minX + 1
const cropHeight = maxY - minY + 1
console.log(JSON.stringify({ step: 'cropped', left: minX, top: minY, width: cropWidth, height: cropHeight }))

// Official ModelScope preprocessing, copied from
// modelscope/models/cv/ocr_recognition/preprocessor.py: keep-ratio resize so the height is 32
// and the width is at most 804, pasted at the TOP-LEFT of a BLACK 32x804 canvas, then three
// overlapping 300-wide windows at left = 0, 252, 504 (stride 300 - 48).
const CANVAS_WIDTH = 804
const STRIDE = 252
const ratio = cropWidth / cropHeight
const fittedWidth = Math.min(CANVAS_WIDTH, Math.max(1, Math.round(HEIGHT * ratio)))
const canvas = Buffer.alloc(HEIGHT * CANVAS_WIDTH, 0)
for (let y = 0; y < HEIGHT; y++) {
  const sy0 = minY + Math.floor(y * cropHeight / HEIGHT)
  const sy1 = Math.max(sy0 + 1, minY + Math.floor((y + 1) * cropHeight / HEIGHT))
  for (let x = 0; x < fittedWidth; x++) {
    const sx0 = minX + Math.floor(x * cropWidth / fittedWidth)
    const sx1 = Math.max(sx0 + 1, minX + Math.floor((x + 1) * cropWidth / fittedWidth))
    // Area averaging, not nearest neighbour: sampling one row in seven of a 220 px tall
    // drawing throws most of the ink away, while averaging keeps it as grey — which is what
    // a photographed page looks like and what cv2.resize produces.
    let sum = 0
    let count = 0
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const source = (Math.min(decoded.height - 1, sy) * decoded.width + Math.min(decoded.width - 1, sx)) * 4
        const alpha = decoded.pixels[source + 3] / 255
        // Dark ink over transparency composes onto white paper; only the area outside the
        // fitted image stays black, which is what upstream's zero-filled canvas provides.
        sum += decoded.pixels[source] * alpha + 255 * (1 - alpha)
        count += 1
      }
    }
    canvas[y * CANVAS_WIDTH + x] = count === 0 ? 255 : Math.round(sum / count)
  }
}

const page = Buffer.alloc(CHUNKS * HEIGHT * WIDTH, 0)
for (let chunk = 0; chunk < CHUNKS; chunk++) {
  const left = STRIDE * chunk
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sourceX = left + x
      page[(chunk * HEIGHT + y) * WIDTH + x] = sourceX < CANVAS_WIDTH ? canvas[y * CANVAS_WIDTH + sourceX] : 0
    }
  }
}

// One request, then exit: the cost that dominates a command-line run is loading the model,
// not recognizing (that is tens of milliseconds). The plugin keeps the worker resident, so
// this reload only happens here.
const child = spawn(process.execPath, [workerPath, ortPath, modelPath, vocabPath], { stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (text) => {
  buffer += text
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    console.log(line)
    if (line.includes('"ready"')) {
      child.stdin.write(`${JSON.stringify({ id: 'note', chunks: CHUNKS, scale: '01', pixelsBase64: page.toString('base64') })}\n`)
    } else if (line.includes('"id"')) {
      child.stdin.end()
      child.kill()
    }
    index = buffer.indexOf('\n')
  }
})
