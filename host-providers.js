/**
 * Cloud model providers — the only code in this plugin that talks to anything outside the
 * machine, and it does nothing until a person says so.
 *
 * The contract is deliberately plain: an OpenAI-compatible transcription endpoint for speech,
 * and a documented JSON contract for speaker vectors. Every call passes the same gate — consent
 * given, provider configured, not in fallback — and every message that leaves this module has
 * been through `redact`, so a key can never reach a log, an error or the interface.
 */
import { readSettings, writeSettings } from './host-tools.js'

/** Provider names this module understands. */
export const CLOUD_PROVIDERS = ['off', 'openai-compatible', 'custom']

/**
 * How recognition chooses between the on-machine model and the cloud one.
 *
 * `local` never calls out, `prefer-cloud` tries the cloud and silently keeps the local result
 * after repeated failures, and `cloud-only` is the strict mode: failures are reported instead
 * of being absorbed by the local model.
 */
export const CLOUD_MODES = ['local', 'prefer-cloud', 'cloud-only']

/** Order of magnitude guard rails: a runaway loop must not become a bill. */
export const MAX_REQUESTS_PER_MINUTE = 60
/** One cloud attempt may not hang a meeting. */
export const REQUEST_TIMEOUT_MS = 20_000
/** After this many failures in a row, the plugin stops trying and says so. */
export const FAILURES_BEFORE_FALLBACK = 3

/** What this process knows about the cloud right now. */
export const cloudState = {
  /** Timestamps of recent requests, for the per-minute limit. */
  recent: [],
  consecutiveFailures: 0,
  fallback: false,
  message: '',
  lastModel: '',
  lastAt: 0,
  /** The stored mode, cached so a request path can tell whether falling back is allowed. */
  mode: 'local',
}

/**
 * Remove anything secret from a message before it is shown or logged.
 * @param value - any value about to be logged, returned or displayed.
 * @returns the same text with keys and authorization headers masked.
 */
