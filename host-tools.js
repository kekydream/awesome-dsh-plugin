/**
 * Business logic functions for the meeting-room host plugin.
 *
 * Extracted from index.js: transcription, text correction, analysis extraction,
 * minutes/document rendering, speaker relabeling, push/webhook/DingTalk integration,
 * and tool implementations.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：kekydream@qq.com
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
} from './host-helpers.js'

import { flushMeetings } from './host-persistence.js'

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
  return {
    ready: phase === 'ready',
    phase,
    message,
    providerId: typeof provider.id === 'string' ? provider.id : '',
    completedBytes,
    totalBytes,
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
  const state = readSpeechState(ctx)
  if (speech === undefined || state.providerId === '') return state
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

/** The transcript as the panel reads it: every field except the speaker embeddings. */
export function publicSegments(meeting) {
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
export function displaySpeaker(meeting, label) {
  const name = meeting.speakers?.[label]
  return typeof name === 'string' && name !== '' ? name : label
}

/**
 * The voice labels that appear in this meeting, in first-spoken order.
 * @param meeting - Meeting record.
 * @returns the labels.
 */
export function speakerLabels(meeting) {
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
export function transcriptText(meeting, limit) {
  const all = meeting.segments
  const kept = all.length > limit ? all.slice(all.length - limit) : all
  const header = [
    '会议实录（本地语音识别，可能含错字；如需订正请对照术语表）',
    `会议：${meeting.id}`,
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
export async function pushTasks(meeting, kinds) {
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
  const sessionId = exec?.agent?.session?.id
  const meeting = findMeeting(meetings, typeof sessionId === 'string' ? sessionId : '', meetingId)
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
export async function writeAnalysis(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = findMeeting(meetings, typeof sessionId === 'string' ? sessionId : '', meetingId)
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
export async function reviseTranscript(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = findMeeting(meetings, typeof sessionId === 'string' ? sessionId : '', meetingId)
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
  const meeting = findMeeting(meetings, typeof sessionId === 'string' ? sessionId : '', meetingId)
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
  const meeting = findMeeting(meetings, typeof sessionId === 'string' ? sessionId : '', meetingId)
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
