/**
 * The voice library and the speaker-recognition settings.
 *
 * Two things live here, both about telling people apart across meetings:
 *
 * 1. **Speaker settings** — the clustering threshold and whether the end-of-meeting pass
 *    relabels every cue or only the tail. They sit in the shared settings file (`speaker`
 *    section) because they describe this installation, not one meeting.
 *
 * 2. **The voice library** (`$DSH_HOME/meeting-room/voices.json`) — one centroid per known
 *    person, and nothing else. No audio, ever. A label is only ever NAMED by a person, and the
 *    library is only written when a name is set: the plugin suggests, the human decides.
 *
 * Vectors never travel over the plugin's HTTP surface. A caller that wants a voice learned
 * passes the meeting id and the label, and the vector is read from that meeting's own cues in
 * memory.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { VOICE_MATCH_THRESHOLD, SPEAKER_THRESHOLD, SPEAKER_BACKFILL_CAP, relabelPlanOf } from './host-constants.js'
import { readSettings, writeSettings } from './host-tools.js'

/** Version of the library file this module reads and writes. */
export const VOICES_VERSION = 1

/** Defaults for the speaker section of the settings. */
export function defaultSpeakerSettings() {
  return {
    threshold: SPEAKER_THRESHOLD,
    // The end-of-meeting pass relabels EVERY cue by default: the 60-cue cap was the single
    // biggest cause of labels breaking apart in a long meeting.
    fullRelabel: true,
    // Only used when fullRelabel is false.
    backfillCap: SPEAKER_BACKFILL_CAP,
    // Similarity at which a name is *suggested* (never written without a human).
    suggestThreshold: VOICE_MATCH_THRESHOLD,
    // Whether the voice library is offered at all; off means "recognise, but never compare".
    useLibrary: true,
  }
}

/** Where the voice library lives. */
export function voicesFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'voices.json')
}

/**
 * Read the speaker settings, filling in defaults for anything missing or invalid.
 * @returns the settings.
 */
export async function readSpeakerSettings() {
  const settings = await readSettings()
  const stored = settings.speaker
  const speaker = defaultSpeakerSettings()
  if (stored === null || typeof stored !== 'object') return speaker
  const threshold = Number(stored.threshold)
  if (Number.isFinite(threshold)) speaker.threshold = clamp(threshold, 0.3, 0.95)
  const suggest = Number(stored.suggestThreshold)
  if (Number.isFinite(suggest)) speaker.suggestThreshold = clamp(suggest, 0.5, 0.98)
  const cap = Number(stored.backfillCap)
  if (Number.isFinite(cap)) speaker.backfillCap = Math.max(0, Math.round(cap))
  if (typeof stored.fullRelabel === 'boolean') speaker.fullRelabel = stored.fullRelabel
  if (typeof stored.useLibrary === 'boolean') speaker.useLibrary = stored.useLibrary
  return speaker
}

/**
 * Write the speaker settings back into the shared settings file.
 * @param patch - fields to change.
 * @returns the stored settings and whether the threshold changed (the worker must be restarted).
 */
export async function writeSpeakerSettings(patch) {
  const settings = await readSettings()
  const current = await readSpeakerSettings()
  const next = { ...current }
  const threshold = Number(patch?.threshold)
  if (Number.isFinite(threshold)) next.threshold = clamp(threshold, 0.3, 0.95)
  const suggest = Number(patch?.suggestThreshold)
  if (Number.isFinite(suggest)) next.suggestThreshold = clamp(suggest, 0.5, 0.98)
  const cap = Number(patch?.backfillCap)
  if (Number.isFinite(cap)) next.backfillCap = Math.max(0, Math.round(cap))
  if (typeof patch?.fullRelabel === 'boolean') next.fullRelabel = patch.fullRelabel
  if (typeof patch?.useLibrary === 'boolean') next.useLibrary = patch.useLibrary
  settings.speaker = next
  await writeSettings({ ...settings, speaker: next })
  return { speaker: next, thresholdChanged: next.threshold !== current.threshold }
}

/**
 * How the end-of-meeting pass should limit itself, from the settings.
 * @returns `{ all: true }` for a full relabel, or `{ limit }` for a capped one.
 */
export async function relabelPlan() {
  return relabelPlanOf(await readSpeakerSettings())
}

/** Keep a number inside a range. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/**
 * Read the voice library.
 * @returns `{ version, voices }` where each voice is `{ name, vector, count, updatedAt }`.
 */
