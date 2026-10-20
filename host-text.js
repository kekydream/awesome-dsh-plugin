/**
 * Making recognition output read the way a person would write it.
 *
 * Speech recognisers are literal: they hand back "二零二六年十月十九号下午三点半" and
 * "百分之三十". That is faithful and unusable — nobody reads a transcript written that way, and
 * every later step (summary, minutes, model prompt) pays for it.
 *
 * Everything here is **pure and local**: given text and a small rule set, produce text. No
 * network, no model, no state. The rules that are on by default are the ones that cannot change
 * meaning; digits that could be a name or a version are left alone deliberately.
 *
 * The one rule that is NOT free is terminology replacement, which lives in host-tools (it reads
 * the meeting's own term list). This module only does the shapes of numbers and dates.
 */

/** Chinese digit characters, for both readings (零 and 〇 appear in dates and quantities). */
const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** Units inside a number, smallest to largest. 十 is handled separately: 十五 is 15, 二十 is 20. */
const UNITS = { 十: 10, 百: 100, 千: 1000 }

/** The single character for a digit, for writing a number out again (十五, not 十5). */
const DIGIT_CHARS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/**
 * Turn one Chinese numeral run into a number.
 * @param text - characters such as 二十三 or 十五 or 三百零五.
 * @returns the number, or null when the run is not a plain numeral.
 */
export function chineseNumber(text) {
  if (typeof text !== 'string' || text === '') return null
  // Pure digit strings (二零二六) read digit by digit.
  if (/^[零〇一二三四五六七八九]+$/u.test(text)) {
    let value = ''
    for (const character of text) value += String(DIGITS[character])
    return Number(value)
  }
  let total = 0
  let current = 0
  let sawUnit = false
  for (const character of text) {
    if (character in DIGITS) {
      current = DIGITS[character]
      continue
    }
    if (character in UNITS) {
      const unit = UNITS[character]
      total += (current === 0 ? 1 : current) * unit
      current = 0
      sawUnit = true
      continue
    }
    return null
  }
  if (!sawUnit && current === 0) return null
  return total + current
}

/**
 * The Chinese numeral for a whole number below ten thousand.
 * @param value - an integer, 0–9999.
 * @returns e.g. 15 → 十五, 23 → 二十三, 105 → 一百零五.
 */
export function numeralOf(value) {
  if (!Number.isFinite(value)) return ''
  const n = Math.trunc(value)
  if (n < 0) return `负${numeralOf(-n)}`
  if (n < 10) return String(n)
  // 10–19 reads 十几: 15 is 十五, never 一十五. 20 is 二十 (no trailing 零).
  if (n < 20) return `十${n === 10 ? '' : DIGIT_CHARS[n - 10]}`
  const thousands = Math.floor(n / 1000)
  const hundreds = Math.floor((n % 1000) / 100)
  const tens = Math.floor((n % 100) / 10)
  const ones = n % 10
  let out = ''
  if (thousands > 0) out += `${DIGIT_CHARS[thousands]}千`
  if (hundreds > 0) out += `${DIGIT_CHARS[hundreds]}百`
  else if (thousands > 0 && (tens > 0 || ones > 0)) out += '零'
  if (tens > 0) out += `${DIGIT_CHARS[tens]}十`
  else if (hundreds > 0 && ones > 0) out += '零'
  if (ones > 0) out += DIGIT_CHARS[ones]
  return out
}
/**
 * Whether a numeral run could be an hour of the day.
 *
 * This is what keeps "版本二点零" from becoming "版本2点零": a clock reading never has a 零
 * *after* the 点 (you say 三点零五分, not 三点零). Only runs that end on a real digit qualify.
 * @param run - the characters before 点.
 * @returns whether it can be read as an hour.
 */
function hourish(run) {
  if (typeof run !== 'string' || run === '') return false
  const value = chineseNumber(run)
  if (value === null) return false
  // 两点 is 2 o'clock; 二十四点 never is.
  return value >= 1 && value <= 24
}

/**
 * Rules, in the order they run. Each is `{ id, pattern, replace }`, and each is reversible in
 * intent: they only rewrite a shape, never a word.
 */
