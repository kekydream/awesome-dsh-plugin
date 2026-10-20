/**
 * Handwriting recognition support for the meeting-room plugin.
 *
 * Extracted from index.js to keep the host entry focused on routing and meeting state.
 * This module owns the pinned DAMO model metadata, asset download/verification, ONNX
 * runtime resolution, and the child-process worker that performs recognition.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, stat, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

import { PACKAGE_DIR } from './host-constants.js'
import { activeModel, verifyModel, modelDirectory } from './host-models.js'

/** Pinned handwriting recognizer assets: the ModelScope DAMO line model and its vocabulary. */
export const HANDWRITING_ASSETS = [
  {
    name: 'handwriting-damo.onnx',
    bytes: 76859029,
    sha256: 'a98dddb2b4ee1bd0b358bd087ecebc242767eae6657682569fb5e87ce96ea82e',
    path: 'iic/cv_convnextTiny_ocr-recognition-handwritten_damo/repo?Revision=master&FilePath=model.onnx',
  },
  {
    name: 'vocab.txt',
    bytes: 30333,
    path: 'iic/cv_convnextTiny_ocr-recognition-handwritten_damo/repo?Revision=master&FilePath=vocab.txt',
  },
]

/** ModelScope answers directly from the mainland, unlike the GitHub release assets. */
export const HANDWRITING_ORIGINS = [
  'https://www.modelscope.cn/api/v1/models/',
]

/**
 * Resolve the directory holding handwriting assets.
 * @returns an absolute directory path.
 */
export function handwritingDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'handwriting')
}

/** Handwriting support as this process sees it. */
export const handwritingState = { phase: 'unprepared', message: '', modulePath: '', modelId: '', modelPath: '' }

/**
 * The handwriting model this installation runs: the registry's active choice when it is present
 * and verified, otherwise the pinned one. Same rule as the speaker model, same reason — the
 * registry is data, so a better model can be installed without touching code.
 * @returns `{ id, directory, file, path }` or null when the registry has nothing usable.
 */
export async function handwritingModelInUse() {
  const chosen = await activeModel('handwriting').catch(() => undefined)
  if (chosen === undefined || chosen.runtime !== 'onnx' || (chosen.files ?? []).length === 0) return null
  const state = await verifyModel(chosen).catch(() => null)
  if (state === null || state.verified !== true) return null
  const file = chosen.files[0]
  return {
    id: chosen.id,
    directory: modelDirectory(chosen),
    file: file.name,
    path: join(modelDirectory(chosen), file.name),
  }
}

/** The running handwriting worker, or null. */
let handwritingWorker = null

/**
 * Download any missing handwriting asset, verifying its byte count and digest.
 * @param ctx - Host context, used for logging which origin failed.
 * @returns after every asset is present.
 */
