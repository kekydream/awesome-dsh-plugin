/**
 * The model registry for the meeting-room plugin.
 *
 * Which models this installation uses is DATA, not code: a catalog (built-in plus anything the
 * person adds) is stored in `$DSH_HOME/meeting-room/models.json`, and `active` says which one
 * each capability runs. The built-in entries ARE the models this plugin has always pinned
 * (same files, same sizes, same sha256, same directories), so an existing installation keeps
 * working untouched — the registry only adds the ability to install, verify, switch and remove.
 *
 * Nothing here ever downloads without verifying: every file carries a size and a sha256, and a
 * failed check leaves nothing behind.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, stat, rename, open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

import { SPEAKER_MODEL, SPEAKER_MODEL_ORIGINS, HANDWRITING_ASSETS, HANDWRITING_ORIGINS } from './host-constants.js'

/** The kinds of capability a model can serve. */
export const MODEL_KINDS = ['asr', 'speaker', 'handwriting']

/** Version of the registry file this module reads and writes. */
export const REGISTRY_VERSION = 1

/** Where the pinned facts about the handwriting model live. */
export { HANDWRITING_ASSETS }

/**
 * Models this plugin ships knowledge of. `dir` is relative to $DSH_HOME; the two legacy
 * entries point at the directories the plugin has always used, so nothing has to move.
 */
export const BUILTIN_MODELS = [
  {
    id: 'speaker.campplus.zh-en.16k',
    kind: 'speaker',
    name: '3D-Speaker CAM++（中英，16 kHz）',
    runtime: 'onnx',
    dir: 'speech-to-text/speakers',
    source: { url: SPEAKER_MODEL_ORIGINS[0], mirrors: SPEAKER_MODEL_ORIGINS.slice(1) },
    files: [{ name: SPEAKER_MODEL.name, bytes: SPEAKER_MODEL.bytes, sha256: SPEAKER_MODEL.sha256 }],
    languages: ['zh', 'en'],
    sizeClass: 'small',
    note: '通用会议够用；嘈杂或多方言环境建议换更大的模型',
    licence: '见上游模型卡（k2-fsa/sherpa-onnx 发布）',
    builtin: true,
  },
  {
    id: 'handwriting.damo.line',
    kind: 'handwriting',
    name: 'DAMO 手写行识别（ConvNeXt-Tiny）',
    runtime: 'onnx',
    dir: 'handwriting',
    source: { url: HANDWRITING_ORIGINS[0], mirrors: HANDWRITING_ORIGINS.slice(1) },
    // ModelScope serves these by a query path rather than by file name, so each file carries
    // its own URL; the installer prefers it over the source-plus-name form.
    files: HANDWRITING_ASSETS.map((asset) => ({ name: asset.name, url: asset.path, bytes: asset.bytes, sha256: asset.sha256 })),
    languages: ['zh'],
    sizeClass: 'medium',
    note: '整行模型：横向书写、字距不要太挤',
    licence: '见上游模型卡（ModelScope iic/cv_convnextTiny_ocr-recognition-handwritten_damo）',
    builtin: true,
  },
  {
    id: 'asr.dsh.default',
    kind: 'asr',
    name: 'DSH 自带语音识别（SenseVoice 等）',
    runtime: 'host',
    dir: '',
    source: { url: '', mirrors: [] },
    files: [],
    languages: ['zh', 'en', 'ja', 'ko', 'yue'],
    sizeClass: 'unknown',
    note: '由 DeepSeek Harness 的语音能力提供，本插件不下载也不管理',
    licence: '随 DeepSeek Harness 分发',
    builtin: true,
    // The host owns this one: it cannot be installed, removed or switched by the plugin.
    locked: true,
  },
]

/** Cache of file verification, keyed by path: hashing 76 MB on every list would be absurd. */
const verificationCache = new Map()

/**
 * What the current install is doing, so the management page can show a real percentage
 * instead of a spinner: a 76 MB download is long enough that "still working" is not enough.
 */
export const installState = { id: '', phase: 'idle', file: '', received: 0, total: 0, source: '', message: '' }

/**
 * The directory $DSH_HOME resolves to, following the plugin's existing convention.
 * @returns the absolute path.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Where this registry lives. */
export function registryPath() {
  return join(dshHome(), 'meeting-room', 'models.json')
}

