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
  ROLES,
  ROLE_LABELS,
  seenText,
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

import { speakerState, prepareSpeakers, labelCue } from './host-speaker.js'
import { handwritingState, recognizeHandwriting, prepareHandwriting } from './host-handwriting.js'
import { flushMeetings } from './host-persistence.js'

import {
  appendChunk,
  extractAnalysis,
  correctText,
  minutesText,
  transcriptText,
  readSettings,
  writeSettings,
  pushTasks,
  relabelSpeakers,
  publicSegments,
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
          if (typeof body.terms === 'string') pending.terms = body.terms
          pending.controller = new AbortController()
          pending.audioName = audioName
          pending.audioPath = audioPath
          pending.audioHandle = audioHandle
          pending.audioBytes = 0
          sendJson(res, 200, { meetingId: pending.id, sampleRate: SAMPLE_RATE, startedAt, audioName })
          return
        }
        const id = `meeting-${Date.now().toString(36)}`
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
        const id = `meeting-${Date.now().toString(36)}`
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
        // Persist the audio before recognition, so a transcription failure never costs
        // the recording itself.
        if (meeting.audioHandle !== undefined) {
          await meeting.audioHandle.write(pcm)
          meeting.audioBytes += pcm.length
        }
        const before = meeting.segments.length
        const text = await appendChunk(ctx, meeting, pcm, meeting.seconds)
        // Label the cue that was just appended. One cue can span a speaker change; that
        // case keeps the dominant voice and is a documented limitation.
        if (meeting.segments.length > before) {
          const judged = await labelCue(ctx, pcm)
          if (judged.speaker !== '') meeting.segments[before].speaker = judged.speaker
          // The embedding is kept for the end-of-meeting pass, which merges voices the online
          // gallery could not; it never leaves this process.
          if (judged.embedding !== '') meeting.segments[before].embedding = judged.embedding
        }
        sendJson(res, 200, {
          text,
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          speaker: { phase: speakerState.phase, message: speakerState.message },
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
          speakers: meeting.speakers,
          people: meeting.people ?? [],
          documents: meeting.documents ?? [],
          labels: speakerLabels(meeting),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
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
        // An empty name clears the assignment and the label shows again.
        if (name === '') delete meeting.speakers[label]
        else meeting.speakers[label] = name
        sendJson(res, 200, { speakers: meeting.speakers, segments: publicSegments(meeting) })
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
        const directory = dirname(webhookFile())
        await mkdir(directory, { recursive: true })
        await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
        sendJson(res, 200, { mode: next.mode, configured: WEBHOOK_KINDS.filter((kind) => next[kind] !== '') })
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
        const outcome = await pushTasks(meeting, asked.length === 0 ? WEBHOOK_KINDS : asked)
        sendJson(res, outcome.error === '' ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/role') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (!ROLES.includes(body.role)) {
          sendJson(res, 400, { error: 'unknown role' })
          return
        }
        meeting.role = body.role
        sendJson(res, 200, { role: meeting.role })
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
          // A human turning a written note into an assignment; it still lands as a draft.
          const title = typeof body.text === 'string' ? body.text.trim() : ''
          if (title === '') {
            sendJson(res, 400, { error: 'a new task needs text' })
            return
          }
          meeting.tasks.push({
            id: `t${meeting.tasks.length + 1}`,
            title,
            owner: '',
            due: '',
            priority: 'normal',
            source: '',
            status: 'draft',
            origin: 'ink',
          })
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
        meeting.controller.abort(new Error('meeting stopped'))
        // Patch the WAV sizes and close the file so the recording is a complete, seekable file.
        if (meeting.audioHandle !== undefined) {
          try {
            await meeting.audioHandle.write(wavHeader(meeting.audioBytes, SAMPLE_RATE), 0, 44, 0)
          } finally {
            await meeting.audioHandle.close()
            meeting.audioHandle = undefined
          }
        }
        // The recording is finished, so the cues can be re-clustered as a whole: the online
        // gallery cannot split or merge what it has already labelled.
        const voices = relabelSpeakers(meeting)
        // The embeddings have done their job once the voices are settled, so a long meeting
        // does not keep every cue's vector in memory for the rest of the session.
        for (const segment of meeting.segments) delete segment.embedding
        void flushMeetings(ctx)
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