export async function ensureHandwritingAssets(ctx) {
  const directory = handwritingDirectory()
  await mkdir(directory, { recursive: true })
  for (const asset of HANDWRITING_ASSETS) {
    const target = join(directory, asset.name)
    try {
      const info = await stat(target)
      if (info.size === asset.bytes) continue
    } catch {
      // Absent: fall through to the download.
    }
    let lastError = 'no origin answered'
    for (const origin of HANDWRITING_ORIGINS) {
      const part = `${target}.${process.pid}.part`
      try {
        const response = await fetch(`${origin}${asset.path}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const chunks = []
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > asset.bytes) throw new Error('response exceeds the pinned size')
          hash.update(chunk)
          chunks.push(chunk)
        }
        if (size !== asset.bytes) throw new Error(`size ${size} differs from the pinned ${asset.bytes}`)
        if (asset.sha256 !== undefined && hash.digest('hex') !== asset.sha256) throw new Error('sha256 differs from the pinned digest')
        await writeFile(part, Buffer.concat(chunks))
        await rename(part, target)
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('meeting-room: handwriting asset failed (%s): %s', origin, lastError)
        await rm(part, { force: true })
      }
    }
    try {
      await stat(target)
    } catch {
      throw new Error(`handwriting asset ${asset.name} could not be downloaded: ${lastError}`)
    }
  }
}

/**
 * Resolve the ONNX runtime entry.
 *
 * A `peerDependencies` declaration only routes a bare specifier to an entry that exists in
 * the dsh *installation* — that is how `sherpa-onnx-node` resolves, because a shipped
 * provider depends on it. A package installed into the *profile* has no such entry, so the
 * resolver falls through to plain Node lookup and fails. Resolve from the profile directory
 * in that case; the launcher-provided context supplies the path.
 * @param ctx - Host context.
 * @returns the absolute module path to load in the worker.
 * @throws when neither location holds the runtime.
 */
export function resolveOnnxRuntime(ctx) {
  const errors = []
  try {
    return createRequire(import.meta.url).resolve('onnxruntime-node')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  // Optional service: present only in a profile launched by dsh, so read it with ctx.get.
  const profileDir = ctx.get('profileContext')?.dir
  if (typeof profileDir === 'string' && profileDir !== '') {
    try {
      return createRequire(join(profileDir, 'package.json')).resolve('onnxruntime-node')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`onnxruntime-node is not installed for this profile (${errors.join('; ')})`)
}

/**
 * Start the handwriting worker when it is not running. The model loads once per process, so
 * every later recognition is tens of milliseconds.
 * @param ctx - Host context.
 * @returns the running worker.
 */
export function ensureHandwritingWorker(ctx) {
  if (handwritingWorker !== null) return handwritingWorker
  if (handwritingState.modulePath === '') {
    handwritingState.modulePath = resolveOnnxRuntime(ctx)
  }
  const directory = handwritingDirectory()
  const child = spawn(process.execPath, [
    join(PACKAGE_DIR, 'handwriting-worker.js'),
    handwritingState.modulePath,
    // Whatever prepareHandwriting settled on; the pinned path remains the fallback.
    handwritingState.modelPath === '' ? join(directory, 'handwriting-damo.onnx') : handwritingState.modelPath,
    // The vocabulary always travels with the pinned assets; a chosen model keeps its own copy
    // in its own directory when it has one.
    handwritingState.modelPath === '' ? join(directory, 'vocab.txt') : join(handwritingState.modelPath, '..', 'vocab.txt'),
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  const worker = { child, ready: false, pending: new Map(), nextId: 1, buffer: '' }
  handwritingWorker = worker

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
            handwritingState.phase = 'ready'
            handwritingState.message = ''
            ctx.logger.info('meeting-room: handwriting worker ready (%s tokens)', message.vocab)
          } else if (typeof message.fatal === 'string') {
            handwritingState.phase = 'failed'
            handwritingState.message = message.fatal
            ctx.logger.warn('meeting-room: handwriting worker failed: %s', message.fatal)
          } else if (typeof message.id === 'string') {
            const settle = worker.pending.get(message.id)
            worker.pending.delete(message.id)
            if (settle !== undefined) settle(message)
          }
        } catch {
          ctx.logger.warn('meeting-room: unreadable handwriting worker line')
        }
      }
      index = worker.buffer.indexOf('\n')
    }
  })
  const stop = (reason) => {
    for (const settle of worker.pending.values()) settle({ error: reason })
    worker.pending.clear()
    worker.ready = false
    if (handwritingWorker === worker) handwritingWorker = null
    if (handwritingState.phase === 'ready') {
      handwritingState.phase = 'failed'
      handwritingState.message = reason
    }
  }
  child.on('exit', (code) => stop(`handwriting worker exited (${code ?? 'signal'})`))
  child.on('error', (error) => stop(`handwriting worker could not start: ${error.message}`))
  return worker
}

/**
 * Prepare handwriting support: verified assets, then a ready worker.
 * @param ctx - Host context.
 * @returns after preparation settles; state carries any failure reason.
 */
export async function prepareHandwriting(ctx) {
  if (handwritingState.phase === 'ready') return
  handwritingState.phase = 'downloading'
  handwritingState.message = ''
  try {
    // A verified model chosen in the registry is used as it is; otherwise the pinned assets are
    // fetched exactly as before.
    const inUse = await handwritingModelInUse()
    if (inUse !== null) {
      handwritingState.modelId = inUse.id
      handwritingState.modelPath = inUse.path
    } else {
      handwritingState.modelId = 'handwriting.damo.line'
      await ensureHandwritingAssets(ctx)
      handwritingState.modelPath = join(handwritingDirectory(), 'handwriting-damo.onnx')
    }
    const worker = ensureHandwritingWorker(ctx)
    const deadline = Date.now() + 120_000
    while (!worker.ready && handwritingState.phase !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!worker.ready && handwritingState.phase !== 'failed') {
      handwritingState.phase = 'failed'
      handwritingState.message = 'handwriting worker did not become ready in time'
    }
  } catch (error) {
    handwritingState.phase = 'failed'
    handwritingState.message = error instanceof Error ? error.message : String(error)
  }
}

/**
 * Recognize one packed drawing.
 * @param ctx - Host context.
 * @param payload - `{ chunks, pixelsBase64 }`.
 * @returns the recognized text, or an empty string.
 */
export async function recognizeHandwriting(ctx, payload) {
  if (handwritingState.phase !== 'ready') {
    await prepareHandwriting(ctx)
    if (handwritingState.phase !== 'ready') {
      throw new Error(handwritingState.message === '' ? 'handwriting support is unavailable' : handwritingState.message)
    }
  }
  const worker = ensureHandwritingWorker(ctx)
  const id = String(worker.nextId)
  worker.nextId += 1
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.pending.delete(id)
      reject(new Error('handwriting recognition timed out'))
    }, 60_000)
    worker.pending.set(id, (message) => {
      clearTimeout(timer)
      if (typeof message.error === 'string') reject(new Error(message.error))
      else resolve(typeof message.text === 'string' ? message.text : '')
    })
    worker.child.stdin.write(`${JSON.stringify({
      id,
      chunks: payload.chunks,
      pixelsBase64: payload.pixelsBase64,
    })}\n`)
  })
}

/**
 * Stop the handwriting worker at disposal.
 * @returns after the child process is signalled.
 */
export function disposeHandwriting() {
  const worker = handwritingWorker
  handwritingWorker = null
  if (worker !== null) {
    try {
      worker.child.stdin.end()
      worker.child.kill()
    } catch {
      // The child is already gone; nothing to release.
    }
  }
}