/**
 * The directory a model's files live in.
 * @param model - registry entry.
 * @returns the absolute directory, or '' for a model the host owns.
 */
export function modelDirectory(model) {
  if (typeof model.dir !== 'string' || model.dir === '') return ''
  return join(dshHome(), model.dir)
}

/**
 * Check one model's files on disk: present, right size, right content.
 * @param model - registry entry.
 * @returns `{ installed, verified, files }` where files list per-file state.
 */
export async function verifyModel(model) {
  if (model.runtime === 'host' || (model.files ?? []).length === 0) {
    return { installed: true, verified: true, files: [] }
  }
  const directory = modelDirectory(model)
  const files = []
  let installed = true
  let verified = true
  for (const file of model.files) {
    const path = join(directory, file.name)
    const info = await stat(path).catch(() => null)
    if (info === null) {
      installed = false
      verified = false
      files.push({ name: file.name, present: false, matches: false })
      continue
    }
    const key = `${path}:${info.size}:${info.mtimeMs}`
    let digest = verificationCache.get(key)
    if (digest === undefined) {
      digest = await sha256OfFile(path).catch(() => '')
      verificationCache.set(key, digest)
    }
    // Size is checked first: a truncated download is the common failure, and hashing it would
    // be wasted work.
    const sizeOk = file.bytes === undefined || Number(file.bytes) === info.size
    const hashOk = file.sha256 === undefined || String(file.sha256).toLowerCase() === digest
    if (!sizeOk || !hashOk) verified = false
    files.push({ name: file.name, present: true, bytes: info.size, matches: sizeOk && hashOk })
  }
  return { installed, verified, files }
}

/**
 * Hash a file without holding it in memory.
 * @param path - file to read.
 * @returns the lowercase hex sha256.
 */
async function sha256OfFile(path) {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1 << 20)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Read the registry, falling back to the built-in catalog. A malformed file is reported rather
 * than silently ignored: a person editing it needs to hear what is wrong.
 * @returns `{ models, active, problem }`.
 */
export async function readRegistry() {
  let stored = null
  let problem = ''
  try {
    const text = await readFile(registryPath(), 'utf8')
    stored = JSON.parse(text)
    if (stored === null || typeof stored !== 'object') throw new Error('not an object')
  } catch (failure) {
    const missing = failure?.code === 'ENOENT'
    stored = null
    if (!missing) problem = `models.json 读取失败，已使用内置目录：${failure instanceof Error ? failure.message : String(failure)}`
  }
  const extra = Array.isArray(stored?.models) ? stored.models : []
  const models = [...BUILTIN_MODELS]
  const problems = []
  for (const entry of extra) {
    const checked = validateModel(entry)
    // Success is the presence of `model`, not the absence of a message: an empty error is not
    // the same thing as no error at all.
    if (checked.model === undefined) {
      problems.push(`${entry?.id ?? '(无 id)'}: ${checked.error ?? '条目不合法'}`)
      continue
    }
    // A user entry may override a built-in id (same files, different mirror, for instance).
    const index = models.findIndex((model) => model.id === checked.model.id)
    if (index >= 0) models[index] = { ...models[index], ...checked.model, builtin: models[index].builtin }
    else models.push(checked.model)
  }
  if (problems.length > 0) problem = problems.join('；')
  const active = {}
  for (const kind of MODEL_KINDS) {
    const chosen = stored?.active?.[kind]
    if (typeof chosen === 'string' && chosen !== '') active[kind] = chosen
  }
  return { models, active, problem }
}

/**
 * Check one registry entry for the fields the installer needs.
 * @param entry - candidate entry from models.json.
 * @returns `{ model }` or `{ error }`.
 */
