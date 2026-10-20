/**
 * 发布前自动化冒烟：直接调用宿主侧的路由处理器与工具函数，不需要麦克风与模型。
 *
 * 用法（DSH 自带 node 或任意 node ≥ 20）：
 *   node smoke.mjs
 *
 * 全部检查通过时退出码 0；失败会打印检查名。数据写在临时目录，运行结束即清理。
 */
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = pathToFileURL(here).href
const tmp = join(process.env.TEMP ?? '.', `meeting-room-smoke-${Date.now()}`)
process.env.DSH_HOME = tmp
await fs.mkdir(join(tmp, 'meetings'), { recursive: true })
// The Excel export runs python; point it at the bundled runtime when one is present, so the
// check exercises the real path instead of failing for a missing interpreter.
if (process.env.DSH_PYTHON === undefined) {
  const bundled = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  if (await fs.access(bundled).then(() => true).catch(() => false)) process.env.DSH_PYTHON = bundled
}
const hasPython = process.env.DSH_PYTHON !== undefined || process.env.PATH?.includes('python') === true

const constants = await import(`${plugin}/host-constants.js`)
const { meetings } = constants
const tools = await import(`${plugin}/host-tools.js`)
const sessions = await import(`${plugin}/host-sessions.js`)
const persistence = await import(`${plugin}/host-persistence.js`)
const { createHandler } = await import(`${plugin}/host-routes.js`)
const { exportDirectory } = await import(`${plugin}/host-helpers.js`)
/** The registry module, used directly for the "which model is actually in use" assertions. */
const speakerModels = await import(`${plugin}/host-models.js`)
const { zipRead, zipWrite, importPackage, PACKAGE_FORMAT } = await import(`${plugin}/host-package.js`)

const results = []
const check = (name, ok) => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, get: () => undefined }
const handler = createHandler(ctx)

