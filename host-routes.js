/**
 * HTTP route handler for the meeting-room plugin.
 *
 * Extracted from index.js so the route logic lives in its own module.
 * `createHandler(ctx)` captures the host context in a closure and returns
 * the `async function handler(req, res)` that the web server registers.
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  PREFIX,
  MAX_BODY_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  SAMPLE_RATE,
  meetings,
  POINT_KINDS,
  TASK_PRIORITIES,
  DOCUMENT_KINDS,
  WEBHOOK_KINDS,
  PUSH_MODES,
  DEFAULT_CUE_LIMIT,
  MAX_CUE_LIMIT,
  SPEAKER_THRESHOLD,
  SPEAKER_MODEL,
  MEETING_KINDS,
  ROLE_LABELS,
  seenText,
  SPEAKER_THRESHOLD_PRESETS,
  SCORE_WEIGHT_KEYS,
  scoreWeights,
  setScoreWeights,
  newMeetingId,
} from './host-constants.js'

import {
  sendJson,
  readBody,
  sameOrigin,
  isSafeArtifactName,
  stampOf,
  exportDirectory,
  contentTypeOf,
  wavFromPcm,
  wavHeader,
  clockOf,
  findMeeting,
  pythonExecutable,
} from './host-helpers.js'

import { speakerState, prepareSpeakers, labelCue, relabelFromRecording, noteSpeakerLabel, retireSpeakerWorker } from './host-speaker.js'
import { meetingForSession } from './host-sessions.js'
import { handwritingState, recognizeHandwriting, prepareHandwriting } from './host-handwriting.js'
import { flushMeetings, meetingIsEmpty } from './host-persistence.js'
import { packageMeeting, importPackage } from './host-package.js'
import { modelState, installModel, importModel, activateModel, removeModel } from './host-models.js'
import { cloudTranscribe, cloudEmbed, cloudSummary, writeCloudSettings, testCloud, redact, cloudState } from './host-providers.js'
import {
  readSpeakerSettings,
  writeSpeakerSettings,
  voiceSummary,
  voicesFile,
  removeVoice,
  clearVoices,
  suggestNames,
  learnFromMeeting,
} from './host-voices.js'
import { readTranscriptSettings, writeTranscriptSettings } from './host-transcript.js'
import { DEFAULT_RULES } from './host-text.js'

/** Ceiling for an imported archive: a long meeting's recording travels inside one. */
const IMPORT_BODY_BYTES = 512 * 1024 * 1024

/**
 * Whether this installation can recognise speech on the machine at all.
 *
 * It decides whether the panel offers the local path or the cloud one — a question the
 * transcript settings page has to answer honestly rather than showing a switch that cannot work.
 * @param ctx - Host context.
 * @returns true when the speech capability is present.
 */
function localAsrAvailable(ctx) {
  try {
    return ctx.get('speechToText') !== undefined
  } catch {
    return false
  }
}

/**
 * The vocabulary to send with a cue when cloud recognition is on: the meeting's own terminology,
 * because names and jargon are exactly what a general model gets wrong.
 * @param meeting - Meeting record.
 * @returns a short prompt, or '' when the meeting has no terms.
 */
function hotwordsFor(meeting) {
  const terms = typeof meeting.terms === 'string' ? meeting.terms : ''
  if (terms.trim() === '') return ''
  return terms
    .split('\n')
    .map((line) => {
      const [wrong, right] = line.split('=')
      return (right === undefined ? wrong : right).trim()
    })
    .filter((word) => word !== '')
    .join(' ')
    .slice(0, 800)
}

import {
  appendChunk,
  extractAnalysis,
  correctText,
  finalizeRecording,
  minutesText,
  transcriptText,
  readSettings,
  writeSettings,
  periodOf,
  kindText,
  seriesFor,
  carryOverFor,
  scoreTotal,
  monthRangeOf,
  ownerTaskStats,
  scoresCsv,
  writeScoresXlsx,
  pushTasks,
  relabelSpeakers,
  publicSegments,
  mergeContinuation,
  splitCueIntoSentences,
  speakerLabels,
  displaySpeaker,
  writeDocx,
  minutesBlocks,
  webhookFile,
  dingtalkToken,
  dingtalkDepartments,
  dingtalkPeople,
  personOf,
  groupByOwner,
  ownerMarkdown,
  postRobot,
  pushToGroups,
  pushToPeople,
  readSpeechState,
  prepareSpeech,
} from './host-tools.js'

