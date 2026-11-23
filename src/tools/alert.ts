/**
 * 开赛雷达：轮询赛程，把该提醒的事合并成一条。
 *
 * 事件检测与去重在这里，真正的定时器和投递在 index.ts——那边才拿得到 agent。
 * 8 场 Major BO1 会在 12:00 同时开打，所以同一轮的事件必须合并成一条，否则刷屏。
 * @module dsh-plugin-cs-companion/tools/alert
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CsMatch } from '../data/fivee.ts'
import { JsonFile } from '../data/store.ts'
import { boLabel, formatTs, int, untilText } from '../util/text.ts'
import { type CsRuntime, mapsLine, scoreline, textOutput } from './common.ts'

/** 雷达认的一个事件。`key` 是去重键，落盘保存，重启不会重复推。 */
export interface AlertEvent {
  readonly key: string
  readonly kind: 'soon' | 'live' | 'map_end' | 'match_point' | 'end'
  readonly at: number
  readonly text: string
}

/** 雷达状态：已推过的事件 + 最近十条，供 `cs_alert_recent` 查。 */
export interface AlertDocument {
  seen: Record<string, number>
  recent: AlertEvent[]
}

/** 雷达状态存取。 */
export class AlertStore {
  private readonly file: JsonFile<AlertDocument>

  constructor(dir: string) {
    this.file = new JsonFile<AlertDocument>(dir, 'alerts.json')
  }

  /** 读状态。 */
  async load(): Promise<AlertDocument> {
    const doc = await this.file.load(() => ({ seen: {}, recent: [] }))
    if (!doc.seen) doc.seen = {}
    if (!doc.recent) doc.recent = []
    return doc
  }

  /** 写状态。 */
  async save(doc: AlertDocument): Promise<void> {
    // 只留最近 3 天的键，否则 seen 会无限长。
    const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400
    const seen: Record<string, number> = {}
    for (const [key, at] of Object.entries(doc.seen)) {
      if (at >= cutoff) seen[key] = at
    }
    await this.file.save({ seen, recent: doc.recent.slice(-20) })
  }
}

/** BO 几胜算赢：BO3 要 2 胜，BO5 要 3 胜。 */
function winsNeeded(bo: string): number {
  const value = int(bo, 1)
  if (value === 3) return 2
  if (value === 5) return 3
  return 1
}

/**
 * 扫一遍赛程，产出本轮该推的事件。
 * `seen` 里已有的不重复产出；产出的同时把 key 写进返回的 doc。
 */
export function scanEvents(
  matches: readonly CsMatch[],
  doc: AlertDocument,
  nowSeconds = Math.floor(Date.now() / 1000),
  soonMinutes = 15,
): AlertEvent[] {
  const events: AlertEvent[] = []
  const push = (key: string, kind: AlertEvent['kind'], text: string, at = nowSeconds): void => {
    if (doc.seen[key]) return
    doc.seen[key] = at
    events.push({ key, kind, at, text })
  }

  for (const match of matches) {
    if (!match.id) continue
    const head = `${match.t1} vs ${match.t2}｜${match.event}${match.stage ? ` ${match.stage}` : ''} ${boLabel(match.bo)}`

    if (match.status === '0' && match.planTs > 0) {
      const lead = match.planTs - nowSeconds
      if (lead > 0 && lead <= Math.max(1, soonMinutes) * 60) {
        push(`${match.id}:soon`, 'soon', `⏰ ${untilText(match.planTs)}开打：${head}`)
      }
      continue
    }

    if (match.status === '1') {
      push(`${match.id}:live`, 'live', `▶ 已开打：${head}｜${scoreline(match)}`)
      const done = match.maps.filter(m => m.done)
      for (const map of done) {
        push(
          `${match.id}:map${map.n}`,
          'map_end',
          `${map.name} 打完 ${map.s1}:${map.s2}｜${match.t1} ${match.s1}:${match.s2} ${match.t2}`,
        )
      }
      const need = winsNeeded(match.bo)
      if (need > 1 && (match.s1 === need - 1 || match.s2 === need - 1)) {
        const who = match.s1 === need - 1 ? match.t1 : match.t2
        push(`${match.id}:mp`, 'match_point', `⚡ 赛点：${who} 再赢一张就拿下了（${match.s1}:${match.s2}）`)
      }
      continue
    }

    if (match.status === '2') {
      const winner = match.s1 > match.s2 ? match.t1 : match.t2
      const maps = mapsLine(match)
      push(
        `${match.id}:end`,
        'end',
        `■ 结束：${winner} 赢下 ${match.t1} ${match.s1}:${match.s2} ${match.t2}${maps ? `｜${maps}` : ''}`,
      )
    }
  }
  return events
}