/** Run one route and parse its JSON answer. */
async function call(route, body, method = 'GET', activeHandler = handler) {
  // A Buffer or a string is the body itself; anything else is JSON. Without this, a binary
  // route would receive `{"type":"Buffer","data":[…]}` and quietly fail every check.
  const payload = body === undefined
    ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/meeting-room${route}`
  req.method = method
  req.headers = {}
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(payload) { if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))) },
  }
  await activeHandler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let value = {}
  try { value = text === '' ? {} : JSON.parse(text) } catch { value = { raw: text } }
  return { status: res.status, headers: res.headers, value, body: Buffer.concat(chunks) }
}

const started = Date.now()
const day = 24 * 3600 * 1000
function seed(id, extra = {}) {
  const meeting = {
    id,
    startedAt: extra.startedAt ?? started,
    sessionId: extra.sessionId ?? `session-${id}`,
    kind: extra.kind ?? '',
    period: extra.period ?? '',
    title: extra.title ?? '',
    summary: '',
    seconds: extra.seconds ?? 0,
    segments: extra.segments ?? [],
    points: extra.points ?? [],
    tasks: extra.tasks ?? [],
    notes: extra.notes ?? [],
    revisions: [],
    speakers: extra.speakers ?? {},
    speakerLabels: extra.speakerLabels ?? [],
    people: [],
    documents: extra.documents ?? [],
    scores: extra.scores ?? [],
    terms: extra.terms ?? '',
    role: extra.role ?? '',
    audioName: extra.audioName ?? '',
    controller: new AbortController(),
  }
  meetings.set(id, meeting)
  return meeting
}

// ---------------------------------------------------------------------------
// 1. 会话 ↔ 会议
// ---------------------------------------------------------------------------
const ids = new Set(Array.from({ length: 200 }, () => constants.newMeetingId()))
check('会议 id 不靠毫秒时间戳，不会互相覆盖', ids.size === 200)
const owned = sessions.ensureMeetingForSession(ctx, { id: 's-root', header: { createdAt: started } })
check('一个会话建出且只建出一场会议', owned !== undefined && sessions.ensureMeetingForSession(ctx, { id: 's-root', header: {} })?.id === owned.id)
check('同一会话再问一次不会多建', [...meetings.values()].filter((m) => m.sessionId === 's-root').length === 1)
check('子代理会话不单独建会议', sessions.ensureMeetingForSession(ctx, { id: 's-sub', header: { origin: 'subagent', delegationDepth: 1 } }) === undefined)
check('分支会话（depth 0）另建一场', sessions.ensureMeetingForSession(ctx, { id: 's-fork', header: { createdAt: started, parentSession: 's-root' } })?.sessionId === 's-fork')
sessions.reapMeetingForSession('s-fork')
check('空会议回收后不再有记录', ![...meetings.values()].some((m) => m.sessionId === 's-fork'))

// ---------------------------------------------------------------------------
// 1b. 发言人标签随会议保存，重新打开仍能看到
// ---------------------------------------------------------------------------
const labeled = seed('m-labels', {
  // A meeting whose cues lost their per-cue label — the model was still downloading, or the
  // stop-time backfill is capped — but whose identified voices were noted on the record.
  speakerLabels: ['S2', 'S1'],
  segments: [{ id: 'c1', start: 0, end: 2, text: '说话内容', speaker: '' }],
})
check('没有逐条标签时也能列出已识别的发言人', tools.speakerLabels(labeled).join(',') === 'S1,S2')
labeled.speakers.S1 = '张三'
check('命名过的标签一定在列表里', tools.speakerLabels(labeled).includes('S1'))
const stateLabels = await call('/state?meetingId=m-labels')
check('/state 把标签回给面板', Array.isArray(stateLabels.value.labels) && stateLabels.value.labels.join(',') === 'S1,S2')
// The panel restores itself from /current after a reload or a session switch, so that answer
// must carry everything it renders — the labels were in it but went unread on the client.
labeled.role = 'host'
labeled.documents = [{ id: 'd1', title: '复盘', name: 'a.md' }]
labeled.terms = '亳州=博州'
const current = await call(`/current?sessionId=${encodeURIComponent(labeled.sessionId)}`)
check('/current 带上标签、角色、文档与术语', current.status === 200
  && current.value.meeting !== null
  && Array.isArray(current.value.meeting.labels) && current.value.meeting.labels.join(',') === 'S1,S2'
  && current.value.meeting.role === 'host'
  && current.value.meeting.documents.length === 1
  && current.value.meeting.terms === '亳州=博州')
check('给只存在于标签集的发言人命名被接受', (await call('/speaker/name', { meetingId: 'm-labels', label: 'S2', name: '李四' }, 'POST')).status === 200)
check('命名后 speakers 里有两个人', labeled.speakers.S1 === '张三' && labeled.speakers.S2 === '李四')
await persistence.flushMeetings(ctx)
const storedLabels = JSON.parse(await fs.readFile(join(tmp, 'meeting-room', 'meetings', 'm-labels.json'), 'utf8'))
check('标签集随会议落盘', Array.isArray(storedLabels.speakerLabels) && storedLabels.speakerLabels.includes('S1'))

// ---------------------------------------------------------------------------
// 2. 元数据：类型 / 周期 / 角色 / 名称
// ---------------------------------------------------------------------------
check('日周期', tools.periodOf('briefing', started) === new Date(started).toLocaleDateString('sv-SE'))
check('ISO 周周期', /^\d{4}-W\d{2}$/.test(tools.periodOf('weekly', started)))
check('月周期', /^\d{4}-\d{2}$/.test(tools.periodOf('monthly', started)))
// The reaper drops meetings that are still empty (by design: nothing is persisted). That
// makes any reference taken earlier racy, so the section asks the host for the meeting again
// rather than assuming it survived — a flaky suite is worse than no suite.
const reEnsured = await call('/ensure', { sessionId: 's-root' }, 'POST')
if (typeof reEnsured.value.meetingId === 'string' && reEnsured.value.meetingId !== '') owned.id = reEnsured.value.meetingId
const k = await call('/kind', { meetingId: owned.id, kind: 'review', title: '复盘 · 今天' }, 'POST')
check('类型与名称写入并派生周期', k.status === 200 && k.value.kind === 'review' && k.value.period !== '' && k.value.title === '复盘 · 今天')
check('未知会议的类型写入被拒', (await call('/kind', { meetingId: 'nope', kind: 'review' }, 'POST')).status === 404)
check('三个常用席位可写入', (await call('/role', { meetingId: owned.id, role: 'host' }, 'POST')).status === 200)
check('自定义角色（含空白）被接受并 trim', (await call('/role', { meetingId: owned.id, role: '  计分员  ' }, 'POST')).value.role === '计分员')
check('空角色被拒', (await call('/role', { meetingId: owned.id, role: '   ' }, 'POST')).status === 400)
check('超长角色被拒', (await call('/role', { meetingId: owned.id, role: 'x'.repeat(25) }, 'POST')).status === 400)

// ---------------------------------------------------------------------------
// 3. 历史列表：倒序、过滤、分页
// ---------------------------------------------------------------------------
const brief = seed('m-brief', {
  startedAt: started + 2000,
  kind: 'briefing',
  period: tools.periodOf('briefing', started),
  title: '晨会 · 排期',
  segments: [{ id: 'c1', start: 0, end: 3, text: '今天先排掉上线风险', speaker: '' }],
  points: [{ id: 'p1', kind: 'decision', text: '周五上线', status: 'draft', origin: 'agent' }],
  tasks: [{ id: 't1', title: '排期评审', owner: '张三', due: '明天', priority: 'high', status: 'draft', origin: 'agent', done: false }],
})
const review = seed('m-review', { kind: 'review', period: tools.periodOf('review', started - day), title: '复盘 · 昨天', startedAt: started - day })
// Deliberately nameless and empty: an eager meeting of a live session, which the history
// must not list and the store must not write (DESIGN §4).
seed('m-blank', { startedAt: started - 2 * day })

const history = await call('/history?limit=2')
check('历史按最近优先', history.value.meetings.length === 2 && history.value.meetings[0].meetingId === 'm-brief')
check('历史返回总条数', history.value.total >= 3)
check('历史分页不重叠', (await call('/history?limit=2&offset=2')).value.meetings.every((row) => row.meetingId !== 'm-brief'))
check('按名称过滤', (await call('/history?query=' + encodeURIComponent('复盘'))).value.meetings.some((row) => row.meetingId === 'm-review'))
check('按实录文字过滤', (await call('/history?query=' + encodeURIComponent('上线风险'))).value.meetings.some((row) => row.meetingId === 'm-brief'))
check('按要点过滤', (await call('/history?query=' + encodeURIComponent('周五上线'))).value.meetings.some((row) => row.meetingId === 'm-brief'))
check('命中计数与摘要随行返回', history.value.meetings[0].counts.points === 1 && history.value.meetings[0].excerpt !== '')
check('空会议不出现在历史里', (await call('/history?limit=200')).value.meetings.every((row) => row.meetingId !== 'm-blank'))

// ---------------------------------------------------------------------------
// 4. 遗留结转
// ---------------------------------------------------------------------------
const carry = await call('/carryover?meetingId=m-brief')
check('晨会找到前一日复盘', carry.value.review !== null && carry.value.review.meetingId === 'm-review')
review.tasks = [
  { id: 'r1', title: '整理排期', owner: '张三', due: '', priority: 'normal', status: 'draft', origin: 'agent', done: false },
  { id: 'r2', title: '遗留：催合同', owner: '李四', due: '', priority: 'normal', status: 'draft', origin: 'agent', done: true },
  { id: 'r3', title: '已完成', owner: '王五', due: '', priority: 'normal', status: 'confirmed', origin: 'agent', done: true },
]
const carried = await call('/carryover?meetingId=m-brief')
check('未完成与标注遗留的都被结转', carried.value.items.length === 2 && carried.value.items.every((item) => item.meetingId === 'm-review'))

// ---------------------------------------------------------------------------
// 5. 跨会查询与写回
// ---------------------------------------------------------------------------
const byYesterday = await tools.queryMeetings({ kind: 'review', period: 'yesterday', include: ['tasks'] }, { agent: { session: { id: 'session-m-brief' } } })
check('周期别名查询命中昨日复盘', typeof byYesterday === 'string' && byYesterday.includes('m-review'))
const byPerson = await tools.queryMeetings({ person: '张三' }, { agent: { session: { id: 'session-m-brief' } } })
check('按人查询命中', typeof byPerson === 'string' && byPerson.includes('m-brief'))

const closed = await tools.writeAnalysis({ meetingId: 'm-brief', tasks: [{ id: 't1', done: true }] }, { agent: { session: { id: 'session-m-brief' } } })
check('跨会核销把任务标为完成', brief.tasks[0].done === true && typeof brief.tasks[0].doneAt === 'number')
check('核销会回一句确认', typeof closed === 'string' && closed.includes('m-brief'))
check('草稿状态不因完成而改变', brief.tasks[0].status === 'draft')
const historyDone = await call('/history?query=' + encodeURIComponent('晨会 · 排期'))
check('历史行带回完成统计（管理页核销列）', historyDone.value.meetings[0].counts.done === 1
  && historyDone.value.meetings[0].counts.tasks === brief.tasks.length)
seed('m-week', { kind: 'weekly', period: tools.periodOf('weekly', started), startedAt: started, title: '本周例会' })
seed('m-review-today', { kind: 'review', period: tools.periodOf('review', started), startedAt: started, title: '本周复盘' })
const thisWeek = await tools.queryMeetings({ period: 'this-week' })
check('本周别名跨类型命中晨会、复盘与例会', ['m-brief', 'm-review-today', 'm-week'].every((id) => thisWeek.includes(id)))
check('period 与 from/to 同时给会被拒绝', String(await tools.queryMeetings({ period: 'this-week', from: '2026-01-01' })).includes('互斥'))
check('非法日期不会悄悄滚到别的月份', String(await tools.queryMeetings({ from: '2026-13-40' })).includes('合法日期'))
check('ISO 周范围按周一到周日', (() => {
  const range = tools.periodRange('2026-W43')
  return range !== undefined && new Date(range.from).getDay() === 1 && new Date(range.to).getDay() === 0
})())

// ---------------------------------------------------------------------------
// 5b. 单条工作安排的发送（每条自己的按钮）
// ---------------------------------------------------------------------------
const unknownTask = await call('/push', { meetingId: 'm-brief', taskId: 'nope' }, 'POST')
check('指定不存在的工作安排被拒', unknownTask.status === 400 && String(unknownTask.value.error).includes('unknown task'))
const unconfirmed = await call('/push', { meetingId: 'm-brief', taskId: 't1' }, 'POST')
check('未确认的单条不能发送并说明原因', unconfirmed.status === 400 && String(unconfirmed.value.error).includes('确认'))
brief.tasks[0].status = 'confirmed'
const oneSent = await call('/push', { meetingId: 'm-brief', taskId: 't1' }, 'POST')
check('已确认的单条可以发送且报告条数', oneSent.status === 200 && oneSent.value.error === '' && oneSent.value.tasks === 1)
brief.tasks.push({ id: 't2', title: '另一件事', owner: '李四', due: '', priority: 'normal', status: 'confirmed', origin: 'agent', done: false })
const bothSent = await call('/push', { meetingId: 'm-brief' }, 'POST')
check('不带 taskId 时发送全部已确认的', bothSent.status === 200 && bothSent.value.tasks === 2)

// ---------------------------------------------------------------------------
// 5c. 历史会议（属于别的会话）也能确认并单条发送
// ---------------------------------------------------------------------------
seed('m-foreign', {
  sessionId: 's-someone-else',
  title: '别人会话里的会议',
  tasks: [{ id: 'f1', title: '跨会查看后要发的事', owner: '张三', due: '明天', priority: 'high', status: 'draft', origin: 'agent', done: false }],
})
const confirmForeign = await call('/analysis', { meetingId: 'm-foreign', kind: 'task', id: 'f1', op: 'update', patch: { status: 'confirmed' } }, 'POST')
check('别的会话的会议里也能确认任务', confirmForeign.status === 200 && meetings.get('m-foreign').tasks[0].status === 'confirmed')
const pushForeign = await call('/push', { meetingId: 'm-foreign', taskId: 'f1' }, 'POST')
check('历史会议的单条也能发送', pushForeign.status === 200 && pushForeign.value.tasks === 1 && pushForeign.value.error === '')
check('确认没有把内容改动写到本会话的会议上', brief.tasks.length === 2)

// ---------------------------------------------------------------------------
// 6. 评分与导出
// ---------------------------------------------------------------------------
const monthly = seed('m-month', { kind: 'monthly', period: tools.periodOf('monthly', started), title: '月度总结' })
await tools.writeAnalysis({
  meetingId: 'm-month',
  scores: [{ person: '张三', hours: 12, completion: 120, quality: 9, learn: 8, highlight: '交付稳', improve: '多同步', basis: ['m-brief#t1'] }],
}, { agent: { session: { id: 'session-m-month' } } })
const row = monthly.scores[0]
check('评分写入并把完成率夹紧在 100', row !== undefined && row.completion === 100 && row.quality === 9)
check('总分按权重计算', row.total === Math.round((9 * 0.4 + 100 * 0.4 + 8 * 0.2) * 10) / 10 || typeof row.total === 'number')
check('评分行是草稿', row.status === 'draft')
const csv = await call('/scores/export', { meetingId: 'm-month', format: 'csv' }, 'POST')
check('CSV 导出带表头与人名', csv.status === 200 && csv.value.content.includes('张三') && csv.value.content.includes('总分'))
const xlsx = await call('/scores/export', { meetingId: 'm-month', format: 'xlsx' }, 'POST')
if (!hasPython) {
  console.log('SKIP  Excel 导出（本机没有可用的 python 解释器）')
} else {
  check('Excel 导出是真正的 xlsx', xlsx.status === 200 && typeof xlsx.value.name === 'string' && xlsx.value.name.endsWith('.xlsx'), xlsx.value)
  const xlsxBytes = xlsx.status === 200 ? await fs.readFile(join(exportDirectory(), xlsx.value.name)).catch(() => Buffer.alloc(0)) : Buffer.alloc(0)
  check('xlsx 文件以 PK 开头', xlsxBytes.length > 4 && xlsxBytes.subarray(0, 2).toString() === 'PK')
}

// ---------------------------------------------------------------------------
// 6a. 评分的依据与权重（FEATURES §2.4）
// ---------------------------------------------------------------------------
const scoreCount = monthly.scores.length
const refusedScore = await tools.writeAnalysis({
  meetingId: 'm-month',
  scores: [{ person: '李四', quality: 8, completion: 50 }],
}, { agent: { session: { id: 'session-m-month' } } })
check('没有依据的评分被拒（不许凭空打分）', monthly.scores.length === scoreCount && String(refusedScore).includes('basis'))
check('被拒的评分在提示里说明原因', String(refusedScore).includes('refused'))
await call('/scores', { meetingId: 'm-month', person: '王五', op: 'add' }, 'POST')
const confirmBare = await call('/scores', { meetingId: 'm-month', person: '王五', patch: { status: 'confirmed' } }, 'POST')
check('缺依据的评分不能确认', confirmBare.status === 400 && String(confirmBare.value.error).includes('依据'))
const confirmWithBasis = await call('/scores', { meetingId: 'm-month', person: '王五', patch: { basis: ['实录 12:30 交付完成'], status: 'confirmed' } }, 'POST')
const wang = monthly.scores.find((entry) => entry.person === '王五')
check('填上依据后可以确认', confirmWithBasis.status === 200 && wang?.status === 'confirmed' && wang?.basis.length === 1)
const badWeights = await call('/webhooks', { scoreWeights: { quality: 40, completion: 40, learn: 30 } }, 'POST')
check('权重之和不是 100% 被拒', badWeights.status === 400 && String(badWeights.value.error).includes('100'))
const savedWeights = await call('/webhooks', { scoreWeights: { quality: 50, completion: 30, learn: 20 } }, 'POST')
const gotWeights = await call('/webhooks')
check('权重可保存为分数并回读', savedWeights.status === 200
  && Math.abs(Number(gotWeights.value.scoreWeights.quality) - 0.5) < 1e-9
  && Math.abs(Number(gotWeights.value.scoreWeights.learn) - 0.2) < 1e-9)
await call('/scores', { meetingId: 'm-month', person: '张三', patch: { quality: 10, completion: 100, learn: 0 } }, 'POST')
check('总分按保存后的权重重算', monthly.scores.find((entry) => entry.person === '张三')?.total === 80)
await call('/webhooks', { scoreWeights: { quality: 40, completion: 40, learn: 20 } }, 'POST')
check('权重可以恢复默认', tools.scoreTotal({ quality: 10, completion: 0, learn: 0 }) === 40)
const savedTemplates = await call('/webhooks', { templates: { briefing: '自定义：{meetingId} / {title}', review: '' } }, 'POST')
check('提炼模板可保存并回读', savedTemplates.status === 200
  && savedTemplates.value.templates.briefing === '自定义：{meetingId} / {title}'
  && (await call('/webhooks')).value.templates.briefing === '自定义：{meetingId} / {title}')
const longTemplate = await call('/webhooks', { templates: { briefing: 'x'.repeat(5000) } }, 'POST')
check('过长的模板被截断而不是整段存下', longTemplate.status === 200 && longTemplate.value.templates.briefing.length === 4000)
await call('/webhooks', { templates: {} }, 'POST')

// ---------------------------------------------------------------------------
// 6b. 推送工作安排
// ---------------------------------------------------------------------------
// A meeting of its own for the "nothing confirmed yet" case: section 5b already confirmed
// m-brief's assignment, and this check is about the state before any confirmation.
seed('m-push-draft', {
  title: '只有草稿任务',
  tasks: [{ id: 'd1', title: '还没确认的事', owner: '', due: '', priority: 'normal', status: 'draft', origin: 'agent', done: false }],
})
const refused = await call('/push', { meetingId: 'm-push-draft' }, 'POST')
check('没有已确认任务时推送被拒并说明原因', refused.status === 400 && String(refused.value.error).includes('确认'))
const attempted = await call('/push', { meetingId: 'm-brief' }, 'POST')
check('已确认任务时按设置的分发方式执行', attempted.status === 200 && typeof attempted.value.mode === 'string' && Array.isArray(attempted.value.results))
check('未配置机器人时每个目标都带回失败原因，而不是假成功', attempted.value.results.length > 0 && attempted.value.results.every((entry) => entry.ok === false && String(entry.message) !== ''))
check('未知会议推送返回 404', (await call('/push', { meetingId: 'nope' }, 'POST')).status === 404)

// ---------------------------------------------------------------------------
// 7. 纪要、下载
// ---------------------------------------------------------------------------
const md = await call('/minutes', { meetingId: 'm-brief', format: 'md' }, 'POST')
check('生成 Markdown 纪要并写明会议名称与类型', md.status === 200 && typeof md.value.content === 'string' && md.value.content.includes('晨会 · 排期') && md.value.content.includes('类型：晨会'))
const docx = await call('/minutes', { meetingId: 'm-brief', format: 'docx' }, 'POST')
check('生成 Word 纪要', docx.status === 200 && String(docx.value.name).endsWith('.docx'))
const download = await call('/download?name=' + encodeURIComponent(md.value.name))
check('下载接口以附件返回', download.status === 200 && String(download.headers['Content-Disposition'] ?? '').startsWith('attachment;'))
check('下载的中文名走 UTF-8 文件名', String(download.headers['Content-Disposition'] ?? '').includes('filename*=UTF-8'))
check('目录穿越被拒', (await call('/download?name=' + encodeURIComponent('../x.txt'))).status === 400)
check('缺失文件返回 404', (await call('/download?name=none.md')).status === 404)

// ---------------------------------------------------------------------------
// 7b. 会议工程包：打包 / 导入
// ---------------------------------------------------------------------------
const packaged = (() => {
  // Give the meeting a recording first, so the archive's audio path is exercised too.
  brief.audioName = 'smoke-recording.wav'
  return null
})() ?? await (async () => {
  await fs.mkdir(exportDirectory(), { recursive: true })
  await fs.writeFile(join(exportDirectory(), 'smoke-recording.wav'), Buffer.from('RIFF....WAVEfmt '))
  return call('/package?meetingId=m-brief')
})()
check('打包接口以附件返回 zip', packaged.status === 200
  && String(packaged.headers['Content-Type']).includes('zip')
  && String(packaged.headers['Content-Disposition']).startsWith('attachment;')
  && packaged.body.subarray(0, 2).toString() === 'PK')
const names = zipRead(packaged.body).map((entry) => entry.name)
check('包里含记录、清单与录音', names.includes('meeting.json') && names.includes('manifest.json') && names.some((name) => name.startsWith('audio/')))
const manifest = JSON.parse(zipRead(packaged.body).find((entry) => entry.name === 'manifest.json').data.toString('utf8'))
check('清单写明格式与版本', manifest.format === PACKAGE_FORMAT && typeof manifest.version === 'number')
const imported = await call('/import', undefined, 'POST') // no body: must be refused, not crash
check('空请求体导入被拒', imported.status === 400)
const restored = await importPackage(packaged.body)
check('导入得到新会议且不挂在会话上', restored.meetingId !== 'm-brief' && meetings.get(restored.meetingId)?.sessionId === '')
check('导入保留内容与发言人标签', meetings.get(restored.meetingId)?.tasks.length === brief.tasks.length
  && JSON.stringify(meetings.get(restored.meetingId)?.speakerLabels ?? []) === JSON.stringify(brief.speakerLabels ?? []))
check('导入记下来源会议', meetings.get(restored.meetingId)?.importedFrom === 'm-brief')
// A package from an older (or hand-made) version may miss arrays and carry a stale period;
// importing it must not hand the flush loop a record that throws (§2.2).
const rough = zipWrite([
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: PACKAGE_FORMAT, version: 1 })) },
  {
    name: 'meeting.json',
    data: Buffer.from(JSON.stringify({
      id: 'rough-1', sessionId: 's-rough', title: '旧包', kind: 'weekly', period: '1999-W01',
      startedAt: started, segments: null, points: null, tasks: 'oops', scores: null,
    })),
  },
])
const roughImported = await importPackage(rough)
const roughMeeting = meetings.get(roughImported.meetingId)
check('导入补齐缺失数组，坏记录不会拖垮落盘', roughMeeting !== undefined
  && Array.isArray(roughMeeting.segments) && Array.isArray(roughMeeting.points)
  && Array.isArray(roughMeeting.tasks) && Array.isArray(roughMeeting.scores))
check('导入按 startedAt 重算 period', roughMeeting?.period === tools.periodOf('weekly', started))
check('拒绝过多条目的压缩包', await importPackage(zipWrite(Array.from({ length: 2001 }, (_, index) => ({ name: `f${index}.txt`, data: Buffer.alloc(1) })))).then(() => false, (error) => String(error.message).includes('too many')))

// ---------------------------------------------------------------------------
// 7c. 版本信息（「关于」对话框读的就是它）
// ---------------------------------------------------------------------------
const version = await call('/version')
check('版本接口回插件自己的版本与作者', version.status === 200
  && typeof version.value.version === 'string' && version.value.version !== '0.0.0'
  && version.value.name === 'dsh-meeting-room'
  && String(version.value.author).includes('yangdaoquan@qq.com'))

// ---------------------------------------------------------------------------
// 7d. 模型注册表（M1）
// ---------------------------------------------------------------------------
const catalog = await call('/models')
check('模型接口列出内置目录与当前启用', catalog.status === 200
  && catalog.value.models.some((m) => m.id === 'speaker.campplus.zh-en.16k')
  && catalog.value.models.some((m) => m.id === 'handwriting.damo.line')
  && catalog.value.models.find((m) => m.id === 'asr.dsh.default').locked === true
  && typeof catalog.value.active.speaker === 'string')
check('模型接口报出目录与安装进度字段', typeof catalog.value.directory === 'string' && catalog.value.install !== undefined)
check('未安装的模型不能启用', (await call('/models/activate', { kind: 'speaker', id: 'speaker.campplus.zh-en.16k' }, 'POST')).status === 400)
check('未知模型不能被启用', (await call('/models/activate', { kind: 'speaker', id: 'nope' }, 'POST')).status === 400)
check('内置模型不能删除', (await call('/models/remove', { id: 'speaker.campplus.zh-en.16k' }, 'POST')).status === 400)
check('DSH 自己的模型不能导入', (await call('/models/import?id=asr.dsh.default&name=x', Buffer.from('x'), 'POST')).status === 400)

// A model someone added to models.json, installed by hand from a local file: the offline path.
const modelBytes = Buffer.from('这就是一个更强的本地模型'.repeat(128))
const modelDigest = createHash('sha256').update(modelBytes).digest('hex')
await fs.mkdir(join(process.env.DSH_HOME, 'meeting-room'), { recursive: true })
await fs.writeFile(join(process.env.DSH_HOME, 'meeting-room', 'models.json'), JSON.stringify({
  version: 1,
  models: [{
    id: 'speaker.test.large',
    kind: 'speaker',
    name: '测试用大模型',
    runtime: 'onnx',
    dir: 'meeting-room/models/speaker.test.large',
    source: { url: 'https://example.invalid/down/', mirrors: [] },
    files: [{ name: 'model.onnx', bytes: modelBytes.length, sha256: modelDigest }],
    languages: ['zh'],
    sizeClass: 'large',
  }],
  active: {},
}, null, 2))
const withCustom = await call('/models')
check('自定义模型出现在列表且标为未安装', withCustom.value.models.find((m) => m.id === 'speaker.test.large')?.verified === false)
check('内容不符的导入被拒（sha256）', (await call('/models/import?id=speaker.test.large&name=model.onnx', Buffer.from('别的字节'), 'POST')).status === 400)
const importedModel = await call('/models/import?id=speaker.test.large&name=model.onnx', modelBytes, 'POST')
check('按 sha256 校验的本地导入成功', importedModel.status === 200 && importedModel.value.verified === true, importedModel.value)
check('导入后可以启用', (await call('/models/activate', { kind: 'speaker', id: 'speaker.test.large' }, 'POST')).status === 200)
const activeNow = await call('/models')
check('启用后 active 指向它', activeNow.value.active.speaker === 'speaker.test.large')
check('启用后准备发言人会用这个模型', (await speakerModels.activeModel('speaker'))?.id === 'speaker.test.large')
check('正在使用的模型不能删除', (await call('/models/remove', { id: 'speaker.test.large' }, 'POST')).status === 400)
check('切回内置默认（清空选择）', (await call('/models/activate', { kind: 'speaker', id: '' }, 'POST')).status === 200)
const removedModel = await call('/models/remove', { id: 'speaker.test.large' }, 'POST')
check('自定义模型可以删除并报告文件数', removedModel.status === 200 && removedModel.value.removed === 1, removedModel.value)
check('删除后文件真的没了', !(await fs.readdir(join(process.env.DSH_HOME, 'meeting-room/models/speaker.test.large')).catch(() => [])).includes('model.onnx'))
check('坏条目被报出来而不是静默忽略', (await import(`${plugin}/host-models.js`)).validateModel({ id: 'x', kind: 'nope', name: 'y' }).error.includes('kind'))

// ---------------------------------------------------------------------------
// 7e. 云端识别与隐私开关（M2）
// ---------------------------------------------------------------------------
const http = await import('node:http')
const providers = await import(`${plugin}/host-providers.js`)
const CLOUD_KEY = 'sk-secret-abcdef123456'
let cloudHits = 0
let cloudAuth = ''
let cloudFails = false
const cloudServer = http.createServer((req, res) => {
  cloudHits += 1
  cloudAuth = String(req.headers.authorization ?? '')
  if (cloudFails) {
    // A service that echoes the key back: whatever it says must come out redacted.
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `bad key ${cloudAuth}` }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ text: '云端识别文本', model: 'test-cloud-model', duration: 1.5 }))
})
await new Promise((resolve) => cloudServer.listen(0, '127.0.0.1', resolve))
const cloudBase = `http://127.0.0.1:${cloudServer.address().port}/v1`
const cuePcm = Buffer.alloc(3200)

// 1) Consent off: the switch's promise is that nothing is sent at all.
await call('/cloud', { consent: false, asr: { provider: 'openai-compatible', baseUrl: cloudBase, model: 'test', apiKey: CLOUD_KEY } }, 'POST')
const skippedByConsent = await providers.cloudTranscribe({ pcm: cuePcm, sampleRate: 16000 })
check('未同意上传时一处请求都不发', skippedByConsent.skipped === true && cloudHits === 0, `hits=${cloudHits}`)

// 2) Consent on: the cloud text is used, and the key travels as a bearer token only.
await call('/cloud', { consent: true, asr: { provider: 'openai-compatible', baseUrl: cloudBase, model: 'test', apiKey: CLOUD_KEY } }, 'POST')
const answered = await providers.cloudTranscribe({ pcm: cuePcm, sampleRate: 16000 })
check('同意后云端识别回文本与模型', answered.skipped === false && answered.text === '云端识别文本' && answered.model === 'test-cloud-model', JSON.stringify(answered))
check('确实只发了一次请求', cloudHits === 1, `hits=${cloudHits}`)
check('密钥只作为 Bearer 头发送', cloudAuth === `Bearer ${CLOUD_KEY}`)
const cloudRead = await call('/cloud')
check('云接口不回显密钥，只说已设置', cloudRead.value.asr.keySet === true && !JSON.stringify(cloudRead.value).includes(CLOUD_KEY))
check('云接口把主机名摊开给用户看', cloudRead.value.asr.host === `127.0.0.1:${cloudServer.address().port}`, cloudRead.value.asr.host)
check('云接口带每分钟上限与超时说明', cloudRead.value.limits.perMinute === 60 && cloudRead.value.limits.timeoutMs === 20000)

// 3) Failures: the message is redacted, and after three in a row the plugin stops trying.
cloudFails = true
let failureMessage = ''
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    await providers.cloudTranscribe({ pcm: cuePcm, sampleRate: 16000 })
  } catch (failure) {
    failureMessage = failure instanceof Error ? failure.message : String(failure)
  }
}
check('云端失败消息里的密钥被脱敏', failureMessage.includes('sk-***') && !failureMessage.includes(CLOUD_KEY), failureMessage)
check('连续失败三次后标记为已回退', providers.cloudState.fallback === true)
const hitsBeforeFallback = cloudHits
const afterFallback = await providers.cloudTranscribe({ pcm: cuePcm, sampleRate: 16000 })
check('回退后不再发起任何请求', afterFallback.skipped === true && cloudHits === hitsBeforeFallback, `hits=${cloudHits}`)
check('回退原因不含密钥', !String(afterFallback.reason).includes(CLOUD_KEY))