export async function readVoices() {
  try {
    const parsed = JSON.parse(await readFile(voicesFile(), 'utf8'))
    const voices = Array.isArray(parsed?.voices) ? parsed.voices : []
    return {
      version: VOICES_VERSION,
      voices: voices
        .filter((voice) => voice !== null && typeof voice === 'object' && typeof voice.name === 'string' && voice.name !== '' && Array.isArray(voice.vector))
        .map((voice) => ({
          name: voice.name,
          vector: voice.vector.map(Number).filter((value) => Number.isFinite(value)),
          count: Number.isFinite(Number(voice.count)) ? Number(voice.count) : 1,
          updatedAt: Number.isFinite(Number(voice.updatedAt)) ? Number(voice.updatedAt) : 0,
        }))
        .filter((voice) => voice.vector.length > 0),
    }
  } catch {
    // Absent or unreadable: an empty library is the honest answer.
    return { version: VOICES_VERSION, voices: [] }
  }
}

/**
 * Write the voice library, rounding vectors so the file stays readable and small.
 * @param library - `{ voices }` as read.
 */
async function writeVoices(library) {
  const directory = join(voicesFile(), '..')
  await mkdir(directory, { recursive: true })
  const body = {
    version: VOICES_VERSION,
    voices: library.voices.map((voice) => ({
      name: voice.name,
      // Five decimals is far more precision than a centroid needs, and keeps the file legible.
      vector: voice.vector.map((value) => Number(value.toFixed(5))),
      count: voice.count,
      updatedAt: voice.updatedAt,
    })),
  }
  await writeFile(voicesFile(), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

/**
 * What the interface may see: names and how much evidence stands behind each — never vectors.
 * @returns `[{ name, count, updatedAt }]`.
 */
export async function voiceSummary() {
  const library = await readVoices()
  return library.voices
    .map((voice) => ({ name: voice.name, count: voice.count, updatedAt: voice.updatedAt }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh'))
}

/**
 * Add a voice or fold it into the existing centroid, as a running mean.
 * @param name - the person's name.
 * @param vector - the centroid of one meeting's cues for that voice.
 * @returns the stored entry's summary, or null when the vector is unusable.
 */
export async function learnVoice(name, vector) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '' || !Array.isArray(vector) || vector.length === 0) return null
  const values = vector.map(Number).filter((value) => Number.isFinite(value))
  if (values.length === 0) return null
  const library = await readVoices()
  const existing = library.voices.find((voice) => voice.name === trimmed)
  if (existing === undefined || existing.vector.length !== values.length) {
    // A different dimensionality is a different model: replace rather than mix nonsense.
    const entry = { name: trimmed, vector: values, count: 1, updatedAt: Date.now() }
    const kept = library.voices.filter((voice) => voice.name !== trimmed)
    await writeVoices({ voices: [...kept, entry] })
    return { name: entry.name, count: entry.count, updatedAt: entry.updatedAt }
  }
  const total = existing.count + 1
  const merged = existing.vector.map((value, index) => (value * existing.count + values[index]) / total)
  existing.vector = merged
  existing.count = total
  existing.updatedAt = Date.now()
  await writeVoices(library)
  return { name: existing.name, count: existing.count, updatedAt: existing.updatedAt }
}

/**
 * Forget one person.
 * @param name - the entry to drop.
 * @returns whether anything was removed.
 */
export async function removeVoice(name) {
  const library = await readVoices()
  const kept = library.voices.filter((voice) => voice.name !== name)
  if (kept.length === library.voices.length) return false
  await writeVoices({ voices: kept })
  return true
}

/** Forget everyone. */
export async function clearVoices() {
  const library = await readVoices()
  await writeVoices({ voices: [] })
  return library.voices.length
}

/**
 * The centroid of one label's cues in a meeting.
 * @param label - voice label such as S1.
 * @param segments - the meeting's cues, embeddings included.
 * @returns an averaged vector, or null when the label has no embeddings.
 */
export function centroidOf(label, segments) {
  const vectors = []
  for (const segment of segments ?? []) {
    if (segment.speaker !== label) continue
    const embedding = decodeEmbedding(segment.embedding)
    if (embedding !== null) vectors.push(embedding)
  }
  if (vectors.length === 0) return null
  const length = vectors[0].length
  const usable = vectors.filter((vector) => vector.length === length)
  const centroid = new Array(length).fill(0)
  for (const vector of usable) {
    for (let index = 0; index < length; index += 1) centroid[index] += vector[index]
  }
  return centroid.map((value) => value / usable.length)
}

/**
 * Cues carry their embedding as base64 of a Float32Array; the worker sends it that way.
 * @param embedding - the stored string.
 * @returns the numbers, or null when there is nothing usable.
 */
export function decodeEmbedding(embedding) {
  if (typeof embedding !== 'string' || embedding === '') return null
  try {
    const buffer = Buffer.from(embedding, 'base64')
    if (buffer.length % 4 !== 0 || buffer.length === 0) return null
    const numbers = new Array(buffer.length / 4)
    for (let index = 0; index < numbers.length; index += 1) numbers[index] = buffer.readFloatLE(index * 4)
    return numbers.every((value) => Number.isFinite(value)) ? numbers : null
  } catch {
    return null
  }
}

/** Cosine similarity of two equal-length vectors. */
export function similarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * Suggest a name for each un-named label, from the voice library.
 *
 * A suggestion is never written anywhere: the panel shows it and a person decides. That rule is
 * the whole reason a library is acceptable at all.
 *
 * @param meeting - meeting record (cues with embeddings, speakers already assigned).
 * @returns `[{ label, name, score }]`, best first, only above the configured similarity.
 */
export async function suggestNames(meeting) {
  const speaker = await readSpeakerSettings()
  if (speaker.useLibrary !== true) return []
  const library = await readVoices()
  if (library.voices.length === 0) return []
  const suggestions = []
  for (const label of speakerLabelsOf(meeting)) {
    const existing = meeting.speakers?.[label]
    if (typeof existing === 'string' && existing !== '') continue
    const centroid = centroidOf(label, meeting.segments)
    if (centroid === null) continue
    let best = null
    for (const voice of library.voices) {
      const score = similarity(centroid, voice.vector)
      if (best === null || score > best.score) best = { name: voice.name, score }
    }
    if (best !== null && best.score >= speaker.suggestThreshold) {
      suggestions.push({ label, name: best.name, score: Number(best.score.toFixed(3)) })
    }
  }
  return suggestions.sort((left, right) => right.score - left.score)
}

/** The labels a meeting knows about, without importing the whole tools module. */
function speakerLabelsOf(meeting) {
  const labels = new Set()
  for (const label of Array.isArray(meeting.speakerLabels) ? meeting.speakerLabels : []) {
    if (typeof label === 'string' && label !== '') labels.add(label)
  }
  for (const segment of meeting.segments ?? []) {
    if (typeof segment.speaker === 'string' && segment.speaker !== '') labels.add(segment.speaker)
  }
  for (const label of Object.keys(meeting.speakers ?? {})) {
    if (label !== '') labels.add(label)
  }
  return [...labels].sort()
}

/**
 * One centroid per voice label of a meeting, from the cues' embeddings.
 *
 * Called at the end of a recording, just before the per-cue vectors are dropped: naming a
 * speaker happens afterwards, and a centroid is all the library needs. The result is kept on
 * the meeting in memory only (recordOf drops it).
 * @param meeting - meeting record.
 * @returns `{ S1: number[], … }`, empty when nothing carries an embedding.
 */
export function centroidsOf(meeting) {
  const centroids = {}
  for (const label of speakerLabelsOf(meeting)) {
    const centroid = centroidOf(label, meeting.segments)
    if (centroid !== null) centroids[label] = centroid
  }
  return centroids
}

/**
 * The centroid behind one label: the one kept at stop time, or computed from the cues while the
 * meeting is still being transcribed.
 * @param meeting - meeting record.
 * @param label - voice label.
 * @returns the vector, or null.
 */
export function centroidFor(meeting, label) {
  const kept = meeting.voiceCentroids?.[label]
  if (Array.isArray(kept) && kept.length > 0) return kept.map(Number)
  return centroidOf(label, meeting.segments)
}

/**
 * Learn the voice behind one label of a meeting, from that meeting's own cues.
 * @param meeting - meeting record.
 * @param label - voice label.
 * @param name - the name a person assigned.
 * @returns the stored entry's summary, or null when there was nothing to learn.
 */
export async function learnFromMeeting(meeting, label, name) {
  const centroid = centroidFor(meeting, label)
  if (centroid === null) return null
  return learnVoice(name, centroid)
}

/**
 * Whether the library file exists, for the interface's "where does this live" line.
 * @returns true when the file is present.
 */
export async function voicesExist() {
  return stat(voicesFile()).then(() => true).catch(() => false)
}