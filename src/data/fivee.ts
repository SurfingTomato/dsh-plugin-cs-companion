/**
 * 5Eplay 客户端：赛事列表与逐人数据。
 *
 * 只有两个方法可用（`session_list` / `session_info`），其余一律 Unknown method，
 * 详见 docs/DATA_SOURCES.md。字段全是字符串，归一化在这里一次做完。
 * @module dsh-plugin-cs-companion/fivee
 */

import { DataError, fetchJson } from './http.ts'
import { int, num } from '../util/text.ts'

const LIST_API = 'https://app.5eplay.com/api/tournament/session_list'
const INFO_API = 'https://app.5eplay.com/api/tournament/session_info'
const REFERER = 'https://event.5eplay.com/csgo/matches'

/** 5E 的赛事状态：0 未开始 / 1 进行中 / 2 已结束。 */
export type GameStatus = 0 | 1 | 2

/** 单张图的比分。 */
export interface CsMap {
  readonly n: number
  readonly name: string
  readonly s1: number
  readonly s2: number
  readonly done: boolean
}

/** 归一化后的一场比赛。原始接口里什么都可能是字符串，这里已经转好。 */
export interface CsMatch {
  readonly id: string
  readonly event: string
  readonly stage: string
  readonly planTs: number
  readonly t1: string
  readonly t2: string
  /** '1' | '2' | '3' | '5' */
  readonly bo: string
  /** '0' | '1' | '2' */
  readonly status: string
  readonly s1: number
  readonly s2: number
  readonly maps: readonly CsMap[]
  /** 赛前胜率百分比，取不到为 null */
  readonly o1: number | null
  readonly o2: number | null
}

/** 一名选手在某张图上的数据，全部来自 `t1_pr_stats` / `t2_pr_stats`。 */
export interface PlayerStat {
  readonly id: string
  readonly name: string
  readonly kill: number
  readonly death: number
  readonly assist: number
  readonly adr: number
  readonly kast: number
  readonly rating: number
  readonly kdDiff: number
  readonly fkDiff: number
  readonly fk: number
  readonly fd: number
  readonly hs: number
  readonly k3: number
  readonly k4: number
  readonly k5: number
  readonly mvp: number
  readonly swing: number
  readonly tradedDeath: number
  readonly clutchWins: number
}

/** `session_info` 里的一张图。 */
export interface BoutState {
  readonly mapName: string
  readonly status: string
  readonly s1: number
  readonly s2: number
  readonly t1: readonly PlayerStat[]
  readonly t2: readonly PlayerStat[]
}

/** `session_info` 的归一化结果。 */
export interface MatchDetail {
  readonly match: CsMatch
  readonly bouts: readonly BoutState[]
}

interface RawRecord {
  readonly [key: string]: unknown
}