const RULES = [
  {
    id: 'date-sentence',
    // 二零二六年十月十九号 → 2026年10月19号
    pattern: /([零〇一二三四五六七八九]{4})年([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,3})[日号]/gu,
    replace: (match, year, month, day) => {
      const y = chineseNumber(year)
      const m = chineseNumber(month)
      const d = chineseNumber(day)
      if (y === null || m === null || d === null || m < 1 || m > 12 || d < 1 || d > 31) return match
      return `${y}年${m}月${d}日`
    },
  },
  {
    id: 'month-day',
    // 十月十九号 → 10月19日 (a year is stated elsewhere in the meeting)
    pattern: /([一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,3})[日号]/gu,
    replace: (match, month, day) => {
      const m = chineseNumber(month)
      const d = chineseNumber(day)
      if (m === null || d === null || m < 1 || m > 12 || d < 1 || d > 31) return match
      return `${m}月${d}日`
    },
  },
  {
    id: 'clock',
    // 三点半 → 3点半 ; 两点半 → 2点半 (两 is a numeral here, which is why the class includes it)
    pattern: /([零〇一二两三四五六七八九十]{1,3})点半/gu,
    replace: (match, hour) => (hourish(hour) ? `${chineseNumber(hour)}点半` : match),
  },
  {
    id: 'clock-minutes',
    pattern: /([零〇一二两三四五六七八九十]{1,3})点([零〇一二三四五六七八九十]{1,3})分/gu,
    replace: (match, hour, minute) => {
      const h = chineseNumber(hour)
      const m = chineseNumber(minute)
      // 三点零五分 is 3:05: a clock writes the minutes with two digits.
      return h === null || m === null || h > 24 || m > 59 ? match : `${h}点${String(m).padStart(2, '0')}分`
    },
  },
  {
    id: 'clock-plain',
    // 三点 → 3点, but 版本二点零 and 三点零五分 are not clocks: a run that continues with 零
    // is a decimal or a spelled-out name, and the lookahead leaves it alone. 两 counts here too.
    pattern: /([零〇一二两三四五六七八九十]{1,3})点(?![半钟分零])/gu,
    replace: (match, hour) => (hourish(hour) ? `${chineseNumber(hour)}点` : match),
  },
  {
    id: 'percent',
    // 百分之三十 → 30%
    pattern: /百分之([零〇一二三四五六七八九十百千]{1,6})/gu,
    replace: (match, run) => {
      const value = chineseNumber(run)
      return value === null ? match : `${value}%`
    },
  },
  {
    id: 'money',
    // 三千五百元 → 3500元 ; 二十万元 → 20万元
    pattern: /([零〇一二三四五六七八九十百千]{2,8})(万)?元/gu,
    replace: (match, run, tenThousand) => {
      const value = chineseNumber(run)
      if (value === null) return match
      return `${value}${tenThousand === undefined ? '' : '万'}元`
    },
  },
  {
    id: 'count-units',
    // 三千五百人 → 3500人（只对这些"数词+量词"组合动手，不碰人名与版本号）
    pattern: /([一二三四五六七八九十百千]{2,6})(人|条|个|项|次|天|周|月|年|小时|分钟|页|份|台|套|家|元)/gu,
    replace: (match, run, unit) => {
      const value = chineseNumber(run)
      // 十年、三月、一天 are idiomatic; rewriting them reads worse, not better.
      if (value === null || value < 11) return match
      return `${value}${unit}`
    },
  },
]

/** Which rules run by default: everything above, each of which only rewrites a shape. */
export const DEFAULT_RULES = RULES.map((rule) => rule.id)

/**
 * Normalise recognition text: numbers, dates and clocks written the way a person writes them.
 *
 * @param text - raw recognition output.
 * @param rules - rule ids to apply; omit for all defaults, `[]` for none.
 * @returns the normalised text.
 */
export function normalizeText(text, rules = DEFAULT_RULES) {
  if (typeof text !== 'string' || text === '') return text
  const enabled = new Set(Array.isArray(rules) ? rules : DEFAULT_RULES)
  let out = text
  for (const rule of RULES) {
    if (!enabled.has(rule.id)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/**
 * Whether normalisation would change this text — the panel uses it to avoid pointless writes.
 * @param text - raw recognition output.
 * @param rules - rule ids to apply.
 * @returns whether anything would change.
 */
export function wouldNormalize(text, rules = DEFAULT_RULES) {
  return normalizeText(text, rules) !== text
}