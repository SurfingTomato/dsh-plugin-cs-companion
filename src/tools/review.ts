/**
 * 复盘台：赛后逐人数据 + 写死的判据，判「扛把子 / 悲情英雄 / 背锅位 / 隐身」。
 *
 * 判据写在代码里、每次都连同判据一起打印，用户能逐条对上账。
 * 它只评价纸上写着的数字，不给选手加心理戏。
 * @module dsh-plugin-cs-companion/tools/review
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BoutState, CsMatch, MatchDetail, PlayerStat } from '../data/fivee.ts'
import { boLabel, displayWidth, formatTs, padEnd, padStart, signed } from '../util/text.ts'
import { type CsRuntime, pickMatch, playedMaps, textOutput } from './common.ts'

/** 判据原文，每次输出都带上。 */
const RULES = [
  '判据：赢方 rating>=1.25（或 >=1.10 且首杀差>=+3）→ 扛把子；',
  '输方 rating>=1.15 且（KD>0 或 rating>=1.25）→ 悲情英雄；',
  'rating<=0.85，或首杀差<=-3 且 KAST<=65% → 背锅位；',
  'KAST<=60% 且 rating 0.85~1.05 → 隐身；其余中规中矩。',
].join('\n')

/** 一场比赛里一名选手的合计数据（按回合数加权）。 */
interface Aggregate {
  name: string
  kill: number
  death: number
  assist: number
  adrW: number
  kastW: number
  ratingW: number
  rounds: number
  fk: number
  fd: number
  hs: number
  mvp: number
  swing: number
  maps: number
  adr: number
  kast: number
  rating: number
  kd: number
  fkDiff: number
}

function emptyAggregate(name: string): Aggregate {
  return {
    name, kill: 0, death: 0, assist: 0, adrW: 0, kastW: 0, ratingW: 0, rounds: 0,
    fk: 0, fd: 0, hs: 0, mvp: 0, swing: 0, maps: 0, adr: 0, kast: 0, rating: 0, kd: 0, fkDiff: 0,
  }
}

/** 把逐图数据合成整场数据；ADR/KAST/rating 按回合数加权，而不是简单平均。 */
export function aggregate(detail: MatchDetail): { t1: Aggregate[]; t2: Aggregate[] } {
  const teams: { t1: Map<string, Aggregate>; t2: Map<string, Aggregate> } = { t1: new Map(), t2: new Map() }

  for (const bout of detail.bouts) {
    const rounds = Math.max(1, bout.s1 + bout.s2)
    for (const side of ['t1', 't2'] as const) {
      for (const player of bout[side]) {
        const key = player.id || player.name || '?'
        const bucket = teams[side]
        const current = bucket.get(key) ?? emptyAggregate(player.name || key)
        addPlayer(current, player, rounds)
        bucket.set(key, current)
      }
    }
  }

  const finalize = (bucket: Map<string, Aggregate>): Aggregate[] => {
    for (const item of bucket.values()) {
      const rounds = item.rounds || 1
      item.adr = item.adrW / rounds
      item.kast = item.kastW / rounds
      item.rating = item.ratingW / rounds
      item.kd = item.kill - item.death
      item.fkDiff = item.fk - item.fd
    }
    return [...bucket.values()]
  }
  return { t1: finalize(teams.t1), t2: finalize(teams.t2) }
}

function addPlayer(target: Aggregate, player: PlayerStat, rounds: number): void {
  target.kill += player.kill
  target.death += player.death
  target.assist += player.assist
  target.fk += player.fk
  target.fd += player.fd
  target.hs += player.hs
  target.mvp += player.mvp
  target.swing += player.swing
  target.adrW += player.adr * rounds
  target.kastW += player.kast * rounds
  target.ratingW += player.rating * rounds
  target.rounds += rounds
  target.maps += 1
}

/** 判据落地。改这里就等于改判据，README 与输出会同时变。 */
export function verdictOf(player: Aggregate, won: boolean): string {
  const rate = player.rating
  const kd = player.kd
  const fkd = player.fkDiff
  const kast = player.kast
  if (won) {
    if (rate >= 1.25 || (rate >= 1.10 && fkd >= 3)) return '扛把子'
    if (kast <= 60 && rate >= 0.85 && rate <= 1.05) return '隐身'
    if (rate <= 0.85) return '混赢'
    return '中规中矩'
  }
  if (rate >= 1.15 && (kd > 0 || rate >= 1.25)) return '悲情英雄'
  if (rate <= 0.85 || (fkd <= -3 && kast <= 65)) return '背锅位'
  if (kast <= 60 && rate >= 0.85 && rate <= 1.05) return '隐身'
  return '中规中矩'
}

