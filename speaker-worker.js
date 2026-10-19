/**
 * Speaker-embedding worker for the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Runs as a child process for two reasons: the sherpa-onnx addon is native, so a fault
 * here must not be able to take down the harness; and `compute()` is synchronous, so
 * keeping it off the Host event loop keeps transcription responsive.
 *
 * The Host passes the resolved `sherpa-onnx-node` entry path, the embedding model path,
 * and the cosine threshold. The worker keeps one extractor and one gallery for its whole
 * lifetime, so a speaker keeps the same label across cues. Protocol: one JSON object per
 * line on stdin (`{ id, pcmBase64 }`), one JSON object per line on stdout
 * (`{ id, speaker }` or `{ id, error }`); a `{ ready: true, dim }` line announces startup.
 */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** Resolved `sherpa-onnx-node` entry, embedding model, and cosine threshold. */
const [modulePath, modelPath, thresholdText] = process.argv.slice(2)
const threshold = Number.isFinite(Number(thresholdText)) ? Number(thresholdText) : 0.6

/** Cue loudness below which the audio is treated as room noise rather than speech. */
const MIN_CUE_RMS = 0.006

/**
 * Report a fatal startup failure and exit non-zero.
 * @param message - Failure reason.
 */
function fail(message) {
  process.stdout.write(`${JSON.stringify({ fatal: message })}\n`)
  process.exit(1)
}

if (modulePath === undefined || modelPath === undefined) fail('speaker-worker: missing arguments')

let sherpa
try {
  const loaded = await import(pathToFileURL(modulePath).href)
  sherpa = loaded.default ?? loaded
} catch (error) {
  fail(`speaker-worker: cannot load sherpa-onnx-node: ${error instanceof Error ? error.message : String(error)}`)
}

let extractor
try {
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, provider: 'cpu', debug: 0 })
} catch (error) {
  fail(`speaker-worker: cannot load the embedding model: ${error instanceof Error ? error.message : String(error)}`)
}

const gallery = new sherpa.SpeakerEmbeddingManager(extractor.dim)
let speakers = 0

/**
 * Convert little-endian PCM16 bytes to the float samples sherpa expects.
 * @param bytes - PCM16 bytes at 16 kHz mono.
 * @returns one sample per input frame, scaled to [-1, 1].
 */
function toFloatSamples(bytes) {
  const frames = Math.floor(bytes.length / 2)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const value = bytes.readInt16LE(i * 2)
    samples[i] = value < 0 ? value / 32768 : value / 32767
  }
  return samples
}

/**
 * Measure a cue's loudness.
 * @param samples - Float samples.
 * @returns the root-mean-square amplitude.
 */
function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length)
}

/**
 * Label one cue: reuse the nearest gallery entry or enroll a new speaker.
 * @param pcmBase64 - Base64 PCM16 bytes at 16 kHz mono.
 * @returns the speaker label and the embedding behind it, or an empty label.
 */
function label(pcmBase64) {
  const samples = toFloatSamples(Buffer.from(pcmBase64, 'base64'))
  // Below roughly half a second an embedding is dominated by noise; leave it unlabelled.
  if (samples.length < 8000) return { speaker: '', embedding: '' }
  // A quiet cue would otherwise enroll silence as the first speaker and hold that slot
  // for the rest of the meeting, because the gallery never re-clusters.
  if (rmsOf(samples) < MIN_CUE_RMS) return { speaker: '', embedding: '' }
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.inputFinished()
  if (!extractor.isReady(stream)) return { speaker: '', embedding: '' }
  // The second argument must be false under Electron's V8 memory cage.
  const computed = extractor.compute(stream, false)
  // Copied out of the native buffer so the host can keep it for the end-of-meeting pass.
  const embedding = Float32Array.from(computed)
  const encoded = Buffer.from(embedding.buffer).toString('base64')
  const known = gallery.search({ v: embedding, threshold })
  if (known !== '') return { speaker: known, embedding: encoded }
  speakers += 1
  const name = `S${speakers}`
  gallery.add({ name, v: embedding })
  return { speaker: name, embedding: encoded }
}

process.stdout.write(`${JSON.stringify({ ready: true, dim: extractor.dim })}\n`)

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    process.stdout.write(`${JSON.stringify({ id: '', error: 'speaker-worker: malformed request' })}\n`)
    return
  }
  try {
    const result = label(typeof request.pcmBase64 === 'string' ? request.pcmBase64 : '')
    process.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`)
  }
})
