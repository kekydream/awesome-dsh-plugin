/**
 * Meeting persistence: flush changed records to disk and restore them on startup.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { meetings } from './host-constants.js'

/**
 * Resolve the directory meeting records are persisted to.
 * @returns an absolute directory path.
 */
export function meetingStoreDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'meetings')
}

/**
 * Serialize one meeting for the store, dropping what cannot outlive the process.
 * @param meeting - Meeting record.
 * @returns the JSON text to write.
 */
export function recordOf(meeting) {
  // A writer handle and an abort controller are process-local; speaker embeddings belong to
  // the recording that produced them and are rebuilt by the next one; kept PCM is only a
  // stop-time backfill vehicle for cues the first-pass labeling missed. Voice centroids are
  // derived from those embeddings and are deliberately NOT persisted either: the voice library
  // (host-voices.js) is the only place a voice profile is kept, and it is written only when a
  // person names a speaker.
  const { audioHandle, controller, voiceCentroids, recentPcm, recordRequestedAt, ...rest } = meeting
  // Defensive on purpose: one malformed record (an import, a hand-edited file) must not
  // throw here, because this runs inside the 5-second flush loop and would take every
  // later meeting's write down with it.
  const segments = (Array.isArray(rest.segments) ? rest.segments : []).map(({ embedding, pcm, ...segment }) => segment)
  return JSON.stringify({
    ...rest,
    segments,
    points: Array.isArray(rest.points) ? rest.points : [],
    tasks: Array.isArray(rest.tasks) ? rest.tasks : [],
    notes: Array.isArray(rest.notes) ? rest.notes : [],
    documents: Array.isArray(rest.documents) ? rest.documents : [],
    scores: Array.isArray(rest.scores) ? rest.scores : [],
    role: meeting.role ?? '',
    revisions: meeting.revisions ?? [],
    speakers: meeting.speakers ?? {},
  })
}

/** Serialized text last written per meeting, so a flush skips unchanged records. */
export const persisted = new Map()

/**
 * Whether a meeting carries no meeting content at all: no transcript, points, tasks,
 * notes, documents, corrections, people, speakers, terms, role, or recording. An eager
 * meeting created because its session was created stays in this state until the person
 * actually records or writes something into it.
 * @param meeting - Meeting record.
 * @returns true when nothing worth persisting has happened yet.
 */
export function meetingIsEmpty(meeting) {
  for (const key of ['segments', 'points', 'tasks', 'notes', 'documents', 'revisions', 'people', 'scores']) {
    if (Array.isArray(meeting[key]) && meeting[key].length > 0) return false
  }
  // A name or a type is a deliberate act: a meeting the person named must survive even
  // when nothing was recorded or written yet (§5.5). The period is derived from the type.
  if (typeof meeting.title === 'string' && meeting.title !== '') return false
  if (typeof meeting.kind === 'string' && meeting.kind !== '') return false
  if (typeof meeting.audioName === 'string' && meeting.audioName !== '') return false
  if (typeof meeting.role === 'string' && meeting.role !== '') return false
  if (typeof meeting.summary === 'string' && meeting.summary !== '') return false
  if (typeof meeting.terms === 'string' && meeting.terms !== '') return false
  if (meeting.speakers !== null && typeof meeting.speakers === 'object' && !Array.isArray(meeting.speakers) && Object.keys(meeting.speakers).length > 0) return false
  return true
}

/**
 * Write every meeting whose record changed. Called periodically and when a recording stops,
 * so points, tasks, notes, corrections and speaker names survive a restart without a write
 * on every keystroke-sized change.
 * @param ctx - Host context, used to log a write failure.
 * @returns after every pending write settles.
 */
export function flushMeetings(ctx) {
  // One flush at a time: the 5-second timer and the panel's "save now" can otherwise write
  // the same record concurrently, and the slower write could land last.
  const run = pendingFlush.then(() => flushOnce(ctx), () => flushOnce(ctx))
  pendingFlush = run.then(() => undefined, () => undefined)
  return run
}