export function redact(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/gu, 'sk-***')
    .replace(/(api[-_]?key["'\s:=]+)[A-Za-z0-9._-]{6,}/giu, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/giu, '$1***')
}

/** The defaults for the cloud section: everything off, nothing configured. */
function defaultCloud() {
  return {
    // Explicit consent, never implied: no call happens while this is false.
    consent: false,
    // Local by default: saving a cloud address is not the same as using it.
    mode: 'local',
    asr: { provider: 'off', baseUrl: '', model: '', language: '', apiKey: '', keepRemote: false },
    speaker: { provider: 'off', baseUrl: '', model: '', apiKey: '' },
  }
}

/**
 * Read the cloud section of the shared settings, filling in defaults.
 * @returns the cloud settings.
 */
export async function readCloudSettings() {
  const settings = await readSettings()
  const stored = settings.cloud
  const cloud = defaultCloud()
  if (stored !== null && typeof stored === 'object') {
    cloud.consent = stored.consent === true
    if (CLOUD_MODES.includes(stored.mode)) cloud.mode = stored.mode
    for (const kind of ['asr', 'speaker']) {
      const part = stored[kind]
      if (part === null || typeof part !== 'object') continue
      if (CLOUD_PROVIDERS.includes(part.provider)) cloud[kind].provider = part.provider
      for (const key of ['baseUrl', 'model', 'language', 'apiKey']) {
        if (typeof part[key] === 'string') cloud[kind][key] = part[key].trim()
      }
      if (kind === 'asr') cloud.asr.keepRemote = part.keepRemote === true
    }
  }
  // A request path that only has the module state still needs the current mode: `cloud-only`
  // must not quietly turn on the process-wide fallback.
  cloudState.mode = cloud.mode
  return cloud
}

/**
 * Write the cloud section back, merging what was sent.
 * @param patch - `{ consent?, asr?, speaker? }`; an empty string clears a field.
 * @returns the stored cloud settings.
 */
export async function writeCloudSettings(patch) {
  const settings = await readSettings()
  const current = await readCloudSettings()
  const next = {
    consent: typeof patch?.consent === 'boolean' ? patch.consent : current.consent,
    mode: CLOUD_MODES.includes(patch?.mode) ? patch.mode : current.mode,
    asr: { ...current.asr },
    speaker: { ...current.speaker },
  }
  for (const kind of ['asr', 'speaker']) {
    const part = patch?.[kind]
    if (part === null || typeof part !== 'object') continue
    if (CLOUD_PROVIDERS.includes(part.provider)) next[kind].provider = part.provider
    for (const key of ['baseUrl', 'model', 'language', 'apiKey']) {
      if (typeof part[key] === 'string') next[kind][key] = part[key].trim()
    }
    if (kind === 'asr' && typeof part.keepRemote === 'boolean') next.asr.keepRemote = part.keepRemote
  }
  settings.cloud = next
  await writeSettings({ ...settings, cloud: next })
  return next
}

/**
 * Whether one capability may call out at all, and why not when it may not.
 * @param kind - asr or speaker.
 * @returns `{ ok, reason }`.
 */
export async function cloudStatus(kind) {
  const cloud = await readCloudSettings()
  const part = cloud[kind]
  // The mode is checked first: `local` means no request is made even when everything else
  // is configured, so switching back to local is an immediate, complete stop.
  if (cloud.mode === 'local') return { ok: false, reason: '当前选择本地识别', cloud }
  if (cloud.consent !== true) return { ok: false, reason: '还没有同意上传：云端识别默认关闭', cloud }
  if (part.provider === 'off') return { ok: false, reason: '没有选择云端服务', cloud }
  if (part.baseUrl === '') return { ok: false, reason: '还没有填写服务地址', cloud }
  if (part.provider === 'openai-compatible' && part.apiKey === '') return { ok: false, reason: '还没有填写密钥', cloud }
  if (cloudState.fallback) return { ok: false, reason: redact(cloudState.message), cloud }
  return { ok: true, reason: '', cloud }
}

/**
 * What the interface may know about the cloud: whether a key is set, never the key itself.
 * @returns a masked summary.
 */
export async function cloudSummary() {
  const cloud = await readCloudSettings()
  const host = (url) => {
    try {
      return new URL(url).host
    } catch {
      return url === '' ? '' : redact(url)
    }
  }
  return {
    consent: cloud.consent,
    mode: cloud.mode,
    asr: {
      provider: cloud.asr.provider,
      baseUrl: cloud.asr.baseUrl,
      host: host(cloud.asr.baseUrl),
      model: cloud.asr.model,
      language: cloud.asr.language,
      keySet: cloud.asr.apiKey !== '',
      keepRemote: cloud.asr.keepRemote,
    },
    speaker: {
      provider: cloud.speaker.provider,
      baseUrl: cloud.speaker.baseUrl,
      host: host(cloud.speaker.baseUrl),
      model: cloud.speaker.model,
      keySet: cloud.speaker.apiKey !== '',
    },
    state: {
      fallback: cloudState.fallback,
      strict: cloud.mode === 'cloud-only',
      message: redact(cloudState.message),
      lastModel: cloudState.lastModel,
      lastAt: cloudState.lastAt,
      failures: cloudState.consecutiveFailures,
    },
    limits: { perMinute: MAX_REQUESTS_PER_MINUTE, timeoutMs: REQUEST_TIMEOUT_MS, failuresBeforeFallback: FAILURES_BEFORE_FALLBACK },
  }
}

/**
 * Forget a fallback, so the next call is tried again (the "test connection" button does this).
 */
export function resetCloudFallback() {
  cloudState.fallback = false
  cloudState.consecutiveFailures = 0
  cloudState.message = ''
}

/**
 * One guarded request: rate limited, timed out, retried once, and never leaking a key.
 * @param url - target.
 * @param options - fetch options.
 * @param label - what to call this request in messages.
 * @returns the response.
 */
async function guardedFetch(url, options, label) {
  const now = Date.now()
  cloudState.recent = cloudState.recent.filter((at) => now - at < 60_000)
  if (cloudState.recent.length >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(redact(`${label}：请求过于频繁（每分钟上限 ${MAX_REQUESTS_PER_MINUTE} 次），已暂停`))
  }
  cloudState.recent.push(now)
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.status >= 500 && attempt === 0) {
        lastError = `HTTP ${response.status}`
        continue
      }
      if (!response.ok) {
        // The body may explain itself; it is still redacted before anyone sees it.
        const detail = await response.text().catch(() => '')
        throw new Error(redact(`${label}：HTTP ${response.status}${detail === '' ? '' : ` ${detail.slice(0, 200)}`}`))
      }
      cloudState.consecutiveFailures = 0
      cloudState.fallback = false
      cloudState.message = ''
      return response
    } catch (failure) {
      lastError = failure instanceof Error ? failure.message : String(failure)
      if (failure?.name === 'TimeoutError' || /aborted|timeout/iu.test(lastError)) lastError = `${label}：超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`
      if (attempt === 1) break
    }
  }
  cloudState.consecutiveFailures += 1
  // Strict mode reports every failure instead of going quiet: a person who picked
  // "cloud only" asked for cloud text, not for the local model's text without being told.
  if (cloudState.mode !== 'cloud-only' && cloudState.consecutiveFailures >= FAILURES_BEFORE_FALLBACK) {
    cloudState.fallback = true
    cloudState.message = redact(`云端连续 ${cloudState.consecutiveFailures} 次失败，已回退到本机识别：${lastError}`)
  }
  throw new Error(redact(lastError))
}