/** 名字列宽：中文按 2 列算，否则 K-D-A 那几列会错位。 */
function nameWidth(names: readonly string[]): number {
  const longest = names.reduce((max, name) => Math.max(max, displayWidth(name)), 8)
  return Math.min(16, Math.max(12, longest + 1))
}

function renderRow(player: Aggregate, verdict: string, width: number): string {
  const star = verdict === '扛把子' || verdict === '悲情英雄' ? '★' : ' '
  return `  ${star}${padEnd(player.name, width)}`
    + `${padStart(String(player.kill), 2)}-${padStart(String(player.death), 2)}-${padEnd(String(player.assist), 2)}`
    + ` ADR ${player.adr.toFixed(1).padStart(5)}  KAST ${padStart(String(Math.round(player.kast)), 3)}%  `
    + `KD ${padStart(signed(player.kd), 3)}  首杀差 ${padStart(signed(player.fkDiff), 2)}  `
    + `评分 ${player.rating.toFixed(2)}  ${verdict}`
}

/**
 * 一队一段。背锅位只点一个人：并列时留评分最低的，其余记"低迷"，
 * 免得一句话把五个人全打成罪犯。
 */
function renderTeam(team: string, players: readonly Aggregate[], won: boolean): string[] {
  if (players.length === 0) return [`\n—— ${team}（无个人数据）——`]
  const sorted = players.slice().sort((a, b) => b.rating - a.rating)
  const verdicts = new Map<string, string>()
  for (const player of sorted) verdicts.set(player.name, verdictOf(player, won))

  const blaming = sorted.filter(player => verdicts.get(player.name) === '背锅位')
  if (blaming.length > 1) {
    const worst = blaming.reduce((a, b) => (a.rating <= b.rating ? a : b))
    for (const player of blaming) {
      if (player !== worst) verdicts.set(player.name, '低迷')
    }
  }

  const width = nameWidth(players.map(player => player.name))
  const lines = [`\n—— ${team}（${won ? '赢' : '输'}）——`]
  for (const player of sorted) {
    lines.push(renderRow(player, verdicts.get(player.name) ?? '中规中矩', width))
  }
  const hero = sorted.find(player => {
    const verdict = verdicts.get(player.name)
    return verdict === '悲情英雄' || verdict === '扛把子'
  })
  const scapegoat = sorted.find(player => verdicts.get(player.name) === '背锅位')
  if (hero) {
    const tag = verdicts.get(hero.name)
    lines.push(`  → ${tag}是 ${hero.name}：${hero.kill}-${hero.death}、ADR ${hero.adr.toFixed(1)}、评分 ${hero.rating.toFixed(2)}`
      + (tag === '悲情英雄' ? '，数据够了但队伍没赢下来' : '，赢下来的主要推力'))
  }
  if (scapegoat) {
    lines.push(`  → 背锅位是 ${scapegoat.name}：${scapegoat.kill}-${scapegoat.death}，评分只有 ${scapegoat.rating.toFixed(2)}、KAST ${Math.round(scapegoat.kast)}%（回合参与不够）`)
  }
  return lines
}

/**
 * 找一场有逐人数据的比赛。
 * 刚结束的比赛 `pr_stats` 是空数组，所以要往前翻，最多翻 8 场。
 */
async function findReviewTarget(runtime: CsRuntime, query: string): Promise<{ match: CsMatch; detail: MatchDetail } | null> {
  const finished = await runtime.fiveE.finished(1)
  if (query.trim()) {
    const picked = pickMatch(finished, query)
    if (!picked) return null
    const detail = await runtime.fiveE.detail(picked.id).catch(() => null)
    if (!detail) return null
    return { match: detail.match.id ? detail.match : picked, detail }
  }

  for (const match of finished.slice(0, 8)) {
    const detail = await runtime.fiveE.detail(match.id).catch(() => null)
    if (!detail) continue
    const hasStats = detail.bouts.some(bout => bout.t1.length > 0 || bout.t2.length > 0)
    if (hasStats) return { match: detail.match.id ? detail.match : match, detail }
  }
  return null
}

