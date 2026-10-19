/**
 * Business logic functions for the meeting-room host plugin.
 *
 * Extracted from index.js: transcription, text correction, analysis extraction,
 * minutes/document rendering, speaker relabeling, push/webhook/DingTalk integration,
 * and tool implementations.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

import {
  meetings,
  ROLES,
  ROLE_LABELS,
  SPEAKER_MERGE_THRESHOLD,
  SPEAKER_BACKFILL_CAP,
  KIND_PERIOD_UNITS,
  MEETING_KINDS,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  SCORE_WEIGHTS,
  scoreWeights,
  setScoreWeights,
  SCORE_WEIGHT_KEYS,
  WEBHOOK_KINDS,
  PUSH_MODES,
  DOCUMENT_KINDS,
  DIRECTORY_DEPARTMENT_LIMIT,
  DIRECTORY_PERSON_LIMIT,
  PACKAGE_DIR,
  DEFAULT_CUE_LIMIT,
  MAX_CUE_LIMIT,
  SAMPLE_RATE,
  PREFIX,
  pinyinSyllables,
  pinyinAttempted,
  setPinyinState,
  seenText,
  ACTION_VERBS,
  DUE_PATTERNS,
  HIGH_PRIORITY,
  LOW_PRIORITY,
  OWNER_PATTERNS,
  DECISION_MARKERS,
  RISK_MARKERS,
  QUESTION_MARKERS,
  POINT_KINDS,
  TASK_PRIORITIES,
  relabelPlanOf,
} from './host-constants.js'

import {
  sendJson,
  readBody,
  stampOf,
  exportDirectory,
  clockOf,
  findMeeting,
  pythonExecutable,
  wavFromPcm,
  wavHeader,
} from './host-helpers.js'

import { flushMeetings } from './host-persistence.js'

import { meetingForSession } from './host-sessions.js'

import { relabelFromRecording, knownSpeakerLabels } from './host-speaker.js'
import { centroidsOf } from './host-voices.js'
import { normalizeText } from './host-text.js'
import { readTranscriptSettings } from './host-transcript.js'

// Re-export regex constants and seenText so consumers can import from this module.
export {
  ACTION_VERBS,
  DUE_PATTERNS,
  HIGH_PRIORITY,
  LOW_PRIORITY,
  OWNER_PATTERNS,
  DECISION_MARKERS,
  RISK_MARKERS,
  QUESTION_MARKERS,
  seenText,
}

// ---------------------------------------------------------------------------
// Meeting metadata
// ---------------------------------------------------------------------------

/**
 * ISO-8601 week label ('YYYY-Www', Monday-based) for a local date.
 * @param date - local date.
 * @returns the week label.
 */
function isoWeekOf(date) {
  // The Thursday of the same week belongs to the ISO year the week is numbered in.
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayIndex = (thursday.getDay() + 6) % 7
  thursday.setDate(thursday.getDate() - dayIndex + 3)
  const isoYear = thursday.getFullYear()
  const firstThursday = new Date(isoYear, 0, 4)
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/**
 * Derive a meeting's period bucket from its kind and start time, in local time. The
 * bucket is what lets later meetings find earlier ones ("today's briefing", "this
 * week's meetings") without any manual filing.
 * @param kind - meeting kind; '' (general) has no period.
 * @param startedAt - meeting start timestamp.
 * @returns 'YYYY-MM-DD', 'YYYY-Www', 'YYYY-MM', or '' for the general meeting.
 */
export function periodOf(kind, startedAt) {
  const unit = KIND_PERIOD_UNITS[kind]
  if (unit === undefined) return ''
  const date = new Date(typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : Date.now())
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  if (unit === 'month') return `${year}-${month}`
  if (unit === 'week') return isoWeekOf(date)
  return `${year}-${month}-${String(date.getDate()).padStart(2, '0')}`
}

/** Chinese label per kind, used in the reading text the model gets. */
const KIND_TEXT = { '': '通用', briefing: '晨会', review: '复盘会', weekly: '例会', monthly: '总结会' }

/**
 * The label for one kind, for text a person reads or the picker searches.
 * @param kind - meeting kind.
 * @returns the label; an unknown kind reads as 通用.
 */
export function kindText(kind) {
  return KIND_TEXT[kind] ?? '通用'
}

/**
 * Local timestamp of an ISO date, or undefined when the text is not one.
 * @param value - 'YYYY-MM-DD'.
 * @param endOfDay - true for the last millisecond of that local day.
 * @returns the timestamp, or undefined.
 */
function localDayOf(value, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(typeof value === 'string' ? value.trim() : '')
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = endOfDay ? new Date(year, month, day, 23, 59, 59, 999) : new Date(year, month, day)
  if (Number.isNaN(date.getTime())) return undefined
  // 2026-13-40 otherwise rolls over into 2027-02-09 and silently searches the wrong range.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return undefined
  return date.getTime()
}

/**
 * The local time span a period bucket covers. A WEEK bucket must match the daily meetings
 * inside that week, and a MONTH bucket every meeting in that month: the buckets are derived
 * per kind, so comparing strings would only ever find the weekly/monthly meeting itself.
 * @param period - a day (YYYY-MM-DD), ISO week (YYYY-Www) or month (YYYY-MM) bucket.
 * @returns inclusive millisecond bounds, or undefined for an unrecognised bucket.
 */
export function periodRange(period) {
  const text = typeof period === 'string' ? period.trim() : ''
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text)
  if (day !== null) {
    const from = localDayOf(text)
    const to = localDayOf(text, true)
    return from === undefined || to === undefined ? undefined : { from, to }
  }
  const week = /^(\d{4})-W(\d{2})$/u.exec(text)
  if (week !== null) {
    const year = Number(week[1])
    const number = Number(week[2])
    if (number < 1 || number > 53) return undefined
    // ISO week 1 is the week containing January 4th; its Monday is the anchor.
    const january4 = new Date(year, 0, 4)
    const monday = new Date(year, 0, 4 - ((january4.getDay() + 6) % 7) + (number - 1) * 7)
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999)
    return { from: monday.getTime(), to: sunday.getTime() }
  }
  const month = /^(\d{4})-(\d{2})$/u.exec(text)
  if (month !== null) {
    const year = Number(month[1])
    const index = Number(month[2]) - 1
    if (index < 0 || index > 11) return undefined
    return { from: new Date(year, index, 1).getTime(), to: new Date(year, index + 1, 0, 23, 59, 59, 999).getTime() }
  }
  return undefined
}

/**
 * Resolve a period argument: an exact bucket, or one of the aliases that keep the model
 * from doing calendar arithmetic ('today', 'yesterday', 'this-week', 'this-month').
 * @param value - the argument as given.
 * @returns a period bucket, or '' when nothing was asked.
 */
export function resolvePeriod(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text === 'today' || text === '今天' || text === '昨天' || text === 'yesterday') {
    const yesterday = text === '昨天' || text === 'yesterday'
    return periodOf('briefing', yesterday ? Date.now() - 24 * 3600 * 1000 : Date.now())
  }
  if (text === 'this-week' || text === 'thisweek' || text === '本周') return periodOf('weekly', Date.now())
  if (text === 'this-month' || text === 'thismonth' || text === '本月') return periodOf('monthly', Date.now())
  return text
}

/**
 * Answer a cross-meeting read-only query: which meetings match, what they hold, and how
 * their work stands. Every hit carries its meeting id, so the model can address a write
 * back to it — a review meeting checking off the tasks a briefing assigned, for instance.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @returns the readable report.
 */