/**
 * Wrap raw PCM16 in a WAV container, which is what every transcription endpoint expects.
 * @param pcm - mono PCM16 little-endian bytes.
 * @param sampleRate - samples per second.
 * @returns the WAV bytes.
 */
export function wavOf(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Transcribe one cue through the configured cloud service.
 *
 * Returns `{ skipped: true, reason }` when the gate is closed — and performs NO request in that
 * case, which is the promise the privacy switch makes.
 *
 * @param input - `{ pcm, sampleRate, language, hotwords }`.
 * @returns `{ skipped }` or `{ text, segments, model, usage }`.
 */
export async function cloudTranscribe(input) {
  const status = await cloudStatus('asr')
  if (!status.ok) return { skipped: true, reason: status.reason }
  const part = status.cloud.asr
  const wav = wavOf(input.pcm, input.sampleRate)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'cue.wav')
  form.append('model', part.model === '' ? 'whisper-1' : part.model)
  form.append('response_format', 'verbose_json')
  const language = input.language !== undefined && input.language !== '' ? input.language : part.language
  if (language !== '') form.append('language', language)
  // A prompt carries the meeting's own vocabulary, which is how names survive transcription.
  if (typeof input.hotwords === 'string' && input.hotwords !== '') form.append('prompt', input.hotwords.slice(0, 800))
  // Declaring that the audio may not be retained is part of asking for consent honestly.
  if (part.keepRemote !== true) form.append('retention', 'none')
  const response = await guardedFetch(`${part.baseUrl.replace(/\/$/u, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` },
    body: form,
  }, '云端识别')
  const value = await response.json().catch(() => ({}))
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (text === '') throw new Error('云端识别返回了空文本')
  const segments = Array.isArray(value.segments)
    ? value.segments
      .filter((item) => item !== null && typeof item === 'object')
      .map((item) => ({
        start: Number(item.start ?? 0),
        end: Number(item.end ?? 0),
        text: typeof item.text === 'string' ? item.text.trim() : '',
      }))
      .filter((item) => item.text !== '')
    : []
  cloudState.lastModel = typeof value.model === 'string' ? value.model : part.model
  cloudState.lastAt = Date.now()
  return { skipped: false, text, segments, model: cloudState.lastModel, usage: value.duration === undefined ? {} : { audioSeconds: Number(value.duration) } }
}

/**
 * Ask the configured service for one speaker vector.
 *
 * The contract is documented rather than guessed: POST the WAV, answer
 * `{ vector: number[], model?: string }`.
 *
 * @param input - `{ pcm, sampleRate }`.
 * @returns `{ skipped }` or `{ vector, model }`.
 */
export async function cloudEmbed(input) {
  const status = await cloudStatus('speaker')
  if (!status.ok) return { skipped: true, reason: status.reason }
  const part = status.cloud.speaker
  const wav = wavOf(input.pcm, input.sampleRate)
  const response = await guardedFetch(`${part.baseUrl.replace(/\/$/u, '')}/speaker/embedding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      ...(part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }),
    },
    body: wav,
  }, '云端声纹')
  const value = await response.json().catch(() => ({}))
  const vector = Array.isArray(value.vector) ? value.vector.map(Number).filter((item) => Number.isFinite(item)) : []
  if (vector.length === 0) throw new Error('云端声纹返回了空向量')
  return { skipped: false, vector, model: typeof value.model === 'string' ? value.model : part.model }
}

/**
 * Try the configured services once, for the "test connection" button.
 * @returns `{ asr, speaker }` each `{ ok, message }`.
 */
export async function testCloud() {
  resetCloudFallback()
  const cloud = await readCloudSettings()
  const results = {}
  for (const kind of ['asr', 'speaker']) {
    const part = cloud[kind]
    if (part.provider === 'off' || part.baseUrl === '') {
      results[kind] = { ok: false, message: '没有配置' }
      continue
    }
    if (cloud.consent !== true) {
      results[kind] = { ok: false, message: '还没有同意上传（已跳过，未发起请求）' }
      continue
    }
    try {
      // A tenth of a second of silence is enough to prove the path works, and sends no speech.
      const sample = Buffer.alloc(1600)
      if (kind === 'asr') await cloudTranscribe({ pcm: sample, sampleRate: 16_000 })
      else await cloudEmbed({ pcm: sample, sampleRate: 16_000 })
      results[kind] = { ok: true, message: redact(`已连通（${cloudState.lastModel}）`) }
    } catch (failure) {
      results[kind] = { ok: false, message: redact(failure instanceof Error ? failure.message : String(failure)) }
    }
  }
  return results
}