/** 注册复盘台的 2 个工具。 */
export function registerReview(ctx: Context, runtime: CsRuntime): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_review',
    description:
      '赛后复盘：逐人 K-D-A / ADR / KAST / 评分 / 首杀差，按写死的判据判「扛把子 / 悲情英雄 / 背锅位 / 隐身」。'
      + '用户问"这场谁在犯罪""谁背锅""谁最惨""复盘一下"时调用。'
      + '判据会随结果一起返回，方便核对。没有逐人数据时它会明确说没有，不要凭比分猜。',
    parameters: {
      match: { type: 'string', description: '队名或赛事名关键词，留空=最近一场有逐人数据的比赛' },
    },
    output,
    async execute(args, _exec) {
      const target = await findReviewTarget(runtime, args.match ?? '')
      if (!target) {
        return { text: '这场还没有逐人数据（刚打完要等几分钟落库）。直接说没有，别凭比分猜谁在犯罪。' }
      }
      const { match, detail } = target
      const maps = playedMaps(match).length > 0 ? playedMaps(match) : detail.bouts
        .filter(bout => bout.mapName)
        .map((bout, index) => ({ n: index + 1, name: bout.mapName, s1: bout.s1, s2: bout.s2, done: true }))
      const t1Wins = maps.filter(map => map.s1 > map.s2).length
      const t2Wins = maps.length - t1Wins
      const series = aggregate(detail)

      const head = [
        `【赛后复盘】${match.t1} ${t1Wins}-${t2Wins} ${match.t2}　${boLabel(match.bo)}　${formatTs(match.planTs)}　${[match.event, match.stage].filter(Boolean).join(' ')}`.trim(),
        `逐图：${maps.map(map => `${map.name} ${map.s1}:${map.s2}`).join('｜')}`,
      ]
      const lines = [...head, ...renderTeam(match.t1, series.t1, t1Wins > t2Wins), ...renderTeam(match.t2, series.t2, t2Wins > t1Wins)]
      lines.push(`\n${RULES}`)
      lines.push('（数据来源：5Eplay 赛后落库；评分是 5E 自己的 rating，不是 HLTV Rating。）')
      return { text: lines.join('\n'), data: { matchId: match.id, maps: maps.length } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_match_stats',
    description:
      '逐图逐人的原始数据表：每张图、每队五人的 K-D-A、ADR、KAST、评分、首杀差。'
      + '用户要"具体数据""给我看表"，或你想自己判断而不套判据时调用。',
    parameters: {
      match: { type: 'string', description: '队名或赛事名关键词，留空=最近一场有数据的比赛' },
    },
    output,
    async execute(args, _exec) {
      const target = await findReviewTarget(runtime, args.match ?? '')
      if (!target) return { text: '没有逐人数据可取。' }
      const { match, detail } = target
      const lines = [`【逐图数据】${match.t1} vs ${match.t2}　${formatTs(match.planTs)}`]
      for (const bout of detail.bouts) {
        lines.push(...renderBout(match, bout))
      }
      return { text: lines.join('\n'), data: { matchId: match.id } }
    },
  }))
}

/** 一张图的表。没有 pr_stats 的图直接标"没有数据"，不装作有。 */
function renderBout(match: CsMatch, bout: BoutState): string[] {
  const lines = [`\n—— ${bout.mapName || '未知图'} ${bout.s1}:${bout.s2} ——`]
  const rows: { team: string; players: readonly PlayerStat[] }[] = [
    { team: match.t1, players: bout.t1 },
    { team: match.t2, players: bout.t2 },
  ]
  let printed = false
  for (const row of rows) {
    if (row.players.length === 0) continue
    printed = true
    lines.push(`${row.team}：`)
    const width = nameWidth(row.players.map(player => player.name))
    for (const player of row.players) {
      lines.push(
        `  ${padEnd(player.name, width)}`
        + `${padStart(String(player.kill), 2)}-${padStart(String(player.death), 2)}-${padEnd(String(player.assist), 2)}`
        + ` ADR ${player.adr.toFixed(1).padStart(5)}  KAST ${padStart(String(Math.round(player.kast)), 3)}%  `
        + `评分 ${player.rating.toFixed(2)}  首杀差 ${padStart(signed(player.fkDiff), 2)}  多杀 ${player.k3}/${player.k4}/${player.k5}`,
      )
    }
  }
  if (!printed) lines.push('  （这张图没有逐人数据）')
  return lines
}
