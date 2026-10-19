/**
 * Session ↔ meeting coordination: one meeting per user conversation.
 *
 * 设计（详见 DESIGN.md）：
 *   - 会话与会话 1:1：每个「用户级会话」在 session/created 时就拥有自己的会议记录；
 *     录音、要点、任务、笔记、文档全部写进同一记录。
 *   - 代理会话不建会议：origin === 'subagent' 或 delegationDepth > 0 的会话（子代理、
 *     团队成员）属于调用方的对话，它们的工具执行沿 parentSession 回溯到拥有会议的
 *     祖先（根对话）。
 *   - 会话销毁时回收：空且从未落盘的会议随会话一起消失；有内容的会议已经是历史
 *     记录，继续保留并可由「会议管理」打开。
 */
import { meetings, newMeetingId } from './host-constants.js'
import { meetingIsEmpty, persisted } from './host-persistence.js'
import { findMeeting } from './host-helpers.js'

/**
 * The live session store (`ctx.sessions`), captured during activation so tool
 * executions without a host context can still walk session lineage.
 */
let sessionStore = null

/** @param value - the live session store, or null when the composition has none. */
export function setSessionStore(value) {
  sessionStore = value
}

/**
 * Build a fresh meeting record for one session.
 * @param sessionId - owning session id.
 * @param startedAt - creation timestamp; the session's own birth when known.
 * @returns the new meeting.
 */
export function newMeeting(sessionId, startedAt) {
  const id = newMeetingId()
  return {
    id,
    startedAt,
    seconds: 0,
    segments: [],
    points: [],
    tasks: [],
    notes: [],
    revisions: [],
    speakers: {},
    // Voice labels this meeting has produced, kept even when a cue cannot carry its own label,
    // so a reopened meeting still lists the speakers it identified.
    speakerLabels: [],
    people: [],
    documents: [],
    sessionId,
    terms: '',
    role: '',
    // Meeting metadata (FEATURES §2.1): kind and period drive the templates and the
    // cross-meeting queries; an eager meeting starts as a general, unnamed one.
    kind: '',
    period: '',
    title: '',
    // A short summary of what the meeting is about, written by hand or polished by the
    // model from the start dialog (FEATURES §2.1).
    summary: '',
    // Monthly reviews score people; every other meeting simply carries an empty table.
    scores: [],
    controller: new AbortController(),
  }
}

/**
 * Whether this session deserves a meeting of its own. Delegated sessions (subagents,
 * team members) share their root conversation's meeting; a fork is a user-level
 * conversation and gets its own.
 * @param session - live session; may be undefined.
 * @returns false for delegated sessions only.
 */
export function ownsMeeting(session) {
  const header = session?.header ?? null
  if (header?.origin === 'subagent') return false
  const depth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0
  return depth === 0
}

/**
 * Make sure the session has a meeting, creating it when none exists yet. Idempotent:
 * a session keeps at most one meeting no matter how often this runs.
 * @param ctx - Host context, used for logging.
 * @param session - live session.
 * @returns the owned meeting, or undefined for delegated or invalid sessions.
 */
export function ensureMeetingForSession(ctx, session) {
  // The sessions service can register after this plugin activates; resolving it lazily
  // keeps the subagent lineage walk working instead of silently reading a null store.
  if (sessionStore === null && typeof ctx?.get === 'function') {
    const live = ctx.get('sessions')
    if (live !== null && live !== undefined) sessionStore = live
  }
  const sessionId = typeof session?.id === 'string' ? session.id : ''
  if (sessionId === '') return undefined
  if (!ownsMeeting(session)) return undefined
  const existing = findMeeting(meetings, sessionId, '')
  if (existing !== undefined) return existing
  const startedAt = typeof session.header?.createdAt === 'number' ? session.header.createdAt : Date.now()
  const meeting = newMeeting(sessionId, startedAt)
  meetings.set(meeting.id, meeting)
  ctx?.logger?.info('dsh-meeting-room: meeting %s created for session %s', meeting.id, sessionId)
  return meeting
}

/**
 * Drop the session's meeting when the session dies — but only when it is still empty
 * and was never persisted. A meeting with content is a historical record and stays.
 * @param sessionId - disposed session id.
 */
export function reapMeetingForSession(sessionId) {
  for (const meeting of [...meetings.values()]) {
    if (meeting.sessionId !== sessionId) continue
    if (!meetingIsEmpty(meeting)) continue
    if (persisted.has(meeting.id)) continue
    meetings.delete(meeting.id)
  }
}

/**
 * The live meeting currently recording on behalf of a session, when one exists.
 * A recording is in progress while its WAV writer handle is open; the stop path
 * (finalizeRecording) closes it. The session↔meeting invariant keeps this a
 * single candidate.
 * @param sessionId - owning session id.
 * @returns the recording meeting, or undefined when the session is not recording.
 */
export function recordingMeetingForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  for (const meeting of meetings.values()) {
    if (meeting.sessionId !== sessionId) continue
    if (meeting.audioHandle !== undefined) return meeting
  }
  return undefined
}

/**
 * Resolve the meeting a tool execution refers to. An explicit meeting id wins; otherwise
 * the calling session's own meeting is used, and when that session is a delegated one
 * (subagent, team member) the lookup walks the live `parentSession` lineage up to the
 * conversation root that owns the meeting.
 * @param sessionId - calling session id (exec.agent.session.id).
 * @param meetingId - explicit meeting id, when given.
 * @returns the meeting, or undefined when nothing matches.
 */
export function meetingForSession(sessionId, meetingId = '') {
  if (meetingId !== '') return meetings.get(meetingId)
  let current = typeof sessionId === 'string' ? sessionId : ''
  const visited = new Set()
  while (current !== '' && !visited.has(current)) {
    visited.add(current)
    const found = findMeeting(meetings, current, '')
    if (found !== undefined) return found
    const session = typeof sessionStore?.get === 'function' ? sessionStore.get(current) : undefined
    const parent = session?.header?.parentSession
    current = typeof parent === 'string' && parent !== '' ? parent : ''
  }
  return undefined
}