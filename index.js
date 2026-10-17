/**
 * Host half of the meeting-room plugin (entry point).
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：kekydream@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * This module is the thin entry point. All logic lives in sibling modules:
 *   host-constants.js   – shared constants and mutable state
 *   host-helpers.js     – HTTP/WAV/utility helpers
 *   host-speaker.js     – speaker diarization worker
 *   host-handwriting.js – handwriting recognition worker
 *   host-persistence.js – meeting record persistence
 *   host-sessions.js    – session ↔ meeting coordination
 *   host-routes.js      – HTTP route handler
 *   host-tools.js       – business logic, analysis, tools
 */

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { meetings } from './host-constants.js'
import { createHandler } from './host-routes.js'
import { disposeSpeakers } from './host-speaker.js'
import { disposeHandwriting } from './host-handwriting.js'
import { flushMeetings, restoreMeetings } from './host-persistence.js'
import { setSessionStore, ensureMeetingForSession, reapMeetingForSession, recordingMeetingForSession } from './host-sessions.js'
import {
  readTranscript,
  queryMeetings,
  writeAnalysis,
  reviseTranscript,
  saveDocument,
  writeNote,
  finalizeRecording,
} from './host-tools.js'

/**
 * Append one line to the boot canary so a broken activation is diagnosable
 * without console access. Never throws: the canary must not add new failure
 * modes to the plugin.
 * @param parts - values joined into one line.
 */
function bootLog(...parts) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const directory = join(home, 'meeting-room')
    mkdirSync(directory, { recursive: true })
    const line = `${new Date().toISOString()} ${parts.map((part) => (
      typeof part === 'string' ? part
        : part instanceof Error ? (part.stack ?? part.message)
          : JSON.stringify(part)
    )).join(' ')}\n`
    appendFileSync(join(directory, 'boot.log'), line, 'utf8')
  } catch {
    // Silent: logging must not affect the plugin.
  }
}
bootLog('module-imported')

// ── Plugin identity ──────────────────────────────────────────────────────────

/** Loader-facing plugin name. */
export const name = 'meeting-room'

/**
 * Required host services.
 *
 * `speechToText` is intentionally absent: the plugin reads it lazily via
 * `ctx.get('speechToText')` so a profile without the speech capability still
 * loads this plugin (transcription then reports it is unavailable instead of
 * wedging the whole plugin in the pending state).
 */
export const inject = ['webServer', 'tools']