export function queryMeetings(args) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const askedKind = typeof request.kind === 'string' ? request.kind.trim() : ''
  const kind = askedKind !== '' && MEETING_KINDS.includes(askedKind) ? askedKind : ''
  const period = resolvePeriod(request.period)
  const from = localDayOf(request.from)
  const to = localDayOf(request.to, true)
  if (typeof request.from === 'string' && request.from.trim() !== '' && from === undefined) {
    return `from 不是合法日期：${request.from}。请写成 YYYY-MM-DD。`
  }
  if (typeof request.to === 'string' && request.to.trim() !== '' && to === undefined) {
    return `to 不是合法日期：${request.to}。请写成 YYYY-MM-DD。`
  }
  if (period !== '' && (from !== undefined || to !== undefined)) {
    return 'period 与 from/to 互斥：给周期就不要再给日期范围，二者选一个。'
  }
  const range = period === '' ? undefined : periodRange(period)
  const person = typeof request.person === 'string' ? request.person.trim() : ''
  const include = new Set((Array.isArray(request.include) ? request.include : []).filter((entry) => typeof entry === 'string'))
  const wanted = Number(request.limit)
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT

  const matches = []
  for (const meeting of meetings.values()) {
    if (kind !== '' && (meeting.kind ?? '') !== kind) continue
    // A recognised bucket matches by its time span, so "this-week" finds every briefing and
// review inside the week as well as the weekly meeting (§3.3, §4.1).
    if (period !== '' && range !== undefined) {
      if (meeting.startedAt < range.from || meeting.startedAt > range.to) continue
    } else if (period !== '' && (meeting.period ?? '') !== period) continue
    if (from !== undefined && meeting.startedAt < from) continue
    if (to !== undefined && meeting.startedAt > to) continue
    if (person !== '') {
      const owns = (meeting.tasks ?? []).some((task) => task.owner === person)
      const scored = (meeting.scores ?? []).some((score) => score.person === person)
      if (!owns && !scored) continue
    }
    matches.push(meeting)
  }
  matches.sort((left, right) => {
    const leftPeriod = left.period ?? ''
    const rightPeriod = right.period ?? ''
    // Oldest first, so a week reads as a chronology; an empty period sorts ahead of dates.
    if (leftPeriod !== rightPeriod) return leftPeriod < rightPeriod ? -1 : 1
    return left.startedAt - right.startedAt
  })

  const filters = [
    kind === '' ? '' : `类型=${KIND_TEXT[kind]}`,
    period === '' ? '' : `周期=${period}`,
    from === undefined && to === undefined
      ? ''
      : `日期=${typeof request.from === 'string' && request.from !== '' ? request.from : '不限'}~${typeof request.to === 'string' && request.to !== '' ? request.to : '不限'}`,
    person === '' ? '' : `人员=${person}`,
  ].filter((part) => part !== '').join('　')
  if (matches.length === 0) return `没有符合条件的会议${filters === '' ? '' : `（${filters}）`}。`

  // When more meetings match than asked for, the most recent ones are the useful ones.
  const kept = matches.slice(Math.max(0, matches.length - limit))
  const lines = [
    `会议检索：命中 ${matches.length} 场，显示最近 ${kept.length} 场${filters === '' ? '' : `（${filters}）`}`,
  ]
  if (kept.length < matches.length) {
    lines.push(`（较早的 ${matches.length - kept.length} 场已省略：缩小范围或提高 limit）`)
  }
  for (const meeting of kept) {
    const tasks = meeting.tasks ?? []
    const points = meeting.points ?? []
    const done = tasks.filter((task) => task.done === true).length
    const confirmed = tasks.filter((task) => task.status === 'confirmed').length
    lines.push('')
    lines.push(`## ${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}　${KIND_TEXT[meeting.kind ?? ''] ?? '通用'}　${meeting.period === undefined || meeting.period === '' ? '（无周期）' : meeting.period}`)
    lines.push(`meetingId: ${meeting.id}　sessionId: ${meeting.sessionId === '' ? '（未知）' : meeting.sessionId}　开始: ${new Date(meeting.startedAt).toLocaleString()}`)
    lines.push(`工作安排: 共 ${tasks.length}，已完成 ${done}，已确认 ${confirmed}　要点 ${points.length} 条　文档 ${(meeting.documents ?? []).length} 篇`)
    if (!include.has('points') && points.length > 0) {
      const teaser = points.slice(0, 3).map((point) => (point.text.length > 40 ? `${point.text.slice(0, 40)}…` : point.text)).join('；')
      lines.push(`要点摘要: ${teaser}${points.length > 3 ? `（其余 ${points.length - 3} 条可用 include:["points"] 读取）` : ''}`)
    }
    if (include.has('tasks') && tasks.length > 0) {
      lines.push('工作安排：')
      for (const task of tasks) {
        lines.push(`- #${task.id} ${task.title}（${task.owner === '' ? '未定负责人' : task.owner} / ${task.due === '' ? '未定时间' : task.due} / ${task.priority} / ${task.status}${task.done === true ? ' / 已完成' : ''}）`)
      }
    }
    if (include.has('points') && points.length > 0) {
      lines.push('要点：')
      for (const point of points) lines.push(`- [${point.kind}] ${point.text}`)
    }
    if (include.has('scores') && (meeting.scores ?? []).length > 0) {
      lines.push('评分：')
      for (const score of meeting.scores) {
        lines.push(`- ${score.person}（课时 ${score.hours} / 完成率 ${score.completion} / 质量 ${score.quality} / 学习 ${score.learn} / 总分 ${score.total} / ${score.status}）`)
      }
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Monthly scores (FEATURES §2.4 / §3.4)
// ---------------------------------------------------------------------------

/** Clamp a value into 0…max, treating anything that is not a finite number as 0. */
function clampNumber(value, max) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0
}

/**
 * Weighted total of one score row, with the design's default weights: quality and
 * completion 40% each, learning 20%. Quality and learning are 1–10 and read as
 * percentages; completion is already a percentage.
 * @param row - score entry carrying completion, quality and learn.
 * @returns the rounded 0–100 total.
 */
export function scoreTotal(row) {
  const quality = clampNumber(row.quality, 10) * 10
  const completion = clampNumber(row.completion, 100)
  const learn = clampNumber(row.learn, 10) * 10
  return Math.round(scoreWeights.quality * quality + scoreWeights.completion * completion + scoreWeights.learn * learn)
}

/**
 * The local date range a 'YYYY-MM' period covers, inclusive on both ends.
 * @param period - monthly period bucket.
 * @returns `{ from, to }` as ISO dates, or undefined when the text is not a month.
 */
export function monthRangeOf(period) {
  const match = /^(\d{4})-(\d{2})$/u.exec(typeof period === 'string' ? period.trim() : '')
  if (match === null) return undefined
  const month = Number(match[2])
  if (month < 1 || month > 12) return undefined
  const lastDay = new Date(Number(match[1]), month, 0).getDate()
  return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * Per-owner task statistics over a window — what pre-fills a monthly table's completion
 * column (FEATURES §3.4): one row per owner, with how much of their work is done.
 * @param from - inclusive local ISO date.
 * @param to - inclusive local ISO date.
 * @returns rows sorted by name.
 */
export function ownerTaskStats(from, to) {
  const fromAt = localDayOf(from)
  const toAt = localDayOf(to, true)
  const stats = new Map()
  for (const meeting of meetings.values()) {
    if (fromAt !== undefined && meeting.startedAt < fromAt) continue
    if (toAt !== undefined && meeting.startedAt > toAt) continue
    for (const task of meeting.tasks ?? []) {
      const owner = typeof task.owner === 'string' ? task.owner.trim() : ''
      if (owner === '') continue
      const row = stats.get(owner) ?? { person: owner, total: 0, done: 0, completion: 0 }
      row.total += 1
      if (task.done === true) row.done += 1
      stats.set(owner, row)
    }
  }
  const rows = [...stats.values()]
  for (const row of rows) row.completion = row.total === 0 ? 0 : Math.round((row.done / row.total) * 100)
  rows.sort((left, right) => left.person.localeCompare(right.person, 'zh'))
  return rows
}

/** Header row of the score table, shared by the CSV and the Excel renderer. */
const SCORE_HEADERS = ['人员', '课时', '完成率%', '工作质量', '学习参与', '总分', '状态', '亮点', '待改进', '依据']

/** One score row as plain cells, in header order. */
function scoreCells(row) {
  return [
    row.person ?? '',
    String(row.hours ?? 0),
    String(row.completion ?? 0),
    String(row.quality ?? 0),
    String(row.learn ?? 0),
    String(row.total ?? 0),
    row.status === 'confirmed' ? '已确认' : '草稿',
    row.highlight ?? '',
    row.improve ?? '',
    (row.basis ?? []).join(' / '),
  ]
}

/**
 * The score table as CSV text.
 * @param meeting - meeting carrying the scores.
 * @returns CSV text: one header row plus one row per person.
 */
export function scoresCsv(meeting) {
  const lines = [SCORE_HEADERS, ...(meeting.scores ?? []).map(scoreCells)]
  return lines.map((cells) => cells.map((cell) => (/[",\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell)).join(',')).join('\n')
}

/**
 * Render the score table as an Excel workbook through the bundled Python runtime.
 * @param ctx - Host context, used to log a renderer failure.
 * @param meeting - meeting carrying the scores.
 * @param name - file name inside the export directory.
 * @returns the written file name.
 */
export async function writeScoresXlsx(ctx, meeting, name) {
  const directory = exportDirectory()
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  const python = await pythonExecutable()
  const script = join(PACKAGE_DIR, 'scores-xlsx.py')
  const payload = JSON.stringify({
    title: meeting.title === undefined || meeting.title === '' ? '月度评分' : meeting.title,
    period: meeting.period ?? '',
    rows: meeting.scores ?? [],
  })
  await new Promise((resolve, reject) => {
    const child = spawn(python, [script, target], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    child.on('error', (error) => reject(new Error(`无法启动 Python：${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        ctx.logger.warn('meeting-room: xlsx renderer failed: %s', errors.trim())
        reject(new Error(errors.trim() === '' ? `Python 退出码 ${code}` : errors.trim()))
      }
    })
    child.stdin.end(payload, 'utf8')
  })
  return name
}

/** A small reference to one meeting, for navigation and reminders. */
function meetingRef(meeting) {
  return meeting === undefined ? null : {
    meetingId: meeting.id,
    sessionId: meeting.sessionId ?? '',
    period: meeting.period ?? '',
    title: meeting.title ?? '',
    startedAt: meeting.startedAt,
  }
}

/**
 * The meetings just before and after this one in its own series: same kind, ordered by
 * period then start time. A general meeting belongs to no series.
 * @param meeting - the meeting to locate.
 * @returns `{ prev, next }`, either may be null.
 */
export function seriesFor(meeting) {
  const kind = meeting.kind ?? ''
  if (kind === '') return { prev: null, next: null }
  const siblings = [...meetings.values()]
    .filter((other) => (other.kind ?? '') === kind)
    .sort((left, right) => {
      const leftPeriod = left.period ?? ''
      const rightPeriod = right.period ?? ''
      if (leftPeriod !== rightPeriod) return leftPeriod < rightPeriod ? -1 : 1
      return left.startedAt - right.startedAt
    })
  const index = siblings.findIndex((other) => other.id === meeting.id)
  if (index < 0) return { prev: null, next: null }
  return { prev: meetingRef(siblings[index - 1]), next: meetingRef(siblings[index + 1]) }
}

/**
 * What the previous review meeting left open — the briefing's carry-over reminder. The
 * day before is computed from this meeting's own start, so the reminder follows the
 * meeting's calendar rather than the wall clock.
 * @param meeting - the meeting being prepared (usually a briefing).
 * @returns `{ review, items }`; items are the review's unfinished or carry-over tasks.
 */
export function carryOverFor(meeting) {
  const startedAt = typeof meeting.startedAt === 'number' ? meeting.startedAt : Date.now()
  const yesterday = periodOf('briefing', startedAt - 24 * 3600 * 1000)
  const review = [...meetings.values()]
    .filter((other) => (other.kind ?? '') === 'review' && (other.period ?? '') === yesterday)
    .sort((left, right) => right.startedAt - left.startedAt)[0]
  if (review === undefined) return { review: null, items: [] }
  const items = (review.tasks ?? [])
    .filter((task) => task.done !== true || /遗留/u.test(task.title ?? ''))
    .map((task) => ({
      meetingId: review.id,
      taskId: task.id,
      title: task.title,
      owner: task.owner ?? '',
      due: task.due ?? '',
      done: task.done === true,
    }))
  return { review: meetingRef(review), items }
}

/**
 * The recipe behind one kind's distillation: which read, which cross-meeting query and
 * which writes produce the structured result (FEATURES §3, §4.3). It is a checklist, not
 * the prose the panel injects, so the wording lives in exactly one place.
 * @param meeting - the meeting to distil.
 * @returns the numbered recipe.
 */
export function distillPlan(meeting) {
  const period = meeting.period === undefined || meeting.period === '' ? '（无周期）' : meeting.period
  const kind = meeting.kind ?? ''
  const title = meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title
  const lines = [
    `会议 ${meeting.id}（类型：${KIND_TEXT[kind] ?? '通用'}　周期：${period}　名称：${title}）`,
    `1) meeting_read { meetingId: "${meeting.id}" } 读完实录；要点与工作安排会带 #id。`,
  ]
  if (kind === 'briefing') {
    lines.push('2) meeting_query { kind: "review", period: "yesterday", include: ["tasks"] } 取昨日复盘的遗留，与实录对照。')
    lines.push('3) meeting_write { meetingId, points: [决定/要求], tasks: [任务·负责人·时限·优先级] }（草稿，等人确认）。')
    lines.push(`4) meeting_save_document { kind: "summary", title: "晨会部署 · ${period}" }。`)
  } else if (kind === 'review') {
    lines.push('2) meeting_query { kind: "briefing", period: "today", include: ["tasks"] } 取当天晨会任务，每条带 #id 与所属 meetingId。')
    lines.push('3) meeting_write { meetingId: <晨会的 meetingId>, tasks: [{ id, done: true|false, source }] } 逐项核销——跨会写回，不要复制任务。')
    lines.push('4) meeting_write { meetingId: <本会>, points: [risk/question], tasks: [遗留，标题注明「遗留」] }。')
    lines.push(`5) meeting_save_document { kind: "summary", title: "复盘盘点 · ${period}" }。`)
  } else if (kind === 'weekly') {
    lines.push('2) meeting_query { kind: "briefing", period: "this-week", include: ["tasks"] } 与 { kind: "review", period: "this-week", include: ["tasks"] }。')
    lines.push('3) meeting_write { meetingId, points: [主题/论点/体会/实践] }。')
    lines.push(`4) meeting_save_document { kind: "summary", title: "本周纪要 · ${period}" }（完成 / 未完成 / 风险三清单，注明来源会议）。`)
  } else if (kind === 'monthly') {
    lines.push('2) meeting_query { period: "this-month", include: ["tasks", "points"] } 取本月会议与任务，按人汇总完成率。')
    lines.push('3) meeting_write { meetingId, scores: [{ person, hours, completion, quality, learn, highlight, improve, basis }] }（草稿，等人确认改分）。')
    lines.push(`4) meeting_save_document { kind: "summary", title: "月度评分 · ${period}" }。`)
  } else {
    lines.push('2) meeting_write { meetingId, points: [...], tasks: [...] }（草稿）。')
    lines.push(`3) meeting_save_document { kind: "summary", title: "会议纪要 · ${period}" }（可选）。`)
  }
  lines.push('只依据实录与查询结果，不要编造；人名与术语不确定时保守处理并标注。')
  return lines.join('\n')
}

/**
 * Tool entry point for `meeting_distill`: resolve the calling session's meeting and hand
 * back its recipe.
 * @param args - Model arguments.
 * @param exec - Tool run context carrying the calling session.
 * @returns the recipe, or a note when the session has no meeting.
 */
export function distillForSession(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) return 'No meeting was found for this session; nothing to distil.'
  return distillPlan(meeting)
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Transcribe one PCM cue and append the resulting segment.
 * @param ctx - Host context.
 * @param meeting - Meeting record.
 * @param pcm - Raw PCM16 bytes for this cue.
 * @param collectedSeconds - Meeting offset where this cue started, in seconds.
 * @returns the recognized text.
 */
export async function appendChunk(ctx, meeting, pcm, collectedSeconds) {
  const speech = ctx.get('speechToText')
  if (speech === undefined) {
    // Read lazily so a profile without the speech capability still loads; the
    // marker lets the browser half surface the in-place download flow.
    throw new Error('语音模型尚未下载。请先在会议面板下载语音识别模型，完成后再开始录制。')
  }
  const audio = wavFromPcm(pcm, SAMPLE_RATE)
  let text = ''
  try {
    const spec = speech.resolve({ audio })
    const result = await speech.transcribe(spec, meeting.controller.signal)
    text = result.text.trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The SenseVoice provider throws English messages when the model needs
    // preparation; translate them into actionable Chinese.
    if (/prepare/i.test(message)) {
      throw new Error('语音模型尚未下载。请先在会议面板下载语音识别模型，完成后再开始录制。')
    }
    throw error
  }
  const end = collectedSeconds + pcm.length / 2 / SAMPLE_RATE
  if (text !== '') {
    // Read once per cue: the normalisation rules and cue limits are settings, and a cue that
    // arrives after a change should follow the change.
    const transcriptSettings = await readTranscriptSettings().catch(() => null)
    const revised = await correctText(ctx, text, meeting.terms)
    // The raw recognition records what was heard; a correction is stored beside it and never
    // replaces it, so the original stays auditable.
    const segment = { id: `${meeting.segments.length + 1}`, start: collectedSeconds, end, text }
    if (revised !== text) segment.revised = revised
    // Numbers, dates and clocks written the way a person writes them: a purely local rewrite
    // (host-text.js), stored BESIDE the recognition rather than replacing it, so the literal
    // output stays auditable and a later rule change can be re-derived from it. The rules are
    // a setting, so a meeting can keep numerals exactly as they were said.
    if (transcriptSettings.normalize) {
      const normalised = normalizeText(revised, transcriptSettings.normalizeRules)
      if (normalised !== revised) segment.normalised = normalised
    }
    meeting.segments.push(segment)
  }
  meeting.seconds = end
  return text
}

// ---------------------------------------------------------------------------
// Speech Readiness
// ---------------------------------------------------------------------------

/**
 * Read the transcription provider readiness as a plain object the browser half can use.
 * The download progress (`completedBytes`/`totalBytes`) rides along so the UI can show a
 * real percentage instead of an indeterminate spinner.
 * @param ctx - Host context.
 * @returns `{ ready, phase, message, providerId, completedBytes, totalBytes }`.
 */
export function readSpeechState(ctx) {
  const speech = ctx.get('speechToText')
  if (speech === undefined) {
    return { ready: false, phase: 'unavailable', message: '', providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  let snapshot
  try {
    snapshot = typeof speech.snapshot === 'function' ? speech.snapshot() : undefined
  } catch (error) {
    return { ready: false, phase: 'unavailable', message: error instanceof Error ? error.message : String(error), providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  const selectedId = snapshot?.selection?.providerId
  const provider = providers.find((entry) => entry?.id === selectedId) ?? providers[0]
  if (provider === undefined) {
    return { ready: false, phase: 'unavailable', message: '', providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  const preparation = provider.preparation ?? {}
  const phase = typeof preparation.phase === 'string' ? preparation.phase : 'unavailable'
  const message = phase === 'failed' && typeof preparation.message === 'string' ? preparation.message : ''
  const completedBytes = typeof preparation.completedBytes === 'number' ? preparation.completedBytes : 0
  const totalBytes = typeof preparation.totalBytes === 'number' ? preparation.totalBytes : 0
  // 'standby' holds a verified model with the worker asleep: a recording can begin right
  // away because the provider wakes its worker lazily on the first transcription.
  return {
    ready: phase === 'ready' || phase === 'standby',
    phase,
    message,
    providerId: typeof provider.id === 'string' ? provider.id : '',
    completedBytes,
    totalBytes,
    busy: phase === 'checking' || phase === 'downloading' || phase === 'loading' || phase === 'waking' || phase === 'cancelling',
  }
}

/**
 * Ask the speech service to prepare the selected local provider (SenseVoice), downloading
 * its model if it has not been fetched yet. Progress is observed through readSpeechState.
 *
 * Robustness: when the speech capability is not loaded at all (the voice-input bundle is
 * disabled), this first enables that bundle programmatically and waits for its provider
 * to register, then starts the model download — so one click installs and downloads.
 *
 * @param ctx - Host context.
 * @returns the state after the request was armed.
 */
export async function prepareSpeech(ctx) {
  let speech = ctx.get('speechToText')
  if (speech === undefined) {
    const manager = ctx.get('pluginManager')
    if (manager !== undefined && typeof manager.setBundleEnabled === 'function') {
      try {
        await manager.setBundleEnabled('@deepseek-ai/dsh-experimental-voice-input-bundle', true)
      } catch (error) {
        return { ready: false, phase: 'failed', message: error instanceof Error ? error.message : String(error), providerId: '' }
      }
      // The bundle applies live; give its provider a moment to register.
      for (let attempt = 0; attempt < 40 && speech === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        speech = ctx.get('speechToText')
      }
    }
  }
  if (speech === undefined) return readSpeechState(ctx)
  // Right after activation the provider inspects its disk cache. Calling prepare() while
  // that inspection runs is silently ignored by the provider, so wait for the verdict
  // first: the cache either verifies to 'standby' (already usable, no download) or
  // reports 'unprepared' (needs a real download).
  let state = readSpeechState(ctx)
  for (let attempt = 0; attempt < 80 && (state.phase === 'checking' || state.phase === 'unavailable'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    state = readSpeechState(ctx)
  }
  // Verified resources need no download, and an active task must not be double-armed.
  if (state.providerId === '' || state.phase === 'ready' || state.phase === 'standby') return state
  if (state.phase === 'downloading' || state.phase === 'loading' || state.phase === 'waking' || state.phase === 'cancelling') return state
  // 'unprepared', 'cancelled' or a previous 'failed' attempt: nothing is in flight now,
  // so arming the download takes effect; the provider reuses verified files.
  try {
    if (typeof speech.prepare === 'function') speech.prepare(state.providerId)
  } catch (error) {
    return { ready: false, phase: 'failed', message: error instanceof Error ? error.message : String(error), providerId: state.providerId }
  }
  return readSpeechState(ctx)
}

// ---------------------------------------------------------------------------
// Text Correction
// ---------------------------------------------------------------------------

/**
 * Load the pinyin helper from the profile directory, where a plugin cannot resolve it by
 * name, and remember its absence instead of retrying on every cue.
 * @param ctx - Host context.
 * @returns the syllable splitter, or null when the package is not installed.
 */
export async function loadPinyin(ctx) {
  if (pinyinAttempted) return pinyinSyllables
  setPinyinState(pinyinSyllables, true)
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
        const syllables = (text) => convert(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
        setPinyinState(syllables, true)
        return syllables
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
export function parseTerms(terms) {
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
export async function correctText(ctx, text, terms) {
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

// ---------------------------------------------------------------------------
// Analysis Extraction
// ---------------------------------------------------------------------------

/**
 * Pull draft work assignments from the transcript with plain rules — no model, no login.
 * A task is the cue's own words, which is the honest artifact a human later confirms.
 * @param segments - Timed transcript segments.
 * @returns draft tasks.
 */
export function extractTasks(segments) {
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
export function extractPoints(segments) {
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
export function extractAnalysis(meeting) {
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

// ---------------------------------------------------------------------------
// Minutes / Document Rendering
// ---------------------------------------------------------------------------

/**
 * Build the structured content of the minutes document, shared by the Word export.
 * @param meeting - Meeting record.
 * @returns the payload the document renderer consumes.
 */
export function minutesBlocks(meeting) {
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
  push('五、手写笔记', written.map((note) => note.text.replace(/\n/gu, ' ')))
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
 * Render a meeting as a minutes document: decisions, points, assignments, notes and the
 * transcript, in the order a reader wants them.
 * @param meeting - Meeting record.
 * @returns the markdown document.
 */
export function minutesText(meeting) {
  const terms = meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const lines = [
    '# 会议纪要',
    '',
    `- 会议编号：${meeting.id}`,
    // A minutes file travels on its own, so it has to say which meeting it is.
    `- 名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`,
    `- 类型：${kindText(meeting.kind ?? '')}${meeting.period === undefined || meeting.period === '' ? '' : `　周期：${meeting.period}`}`,
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
    for (const note of written) lines.push(`- ${note.text.replace(/\n/gu, ' ')}`)
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

/**
 * Render the minutes as a Word document through the bundled Python.
 * @param ctx - Host context, used to log a renderer failure.
 * @param meeting - Meeting record.
 * @param name - File name to write inside the export directory.
 * @returns the written file name.
 */
export async function writeDocx(ctx, meeting, name) {
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

// ---------------------------------------------------------------------------
// Speaker Relabeling
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two equally long vectors.
 * @param left - First vector.
 * @param right - Second vector.
 * @returns the similarity, or 0 when either vector has no length.
 */
export function cosine(left, right) {
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
export function relabelSpeakers(meeting) {
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

/**
 * Finish a recording wherever the stop comes from: the panel's stop button, the
 * owning session leaving the store, or a forced archive. The three entries share
 * this one path so the WAV is always patched shut, the file handle closed, and the
 * voices re-clustered exactly once. Idempotent: a meeting that has already stopped
 * has no handle and all embeddings were already dropped, so a second pass only
 * re-flushes an unchanged record.
 * @param ctx - Host context, used to flush the finalized record.
 * @param meeting - Meeting whose recording ends.
 * @returns the number of voices after the whole-meeting repass.
 */
export async function finalizeRecording(ctx, meeting) {
  if (meeting.controller !== undefined && !meeting.controller.signal.aborted) {
    meeting.controller.abort(new Error('meeting stopped'))
  }
  // Patch the WAV sizes and close the file so the recording is a complete, seekable file.
  if (meeting.audioHandle !== undefined) {
    try {
      await meeting.audioHandle.write(wavHeader(meeting.audioBytes, SAMPLE_RATE), 0, 44, 0)
    } finally {
      await meeting.audioHandle.close()
      meeting.audioHandle = undefined
    }
  }
  // Cues captured before the speaker model finished downloading carry no label, and a
  // worker that died mid-meeting leaves the rest blank too. The finished recording
  // still holds every cue's audio, so judge the unlabeled ones from it now. By default this
  // covers EVERY cue: the old 60-cue cap was the main reason labels broke apart in a long
  // meeting. `fullRelabel: false` in the speaker settings restores a capped tail pass.
  const plan = relabelPlanOf((await readSettings()).speaker)
  let backfilled = 0
  try {
    backfilled = await relabelFromRecording(ctx, meeting, plan)
  } catch (error) {
    ctx?.logger?.warn('dsh-meeting-room: speaker backfill failed: %s', error instanceof Error ? error.message : String(error))
  }
  if (backfilled > 0) ctx?.logger?.info('dsh-meeting-room: backfilled %d unlabeled cue(s) at stop', backfilled)
  // The recording is finished, so the cues can be re-clustered as a whole: the online
  // gallery cannot split or merge what it has already labelled.
  const voices = relabelSpeakers(meeting)
  // Keep one centroid per voice before the per-cue vectors go: the voice library is written
  // when a person NAMES a speaker, which happens after the meeting, and a centroid is all it
  // needs. Centroids are never persisted (see recordOf) and never leave this machine.
  meeting.voiceCentroids = centroidsOf(meeting)
  // The embeddings have done their job once the voices are settled, so a long meeting
  // does not keep every cue's vector in memory for the rest of the session.
  for (const segment of meeting.segments) delete segment.embedding
  void flushMeetings(ctx)
  return voices
}

/** A spoken sentence ends here; a cue that does not end this way is still going on. */
const TERMINAL_PUNCTUATION = /[。！？!?…]$/u

/**
 * Join two cue texts without inserting a space between Chinese characters.
 * @param left - earlier text.
 * @param right - later text.
 * @returns the joined text.
 */
function joinFragment(left, right) {
  if (left === '') return right
  if (right === '') return left
  return /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right) ? `${left} ${right}` : `${left}${right}`
}

/** A clause boundary inside a long sentence, used only when the sentence must be cut. */
const CLAUSE_PUNCTUATION = /[，,、；;：:]/u

/**
 * Break recognized text into readable sentence-sized pieces.
 *
 * Fast speech arrives as one 10-second cue holding several sentences; the local recognizer
 * does punctuate, but it never reports where one sentence ends in time. Splitting on its
 * punctuation is the closest local equivalent of "按语义断句": sentence enders first, then
 * clause punctuation inside an over-long sentence, and a hard cut only as a last resort.
 * The cloud recognizer's own `segments` (Whisper-style) are used instead when present —
 * those carry real boundaries.
 * @param text - recognized text.
 * @param maxChars - longest piece a person wants on one line.
 * @returns the pieces, in order; empty for blank text.
 */
export function sentenceParts(text, maxChars = 60) {
  const clean = typeof text === 'string' ? text.trim() : ''
  if (clean === '') return []
  const cap = Math.max(12, Math.round(maxChars))
  // 1. Cut after every sentence terminator (，。！？；…), keeping the punctuation.
  const sentences = []
  let buffer = ''
  for (const character of clean) {
    buffer += character
    if (/[。！？!?…]/u.test(character)) {
      sentences.push(buffer)
      buffer = ''
    }
  }
  if (buffer.trim() !== '') sentences.push(buffer)
  // 2. A sentence longer than the cap is cut at a clause mark, never mid-word if avoidable.
  const pieces = []
  for (const sentence of sentences) {
    let rest = sentence
    while (rest.length > cap) {
      let cut = -1
      for (let index = cap; index >= Math.max(6, Math.floor(cap / 2)); index -= 1) {
        if (CLAUSE_PUNCTUATION.test(rest[index - 1])) {
          cut = index
          break
        }
      }
      if (cut < 0) cut = cap
      pieces.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest !== '') pieces.push(rest)
  }
  // 3. A dangling two-word tail (no terminator of its own) reads badly alone; keep it with
  // the sentence before it. A short but complete sentence stays its own line.
  const merged = []
  for (const piece of pieces) {
    const complete = /[。！？!?…]/u.test(piece)
    if (merged.length > 0 && piece.trim().length < 6 && !complete) merged[merged.length - 1] += piece
    else merged.push(piece)
  }
  return merged.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/**
 * Replace one cue with its sentence-sized pieces.
 *
 * The recording is written cue by cue, so sub-cue times are proportional to character
 * count unless the cloud recognizer supplied real segment times. Speaker and embedding are
 * copied onto every piece: one person said the whole cue.
 * @param meeting - Meeting whose cue is split.
 * @param index - position of the cue.
 * @param options - `maxChars`, optional cloud `hints` (relative seconds + text), and
 *   `normalizeRules` so each piece is still written the way a person writes it.
 * @returns the number of pieces now at that position (1 when nothing changed).
 */
export function splitCueIntoSentences(meeting, index, options = {}) {
  const cue = meeting.segments[index]
  if (cue === undefined || typeof cue.text !== 'string') return 0
  const maxChars = options.maxChars
  const hints = Array.isArray(options.hints) ? options.hints.filter((hint) => hint !== null && typeof hint === 'object' && typeof hint.text === 'string' && hint.text.trim() !== '') : []
  let pieces = []
  if (hints.length > 1) {
    // Real boundaries from the cloud recognizer: trust its times and wording.
    pieces = hints.map((hint) => ({
      text: hint.text.trim(),
      start: cue.start + Math.max(0, Number(hint.start) || 0),
      end: cue.start + Math.max(0, Number(hint.end) || 0),
    }))
  } else {
    const parts = sentenceParts(cue.text, maxChars)
    if (parts.length <= 1) return 1
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0)
    let cursor = cue.start
    const span = Math.max(0.001, cue.end - cue.start)
    pieces = parts.map((part) => {
      const start = cursor
      const end = cursor + (part.length / totalChars) * span
      cursor = end
      return { text: part, start, end }
    })
    pieces[pieces.length - 1].end = cue.end
  }
  if (pieces.length <= 1) return 1
  // Corrections and the normalised reading describe the whole cue. Split them too when the
  // sentence count lines up, so a split cue does not lose its terminology corrections.
  const revisedParts = typeof cue.revised === 'string' && hints.length <= 1 ? sentenceParts(cue.revised, maxChars) : []
  const rules = Array.isArray(options.normalizeRules) ? options.normalizeRules : null
  const rebuilt = pieces.map((piece, pieceIndex) => {
    const revised = revisedParts.length === pieces.length ? revisedParts[pieceIndex] : undefined
    const readable = revised ?? piece.text
    const normalised = rules === null ? '' : normalizeText(readable, rules)
    return {
      ...cue,
      id: `${cue.id}.${pieceIndex + 1}`,
      start: piece.start,
      end: piece.end,
      text: piece.text,
      revised: revised !== undefined && revised !== piece.text ? revised : undefined,
      normalised: normalised !== '' && normalised !== readable ? normalised : undefined,
    }
  })
  meeting.segments.splice(index, 1, ...rebuilt)
  return rebuilt.length
}

/**
 * Fold a cue into the one before it when the first sentence is not finished yet.
 *
 * The browser endpoints audio on a pause, not on a full stop, so a single spoken
 * sentence often arrives as two or three cues. Left alone, the transcript showed
 * fragments ("我们下周" / "把方案交上来") instead of sentences, and every fragment got
 * its own speaker guess. Merging is text-only: the earlier cue keeps its start and
 * takes the later end, so seeking and speaker evidence stay one per sentence.
 * @param meeting - Meeting whose last cue may continue the previous one.
 * @param index - position of the new cue.
 * @returns whether the cue was merged.
 */
export function mergeContinuation(meeting, index) {
  if (!Number.isInteger(index) || index <= 0 || index >= meeting.segments.length) return false
  const previous = meeting.segments[index - 1]
  const current = meeting.segments[index]
  if (typeof previous.text !== 'string' || typeof current.text !== 'string') return false
  // A change of voice is a new utterance even when the sentence is unfinished.
  if (previous.speaker !== current.speaker) return false
  if (current.start - previous.end > 1.0) return false
  if (TERMINAL_PUNCTUATION.test(previous.text.trim())) return false
  // Fast speech can produce a very long cue; merging without a cap turned several
// sentences into one unreadable paragraph, which is the opposite of sentence-per-line.
  if (previous.text.length + current.text.length > 90) return false
  previous.text = joinFragment(previous.text, current.text)
  previous.end = current.end
  // Derived readings describe the old fragment; join them when both exist, otherwise
  // drop them so the panel does not show half a sentence.
  if (typeof previous.revised === 'string' && typeof current.revised === 'string') {
    previous.revised = joinFragment(previous.revised, current.revised)
  } else {
    delete previous.revised
  }
  if (typeof previous.normalised === 'string' && typeof current.normalised === 'string') {
    previous.normalised = joinFragment(previous.normalised, current.normalised)
  } else {
    delete previous.normalised
  }
  if (typeof previous.localText === 'string' && typeof current.localText === 'string') {
    previous.localText = joinFragment(previous.localText, current.localText)
  }
  meeting.segments.splice(index, 1)
  return true
}

/** The transcript as the panel reads it: every field except the speaker embeddings. */
export function publicSegments(meeting) {
  return meeting.segments.map(({ embedding, pcm, speaker, ...rest }) => ({
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
export function displaySpeaker(meeting, label) {
  const name = meeting.speakers?.[label]
  return typeof name === 'string' && name !== '' ? name : label
}

/**
 * The voice labels that appear in this meeting: recorded as they were produced, still present
 * on cues, and any label that carries a name. Reading all three is what lets a reopened
 * meeting show the voices it identified, instead of claiming it never identified any.
 * @param meeting - Meeting record.
 * @returns the labels, in S1, S2, … order.
 */
export function speakerLabels(meeting) {
  return knownSpeakerLabels(meeting)
}

/**
 * Render a meeting as the plain text a model reads.
 * @param meeting - Meeting record.
 * @param limit - Maximum cues to include, keeping the most recent.
 * @returns the transcript text.
 */
export function transcriptText(meeting, limit) {
  const all = meeting.segments
  const kept = all.length > limit ? all.slice(all.length - limit) : all
  const header = [
    '会议实录（本地语音识别，可能含错字；如需订正请对照术语表）',
    `会议：${meeting.id}`,
    `名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}　类型：${meeting.kind === undefined || meeting.kind === '' ? '通用' : meeting.kind}　周期：${meeting.period === undefined || meeting.period === '' ? '（无）' : meeting.period}`,
    `会话：${meeting.sessionId === '' ? '（未知）' : meeting.sessionId}`,
    `开始：${new Date(meeting.startedAt).toLocaleString()}`,
    `时长：${clockOf(meeting.seconds)} 段落：${all.length}`,
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
    recorded.push('', '已记录的工作安排（可用 meeting_write 带 id 更新，含 done 核销）：')
    for (const task of meeting.tasks) {
      const owner = task.owner === '' ? '（未定负责人）' : task.owner
      const due = task.due === '' ? '（未定时间）' : task.due
      // The id is what a review meeting addresses when it checks a task off, so the
      // reading view carries it next to the human-readable fields.
      recorded.push(`- #${task.id} ${task.title}（${owner} / ${due} / ${task.priority} / ${task.status}${task.done === true ? ' / 已完成' : ''}）`)
    }
  }
  // Handwritten notes are meeting content too: a review of a meeting that was only written
  // down would otherwise read as empty.
  const written = (meeting.notes ?? []).filter((note) => typeof note.text === 'string' && note.text !== '')
  if (written.length > 0) {
    recorded.push('', '手写笔记：')
    for (const note of written) recorded.push(`- ${note.text.replace(/\n/gu, ' ')}`)
  }
  const stored = meeting.documents ?? []
  if (stored.length > 0) {
    recorded.push('', '会议文档：')
    for (const document of stored) recorded.push(`- ${document.title}（${document.name}）`)
  }
  return [...header, ...body, ...recorded, ''].join('\n')
}

// ---------------------------------------------------------------------------
// Push / Webhook / DingTalk
// ---------------------------------------------------------------------------

/**
 * Where the robot webhook addresses are kept: user configuration, not plugin code, so it
 * survives restarts without editing the profile composition.
 * @returns the absolute file path.
 */
export function webhookFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'webhooks.json')
}

/**
 * Read the push settings: group robot webhooks, the DingTalk internal application used for
 * private work notifications and contact sync, the shared people roster, and which delivery
 * the user chose.
 * @returns one value per setting, empty when unset.
 */
export async function readSettings() {
  const empty = {
    dingtalk: '', wecom: '', appKey: '', appSecret: '', agentId: '', mode: 'group', people: [], departments: [],
    // The score weights in force (FEATURES §2.4); the default until a person changes them.
    scoreWeights: { ...scoreWeights },
    // Per-type distillation wording (§9 P4): an empty entry means "use the built-in text".
    templates: {},
  }
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
    // The cloud section belongs to whoever reads it (host-providers), which validates its own
    // fields; passing it through untouched is what keeps a saved key from vanishing on read.
    if (parsed.cloud !== null && typeof parsed.cloud === 'object') empty.cloud = parsed.cloud
    // Same for the speaker section (the speaker settings routes and the voice library read it).
    if (parsed.speaker !== null && typeof parsed.speaker === 'object') empty.speaker = parsed.speaker
    // Same for the transcript section (normalisation rules and cue limits).
    if (parsed.transcript !== null && typeof parsed.transcript === 'object') empty.transcript = parsed.transcript
    if (parsed.templates !== null && typeof parsed.templates === 'object') {
      const kept = {}
      for (const kind of ['briefing', 'review', 'weekly', 'monthly']) {
        if (typeof parsed.templates[kind] === 'string') kept[kind] = parsed.templates[kind].slice(0, 4000)
      }
      empty.templates = kept
    }
    // Score weights: adopt only a complete, positive set; a half-written section leaves the
    // defaults in force instead of scoring everyone zero.
    if (parsed.scoreWeights !== null && typeof parsed.scoreWeights === 'object') {
      const candidate = {}
      for (const key of SCORE_WEIGHT_KEYS) {
        if (typeof parsed.scoreWeights[key] === 'number') candidate[key] = parsed.scoreWeights[key]
      }
      if (SCORE_WEIGHT_KEYS.every((key) => typeof candidate[key] === 'number')) {
        empty.scoreWeights = setScoreWeights(candidate)
      }
    }
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
export async function writeSettings(next) {
  const directory = join(webhookFile(), '..')
  await mkdir(directory, { recursive: true })
  await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
}

/**
 * Find the roster entry describing one person by name.
 * @param people - The shared roster.
 * @param name - Owner name written on a task.
 * @returns the entry, or null when the name is unknown or blank.
 */
export function personOf(people, name) {
  const trimmed = name.trim()
  if (trimmed === '') return null
  return (people ?? []).find((person) => person.name === trimmed) ?? null
}

/**
 * Group confirmed assignments by owner, so each person is told only about their own work.
 * @param tasks - Confirmed tasks.
 * @returns one entry per owner, with '' for tasks nobody owns yet.
 */
export function groupByOwner(tasks) {
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
export function ownerMarkdown(meeting, owner, tasks) {
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
    lines.push(`- **${task.title}** 时间：${due} 优先级：${task.priority}`)
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
export async function postRobot(url, payload) {
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
export async function pushToGroups(meeting, kinds, settings) {
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
export async function dingtalkToken(settings) {
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
export async function pushToPeople(meeting, settings) {
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
export async function pushTasks(meeting, kinds, only = '') {
  const settings = await readSettings()
  // One assignment can be sent on its own — a row's own button — and the confirmed rule holds
  // either way: an unconfirmed assignment is never sent.
  const selected = typeof only === 'string' && only !== ''
    ? meeting.tasks.filter((task) => task.id === only)
    : meeting.tasks
  const confirmed = selected.filter((task) => task.status === 'confirmed')
  if (confirmed.length === 0) {
    return {
      sent: [],
      results: [],
      error: typeof only === 'string' && only !== ''
        ? '这条工作安排还没有确认，不能发送：请先勾选确认'
        : '没有已确认的任务可推送：请先在「工作安排」里确认',
    }
  }
  const pending = { ...meeting, tasks: selected }
  const results = []
  if (settings.mode === 'group' || settings.mode === 'both') results.push(...await pushToGroups(pending, kinds, settings))
  if (settings.mode === 'work' || settings.mode === 'both') results.push(...await pushToPeople(pending, settings))
  return { sent: kinds, results, error: '', mode: settings.mode, tasks: confirmed.length }
}

/**
 * Call one DingTalk topapi endpoint with the access token in the query string.
 * @param path - Endpoint path such as topapi/v2/user/list.
 * @param token - Access token.
 * @param body - JSON body.
 * @returns the decoded reply.
 */
export async function dingtalkPost(path, token, body) {
  const response = await fetch(`https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  return await response.json().catch(() => ({}))
}

/**
 * Walk the DingTalk department tree from the root.
 * @param token - Access token.
 * @returns every department from the root down, or an error message.
 */
export async function dingtalkDepartments(token) {
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
export async function dingtalkPeople(token, departmentIds) {
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

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

/**
 * Read the recorded transcript for the calling session.
 * @param args - Model arguments; validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns the transcript text.
 */
export async function readTranscript(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const rawLimit = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : DEFAULT_CUE_LIMIT
  const limit = Math.max(1, Math.min(MAX_CUE_LIMIT, rawLimit))
  const meeting = meetingForSession(exec?.agent?.session?.id, meetingId)
  if (meeting === undefined) {
    const known = [...meetings.values()].map((entry) => entry.id)
    return known.length === 0
      ? 'No meeting has been recorded in this harness process yet.'
      : `No meeting matched this session. Known meetings in this process: ${known.join(', ')}.`
  }
  return transcriptText(meeting, limit)
}

/**
 * Create/configure the calling session's meeting, or report its live state.
 *
 * The definition deliberately has no "start recording" action: the microphone belongs to
 * the browser panel, and a tool that pretended to open it would be a lie. What the
 * five-minute scribe loop needs is the other half — set the name/type up front, and know
 * whether the recording has stopped (so the loop can finish and delete itself).
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short readable state, or an actionable refusal.
 */
export function meetingSession(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) {
    return '这个会话还没有会议记录。请先在右侧会议面板点「开始记录」创建会议，再调用 meeting_session。'
  }
  const action = typeof request.action === 'string' ? request.action : 'status'
  if (action === 'create') {
    if (typeof request.title === 'string' && request.title.trim() !== '') {
      meeting.title = request.title.trim().slice(0, 120)
    }
    if (typeof request.kind === 'string' && MEETING_KINDS.includes(request.kind)) {
      meeting.kind = request.kind
      // The period is derived, never typed: a later weekly/monthly meeting finds this
      // one through it (FEATURES §2.1).
      meeting.period = periodOf(meeting.kind, meeting.startedAt)
    }
    if (typeof request.summary === 'string' && request.summary.trim() !== '') {
      meeting.summary = request.summary.trim().slice(0, 400)
    }
  } else if (action !== 'status') {
    return `未知的 action：${action}。可用 create 或 status。`
  }
  const recording = meeting.audioHandle !== undefined
  const last = meeting.segments.length === 0 ? undefined : meeting.segments[meeting.segments.length - 1]
  const lines = [
    `会议：${meeting.id}`,
    `名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`,
    `类型：${KIND_TEXT[meeting.kind ?? ''] ?? '通用'}　周期：${meeting.period === undefined || meeting.period === '' ? '（无）' : meeting.period}`,
    `录音：${recording ? '进行中' : '已停止'}　已录：${clockOf(meeting.seconds ?? 0)}`,
    `实录：${meeting.segments.length} 段${last === undefined ? '' : `（最后一段 ${clockOf(last.end)}）`}`,
    `要点：${meeting.points.length} 条　工作安排：${meeting.tasks.length} 项`,
  ]
  if (action === 'create') {
    lines.push('', recording
      ? '会议名称与类型已保存。录音已在面板中进行，按计划开始每 5 分钟的整理即可。'
      : '会议名称与类型已保存。请提示用户在会议面板点「开始记录」以开始录音。')
  } else if (!recording) {
    lines.push('', '录音已停止：可以读全文收尾，并删除「会议要点整理」提醒。')
  }
  return lines.join('\n')
}

/**
 * Store the agent's structured reading of the calling session's meeting.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation of what was stored.
 */
export async function writeAnalysis(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) return 'No meeting was found for this session; nothing was recorded.'
  if (request.mode === 'replace') {
    meeting.points = []
    meeting.tasks = []
  }
  // The meeting's short summary: the person types one in the start dialog and the model may
  // polish it, or write one from the transcript (FEATURES §2.1).
  if (typeof request.summary === 'string' && request.summary.trim() !== '') {
    meeting.summary = request.summary.trim()
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
  let updatedTasks = 0
  const unknownTaskIds = []
  for (const item of Array.isArray(request.tasks) ? request.tasks : []) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    const existing = id === '' ? undefined : meeting.tasks.find((task) => task.id === id)
    if (existing !== undefined) {
      // An addressed task is updated in place: this is how a review meeting checks off the
      // tasks a briefing assigned, in the meeting that owns them. A human still owns the
      // final confirmation, so `done` and `status` stay independent.
      if (typeof source.title === 'string' && source.title.trim() !== '') existing.title = source.title.trim()
      if (typeof source.owner === 'string') existing.owner = source.owner.trim()
      if (typeof source.due === 'string') existing.due = source.due.trim()
      if (TASK_PRIORITIES.includes(source.priority)) existing.priority = source.priority
      if (typeof source.source === 'string' && source.source.trim() !== '') existing.source = source.source.trim()
      if (typeof source.done === 'boolean') {
        // The first check-off is the fact worth keeping: repeating `done: true` (another
        // review meeting, a retry) must not move the completion time (§2.3).
        if (source.done && existing.done !== true) existing.doneAt = Date.now()
        if (!source.done) delete existing.doneAt
        existing.done = source.done
      }
      updatedTasks += 1
      continue
    }
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    // An addressed id that does not exist must not pass silently: a review meeting would
    // report "0 updated" as if the check-off had worked (§4.2).
    if (id !== '' && title === '') {
      unknownTaskIds.push(id)
      continue
    }
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
      done: false,
    })
    storedTasks += 1
  }
  let storedScores = 0
  let unscoredForBasis = 0
  for (const item of Array.isArray(request.scores) ? request.scores : []) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const person = typeof source.person === 'string' ? source.person.trim() : ''
    if (person === '') continue
    if (!Array.isArray(meeting.scores)) meeting.scores = []
    const existing = meeting.scores.find((row) => row.person === person)
    const basis = (Array.isArray(source.basis) ? source.basis : [])
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
    // A score must be traceable to the transcript or to a task id (§2.4): a row with no
    // evidence is refused, whether it is new or an existing row still has none. A row that
    // already carries evidence may be corrected without resending it.
    if (basis.length === 0 && (existing === undefined || (existing.basis ?? []).length === 0)) {
      unscoredForBasis += 1
      continue
    }
    const target = existing ?? {
      person, hours: 0, completion: 0, quality: 0, learn: 0, highlight: '', improve: '', basis: [],
      // A score is a draft until a human confirms it, exactly like a task.
      status: 'draft',
    }
    for (const [field, max] of [['hours', 10000], ['completion', 100], ['quality', 10], ['learn', 10]]) {
      const value = source[field]
      if (typeof value === 'number' && Number.isFinite(value)) target[field] = Math.min(Math.max(value, 0), max)
    }
    if (typeof source.highlight === 'string') target.highlight = source.highlight.trim()
    if (typeof source.improve === 'string') target.improve = source.improve.trim()
    if (basis.length > 0) target.basis = basis
    // The weighted total is a default, not a cage: a person may override it, and the
    // override survives until it is cleared (§2.4).
    if (typeof source.total === 'number' && Number.isFinite(source.total)) {
      target.total = Math.min(Math.max(Math.round(source.total), 0), 100)
      target.totalOverride = true
    } else if (target.totalOverride !== true) {
      target.total = scoreTotal(target)
    }
    if (existing === undefined) meeting.scores.push(target)
    storedScores += 1
  }
  const refused = unscoredForBasis === 0 ? '' : ` ${unscoredForBasis} score row(s) were refused because their basis was empty — evidence (a transcript quote or a task id) is required.`
  const unknown = unknownTaskIds.length === 0 ? '' : ` Unknown task id(s), not updated: ${unknownTaskIds.join(', ')}.`
  return `Meeting ${meeting.id}: stored ${storedPoints} point(s), ${storedTasks} new task(s), ${updatedTasks} updated task(s) and ${storedScores} score row(s); it now holds ${meeting.points.length} point(s), ${meeting.tasks.length} task(s) and ${(meeting.scores ?? []).length} score row(s). Tasks and scores stay drafts until a human confirms them.${refused}`
}

/**
 * Apply context-aware corrections to a finished transcript. Every correction is stored
 * beside the recognition it replaces, and the pair is kept as a change entry, so the
 * original words remain auditable and a reader can see what was changed.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation with the applied changes.
 */
export async function reviseTranscript(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
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
export async function saveDocument(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
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
  // flushMeetings needs a ctx; tools don't have direct access, so we skip the flush here
  // and rely on the periodic timer in apply().
  return `Saved "${title}" as ${name} (${Buffer.byteLength(markdown, 'utf8')} bytes). It is listed in the meeting panel.`
}

/**
 * Store the text the agent read out of a handwritten note.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation.
 */
export async function writeNote(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
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