/** The flush currently queued or running; resolved before the next one starts. */
let pendingFlush = Promise.resolve()

/**
 * Write every changed meeting, one at a time. Never throws: a failure is reported in the
 * result so the caller (and the panel) can tell the truth about whether it saved.
 */
async function flushOnce(ctx) {
  const directory = meetingStoreDirectory()
  const failed = []
  let written = 0
  for (const meeting of meetings.values()) {
    let text
    try {
      text = recordOf(meeting)
    } catch (error) {
      // One unreadable record must not abort the loop: every meeting after it would stay
      // unwritten, which is silent data loss. Report it and keep going.
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ id: meeting.id, error: message })
      ctx.logger.warn('meeting-room: could not serialize %s: %s', meeting.id, message)
      continue
    }
    if (persisted.get(meeting.id) === text) continue
    // A meeting created eagerly for a new session writes nothing to disk until it
    // carries actual meeting content; the store holds only real records.
    if (meetingIsEmpty(meeting) && !persisted.has(meeting.id)) continue
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${meeting.id}.json`), text, 'utf8')
      persisted.set(meeting.id, text)
      written += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ id: meeting.id, error: message })
      ctx.logger.warn('meeting-room: could not persist %s: %s', meeting.id, message)
    }
  }
  return { written, failed }
}

/**
 * Load every persisted meeting back into memory.
 * @param ctx - Host context.
 * @returns the number of meetings recovered.
 */
export async function restoreMeetings(ctx) {
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
      const raw = await readFile(join(directory, name), 'utf8')
      const record = JSON.parse(raw)
      if (typeof record.id !== 'string' || record.id === '') continue
      // One session owns at most one meeting. A live meeting for the same session can
      // already exist when `session/created` or the boot sweep ran before this file was
      // read back. The disk record is the authoritative history: an empty, never-
      // persisted live meeting loses to it; a live meeting that already carries content
      // (the session continued working in the startup window) wins instead.
      const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : ''
      const live = sessionId === '' ? undefined : [...meetings.values()].find(
        (meeting) => meeting.id !== record.id && meeting.sessionId === sessionId,
      )
      if (live !== undefined) {
        if (meetingIsEmpty(live) && !persisted.has(live.id)) {
          meetings.delete(live.id)
          ctx.logger.info('dsh-meeting-room: adopting %s: empty live meeting %s of session %s yields to the stored record', record.id, live.id, sessionId)
        } else {
          ctx.logger.warn('dsh-meeting-room: skipping %s: session %s already has live meeting %s with content', record.id, sessionId, live.id)
          continue
        }
      }
      // A restored record is history: it gets no writer handle, and its controller only
      // guards future work. Array fields are normalised because a damaged or older file
      // must not make every later flush throw.
      const restoredRecord = {
        seconds: 0,
        segments: [],
        points: [],
        tasks: [],
        notes: [],
        terms: '',
        role: '',
        revisions: [],
        speakers: {},
        // Metadata added after some records were already on disk: absent fields read as
        // "general, unnamed" instead of failing the restore.
        kind: '',
        period: '',
        title: '',
        scores: [],
        ...record,
        controller: new AbortController(),
      }
      for (const key of ['segments', 'points', 'tasks', 'notes', 'documents', 'revisions', 'scores', 'speakerLabels', 'people']) {
        if (!Array.isArray(restoredRecord[key])) restoredRecord[key] = []
      }
      if (restoredRecord.speakers === null || typeof restoredRecord.speakers !== 'object' || Array.isArray(restoredRecord.speakers)) restoredRecord.speakers = {}
      meetings.set(record.id, restoredRecord)
      // Remember the file's own text: without this every restored meeting looks "never
      // persisted" to the empty-meeting rule and to session disposal, and the first flush
      // rewrites the whole store.
      persisted.set(record.id, raw)
      restored += 1
    } catch (error) {
      ctx.logger.warn('meeting-room: could not restore %s: %s', name, error instanceof Error ? error.message : String(error))
    }
  }
  return restored
}