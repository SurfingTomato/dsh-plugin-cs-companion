/**
 * 六个工具组共用的东西：运行时依赖、比赛挑选、比分渲染、统一输出形状。
 * @module dsh-plugin-cs-companion/tools/common
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { FiveEClient, CsMatch } from '../data/fivee.ts'
import type { LiquipediaClient } from '../data/liquipedia.ts'
import { boLabel, formatTs, statusLabel, untilText } from '../util/text.ts'

/** 插件运行期共享的依赖。工具组只拿这个，不直接碰 ctx。 */
export interface CsRuntime {
  readonly fiveE: FiveEClient
  readonly liquipedia: LiquipediaClient
  readonly dataDir: string
  readonly contact: string
  /** 写日志用，出错不抛。 */
  readonly log: (message: string) => void
  /** 把一场比赛的最新状态放进内存缓存，注入时直接用，避免在 pre-step 里发网络请求。 */
  readonly remember: (match: CsMatch) => void
}

/**
 * 统一的输出形状：`text` 是给模型看的那段人话，`data` 留给程序化调用方。
 * 22 个工具各写一套 schema 收益不大，保持一个形状更好维护。
 */
export function textOutput(): {
  schema: { type: 'object'; additionalProperties: false; properties: { text: { type: 'string'; required: true }; data: { type: 'json' } } }
  render: (args: unknown, value: { text: string }) => ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true },
        data: { type: 'json' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

/** 比分：进行中/未开始/已结束三种口径。 */
export function scoreline(match: CsMatch): string {
  if (match.status === '2') return `${match.t1} ${match.s1}:${match.s2} ${match.t2}（已结束）`
  if (match.status === '1') {
    const current = match.maps.filter(m => !m.done && m.s1 + m.s2 > 0).at(-1)
    const mapPart = current ? `｜当前 ${current.name} ${current.s1}:${current.s2}` : ''
    return `${match.t1} ${match.s1}:${match.s2} ${match.t2}（进行中）${mapPart}`
  }
  return `${match.t1} vs ${match.t2}（未开始，${untilText(match.planTs)}）`
}

/** 一行赛事描述：赛事名 · 阶段 · BO · 开赛时间。 */
export function matchTitle(match: CsMatch): string {
  return [match.event, match.stage, boLabel(match.bo), formatTs(match.planTs)]
    .filter(Boolean)
    .join(' · ')
}

/** 逐图比分串："Inferno 13:9｜Ancient 11:13"。 */
export function mapsLine(match: CsMatch): string {
  const played = match.maps.filter(m => m.s1 + m.s2 > 0 || m.done)
  if (played.length === 0) return ''
  return played.map(m => `${m.name} ${m.s1}:${m.s2}`).join('｜')
}

/**
 * 按关键词挑一场比赛：先看进行中，再按开赛时间就近。
 * 关键词匹配队名、赛事名、阶段。
 */
export function pickMatch(matches: readonly CsMatch[], query: string): CsMatch | null {
  const q = query.trim().toLowerCase()
  const pool = q
    ? matches.filter(m => [m.t1, m.t2, m.event, m.stage].join(' ').toLowerCase().includes(q))
    : matches.slice()
  if (pool.length === 0) return null
  const order: Record<string, number> = { '1': 0, '0': 1, '2': 2 }
  const now = Date.now() / 1000
  pool.sort((a, b) => {
    const diff = (order[a.status] ?? 3) - (order[b.status] ?? 3)
    if (diff !== 0) return diff
    return Math.abs(a.planTs - now) - Math.abs(b.planTs - now)
  })
  return pool[0] ?? null
}

/** 只留真开打过的图，避免把 TBA 占位当数据。 */
export function playedMaps(match: CsMatch): CsMatch['maps'] {
  return match.maps.filter(m => m.done && m.name && !/^(tba|default)$/i.test(m.name))
}

/** 从"今日 + 未开始 + 已结束"三张表里找到指定 id 的最新状态。 */
export async function refreshById(runtime: CsRuntime, matchId: string): Promise<CsMatch | null> {
  const tables = await Promise.allSettled([
    runtime.fiveE.upcoming(),
    runtime.fiveE.scheduled(),
    runtime.fiveE.finished(1),
  ])
  for (const result of tables) {
    if (result.status !== 'fulfilled') continue
    const hit = result.value.find(m => m.id === matchId)
    if (hit) return hit
  }
  return null
}

/** 今天的比赛，按开赛时间排序。 */
export async function todayMatches(runtime: CsRuntime): Promise<CsMatch[]> {
  const rows = await runtime.fiveE.upcoming()
  return rows
    .filter(m => m.status !== '2')
    .slice()
    .sort((a, b) => a.planTs - b.planTs)
}

/** 一句话概括状态，给"没找到"这类回复用。 */
export function describeStatus(match: CsMatch): string {
  return `${matchTitle(match)}｜${statusLabel(match.status)}｜${scoreline(match)}`
}

/**
 * 取当前会话 id，陪看状态按会话隔离。
 * `exec.agent` 在纯程序化调用（PTC / 测试）里可能是空的，回退到 `default`。
 */
export function sessionIdOf(exec: Pick<ToolRunContext, 'agent'>): string {
  const agent = exec.agent as { session?: { id?: string } } | undefined
  return agent?.session?.id ?? 'default'
}
