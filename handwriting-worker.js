/**
 * Handwriting recognition worker for the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Runs as a child process for the same reasons as the speaker worker: the ONNX runtime is
 * native, so a fault here must not take down the harness, and inference blocks.
 *
 * Input contract, measured against the ModelScope DAMO model (see design §9.2.1):
 * the graph takes `input_images` shaped `[chunks, 3, 32, 300]` and returns `result`
 * shaped `[1, tokens, classes]`; the first axis is the number of text chunks, not a
 * batch. Callers therefore send one byte per pixel and say how many chunks they packed.
 *
 * Protocol: one JSON object per line on stdin, one per line on stdout.
 *   request  { id, chunks, pixelsBase64 }   pixels = chunks * 32 * 300 grayscale bytes
 *   reply    { id, text }                   or { id, error }
 * A `{ ready: true, classes, vocab }` line announces startup.
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Resolved `onnxruntime-node` entry, model file, vocabulary file. */
const [modulePath, modelPath, vocabPath] = process.argv.slice(2)

/** The graph's fixed spatial contract. */
const HEIGHT = 32
const WIDTH = 300
const CHANNELS = 3

/**
 * Report a fatal startup failure and exit non-zero.
 * @param message - Failure reason.
 */
function fail(message) {
  process.stdout.write(`${JSON.stringify({ fatal: message })}\n`)
  process.exit(1)
}

if (modulePath === undefined || modelPath === undefined || vocabPath === undefined) {
  fail('handwriting-worker: missing arguments')
}

let ort
try {
  const loaded = await import(pathToFileURL(modulePath).href)
  ort = loaded.default ?? loaded
} catch (error) {
  fail(`handwriting-worker: cannot load onnxruntime-node: ${error instanceof Error ? error.message : String(error)}`)
}

let session
try {
  session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
} catch (error) {
  fail(`handwriting-worker: cannot load the model: ${error instanceof Error ? error.message : String(error)}`)
}

// One token per line, UTF-8. PaddleOCR-style heads reserve index 0 for the CTC blank,
// so a vocabulary one shorter than the class count is shifted by one when decoding.
let vocab
try {
  vocab = readFileSync(vocabPath, 'utf8').split('\n').map((line) => line.replace(/\r$/u, '')).filter((line) => line !== '')
} catch (error) {
  fail(`handwriting-worker: cannot read the vocabulary: ${error instanceof Error ? error.message : String(error)}`)
}

const inputName = session.inputNames[0]
const outputName = session.outputNames[0]

/**
 * Turn packed grayscale bytes into the graph's input tensor.
 * @param bytes - One byte per pixel, chunks * 32 * 300 long.
 * @param chunks - How many text chunks the caller packed.
 * @param scale - How the byte becomes a float. Measured on this model: `01` (byte/255) is
 *   the correct scheme and recognizes real strokes, while `pm1` ([-1,1], the PaddleOCR
 *   convention) blanks every timestep and `raw` (0..255) decodes to noise. The graph does
 *   not normalize internally, so the outer scheme decides whether it sees anything.
 * @returns the input tensor.
 */
function tensorOf(bytes, chunks, scale = '01') {
  const data = new Float32Array(chunks * CHANNELS * HEIGHT * WIDTH)
  for (let chunk = 0; chunk < chunks; chunk++) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const byte = bytes[(chunk * HEIGHT + y) * WIDTH + x]
        // `pm1` maps to [-1,1], `01` to [0,1], `raw` keeps 0..255: the graph may normalize
        // internally, in which case an outer normalization destroys the signal.
        const value = scale === 'raw' ? byte : scale === '01' ? byte / 255 : (byte / 255 - 0.5) / 0.5
        // The model was trained on photographs, so one grayscale plane is replicated
        // across the three channels.
        for (let channel = 0; channel < CHANNELS; channel++) {
          data[((chunk * CHANNELS + channel) * HEIGHT + y) * WIDTH + x] = value
        }
      }
    }
  }
  return new ort.Tensor('float32', data, [chunks, CHANNELS, HEIGHT, WIDTH])
}

/**
 * Greedy CTC decode over the model's per-timestep logits.
 * @param logits - Flat float data shaped [1, tokens, classes].
 * @param tokens - Number of timesteps.
 * @param classes - Number of classes per timestep.
 * @returns the recognized text.
 */
function decode(logits, tokens, classes) {
  // The ConvNextViT head reserves index 0 for the CTC blank and index 1 as a gap, then
  // maps vocab line i to index i+2 (model.py: cnt starts at 1 and is incremented for this
  // recognizer). So the printed token is vocab[index - 2], and index 1 must be skipped.
  let text = ''
  let previous = -1
  let fired = 0
  for (let step = 0; step < tokens; step++) {
    const base = step * classes
    let best = 0
    let bestScore = logits[base]
    for (let index = 1; index < classes; index++) {
      if (logits[base + index] > bestScore) {
        bestScore = logits[base + index]
        best = index
      }
    }
    // Index 0 is blank and 1 is reserved; repeated labels collapse to one emission.
    if (best !== previous && best >= 2) {
      fired += 1
      const token = vocab[best - 2]
      if (typeof token === 'string') text += token
    }
    previous = best
  }
  const counts = new Map()
  for (let step = 0; step < tokens; step++) {
    const base = step * classes
    let best = 0
    let bestScore = logits[base]
    for (let index = 1; index < classes; index++) {
      if (logits[base + index] > bestScore) {
        bestScore = logits[base + index]
        best = index
      }
    }
    counts.set(best, (counts.get(best) ?? 0) + 1)
  }
  const histogram = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 6)
  return { text, fired, histogram, tokens, classes, vocabSize: vocab.length }
}

/**
 * Recognize one packed drawing.
 * @param request - `{ chunks, pixelsBase64 }`.
 * @returns the recognized text, or an empty string when nothing was drawn.
 */
async function recognize(request) {
  // Three chunks is what this graph accepts: one chunk fails its internal reshape, so a
  // short drawing is padded out with blank chunks by the caller.
  const chunks = Number.isInteger(request.chunks) && request.chunks > 0 ? request.chunks : 3
  const bytes = Buffer.from(typeof request.pixelsBase64 === 'string' ? request.pixelsBase64 : '', 'base64')
  const expected = chunks * HEIGHT * WIDTH
  if (bytes.length !== expected) {
    throw new Error(`handwriting-worker: expected ${expected} pixel bytes, received ${bytes.length}`)
  }
  const output = await session.run({ [inputName]: tensorOf(bytes, chunks, request.scale) })
  const value = output[outputName]
  const [, tokens, classes] = value.dims
  return decode(value.data, tokens, classes)
}
process.stdout.write(`${JSON.stringify({ ready: true, classes: null, vocab: vocab.length })}\n`)

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    process.stdout.write(`${JSON.stringify({ id: '', error: 'handwriting-worker: malformed request' })}\n`)
    return
  }
  recognize(request)
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`)
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`)
    })
})