const warn = (ctx, message, error) => {
  try {
    ctx.logger.warn(message, error instanceof Error ? error.message : String(error))
  } catch {
    bootLog('logger-unavailable')
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate the host half. Registration order matters for resilience: the HTTP
 * routes and the meeting tools come FIRST and each registers in its own guard,
 * so no unrelated failure (session wiring, persistence, workers) can take the
 * meeting panel down with it.
 * @param ctx - Host context owned by this plugin's fiber.
 */
export function apply(ctx) {
  bootLog('apply-enter')
  const handler = createHandler(ctx)

  // ── Routes (registered before everything else) ──────────────────────────
  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/meeting-room', handler }),
      'meeting-room: routes',
    )
    bootLog('routes-ok')
  } catch (error) {
    bootLog('routes-failed', error)
    warn(ctx, 'dsh-meeting-room: route registration failed: %s', error)
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  const registerTool = (definition, label) => {
    try {
      ctx.effect(() => ctx.tools.register(definition), label)
      bootLog(label)
    } catch (error) {
      bootLog(`${label}-failed`, error)
      warn(ctx, `dsh-meeting-room: ${label} failed: %s`, error)
    }
  }

  registerTool({
    name: 'meeting_read',
    description: 'Read the meeting transcript recorded in this session: timed cues from the local speech recognizer plus the meeting terminology list. Use it to summarize the meeting, extract decisions, key points and action items, or to correct recognition errors. Returns plain text; the text says so when this session has no meeting yet.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to read this session\'s most recent meeting.' },
        limit: { type: 'integer', description: 'Maximum cues to return, keeping the most recent (default 400, max 4000).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: readTranscript,
  }, 'meeting-room: meeting_read tool')

  registerTool({
    name: 'meeting_query',
    description: 'Find this machine\'s meetings by type, period, date range or person and read what each one holds: a short summary by default, plus tasks, points or scores on request. Read-only, and every hit carries its meeting id — which is how a later meeting writes back to an earlier one (meeting_write with an explicit meetingId), e.g. a review meeting checking off what a briefing assigned. Results read oldest first; when more meetings match than fit the limit, the older ones are omitted and the report says so.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['briefing', 'review', 'weekly', 'monthly'], description: 'Only meetings of this type; omit to search every type.' },
        period: { type: 'string', description: 'One bucket: a day (2026-10-18), an ISO week (2026-W42) or a month (2026-10); or the alias today, yesterday, this-week or this-month. A weekly alias matches only weekly meetings. Do not combine with from/to.' },
        from: { type: 'string', description: 'Earliest meeting start, as the local date YYYY-MM-DD; do not combine with period.' },
        to: { type: 'string', description: 'Latest meeting start, as the local date YYYY-MM-DD; do not combine with period.' },
        person: { type: 'string', description: 'Only meetings where this person owns a task or appears in the scores; exact name match.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['tasks', 'points', 'scores'] },
          description: 'Detail to list per meeting; without it a meeting reports counts and a short summary only.',
        },
        limit: { type: 'integer', description: 'Maximum meetings to report, keeping the most recent (default 20, max 100).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: queryMeetings,
  }, 'meeting-room: meeting_query tool')

  registerTool({
    name: 'meeting_write',
    description: 'Record the structured reading of a meeting: key points (decisions, points, risks, open questions) and work assignments (tasks with owner and due date), plus — for a monthly review — one score row per person. Call it after reading the transcript with meeting_read. Entries are stored per meeting and shown in the meeting panel; a task or a score stays a draft until a human confirms it. A task entry carrying the id of an existing task updates it in place, which is how a review meeting checks off what a briefing assigned. Returns a short confirmation, not the stored data.',
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
          description: 'Work assignments: an entry with a title creates a draft task; an entry with the id of an existing task updates that task in place (this is how a review meeting checks off what a briefing assigned, including in another meeting through meetingId).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Id of an existing task to update, as reported by meeting_read or meeting_query; omit to create a new task.' },
              title: { type: 'string', description: 'The task, starting with a verb. Required when creating; optional when updating.' },
              owner: { type: 'string', description: 'Who owns it; empty when the meeting did not say.' },
              due: { type: 'string', description: 'Due date or time as agreed, e.g. 周五 or 2026-10-20 18:00; empty when unstated.' },
              priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority; defaults to normal.' },
              source: { type: 'string', description: 'The transcript words that assigned it, verbatim.' },
              done: { type: 'boolean', description: 'Whether the work is finished; a human owns the final confirmation, so this is separate from the confirmed/draft state.' },
            },
            required: [],
            additionalProperties: false,
          },
        },
        scores: {
          type: 'array',
          description: 'Score rows for a monthly review, one per person; an entry naming an existing person updates that row. The total is recomputed from the numbers.',
          items: {
            type: 'object',
            properties: {
              person: { type: 'string', description: 'Whose score this is; matches an existing row by name.' },
              hours: { type: 'number', description: 'Work or course hours contributed in the period.' },
              completion: { type: 'number', description: 'Task completion rate 0–100; the panel can pre-fill it from the period\'s tasks.' },
              quality: { type: 'number', description: 'Work quality 1–10.' },
              learn: { type: 'number', description: 'Participation in learning 1–10.' },
              highlight: { type: 'string', description: 'What went well, in one line.' },
              improve: { type: 'string', description: 'What to improve, in one line.' },
              basis: { type: 'array', items: { type: 'string' }, description: 'Evidence behind the numbers: transcript quotes or task ids. Never score without evidence.' },
            },
            required: ['person'],
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
  }, 'meeting-room: meeting_write tool')

  registerTool({
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
  }, 'meeting-room: meeting_note_write tool')

  registerTool({
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
  }, 'meeting-room: meeting_revise tool')

  registerTool({
    name: 'meeting_save_document',
    description: 'Save a document you produced about this meeting — a role-based review, a summary, or any write-up — into the meeting record. It is written as a Markdown file next to the recording and listed in the meeting panel, so the user keeps it without copying from the conversation. Call it after finishing the document text.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to save to this session\'s most recent meeting.' },
        kind: { type: 'string', enum: ['review', 'summary', 'note'], description: 'What the document is: a review, a summary, or a note.' },
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
  }, 'meeting-room: meeting_save_document tool')

  // ── Session ↔ meeting lifecycle (after the panel surface is safe) ───────
  try {
    // The live session store lets meetings follow the session lineage: an agent
    // execution inside a subagent resolves the owning conversation's meeting.
    // Optional access: `ctx.sessions` would throw without declaring `sessions`
    // in inject; `ctx.get('sessions')` simply reads undefined when absent.
    setSessionStore(ctx.get('sessions') ?? null)

    // One meeting per user conversation, created the moment the session is created
    // (delegated sessions — subagents, team members — share their root's meeting).
    // A throwing listener here would roll the whole session publication back, so
    // everything this listener does is wrapped and cannot throw.
    ctx.on('session/created', (session) => {
      try {
        ensureMeetingForSession(ctx, session)
      } catch (error) {
        warn(ctx, 'dsh-meeting-room: meeting creation failed: %s', error)
      }
    })
    // A session that dies takes its meeting with it — but only when the meeting is
    // still empty and never persisted. A recording in flight is finalized first
    // through the same path as the stop button, and stays as history.
    ctx.on('session/disposed', (session) => {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      try {
        const recording = recordingMeetingForSession(sessionId)
        if (recording !== undefined) {
          void finalizeRecording(ctx, recording).catch((error) => {
            warn(ctx, 'dsh-meeting-room: could not finalize meeting of a disposed session: %s', error)
          })
        } else {
          reapMeetingForSession(sessionId)
        }
      } catch (error) {
        warn(ctx, 'dsh-meeting-room: meeting disposal failed: %s', error)
      }
    })

    // ── Archive admission ──────────────────────────────────────────────────
    // The workspace seam (same pattern as dsh-subagent): a non-empty activity
    // answer refuses the archive, so a session that is recording cannot be
    // archived quietly; archiving with stopActivity runs the same end-of-
    // recording path and keeps the finished record as history.
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      const recording = recordingMeetingForSession(sessionId)
      if (recording === undefined) return rest
      return [{ kind: 'meeting', items: [{ id: recording.id, label: '会议录音进行中' }] }, ...rest]
    })
    ctx.on('workspace/session-stop', ({ sessionId }) => {
      const recording = recordingMeetingForSession(sessionId)
      if (recording === undefined) return
      void finalizeRecording(ctx, recording).catch((error) => {
        warn(ctx, 'dsh-meeting-room: could not finalize meeting of an archived session: %s', error)
      })
    })
    bootLog('lifecycle-ok')
  } catch (error) {
    bootLog('lifecycle-failed', error)
    warn(ctx, 'dsh-meeting-room: session lifecycle wiring failed: %s', error)
  }

  // ── Disposal ───────────────────────────────────────────────────────────
  ctx.effect(() => disposeSpeakers, 'meeting-room: speaker worker')
  ctx.effect(() => disposeHandwriting, 'meeting-room: handwriting worker')

  // ── Periodic flush ─────────────────────────────────────────────────────
  const flushTimer = setInterval(() => { void flushMeetings(ctx) }, 5000)
  ctx.effect(() => () => {
    clearInterval(flushTimer)
    void flushMeetings(ctx)
  }, 'meeting-room: meeting store')

  // ── Restore persisted meetings, THEN sweep restored sessions ────────────
  // The sweep must run after the store read back its files, or a restored
  // conversation would get a second, empty eager meeting that hides its real
  // history. Sessions announced after activation are covered by the
  // session/created listener; the restore-side adoption rule (host-persistence)
  // stays as a second, ordering-independent line of defense. Idempotent.
  const sweepMeetingsForSessions = () => {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.list !== 'function') return
      for (const session of sessions.list()) ensureMeetingForSession(ctx, session)
    } catch (error) {
      warn(ctx, 'dsh-meeting-room: session sweep failed: %s', error)
    }
  }
  const recovered = restoreMeetings(ctx)
  void recovered.then(
    (count) => {
      if (count > 0) ctx.logger?.info('dsh-meeting-room: recovered %d meeting record(s)', count)
      sweepMeetingsForSessions(ctx)
      bootLog('apply-done', `recovered=${count}`)
    },
    (error) => {
      warn(ctx, 'dsh-meeting-room: could not read the meeting store: %s', error)
      sweepMeetingsForSessions(ctx)
      bootLog('apply-done', 'restore-failed')
    },
  )

  ctx.logger?.info('dsh-meeting-room: host half active (/meeting-room)')
}