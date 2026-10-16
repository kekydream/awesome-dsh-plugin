/**
 * Speaker diarization support for the meeting-room plugin.
 *
 * Downloads/verifies the pinned ONNX speaker-embedding model, spawns a child-process
 * worker that loads it once, and exposes a promise-based API to label PCM cues with
 * speaker ids and embeddings.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { SPEAKER_MODEL, SPEAKER_MODEL_ORIGINS, SPEAKER_THRESHOLD } from './host-constants.js'

/** This package's own directory, used to locate the worker beside this file. */
const PACKAGE_DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Resolve the directory holding speaker models.
 * @returns an absolute directory path.
 */
export function speakerDirectory() {
  const home = process.env.DSH_HOME ?? join(require('node:os').homedir(), '.dsh')
  return join(home, 'speech-to-text', 'speakers')
}

/**
 * Speaker support as this process sees it: the model must be present and verified, and
 * the worker started, before any cue can be labelled.
 */
export const speakerState = { phase: 'unprepared', message: '', modulePath: '' }

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
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > SPEAKER_MODEL.bytes) throw new Error('response exceeds the pinned size')
        hash.update(chunk)
        chunks.push(chunk)
      }
      if (size !== SPEAKER_MODEL.bytes) throw new Error(`size ${size} differs from the pinned ${SPEAKER_MODEL.bytes}`)
      const digest = hash.digest('hex')
      if (digest !== SPEAKER_MODEL.sha256) throw new Error(`sha256 ${digest} differs from the pinned digest`)
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
    const { createRequire } = require('node:module')
    speakerState.modulePath = createRequire(import.meta.url).resolve('sherpa-onnx-node')
  }
  const child = spawn(process.execPath, [
    join(PACKAGE_DIR, 'speaker-worker.js'),
    speakerState.modulePath,
    join(speakerDirectory(), SPEAKER_MODEL.name),
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
  try {
    await ensureSpeakerModel(ctx)
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
  if (speakerState.phase !== 'ready') return none
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
