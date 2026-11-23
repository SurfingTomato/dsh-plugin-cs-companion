/**
 * 赛程簿：未来赛程、历史赛果与统计、瑞士轮推演、胜率估算。
 *
 * 瑞士轮后续轮次官方不给对阵，`cs_swiss` 是按"3 胜晋级、同战绩组内 Buchholz 高打低、
 * 避免重赛"推出来的，返回值里必须写明这是推算。
 * @module dsh-plugin-cs-companion/tools/schedule
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CsMatch } from '../data/fivee.ts'
import { boLabel, formatDay, formatTs, untilText } from '../util/text.ts'
import { type CsRuntime, mapsLine, pickMatch, playedMaps, scoreline, textOutput } from './common.ts'

/** 一支队的瑞士轮战绩。 */
interface Standing {
  team: string
  wins: number
  losses: number
  opponents: string[]
  buchholz: number
}

/** 从已结束的比赛里累加战绩。只统计赛事名包含关键字的场次。 */
function buildStandings(matches: readonly CsMatch[], keyword: string): Map<string, Standing> {
  const table = new Map<string, Standing>()
  const ensure = (team: string): Standing => {
    const hit = table.get(team)
    if (hit) return hit
    const fresh: Standing = { team, wins: 0, losses: 0, opponents: [], buchholz: 0 }
    table.set(team, fresh)
    return fresh
  }

  for (const match of matches) {
    if (match.status !== '2') continue
    if (!match.t1 || !match.t2 || match.t1 === 'TBD' || match.t2 === 'TBD') continue
    if (keyword && !`${match.event} ${match.stage}`.toLowerCase().includes(keyword.toLowerCase())) continue
    if (match.s1 === match.s2) continue
    const winner = match.s1 > match.s2 ? match.t1 : match.t2
    const loser = winner === match.t1 ? match.t2 : match.t1
    const w = ensure(winner)
    const l = ensure(loser)
    w.wins += 1
    l.losses += 1
    w.opponents.push(loser)
    l.opponents.push(winner)
  }

  for (const standing of table.values()) {
    standing.buchholz = standing.opponents.reduce(
      (sum, opponent) => sum + (table.get(opponent)?.wins ?? 0),
      0,
    )
  }
  return table
}

/** 排序：胜场优先，其次 Buchholz，最后字母序，保证输出稳定。 */
function rankStandings(table: Map<string, Standing>): Standing[] {
  return [...table.values()].sort((a, b) =>
    b.wins - a.wins
    || b.buchholz - a.buchholz
    || (a.losses - b.losses)
    || a.team.localeCompare(b.team))
}

/**
 * 下一轮配对推演：同战绩组内按 Buchholz 高打低，遇到重赛则与相邻顺位交换。
 * @returns 配对列表；组内落单时下沉到下一个战绩组。
 */
function pairNextRound(ranked: readonly Standing[], played: ReadonlySet<string>): { a: string; b: string; note: string }[] {
  const byRecord = new Map<string, Standing[]>()
  for (const standing of ranked) {
    const key = `${standing.wins}-${standing.losses}`
    const list = byRecord.get(key) ?? []
    list.push(standing)
    byRecord.set(key, list)
  }

  const pairs: { a: string; b: string; note: string }[] = []
  const groups = [...byRecord.entries()].sort((a, b) => {
    const [aw, al] = a[0].split('-').map(Number)
    const [bw, bl] = b[0].split('-').map(Number)
    return (bw ?? 0) - (aw ?? 0) || (al ?? 0) - (bl ?? 0)
  })

  for (const [key, group] of groups) {
    const pool = group.slice()
    while (pool.length >= 2) {
      const first = pool.shift() as Standing
      let index = 0
      let partner = pool[index]
      while (partner && played.has(`${first.team}|${partner.team}`)) {
        index += 1
        partner = pool[index]
      }
      if (!partner) {
        // 组内没有没打过的对手，硬配顺位下一个，标注重赛。
        partner = pool[0] as Standing
        if (!partner) break
        pool.splice(0, 1)
        pairs.push({ a: first.team, b: partner.team, note: `${key} 组，只剩余下这个对手（重赛）` })
        continue
      }
      pool.splice(index, 1)
      pairs.push({ a: first.team, b: partner.team, note: `${key} 组，Buchholz ${first.buchholz} vs ${partner.buchholz}` })
    }
    if (pool.length === 1) {
      pairs.push({ a: pool[0]?.team ?? '', b: '（轮空/待定）', note: `${key} 组人数为奇数，这一位需要下沉或轮空` })
    }
  }
  return pairs
}

