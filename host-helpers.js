/**
 * General-purpose host helpers extracted from meeting-room/index.js.
 *
 * Pure ESM, Node builtins only. Each helper is self-contained so other
 * modules can import exactly what they need without pulling in the full
 * meeting-room plugin.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

/** Accepted request body ceiling; one 8-second 16 kHz mono PCM16 cue is ~256 KB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Accepted artifact name: one path segment, first character alphanumeric, no traversal. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/**
 * Decide whether a caller-supplied artifact name may be joined to the meetings directory.
 * @param name - Requested file name.
 * @returns whether the name is a single traversal-free segment.
 */
export function isSafeArtifactName(name) {
  return SAFE_NAME.test(name) && !name.includes('..')
}

/**
 * Write a JSON response.
 * @param res - Response owned by this route.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

/**
 * Collect a request body with a hard size ceiling.
 * @param req - Incoming request.
 * @returns the body bytes.
 */
export function readBody(req) {
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
export function sameOrigin(req) {
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
export function wavFromPcm(pcm, sampleRate) {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])
}

/**
 * Build the 44-byte canonical WAV header for 16 kHz mono PCM16.
 * @param dataBytes - PCM payload size in bytes.
 * @param sampleRate - Samples per second.
 * @returns the header bytes.
 */
export function wavHeader(dataBytes, sampleRate) {
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
export function contentTypeOf(name) {
  if (name.endsWith('.wav')) return 'audio/wav'
  if (name.endsWith('.png')) return 'image/png'
  return 'text/plain; charset=utf-8'
}

/**
 * Render a local date and time for file names, matching the browser half's stamp.
 * @param at - Epoch milliseconds.
 * @returns `YYYY-MM-DD_HH-MM-SS` in local time.
 */
export function stampOf(at) {
  const date = new Date(at)
  const pad = (value) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${day}_${time}`
}

/**
 * Resolve the directory exports are written to.
 * Uses the DSH_HOME pattern: ~/.dsh/meetings
 * @returns an absolute directory path.
 */
export function exportDirectory() {
  return join(homedir(), '.dsh', 'meetings')
}

/**
 * Resolve an interpreter that can import python-docx: an explicit override, the bundled
 * runtime payload, then whatever `python3`/`python` is on the path.
 * @returns the command to run, or an empty string when none is usable.
 */
export async function pythonExecutable() {
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
 * Render seconds as m:ss.
 * @param seconds - Offset in seconds.
 * @returns the clock text.
 */
export function clockOf(seconds) {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Select the meeting a request refers to: an explicit id, else the session's newest.
 * @param meetings - The meetings Map to search.
 * @param sessionId - Session making the request, when known.
 * @param meetingId - Explicit meeting id, when given.
 * @returns the meeting, or undefined when none matches.
 */
export function findMeeting(meetings, sessionId, meetingId) {
  if (meetingId !== '') return meetings.get(meetingId)
  let found
  for (const meeting of meetings.values()) {
    if (sessionId !== '' && meeting.sessionId !== sessionId) continue
    if (found === undefined || meeting.startedAt > found.startedAt) found = meeting
  }
  return found
}
