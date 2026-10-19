/**
 * Shared constants and module-level state for the meeting-room host plugin.
 *
 * Extracted from index.js so that other modules in this package can reference
 * the same values without circular imports.
 */
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Route prefix owned by this plugin. */
export const PREFIX = '/meeting-room'

/** Accepted request body ceiling; one 8-second 16 kHz mono PCM16 cue is ~256 KB. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Ceiling for one exported artifact. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024

/** Exported files per request. */
export const MAX_ARTIFACTS = 8

/** Sample rate the browser half sends. */
export const SAMPLE_RATE = 16000

/** Accepted artifact name: one path segment, first character alphanumeric, no traversal. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Pinned speaker-embedding model: 3D-Speaker CAM++, Chinese/English, 16 kHz. */
export const SPEAKER_MODEL = {
  name: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  bytes: 28281138,
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
}

/**
 * Origins tried in order for the pinned model. The sherpa models are GitHub release
 * assets, so the Hugging Face mirror the speech provider uses does not cover them, and
 * mainland networks routinely drop direct github.com transfers; the public proxies are
 * the same ones the plugin market uses.
 */
export const SPEAKER_MODEL_ORIGINS = [
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
  'https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/',
]

/** Cosine similarity above which a cue joins an existing speaker instead of creating one. */
export const SPEAKER_THRESHOLD = 0.6

/**
 * Similarity above which a label is offered as "this sounds like …" from the voice library.
 * Higher than the clustering threshold on purpose: suggesting the WRONG name is worse than
 * suggesting none, because a wrong suggestion costs a correction every single time.
 */
export const VOICE_MATCH_THRESHOLD = 0.75

/** Threshold presets the interface offers, each with the reason it exists. */
export const SPEAKER_THRESHOLD_PRESETS = [
  { id: 'crowd', threshold: 0.7, note: '人多：更严格，宁可多分几个声音，也不把两个人合成一个' },
  { id: 'default', threshold: 0.6, note: '默认：通用会议' },
  { id: 'few', threshold: 0.5, note: '人少：更宽松，同一个人语气变化大时不容易被拆开' },
]

/**
 * How the end-of-meeting speaker pass should limit itself.
 *
 * Pure, so both the stop path (which already holds the settings) and the voice module can ask
 * the same question without either importing the other.
 * @param speakerSettings - the `speaker` section of the settings, if any.
 * @returns `{ all: true }` for a full relabel, or `{ limit }` for a capped tail pass.
 */
export function relabelPlanOf(speakerSettings) {
  const full = speakerSettings === null || typeof speakerSettings !== 'object' || speakerSettings.fullRelabel !== false
  if (full) return { all: true }
  const cap = Number(speakerSettings.backfillCap)
  return { limit: Number.isFinite(cap) && cap > 0 ? Math.round(cap) : SPEAKER_BACKFILL_CAP }
}

/**
 * How many unlabeled cues the end-of-meeting pass may backfill from the finished
 * recording. The speaker worker is serial, and a first-ever meeting can outrun the
 * model download by hundreds of cues; the cap keeps "stop" instant while the rest
 * stays unlabeled (the panel's re-identify action can redo the whole meeting).
 */
export const SPEAKER_BACKFILL_CAP = 60

/**
 * How often one process may bring the speaker worker back after an unexpected exit.
 * A crashed worker must not end labeling for the rest of a meeting, but a worker that
 * keeps dying (a broken model, a missing runtime) must not become a respawn loop.
 */
export const SPEAKER_WORKER_RESTARTS = 3

/** Meeting kinds a record may carry; '' is the general meeting. */
export const MEETING_KINDS = ['', 'briefing', 'review', 'weekly', 'monthly']

/**
 * Period granularity per kind: the daily meetings bucket by day, the weekly meeting by
 * ISO week (Monday-based), the monthly by month; the general meeting has no period.
 */
export const KIND_PERIOD_UNITS = { briefing: 'day', review: 'day', weekly: 'week', monthly: 'month' }

