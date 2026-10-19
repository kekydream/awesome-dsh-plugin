/**
 * Speaker diarization support for the meeting-room plugin.
 *
 * Downloads/verifies the pinned ONNX speaker-embedding model, spawns a child-process
 * worker that loads it once, and exposes a promise-based API to label PCM cues with
 * speaker ids and embeddings.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, stat, rename, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Remember one voice label this meeting has produced. The per-cue speaker stays the primary
 * record, but a cue's label can be missing — the model was still downloading, or a long
 * meeting exceeded the stop-time backfill — and a reopened meeting would then claim it never
 * identified anyone. This set is persisted with the meeting and read back when it is opened.
 * @param meeting - Meeting record.
 * @param label - Voice label such as S1.
 */
export function noteSpeakerLabel(meeting, label) {
  if (meeting === undefined || typeof label !== 'string' || label === '') return
  if (!Array.isArray(meeting.speakerLabels)) meeting.speakerLabels = []
  if (!meeting.speakerLabels.includes(label)) meeting.speakerLabels.push(label)
}

/**
 * Every voice label a meeting knows about, from each source that can hold one: labels noted as
 * they were produced, labels still present on cues, and labels that carry a name (a name is
 * only ever attached to a label that existed).
 * @param meeting - Meeting record.
 * @returns labels in S1, S2, … order.
 */
export function knownSpeakerLabels(meeting) {
  const labels = new Set()
  for (const label of Array.isArray(meeting.speakerLabels) ? meeting.speakerLabels : []) {
    if (typeof label === 'string' && label !== '') labels.add(label)
  }
  for (const segment of meeting.segments ?? []) {
    if (typeof segment.speaker === 'string' && segment.speaker !== '') labels.add(segment.speaker)
  }
  for (const label of Object.keys(meeting.speakers ?? {})) {
    if (label !== '') labels.add(label)
  }
  return [...labels].sort((left, right) => {
    const leftNumber = Number(String(left).replace(/\D/gu, ''))
    const rightNumber = Number(String(right).replace(/\D/gu, ''))
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber
    return left < right ? -1 : 1
  })
}

import { SPEAKER_MODEL, SPEAKER_MODEL_ORIGINS, SPEAKER_THRESHOLD, SPEAKER_WORKER_RESTARTS, SAMPLE_RATE } from './host-constants.js'
import { exportDirectory } from './host-helpers.js'
import { activeModel, verifyModel, modelDirectory } from './host-models.js'

/** This package's own directory, used to locate the worker beside this file. */
const PACKAGE_DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Resolve the directory holding speaker models.
 * @returns an absolute directory path.
 */
export function speakerDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'speech-to-text', 'speakers')
}

/**
 * The speaker model this installation runs: the registry's active choice when it is present and
 * verified, otherwise the built-in pinned one. The registry is data, so a stronger model can be
 * installed and switched without touching code — this is the only place that knows that.
 * @returns the model entry in the shape both the downloader and the worker need.
 */
export async function speakerModelInUse() {
  const chosen = await activeModel('speaker').catch(() => undefined)
  if (chosen === undefined || chosen.runtime !== 'onnx' || (chosen.files ?? []).length === 0) return null
  const state = await verifyModel(chosen).catch(() => null)
  if (state === null || state.verified !== true) return null
  const file = chosen.files[0]
  return {
    id: chosen.id,
    name: chosen.name,
    directory: modelDirectory(chosen),
    file: file.name,
    path: join(modelDirectory(chosen), file.name),
    bytes: file.bytes ?? 0,
  }
}

/**
 * The pinned model, in the same shape, for the download path and as the fallback.
 * @returns the built-in speaker model.
 */
export function pinnedSpeakerModel() {
  return {
    id: 'speaker.campplus.zh-en.16k',
    name: '3D-Speaker CAM++（中英，16 kHz）',
    directory: speakerDirectory(),
    file: SPEAKER_MODEL.name,
    path: join(speakerDirectory(), SPEAKER_MODEL.name),
    bytes: SPEAKER_MODEL.bytes,
  }
}

