/**
 * 文本工具：等宽对齐、时间、数值格式化。
 *
 * CS 选手名里混着中英日韩，中文按 2 列宽算，否则 K-D-A 那几列永远对不齐。
 * @module dsh-plugin-cs-companion/text
 */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

/** 一个字符在等宽字体里占几列。 */
export function charWidth(ch: string): number {
  return WIDE.test(ch) ? 2 : 1
}

/** 字符串的显示宽度（中文算 2）。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** 按显示宽度左对齐补空格。 */
export function padEnd(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/** 按显示宽度右对齐补空格。 */
export function padStart(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? ' '.repeat(gap) + text : text
}

/** 截断到目标显示宽度，超出补省略号。 */
export function clip(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** 安全转数字，取不到就给默认值。接口里所有数字都是字符串。 */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[%+,\s]/g, '')
  const parsed = Number.parseFloat(cleaned)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 安全转整数。 */
export function int(value: unknown, fallback = 0): number {
  return Math.trunc(num(value, fallback))
}

/** 去掉百分号并保留两位小数，用于 "93.8%" → 93.8。 */
export function pctValue(value: unknown): number {
  return num(value, 0)
}

/** 数字带符号：+3 / -2 / 0。 */
export function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`
}

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000

/** 秒级时间戳 → "11-24 12:00"（固定 UTC+8）。 */
export function formatTs(ts: unknown): string {
  const sec = int(ts, 0)
  if (sec <= 0) return ''
  const date = new Date(sec * 1000 + TZ_OFFSET_MS)
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mi = String(date.getUTCMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

/** 秒级时间戳 → "11-24"，只到日期。 */
export function formatDay(ts: unknown): string {
  return formatTs(ts).slice(0, 5)
}

/** 当前 UTC+8 的日期串，用于按天分组。 */
export function todayKey(now = Date.now()): string {
  const date = new Date(now + TZ_OFFSET_MS)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** 距离某时间戳还有多久，返回 "还有 2 小时 13 分" / "已开始"。 */
export function untilText(ts: unknown, now = Date.now()): string {
  const sec = int(ts, 0)
  if (sec <= 0) return ''
  const diff = sec * 1000 - now
  if (diff <= 0) return '已开始'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `还有 ${mins} 分钟`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest === 0 ? `还有 ${hours} 小时` : `还有 ${hours} 小时 ${rest} 分`
}

/** BO 数字转显示名。 */
export function boLabel(format: unknown): string {
  const raw = String(format ?? '').trim()
  const map: Record<string, string> = { '1': 'BO1', '2': 'BO2', '3': 'BO3', '5': 'BO5' }
  return map[raw] ?? (raw ? `BO${raw}` : '')
}

/** 状态码转中文。 */
export function statusLabel(status: unknown): string {
  const raw = String(status ?? '').trim()
  if (raw === '0') return '未开始'
  if (raw === '1') return '进行中'
  if (raw === '2') return '已结束'
  return '未知'
}

/** 去重并保序。 */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}
