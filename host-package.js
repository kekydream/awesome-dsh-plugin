/**
 * Meeting packages: one meeting, everything it owns, in a single ZIP.
 *
 * The archive is what makes a meeting portable — the record itself, its recording, and the
 * artifacts produced from it — so another DSH can open the meeting as a project. The ZIP is
 * written and read here with only Node's zlib, exactly to the specification, so no dependency
 * enters the plugin and the file stays readable by any ordinary unzip tool.
 *
 * Layout inside the archive:
 *   meeting.json          the record exactly as it is persisted (segments, points, tasks, …)
 *   manifest.json         format name, version, plugin id and the meeting's own identity
 *   audio/<recording>     the recording, when the meeting has one
 *   files/<artifact>      the artifacts the meeting references (minutes, drawings, documents)
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { join, basename } from 'node:path'

import { MEETING_KINDS, meetings } from './host-constants.js'
import { periodOf } from './host-tools.js'
import { exportDirectory } from './host-helpers.js'
import { recordOf } from './host-persistence.js'

/** Identifies the archive so an import can refuse a file that is not one of ours. */
export const PACKAGE_FORMAT = 'dsh-meeting-room-package'
/** Bumped when the archive layout changes in a way an older reader cannot handle. */
export const PACKAGE_VERSION = 1
/** A meeting package is small; a few-hundred-KB zip must not expand to gigabytes. */
const MAX_ENTRIES = 2000
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

/**
 * The CRC-32 the ZIP format stores per entry.
 * @param buffer - Entry bytes.
 * @returns the checksum as an unsigned 32-bit number.
 */
export function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/**
 * Build a ZIP archive from in-memory entries, deflating each one.
 * @param entries - `{ name, data }` pairs; data may be a Buffer, a string or null.
 * @returns the archive bytes.
 */
export function zipWrite(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/gu, '/'), 'utf8')
    const data = entry.data === null || entry.data === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = deflateRawSync(data)
    // Storing beats deflating when compression does not help (tiny files, PNG, WAV).
    const stored = deflated.length >= data.length
    const body = stored ? data : deflated
    const method = stored ? 0 : 8
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Read a ZIP archive held in memory.
 * @param buffer - Archive bytes.
 * @returns `{ name, data }` entries, in archive order.
 */