/** logistic：地图胜率差映射成 BO 胜率，封顶 15%–85%，绝不输出"稳赢"。 */
function estimateWinRate(myMapRate: number, theirMapRate: number): number {
  const diff = (myMapRate - theirMapRate) / 100
  const raw = 1 / (1 + Math.exp(-3.2 * diff))
  return Math.min(85, Math.max(15, Math.round(raw * 100)))
}

/** 近 N 天一支队的地图胜率与场次。 */
function teamForm(matches: readonly CsMatch[], team: string, sinceSeconds: number): { mapRate: number; series: number; mapWins: number; mapLosses: number } {
  let mapWins = 0
  let mapLosses = 0
  let series = 0
  for (const match of matches) {
    if (match.status !== '2') continue
    if (match.planTs < sinceSeconds) continue
    if (match.t1 !== team && match.t2 !== team) continue
    series += 1
    const mine = match.t1 === team ? 's1' : 's2'
    for (const map of playedMaps(match)) {
      const own = map[mine]
      const other = mine === 's1' ? map.s2 : map.s1
      if (own > other) mapWins += 1
      else if (own < other) mapLosses += 1
    }
  }
  const total = mapWins + mapLosses
  return { mapRate: total === 0 ? 50 : Math.round((mapWins / total) * 100), series, mapWins, mapLosses }
}