/**
 * Create the HTTP handler for all /meeting-room routes.
 *
 * Note: this factory itself is synchronous — it only returns the (async) handler closure.
 * The caller registers the returned function directly, so it must not be a promise.
 *
 * @param ctx - Host context owned by this plugin's fiber.
 * @returns an async function suitable for webServer.register.
 */
export function createHandler(ctx) {
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
          // The period is derived from the start time, so moving the start must move the
          // bucket too — otherwise a meeting resumed after midnight stays in yesterday's
          // day bucket and the cross-meeting queries miss it (§2.2).
          pending.period = periodOf(pending.kind ?? '', startedAt)
          if (typeof body.terms === 'string') pending.terms = body.terms
          pending.controller = new AbortController()
          pending.audioName = audioName
          pending.audioPath = audioPath
          pending.audioHandle = audioHandle
          pending.audioBytes = 0
          sendJson(res, 200, { meetingId: pending.id, sampleRate: SAMPLE_RATE, startedAt, audioName })
          return
        }
        const id = newMeetingId()
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
        const existing = findMeeting(meetings, sessionId, '')
        if (existing !== undefined) {
          sendJson(res, 200, { meetingId: existing.id, created: false })
          return
        }
        // Notes and tasks belong to a meeting even when nothing was recorded, so the first
        // write creates the container; a later recording joins it.
        const id = newMeetingId()
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
        // The last few seconds of audio before this cue: a very short cue is matched
        // against this window, so a two-word reply keeps the previous speaker instead of
        // enrolling a voice of its own.
        const contextPcm = meeting.recentPcm
        meeting.recentPcm = Buffer.concat([contextPcm ?? Buffer.alloc(0), pcm]).subarray(-SAMPLE_RATE * 2 * 3)
        // Persist the audio before recognition, so a transcription failure never costs
        // the recording itself.
        if (meeting.audioHandle !== undefined) {
          await meeting.audioHandle.write(pcm)
          meeting.audioBytes += pcm.length
        }
        const before = meeting.segments.length
        const text = await appendChunk(ctx, meeting, pcm, meeting.seconds)
        // Cloud recognition, when the person has turned it on. It never runs without consent
        // (the gate returns `skipped` before any request) and never costs the local text: a
        // failure keeps what the on-machine recogniser produced and says what happened.
        let cloud = { used: false, skipped: true, message: '' }
        // Real sentence boundaries from the cloud recognizer, when it reports them.
        let cloudHints = []
        if (meeting.segments.length > before) {
          const cue = meeting.segments[before]
          try {
            const answer = await cloudTranscribe({
              pcm: Buffer.from(cue.pcm ?? pcm),
              sampleRate: SAMPLE_RATE,
              language: meeting.language ?? '',
              hotwords: await hotwordsFor(meeting),
            })
            if (answer.skipped === true) {
              cloud = { used: false, skipped: true, message: '' }
            } else {
              // The on-machine result stays beside the cloud one: turning on a cloud model
              // must never erase what this machine heard (DESIGN §3.2).
              if (typeof cue.localText !== 'string') cue.localText = cue.text
              cue.text = answer.text
              cue.asrModel = answer.model
              meeting.asrModel = answer.model
              cloudHints = Array.isArray(answer.segments) ? answer.segments : []
              cloud = { used: true, skipped: false, message: '', model: answer.model }
            }
          } catch (failure) {
            cloud = {
              used: false,
              skipped: false,
              message: redact(failure instanceof Error ? failure.message : String(failure)),
              fallback: cloudState.fallback,
            }
          }
        }
        // Label the cue that was just appended. One cue can span a speaker change; that
        // case keeps the dominant voice and is a documented limitation.
        if (meeting.segments.length > before) {
          const judged = await labelCue(ctx, pcm, contextPcm)
          if (judged.speaker !== '') {
            meeting.segments[before].speaker = judged.speaker
            // Noted on the meeting as well: a reopened record must still know this voice
            // existed, even when a later cue's label could not be produced.
            noteSpeakerLabel(meeting, judged.speaker)
            // Which model produced these labels, so a later "why do the labels look like
            // this?" has an answer. Recorded once, on the first labelled cue.
            if (meeting.speakerModel === undefined || meeting.speakerModel === '') {
              meeting.speakerModel = speakerState.modelId
            }
          }
          // The embedding is kept for the end-of-meeting pass, which merges voices the online
          // gallery could not; it never leaves this process.
          if (judged.embedding !== '') meeting.segments[before].embedding = judged.embedding
          // Fast speech puts several sentences in one cue. Split it at the recognizer's
          // punctuation (or its own cloud segments) before merging, so a line is a
          // sentence, not ten seconds of speech.
          const transcriptSettings = await readTranscriptSettings().catch(() => null)
          const pieces = splitCueIntoSentences(meeting, before, {
            maxChars: transcriptSettings?.maxLineChars ?? 60,
            hints: cloudHints,
            normalizeRules: transcriptSettings?.normalize === true ? transcriptSettings.normalizeRules : null,
          })
          if (pieces <= 1) {
            // A sentence cut by the endpointing pause is folded back into one readable
            // line once the speaker is known (text-only; times still span the audio).
            mergeContinuation(meeting, before)
          }
        }
        sendJson(res, 200, {
          text,
          cloud,
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          speaker: {
            phase: speakerState.phase,
            message: speakerState.message,
            completedBytes: typeof speakerState.completedBytes === 'number' ? speakerState.completedBytes : 0,
            totalBytes: typeof speakerState.totalBytes === 'number' ? speakerState.totalBytes : SPEAKER_MODEL.bytes,
          },
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
          kind: meeting.kind ?? '',
          period: meeting.period ?? '',
          title: meeting.title ?? '',
          summary: meeting.summary ?? '',
          scores: meeting.scores ?? [],
          speakers: meeting.speakers,
          people: meeting.people ?? [],
          documents: meeting.documents ?? [],
          labels: speakerLabels(meeting),
          // "This sounds like 张三" — offered, never written. The panel shows it and a person
          // decides; that rule is why keeping a voice library is acceptable at all.
          suggestions: await suggestNames(meeting).catch(() => []),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      if (method === 'POST' && route === '/kind') {
        // The meeting's type and name. The period is derived, never typed in: it is what
        // lets a later meeting find this one ("today's briefing", "this week").
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.kind === 'string' && MEETING_KINDS.includes(body.kind)) meeting.kind = body.kind
        if (typeof body.title === 'string') meeting.title = body.title.trim()
        meeting.period = periodOf(meeting.kind ?? '', meeting.startedAt)
        sendJson(res, 200, { kind: meeting.kind ?? '', period: meeting.period, title: meeting.title ?? '' })
        return
      }

      if (method === 'POST' && route === '/scores') {
        // The monthly review's table. The agent drafts rows through meeting_write; a human
        // edits, confirms and exports them here (FEATURES §2.4, §3.4, §5.1).
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (!Array.isArray(meeting.scores)) meeting.scores = []
        const person = typeof body.person === 'string' ? body.person.trim() : ''

        if (body.op === 'add') {
          if (person === '') {
            sendJson(res, 400, { error: 'a score row needs a person' })
            return
          }
          if (!meeting.scores.some((row) => row.person === person)) {
            meeting.scores.push({
              person, hours: 0, completion: 0, quality: 0, learn: 0, highlight: '', improve: '', basis: [], total: 0, status: 'draft',
            })
          }
          sendJson(res, 200, { scores: meeting.scores })
          return
        }

        if (body.op === 'prefill') {
          // Completion comes from the tasks recorded inside the monthly period; a human
          // still owns quality and learning, and a confirmed row is never overwritten.
          const range = monthRangeOf(meeting.period ?? '')
          const stats = range === undefined ? [] : ownerTaskStats(range.from, range.to)
          for (const stat of stats) {
            const existing = meeting.scores.find((row) => row.person === stat.person)
            if (existing === undefined) {
              const row = {
                person: stat.person, hours: 0, completion: stat.completion, quality: 0, learn: 0,
                highlight: '', improve: '', basis: [], status: 'draft', total: 0,
              }
              row.total = scoreTotal(row)
              meeting.scores.push(row)
            } else if (existing.status !== 'confirmed') {
              existing.completion = stat.completion
              if (existing.totalOverride !== true) existing.total = scoreTotal(existing)
            }
          }
          sendJson(res, 200, { scores: meeting.scores, filled: stats.length })
          return
        }

        const index = meeting.scores.findIndex((row) => row.person === person)
        if (index < 0) {
          sendJson(res, 404, { error: 'unknown person' })
          return
        }
        if (body.op === 'remove') {
          meeting.scores.splice(index, 1)
          sendJson(res, 200, { scores: meeting.scores })
          return
        }
        const row = meeting.scores[index]
        const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
        // Evidence is part of the row, not decoration: a human may edit it here (the agent
        // supplies it when drafting), and a row without any cannot be confirmed (§2.4).
        const nextBasis = Array.isArray(patch.basis)
          ? patch.basis.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
          : (row.basis ?? [])
        if (patch.status === 'confirmed' && nextBasis.length === 0) {
          sendJson(res, 400, { error: '这条评分还没有依据：请先填一条实录原文或任务 id，再确认' })
          return
        }
        if (Array.isArray(patch.basis)) row.basis = nextBasis
        // Only a human may confirm; the agent's drafts always arrive as drafts.
        if (patch.status === 'draft' || patch.status === 'confirmed') row.status = patch.status
        for (const [field, max] of [['hours', 10000], ['completion', 100], ['quality', 10], ['learn', 10]]) {
          const value = Number(patch[field])
          if (Number.isFinite(value)) row[field] = Math.min(Math.max(value, 0), max)
        }
        if (typeof patch.highlight === 'string') row.highlight = patch.highlight.trim()
        if (typeof patch.improve === 'string') row.improve = patch.improve.trim()
        // The weighted total is a default a person may override; clearing the field goes
        // back to the computed value (§2.4).
        if (patch.total === null || patch.total === '') {
          delete row.totalOverride
        } else if (Number.isFinite(Number(patch.total))) {
          row.total = Math.min(Math.max(Math.round(Number(patch.total)), 0), 100)
          row.totalOverride = true
        }
        if (row.totalOverride !== true) row.total = scoreTotal(row)
        sendJson(res, 200, { scores: meeting.scores })
        return
      }

      if (method === 'POST' && route === '/scores/export') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if ((meeting.scores ?? []).length === 0) {
          sendJson(res, 400, { error: 'this meeting has no scores yet' })
          return
        }
        const stamp = stampOf(meeting.startedAt)
        if (body.format === 'xlsx') {
          const name = await writeScoresXlsx(ctx, meeting, `${stamp}-scores.xlsx`)
          sendJson(res, 200, { name })
          return
        }
        const name = `${stamp}-scores.csv`
        const content = scoresCsv(meeting)
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, name), content, 'utf8')
        sendJson(res, 200, { name, content })
        return
      }

      // A start-recording request from the agent. The microphone is the browser's, so this is a