export function zipRead(buffer) {
  const end = (() => {
    for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66000; index -= 1) {
      if (buffer.readUInt32LE(index) === 0x06054b50) return index
    }
    return -1
  })()
  if (end < 0) throw new Error('not a zip archive')
  const count = buffer.readUInt16LE(end + 10)
  if (count > MAX_ENTRIES) throw new Error(`this archive has too many entries (${count})`)
  let cursor = buffer.readUInt32LE(end + 16)
  const entries = []
  let unpacked = 0
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('damaged zip directory')
    const method = buffer.readUInt16LE(cursor + 10)
    const size = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const localName = buffer.readUInt16LE(localOffset + 26)
    const localExtra = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const raw = buffer.subarray(start, start + size)
    let data
    try {
      data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : Buffer.from(raw)
    } catch {
      throw new Error(`entry ${name} could not be read (it may expand past the size limit)`)
    }
    unpacked += data.length
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error('this archive expands past the size limit')
    entries.push({ name, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Collect everything one meeting owns into one archive.
 * @param meeting - Meeting record.
 * @returns the archive bytes.
 */
export async function packageMeeting(meeting) {
  const entries = []
  entries.push({ name: 'meeting.json', data: recordOf(meeting) })
  entries.push({
    name: 'manifest.json',
    data: JSON.stringify({
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      meetingId: meeting.id,
      title: meeting.title ?? '',
      kind: meeting.kind ?? '',
      period: meeting.period ?? '',
      startedAt: meeting.startedAt,
      exportedAt: Date.now(),
    }, null, 2),
  })
  const directory = exportDirectory()
  const wanted = new Set()
  if (typeof meeting.audioName === 'string' && meeting.audioName !== '') wanted.add(meeting.audioName)
  for (const document of meeting.documents ?? []) {
    if (typeof document.name === 'string' && document.name !== '') wanted.add(document.name)
  }
  for (const note of meeting.notes ?? []) {
    if (typeof note.name === 'string' && note.name !== '') wanted.add(note.name)
  }
  for (const name of wanted) {
    try {
      const bytes = await readFile(join(directory, name))
      const folder = name === meeting.audioName ? 'audio' : 'files'
      entries.push({ name: `${folder}/${name}`, data: bytes })
    } catch {
      // A referenced file that is gone simply does not travel: the record still does.
    }
  }
  return zipWrite(entries)
}

/**
 * Bring one meeting back from an archive, as a meeting of this machine.
 *
 * The record keeps everything it described, but it is a NEW meeting: it belongs to no session
 * here and its recording and artifacts are written into this machine's export directory, so
 * the import can never overwrite what is already there.
 * @param buffer - Archive bytes.
 * @returns the imported meeting's id, title and how many files came with it.
 */
export async function importPackage(buffer) {
  const entries = zipRead(buffer)
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  const recordEntry = entries.find((entry) => entry.name === 'meeting.json')
  if (recordEntry === undefined) throw new Error('the archive has no meeting.json')
  if (manifestEntry !== undefined) {
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'))
    if (manifest.format !== PACKAGE_FORMAT) throw new Error('this archive is not a meeting package')
    if (typeof manifest.version === 'number' && manifest.version > PACKAGE_VERSION) {
      throw new Error(`this archive needs a newer plugin (package version ${manifest.version})`)
    }
  }
  const record = JSON.parse(recordEntry.data.toString('utf8'))
  const imported = {
    ...record,
    // A fresh identity here: the archive's id may already exist, and this meeting owns no
    // session on this machine (it is opened from the management page, not from a conversation).
    id: `meeting-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: '',
    controller: new AbortController(),
    importedAt: Date.now(),
    importedFrom: record.id ?? '',
  }
  // A record from another machine (or an older version) is not trusted blindly: one missing
// array would make every later flush throw, and a stale period would hide the meeting from
// the cross-meeting queries (§2.2). Normalise, then recompute the derived fields.
  for (const key of ['segments', 'points', 'tasks', 'notes', 'revisions', 'scores', 'speakerLabels', 'people', 'documents']) {
    if (!Array.isArray(imported[key])) imported[key] = []
  }
  if (imported.speakers === null || typeof imported.speakers !== 'object' || Array.isArray(imported.speakers)) imported.speakers = {}
  imported.kind = MEETING_KINDS.includes(imported.kind) ? imported.kind : ''
  const importedAt = typeof imported.startedAt === 'number' && Number.isFinite(imported.startedAt) ? imported.startedAt : Date.now()
  imported.startedAt = importedAt
  imported.period = periodOf(imported.kind, importedAt)
  imported.title = typeof imported.title === 'string' ? imported.title : ''

  const directory = exportDirectory()
  await mkdir(directory, { recursive: true })
  let copied = 0
  for (const entry of entries) {
    if (!entry.name.startsWith('audio/') && !entry.name.startsWith('files/')) continue
    const name = basename(entry.name)
    if (name === '' || name === '.' || name === '..') continue
    // The archive's own name is kept unless this machine already has that file.
    let target = name
    const taken = await stat(join(directory, target)).then(() => true).catch(() => false)
    if (taken) target = `${Date.now().toString(36)}-${name}`
    await writeFile(join(directory, target), entry.data)
    if (entry.name.startsWith('audio/') && imported.audioName === name) imported.audioName = target
    for (const list of [imported.documents, imported.notes]) {
      for (const item of Array.isArray(list) ? list : []) {
        if (item !== null && typeof item === 'object' && item.name === name) item.name = target
      }
    }
    copied += 1
  }
  meetings.set(imported.id, imported)
  return { meetingId: imported.id, title: imported.title ?? '', kind: imported.kind ?? '', files: copied }
}