// 4) The package must never carry a key, whatever the meeting holds.
const packedBytes = (await call('/package?meetingId=m-brief')).body
check('会议工程包里搜不到密钥', !packedBytes.includes(CLOUD_KEY))

// Leave the harness as it was found: fallback cleared, cloud off.
providers.resetCloudFallback()
await call('/cloud', { consent: false, asr: { provider: 'off', baseUrl: '', model: '', apiKey: '' } }, 'POST')
await new Promise((resolve) => cloudServer.close(resolve))

// ---------------------------------------------------------------------------
// 7f. 「开始记录」第一次点击就要有效
// ---------------------------------------------------------------------------
// A click was once spent because the panel believed speech was ready before its probe answered:
// it took the record-now path, failed on an unprepared model, and the person had to click again.
// Worse, a missing host route (the incomplete package) was caught and reported as `ready: true`.
// These assertions guard the exact places that lied.
const speechProbe = await call('/speech')
check('/speech 路由已注册（缺 host-*.js 时这里会 404）', speechProbe.status !== 404, `status=${speechProbe.status}`)
const routesSource = await fs.readFile(join(here, 'host-routes.js'), 'utf8')
check('宿主注册了 /speech 与 /speech/prepare', routesSource.includes("route === '/speech'") && routesSource.includes("route === '/speech/prepare'"))
const clientSource = await fs.readFile(join(here, 'client.js'), 'utf8')
check('客户端不再把探测失败当作就绪', !/catch\s*\{\s*return\s*\{\s*ready:\s*true/u.test(clientSource))
check('客户端初始状态不谎报就绪', !/useState\(\{\s*ready:\s*true/u.test(clientSource))
check('失败的路由请求带上 HTTP 状态（用来区分 404 与忙）', clientSource.includes('failure.status = response.status'))
check('准备过程对终态与停滞都有出口（不会空等十分钟）', clientSource.includes('setupPrepareStalled') && clientSource.includes("s.phase === 'missing'"))
// §5.1/§5.2/§5.5 的实际入口：这些名字或调用一旦被改掉，对应功能就会静默消失。
check('面板标题行含名称、类型与系列导航', clientSource.includes('titlerow') && clientSource.includes('series.prev') && clientSource.includes("saveMeta({ kind"))
check('四套一键提炼按钮都在', ['distillBriefing', 'distillReview', 'distillWeekly', 'distillMonthly'].every((key) => clientSource.includes(`${key}:`)))
check('本地提取接到 /extract', clientSource.includes("post('/extract'"))
check('命名弹窗有「临时会议」', clientSource.includes('kindAdhoc'))
check('管理页类型筛选有独立的全部', clientSource.includes('__all__') && clientSource.includes('hubAll'))
check('管理页可加载更早的会议', clientSource.includes('hubLoadMore') && clientSource.includes('offset='))
check('历史会议也能重新识别发言人', clientSource.includes('const id = viewing !== null ? viewing.meetingId : await ensureMeeting()'))
check('一键提炼使用设置里的模板', clientSource.includes('templates[meta.kind]') && clientSource.includes('custom === \'\''))
// §2.4 的评分输入：受控草稿，输入不被往返打断，失焦后以服务端夹紧后的值为准。
check('评分输入是受控草稿而不是 defaultValue', clientSource.includes('scoreValueOf(row.person') && clientSource.includes('commitScore(row.person')
  && !clientSource.includes("key: `hours-${row.hours"))
// 评分表的可访问性：表格/行/列头语义，且每个控件用自己的列名+人名做标签。
check('评分表有表格语义与逐控件标签', clientSource.includes("role: 'table'")
  && clientSource.includes("role: 'columnheader'") && clientSource.includes("role: 'rowheader'")
  && clientSource.includes('${t(\'scoreHours\')}：${row.person}'))
// 设置页按功能分 tab：六个分组各有自己的标签，且每块只在对应 tab 下渲染。
check('设置页按功能分成六个 tab', clientSource.includes('settingsTab, setSettingsTab')
  && ['push', 'cloud', 'transcript', 'speaker', 'weights', 'templates'].every((id) => clientSource.includes(`settingsTab !== '${id}' ? null`))
  && ['settingsTabPush', 'settingsTabCloud', 'settingsTabTranscript', 'settingsTabSpeaker', 'settingsTabWeights', 'settingsTabTemplates'].every((key) => clientSource.includes(`'${key}'`)))
check('会议记录页提示上次会议主题', clientSource.includes("key: 'lasttopic'") && clientSource.includes("t('hubLastTopic')"))
// 停止录音要收尾（补识别 + 全量重判），这段等待必须有提示，否则像卡住。
check('停止录音的收尾等待有 toast', clientSource.includes("toast(t('stopFinishing'), { sticky: true })")
  && clientSource.includes("t('stopRemaining')") && clientSource.includes("t('stopFinished')")
  && clientSource.includes("item.sticky === true") && clientSource.includes('clearInterval(ticker)'))

// ---------------------------------------------------------------------------
// 7g. M3：阈值可调、全量重判、跨会议声纹库（建议姓名需人确认）
// ---------------------------------------------------------------------------
const voices = await import(`${plugin}/host-voices.js`)
const speakerSettings = await call('/speaker/settings')
check('发言人设置给出默认阈值与全量重判', speakerSettings.status === 200
  && speakerSettings.value.speaker.threshold === 0.6
  && speakerSettings.value.speaker.fullRelabel === true
  && Array.isArray(speakerSettings.value.presets) && speakerSettings.value.presets.length === 3)
check('默认补标计划是全量（不再卡 60 条）', JSON.stringify(await voices.relabelPlan()) === '{"all":true}')
const planOff = (await import(`${plugin}/host-constants.js`)).relabelPlanOf({ fullRelabel: false, backfillCap: 12 })
check('关掉全量后按上限补标', JSON.stringify(planOff) === '{"limit":12}')
const thresholdSet = await call('/speaker/settings', { threshold: 0.7, fullRelabel: false, backfillCap: 5 }, 'POST')
check('阈值与补标方式可写入并回读', thresholdSet.status === 200
  && thresholdSet.value.speaker.threshold === 0.7
  && thresholdSet.value.speaker.fullRelabel === false
  && (await call('/speaker/settings')).value.speaker.backfillCap === 5)
check('越界阈值被夹到合法区间', (await call('/speaker/settings', { threshold: 5 }, 'POST')).value.speaker.threshold <= 0.95)
await call('/speaker/settings', { threshold: 0.6, fullRelabel: true, backfillCap: 60 }, 'POST')

// The library learns ONLY from a name a person gave, and suggests without ever writing.
const encodeVector = (values) => Buffer.from(Float32Array.from(values).buffer).toString('base64')
const voiceA = [1, 0.1, 0, 0, 0, 0, 0, 0]
const voiceNear = [0.98, 0.12, 0.01, 0, 0, 0, 0, 0]
const voiceFar = [0, 0, 0, 0, 0, 1, 0.1, 0]
seed('m-voice', {
  segments: [{ id: 'v1', start: 0, end: 2, text: '甲说话', speaker: 'S1', embedding: encodeVector(voiceA) }],
  speakerLabels: ['S1'],
})
check('命名之前，库里没有东西', (await call('/voices')).value.voices.length === 0)
const named = await call('/speaker/name', { meetingId: 'm-voice', label: 'S1', name: '张三' }, 'POST')
check('命名会把这条声音学进库（人名来自人）', named.status === 200 && named.value.learned?.name === '张三', JSON.stringify(named.value.learned))
const library = await call('/voices')
check('声纹库只回姓名与次数，不回向量', library.value.voices.length === 1
  && library.value.voices[0].name === '张三'
  && !JSON.stringify(library.value).includes('vector'))
const nearMeeting = seed('m-voice-near', {
  segments: [{ id: 'v2', start: 0, end: 2, text: '又一个声音', speaker: 'S1', embedding: encodeVector(voiceNear) }],
  speakerLabels: ['S1'],
})
const nearState = await call('/state?meetingId=m-voice-near')
check('相近声音被建议为同一个人', Array.isArray(nearState.value.suggestions)
  && nearState.value.suggestions.some((item) => item.label === 'S1' && item.name === '张三'))
check('建议不会自动写入姓名（必须人确认）', Object.keys(nearMeeting.speakers).length === 0 && nearState.value.speakers.S1 === undefined)
seed('m-voice-far', {
  segments: [{ id: 'v3', start: 0, end: 2, text: '陌生声音', speaker: 'S1', embedding: encodeVector(voiceFar) }],
  speakerLabels: ['S1'],
})
check('差得远的声音不会被乱猜', (await call('/state?meetingId=m-voice-far')).value.suggestions.length === 0)
check('声纹库可以删掉一个人', (await call('/voices/remove', { name: '张三' }, 'POST')).value.voices.length === 0)
check('删错人回报 404', (await call('/voices/remove', { name: '李四' }, 'POST')).status === 404)
await call('/speaker/name', { meetingId: 'm-voice', label: 'S1', name: '张三' }, 'POST')
check('清空声纹库', (await call('/voices/clear', {}, 'POST')).value.removed === 1 && (await call('/voices')).value.voices.length === 0)
// Nothing vector-shaped may reach a package or the persisted record.
await call('/speaker/name', { meetingId: 'm-voice', label: 'S1', name: '张三' }, 'POST')
const voicePackage = await call('/package?meetingId=m-voice')
const packedRecord = zipRead(voicePackage.body).find((entry) => entry.name === 'meeting.json').data.toString('utf8')
check('会议记录不落 embedding 与质心', !packedRecord.includes('embedding') && !packedRecord.includes('voiceCentroids'))
check('会议记录仍保留发言人姓名与标签', packedRecord.includes('张三') && packedRecord.includes('S1'))

// ---------------------------------------------------------------------------
// 7h. M4：数字日期规整、切句参数可调
// ---------------------------------------------------------------------------
const textTools = await import(`${plugin}/host-text.js`)
check('中文数字读得对', textTools.chineseNumber('十五') === 15 && textTools.chineseNumber('二十四') === 24 && textTools.chineseNumber('三百零五') === 305)
check('数字写得像人写的', textTools.numeralOf(15) === '十五' && textTools.numeralOf(105) === '一百零五')
check('规整把日期、百分比、金额写成平时写法', textTools.normalizeText('二零二六年十月十九号') === '2026年10月19日'
  && textTools.normalizeText('完成百分之三十') === '完成30%'
  && textTools.normalizeText('预算三千五百元') === '预算3500元'
  && textTools.normalizeText('下午三点半') === '下午3点半')
check('规整不碰人名与版本号', textTools.normalizeText('张三和李四都在') === '张三和李四都在'
  && textTools.normalizeText('版本二点零') === '版本二点零'
  && textTools.normalizeText('十年之前') === '十年之前')
check('关掉规则后一字不动', textTools.normalizeText('二零二六年十月十九号', []) === '二零二六年十月十九号')

const transcriptRead = await call('/transcript')
check('实录设置给出默认规整与切句参数', transcriptRead.status === 200
  && transcriptRead.value.transcript.normalize === true
  && transcriptRead.value.transcript.maxChunkSeconds === 12
  && transcriptRead.value.transcript.maxLineChars === 60
  && Array.isArray(transcriptRead.value.rules) && transcriptRead.value.rules.length >= 5)
check('实录设置诚实报告本机是否有语音能力', typeof transcriptRead.value.local === 'boolean')
const transcriptWrite = await call('/transcript', { normalize: false, minChunkSeconds: 0.8, maxChunkSeconds: 12, silenceHoldSeconds: 0.3, maxLineChars: 40 }, 'POST')
check('切句参数可写入并回读', transcriptWrite.status === 200
  && transcriptWrite.value.transcript.maxChunkSeconds === 12
  && transcriptWrite.value.transcript.silenceHoldSeconds === 0.3
  && transcriptWrite.value.transcript.maxLineChars === 40
  && (await call('/transcript')).value.transcript.minChunkSeconds === 0.8)
check('每行字数越界会被夹住', (await call('/transcript', { maxLineChars: 999 }, 'POST')).value.transcript.maxLineChars === 200)
check('越界的切句参数被夹到合法区间', (await call('/transcript', { maxChunkSeconds: 999, silenceRms: 99 }, 'POST')).value.transcript.maxChunkSeconds <= 30)
check('最短大于最长时自动对齐', (await call('/transcript', { minChunkSeconds: 9, maxChunkSeconds: 3 }, 'POST')).value.transcript.maxChunkSeconds >= 9)
check('不认识的规整规则被丢弃', (await call('/transcript', { normalizeRules: ['percent', '不存在'] }, 'POST')).value.transcript.normalizeRules.length === 1)
await call('/transcript', { normalize: true, normalizeRules: textTools.DEFAULT_RULES, minChunkSeconds: 1.2, maxChunkSeconds: 12, silenceRms: 0.012, silenceHoldSeconds: 0.7, maxLineChars: 60 }, 'POST')
const clientForM4 = await fs.readFile(join(here, 'client.js'), 'utf8')
check('浏览器半边的切句参数来自设置而不是写死', clientForM4.includes('applyCueSettings') && clientForM4.includes('CUES.maxSeconds'))
check('规整结果与被识别的原文并存', (await fs.readFile(join(here, 'host-tools.js'), 'utf8')).includes('segment.normalised = normalised'))

// ---------------------------------------------------------------------------
// 8. Agent 工具
// ---------------------------------------------------------------------------
const agent = { agent: { session: { id: 'session-m-brief' } } }
const read = await tools.readTranscript({}, agent)
check('meeting_read 带抬头与 #id', typeof read === 'string' && read.includes('m-brief') && read.includes('#t1'))
const wrote = await tools.writeAnalysis({ meetingId: 'm-brief', points: [{ kind: 'risk', text: '合同未盖章', quote: '今天先排掉上线风险' }] }, agent)
check('meeting_write 落库要点', brief.points.some((point) => point.text === '合同未盖章') && typeof wrote === 'string')
const noted = await tools.writeNote({ text: '记一笔：合同要催' }, agent)
check('meeting_note_write 落库笔记', brief.notes.some((note) => note.text.includes('合同要催')) && typeof noted === 'string')
const saved = await tools.saveDocument({ kind: 'review', title: '复盘（冒烟）', markdown: '# 复盘\n内容' }, agent)
check('meeting_save_document 落库文档', brief.documents.some((doc) => doc.title === '复盘（冒烟）') && typeof saved === 'string')
const revised = await tools.reviseTranscript({ corrections: [{ id: 'c1', text: '今天先排掉上线风险（已订正）' }] }, agent)
check('meeting_revise 留下订正与对照', brief.segments[0].revised !== undefined && brief.revisions.length === 1 && typeof revised === 'string')
const recipe = tools.distillForSession({}, agent)
check('meeting_distill 给出配方', typeof recipe === 'string' && recipe.includes('meeting_read') && recipe.includes('m-brief'))

// meeting-scribe 的两块地基：会议状态工具 + 句子续接（供 5 分钟循环判断收尾）。
const scribeMeeting = seed('m-scribe', { sessionId: 'session-scribe', title: '周例会' })
const scribeAgent = { agent: { session: { id: 'session-scribe' } } }
const scribeStatus = tools.meetingSession({ action: 'status' }, scribeAgent)
check('meeting_session 报告录音状态与条数', typeof scribeStatus === 'string'
  && scribeStatus.includes('录音：已停止') && scribeStatus.includes('m-scribe'))
const scribeCreated = tools.meetingSession({ action: 'create', title: '十月周例会', kind: 'weekly' }, scribeAgent)
check('meeting_session 可命名并设类型且重算周期', scribeMeeting.title === '十月周例会'
  && scribeMeeting.kind === 'weekly' && scribeMeeting.period === tools.periodOf('weekly', scribeMeeting.startedAt)
  && scribeCreated.includes('会议名称与类型已保存'))
const scribeMissing = tools.meetingSession({ action: 'status' }, { agent: { session: { id: 'session-none' } } })
check('没有会议时 meeting_session 给出可操作提示', scribeMissing.includes('还没有会议记录'))

// 不带参数直接开始：create 自己建会，record 只留请求给面板（麦克风仍在浏览器里）。
const freshScribe = { agent: { session: { id: 'session-scribe-new' } } }
const autoCreated = tools.meetingSession({ action: 'create' }, freshScribe)
const sessionsModule = await import(`${plugin}/host-sessions.js`)
const autoMeeting = sessionsModule.meetingForSession('session-scribe-new')
check('meeting_session 不带参数也能建会', autoMeeting !== undefined && autoCreated.includes('会议：'))
const autoRecord = tools.meetingSession({ action: 'record' }, freshScribe)
check('record 只留请求，不假装已开麦', autoRecord.includes('已请求开始录音')
  && typeof autoMeeting.recordRequestedAt === 'number' && autoMeeting.audioHandle === undefined)
const recordRoute = await call('/record?sessionId=session-scribe-new')
check('面板可读到开始录音请求', recordRoute.status === 200 && recordRoute.value.request > 0
  && recordRoute.value.meetingId === autoMeeting.id)
const clearedRoute = await call('/record', { sessionId: 'session-scribe-new' }, 'POST')
check('面板领取后请求被清除', clearedRoute.value.cleared === true && autoMeeting.recordRequestedAt === undefined)

// 人点「开始记录」时，录音之外还要让 agent 自己开工：/start 向该会话投一条普通 prompt。
const prompted = []
const nudgeCtx = {
  logger: ctx.logger,
  get: (name) => (name === 'sessionController' ? { prompt: async (request) => { prompted.push(request) } } : undefined),
}
const nudgeHandler = createHandler(nudgeCtx)
const manualStart = await call('/start', { sessionId: 'session-nudge' }, 'POST', nudgeHandler)
check('面板点开始会让 agent 开始工作', manualStart.status === 200 && prompted.length === 1
  && prompted[0].sessionId === 'session-nudge' && prompted[0].content[0].text.includes('meeting-scribe'))
const autoStart = await call('/start', { sessionId: 'session-nudge-auto', auto: true }, 'POST', nudgeHandler)
check('agent 自己请求的开录不重复通知', autoStart.status === 200 && prompted.length === 1)

const fragmentMeeting = seed('m-merge', { segments: [
  { id: '1', start: 0, end: 2, text: '我们下周', speaker: 'S1' },
  { id: '2', start: 2.3, end: 4.1, text: '把方案交上来', speaker: 'S1' },
] })
check('未说完的句子被并成一句', tools.mergeContinuation(fragmentMeeting, 1) === true
  && fragmentMeeting.segments.length === 1
  && fragmentMeeting.segments[0].text === '我们下周把方案交上来'
  && fragmentMeeting.segments[0].end === 4.1)
const finishedMeeting = seed('m-merge-stop', { segments: [
  { id: '1', start: 0, end: 2, text: '方案定了。', speaker: 'S1' },
  { id: '2', start: 2.2, end: 4, text: '明天发出去', speaker: 'S1' },
] })
check('已收句的不会并到下一句', tools.mergeContinuation(finishedMeeting, 1) === false && finishedMeeting.segments.length === 2)
const scribeSkill = await import(`${plugin}/skill-meeting-scribe.js`)
check('meeting-scribe 技能说明包含 5 分钟循环与自动停止', scribeSkill.MEETING_SCRIBE_SKILL.content.includes('300')
  && scribeSkill.MEETING_SCRIBE_SKILL.content.includes('schedule_delete')
  && scribeSkill.MEETING_SCRIBE_SKILL.content.includes('meeting_session'))
check('技能在插件激活时注册到 skills 服务', (await fs.readFile(join(here, 'index.js'), 'utf8')).includes('skills.register(MEETING_SCRIBE_SKILL)'))
check('技能写明可无参数开始并按前 5 分钟命名', scribeSkill.MEETING_SCRIBE_SKILL.content.includes('不带任何参数')
  && scribeSkill.MEETING_SCRIBE_SKILL.content.includes('action:"record"')
  && scribeSkill.MEETING_SCRIBE_SKILL.content.includes('第一轮') && scribeSkill.MEETING_SCRIBE_SKILL.content.includes('6–16 字'))

// 语速快时一个 cue 里会有好几句：按标点拆行，云端的 segment 边界优先。
const lineTools = await import(`${plugin}/host-tools.js`)
const pieces = lineTools.sentenceParts('第一件事是预算。第二件事是排期，第三件事是人手，都要今天定下来。', 20)
check('长句按句号与逗号拆成不超过上限的行', pieces.length >= 3
  && pieces.every((piece) => piece.length <= 26)
  && pieces.some((piece) => piece.includes('预算')))
const splitMeeting = seed('m-split', { segments: [
  { id: '9', start: 0, end: 6, text: '第一句。第二句。第三句。', speaker: 'S1', embedding: 'vec' },
] })
const splitCount = lineTools.splitCueIntoSentences(splitMeeting, 0, { maxChars: 60 })
check('一个 cue 拆成多行且保留发言人与时间范围', splitCount === 3
  && splitMeeting.segments.length === 3
  && splitMeeting.segments[0].id === '9.1'
  && splitMeeting.segments[2].text === '第三句。'
  && splitMeeting.segments.every((segment) => segment.speaker === 'S1' && segment.embedding === 'vec')
  && splitMeeting.segments[0].start === 0 && splitMeeting.segments[2].end === 6)
const hintMeeting = seed('m-hint', { segments: [
  { id: 'h', start: 10, end: 16, text: '云端整段文本', speaker: 'S2' },
] })
check('云端 segment 时间被优先采用', lineTools.splitCueIntoSentences(hintMeeting, 0, {
  hints: [{ start: 0, end: 2.5, text: '云端第一句。' }, { start: 2.5, end: 6, text: '云端第二句。' }],
}) === 2 && hintMeeting.segments[0].start === 10 && hintMeeting.segments[0].end === 12.5
  && hintMeeting.segments[1].start === 12.5 && hintMeeting.segments[1].end === 16)
check('单句不会被拆开', lineTools.sentenceParts('短句。', 60).length === 1)
const normMeeting = seed('m-norm', { segments: [
  { id: 'n', start: 0, end: 4, text: '完成百分之三十。再谈预算。' },
] })
lineTools.splitCueIntoSentences(normMeeting, 0, { maxChars: 60, normalizeRules: textTools.DEFAULT_RULES })
check('拆分后数字规整跟着每一行走', normMeeting.segments.length === 2
  && normMeeting.segments[0].text === '完成百分之三十。'
  && normMeeting.segments[0].normalised === '完成30%。')

// ---------------------------------------------------------------------------
// 9. 持久化
// ---------------------------------------------------------------------------
// A name is content: a meeting the person named must survive even without a recording,
// while a genuinely blank one stays out of the store (FEATURES §5.5).
seed('m-named', { title: '只命名没录' })
const flushed = await persistence.flushMeetings(ctx)
const files = await fs.readdir(join(tmp, 'meeting-room', 'meetings')).catch(() => [])
check('flush 如实回报写了几个、失败几条', typeof flushed.written === 'number' && Array.isArray(flushed.failed) && flushed.failed.length === 0)
check('有内容的会议落盘', files.includes('m-brief.json'))
check('只命名不录也落盘', files.includes('m-named.json'))
check('空会议不落盘', !files.includes('m-blank.json'))
const stored = JSON.parse(await fs.readFile(join(tmp, 'meeting-room', 'meetings', 'm-brief.json'), 'utf8'))
check('落盘保留要点、任务、笔记与订正', stored.points.length >= 1 && stored.tasks.length >= 1 && stored.notes.length >= 1 && stored.revisions.length === 1)
meetings.clear()
await persistence.restoreMeetings(ctx)
check('重启后恢复会议', meetings.has('m-brief') && meetings.get('m-brief').tasks.length >= 1)

await fs.rm(tmp, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 0. 发布清单：装出去的包里必须带齐代码
// ---------------------------------------------------------------------------
// A published package once shipped without `host-*.js`: `files` listed only a few of them, so
// the host half died at import time on the user's machine while every local test passed — the
// files were all present here. This walks the real dependency graph and insists that the
// manifest covers it, which is the only check that would have caught it.
const publishManifest = JSON.parse(await fs.readFile(join(here, 'package.json'), 'utf8'))

/** The subset of glob syntax npm's `files` uses: `*` inside one path segment. */
function coveredByFiles(relative) {
  const target = relative.replace(/\\/gu, '/')
  return (publishManifest.files ?? []).some((pattern) => {
    const expression = pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replace(/\*/gu, '[^/]*')
    return new RegExp(`^${expression}$`, 'u').test(target)
  })
}

/** Every relative specifier one file imports. */
async function relativeImportsOf(file) {
  const text = await fs.readFile(join(here, file), 'utf8')
  const found = new Set()
  for (const match of text.matchAll(/from\s+'(\.[^']+)'/gu)) found.add(match[1].replace(/^\.\//u, ''))
  for (const match of text.matchAll(/import\(\s*`\$\{plugin\}\/([^`]+)`\s*\)/gu)) found.add(match[1])
  return [...found]
}

const shipped = new Set(['index.js', 'client.js', 'package.json', 'cordis.patch.yml'])
for (const file of await fs.readdir(here)) {
  if (/\.(js|mjs|py)$/u.test(file)) shipped.add(file)
  if (file === 'locale') for (const inner of await fs.readdir(join(here, 'locale'))) shipped.add(`locale/${inner}`)
}
const missingFromFiles = []
for (const file of shipped) {
  for (const specifier of await relativeImportsOf(file)) {
    if (specifier.startsWith('node:')) continue
    // A bare specifier is a dependency, not a file of this package.
    if (!specifier.startsWith('.') && !specifier.endsWith('.js') && !specifier.endsWith('.json')) continue
    const target = specifier.replace(/^\.\//u, '')
    if (!coveredByFiles(target)) missingFromFiles.push(`${file} → ${specifier}`)
  }
}
check('发布清单覆盖 index.js 引用的每个兄弟模块', missingFromFiles.length === 0, missingFromFiles.join(' | '))
check('发布清单用通配覆盖 host-*.js', coveredByFiles('host-routes.js') && coveredByFiles('host-constants.js'))
check('发布清单覆盖客户端与两个 worker', coveredByFiles('client.js') && coveredByFiles('speaker-worker.js') && coveredByFiles('handwriting-worker.js'))
check('发布清单漏掉的文件一个都没有（逐文件核对）', (await fs.readdir(here)).filter((file) => /\.js$/u.test(file) && !coveredByFiles(file)).length === 0,
  (await fs.readdir(here)).filter((file) => /\.js$/u.test(file) && !coveredByFiles(file)).join(', '))

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) console.log('failed:', failed.map(([name]) => name).join(' | '))
process.exitCode = failed.length > 0 ? 1 : 0