// hand-off, not a capture: the panel polls it and runs its own start(), which keeps the
// permission prompt, the model preparation and the error messages in one place.
      if (method === 'GET' && route === '/record') {
        const meeting = meetingForSession(url.searchParams.get('sessionId') ?? '', url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, {
          meetingId: meeting.id,
          request: typeof meeting.recordRequestedAt === 'number' ? meeting.recordRequestedAt : 0,
          recording: meeting.audioHandle !== undefined,
        })
        return
      }

      if (method === 'POST' && route === '/record') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetingForSession(
          typeof body.sessionId === 'string' ? body.sessionId : '',
          typeof body.meetingId === 'string' ? body.meetingId : '',
        )
        if (meeting !== undefined) delete meeting.recordRequestedAt
        sendJson(res, 200, { cleared: meeting !== undefined })
        return
      }

      if (method === 'GET' && route === '/series') {
        // The panel's series navigation: the same kind's previous and next meeting, so a
        // briefing can step back through the week without searching (FEATURES §5.1).
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, seriesFor(meeting))
        return
      }

      if (method === 'GET' && route === '/carryover') {
        // What the previous day's review left open: the briefing's reminder (§3.1).
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, carryOverFor(meeting))
        return
      }

      if (method === 'GET' && route === '/history') {
        // The panel's meeting picker (FEATURES §5.4): every meeting on this machine, newest
        // first, filterable by name, date, type, points, assignments and transcript text.
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
        const asked = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 200) : 50
        // Paging: the picker scrolls and asks for the next slice instead of loading everything.
        const askedOffset = Number(url.searchParams.get('offset') ?? 0)
        const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? Math.floor(askedOffset) : 0
        const rows = []
        for (const meeting of meetings.values()) {
          // Only meetings that actually hold something belong in the history: every live
          // conversation owns an eager (often still empty) meeting, and listing those would
          // bury the real records (DESIGN §4).
          if (meetingIsEmpty(meeting)) continue
          const points = meeting.points ?? []
          const tasks = meeting.tasks ?? []
          const segments = meeting.segments ?? []
          const when = new Date(meeting.startedAt).toLocaleDateString()
          const haystack = [
            meeting.title ?? '',
            kindText(meeting.kind ?? ''),
            meeting.period ?? '',
            when,
            ...points.slice(0, 20).map((point) => point.text ?? ''),
            ...tasks.slice(0, 20).map((task) => task.title ?? ''),
            ...segments.slice(0, 100).map((segment) => seenText(segment)),
          ].join('\n').toLowerCase()
          if (query !== '' && !haystack.includes(query)) continue
          rows.push({
            meetingId: meeting.id,
            sessionId: meeting.sessionId ?? '',
            title: meeting.title ?? '',
            kind: meeting.kind ?? '',
            period: meeting.period ?? '',
            startedAt: meeting.startedAt,
            excerpt: points.length > 0 ? points[0].text ?? '' : (segments.length > 0 ? seenText(segments[0]) : ''),
            counts: {
              segments: segments.length,
              points: points.length,
              tasks: tasks.length,
              // The management page reports how much of the work is checked off (§5.2).
              done: tasks.filter((task) => task.done === true).length,
              notes: (meeting.notes ?? []).length,
              documents: (meeting.documents ?? []).length,
              scores: (meeting.scores ?? []).length,
            },
            // The switch guard only interrupts for a meeting that actually holds something.
            hasContent: !meetingIsEmpty(meeting),
          })
        }
        rows.sort((left, right) => right.startedAt - left.startedAt)
        sendJson(res, 200, { meetings: rows.slice(offset, offset + limit), total: rows.length, offset, limit })
        return
      }

      if (method === 'POST' && route === '/flush') {
        // The picker's "auto-save": the periodic flush covers it within seconds, but the
        // panel must be able to say "saved" honestly before it switches away.
        const result = await flushMeetings(ctx)
        // "Saved" has to mean saved: a failed write is reported, not hidden, because the
        // panel switches away on this answer (§5.4).
        sendJson(res, result.failed.length === 0 ? 200 : 500, {
          saved: result.failed.length === 0,
          written: result.written,
          failed: result.failed,
        })
        return
      }

      if (method === 'GET' && route === '/transcript') {
        // How the transcript is written back, and where the browser half cuts a cue. The panel
        // needs the cue limits with its own state, so they travel here instead of being
        // duplicated as constants on both sides.
        sendJson(res, 200, {
          transcript: await readTranscriptSettings(),
          rules: DEFAULT_RULES,
          local: await localAsrAvailable(ctx),
        })
        return
      }

      if (method === 'POST' && route === '/transcript') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        sendJson(res, 200, { transcript: await writeTranscriptSettings(body) })
        return
      }

      if (method === 'GET' && route === '/speaker/settings') {
        // The clustering threshold and the end-of-meeting pass: what this installation does,
        // not what one meeting is.
        sendJson(res, 200, {
          speaker: await readSpeakerSettings(),
          presets: SPEAKER_THRESHOLD_PRESETS,
          model: speakerState.modelId,
          library: await voiceSummary(),
          libraryFile: voicesFile(),
        })
        return
      }

      if (method === 'POST' && route === '/speaker/settings') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const { speaker, thresholdChanged } = await writeSpeakerSettings(body)
        // The threshold is handed to the worker when it starts, so a change has to retire the
        // running one. Saying that it restarted beats pretending the new value is in force.
        let restarted = false
        if (thresholdChanged && speakerState.phase !== 'unprepared') {
          restarted = retireSpeakerWorker()
          speakerState.phase = 'unprepared'
          speakerState.message = ''
        }
        sendJson(res, 200, { speaker, restarted })
        return
      }

      if (method === 'GET' && route === '/voices') {
        // Names and evidence only: a vector never travels over the plugin's HTTP surface.
        sendJson(res, 200, { voices: await voiceSummary(), file: voicesFile() })
        return
      }

      if (method === 'POST' && route === '/voices/remove') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const removed = await removeVoice(typeof body.name === 'string' ? body.name.trim() : '')
        sendJson(res, removed ? 200 : 404, removed ? { removed: true, voices: await voiceSummary() } : { error: 'unknown voice' })
        return
      }

      if (method === 'POST' && route === '/voices/clear') {
        sendJson(res, 200, { removed: await clearVoices(), voices: [] })
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
        // The label is noted independently of the name, so clearing a name never erases the
        // fact that this voice was identified.
        noteSpeakerLabel(meeting, label)
        // An empty name clears the assignment and the label shows again.
        if (name === '') delete meeting.speakers[label]
        else meeting.speakers[label] = name
        // Naming a speaker is the human confirmation the voice library waits for: only here is
        // a voice profile written, and it is derived from this meeting's own cues.
        const learned = name === '' ? null : await learnFromMeeting(meeting, label, name).catch(() => null)
        sendJson(res, 200, { speakers: meeting.speakers, segments: publicSegments(meeting), learned })
        return
      }

      if (method === 'POST' && route === '/relabel') {
        // Re-identify a meeting from its recording: the online pass can miss cues (the
        // model was still downloading, or the worker died mid-meeting), and this is the
        // panel's way to redo the whole meeting — including ones recorded earlier.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (meeting.audioName === undefined && typeof meeting.audioPath !== 'string') {
          sendJson(res, 400, { error: 'this meeting has no recording' })
          return
        }
        // A manual re-run must work even when the worker died or was never prepared.
        if (speakerState.phase !== 'ready') await prepareSpeakers(ctx)
        if (speakerState.phase !== 'ready') {
          sendJson(res, 409, { error: speakerState.message === '' ? 'speaker support is unavailable' : speakerState.message })
          return
        }
        const judged = await relabelFromRecording(ctx, meeting, { all: true })
        // The repass re-clusters every cue by its embedding, so labels and any assigned
        // names settle consistently; the vectors themselves are not needed afterwards.
        const voices = relabelSpeakers(meeting)
        for (const segment of meeting.segments) delete segment.embedding
        sendJson(res, 200, {
          judged,
          voices,
          segments: publicSegments(meeting),
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
        })
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
          // The score weights, as fractions; the panel shows them as percentages (§2.4).
          scoreWeights: settings.scoreWeights,
          // Custom distillation wording per type; an empty entry uses the built-in text.
          templates: settings.templates ?? {},
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
        // Score weights arrive as percentages, because that is what a person types; they are
        // stored normalised, so the three always add up (§2.4, P4). A set that does not add
        // up to 100% is refused with the reason rather than silently reweighted.
        if (body.scoreWeights !== null && typeof body.scoreWeights === 'object') {
          const values = SCORE_WEIGHT_KEYS.map((key) => Number(body.scoreWeights[key]))
          const sum = values.reduce((total, value) => total + value, 0)
          if (!values.every((value) => Number.isFinite(value) && value >= 0) || Math.abs(sum - 100) > 0.5) {
            sendJson(res, 400, { error: '评分权重三项必须是非负数，且加起来为 100%' })
            return
          }
          next.scoreWeights = setScoreWeights(Object.fromEntries(SCORE_WEIGHT_KEYS.map((key, index) => [key, values[index] / 100])))
        }
        // Custom distill wording: only the four known types, trimmed, bounded. An empty string
    // restores the built-in text instead of storing an unusable template.
    if (body.templates !== null && typeof body.templates === 'object') {
      const kept = {}
      for (const kind of ['briefing', 'review', 'weekly', 'monthly']) {
        if (typeof body.templates[kind] === 'string') kept[kind] = body.templates[kind].slice(0, 4000)
      }
      next.templates = kept
    }
    const directory = dirname(webhookFile())
        await mkdir(directory, { recursive: true })
        await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
        sendJson(res, 200, {
          mode: next.mode,
          configured: WEBHOOK_KINDS.filter((kind) => next[kind] !== ''),
          scoreWeights: { ...scoreWeights },
          templates: next.templates ?? {},
        })
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
        // `taskId` narrows the send to one assignment; absent, every confirmed one goes.
        const only = typeof body.taskId === 'string' ? body.taskId : ''
        if (only !== '' && !(meeting.tasks ?? []).some((task) => task.id === only)) {
          sendJson(res, 400, { error: 'unknown task' })
          return
        }
        const outcome = await pushTasks(meeting, asked.length === 0 ? WEBHOOK_KINDS : asked, only)
        sendJson(res, outcome.error === '' ? 200 : 400, outcome)
        return
      }

      if (method === 'GET' && route === '/cloud') {
        // Consent, configured hosts, whether a key is set — never the key itself.
        sendJson(res, 200, await cloudSummary())
        return
      }

      if (method === 'POST' && route === '/cloud') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const stored = await writeCloudSettings(body)
        sendJson(res, 200, await cloudSummary())
        // The write is reported through the summary, which cannot echo a key back.
        void stored
        return
      }

      if (method === 'POST' && route === '/cloud/test') {
        sendJson(res, 200, await testCloud())
        return
      }

      if (method === 'GET' && route === '/models') {
        // The catalog, what is on disk, which one each capability runs, and how a download in
        // flight is going — one answer, because the page shows all of it together.
        sendJson(res, 200, await modelState())
        return
      }

      if (method === 'POST' && route === '/models/install') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await installModel(typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/models/import') {
        // The bytes ARE the body: a model file can be large, and JSON would only inflate it.
        const id = url.searchParams.get('id') ?? ''
        const name = url.searchParams.get('name') ?? ''
        try {
          const bytes = await readBody(req, IMPORT_BODY_BYTES)
          const outcome = await importModel(id, name, bytes)
          sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        } catch (failure) {
          sendJson(res, 400, { error: failure instanceof Error ? failure.message : String(failure) })
        }
        return
      }

      if (method === 'POST' && route === '/models/activate') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await activateModel(typeof body.kind === 'string' ? body.kind : '', typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/models/remove') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await removeModel(typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'GET' && route === '/version') {
        // What is actually installed, read from the plugin's own package.json, so the About
        // dialog can never drift from the release it belongs to.
        try {
          const info = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
          sendJson(res, 200, {
            name: typeof info.name === 'string' ? info.name : 'dsh-meeting-room',
            version: typeof info.version === 'string' ? info.version : '0.0.0',
            author: typeof info.author === 'string' ? info.author : '',
          })
        } catch (failure) {
          sendJson(res, 200, { name: 'dsh-meeting-room', version: '0.0.0', author: '', error: String(failure) })
        }
        return
      }

      if (method === 'GET' && route === '/package') {
        // One meeting as a portable archive: the record, its recording and its artifacts.
        // Served as an attachment, so the browser asks the person where to put it.
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const bytes = await packageMeeting(meeting)
        const title = (meeting.title === undefined || meeting.title === '' ? meeting.id : meeting.title)
          .replace(/[\\/:*?"<>|]/gu, '_')
        const name = `${title}-${stampOf(meeting.startedAt)}.zip`
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': bytes.length,
          'Content-Disposition': `attachment; filename="meeting.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        res.end(bytes)
        return
      }

      if (method === 'POST' && route === '/import') {
        // The reverse: read a package back as a meeting of this machine. The body is the
        // archive itself, with a ceiling a recording can actually reach.
        try {
          const bytes = await readBody(req, IMPORT_BODY_BYTES)
          const imported = await importPackage(bytes)
          await flushMeetings(ctx)
          sendJson(res, 200, imported)
        } catch (failure) {
          sendJson(res, 400, { error: failure instanceof Error ? failure.message : String(failure) })
        }
        return
      }

      if (method === 'POST' && route === '/role') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        // The three common seats are offered as buttons, but a person may describe their own
        // seat in a few words, so the value is text — bounded, and never empty.
        const nextRole = typeof body.role === 'string' ? body.role.trim() : ''
        if (nextRole === '' || nextRole.length > 24) {
          sendJson(res, 400, { error: 'role must be 1-24 characters of text' })
          return
        }
        meeting.role = nextRole
        sendJson(res, 200, { role: meeting.role })
        return
      }

      if (method === 'POST' && route === '/summary') {
        // The meeting's short summary: typed in the start dialog, or polished there by the
        // model and written back. It is what a reader sees before the transcript.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.summary !== 'string') {
          sendJson(res, 400, { error: 'summary must be text' })
          return
        }
        meeting.summary = body.summary.trim()
        sendJson(res, 200, { summary: meeting.summary })
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
        const meeting = findMeeting(meetings, url.searchParams.get('sessionId') ?? '', '')
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
            kind: meeting.kind ?? '',
            period: meeting.period ?? '',
            title: meeting.title ?? '',
            scores: meeting.scores ?? [],
            speakers: meeting.speakers,
            labels: speakerLabels(meeting),
            // Offered, never written — the same rule as /state.
            suggestions: await suggestNames(meeting).catch(() => []),
            // The rest of what the panel renders, so a reload restores it from one answer.
            role: meeting.role ?? '',
            documents: meeting.documents ?? [],
            terms: meeting.terms ?? '',
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
          // A human writing an entry by hand (or turning a written note into an
          // assignment); it still lands as a draft, like everything the extractors write.
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') {
            sendJson(res, 400, { error: body.kind === 'point' ? 'a new point needs text' : 'a new task needs text' })
            return
          }
          const origin = body.origin === 'ink' ? 'ink' : 'manual'
          if (body.kind === 'point') {
            meeting.points.push({
              id: `p${meeting.points.length + 1}`,
              kind: POINT_KINDS.includes(body.pointKind) ? body.pointKind : 'point',
              text,
              status: 'draft',
              origin,
            })
          } else {
            meeting.tasks.push({
              id: `t${meeting.tasks.length + 1}`,
              title: text,
              owner: '',
              due: '',
              priority: 'normal',
              source: '',
              status: 'draft',
              origin,
            })
          }
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
        // One end-of-recording path for every stop entry: the panel button, the
        // session leaving the store, and a forced archive all land here.
        const voices = await finalizeRecording(ctx, meeting)
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

      if (method === 'GET' && route === '/download') {
        // Hand a produced artifact to the browser as a download, so the person gets the
        // usual save dialog instead of a file written somewhere they have to go looking for.
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
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) {
          sendJson(res, 400, { error: 'file is missing or too large' })
          return
        }
        const bytes = await readFile(path)
        res.writeHead(200, {
          'Content-Type': contentTypeOf(name),
          'Content-Length': bytes.length,
          // The name is percent-encoded for the header, and the plain name is kept too so
          // older clients still see a sensible file name.
          'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/gu, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        res.end(bytes)
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
          completedBytes: typeof speakerState.completedBytes === 'number' ? speakerState.completedBytes : 0,
          totalBytes: typeof speakerState.totalBytes === 'number' ? speakerState.totalBytes : SPEAKER_MODEL.bytes,
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

      if (method === 'GET' && route === '/speech') {
        // Report whether the transcription provider can record right now, so the
        // browser half can warn on panel load instead of the first failed cue.
        sendJson(res, 200, readSpeechState(ctx))
        return
      }

      if (method === 'POST' && route === '/speech/prepare') {
        // Download (or resume) the SenseVoice model directly; the browser half polls
        // /speech to show progress. When the voice-input bundle is disabled this also
        // enables it first, so the one click installs and downloads.
        const state = await prepareSpeech(ctx)
        sendJson(res, 200, state)
        return
      }

      if (method === 'GET' && route === '/prepare') {
        sendJson(res, 200, {
          speaker: { phase: speakerState.phase, message: speakerState.message },
          handwriting: { phase: handwritingState.phase, message: handwritingState.message },
        })
        return
      }

      if (method === 'POST' && route === '/prepare') {
        // Pre-download the speaker and handwriting models in one action.
        if (speakerState.phase !== 'downloading' && speakerState.phase !== 'ready') {
          void prepareSpeakers(ctx).catch(() => undefined)
        }
        if (handwritingState.phase !== 'downloading' && handwritingState.phase !== 'ready') {
          void prepareHandwriting(ctx).catch(() => undefined)
        }
        sendJson(res, 200, {
          speaker: { phase: speakerState.phase, message: speakerState.message },
          handwriting: { phase: handwritingState.phase, message: handwritingState.message },
        })
        return
      }

      sendJson(res, 404, { error: `no such route: ${method} ${url.pathname}` })
    } catch (error) {
      ctx.logger.warn('meeting-room: request failed: %s', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    }
  }

  return handler
}