/**
 * Speaker support as this process sees it: the model must be present and verified, and
 * the worker started, before any cue can be labelled. The byte counters let the panel
 * render a real download percentage instead of an indeterminate spinner.
 */
export const speakerState = { phase: 'unprepared', message: '', modulePath: '', completedBytes: 0, totalBytes: 0, modelId: '', modelPath: '' }

/** The running speaker worker, or null. */
export let speakerWorker = null

/**
 * Download the pinned speaker model, verifying its byte count and SHA-256 first.
 * @param ctx - Host context, used for logging which origin failed.
 * @returns after a verified model is in place.
 */
export async function ensureSpeakerModel(ctx) {
  const directory = speakerDirectory()
  await mkdir(directory, { recursive: true })
  const target = join(directory, SPEAKER_MODEL.name)
  try {
    const info = await stat(target)
    if (info.size === SPEAKER_MODEL.bytes) return
  } catch {
    // Absent: fall through to the download.
  }
  let lastError = 'no origin answered'
  for (const origin of SPEAKER_MODEL_ORIGINS) {
    const part = `${target}.${process.pid}.part`
    try {
      const response = await fetch(`${origin}${SPEAKER_MODEL.name}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const chunks = []
      const hash = createHash('sha256')
      let size = 0
      speakerState.completedBytes = 0
      speakerState.totalBytes = SPEAKER_MODEL.bytes
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > SPEAKER_MODEL.bytes) throw new Error('response exceeds the pinned size')
        hash.update(chunk)
        chunks.push(chunk)
        // The browser polls /speaker every two seconds while downloading, so the
        // counter needs no throttling of its own.
        speakerState.completedBytes = size
      }
      if (size !== SPEAKER_MODEL.bytes) throw new Error(`size ${size} differs from the pinned ${SPEAKER_MODEL.bytes}`)
      const digest = hash.digest('hex')
      if (digest !== SPEAKER_MODEL.sha256) throw new Error(`sha256 ${digest} differs from the pinned digest`)
      speakerState.completedBytes = SPEAKER_MODEL.bytes
      await writeFile(part, Buffer.concat(chunks))
      await rename(part, target)
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('meeting-room: speaker model origin failed (%s): %s', origin, lastError)
      await rm(part, { force: true })
    }
  }
  throw new Error(`speaker model download failed: ${lastError}`)
}

/**
 * Start the speaker worker when it is not running.
 * @param ctx - Host context.
 * @returns the running worker.
 */
export function ensureSpeakerWorker(ctx) {
  if (speakerWorker !== null) return speakerWorker
  if (speakerState.modulePath === '') {
    // The runtime hands us the installation's copy only because this package declares
    // `sherpa-onnx-node` as a peer dependency; a bare specifier resolves no other way.
    speakerState.modulePath = createRequire(import.meta.url).resolve('sherpa-onnx-node')
  }
  const child = spawn(process.execPath, [
    join(PACKAGE_DIR, 'speaker-worker.js'),
    speakerState.modulePath,
    // Whatever prepareSpeakers settled on: a model installed through the registry, or the
    // pinned one. Never a guess — the path is only set once the file is verified.
    speakerState.modelPath === '' ? join(speakerDirectory(), SPEAKER_MODEL.name) : speakerState.modelPath,
    String(SPEAKER_THRESHOLD),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const worker = { child, ready: false, pending: new Map(), nextId: 1, buffer: '' }
  speakerWorker = worker

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (text) => {
    worker.buffer += text
    let index = worker.buffer.indexOf('\n')
    while (index !== -1) {
      const line = worker.buffer.slice(0, index).trim()
      worker.buffer = worker.buffer.slice(index + 1)
      if (line !== '') {
        try {
          const message = JSON.parse(line)
          if (message.ready === true) {
            worker.ready = true
            speakerState.phase = 'ready'
            speakerState.message = ''
            ctx.logger.info('meeting-room: speaker worker ready (dim %s)', message.dim)
          } else if (typeof message.fatal === 'string') {
            speakerState.phase = 'failed'
            speakerState.message = message.fatal
            ctx.logger.warn('meeting-room: speaker worker failed: %s', message.fatal)
          } else if (typeof message.id === 'string') {
            const settle = worker.pending.get(message.id)
            worker.pending.delete(message.id)
            if (settle !== undefined) {
              settle({
                speaker: typeof message.speaker === 'string' ? message.speaker : '',
                embedding: typeof message.embedding === 'string' ? message.embedding : '',
              })
            }
          }
        } catch {
          ctx.logger.warn('meeting-room: unreadable speaker worker line')
        }
      }
      index = worker.buffer.indexOf('\n')
    }
  })
  const stop = (reason) => {
    for (const settle of worker.pending.values()) settle('')
    worker.pending.clear()
    worker.ready = false
    if (speakerWorker === worker) speakerWorker = null
    if (speakerState.phase === 'ready') {
      speakerState.phase = 'failed'
      speakerState.message = reason
    }
  }
  child.on('exit', (code) => stop(`speaker worker exited (${code ?? 'signal'})`))
  child.on('error', (error) => stop(`speaker worker could not start: ${error.message}`))
  return worker
}

/**
 * Prepare speaker support: verified model, then a ready worker.
 * @param ctx - Host context.
 * @returns after preparation settles; state carries any failure reason.
 */
export async function prepareSpeakers(ctx) {
  if (speakerState.phase === 'ready') return
  speakerState.phase = 'downloading'
  speakerState.message = ''
  speakerState.totalBytes = SPEAKER_MODEL.bytes
  speakerState.completedBytes = 0
  try {
    // A model chosen in the registry and already verified here is used as it is: that is what
    // makes "install a stronger local model" mean something. Otherwise the pinned model is
    // fetched exactly as before.
    const inUse = await speakerModelInUse()
    if (inUse !== null) {
      speakerState.modelId = inUse.id
      speakerState.modelPath = inUse.path
      speakerState.totalBytes = inUse.bytes
      speakerState.completedBytes = inUse.bytes
    } else {
      speakerState.modelId = 'speaker.campplus.zh-en.16k'
      await ensureSpeakerModel(ctx)
      speakerState.modelPath = join(speakerDirectory(), SPEAKER_MODEL.name)
    }
    const worker = ensureSpeakerWorker(ctx)
    const deadline = Date.now() + 60_000
    while (!worker.ready && speakerState.phase !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!worker.ready && speakerState.phase !== 'failed') {
      speakerState.phase = 'failed'
      speakerState.message = 'speaker worker did not become ready in time'
    }
  } catch (error) {
    speakerState.phase = 'failed'
    speakerState.message = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Label one cue, or return an empty label when speaker support is unavailable.
 * @param ctx - Host context.
 * @param pcm - Raw PCM16 bytes of the cue.
 * @returns the speaker label and its base64 embedding, both empty when unjudged.
 */
export async function labelCue(ctx, pcm) {
  const none = { speaker: '', embedding: '' }
  if (speakerState.phase !== 'ready') {
    // A worker that died mid-meeting must not silently end labeling for the rest of
    // the meeting; 'unprepared' means the model itself is missing, so only a failed
    // worker is worth one bounded revive attempt.
    if (speakerState.phase !== 'failed') return none
    if (!(await reviveSpeakerWorker(ctx))) return none
  }
  let worker
  try {
    worker = ensureSpeakerWorker(ctx)
  } catch (error) {
    speakerState.phase = 'failed'
    speakerState.message = error instanceof Error ? error.message : String(error)
    return none
  }
  if (!worker.ready) return none
  const id = String(worker.nextId)
  worker.nextId += 1
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id)
      resolve(none)
    }, 20_000)
    worker.pending.set(id, (reply) => {
      clearTimeout(timer)
      resolve(typeof reply === 'string' ? { speaker: reply, embedding: '' } : reply ?? none)
    })
    worker.child.stdin.write(`${JSON.stringify({ id, pcmBase64: pcm.toString('base64') })}\n`)
  })
}

/** How many times this process has revived the worker; bounded by SPEAKER_WORKER_RESTARTS. */
let workerRestarts = 0

/**
 * Bring the worker back after an unexpected exit and wait for it to load the model.
 * The restarted worker numbers voices from scratch, which is harmless: the
 * end-of-meeting repass re-clusters every cue by its stored embedding.
 * @param ctx - Host context.
 * @returns whether a fresh worker reported ready.
 */
async function reviveSpeakerWorker(ctx) {
  if (workerRestarts >= SPEAKER_WORKER_RESTARTS) return false
  workerRestarts += 1
  try {
    const worker = ensureSpeakerWorker(ctx)
    const deadline = Date.now() + 20_000
    // The worker clears itself from the module slot when it dies, so that slot is the
    // liveness signal while the phase still reads 'failed'.
    while (!worker.ready && speakerWorker === worker && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (worker.ready) {
      speakerState.phase = 'ready'
      speakerState.message = ''
      ctx.logger.info('meeting-room: speaker worker revived')
      return true
    }
    return false
  } catch {
    return false
  }
}

/** WAV header bytes in front of the PCM payload of this plugin's own recordings. */
const WAV_HEADER_BYTES = 44

/**
 * Where one cue's audio sits inside the recording's PCM payload. Cue audio is written
 * back to back, so a cue's start/end seconds map linearly onto PCM16 bytes; the same
 * mapping the recorder used when it accumulated `meeting.seconds`.
 * @param segment - cue carrying start/end in seconds.
 * @returns byte offsets relative to the PCM payload.
 */
export function pcmRangeOf(segment) {
  const from = Math.max(0, Math.round(segment.start * SAMPLE_RATE) * 2)
  const to = Math.max(from, Math.round(segment.end * SAMPLE_RATE) * 2)
  return { from, to }
}

/**
 * Re-judge cues from the finished recording. Used at stop to label the cues captured
 * before the speaker model finished downloading, and by the panel's re-identify
 * action over an existing meeting.
 * @param ctx - Host context.
 * @param meeting - meeting whose recording is on disk.
 * @param options - `all` re-judges every cue; otherwise only unlabeled cues, and
 *                  `limit` (0 = uncapped) bounds how many are judged.
 * @returns the number of cues that received a label.
 */
export async function relabelFromRecording(ctx, meeting, options = {}) {
  if (speakerState.phase !== 'ready') return 0
  const all = options.all === true
  const limit = typeof options.limit === 'number' ? options.limit : 0
  const audioPath = typeof meeting.audioPath === 'string' && meeting.audioPath !== ''
    ? meeting.audioPath
    : (typeof meeting.audioName === 'string' && meeting.audioName !== '' ? join(exportDirectory(), meeting.audioName) : '')
  if (audioPath === '') return 0
  let handle
  try {
    handle = await open(audioPath, 'r')
  } catch {
    // The recording is gone (cleaned up by hand): nothing to re-judge.
    return 0
  }
  let judged = 0
  try {
    for (const segment of meeting.segments) {
      if (limit > 0 && judged >= limit) break
      const labeled = typeof segment.speaker === 'string' && segment.speaker !== ''
      if (labeled && !all) continue
      const { from, to } = pcmRangeOf(segment)
      // Below half a second the embedding measures noise, not a voice.
      if (to - from < SAMPLE_RATE) continue
      const buffer = Buffer.alloc(to - from)
      const read = await handle.read(buffer, 0, buffer.length, WAV_HEADER_BYTES + from)
      if (read.bytesRead < buffer.length) continue
      const result = await labelCue(ctx, buffer)
      if (result.speaker === '') continue
      segment.speaker = result.speaker
      noteSpeakerLabel(meeting, result.speaker)
      if (result.embedding !== '') segment.embedding = result.embedding
      judged += 1
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  return judged
}

/**
 * Stop the speaker worker at disposal.
 * @returns after the child process is signalled.
 */
export function disposeSpeakers() {
  const worker = speakerWorker
  speakerWorker = null
  if (worker !== null) {
    try {
      worker.child.stdin.end()
      worker.child.kill()
    } catch {
      // The child is already gone; nothing to release.
    }
  }
}