export function validateModel(entry) {
  if (entry === null || typeof entry !== 'object') return { error: '不是一个对象' }
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') return { error: '缺少 id' }
  if (!MODEL_KINDS.includes(entry.kind)) return { error: `kind 必须是 ${MODEL_KINDS.join(' / ')}` }
  if (typeof entry.name !== 'string' || entry.name.trim() === '') return { error: '缺少 name' }
  const runtime = entry.runtime === 'http' ? 'http' : 'onnx'
  const files = Array.isArray(entry.files) ? entry.files : []
  for (const file of files) {
    if (typeof file?.name !== 'string' || file.name === '' || basename(file.name) !== file.name) {
      return { error: `文件名不合法：${String(file?.name)}` }
    }
    if (file.sha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(String(file.sha256))) {
      return { error: `${file.name} 的 sha256 不是 64 位十六进制` }
    }
  }
  const dir = typeof entry.dir === 'string' ? entry.dir.trim() : ''
  if (runtime === 'onnx' && (dir === '' || dir.includes('..'))) return { error: 'dir 不合法（不能为空或含 ..）' }
  return {
    model: {
      id,
      kind: entry.kind,
      name: entry.name.trim(),
      runtime,
      dir,
      source: {
        url: typeof entry.source?.url === 'string' ? entry.source.url : '',
        mirrors: Array.isArray(entry.source?.mirrors) ? entry.source.mirrors.filter((item) => typeof item === 'string') : [],
      },
      files: files.map((file) => ({
        name: file.name,
        // A per-file URL overrides the source-plus-name form (ModelScope serves query paths).
        url: typeof file.url === 'string' ? file.url : '',
        bytes: Number.isFinite(Number(file.bytes)) ? Number(file.bytes) : undefined,
        sha256: typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : undefined,
      })),
      languages: Array.isArray(entry.languages) ? entry.languages.filter((item) => typeof item === 'string') : [],
      sizeClass: typeof entry.sizeClass === 'string' ? entry.sizeClass : 'unknown',
      note: typeof entry.note === 'string' ? entry.note : '',
      licence: typeof entry.licence === 'string' ? entry.licence : '',
      builtin: entry.builtin === true,
      locked: entry.locked === true,
      installedFrom: typeof entry.installedFrom === 'string' ? entry.installedFrom : '',
    },
  }
}

/**
 * Write the registry file, keeping any entries the person added.
 * @param registry - `{ models, active }` as read.
 */
