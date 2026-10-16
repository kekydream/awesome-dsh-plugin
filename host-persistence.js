/**
 * Meeting persistence: flush changed records to disk and restore them on startup.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：kekydream@qq.com
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
export const persisted = new Map()

/**
 * Write every meeting whose record changed. Called periodically and when a recording stops,
 * so points, tasks, notes, corrections and speaker names survive a restart without a write
 * on every keystroke-sized change.
 * @param ctx - Host context, used to log a write failure.
 * @returns after every pending write settles.
 */
export async function flushMeetings(ctx) {
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