/** Meeting windows the cross-meeting query returns by default, and its ceiling. */
export const DEFAULT_QUERY_LIMIT = 20
export const MAX_QUERY_LIMIT = 100

/**
 * Default weights behind one score row's total (FEATURES §2.4): work quality and task
 * completion carry 40% each, participation in learning 20%. Quality and learning are
 * 1–10 and read as percentages; completion is already a percentage.
 */
export const SCORE_WEIGHTS = { quality: 0.4, completion: 0.4, learn: 0.2 }

/**
 * The weights actually in force (FEATURES §2.4, P4): the stored setting when one exists,
 * the defaults otherwise. Kept as module state so `scoreTotal` — a pure function used by
 * the tools and the routes alike — computes the same total everywhere.
 */
export const scoreWeights = { ...SCORE_WEIGHTS }

/** The keys a stored weight may carry, in the order the panel shows them. */
export const SCORE_WEIGHT_KEYS = ['quality', 'completion', 'learn']

/**
 * Replace the weights in force. Values are normalised to sum to 1, so a caller that stores
 * percentages (40 / 40 / 20) and one that stores fractions (0.4 / 0.4 / 0.2) agree; a
 * value set that is not three finite, non-negative numbers leaves the current weights
 * untouched rather than silently scoring everyone zero.
 * @param next - the candidate weights, keyed quality / completion / learn.
 * @returns the weights now in force.
 */
export function setScoreWeights(next) {
  const values = SCORE_WEIGHT_KEYS.map((key) => (next !== null && typeof next === 'object' ? Number(next[key]) : Number.NaN))
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) return { ...scoreWeights }
  const sum = values.reduce((total, value) => total + value, 0)
  if (!(sum > 0)) return { ...scoreWeights }
  SCORE_WEIGHT_KEYS.forEach((key, index) => { scoreWeights[key] = values[index] / sum })
  return { ...scoreWeights }
}

/** Point kinds the model may use; anything else is stored as a plain point. */
export const POINT_KINDS = ['decision', 'point', 'risk', 'question']

/** Task priorities the model may use; anything else is stored as normal. */
export const TASK_PRIORITIES = ['high', 'normal', 'low']

/** This package's own directory, used to locate the worker beside this file. */
export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** Default cue ceiling returned by the transcript tool. */
export const DEFAULT_CUE_LIMIT = 400

/** Largest cue ceiling the tool accepts. */
export const MAX_CUE_LIMIT = 4000

/** In-memory meetings, keyed by meeting id. */
export const meetings = new Map()

/**
 * A meeting id that cannot collide. A bare millisecond timestamp did: the boot sweep can
 * create several meetings inside one tick, and two records with the same id overwrite each
 * other in memory and on disk (DESIGN §2.1 requires a unique id).
 * @returns a unique id of the form meeting-<timestamp36>-<random>.
 */
