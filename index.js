/**
 * Host half of the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：kekydream@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Serves the browser half over same-origin HTTP routes on the harness's own web server:
 * the client posts 16 kHz mono PCM16 cues, this half wraps each cue in a WAV container,
 * transcribes it through the existing speech capability (`ctx.speechToText`, the local
 * SenseVoice provider), and keeps the meeting's timed segments in memory.
 *
 * It also exposes `meeting_read`, the one path by which the transcript reaches a model.
 * The tool result is a core session event, so "model-visible ⟺ reconstructable from the
 * log" holds without this plugin declaring session event types of its own — which an
 * out-of-repository plugin may not do (a custom event type outside the generated known
 * list makes a stored session unreadable on resume). Durable artifacts stay files.
 *
 * Scope: one process, in-memory meetings. Speaker separation, key points, task sync,
 * ink, and the RTC room follow.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Loader-facing plugin name. */
export const name = 'meeting-room'

/** Routes for the browser half, the speech capability, the transcript tool, and the speaker worker. */
export const inject = ['webServer', 'speechToText', 'tools']

/** Route prefix owned by this plugin. */
const PREFIX = '/meeting-room'

/** Accepted request body ceiling; one 8-second 16 kHz mono PCM16 cue is ~256 KB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Ceiling for one exported artifact. */
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024

/** Exported files per request. */
const MAX_ARTIFACTS = 8

/** Sample rate the browser half sends. */
const SAMPLE_RATE = 16000

/** Accepted artifact name: one path segment, first character alphanumeric, no traversal. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Pinned speaker-embedding model: 3D-Speaker CAM++, Chinese/English, 16 kHz. */
const SPEAKER_MODEL = {
  name: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  bytes: 28281138,
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
}

/**
 * Origins tried in order for the pinned model. The sherpa models are GitHub release
 * assets, so the Hugging Face mirror the speech provider uses does not cover them, and
 * mainland networks routinely drop direct github.com transfers; the public proxies are
 * the same ones the plugin market uses.
 */
const SPEAKER_MODEL_ORIGINS = [
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
  'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
]

/** Cosine similarity above which a cue joins an existing speaker instead of creating one. */
const SPEAKER_THRESHOLD = 0.6

/** Point kinds the model may use; anything else is stored as a plain point. */
const POINT_KINDS = ['decision', 'point', 'risk', 'question']

/** Task priorities the model may use; anything else is stored as normal. */
const TASK_PRIORITIES = ['high', 'normal', 'low']

/** This package's own directory, used to locate the worker beside this file. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))


/**
 * Decide whether a caller-supplied artifact name may be joined to the meetings directory.
 * @param name - Requested file name.
 * @returns whether the name is a single traversal-free segment.
 */
function isSafeArtifactName(name) {
  return SAFE_NAME.test(name) && !name.includes('..')
}

/** Default cue ceiling returned by the transcript tool. */
const DEFAULT_CUE_LIMIT = 400

/** Largest cue ceiling the tool accepts. */
const MAX_CUE_LIMIT = 4000

/** In-memory meetings, keyed by meeting id. */
const meetings = new Map()

/**
 * Write a JSON response.
 * @param res - Response owned by this route.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

/**
 * Collect a request body with a hard size ceiling.
 * @param req - Incoming request.
 * @returns the body bytes.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Reject cross-origin browser calls; requests without an Origin header (curl, tests) pass.
 * @param req - Incoming request.
 * @returns whether the request may proceed.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/**
 * Wrap raw little-endian PCM16 mono samples in a canonical WAV container.
 * @param pcm - Raw PCM16 bytes.
 * @param sampleRate - Samples per second.
 * @returns complete WAV bytes.
 */
function wavFromPcm(pcm, sampleRate) {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])
}

/**
 * Build the 44-byte canonical WAV header for 16 kHz mono PCM16.
 * @param dataBytes - PCM payload size in bytes.
 * @param sampleRate - Samples per second.
 * @returns the header bytes.
 */
function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * Map an artifact extension to the type the browser needs to display it.
 * @param name - Artifact file name.
 * @returns the Content-Type header value.
 */
function contentTypeOf(name) {
  if (name.endsWith('.wav')) return 'audio/wav'
  if (name.endsWith('.png')) return 'image/png'
  return 'text/plain; charset=utf-8'
}

/**
 * Render a local date and time for file names, matching the browser half's stamp.
 * @param at - Epoch milliseconds.
 * @returns `YYYY-MM-DD_HH-MM-SS` in local time.
 */
function stampOf(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${day}_${time}`
}

/**
 * Resolve the directory exports are written to.
 * @returns an absolute directory path.
 */
function exportDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meetings')
}

/**
 * Resolve an interpreter that can import python-docx: an explicit override, the bundled
 * runtime payload, then whatever `python3`/`python` is on the path.
 * @returns the command to run, or an empty string when none is usable.
 */
async function pythonExecutable() {
  const candidates = []
  if (typeof process.env.DSH_PYTHON === 'string' && process.env.DSH_PYTHON !== '') candidates.push(process.env.DSH_PYTHON)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    const runtimes = await readdir(join(home, 'dsh-runtimes'))
    for (const name of runtimes) {
      candidates.push(join(home, 'dsh-runtimes', name, 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'python3'))
    }
  } catch {
    // No bundled runtimes under this home; the path below may still have one.
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

/**
 * Build the structured content of the minutes document, shared by the Word export.
 * @param meeting - Meeting record.
 * @returns the payload the document renderer consumes.
 */
function minutesBlocks(meeting) {
  const terms = meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const sections = []
  const push = (title, items) => {
    if (items.length > 0) sections.push({ title, items })
  }
  push('一、决议', meeting.points.filter((point) => point.kind === 'decision').map((point) => point.text))
  push('二、要点', meeting.points.filter((point) => point.kind === 'point').map((point) => point.text))
  push('三、风险与待确认', meeting.points
    .filter((point) => point.kind === 'risk' || point.kind === 'question')
    .map((point) => `[${point.kind === 'risk' ? '风险' : '待确认'}] ${point.text}`))
  const written = meeting.notes.filter((note) => typeof note.text === 'string' && note.text !== '')
  push('五、手写笔记', written.map((note) => note.text.replace(/\n/gu, '　')))
  push('七、订正对照', (meeting.revisions ?? []).map((change) => `${change.from} → ${change.to}`))
  return {
    title: '会议纪要',
    meta: [
      ['会议编号', meeting.id],
      ['开始时间', new Date(meeting.startedAt).toLocaleString()],
      ['时长', clockOf(meeting.seconds)],
      ['段落数', String(meeting.segments.length)],
      ['我的角色', ROLE_LABELS[meeting.role] ?? '（未选择）'],
      ['录音文件', meeting.audioName === undefined ? '（无）' : meeting.audioName],
      ['术语表', terms.length === 0 ? '（未提供）' : terms.join('、')],
    ],
    sections,
    table: meeting.tasks.length === 0 ? null : {
      title: '四、工作安排',
      headers: ['事项', '负责人', '时间', '优先级', '状态'],
      rows: meeting.tasks.map((task) => [
        task.title,
        task.owner === '' ? '未定' : task.owner,
        task.due === '' ? '未定' : task.due,
        task.priority,
        task.status === 'confirmed' ? '已确认' : '待确认',
      ]),
    },
    transcript: meeting.segments.length === 0 ? null : {
      title: '六、会议实录',
      lines: meeting.segments.map((segment) => {
        const speaker = displaySpeaker(meeting, segment.speaker)
        return `[${clockOf(segment.start)}]${speaker === '' ? '' : ` ${speaker}`} ${seenText(segment)}`
      }),
    },
    footer: '实录由本机语音识别生成，可能含错字；原文永远保留，作为订正的依据。',
  }
}

/**
 * Render the minutes as a Word document through the bundled Python.
 * @param ctx - Host context, used to log a renderer failure.
 * @param meeting - Meeting record.
 * @param name - File name to write inside the export directory.
 * @returns the written file name.
 */
async function writeDocx(ctx, meeting, name) {
  const directory = exportDirectory()
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  const python = await pythonExecutable()
  const script = join(PACKAGE_DIR, 'minutes-docx.py')
  const payload = JSON.stringify(minutesBlocks(meeting))
  await new Promise((resolve, reject) => {
    const child = spawn(python, [script, target], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    child.on('error', (error) => reject(new Error(`无法启动 Python：${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        ctx.logger.warn('meeting-room: docx renderer failed: %s', errors.trim())
        reject(new Error(errors.trim() === '' ? `Python 退出码 ${code}` : errors.trim()))
      }
    })
    child.stdin.end(payload, 'utf8')
  })
  return name
}

/**
 * Resolve the directory holding speaker models.
 * @returns an absolute directory path.
 */
function speakerDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'speech-to-text', 'speakers')
}

/**
 * Resolve the directory meeting records are persisted to.
 * @returns an absolute directory path.
 */
function meetingStoreDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'meetings')
}

/**
 * Serialize one meeting for the store, dropping what cannot outlive the process.
 * @param meeting - Meeting record.
 * @returns the JSON text to write.
 */
function recordOf(meeting) {
  // A writer handle and an abort controller are process-local; speaker embeddings belong to
  // the recording that produced them and are rebuilt by the next one.
  const { audioHandle, controller, ...rest } = meeting
  const segments = rest.segments.map(({ embedding, ...segment }) => segment)
  return JSON.stringify({
    ...rest,
    segments,
    role: meeting.role ?? '',
    revisions: meeting.revisions ?? [],
    speakers: meeting.speakers ?? {},
  })
}

/** Serialized text last written per meeting, so a flush skips unchanged records. */
const persisted = new Map()

/**
 * Write every meeting whose record changed. Called periodically and when a recording stops,
 * so points, tasks, notes, corrections and speaker names survive a restart without a write
 * on every keystroke-sized change.
 * @param ctx - Host context, used to log a write failure.
 * @returns after every pending write settles.
 */