/** 悬念值：赔率越接近越有悬念，用于「今日看哪场」。 */
function suspense(match: CsMatch): number {
  if (!match.o1 || !match.o2) return 50
  return 100 - Math.abs(match.o1 - match.o2)
}

/** 注册雷达的 2 个工具。 */
export function registerAlert(ctx: Context, runtime: CsRuntime, store: AlertStore): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_major_today',
    description:
      '今天的比赛清单，按悬念从高到低排。用户问"今天有什么比赛""今天看哪场好"，'
      + '或你想主动推荐今天的场次时调用。带赛前胜率与实际比分。',
    parameters: {
      limit: { type: 'integer', description: '最多几条，默认 8' },
    },
    output,
    async execute(args, exec) {
      const rows = await runtime.fiveE.upcoming()
      if (rows.length === 0) return { text: '接口今天没返回任何比赛，直接说没有，别编赛程。' }
      const limit = Math.min(20, Math.max(1, args.limit ?? 8))
      const sorted = rows.slice().sort((a, b) => suspense(b) - suspense(a)).slice(0, limit)
      const lines = [`【今日 ${rows.length} 场，按悬念排】`]
      let index = 1
      for (const match of sorted) {
        const odds = match.o1 && match.o2 ? `　赛前 ${match.o1}% / ${match.o2}%` : ''
        lines.push(`${index}. ${formatTs(match.planTs)} ${scoreline(match)}${odds}`)
        if (match.stage || match.event) {
          lines.push(`   ${[match.event, match.stage, boLabel(match.bo)].filter(Boolean).join(' · ')}`)
        }
        index += 1
      }
      return { text: lines.join('\n'), data: { count: rows.length } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_alert_recent',
    description:
      '雷达最近推过什么。用户问"刚才有什么提醒""有没有漏掉的"，或你想确认推送状态时调用。'
      + '返回的是真实事件流水，不含预测。',
    parameters: {
      limit: { type: 'integer', description: '最多几条，默认 5' },
    },
    output,
    async execute(args, _exec) {
      const doc = await store.load()
      const limit = Math.min(20, Math.max(1, args.limit ?? 5))
      const recent = doc.recent.slice(-limit)
      if (recent.length === 0) return { text: '雷达还没推过东西。' }
      const lines = ['【雷达最近事件】']
      for (const event of recent) lines.push(`- ${formatTs(event.at)} ${event.text}`)
      return { text: lines.join('\n'), data: { count: doc.recent.length } }
    },
  }))
}

/** 把事件塞进流水，供 `cs_alert_recent` 读。 */
export function rememberEvents(doc: AlertDocument, events: readonly AlertEvent[]): AlertDocument {
  return { seen: doc.seen, recent: [...doc.recent, ...events].slice(-20) }
}

/** 事件合并成一条推送正文；空数组返回 null，调用方就别推了。 */
export function composePush(events: readonly AlertEvent[]): string | null {
  if (events.length === 0) return null
  if (events.length === 1) return events[0]?.text ?? null
  return [`【同一批 ${events.length} 条】`, ...events.map(e => `- ${e.text}`)].join('\n')
}
