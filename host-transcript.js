/**
 * Reading settings for the whole transcript: how numbers are written back, and where the
 * browser half should cut a cue.
 *
 * Both live in the shared settings file under `transcript`, because they describe how this
 * installation records — not what one meeting says. The normalisation switches are per rule so
 * a person can keep 数字 as said and still get dates tidied, and the cue limits travel to the
 * browser half with the rest of the panel state.
 */
import { readSettings, writeSettings } from './host-tools.js'
import { DEFAULT_RULES } from './host-text.js'

/** Cue shaping defaults — the values the browser half has always used. */
export const MIN_CHUNK_SECONDS = 1.2
export const MAX_CHUNK_SECONDS = 5
export const SILENCE_RMS = 0.012
export const SILENCE_HOLD_SECONDS = 0.5

/** The limits a cue's length may be set to, so a typo cannot make recording unusable. */
export const CHUNK_LIMITS = { minSeconds: 0.5, maxSeconds: 30, silenceRms: [0.002, 0.08], holdSeconds: 0.1 }

/** Defaults for the transcript section. */
export function defaultTranscriptSettings() {
  return {
    // Every default rule is on: each one only rewrites a shape, never a word.
    normalize: true,
    normalizeRules: [...DEFAULT_RULES],
    minChunkSeconds: MIN_CHUNK_SECONDS,
    maxChunkSeconds: MAX_CHUNK_SECONDS,
    silenceRms: SILENCE_RMS,
    silenceHoldSeconds: SILENCE_HOLD_SECONDS,
  }
}

/**
 * Read the transcript settings, filling in defaults for anything missing or out of range.
 * @returns the settings.
 */
export async function readTranscriptSettings() {
  const settings = await readSettings()
  const stored = settings.transcript
  const transcript = defaultTranscriptSettings()
  if (stored === null || typeof stored !== 'object') return transcript
  if (typeof stored.normalize === 'boolean') transcript.normalize = stored.normalize
  if (Array.isArray(stored.normalizeRules)) {
    const known = new Set(DEFAULT_RULES)
    transcript.normalizeRules = stored.normalizeRules.filter((id) => typeof id === 'string' && known.has(id))
  }
  const min = Number(stored.minChunkSeconds)
  if (Number.isFinite(min)) transcript.minChunkSeconds = clamp(min, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  const max = Number(stored.maxChunkSeconds)
  if (Number.isFinite(max)) transcript.maxChunkSeconds = clamp(max, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  // A minimum above the maximum would make every cue the maximum: keep them ordered.
  if (transcript.minChunkSeconds > transcript.maxChunkSeconds) {
    transcript.maxChunkSeconds = transcript.minChunkSeconds
  }
  const rms = Number(stored.silenceRms)
  if (Number.isFinite(rms)) transcript.silenceRms = clamp(rms, CHUNK_LIMITS.silenceRms[0], CHUNK_LIMITS.silenceRms[1])
  const hold = Number(stored.silenceHoldSeconds)
  if (Number.isFinite(hold)) transcript.silenceHoldSeconds = clamp(hold, CHUNK_LIMITS.holdSeconds, 5)
  return transcript
}

/**
 * Write the transcript settings back, merging what was sent.
 * @param patch - fields to change.
 * @returns the stored settings.
 */
export async function writeTranscriptSettings(patch) {
  const settings = await readSettings()
  const current = await readTranscriptSettings()
  const next = { ...current }
  if (typeof patch?.normalize === 'boolean') next.normalize = patch.normalize
  if (Array.isArray(patch?.normalizeRules)) {
    const known = new Set(DEFAULT_RULES)
    next.normalizeRules = patch.normalizeRules.filter((id) => typeof id === 'string' && known.has(id))
  }
  const min = Number(patch?.minChunkSeconds)
  if (Number.isFinite(min)) next.minChunkSeconds = clamp(min, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  const max = Number(patch?.maxChunkSeconds)
  if (Number.isFinite(max)) next.maxChunkSeconds = clamp(max, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  if (next.minChunkSeconds > next.maxChunkSeconds) next.maxChunkSeconds = next.minChunkSeconds
  const rms = Number(patch?.silenceRms)
  if (Number.isFinite(rms)) next.silenceRms = clamp(rms, CHUNK_LIMITS.silenceRms[0], CHUNK_LIMITS.silenceRms[1])
  const hold = Number(patch?.silenceHoldSeconds)
  if (Number.isFinite(hold)) next.silenceHoldSeconds = clamp(hold, CHUNK_LIMITS.holdSeconds, 5)
  settings.transcript = next
  await writeSettings({ ...settings, transcript: next })
  return next
}

/** Keep a number inside a range. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}