async function flushMeetings(ctx) {
  const directory = meetingStoreDirectory()
  for (const meeting of meetings.values()) {
    const text = recordOf(meeting)
    if (persisted.get(meeting.id) === text) continue
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${meeting.id}.json`), text, 'utf8')
      persisted.set(meeting.id, text)
    } catch (error) {
      ctx.logger.warn('meeting-room: could not persist %s: %s', meeting.id, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * Load every persisted meeting back into memory.
 * @param ctx - Host context.
 * @returns the number of meetings recovered.
 */
async function restoreMeetings(ctx) {
  const directory = meetingStoreDirectory()
  let names = []
  try {
    names = await readdir(directory)
  } catch {
    // No store yet: the first meeting creates it.
    return 0
  }
  let restored = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
      if (typeof record.id !== 'string' || record.id === '') continue
      // A restored record is history: it gets no writer handle, and its controller only
      // guards future work.
      meetings.set(record.id, {
        seconds: 0,
        segments: [],
        points: [],
        tasks: [],
        notes: [],
        terms: '',
        role: '',
        revisions: [],
        speakers: {},
        ...record,
        controller: new AbortController(),
      })
      restored += 1
    } catch (error) {
      ctx.logger.warn('meeting-room: could not restore %s: %s', name, error instanceof Error ? error.message : String(error))
    }
  }
  return restored
}

/**
 * Speaker support as this process sees it: the model must be present and verified, and
 * the worker started, before any cue can be labelled.
 */
const speakerState = { phase: 'unprepared', message: '', modulePath: '' }

/** The running speaker worker, or null. */
let speakerWorker = null

/**
 * Download the pinned speaker model, verifying its byte count and SHA-256 first.
 * @param ctx - Host context, used for logging which origin failed.
 * @returns after a verified model is in place.
 */
async function ensureSpeakerModel(ctx) {
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
function ensureSpeakerWorker(ctx) {
  if (speakerWorker !== null) return speakerWorker
  if (speakerState.modulePath === '') {
    // The runtime hands us the installation's copy only because this package declares
    // `sherpa-onnx-node` as a peer dependency; a bare specifier resolves no other way.
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
async function prepareSpeakers(ctx) {
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
async function labelCue(ctx, pcm) {
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
function disposeSpeakers() {
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

/** Pinned handwriting recognizer assets: the ModelScope DAMO line model and its vocabulary. */
const HANDWRITING_ASSETS = [
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
const HANDWRITING_ORIGINS = [
  'https://www.modelscope.cn/api/v1/models/',
]

/**
 * Resolve the directory holding handwriting assets.
 * @returns an absolute directory path.
 */
function handwritingDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'handwriting')
}

/** Handwriting support as this process sees it. */
const handwritingState = { phase: 'unprepared', message: '', modulePath: '' }

/** The running handwriting worker, or null. */
let handwritingWorker = null

/**
 * Download any missing handwriting asset, verifying its byte count and digest.
 * @param ctx - Host context, used for logging which origin failed.
 * @returns after every asset is present.
 */
async function ensureHandwritingAssets(ctx) {
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
function resolveOnnxRuntime(ctx) {
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
function ensureHandwritingWorker(ctx) {
  if (handwritingWorker !== null) return handwritingWorker
  if (handwritingState.modulePath === '') {
    handwritingState.modulePath = resolveOnnxRuntime(ctx)
  }
  const directory = handwritingDirectory()
  const child = spawn(process.execPath, [
    join(PACKAGE_DIR, 'handwriting-worker.js'),
    handwritingState.modulePath,
    join(directory, 'handwriting-damo.onnx'),
    join(directory, 'vocab.txt'),
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
async function prepareHandwriting(ctx) {
  if (handwritingState.phase === 'ready') return
  handwritingState.phase = 'downloading'
  handwritingState.message = ''
  try {
    await ensureHandwritingAssets(ctx)
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
async function recognizeHandwriting(ctx, payload) {
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
function disposeHandwriting() {
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

/**
 * Render seconds as m:ss.
 * @param seconds - Offset in seconds.
 * @returns the clock text.
 */
function clockOf(seconds) {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Select the meeting a request refers to: an explicit id, else this session's newest.
 * @param sessionId - Session making the request, when known.
 * @param meetingId - Explicit meeting id, when given.
 * @returns the meeting, or undefined when none matches.
 */
function findMeeting(sessionId, meetingId) {
  if (meetingId !== '') return meetings.get(meetingId)
  let found
  for (const meeting of meetings.values()) {
    if (sessionId !== '' && meeting.sessionId !== sessionId) continue
    if (found === undefined || meeting.startedAt > found.startedAt) found = meeting
  }
  return found
}

/** Action verbs that make a cue read as a work assignment. */
const ACTION_VERBS = /(负责|跟进|安排|准备|整理|确认|联系|发送|发一|写|订|约|更新|修改|修复|调研|评估|输出|推动|协调|通知|提醒|回|答复|交给|处理)/u

/** Due expressions a cue may carry. */
const DUE_PATTERNS = /(今天|明天|后天|今晚|明早|本周|这周|下周|周末|月底|月初|下个月|下月|周一|周二|周三|周四|周五|周六|周日|周天|马上|尽快|立即|本周内|这周内|下周一|下周二|下周三|下周四|下周五|\d{1,2}\s*[点:：]\s*\d{0,2}|\d{1,2}\s*[号日]|\d{1,2}\s*月\s*\d{1,2}\s*[号日]?)/u

/** Urgency markers. */
const HIGH_PRIORITY = /(紧急|尽快|马上|立即|重要|优先|务必|必须)/u
const LOW_PRIORITY = /(有空|方便|不急|稍后|之后|回头|改天|不着急)/u

/** Owner phrase: "X负责/跟进/来/去…" with a short name-like lead token. */
const OWNER_PATTERNS = [
  /(?:请|让|麻烦|叫|由|交给)(.{1,6}?)(?:负责|跟进|处理|整理|准备|确认|通知|联系|写|订|回复|安排)/u,
  /(.{1,4}?)(?:负责|来跟进|牵头|主导)/u,
]

/** Markers that turn a cue into a decision, a risk, or an open question. */
const DECISION_MARKERS = /(决定|结论|就这么定|定下来|敲定|通过|同意|就这么办|一致同意|定了|确认了)/u
const RISK_MARKERS = /(风险|担心|隐患|注意|小心|千万|别|不要|避免|防止|可能有问题|有坑|告警)/u
const QUESTION_MARKERS = /(要不要|是否|怎么办|如何|怎么|谁来|谁去|什么问题|待定|再议|不确定|需不需要|能不能|为什么)/u

/**
 * Pull draft work assignments from the transcript with plain rules — no model, no login.
 * A task is the cue's own words, which is the honest artifact a human later confirms.
 * @param segments - Timed transcript segments.
 * @returns draft tasks.
 */
function extractTasks(segments) {
  const tasks = []
  for (const segment of segments) {
    const text = seenText(segment).trim()
    if (text === '' || !ACTION_VERBS.test(text)) continue
    let owner = ''
    for (const pattern of OWNER_PATTERNS) {
      const match = text.match(pattern)
      const candidate = match?.[1]?.trim() ?? ''
      if (candidate !== '' && candidate.length <= 4 && !/^(你|我|我们|大家|他|她|他们|一下|这个|那个|这边|那边|谁来|谁去|哪位|哪个|怎么|如何|什么|为什么|是否)$/u.test(candidate)) {
        owner = candidate
        break
      }
    }
    const due = DUE_PATTERNS.test(text) ? (text.match(DUE_PATTERNS)?.[1] ?? '') : ''
    const priority = HIGH_PRIORITY.test(text) ? 'high' : LOW_PRIORITY.test(text) ? 'low' : 'normal'
    tasks.push({ id: `t${tasks.length + 1}`, title: text, owner, due, priority, source: text, status: 'draft', origin: 'rule' })
  }
  return tasks
}

/**
 * Pull draft key points with rule markers only. Sentences with no marker stay out: a
 * wrong point is worse than an omitted one, and a logged-in agent can add the rest.
 * @param segments - Timed transcript segments.
 * @returns draft points.
 */
function extractPoints(segments) {
  const points = []
  for (const segment of segments) {
    const text = seenText(segment).trim()
    if (text === '') continue
    let kind = ''
    if (DECISION_MARKERS.test(text)) kind = 'decision'
    else if (RISK_MARKERS.test(text)) kind = 'risk'
    else if (QUESTION_MARKERS.test(text)) kind = 'question'
    if (kind === '') continue
    points.push({ id: `p${points.length + 1}`, kind, text, quote: text, status: 'draft', origin: 'rule' })
  }
  return points
}

/**
 * Re-derive the meeting's draft points and tasks locally, merging into what is already
 * stored: an item the user already confirmed or edited keeps its state, so re-extracting
 * never discards human work. The agent (`meeting_write`) can add the rest when a model is
 * available; until then this works with no login.
 * @param meeting - Meeting record.
 * @returns how many of each are stored now.
 */
function extractAnalysis(meeting) {
  const merge = (existing, found, keyOf) => {
    const merged = [...existing]
    for (const item of found) {
      const key = keyOf(item)
      const index = merged.findIndex((candidate) => keyOf(candidate) === key)
      if (index < 0) {
        merged.push(item)
        continue
      }
      // Keep what a human already set; refresh only the wording from the transcript.
      const kept = merged[index]
      merged[index] = {
        ...item,
        status: kept.status,
        owner: kept.owner ?? item.owner,
        due: kept.due ?? item.due,
        priority: kept.priority ?? item.priority,
      }
    }
    return merged
  }
  // Ids are reassigned after the merge so every entry stays uniquely addressable by the
  // confirmation calls, without ids from two extraction runs colliding.
  meeting.points = merge(meeting.points, extractPoints(meeting.segments), (item) => item.text)
    .map((item, index) => ({ ...item, id: `p${index + 1}` }))
  meeting.tasks = merge(meeting.tasks, extractTasks(meeting.segments), (item) => item.title)
    .map((item, index) => ({ ...item, id: `t${index + 1}` }))
  return { points: meeting.points.length, tasks: meeting.tasks.length }
}

/**
 * Transcribe one PCM cue and append the resulting segment.
 * @param ctx - Host context.
 * @param meeting - Meeting record.
 * @param pcm - Raw PCM16 bytes for this cue.
 * @param collectedSeconds - Meeting offset where this cue started, in seconds.
 * @returns the recognized text.
 */
async function appendChunk(ctx, meeting, pcm, collectedSeconds) {
  const audio = wavFromPcm(pcm, SAMPLE_RATE)
  const spec = ctx.speechToText.resolve({ audio })
  const result = await ctx.speechToText.transcribe(spec, meeting.controller.signal)
  const text = result.text.trim()
  const end = collectedSeconds + pcm.length / 2 / SAMPLE_RATE
  if (text !== '') {
    const revised = await correctText(ctx, text, meeting.terms)
    // The raw recognition records what was heard; a correction is stored beside it and never
    // replaces it, so the original stays auditable.
    const segment = { id: `${meeting.segments.length + 1}`, start: collectedSeconds, end, text }
    if (revised !== text) segment.revised = revised
    meeting.segments.push(segment)
  }
  meeting.seconds = end
  return text
}

/** Roles a person may review a meeting as. */
const ROLES = ['host', 'attendee', 'observer']

/**
 * Pinyin of one string, loaded on demand. The speech seam exposes no hotword biasing
 * (`TranscriptionRequest` carries only audio, provider and language), so terminology is
 * applied here as post-processing; without this helper only literal replacement runs.
 */
let pinyinSyllables = null
let pinyinAttempted = false

/**
 * Load the pinyin helper from the profile directory, where a plugin cannot resolve it by
 * name, and remember its absence instead of retrying on every cue.
 * @param ctx - Host context.
 * @returns the syllable splitter, or null when the package is not installed.
 */
async function loadPinyin(ctx) {
  if (pinyinAttempted) return pinyinSyllables
  pinyinAttempted = true
  // An installed copy resolves the library normally; a linked checkout has no install of its
  // own, so the profile copy is tried as well.
  const candidates = []
  try {
    candidates.push(createRequire(import.meta.url).resolve('pinyin-pro'))
  } catch {
    // Not installed beside this plugin; the profile path below may still hold it.
  }
  const profileDir = ctx.get('profileContext')?.dir
  if (typeof profileDir === 'string' && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'pinyin-pro', 'dist', 'index.mjs'))
  }
  for (const entry of candidates) {
    try {
      const module = await import(pathToFileURL(entry).href)
      const convert = typeof module.pinyin === 'function' ? module.pinyin : module.default?.pinyin
      if (typeof convert === 'function') {
        pinyinSyllables = (text) => convert(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
        return pinyinSyllables
      }
    } catch {
      // Try the next candidate before giving up on the helper.
    }
  }
  ctx.logger.warn('meeting-room: pinyin helper unavailable; terms use literal replacement only')
  return pinyinSyllables
}

/**
 * Split the terminology list into literal replacements and words matched by sound.
 * @param terms - One entry per line; `wrong=right` is literal, a bare word is a hotword, and
 *   a leading `*` allows a single-syllable word to match, which is off by default because one
 *   syllable matches far too many characters to do safely.
 * @returns the two rule lists.
 */
function parseTerms(terms) {
  const literal = []
  const hotwords = []
  for (const raw of terms.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator === -1) {
      const single = line.startsWith('*')
      const word = single ? line.slice(1).trim() : line
      if (word !== '') hotwords.push({ word, allowSingle: single })
      continue
    }
    const wrong = line.slice(0, separator).trim()
    const right = line.slice(separator + 1).trim()
    if (wrong !== '' && right !== '') literal.push({ wrong, right })
  }
  return { literal, hotwords }
}

/**
 * Apply the meeting's terminology to one recognized cue: literal replacements first, then
 * same-sound replacements for the hotwords, which is what fixes misheard names and terms.
 * @param ctx - Host context.
 * @param text - Raw recognized text.
 * @param terms - The meeting's terminology list.
 * @returns the corrected text, identical to the input when nothing matched.
 */
async function correctText(ctx, text, terms) {
  if (terms === '') return text
  const { literal, hotwords } = parseTerms(terms)
  let corrected = text
  for (const rule of literal) corrected = corrected.split(rule.wrong).join(rule.right)
  if (hotwords.length === 0) return corrected
  const syllablesOf = await loadPinyin(ctx)
  if (syllablesOf === null) return corrected
  for (const { word, allowSingle } of hotwords) {
    const target = syllablesOf(word)
    if (target.length === 0) continue
    // One syllable needs the explicit `*` opt-in: without it a short word would rewrite every
    // same-sounding character in the transcript.
    if (target.length < 2 && !allowSingle) continue
    const length = word.length
    for (let index = 0; index + length <= corrected.length; index++) {
      const window = corrected.slice(index, index + length)
      if (window === word) continue
      const heard = syllablesOf(window)
      if (heard.length !== target.length) continue
      if (heard.every((syllable, position) => syllable === target[position])) {
        corrected = `${corrected.slice(0, index)}${word}${corrected.slice(index + length)}`
        index += length - 1
      }
    }
  }
  return corrected
}

/** The text a reader sees for one cue: the correction when there is one. */
const seenText = (segment) => (typeof segment.revised === 'string' ? segment.revised : segment.text)


/** How each role is written in a document. */
const ROLE_LABELS = { host: '主持人', attendee: '参会人', observer: '旁听' }

/**
 * Render a meeting as a minutes document: decisions, points, assignments, notes and the
 * transcript, in the order a reader wants them.
 * @param meeting - Meeting record.
 * @returns the markdown document.
 */
function minutesText(meeting) {
  const terms = meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const lines = [
    '# 会议纪要',
    '',
    `- 会议编号：${meeting.id}`,
    `- 开始时间：${new Date(meeting.startedAt).toLocaleString()}`,
    `- 时长：${clockOf(meeting.seconds)}`,
    `- 段落数：${meeting.segments.length}`,
    `- 我的角色：${ROLE_LABELS[meeting.role] ?? '（未选择）'}`,
    `- 录音文件：${meeting.audioName === undefined ? '（无）' : meeting.audioName}`,
    `- 术语表：${terms.length === 0 ? '（未提供）' : terms.join('、')}`,
    '',
  ]
  const section = (title, entries, render) => {
    if (entries.length === 0) return
    lines.push(`## ${title}`, '')
    for (const entry of entries) lines.push(render(entry))
    lines.push('')
  }
  section('一、决议', meeting.points.filter((point) => point.kind === 'decision'), (point) => `- ${point.text}`)
  section('二、要点', meeting.points.filter((point) => point.kind === 'point'), (point) => `- ${point.text}`)
  section('三、风险与待确认', meeting.points.filter((point) => point.kind === 'risk' || point.kind === 'question'), (point) => `- [${point.kind === 'risk' ? '风险' : '待确认'}] ${point.text}`)
  if (meeting.tasks.length > 0) {
    lines.push('## 四、工作安排', '', '| 事项 | 负责人 | 时间 | 优先级 | 状态 |', '| --- | --- | --- | --- | --- |')
    for (const task of meeting.tasks) {
      lines.push(`| ${task.title.replace(/\|/gu, '\\|')} | ${task.owner === '' ? '未定' : task.owner} | ${task.due === '' ? '未定' : task.due} | ${task.priority} | ${task.status === 'confirmed' ? '已确认' : '待确认'} |`)
    }
    lines.push('')
  }
  const written = meeting.notes.filter((note) => typeof note.text === 'string' && note.text !== '')
  if (written.length > 0) {
    lines.push('## 五、手写笔记', '')
    for (const note of written) lines.push(`- ${note.text.replace(/\n/gu, '　')}`)
    lines.push('')
  }
  if (meeting.segments.length > 0) {
    lines.push('## 六、会议实录', '')
    for (const segment of meeting.segments) {
      const speaker = displaySpeaker(meeting, segment.speaker)
      lines.push(`- [${clockOf(segment.start)}]${speaker === '' ? '' : ` ${speaker}`} ${seenText(segment)}`)
    }
    lines.push('')
  }
  lines.push('> 实录由本机语音识别生成，可能含错字；原文永远保留，作为订正的依据。', '')
  if (meeting.revisions.length > 0) {
    lines.push('## 七、订正对照', '')
    for (const change of meeting.revisions) lines.push(`- [${clockOf(meeting.segments.find((segment) => segment.id === change.id)?.start ?? 0)}] ${change.from} → ${change.to}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** How close two cue embeddings must be to count as one voice in the end-of-meeting pass. */
const SPEAKER_MERGE_THRESHOLD = 0.62

/** Robot webhooks a meeting's confirmed assignments can be pushed to. */
const WEBHOOK_KINDS = ['dingtalk', 'wecom']

/** How confirmed assignments reach people: the group robot, private notices, or both. */
const PUSH_MODES = ['group', 'work', 'both']

/** Documents the agent may store beside a meeting. */
const DOCUMENT_KINDS = ['review', 'summary', 'note']

/**
 * Where the robot webhook addresses are kept: user configuration, not plugin code, so it
 * survives restarts without editing the profile composition.
 * @returns the absolute file path.
 */
function webhookFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'webhooks.json')
}

/**
 * Read the push settings: group robot webhooks, the DingTalk internal application used for
 * private work notifications and contact sync, the shared people roster, and which delivery
 * the user chose.
 * @returns one value per setting, empty when unset.
 */
async function readSettings() {
  const empty = { dingtalk: '', wecom: '', appKey: '', appSecret: '', agentId: '', mode: 'group', people: [], departments: [] }
  try {
    const parsed = JSON.parse(await readFile(webhookFile(), 'utf8'))
    for (const kind of WEBHOOK_KINDS) {
      if (typeof parsed[kind] === 'string') empty[kind] = parsed[kind]
    }
    for (const key of ['appKey', 'appSecret', 'agentId']) {
      if (typeof parsed[key] === 'string') empty[key] = parsed[key]
    }
    if (PUSH_MODES.includes(parsed.mode)) empty.mode = parsed.mode
    // The roster is shared by every meeting: it describes the organisation, not one record.
    if (Array.isArray(parsed.people)) {
      empty.people = parsed.people
        .filter((person) => person !== null && typeof person === 'object' && typeof person.name === 'string' && person.name !== '')
        .map((person) => ({
          name: person.name,
          phone: typeof person.phone === 'string' ? person.phone : '',
          userId: typeof person.userId === 'string' ? person.userId : '',
        }))
    }
    if (Array.isArray(parsed.departments)) empty.departments = parsed.departments
  } catch {
    // Absent or unreadable: nothing is configured yet, which is not an error.
  }
  return empty
}

/**
 * Write the push settings back, keeping every unrelated field intact.
 * @param next - The settings to store.
 * @returns after the file is written.
 */
async function writeSettings(next) {
  const directory = dirname(webhookFile())
  await mkdir(directory, { recursive: true })
  await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
}

/**
 * Find the roster entry describing one person by name.
 * @param people - The shared roster.
 * @param name - Owner name written on a task.
 * @returns the entry, or null when the name is unknown or blank.
 */
function personOf(people, name) {
  const trimmed = name.trim()
  if (trimmed === '') return null
  return (people ?? []).find((person) => person.name === trimmed) ?? null
}

/**
 * Group confirmed assignments by owner, so each person is told only about their own work.
 * @param tasks - Confirmed tasks.
 * @returns one entry per owner, with '' for tasks nobody owns yet.
 */
function groupByOwner(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    const owner = task.owner.trim()
    const list = groups.get(owner) ?? []
    list.push(task)
    groups.set(owner, list)
  }
  return groups
}

/**
 * Render one owner's assignments as the markdown a group robot accepts.
 * @param meeting - Meeting record.
 * @param owner - Owner name, or '' for unassigned work.
 * @param tasks - That owner's confirmed tasks.
 * @returns the message body.
 */
function ownerMarkdown(meeting, owner, tasks) {
  const who = owner === '' ? '待认领' : owner
  const lines = [
    `### 会议工作安排 · ${who}`,
    '',
    `- 会议编号：${meeting.id}`,
    `- 时间：${new Date(meeting.startedAt).toLocaleString()}`,
    '',
  ]
  for (const task of tasks) {
    const due = task.due === '' ? '未定' : task.due
    lines.push(`- **${task.title}**　时间：${due}　优先级：${task.priority}`)
  }
  lines.push('', '> 由 DeepSeek Harness 会议记录发出；只推送已人工确认的事项。')
  return lines.join('\n')
}

/**
 * Send one payload to a group robot and report what it answered.
 * @param url - Robot webhook address.
 * @param payload - JSON body to post.
 * @returns the outcome for this robot.
 */
async function postRobot(url, payload) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const reply = await response.json().catch(() => ({}))
    const code = typeof reply.errcode === 'number' ? reply.errcode : response.ok ? 0 : -1
    return { ok: response.ok && code === 0, message: typeof reply.errmsg === 'string' ? reply.errmsg : `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send every confirmed assignment to the group robots, one message per owner, mentioning the
 * owner's mobile number when the meeting's roster knows it.
 * @param meeting - Meeting record.
 * @param kinds - Robot kinds to send to.
 * @param settings - Push settings.
 * @returns one result per robot.
 */
async function pushToGroups(meeting, kinds, settings) {
  const confirmed = meeting.tasks.filter((task) => task.status === 'confirmed')
  const groups = groupByOwner(confirmed)
  const results = []
  for (const kind of kinds) {
    const url = settings[kind] ?? ''
    if (url === '') {
      results.push({ target: kind, ok: false, message: '未配置该机器人的 Webhook 地址' })
      continue
    }
    let sent = 0
    let failed = ''
    for (const [owner, tasks] of groups) {
      const text = ownerMarkdown(meeting, owner, tasks)
      const person = personOf(settings.people, owner)
      const phone = person !== null && typeof person.phone === 'string' ? person.phone : ''
      const payload = kind === 'dingtalk'
        ? {
          msgtype: 'markdown',
          markdown: { title: '会议工作安排', text: phone === '' ? text : `${text}\n\n@${phone}` },
          ...phone === '' ? {} : { at: { atMobiles: [phone], isAtAll: false } },
        }
        : {
          msgtype: 'markdown',
          markdown: { content: text },
          // WeCom mentions by mobile through this list rather than inside the text.
          ...phone === '' ? {} : { mentioned_mobile_list: [phone] },
        }
      const outcome = await postRobot(url, payload)
      if (outcome.ok) sent += 1
      else failed = outcome.message
    }
    results.push({
      target: `${kind}（按负责人 ${groups.size} 条）`,
      ok: failed === '',
      message: failed === '' ? `已发送 ${sent} 条` : failed,
    })
  }
  return results
}

/**
 * Fetch the internal application's access token.
 * @param settings - Push settings carrying appKey and appSecret.
 * @returns the token, or an error message.
 */
async function dingtalkToken(settings) {
  if (settings.appKey === '' || settings.appSecret === '') return { token: '', error: '未配置钉钉企业内部应用的 AppKey / AppSecret' }
  try {
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(settings.appKey)}&appsecret=${encodeURIComponent(settings.appSecret)}`
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const reply = await response.json().catch(() => ({}))
    if (typeof reply.access_token !== 'string' || reply.access_token === '') {
      return { token: '', error: typeof reply.errmsg === 'string' ? reply.errmsg : `HTTP ${response.status}` }
    }
    return { token: reply.access_token, error: '' }
  } catch (error) {
    return { token: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send each owner their own assignments as a private work notification. This is the only path
 * that reaches one person rather than a group, and it needs an internal application whose
 * agent id the meeting's roster can address by userid.
 * @param meeting - Meeting record.
 * @param settings - Push settings.
 * @returns one result per person approached.
 */
async function pushToPeople(meeting, settings) {
  if (settings.agentId === '') return [{ target: '工作通知', ok: false, message: '未配置 AgentId' }]
  const { token, error } = await dingtalkToken(settings)
  if (token === '') return [{ target: '工作通知', ok: false, message: error }]
  const groups = groupByOwner(meeting.tasks.filter((task) => task.status === 'confirmed'))
  const results = []
  for (const [owner, tasks] of groups) {
    const person = personOf(settings.people, owner)
    const userId = person !== null && typeof person.userId === 'string' ? person.userId : ''
    if (owner === '' || userId === '') {
      results.push({ target: `工作通知 · ${owner === '' ? '待认领' : owner}`, ok: false, message: '该负责人没有钉钉 UserId，无法私发' })
      continue
    }
    const outcome = await postRobot(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(token)}`, {
      agent_id: settings.agentId,
      userid_list: userId,
      msg: { msgtype: 'markdown', markdown: { title: '会议工作安排', text: ownerMarkdown(meeting, owner, tasks) } },
    })
    results.push({ target: `工作通知 · ${owner}`, ok: outcome.ok, message: outcome.message })
  }
  return results
}

/**
 * Push the confirmed assignments to the configured group robots.
 * @param meeting - Meeting record.
 * @param kinds - Robot kinds to send to.
 * @returns one result per robot.
 */
async function pushTasks(meeting, kinds) {
  const settings = await readSettings()
  const confirmed = meeting.tasks.filter((task) => task.status === 'confirmed').length
  if (confirmed === 0) return { sent: [], results: [], error: '没有已确认的任务可推送：请先在「工作安排」里确认' }
  const results = []
  if (settings.mode === 'group' || settings.mode === 'both') results.push(...await pushToGroups(meeting, kinds, settings))
  if (settings.mode === 'work' || settings.mode === 'both') results.push(...await pushToPeople(meeting, settings))
  return { sent: kinds, results, error: '', mode: settings.mode }
}

/**
 * Call one DingTalk topapi endpoint with the access token in the query string.
 * @param path - Endpoint path such as topapi/v2/user/list.
 * @param token - Access token.
 * @param body - JSON body.
 * @returns the decoded reply.
 */
async function dingtalkPost(path, token, body) {
  const response = await fetch(`https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return await response.json().catch(() => ({}))
}

/** How many departments and people a single sync may pull, so a large org cannot hang it. */
const DIRECTORY_DEPARTMENT_LIMIT = 400
const DIRECTORY_PERSON_LIMIT = 5000

/**
 * Walk the DingTalk department tree from the root.
 * @param token - Access token.
 * @returns every department from the root down, or an error message.
 */
async function dingtalkDepartments(token) {
  const departments = []
  const queue = [1]
  const seen = new Set()
  while (queue.length > 0 && departments.length < DIRECTORY_DEPARTMENT_LIMIT) {
    const deptId = queue.shift()
    if (seen.has(deptId)) continue
    seen.add(deptId)
    const detail = await dingtalkPost('topapi/v2/department/get', token, { dept_id: deptId })
    const name = detail?.result?.name ?? (deptId === 1 ? '全公司' : `科室 ${deptId}`)
    departments.push({ id: deptId, name, parentId: typeof detail?.result?.parent_id === 'number' ? detail.result.parent_id : 0 })
    const children = await dingtalkPost('topapi/v2/department/listsub', token, { dept_id: deptId })
    if (children?.errcode !== 0 && children?.errcode !== undefined) {
      return { departments: [], error: typeof children.errmsg === 'string' ? children.errmsg : '读取子部门失败' }
    }
    for (const child of children?.result ?? []) {
      if (typeof child?.dept_id === 'number') queue.push(child.dept_id)
    }
  }
  return { departments, error: '' }
}

/**
 * Read every person in the given departments, following DingTalk's cursor paging.
 * @param token - Access token.
 * @param departmentIds - Departments to read; one entry means one department.
 * @returns the people found, deduplicated by user id, or an error message.
 */
async function dingtalkPeople(token, departmentIds) {
  const people = []
  const seen = new Set()
  for (const deptId of departmentIds) {
    let cursor = 0
    for (let page = 0; page < 50 && people.length < DIRECTORY_PERSON_LIMIT; page++) {
      const reply = await dingtalkPost('topapi/v2/user/list', token, { dept_id: deptId, cursor, size: 100 })
      if (reply?.errcode !== 0) return { people: [], error: typeof reply?.errmsg === 'string' ? reply.errmsg : '读取人员失败' }
      for (const user of reply?.result?.list ?? []) {
        const userId = typeof user?.userid === 'string' ? user.userid : ''
        if (userId === '' || seen.has(userId)) continue
        seen.add(userId)
        people.push({
          name: typeof user?.name === 'string' ? user.name : '',
          // The mobile only comes back when the application holds the field permission.
          phone: typeof user?.mobile === 'string' ? user.mobile : '',
          userId,
        })
      }
      if (reply?.result?.has_more !== true) break
      cursor = typeof reply?.result?.next_cursor === 'number' ? reply.result.next_cursor : cursor + 100
    }
  }
  return { people: people.filter((person) => person.name !== ''), error: '' }
}

/**
 * Cosine similarity of two equally long vectors.
 * @param left - First vector.
 * @param right - Second vector.
 * @returns the similarity, or 0 when either vector has no length.
 */
function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const scale = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return scale === 0 ? 0 : dot / scale
}

/**
 * Merge every cue of one voice under a single label. The online gallery only ever adds
 * entries, so one voice can hold two labels and a noisy cue can hold one forever; this pass
 * clusters the stored embeddings instead and numbers the voices by first appearance.
 * @param meeting - Meeting record.
 * @returns the number of voices after merging.
 */
function relabelSpeakers(meeting) {
  const cues = meeting.segments.filter((segment) => typeof segment.embedding === 'string' && segment.embedding !== '')
  if (cues.length < 2) return 0
  const vectors = cues.map((cue) => {
    const bytes = Buffer.from(cue.embedding, 'base64')
    // Node pools small buffers, so the embedding starts at an offset inside a shared
    // ArrayBuffer; slicing copies exactly this vector out for the float view.
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  })
  // Single-linkage clustering: every pair closer than the threshold joins one voice.
  const parent = cues.map((_, index) => index)
  const rootOf = (index) => {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  for (let left = 0; left < cues.length; left++) {
    for (let right = left + 1; right < cues.length; right++) {
      if (cosine(vectors[left], vectors[right]) < SPEAKER_MERGE_THRESHOLD) continue
      const leftRoot = rootOf(left)
      const rightRoot = rootOf(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
  }
  const names = new Map()
  // Names already assigned must follow the voice, not the old number: the rename below can
  // change which label a voice holds, so each new group inherits the label it mostly held.
  const tally = new Map()
  for (let index = 0; index < cues.length; index++) {
    const root = rootOf(index)
    const counts = tally.get(root) ?? new Map()
    const previous = cues[index].speaker
    counts.set(previous, (counts.get(previous) ?? 0) + 1)
    tally.set(root, counts)
  }
  const inherited = new Map()
  for (const [root, counts] of tally) {
    let best = ''
    let bestCount = -1
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        best = label
      }
    }
    if (best !== '') inherited.set(root, best)
  }
  for (let index = 0; index < cues.length; index++) {
    const root = rootOf(index)
    if (!names.has(root)) names.set(root, `S${names.size + 1}`)
    cues[index].speaker = names.get(root)
  }
  const renamed = {}
  for (const [root, label] of inherited) {
    const name = meeting.speakers[label]
    if (typeof name === 'string' && name !== '') renamed[names.get(root)] = name
  }
  meeting.speakers = renamed
  return names.size
}

/** The transcript as the panel reads it: every field except the speaker embeddings. */
function publicSegments(meeting) {
  return meeting.segments.map(({ embedding, speaker, ...rest }) => ({
    ...rest,
    // The label stays the identity a voice is re-clustered by; the name is what a person
    // reads, and it falls back to the label until someone assigns one.
    speaker: displaySpeaker(meeting, speaker),
  }))
}

/**
 * The name a person sees for one voice label.
 * @param meeting - Meeting record.
 * @param label - Voice label such as S1, or an empty string.
 * @returns the assigned name, else the label.
 */
function displaySpeaker(meeting, label) {
  const name = meeting.speakers?.[label]
  return typeof name === 'string' && name !== '' ? name : label
}

/**
 * The voice labels that appear in this meeting, in first-spoken order.
 * @param meeting - Meeting record.
 * @returns the labels.
 */
function speakerLabels(meeting) {
  const labels = []
  for (const segment of meeting.segments) {
    if (typeof segment.speaker === 'string' && segment.speaker !== '' && !labels.includes(segment.speaker)) {
      labels.push(segment.speaker)
    }
  }
  return labels
}

/**
 * Render a meeting as the plain text a model reads.
 * @param meeting - Meeting record.
 * @param limit - Maximum cues to include, keeping the most recent.
 * @returns the transcript text.
 */
function transcriptText(meeting, limit) {
  const all = meeting.segments
  const kept = all.length > limit ? all.slice(all.length - limit) : all
  const header = [
    '会议实录（本地语音识别，可能含错字；如需订正请对照术语表）',
    `会议：${meeting.id}`,
    `会话：${meeting.sessionId === '' ? '（未知）' : meeting.sessionId}`,
    `开始：${new Date(meeting.startedAt).toLocaleString()}`,
    `时长：${clockOf(meeting.seconds)}　段落：${all.length}`,
    `录音：${meeting.audioName === undefined ? '（无）' : meeting.audioName}`,
    `术语表：${meeting.terms === '' ? '（未提供）' : meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('、')}`,
    '',
  ]
  const body = kept.map((segment) => {
    const speaker = displaySpeaker(meeting, segment.speaker)
    // The cue id is what meeting_revise corrects, so the reading view carries it.
    return `[${clockOf(segment.start)}] #${segment.id}${speaker === '' ? '' : ` ${speaker}`} ${seenText(segment)}`
  })
  const omitted = all.length - kept.length
  if (omitted > 0) body.unshift(`（较早的 ${omitted} 段已省略，可用 meetingId 与更大的 limit 重新读取）`)
  // Echo what is already recorded, so a second pass refines instead of duplicating.
  const recorded = []
  if (meeting.points.length > 0) {
    recorded.push('', '已记录的要点：')
    for (const point of meeting.points) recorded.push(`- [${point.kind}] ${point.text}`)
  }
  if (meeting.tasks.length > 0) {
    recorded.push('', '已记录的工作安排：')
    for (const task of meeting.tasks) {
      const owner = task.owner === '' ? '（未定负责人）' : task.owner
      const due = task.due === '' ? '（未定时间）' : task.due
      recorded.push(`- ${task.title}（${owner} / ${due} / ${task.priority} / ${task.status}）`)
    }
  }
  // Handwritten notes are meeting content too: a review of a meeting that was only written
  // down would otherwise read as empty.
  const written = (meeting.notes ?? []).filter((note) => typeof note.text === 'string' && note.text !== '')
  if (written.length > 0) {
    recorded.push('', '手写笔记：')
    for (const note of written) recorded.push(`- ${note.text.replace(/\n/gu, '　')}`)
  }
  const stored = meeting.documents ?? []
  if (stored.length > 0) {
    recorded.push('', '会议文档：')
    for (const document of stored) recorded.push(`- ${document.title}（${document.name}）`)
  }
  return [...header, ...body, ...recorded, ''].join('\n')
}

/**
 * Activate the host half: register the meeting routes and the transcript tool.
 * @param ctx - Host context owned by this plugin's fiber.
 */
export function apply(ctx) {
  /**
   * Serve one meeting-room request.
   * @param req - Incoming request.
   * @param res - Response owned by this route.
   */
  async function handler(req, res) {
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'untrusted origin' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(PREFIX.length)
      const method = req.method ?? 'GET'

      if (method === 'POST' && route === '/start') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const startedAt = Date.now()
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        const audioName = `${stampOf(startedAt)}.wav`
        const audioPath = join(directory, audioName)
        // The header is rewritten with the final payload size when the meeting stops, so
        // the file stays playable both during and after the recording.
        const audioHandle = await open(audioPath, 'w')
        await audioHandle.write(wavHeader(0, SAMPLE_RATE))
        // A meeting created by `/ensure` to hold notes has no audio yet; the recording joins
        // it instead of orphaning those notes in a second record for the same session.
        const pending = sessionId === '' ? undefined : [...meetings.values()].find(
          (meeting) => meeting.sessionId === sessionId && meeting.audioName === undefined,
        )
        if (pending !== undefined) {
          pending.startedAt = startedAt
          if (typeof body.terms === 'string') pending.terms = body.terms
          pending.controller = new AbortController()
          pending.audioName = audioName
          pending.audioPath = audioPath
          pending.audioHandle = audioHandle
          pending.audioBytes = 0
          sendJson(res, 200, { meetingId: pending.id, sampleRate: SAMPLE_RATE, startedAt, audioName })
          return
        }
        const id = `meeting-${Date.now().toString(36)}`
        meetings.set(id, {
          id,
          startedAt,
          seconds: 0,
          segments: [],
          points: [],
          tasks: [],
          notes: [],
          revisions: [],
          speakers: {},
          people: [],
          documents: [],
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
          terms: typeof body.terms === 'string' ? body.terms : '',
          role: '',
          controller: new AbortController(),
          audioName,
          audioPath,
          audioHandle,
          audioBytes: 0,
        })
        sendJson(res, 200, { meetingId: id, sampleRate: SAMPLE_RATE, startedAt, audioName })
        return
      }

      if (method === 'POST' && route === '/ensure') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          sendJson(res, 400, { error: 'a meeting needs a session' })
          return
        }
        const existing = findMeeting(sessionId, '')
        if (existing !== undefined) {
          sendJson(res, 200, { meetingId: existing.id, created: false })
          return
        }
        // Notes and tasks belong to a meeting even when nothing was recorded, so the first
        // write creates the container; a later recording joins it.
        const id = `meeting-${Date.now().toString(36)}`
        meetings.set(id, {
          id,
          startedAt: Date.now(),
          seconds: 0,
          segments: [],
          points: [],
          tasks: [],
          notes: [],
          revisions: [],
          speakers: {},
          people: [],
          documents: [],
          sessionId,
          terms: typeof body.terms === 'string' ? body.terms : '',
          role: '',
          controller: new AbortController(),
        })
        sendJson(res, 200, { meetingId: id, created: true })
        return
      }

      if (method === 'POST' && route === '/terms') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        meeting.terms = typeof body.terms === 'string' ? body.terms : ''
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'POST' && route === '/chunk') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.pcm !== 'string' || body.pcm === '') {
          sendJson(res, 400, { error: 'missing pcm' })
          return
        }
        const pcm = Buffer.from(body.pcm, 'base64')
        // Persist the audio before recognition, so a transcription failure never costs
        // the recording itself.
        if (meeting.audioHandle !== undefined) {
          await meeting.audioHandle.write(pcm)
          meeting.audioBytes += pcm.length
        }
        const before = meeting.segments.length
        const text = await appendChunk(ctx, meeting, pcm, meeting.seconds)
        // Label the cue that was just appended. One cue can span a speaker change; that
        // case keeps the dominant voice and is a documented limitation.
        if (meeting.segments.length > before) {
          const judged = await labelCue(ctx, pcm)
          if (judged.speaker !== '') meeting.segments[before].speaker = judged.speaker
          // The embedding is kept for the end-of-meeting pass, which merges voices the online
          // gallery could not; it never leaves this process.
          if (judged.embedding !== '') meeting.segments[before].embedding = judged.embedding
        }
        sendJson(res, 200, {
          text,
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      if (method === 'GET' && route === '/state') {
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, {
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          role: meeting.role,
          speakers: meeting.speakers,
          people: meeting.people ?? [],
          documents: meeting.documents ?? [],
          labels: speakerLabels(meeting),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      if (method === 'POST' && route === '/speaker/name') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const label = typeof body.label === 'string' ? body.label.trim() : ''
        if (label === '' || !speakerLabels(meeting).includes(label)) {
          sendJson(res, 400, { error: 'unknown speaker' })
          return
        }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        // An empty name clears the assignment and the label shows again.
        if (name === '') delete meeting.speakers[label]
        else meeting.speakers[label] = name
        sendJson(res, 200, { speakers: meeting.speakers, segments: publicSegments(meeting) })
        return
      }

      if (method === 'GET' && route === '/webhooks') {
        const settings = await readSettings()
        // The panel only needs to know whether each value is set, and to show an address tail.
        sendJson(res, 200, {
          dingtalk: settings.dingtalk === '' ? '' : settings.dingtalk.slice(-8),
          wecom: settings.wecom === '' ? '' : settings.wecom.slice(-8),
          appKey: settings.appKey === '' ? '' : `${settings.appKey.slice(0, 4)}…`,
          agentId: settings.agentId,
          hasSecret: settings.appSecret !== '',
          mode: settings.mode,
          configured: WEBHOOK_KINDS.filter((kind) => settings[kind] !== ''),
        })
        return
      }

      if (method === 'POST' && route === '/webhooks') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const next = await readSettings()
        for (const kind of WEBHOOK_KINDS) {
          const value = body[kind]
          if (typeof value !== 'string') continue
          const trimmed = value.trim()
          // An empty string clears the address; anything else must be an https robot URL.
          if (trimmed !== '' && !/^https:\/\//u.test(trimmed)) {
            sendJson(res, 400, { error: `${kind} 的地址必须以 https:// 开头` })
            return
          }
          next[kind] = trimmed
        }
        for (const key of ['appKey', 'appSecret', 'agentId']) {
          const value = body[key]
          if (typeof value === 'string') next[key] = value.trim()
        }
        if (PUSH_MODES.includes(body.mode)) next.mode = body.mode
        const directory = dirname(webhookFile())
        await mkdir(directory, { recursive: true })
        await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
        sendJson(res, 200, { mode: next.mode, configured: WEBHOOK_KINDS.filter((kind) => next[kind] !== '') })
        return
      }

      if (method === 'POST' && route === '/people') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const settings = await readSettings()
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') {
          sendJson(res, 400, { error: '人员需要一个姓名' })
          return
        }
        const entry = settings.people.find((person) => person.name === name)
        if (entry === undefined) {
          if (body.remove === true) {
            sendJson(res, 404, { error: '名册里没有这个人' })
            return
          }
          settings.people.push({ name, phone: '', userId: '' })
          await writeSettings(settings)
          sendJson(res, 200, { people: settings.people })
          return
        }
        if (body.remove === true) {
          settings.people = settings.people.filter((person) => person.name !== name)
          await writeSettings(settings)
          sendJson(res, 200, { people: settings.people })
          return
        }
        // Only what the panel sent changes; an omitted field keeps the stored value.
        if (typeof body.phone === 'string') entry.phone = body.phone.trim()
        if (typeof body.userId === 'string') entry.userId = body.userId.trim()
        await writeSettings(settings)
        sendJson(res, 200, { people: settings.people })
        return
      }

      if (method === 'GET' && route === '/people') {
        const settings = await readSettings()
        sendJson(res, 200, { people: settings.people, departments: settings.departments })
        return
      }

      if (method === 'POST' && route === '/dingtalk/departments') {
        const settings = await readSettings()
        const { token, error } = await dingtalkToken(settings)
        if (token === '') {
          sendJson(res, 400, { error })
          return
        }
        const { departments, error: failure } = await dingtalkDepartments(token)
        if (failure !== '') {
          sendJson(res, 400, { error: failure })
          return
        }
        settings.departments = departments
        await writeSettings(settings)
        sendJson(res, 200, { departments })
        return
      }

      if (method === 'POST' && route === '/dingtalk/sync') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const settings = await readSettings()
        const { token, error } = await dingtalkToken(settings)
        if (token === '') {
          sendJson(res, 400, { error })
          return
        }
        // An empty or absent department id means the whole organisation: every department the
        // tree walk found, or a fresh walk when the tree was never read.
        let targets = []
        const asked = typeof body.deptId === 'number' ? body.deptId : 0
        if (asked === 0) {
          let departments = settings.departments
          if (!Array.isArray(departments) || departments.length === 0) {
            const walked = await dingtalkDepartments(token)
            if (walked.error !== '') {
              sendJson(res, 400, { error: walked.error })
              return
            }
            departments = walked.departments
          }
          targets = departments.map((department) => department.id)
        } else {
          targets = [asked]
        }
        if (targets.length === 0) {
          sendJson(res, 400, { error: '没有可同步的科室' })
          return
        }
        const { people, error: failure } = await dingtalkPeople(token, targets)
        if (failure !== '') {
          sendJson(res, 400, { error: failure })
          return
        }
        // Syncing merges: a name already on the roster keeps its row and gains the fields
        // DingTalk knows, so hand-edited entries are not thrown away.
        let added = 0
        for (const person of people) {
          const existing = settings.people.find((entry) => entry.name === person.name)
          if (existing === undefined) {
            settings.people.push(person)
            added += 1
            continue
          }
          if (existing.userId === '') existing.userId = person.userId
          if (existing.phone === '' && person.phone !== '') existing.phone = person.phone
        }
        await writeSettings(settings)
        sendJson(res, 200, { people: settings.people, added, total: people.length, departments: targets.length })
        return
      }

      if (method === 'POST' && route === '/push') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const asked = Array.isArray(body.kinds) ? body.kinds.filter((kind) => WEBHOOK_KINDS.includes(kind)) : WEBHOOK_KINDS
        const outcome = await pushTasks(meeting, asked.length === 0 ? WEBHOOK_KINDS : asked)
        sendJson(res, outcome.error === '' ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/role') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (!ROLES.includes(body.role)) {
          sendJson(res, 400, { error: 'unknown role' })
          return
        }
        meeting.role = body.role
        sendJson(res, 200, { role: meeting.role })
        return
      }

      if (method === 'GET' && route === '/transcript') {
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const limit = Number(url.searchParams.get('limit') ?? 4000)
        sendJson(res, 200, {
          text: transcriptText(meeting, Number.isFinite(limit) && limit > 0 ? limit : 4000),
        })
        return
      }

      if (method === 'POST' && route === '/minutes') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const content = minutesText(meeting)
        const stamp = stampOf(meeting.startedAt)
        if (body.format === 'docx') {
          // Word is for handing the minutes to someone; Markdown stays the machine-readable copy.
          const docxName = await writeDocx(ctx, meeting, `${stamp}-minutes.docx`)
          sendJson(res, 200, { name: docxName })
          return
        }
        const name = `${stamp}-minutes.md`
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, name), content, 'utf8')
        sendJson(res, 200, { name, size: Buffer.byteLength(content, 'utf8'), content })
        return
      }

      if (method === 'GET' && route === '/current') {
        // The panel loses its React state on reload, so it asks which meeting this
        // session owns rather than starting a second recording.
        const meeting = findMeeting(url.searchParams.get('sessionId') ?? '', '')
        if (meeting === undefined) {
          sendJson(res, 200, { meeting: null })
          return
        }
        sendJson(res, 200, {
          meeting: {
            meetingId: meeting.id,
            startedAt: meeting.startedAt,
            seconds: meeting.seconds,
            segments: publicSegments(meeting),
            audioName: meeting.audioName,
            points: meeting.points,
            tasks: meeting.tasks,
          notes: meeting.notes,
          },
        })
        return
      }

      if (method === 'POST' && route === '/extract') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const counts = extractAnalysis(meeting)
        sendJson(res, 200, { ...counts, points: meeting.points, tasks: meeting.tasks })
        return
      }

      if (method === 'POST' && route === '/analysis') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const list = body.kind === 'point' ? meeting.points : meeting.tasks
        if (body.op === 'add') {
          // A human turning a written note into an assignment; it still lands as a draft.
          const title = typeof body.text === 'string' ? body.text.trim() : ''
          if (title === '') {
            sendJson(res, 400, { error: 'a new task needs text' })
            return
          }
          meeting.tasks.push({
            id: `t${meeting.tasks.length + 1}`,
            title,
            owner: '',
            due: '',
            priority: 'normal',
            source: '',
            status: 'draft',
            origin: 'ink',
          })
          sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
          return
        }
        const index = list.findIndex((item) => item.id === body.id)
        if (index < 0) {
          sendJson(res, 404, { error: 'unknown entry' })
          return
        }
        if (body.op === 'remove') {
          list.splice(index, 1)
          sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
          return
        }
        const item = list[index]
        const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
        // Only a human may move an entry to confirmed; the extractors always write drafts.
        if (patch.status === 'draft' || patch.status === 'confirmed') item.status = patch.status
        if (body.kind === 'point') {
          if (typeof patch.text === 'string' && patch.text.trim() !== '') item.text = patch.text.trim()
          if (POINT_KINDS.includes(patch.kind)) item.kind = patch.kind
        } else {
          if (typeof patch.title === 'string' && patch.title.trim() !== '') item.title = patch.title.trim()
          if (typeof patch.owner === 'string') item.owner = patch.owner.trim()
          if (typeof patch.due === 'string') item.due = patch.due.trim()
          if (TASK_PRIORITIES.includes(patch.priority)) item.priority = patch.priority
        }
        sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
        return
      }

      if (method === 'POST' && route === '/stop') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        meeting.controller.abort(new Error('meeting stopped'))
        // Patch the WAV sizes and close the file so the recording is a complete, seekable file.
        if (meeting.audioHandle !== undefined) {
          try {
            await meeting.audioHandle.write(wavHeader(meeting.audioBytes, SAMPLE_RATE), 0, 44, 0)
          } finally {
            await meeting.audioHandle.close()
            meeting.audioHandle = undefined
          }
        }
        // The recording is finished, so the cues can be re-clustered as a whole: the online
        // gallery cannot split or merge what it has already labelled.
        const voices = relabelSpeakers(meeting)
        // The embeddings have done their job once the voices are settled, so a long meeting
        // does not keep every cue's vector in memory for the rest of the session.
        for (const segment of meeting.segments) delete segment.embedding
        void flushMeetings(ctx)
        sendJson(res, 200, {
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          startedAt: meeting.startedAt,
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          voices,
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      if (method === 'POST' && route === '/export') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const files = Array.isArray(body.files) ? body.files : []
        if (files.length === 0 || files.length > MAX_ARTIFACTS) {
          sendJson(res, 400, { error: `files must hold 1..${MAX_ARTIFACTS} entries` })
          return
        }
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        const paths = []
        for (const file of files) {
          const artifactName = typeof file.name === 'string' ? file.name : ''
          if (!isSafeArtifactName(artifactName)) throw new Error(`invalid file name: ${artifactName}`)
          const content = typeof file.content === 'string' ? file.content : ''
          if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error(`artifact too large: ${artifactName}`)
          const path = join(directory, artifactName)
          await writeFile(path, content, 'utf8')
          paths.push(path)
        }
        sendJson(res, 200, { paths })
        return
      }

      if (method === 'GET' && route === '/list') {
        const directory = exportDirectory()
        let names = []
        try {
          names = await readdir(directory)
        } catch {
          // No meetings directory yet: an empty list, not an error.
          sendJson(res, 200, { files: [] })
          return
        }
        const files = []
        for (const name of names) {
          if (!isSafeArtifactName(name)) continue
          try {
            const info = await stat(join(directory, name))
            if (!info.isFile()) continue
            // Meeting artifacts share the recording's `YYYY-MM-DD_HH-MM-SS` prefix, so a file
            // can be traced back to the session that produced it.
            const owner = [...meetings.values()].find((meeting) => stampOf(meeting.startedAt) === name.slice(0, 19))
            files.push({
              name,
              size: info.size,
              modified: info.mtimeMs,
              sessionId: owner === undefined ? '' : owner.sessionId,
              meetingId: owner === undefined ? '' : owner.id,
            })
          } catch {
            // A file that vanished between listing and stat is simply skipped.
          }
        }
        files.sort((left, right) => right.modified - left.modified)
        sendJson(res, 200, { files: files.slice(0, 200) })
        return
      }

      if (method === 'POST' && route === '/reveal') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const name = typeof body.name === 'string' ? body.name : ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const target = join(exportDirectory(), name)
        try {
          await stat(target)
        } catch {
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        // Each platform has one command that opens the file manager on a path; the explorer
        // switch selects the file itself rather than merely its folder.
        const opened = process.platform === 'win32'
          ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' })
          : process.platform === 'darwin'
            ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
            : spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' })
        opened.unref()
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && route === '/file') {
        const name = url.searchParams.get('name') ?? ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const path = join(exportDirectory(), name)
        try {
          const info = await stat(path)
          if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) {
            sendJson(res, 400, { error: 'file is missing or too large' })
            return
          }
          sendJson(res, 200, { name, size: info.size, modified: info.mtimeMs, content: await readFile(path, 'utf8') })
        } catch {
          sendJson(res, 404, { error: 'no such file' })
        }
        return
      }

      if (method === 'GET' && (route === '/audio' || route === '/raw')) {
        const name = url.searchParams.get('name') ?? ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const path = join(exportDirectory(), name)
        let info
        try {
          info = await stat(path)
        } catch {
          sendJson(res, 404, { error: 'no such recording' })
          return
        }
        if (!info.isFile()) {
          sendJson(res, 404, { error: 'no such recording' })
          return
        }
        const total = info.size
        const type = contentTypeOf(name)
        const range = req.headers.range
        // Range support is what lets the browser seek inside a recording.
        if (typeof range === 'string' && /^bytes=\d*-\d*$/u.test(range.trim())) {
          const [startText, endText] = range.trim().slice(6).split('-')
          const start = startText === '' ? Math.max(0, total - Number(endText)) : Number(startText)
          const end = startText === '' || endText === '' ? total - 1 : Math.min(Number(endText), total - 1)
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
          })
          createReadStream(path, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes' })
        createReadStream(path).pipe(res)
        return
      }

      if (method === 'POST' && route === '/note') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const name = typeof body.name === 'string' ? body.name : ''
        const noteText = typeof body.text === 'string' ? body.text.trim() : ''
        const png = typeof body.pngBase64 === 'string' ? body.pngBase64 : ''
        if (png === '' && noteText === '') {
          sendJson(res, 400, { error: 'a note needs pngBase64, text, or both' })
          return
        }
        // A drawing is written to disk; a text-only note (system handwriting panel, typed
        // correction) only joins the meeting record.
        let path = ''
        if (png !== '') {
          if (!isSafeArtifactName(name) || !name.endsWith('.png')) {
            sendJson(res, 400, { error: 'a note image needs a safe .png file name' })
            return
          }
          const bytes = Buffer.from(png, 'base64')
          if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
            sendJson(res, 400, { error: `a note must be 1..${MAX_ARTIFACT_BYTES} bytes` })
            return
          }
          const directory = exportDirectory()
          await mkdir(directory, { recursive: true })
          path = join(directory, name)
          await writeFile(path, bytes)
        }
        // The note is also a cue in the record, so the agent can read its text later.
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting !== undefined) {
          meeting.notes.push({
            id: `n${meeting.notes.length + 1}`,
            name,
            text: noteText,
            at: Date.now(),
            source: typeof body.source === 'string' ? body.source : 'ink',
            status: 'draft',
          })
        }
        sendJson(res, 200, { path, notes: meeting === undefined ? [] : meeting.notes })
        return
      }

      if (method === 'GET' && route === '/speaker') {
        sendJson(res, 200, {
          phase: speakerState.phase,
          message: speakerState.message,
          threshold: SPEAKER_THRESHOLD,
          model: SPEAKER_MODEL.name,
          bytes: SPEAKER_MODEL.bytes,
        })
        return
      }

      if (method === 'GET' && route === '/handwriting') {
        sendJson(res, 200, { phase: handwritingState.phase, message: handwritingState.message })
        return
      }

      if (method === 'POST' && route === '/handwriting') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        if (typeof body.pixelsBase64 !== 'string' || body.pixelsBase64 === '') {
          sendJson(res, 400, { error: 'missing pixelsBase64' })
          return
        }
        const text = await recognizeHandwriting(ctx, {
          chunks: typeof body.chunks === 'number' ? body.chunks : 3,
          pixelsBase64: body.pixelsBase64,
        })
        sendJson(res, 200, { text, phase: handwritingState.phase })
        return
      }

      if (method === 'POST' && route === '/speaker/prepare') {
        // The download is long enough that the caller polls /speaker instead of waiting.
        if (speakerState.phase !== 'downloading' && speakerState.phase !== 'ready') {
          void prepareSpeakers(ctx).catch(() => undefined)
        }
        sendJson(res, 200, { phase: speakerState.phase, message: speakerState.message })
        return
      }

      sendJson(res, 404, { error: `no such route: ${method} ${url.pathname}` })
    } catch (error) {
      ctx.logger.warn('meeting-room: request failed: %s', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    }
  }

  /**
   * Read the recorded transcript for the calling session.
   * @param args - Model arguments; validated here because a raw definition is not.
   * @param exec - Tool run context carrying the calling session.
   * @returns the transcript text.
   */
  async function readTranscript(args, exec) {
    const request = args !== null && typeof args === 'object' ? args : {}
    const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
    const rawLimit = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : DEFAULT_CUE_LIMIT
    const limit = Math.max(1, Math.min(MAX_CUE_LIMIT, rawLimit))
    const sessionId = exec?.agent?.session?.id
    const meeting = findMeeting(typeof sessionId === 'string' ? sessionId : '', meetingId)
    if (meeting === undefined) {
      const known = [...meetings.values()].map((entry) => entry.id)
      return known.length === 0
        ? 'No meeting has been recorded in this harness process yet.'
        : `No meeting matched this session. Known meetings in this process: ${known.join(', ')}.`
    }
    return transcriptText(meeting, limit)
  }

  /**
   * Store the agent's structured reading of the calling session's meeting.
   * @param args - Model arguments, validated here because a raw definition is not.
   * @param exec - Tool run context carrying the calling session.
   * @returns a short confirmation of what was stored.
   */
  async function writeAnalysis(args, exec) {
    const request = args !== null && typeof args === 'object' ? args : {}
    const sessionId = exec?.agent?.session?.id
    const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
    const meeting = findMeeting(typeof sessionId === 'string' ? sessionId : '', meetingId)
    if (meeting === undefined) return 'No meeting was found for this session; nothing was recorded.'
    if (request.mode === 'replace') {
      meeting.points = []
      meeting.tasks = []
    }
    let storedPoints = 0
    for (const item of Array.isArray(request.points) ? request.points : []) {
      const source = item !== null && typeof item === 'object' ? item : {}
      const text = typeof source.text === 'string' ? source.text.trim() : ''
      if (text === '' || meeting.points.some((existing) => existing.text === text)) continue
      meeting.points.push({
        id: `p${meeting.points.length + 1}`,
        kind: POINT_KINDS.includes(source.kind) ? source.kind : 'point',
        text,
        quote: typeof source.quote === 'string' ? source.quote.trim() : '',
        status: 'draft',
        origin: 'agent',
      })
      storedPoints += 1
    }
    let storedTasks = 0
    for (const item of Array.isArray(request.tasks) ? request.tasks : []) {
      const source = item !== null && typeof item === 'object' ? item : {}
      const title = typeof source.title === 'string' ? source.title.trim() : ''
      if (title === '' || meeting.tasks.some((existing) => existing.title === title)) continue
      meeting.tasks.push({
        id: `t${meeting.tasks.length + 1}`,
        title,
        owner: typeof source.owner === 'string' ? source.owner.trim() : '',
        due: typeof source.due === 'string' ? source.due.trim() : '',
        priority: TASK_PRIORITIES.includes(source.priority) ? source.priority : 'normal',
        source: typeof source.source === 'string' ? source.source.trim() : '',
        // A human confirms before anything is pushed anywhere.
        status: 'draft',
        origin: 'agent',
      })
      storedTasks += 1
    }
    return `Meeting ${meeting.id}: stored ${storedPoints} point(s) and ${storedTasks} task(s); it now holds ${meeting.points.length} point(s) and ${meeting.tasks.length} task(s). Tasks stay drafts until a human confirms them.`
  }

  /**
   * Apply context-aware corrections to a finished transcript. Every correction is stored
   * beside the recognition it replaces, and the pair is kept as a change entry, so the
   * original words remain auditable and a reader can see what was changed.
   * @param args - Model arguments, validated here because a raw definition is not.
   * @param exec - Tool run context carrying the calling session.
   * @returns a short confirmation with the applied changes.
   */
  async function reviseTranscript(args, exec) {
    const request = args !== null && typeof args === 'object' ? args : {}
    const sessionId = exec?.agent?.session?.id
    const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
    const meeting = findMeeting(typeof sessionId === 'string' ? sessionId : '', meetingId)
    if (meeting === undefined) return 'No meeting was found for this session; nothing was revised.'
    const corrections = Array.isArray(request.corrections) ? request.corrections : []
    const applied = []
    for (const entry of corrections) {
      if (entry === null || typeof entry !== 'object') continue
      const id = typeof entry.id === 'string' ? entry.id : ''
      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (id === '' || text === '') continue
      const segment = meeting.segments.find((candidate) => candidate.id === id)
      if (segment === undefined) continue
      const from = seenText(segment)
      if (from === text) continue
      segment.revised = text
      meeting.revisions.push({ id, at: Date.now(), from, to: text })
      applied.push({ id, from, to: text })
    }
    if (applied.length === 0) return `Meeting ${meeting.id}: no cue needed changing; the transcript is unchanged (${meeting.segments.length} cue(s)).`
    const listing = applied.map((change) => `- ${change.id}: ${change.from} -> ${change.to}`).join('\n')
    return `Meeting ${meeting.id}: revised ${applied.length} of ${meeting.segments.length} cue(s). The recognition stays stored beside every correction.\n${listing}`
  }

  /**
   * Store a document the agent produced about this meeting — a review, a summary or a
   * write-up — as a file beside the recording and as an entry the panel can list.
   * @param args - Model arguments, validated here because a raw definition is not.
   * @param exec - Tool run context carrying the calling session.
   * @returns a short confirmation.
   */
  async function saveDocument(args, exec) {
    const request = args !== null && typeof args === 'object' ? args : {}
    const sessionId = exec?.agent?.session?.id
    const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
    const meeting = findMeeting(typeof sessionId === 'string' ? sessionId : '', meetingId)
    if (meeting === undefined) return 'No meeting was found for this session; nothing was saved.'
    const markdown = typeof request.markdown === 'string' ? request.markdown.trim() : ''
    if (markdown === '') return 'The document was empty; nothing was saved.'
    if (!Array.isArray(meeting.documents)) meeting.documents = []
    const kind = DOCUMENT_KINDS.includes(request.kind) ? request.kind : 'note'
    const title = typeof request.title === 'string' && request.title.trim() !== '' ? request.title.trim() : '会议文档'
    const name = `${stampOf(meeting.startedAt)}-${kind}${meeting.documents.length + 1}.md`
    const directory = exportDirectory()
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, name), markdown, 'utf8')
    } catch (error) {
      return `The document could not be written: ${error instanceof Error ? error.message : String(error)}`
    }
    meeting.documents.push({ id: `d${meeting.documents.length + 1}`, name, title, kind, at: Date.now() })
    void flushMeetings(ctx)
    return `Saved "${title}" as ${name} (${Buffer.byteLength(markdown, 'utf8')} bytes). It is listed in the meeting panel.`
  }

  /**
   * Store the text the agent read out of a handwritten note.
   * @param args - Model arguments, validated here because a raw definition is not.
   * @param exec - Tool run context carrying the calling session.
   * @returns a short confirmation.
   */
  async function writeNote(args, exec) {
    const request = args !== null && typeof args === 'object' ? args : {}
    const sessionId = exec?.agent?.session?.id
    const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
    const meeting = findMeeting(typeof sessionId === 'string' ? sessionId : '', meetingId)
    if (meeting === undefined) return 'No meeting was found for this session; nothing was recorded.'
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (text === '') return 'The text was empty; nothing was recorded.'
    meeting.notes.push({
      id: `n${meeting.notes.length + 1}`,
      name: typeof request.name === 'string' ? request.name : '',
      text,
      at: Date.now(),
      source: 'agent',
      // A human confirms a note before it becomes an assignment.
      status: 'draft',
    })
    return `Meeting ${meeting.id}: stored one handwritten note (${text.length} characters); it now holds ${meeting.notes.length} note(s).`
  }

  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
      'meeting-room: routes',
    )
    ctx.effect(() => ctx.tools.register({
      name: 'meeting_read',
      description: 'Read the meeting transcript recorded in this session: timed cues from the local speech recognizer plus the meeting terminology list. Use it to summarize the meeting, extract decisions, key points and action items, or to correct recognition errors. Returns plain text; the text says so when this session has no meeting yet.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Exact meeting id; omit to read this session\'s most recent meeting.' },
          limit: { type: 'integer', description: `Maximum cues to return, keeping the most recent (default ${DEFAULT_CUE_LIMIT}, max ${MAX_CUE_LIMIT}).` },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: readTranscript,
    }), 'meeting-room: meeting_read tool')
    ctx.effect(() => ctx.tools.register({
      name: 'meeting_write',
      description: 'Record the structured reading of a meeting: key points (decisions, points, risks, open questions) and work assignments (tasks with owner and due date). Call it after reading the transcript with meeting_read. Entries are stored per meeting and shown in the meeting panel; a task stays a draft until a human confirms it. Returns a short confirmation, not the stored data.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Exact meeting id; omit to write to this session\'s most recent meeting.' },
          mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) adds and skips duplicates; replace clears what was stored before.' },
          points: {
            type: 'array',
            description: 'Key points in meeting order.',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['decision', 'point', 'risk', 'question'], description: 'What kind of point this is.' },
                text: { type: 'string', description: 'The point, in one sentence.' },
                quote: { type: 'string', description: 'The transcript words this came from, verbatim.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          tasks: {
            type: 'array',
            description: 'Work assignments agreed in the meeting.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The task, starting with a verb.' },
                owner: { type: 'string', description: 'Who owns it; empty when the meeting did not say.' },
                due: { type: 'string', description: 'Due date or time as agreed, e.g. 周五 or 2026-10-20 18:00; empty when unstated.' },
                priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority; defaults to normal.' },
                source: { type: 'string', description: 'The transcript words that assigned it, verbatim.' },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: writeAnalysis,
    }), 'meeting-room: meeting_write tool')
    ctx.effect(() => ctx.tools.register({
      name: 'meeting_note_write',
      description: 'Store the text you read out of a handwritten meeting note, after the user sends a drawing for recognition. Notes stay drafts until a human confirms them. Returns a short confirmation.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Exact meeting id; omit to write to this session\'s most recent meeting.' },
          text: { type: 'string', description: 'The recognized note text, verbatim. Mark anything illegible instead of guessing.' },
          name: { type: 'string', description: 'The drawing file name when the user saved one, else empty.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: writeNote,
    }), 'meeting-room: meeting_note_write tool')
    ctx.effect(() => ctx.tools.register({
      name: 'meeting_revise',
      description: 'Second-pass correction of a finished meeting transcript. After reading the transcript with meeting_read, submit the cues you can correct from context — consistent names, terms heard as homophones, obviously garbled words. Each correction is stored beside the recognition it replaces, so the original is never lost and the change is listed for review. Only correct what the context supports; never invent content.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Exact meeting id; omit to revise this session\'s most recent meeting.' },
          corrections: {
            type: 'array',
            description: 'Cues to correct, in transcript order.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The cue id exactly as meeting_read reported it.' },
                text: { type: 'string', description: 'The corrected text for that cue, in full.' },
              },
              required: ['id', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['corrections'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: reviseTranscript,
    }), 'meeting-room: meeting_revise tool')
    ctx.effect(() => ctx.tools.register({
      name: 'meeting_save_document',
      description: 'Save a document you produced about this meeting — a role-based review, a summary, or any write-up — into the meeting record. It is written as a Markdown file next to the recording and listed in the meeting panel, so the user keeps it without copying from the conversation. Call it after finishing the document text.',
      parameters: {
        type: 'object',
        properties: {
          meetingId: { type: 'string', description: 'Exact meeting id; omit to save to this session\'s most recent meeting.' },
          kind: { type: 'string', enum: DOCUMENT_KINDS, description: 'What the document is: a review, a summary, or a note.' },
          title: { type: 'string', description: 'A short human title, e.g. 会议复盘（主持人视角）.' },
          markdown: { type: 'string', description: 'The complete document, in Markdown.' },
        },
        required: ['markdown'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: saveDocument,
    }), 'meeting-room: meeting_save_document tool')
    ctx.effect(() => disposeSpeakers, 'meeting-room: speaker worker')
    ctx.effect(() => disposeHandwriting, 'meeting-room: handwriting worker')
    // Records are flushed on a timer rather than on every change, so a burst of edits costs
    // one write, and the final state still lands when the plugin unloads.
    const flushTimer = setInterval(() => { void flushMeetings(ctx) }, 5000)
    ctx.effect(() => () => {
      clearInterval(flushTimer)
      void flushMeetings(ctx)
    }, 'meeting-room: meeting store')
    const recovered = restoreMeetings(ctx)
    void recovered.then((count) => {
      if (count > 0) ctx.logger.info('dsh-meeting-room: recovered %d meeting record(s)', count)
    }, (error) => {
      ctx.logger.warn('dsh-meeting-room: could not read the meeting store: %s', error instanceof Error ? error.message : String(error))
    })
    ctx.logger.info('dsh-meeting-room: host half active (%s)', PREFIX)
  } catch (error) {
    // Never let this plugin fail the whole boot: a missing service or a route
    // conflict must surface as an unusable meeting panel, not a dead harness.
    ctx.logger.warn('dsh-meeting-room: registration failed: %s', error instanceof Error ? error.message : String(error))
  }
}