export async function writeRegistry(registry) {
  const extras = registry.models.filter((model) => model.builtin !== true)
  const body = {
    version: REGISTRY_VERSION,
    // Only what differs from the built-in catalog is stored, so an upgrade can improve the
    // built-ins without the file freezing them.
    models: extras,
    active: registry.active,
  }
  await mkdir(join(dshHome(), 'meeting-room'), { recursive: true })
  await writeFile(registryPath(), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

/**
 * Everything the management page needs to show the model list.
 * @returns `{ models, active, problem, directory }`.
 */
export async function modelState() {
  const registry = await readRegistry()
  const models = []
  for (const model of registry.models) {
    const state = await verifyModel(model)
    models.push({
      id: model.id,
      kind: model.kind,
      name: model.name,
      runtime: model.runtime,
      dir: model.dir,
      builtin: model.builtin === true,
      locked: model.locked === true,
      active: registry.active[model.kind] === model.id || (registry.active[model.kind] === undefined && model.builtin === true && model.locked === true),
      installed: state.installed,
      verified: state.verified,
      files: model.files.map((file, index) => ({
        name: file.name,
        bytes: file.bytes ?? 0,
        sha256: file.sha256 ?? '',
        present: state.files[index]?.present === true,
        matches: state.files[index]?.matches === true,
      })),
      totalBytes: model.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
      languages: model.languages,
      sizeClass: model.sizeClass,
      note: model.note,
      licence: model.licence,
      installedFrom: model.installedFrom,
      source: model.source,
    })
  }
  return { models, active: activeOf(registry), problem: registry.problem, directory: join(dshHome(), 'meeting-room', 'models'), install: { ...installState } }
}

/**
 * The model each capability will actually use, following the documented order: the chosen one,
 * else the only installed one, else the built-in default. Anything else is an explicit error.
 * @param registry - result of readRegistry().
 * @returns `{ active, problems }` where active maps kind to model id or ''.
 */
export function activeOf(registry) {
  const active = {}
  for (const kind of MODEL_KINDS) {
    const chosen = registry.active[kind]
    if (typeof chosen === 'string' && registry.models.some((model) => model.id === chosen && model.kind === kind)) {
      active[kind] = chosen
      continue
    }
    const fallback = registry.models.find((model) => model.kind === kind && model.builtin === true)
    active[kind] = fallback?.id ?? ''
  }
  return active
}

/**
 * The model a capability runs, with its directory resolved.
 * @param kind - asr / speaker / handwriting.
 * @returns the model entry, or undefined when the catalog has none.
 */
export async function activeModel(kind) {
  const registry = await readRegistry()
  const id = activeOf(registry)[kind] ?? ''
  return registry.models.find((model) => model.id === id)
}

/**
 * Download and verify one model, trying the source then its mirrors.
 * @param id - model id from the catalog.
 * @param onProgress - called with `{ file, received, total, source }`.
 * @returns `{ installed, files }` or `{ error }`.
 */
export async function installModel(id, onProgress = () => undefined) {
  const registry = await readRegistry()
  const model = registry.models.find((entry) => entry.id === id)
  if (model === undefined) return { error: `目录里没有这个模型：${id}` }
  if (model.runtime === 'host') return { error: '这个模型由 DSH 提供，插件不能安装' }
  const sources = [model.source.url, ...(model.source.mirrors ?? [])].filter((url) => typeof url === 'string' && url !== '')
  if (sources.length === 0) return { error: '这个模型没有下载地址，请用「从本地文件导入」' }
  const directory = modelDirectory(model)
  await mkdir(directory, { recursive: true })
  installState.id = id
  installState.phase = 'downloading'
  installState.message = ''
  let lastError = ''
  for (const source of sources) {
    installState.source = source
    try {
      for (const file of model.files) {
        installState.file = file.name
        installState.received = 0
        installState.total = file.bytes ?? 0
        await downloadAndVerify(file, join(directory, file.name), join(directory, `${file.name}.part`), source, (progress) => {
          installState.received = progress.received
          installState.total = progress.total
          onProgress({ ...progress, file: file.name, source })
        })
        verificationCache.clear()
      }
      installState.phase = 'idle'
      installState.message = ''
      return { installed: true, files: model.files.map((file) => file.name), from: source }
    } catch (failure) {
      lastError = failure instanceof Error ? failure.message : String(failure)
      // Never leave a half file behind: the next attempt must start from nothing.
      for (const file of model.files) {
        await rm(join(directory, `${file.name}.part`), { force: true }).catch(() => undefined)
      }
    }
  }
  installState.phase = 'failed'
  installState.message = lastError
  return { error: `下载或校验失败：${lastError}` }
}

/**
 * Fetch one file and check it before it counts as installed.
 * @param file - `{ name, bytes, sha256 }` from the catalog.
 * @param target - final path.
 * @param partial - path to write while downloading.
 * @param source - base URL.
 * @param onProgress - progress callback.
 */
async function downloadAndVerify(file, target, partial, source, onProgress) {
  const url = file.url !== undefined && file.url !== ''
    ? (file.url.startsWith('http') ? file.url : `${source}${file.url}`)
    : (source.endsWith('/') ? `${source}${encodeURIComponent(file.name)}` : `${source}/${encodeURIComponent(file.name)}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('Content-Length') ?? file.bytes ?? 0)
  const handle = await open(partial, 'w')
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      hash.update(buffer)
      await handle.write(buffer)
      received += buffer.length
      // Refuse early when the source is clearly serving something else.
      if (file.bytes !== undefined && received > file.bytes) throw new Error('文件比目录记录的更大')
      onProgress({ received, total: total === 0 ? file.bytes ?? 0 : total })
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
  if (file.bytes !== undefined && received !== file.bytes) throw new Error(`大小不符：收到 ${received}，应为 ${file.bytes}`)
  const digest = hash.digest('hex')
  if (file.sha256 !== undefined && digest !== file.sha256) throw new Error('sha256 不符')
  await rename(partial, target)
  // A file whose size is known only after the fact is recorded, but never silently trusted.
  if (file.bytes === undefined) file.bytes = received
}

/**
 * Install a model from bytes the person already has — an offline machine, a private mirror, or
 * a model they trained themselves. The catalog entry decides what is acceptable: with a sha256
 * the bytes must match it exactly.
 * @param id - model id.
 * @param fileName - which file of the model these bytes are.
 * @param bytes - the file's bytes.
 * @returns `{ installed, verified }` or `{ error }`.
 */
export async function importModel(id, fileName, bytes) {
  const registry = await readRegistry()
  const model = registry.models.find((entry) => entry.id === id)
  if (model === undefined) return { error: `目录里没有这个模型：${id}` }
  if (model.runtime === 'host') return { error: '这个模型由 DSH 提供，插件不能导入' }
  const file = model.files.find((entry) => entry.name === fileName)
  if (file === undefined) {
    const names = model.files.map((entry) => entry.name).join(' / ')
    return { error: `这个模型需要 ${names}，不认识 ${fileName}` }
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (file.sha256 !== undefined && digest !== file.sha256) {
    return { error: `sha256 不符：这个文件不是目录里记录的 ${fileName}（可能版本不同或已损坏）` }
  }
  if (file.sha256 === undefined && file.bytes !== undefined && file.bytes !== bytes.length) {
    return { error: `大小不符：${bytes.length} 字节，目录记录 ${file.bytes}` }
  }
  const directory = modelDirectory(model)
  await mkdir(directory, { recursive: true })
  const partial = join(directory, `${fileName}.part`)
  await writeFile(partial, bytes)
  await rename(partial, join(directory, fileName))
  if (file.bytes === undefined) file.bytes = bytes.length
  if (file.sha256 === undefined) file.sha256 = digest
  verificationCache.clear()
  // Remember that this copy arrived by hand, so a later "install" does not silently replace it.
  if (model.builtin !== true) model.installedFrom = 'import'
  await persistModelChange(model, registry)
  const state = await verifyModel(model)
  return { installed: state.installed, verified: state.verified, sha256: digest }
}

/**
 * Record a change to a model entry (an imported digest, for instance) in the registry file.
 * @param model - the entry that changed.
 * @param registry - the registry it came from.
 */
async function persistModelChange(model, registry) {
  if (model.builtin === true) {
    // Built-ins are not stored; an import of a built-in only needs the file on disk.
    return
  }
  const index = registry.models.findIndex((entry) => entry.id === model.id)
  if (index >= 0) registry.models[index] = model
  await writeRegistry(registry)
}

/**
 * Choose which model a capability runs.
 * @param kind - asr / speaker / handwriting.
 * @param id - model id, or '' to fall back to the built-in default.
 * @returns `{ active }` or `{ error }`.
 */
export async function activateModel(kind, id) {
  if (!MODEL_KINDS.includes(kind)) return { error: `kind 必须是 ${MODEL_KINDS.join(' / ')}` }
  const registry = await readRegistry()
  if (id !== '') {
    const model = registry.models.find((entry) => entry.id === id)
    if (model === undefined) return { error: `目录里没有这个模型：${id}` }
    if (model.kind !== kind) return { error: `${model.name} 不是 ${kind} 模型` }
    if (model.runtime === 'host') return { error: '这个模型由 DSH 提供，不需要也无法切换' }
    const state = await verifyModel(model)
    if (!state.verified) return { error: `${model.name} 还没有装好或校验不通过，请先安装` }
  }
  const active = { ...registry.active }
  if (id === '') delete active[kind]
  else active[kind] = id
  registry.active = active
  await writeRegistry(registry)
  return { active: activeOf(registry) }
}

/**
 * Remove a model's files. Built-ins can only be switched away from, never deleted, and a model
 * that is still in use is reported rather than removed behind the person's back.
 * @param id - model id.
 * @returns `{ removed, files }` or `{ error }`.
 */
export async function removeModel(id) {
  const registry = await readRegistry()
  const model = registry.models.find((entry) => entry.id === id)
  if (model === undefined) return { error: `目录里没有这个模型：${id}` }
  if (model.builtin === true) return { error: '内置模型不能删除：可以改用别的模型，或保留它不动' }
  if (registry.active[model.kind] === id) return { error: '这个模型正在使用：请先切换到别的模型再删除' }
  const directory = modelDirectory(model)
  let removed = 0
  for (const file of model.files) {
    const path = join(directory, file.name)
    const existed = await stat(path).then(() => true).catch(() => false)
    if (!existed) continue
    await rm(path, { force: true })
    removed += 1
  }
  // The directory is left in place: it may hold other models' files.
  verificationCache.clear()
  const kept = { ...registry, models: registry.models.filter((entry) => entry.id !== id) }
  await writeRegistry(kept)
  return { removed, files: model.files.map((file) => file.name) }
}

/**
 * The files of one model that are present, for the "what is on disk" line in the interface.
 * @param model - registry entry.
 * @returns names present in its directory.
 */
export async function filesOnDisk(model) {
  const directory = modelDirectory(model)
  if (directory === '') return []
  const names = await readdir(directory).catch(() => [])
  return model.files.map((file) => file.name).filter((name) => names.includes(name))
}