/** 注册赛程簿的 4 个工具。 */
export function registerSchedule(ctx: Context, runtime: CsRuntime): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_schedule',
    description:
      '未来赛程，按天分组。含整届赛事的预排与后续轮次的 TBD 占位。'
      + '用户问"后面还有什么比赛""明天打什么""这个赛事还有几轮"时调用。'
      + '返回的标题写了"已确定对阵 N 场"：这 N 场必须一场不漏地列全（几点、谁打谁），'
      + '不能只挑一两场就总结成"就这几场"。'
      + '赛程是实时数据，随时会补队名、改时间：即使用户重复问、即使你记得刚查过，也必须重新调用，'
      + '不许凭旧回答复述。用户再问一次通常意味着上次答得不对。',
    parameters: {
      days: { type: 'integer', description: '看几天内的，默认 3 天，最多 14 天' },
      event: { type: 'string', description: '只看某个赛事，填赛事名关键词' },
    },
    output,
    async execute(args, _exec) {
      const span = Math.min(14, Math.max(1, args.days ?? 3))
      const now = Math.floor(Date.now() / 1000)
      const deadline = now + span * 86400
      const keyword = (args.event ?? '').trim().toLowerCase()

      const rows = [...(await runtime.fiveE.upcoming()), ...(await runtime.fiveE.scheduled())]
      const seen = new Set<string>()
      const pool = rows.filter(match => {
        if (!match.id || seen.has(match.id)) return false
        seen.add(match.id)
        if (match.status === '2') return false
        if (match.planTs > deadline) return false
        if (keyword && !`${match.event} ${match.stage}`.toLowerCase().includes(keyword)) return false
        return true
      }).sort((a, b) => a.planTs - b.planTs)

      if (pool.length === 0) return { text: `${span} 天内没有已排定的比赛（接口没返回）。直接说没有，别编赛程。` }

      // 已定对阵和 TBD 占位分开：占位几十场会把真实对阵淹掉，模型容易只挑一两场讲
      const isTbd = (m: CsMatch) => m.t1 === 'TBD' || m.t2 === 'TBD' || !m.t1 || !m.t2
      const decidedCount = pool.filter(m => !isTbd(m)).length

      interface DayBucket { decided: CsMatch[]; tbd: number }
      const byDay = new Map<string, DayBucket>()
      for (const match of pool) {
        const day = formatDay(match.planTs)
        const bucket = byDay.get(day) ?? { decided: [], tbd: 0 }
        if (isTbd(match)) bucket.tbd += 1
        else bucket.decided.push(match)
        byDay.set(day, bucket)
      }

      const lines: string[] = [`【未来 ${span} 天】共 ${pool.length} 场，其中已确定对阵 ${decidedCount} 场`]
      for (const day of [...byDay.keys()].sort()) {
        const bucket = byDay.get(day)
        if (!bucket) continue
        lines.push(`\n—— ${day} ——`)
        for (const match of bucket.decided) {
          lines.push(`${formatTs(match.planTs)} ${match.t1} vs ${match.t2}　${boLabel(match.bo)}　${untilText(match.planTs)}`)
          if (match.stage || match.event) lines.push(`   ${[match.event, match.stage].filter(Boolean).join(' · ')}`)
        }
        if (bucket.tbd > 0) lines.push(`另有 ${bucket.tbd} 场对阵未定（TBD，等上一轮打完才填队名）`)
      }

      if (decidedCount > 0) {
        lines.push(
          `\n（上面 ${decidedCount} 场都是已经排好队名的真实对阵，讲的时候必须一场不漏地列全，`
          + '别只说开头一两场就下"只有几场"的结论；只有 TBD 那些才算未定。）',
        )
      } else {
        lines.push('\n（TBD 是官方还没定下的对阵，不是没查到。）')
      }
      return { text: lines.join('\n'), data: { count: pool.length, decided: decidedCount } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_history',
    description:
      '历史赛果与统计。可以只看某支队：返回它近期的场次、地图胜率、回合差、场均击杀。'
      + '用户问"XX 最近怎么样""他们上一场赢了没"时调用。',
    parameters: {
      team: { type: 'string', description: '队名关键词，留空=最近所有已结束的比赛' },
      limit: { type: 'integer', description: '最多几场，默认 10' },
    },
    output,
    async execute(args, _exec) {
      const limit = Math.min(30, Math.max(1, args.limit ?? 10))
      const keyword = (args.team ?? '').trim().toLowerCase()
      const pages = [await runtime.fiveE.finished(1)]

      let pool = dedupe(pages.flat().filter(m => m.status === '2'))
      if (keyword) {
        pool = pool.filter(m => `${m.t1} ${m.t2}`.toLowerCase().includes(keyword))
        if (pool.length < limit) {
          pool = dedupe([
            ...pool,
            ...(await runtime.fiveE.finished(2)).filter(
              m => m.status === '2' && `${m.t1} ${m.t2}`.toLowerCase().includes(keyword),
            ),
          ])
        }
      }
      pool = pool.slice(0, limit)
      if (pool.length === 0) return { text: '已结束的比赛里没找到匹配的场次。' }

      const lines: string[] = []
      if (keyword) {
        const since = Math.floor(Date.now() / 1000) - 30 * 86400
        const forms = new Map<string, { mapRate: number; series: number; mapWins: number; mapLosses: number }>()
        for (const match of pool) {
          for (const team of [match.t1, match.t2]) {
            if (!forms.has(team)) forms.set(team, teamForm(pool, team, since))
          }
        }
        for (const [team, form] of forms) {
          if (!team.toLowerCase().includes(keyword)) continue
          lines.push(`【${team}】近 ${form.series} 场：地图 ${form.mapWins} 胜 ${form.mapLosses} 负，地图胜率 ${form.mapRate}%`)
        }
      }

      for (const match of pool) {
        const maps = mapsLine(match)
        lines.push(`${formatTs(match.planTs)} ${scoreline(match)}　${boLabel(match.bo)}`)
        if (maps) lines.push(`   逐图：${maps}`)
        if (match.stage) lines.push(`   ${[match.event, match.stage].filter(Boolean).join(' · ')}`)
      }
      return { text: lines.join('\n'), data: { count: pool.length } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_swiss',
    description:
      '瑞士轮当前积分与下一轮配对推演。用户问"现在谁几胜几负""下一轮谁打谁""谁能出线"时调用。'
      + '⚠️ 后续轮次官方不给对阵，配对是按 3 胜晋级 / 同战绩组内 Buchholz 推出来的，'
      + '回答时必须说明这是推算。',
    parameters: {
      event: { type: 'string', description: '赛事名关键词，留空=用最近已结束比赛所属赛事' },
      advance: { type: 'integer', description: '几胜晋级，默认 3' },
    },
    output,
    async execute(args, _exec) {
      const advance = Math.min(4, Math.max(2, args.advance ?? 3))
      const finished = dedupe(
        [...(await runtime.fiveE.finished(1)), ...(await runtime.fiveE.finished(2))]
          .filter(m => m.status === '2' && m.t1 !== 'TBD' && m.t2 !== 'TBD'),
      )
      if (finished.length === 0) return { text: '还没有已结束的比赛，瑞士轮无从算起。' }

      const keyword = (args.event ?? '').trim() || mostCommonEvent(finished) || ''
      // 瑞士轮只算轮次赛；淘汰赛（半决赛/决赛/季军赛）是另一套口径，混进来会算出 4-1 这种战绩。
      const swissOnly = finished.filter(m => isSwissStage(m.stage))
      const scoped = swissOnly.length > 0 ? swissOnly : finished
      const table = buildStandings(scoped, keyword)
      if (table.size === 0) return { text: `已结束的比赛里没找到「${keyword}」的场次。` }
      const ranked = rankStandings(table)

      const lines = [`【瑞士轮推算｜${keyword}｜${advance} 胜晋级】`]
      lines.push('战绩　Buchholz　队伍')
      for (const standing of ranked) {
        const flag = standing.wins >= advance ? ' ✅ 晋级' : standing.losses >= advance ? ' ❌ 淘汰' : ''
        lines.push(`${standing.wins}-${standing.losses}　　${standing.buchholz}　　　${standing.team}${flag}`)
      }

      const played = new Set<string>()
      for (const match of scoped) {
        if (!`${match.event} ${match.stage}`.toLowerCase().includes(keyword.toLowerCase())) continue
        played.add(`${match.t1}|${match.t2}`)
        played.add(`${match.t2}|${match.t1}`)
      }
      const alive = ranked.filter(s => s.wins < advance && s.losses < advance)
      const pairs = pairNextRound(alive, played)
      if (pairs.length > 0) {
        lines.push('\n【下一轮配对（推算，非官宣）】')
        for (const pair of pairs) lines.push(`${pair.a} vs ${pair.b}　（${pair.note}）`)
      }
      lines.push('\n⚠️ 对阵为推算结果；官方公布的为准。')
      return { text: lines.join('\n'), data: { teams: ranked.length, keyword } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_predict',
    description:
      '估一场比赛的胜率。有赛前赔率就用赔率（并说明是市场预期），没有才用近 14 天地图胜率做估算，'
      + '并标明"估算"、封顶 15%–85%。绝不说"稳赢"。用户问"谁更可能赢""你看好谁"时调用。',
    parameters: {
      match: { type: 'string', description: '队名或赛事名，留空=最近一场未开始的比赛' },
    },
    output,
    async execute(args, _exec) {
      const rows = [...(await runtime.fiveE.upcoming()), ...(await runtime.fiveE.scheduled())]
      const match = pickMatch(rows, args.match ?? '')
      if (!match) return { text: '赛程里没找到这一场，直接说没找到。' }

      const lines = [`【胜率】${scoreline(match)}`, `${[match.event, match.stage, boLabel(match.bo)].filter(Boolean).join(' · ')}`]
      if (match.o1 && match.o2) {
        lines.push(`来源：赛前赔率换算（市场预期，不是预测模型）`)
        lines.push(`${match.t1} ${match.o1}%　/　${match.t2} ${match.o2}%`)
        const gap = Math.abs(match.o1 - match.o2)
        lines.push(gap <= 10 ? '两边几乎五五开，这种盘最容易爆冷。' : `市场认为 ${match.o1 >= match.o2 ? match.t1 : match.t2} 更被看好。`)
        return { text: lines.join('\n'), data: { source: 'odds' } }
      }

      const since = Math.floor(Date.now() / 1000) - 14 * 86400
      const finished = [...(await runtime.fiveE.finished(1)), ...(await runtime.fiveE.finished(2))]
      const form1 = teamForm(finished, match.t1, since)
      const form2 = teamForm(finished, match.t2, since)
      const rate1 = estimateWinRate(form1.mapRate, form2.mapRate)
      lines.push('来源：近 14 天地图胜率 logistic 估算（没有赔率，只能这么估）')
      lines.push(`${match.t1} ${rate1}%（地图胜率 ${form1.mapRate}%，${form1.series} 场）`)
      lines.push(`${match.t2} ${100 - rate1}%（地图胜率 ${form2.mapRate}%，${form2.series} 场）`)
      if (form1.series === 0 || form2.series === 0) lines.push('⚠️ 有一方近 14 天没有可查场次，这个估算很不稳，说的时候要打折。')
      return { text: lines.join('\n'), data: { source: 'estimate' } }
    },
  }))
}

/** 出现次数最多的赛事名，作为瑞士轮的默认范围。 */
function mostCommonEvent(matches: readonly CsMatch[]): string | null {
  const counter = new Map<string, number>()
  for (const match of matches) {
    if (!match.event) continue
    counter.set(match.event, (counter.get(match.event) ?? 0) + 1)
  }
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1])
  return sorted[0]?.[0] ?? null
}

/** 两页数据会有重叠，按比赛 id 去重并保留原顺序。 */
function dedupe(matches: readonly CsMatch[]): CsMatch[] {
  const seen = new Set<string>()
  const out: CsMatch[] = []
  for (const match of matches) {
    if (seen.has(match.id)) continue
    seen.add(match.id)
    out.push(match)
  }
  return out
}

/** 这一场是不是瑞士轮/小组赛的轮次赛（排除淘汰赛）。 */
function isSwissStage(stage: string): boolean {
  const text = (stage ?? '').trim()
  if (!text) return false
  if (/淘汰|季军|决赛|半决赛|playoff|final|third place/i.test(text)) return false
  return /第\s*[0-9一二三四五六七八九十]+\s*轮|round\s*[0-9]+|swiss|瑞士/i.test(text)
}
