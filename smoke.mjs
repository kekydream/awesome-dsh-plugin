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

const { meetings } = await import(`${plugin}/host-constants.js`)
const tools = await import(`${plugin}/host-tools.js`)
const sessions = await import(`${plugin}/host-sessions.js`)
const persistence = await import(`${plugin}/host-persistence.js`)
const { createHandler } = await import(`${plugin}/host-routes.js`)
const { exportDirectory } = await import(`${plugin}/host-helpers.js`)

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
async function call(route, body, method = 'GET') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
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
  await handler(req, res)
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
const owned = sessions.ensureMeetingForSession(ctx, { id: 's-root', header: { createdAt: started } })
check('一个会话建出且只建出一场会议', owned !== undefined && sessions.ensureMeetingForSession(ctx, { id: 's-root', header: {} })?.id === owned.id)
check('同一会话再问一次不会多建', [...meetings.values()].filter((m) => m.sessionId === 's-root').length === 1)
check('子代理会话不单独建会议', sessions.ensureMeetingForSession(ctx, { id: 's-sub', header: { origin: 'subagent', delegationDepth: 1 } }) === undefined)
check('分支会话（depth 0）另建一场', sessions.ensureMeetingForSession(ctx, { id: 's-fork', header: { createdAt: started, parentSession: 's-root' } })?.sessionId === 's-fork')
sessions.reapMeetingForSession('s-fork')
check('空会议回收后不再有记录', ![...meetings.values()].some((m) => m.sessionId === 's-fork'))

// ---------------------------------------------------------------------------
// 2. 元数据：类型 / 周期 / 角色 / 名称
// ---------------------------------------------------------------------------
check('日周期', tools.periodOf('briefing', started) === new Date(started).toLocaleDateString('sv-SE'))
check('ISO 周周期', /^\d{4}-W\d{2}$/.test(tools.periodOf('weekly', started)))
check('月周期', /^\d{4}-\d{2}$/.test(tools.periodOf('monthly', started)))
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
seed('m-blank', { startedAt: started - 2 * day, title: '临时碰头' })

const history = await call('/history?limit=2')
check('历史按最近优先', history.value.meetings.length === 2 && history.value.meetings[0].meetingId === 'm-brief')
check('历史返回总条数', history.value.total >= 3)
check('历史分页不重叠', (await call('/history?limit=2&offset=2')).value.meetings.every((row) => row.meetingId !== 'm-brief'))
check('按名称过滤', (await call('/history?query=' + encodeURIComponent('复盘'))).value.meetings.some((row) => row.meetingId === 'm-review'))
check('按实录文字过滤', (await call('/history?query=' + encodeURIComponent('上线风险'))).value.meetings.some((row) => row.meetingId === 'm-brief'))
check('按要点过滤', (await call('/history?query=' + encodeURIComponent('周五上线'))).value.meetings.some((row) => row.meetingId === 'm-brief'))
check('命中计数与摘要随行返回', history.value.meetings[0].counts.points === 1 && history.value.meetings[0].excerpt !== '')
check('无内容会议标记为空', (await call('/history?query=' + encodeURIComponent('临时碰头'))).value.meetings[0].hasContent === false)

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

// ---------------------------------------------------------------------------
// 9. 持久化
// ---------------------------------------------------------------------------
await persistence.flushMeetings(ctx)
const files = await fs.readdir(join(tmp, 'meeting-room', 'meetings')).catch(() => [])
check('有内容的会议落盘', files.includes('m-brief.json'))
check('空会议不落盘', !files.includes('m-blank.json'))
const stored = JSON.parse(await fs.readFile(join(tmp, 'meeting-room', 'meetings', 'm-brief.json'), 'utf8'))
check('落盘保留要点、任务、笔记与订正', stored.points.length >= 1 && stored.tasks.length >= 1 && stored.notes.length >= 1 && stored.revisions.length === 1)
meetings.clear()
await persistence.restoreMeetings(ctx)
check('重启后恢复会议', meetings.has('m-brief') && meetings.get('m-brief').tasks.length >= 1)

await fs.rm(tmp, { recursive: true, force: true })
const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) console.log('failed:', failed.map(([name]) => name).join(' | '))
process.exitCode = failed.length > 0 ? 1 : 0