function asRecord(value: unknown): RawRecord {
  return (value && typeof value === 'object' ? value : {}) as RawRecord
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function dispName(info: unknown, fallback: string): string {
  const name = asRecord(info)['disp_name']
  return typeof name === 'string' && name.trim() ? name.trim() : fallback
}

function pctOrNull(value: unknown): number | null {
  const n = int(value, 0)
  return n > 0 ? n : null
}

/**
 * 把接口返回的一条 `matches` 记录压成 {@link CsMatch}。
 * 大比分以 `state.t1_score` 为准，但若逐图结果更多则以图计数兜底——
 * 结算瞬间接口会短暂不同步，两者取大能避免显示 0:0 赢下的比赛。
 */
export function normalizeMatch(raw: unknown): CsMatch {
  const row = asRecord(raw)
  const info = asRecord(row['mc_info'])
  const state = asRecord(row['state'])
  const tt = asRecord(row['tt_info'])
  const bouts = asArray(state['bout_states'])

  const maps: CsMap[] = []
  for (const entry of bouts) {
    const bout = asRecord(entry)
    const name = String(bout['map_name'] ?? '').trim()
    if (!name) continue
    maps.push({
      n: int(bout['bout_num'], maps.length + 1),
      name,
      s1: int(bout['t1_score'], 0),
      s2: int(bout['t2_score'], 0),
      done: String(bout['status'] ?? '') === '2',
    })
  }

  const fromMaps1 = maps.filter(m => m.done && m.s1 > m.s2).length
  const fromMaps2 = maps.filter(m => m.done && m.s2 > m.s1).length

  return {
    id: String(info['id'] ?? ''),
    event: String(tt['disp_name'] ?? '').trim(),
    stage: String(info['round_name'] ?? info['tt_stage'] ?? '').trim(),
    planTs: int(info['plan_ts'], 0),
    t1: dispName(info['t1_info'], 'TBD'),
    t2: dispName(info['t2_info'], 'TBD'),
    bo: String(info['format'] ?? '1'),
    status: String(state['status'] ?? '0'),
    s1: Math.max(int(state['t1_score'], 0), fromMaps1),
    s2: Math.max(int(state['t2_score'], 0), fromMaps2),
    maps,
    o1: pctOrNull(state['t1_odds_percent']),
    o2: pctOrNull(state['t2_odds_percent']),
  }
}

function normalizePlayer(raw: unknown): PlayerStat {
  const p = asRecord(raw)
  return {
    id: String(p['id'] ?? ''),
    name: String(p['name'] ?? p['id'] ?? '?'),
    kill: int(p['kill'], 0),
    death: int(p['death'], 0),
    assist: int(p['assist'], 0),
    adr: num(p['adr'], 0),
    kast: num(p['kast'], 0),
    rating: num(p['rating'], 0),
    kdDiff: int(p['kd_diff'], 0),
    fkDiff: int(p['fkdiff'], 0),
    fk: int(p['first_blood_num'], 0),
    fd: int(p['first_death_num'], 0),
    hs: int(p['headshot'], 0),
    k3: int(p['k3'], 0),
    k4: int(p['k4'], 0),
    k5: int(p['k5'], 0),
    mvp: int(p['round_mvp'], 0),
    swing: num(p['swing'], 0),
    tradedDeath: int(p['traded_death'], 0),
    clutchWins: int(p['cl_win_num'], 0),
  }
}

interface CacheEntry<T> {
  readonly at: number
  readonly value: T
}

/** 5Eplay 客户端。列表按状态缓存，`session_info` 由调用方决定缓存策略。 */
export class FiveEClient {
  private readonly listCache = new Map<number, CacheEntry<readonly CsMatch[]>>()
  private readonly infoCache = new Map<string, CacheEntry<MatchDetail>>()
  private readonly listTtlMs: number
  private readonly infoTtlMs: number

  constructor(options: { listTtlMs?: number; infoTtlMs?: number } = {}) {
    this.listTtlMs = options.listTtlMs ?? 180_000
    this.infoTtlMs = options.infoTtlMs ?? 900_000
  }

  /**
   * 取一批比赛。
   * @param status 0 未开始 / 1 今日 / 2 已结束
   * @param page 页码，从 1 开始
   * @param limit 每页条数，越大越慢（100 条约 1.1 秒）
   */
  async list(
    status: GameStatus,
    page = 1,
    limit = 60,
    signal?: AbortSignal,
  ): Promise<readonly CsMatch[]> {
    const key = status * 1000 + page
    const hit = this.listCache.get(key)
    if (hit && Date.now() - hit.at < this.listTtlMs) return hit.value

    const url = `${LIST_API}?game_status=${status}&game_type=1&page=${page}&limit=${limit}`
    const payload = await fetchJson<{ data?: { matches?: unknown[] } }>(url, {
      headers: { Referer: REFERER },
      label: '5Eplay session_list',
      signal,
    })
    const rows = asArray(payload?.data?.matches).map(normalizeMatch)
    const value = rows.filter(m => m.id)
    this.listCache.set(key, { at: Date.now(), value })
    return value
  }

  /** 今日 + 明天的比赛（`game_status=1`）。 */
  async upcoming(signal?: AbortSignal): Promise<readonly CsMatch[]> {
    return this.list(1, 1, 60, signal)
  }

  /** 整届赛事的预排（`game_status=0`），含后续轮次的 TBD 占位。 */
  async scheduled(signal?: AbortSignal): Promise<readonly CsMatch[]> {
    const first = await this.list(0, 1, 100, signal)
    if (first.length < 100) return first
    const second = await this.list(0, 2, 100, signal)
    return [...first, ...second]
  }

  /** 已结束的比赛（`game_status=2`），第 1 页是最近的。 */
  async finished(page = 1, signal?: AbortSignal): Promise<readonly CsMatch[]> {
    return this.list(2, page, 100, signal)
  }

  /**
   * 逐人数据。刚结束的比赛 `pr_stats` 还是空数组，所以这里不做"自动前翻"，
   * 由复盘台自己决定翻几页——原因见 docs/DATA_SOURCES.md。
   */
  async detail(matchId: string, signal?: AbortSignal): Promise<MatchDetail> {
    if (!matchId) throw new DataError('BAD_MATCH_ID', '没有 match id，取不到逐人数据')
    const hit = this.infoCache.get(matchId)
    if (hit && Date.now() - hit.at < this.infoTtlMs) return hit.value

    const url = `${INFO_API}?match_id=${encodeURIComponent(matchId)}&id=${encodeURIComponent(matchId)}`
    const payload = await fetchJson<{ data?: { match?: Record<string, unknown> } }>(url, {
      headers: { Referer: REFERER },
      label: '5Eplay session_info',
      signal,
      timeoutMs: 15_000,
    })
    const match = asRecord(payload?.data?.match)
    if (!Object.keys(match).length) {
      throw new DataError('NO_DETAIL', '这场没有逐人数据，别凭比分猜')
    }

    const bouts: BoutState[] = []
    for (const entry of asArray(match['bouts_state'])) {
      const bout = asRecord(entry)
      const t1s = asRecord(bout['t1_stats'])
      const t2s = asRecord(bout['t2_stats'])
      bouts.push({
        mapName: String(bout['map_name'] ?? '').trim(),
        status: String(bout['status'] ?? ''),
        s1: int(t1s['all_score'], 0),
        s2: int(t2s['all_score'], 0),
        t1: asArray(bout['t1_pr_stats']).map(normalizePlayer),
        t2: asArray(bout['t2_pr_stats']).map(normalizePlayer),
      })
    }

    const value: MatchDetail = { match: normalizeMatch(match), bouts }
    this.infoCache.set(matchId, { at: Date.now(), value })
    return value
  }

  /** 清空缓存，`cs_alert` 之类的长跑任务用它强制拿新数据。 */
  invalidate(): void {
    this.listCache.clear()
    this.infoCache.clear()
  }
}
