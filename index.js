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
 *   host-routes.js      – HTTP route handler
 *   host-tools.js       – business logic, analysis, tools
 */

// ── Imports ──────────────────────────────────────────────────────────────────

import { meetings } from './host-constants.js'
import { createHandler } from './host-routes.js'
import { disposeSpeakers } from './host-speaker.js'
import { disposeHandwriting } from './host-handwriting.js'
import { flushMeetings, restoreMeetings } from './host-persistence.js'
import {
  readTranscript,
  writeAnalysis,
  reviseTranscript,
  saveDocument,
  writeNote,
} from './host-tools.js'

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

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate the host half: register the meeting routes and the transcript tools.
 * @param ctx - Host context owned by this plugin's fiber.
 */
export function apply(ctx) {
  // Build the HTTP handler with ctx captured in closure.
  const handler = createHandler(ctx)

  try {
    // ── Routes ─────────────────────────────────────────────────────────────
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/meeting-room', handler }),
      'meeting-room: routes',
    )

    // ── Tools ──────────────────────────────────────────────────────────────
    ctx.effect(() => ctx.tools.register({
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
    }), 'meeting-room: meeting_save_document tool')

    // ── Disposal ───────────────────────────────────────────────────────────
    ctx.effect(() => disposeSpeakers, 'meeting-room: speaker worker')
    ctx.effect(() => disposeHandwriting, 'meeting-room: handwriting worker')

    // ── Periodic flush ─────────────────────────────────────────────────────
    const flushTimer = setInterval(() => { void flushMeetings(ctx) }, 5000)
    ctx.effect(() => () => {
      clearInterval(flushTimer)
      void flushMeetings(ctx)
    }, 'meeting-room: meeting store')

    // ── Restore persisted meetings on startup ──────────────────────────────
    const recovered = restoreMeetings(ctx)
    void recovered.then((count) => {
      if (count > 0) ctx.logger.info('dsh-meeting-room: recovered %d meeting record(s)', count)
    }, (error) => {
      ctx.logger.warn('dsh-meeting-room: could not read the meeting store: %s', error instanceof Error ? error.message : String(error))
    })

    ctx.logger.info('dsh-meeting-room: host half active (/meeting-room)')
  } catch (error) {
    // Never let this plugin fail the whole boot: a missing service or a route
    // conflict must surface as an unusable meeting panel, not a dead harness.
    ctx.logger.warn('dsh-meeting-room: registration failed: %s', error instanceof Error ? error.message : String(error))
  }
}