export function newMeetingId() {
  return `meeting-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

/**
 * Speaker support as this process sees it: the model must be present and verified, and
 * the worker started, before any cue can be labelled.
 */
export const speakerState = { phase: 'unprepared', message: '', modulePath: '' }

/** The running speaker worker, or null. */
export let speakerWorker = null

/** Setter for speakerWorker (mutable binding workaround for cross-module updates). */
export function setSpeakerWorker(value) {
  speakerWorker = value
}

/** Pinned handwriting recognizer assets: the ModelScope DAMO line model and its vocabulary. */
export const HANDWRITING_ASSETS = [
  {
    name: 'handwriting-damo.onnx',
    bytes: 76859029,
    sha256: 'a98dddb2b4ee1bd0b358bd087ecebc242767eae6657682569fb5e87ce96ea82e',
    path: 'iic/cv_convnextTiny_ocr-recognition-handwritten_damo/repo?Revision=master&FilePath=model.onnx',
  },
  {
    name: 'vocab.txt',
    bytes: 30333,
    path: 'iic/cv_convnextTiny_ocr-recognition-handwritten_damo/repo?Revision=master&FilePath=vocab.txt',
  },
]

/** ModelScope answers directly from the mainland, unlike the GitHub release assets. */
export const HANDWRITING_ORIGINS = [
  'https://www.modelscope.cn/api/v1/models/',
]

/** Handwriting support as this process sees it. */
export const handwritingState = { phase: 'unprepared', message: '', modulePath: '' }

/** The running handwriting worker, or null. */
export let handwritingWorker = null

/** Setter for handwritingWorker (mutable binding workaround for cross-module updates). */
export function setHandwritingWorker(value) {
  handwritingWorker = value
}

/** Action verbs that make a cue read as a work assignment. */
export const ACTION_VERBS = /(负责|跟进|安排|准备|整理|确认|联系|发送|发一|写|订|约|更新|修改|修复|调研|评估|输出|推动|协调|通知|提醒|回|答复|交给|处理)/u

/** Due expressions a cue may carry. */
export const DUE_PATTERNS = /(今天|明天|后天|今晚|明早|本周|这周|下周|周末|月底|月初|下个月|下月|周一|周二|周三|周四|周五|周六|周日|周天|马上|尽快|立即|本周内|这周内|下周一|下周二|下周三|下周四|下周五|\d{1,2}\s*[点:：]\s*\d{0,2}|\d{1,2}\s*[号日]|\d{1,2}\s*月\s*\d{1,2}\s*[号日]?)/u

/** Urgency markers. */
export const HIGH_PRIORITY = /(紧急|尽快|马上|立即|重要|优先|务必|必须)/u
export const LOW_PRIORITY = /(有空|方便|不急|稍后|之后|回头|改天|不着急)/u

/** Owner phrase: "X负责/跟进/来/去…" with a short name-like lead token. */
export const OWNER_PATTERNS = [
  /(?:请|让|麻烦|叫|由|交给)(.{1,6}?)(?:负责|跟进|处理|整理|准备|确认|通知|联系|写|订|回复|安排)/u,
  /(.{1,4}?)(?:负责|来跟进|牵头|主导)/u,
]

/** Markers that turn a cue into a decision, a risk, or an open question. */
export const DECISION_MARKERS = /(决定|结论|就这么定|定下来|敲定|通过|同意|就这么办|一致同意|定了|确认了)/u
export const RISK_MARKERS = /(风险|担心|隐患|注意|小心|千万|别|不要|避免|防止|可能有问题|有坑|告警)/u
export const QUESTION_MARKERS = /(要不要|是否|怎么办|如何|怎么|谁来|谁去|什么问题|待定|再议|不确定|需不需要|能不能|为什么)/u

/** Roles a person may review a meeting as. */
export const ROLES = ['host', 'attendee', 'observer']

/** How each role is written in a document. */
export const ROLE_LABELS = { host: '主持人', attendee: '参会人', observer: '旁听' }

/** How close two cue embeddings must be to count as one voice in the end-of-meeting pass. */
export const SPEAKER_MERGE_THRESHOLD = 0.62

/** Robot webhooks a meeting's confirmed assignments can be pushed to. */
export const WEBHOOK_KINDS = ['dingtalk', 'wecom']

/** How confirmed assignments reach people: the group robot, private notices, or both. */
export const PUSH_MODES = ['group', 'work', 'both']

/** Documents the agent may store beside a meeting. */
export const DOCUMENT_KINDS = ['review', 'summary', 'note']

/** How many departments and people a single sync may pull, so a large org cannot hang it. */
export const DIRECTORY_DEPARTMENT_LIMIT = 400
export const DIRECTORY_PERSON_LIMIT = 5000

/**
 * Pinyin helper state: loaded on demand, remembered once attempted so we never retry
 * on every cue.
 */
export let pinyinSyllables = null
export let pinyinAttempted = false

/** Setter for pinyin state (mutable binding workaround for cross-module updates). */
export function setPinyinState(syllables, attempted) {
  pinyinSyllables = syllables
  pinyinAttempted = attempted
}

/** The text a reader sees for one cue: the correction when there is one. */
export const seenText = (segment) => (typeof segment.revised === 'string' ? segment.revised : segment.text)
