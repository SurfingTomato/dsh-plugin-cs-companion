/**
 * 打赌台：用真实赛前赔率开盘，赛后按真实赛果自动结算。
 *
 * 计分规则：一场最多三分（胜负 / 大比分 / 加时各 1 分），双方都押同一套盘口。
 * 彩头是纯文本记录，不做任何自动化执行——它只是"欠着的事"的账本。
 * @module dsh-plugin-cs-companion/tools/bet
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CsMatch } from '../data/fivee.ts'
import { JsonFile } from '../data/store.ts'
import { boLabel, formatTs } from '../util/text.ts'
import { type CsRuntime, pickMatch, scoreline, textOutput } from './common.ts'

type Market = 'winner' | 'series' | 'ot'
type Side = 'her' | 'user'

/** 一注里面押了什么。未押的盘是 `undefined`。 */
interface Picks {
  winner?: string
  series?: string
  ot?: string
}

/** 一个盘口。 */
interface Bet {
  id: string
  matchId: string
  event: string
  stage: string
  t1: string
  t2: string
  bo: string
  markets: Market[]
  openedTs: number
  status: 'open' | 'settled'
  picks: Record<Side, Picks>
  result?: {
    winner: string
    series: string
    ot: boolean
    settledTs: number
    points: Record<Side, number>
    detail: Record<Side, string>
  }
}

/** 彩头：输的人欠的一件事。 */
interface Forfeit {
  id: string
  text: string
  owed: Side
  at: number
  done: boolean
}

interface BetDocument {
  bets: Bet[]
  score: Record<Side, { pts: number; rounds: number }>
  streak: Record<Side, number>
  forfeits: Forfeit[]
}

function emptyDoc(): BetDocument {
  return {
    bets: [],
    score: { her: { pts: 0, rounds: 0 }, user: { pts: 0, rounds: 0 } },
    streak: { her: 0, user: 0 },
    forfeits: [],
  }
}

/** 账本存取。 */
export class BetStore {
  private readonly file: JsonFile<BetDocument>

  constructor(dir: string) {
    this.file = new JsonFile<BetDocument>(dir, 'bets.json')
  }

  /** 读账本。 */
  async load(): Promise<BetDocument> {
    const doc = await this.file.load(emptyDoc)
    if (!Array.isArray(doc.bets)) doc.bets = []
    if (!Array.isArray(doc.forfeits)) doc.forfeits = []
    if (!doc.score) doc.score = emptyDoc().score
    if (!doc.streak) doc.streak = emptyDoc().streak
    return doc
  }

  /** 写账本。 */
  async save(doc: BetDocument): Promise<void> {
    await this.file.save({ ...doc, bets: doc.bets.slice(-80) })
  }
}

/** 大比分盘口的选项；BO3 是 2:0/2:1，BO5 是 3:0/3:1/3:2 的对偶。 */
function seriesOptions(bo: string): string[] {
  const need = bo === '5' ? 3 : 2
  return [`${need}:0`, `${need}:1`, `1:${need}`, `0:${need}`]
}

/** 这场有没有加时：任一张图有一方到 16 分即算。 */
function hasOvertime(match: CsMatch): boolean {
  return match.maps.some(m => m.done && Math.max(m.s1, m.s2) >= 16)
}

function actualResult(match: CsMatch): { winner: string; series: string; ot: boolean } {
  const winner = match.s1 > match.s2 ? match.t1 : match.t2
  return { winner, series: `${match.s1}:${match.s2}`, ot: hasOvertime(match) }
}

/** 注册打赌台的 5 个工具。 */
export function registerBet(ctx: Context, runtime: CsRuntime, store: BetStore): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_bet_open',
    description:
      '开一个盘口：拿真实赛前赔率生成押注题目，等双方各押一注。'
      + '用户说"赌一把""押一注""我们打个赌"，或比赛快开始时你想主动开盘，调用它。'
      + '开完要让用户先押，她自己也押，然后才有意思。',
    parameters: {
      match: { type: 'string', description: '队名或赛事名，留空=最近一场未开始的比赛' },
    },
    output,
    async execute(args, exec) {
      const rows = [...(await runtime.fiveE.upcoming()), ...(await runtime.fiveE.scheduled())]
      const match = pickMatch(rows, args.match ?? '')
      if (!match) return { text: '赛程里没找到能开盘的比赛。直接说没找到，别编。' }

      const doc = await store.load()
      const existing = doc.bets.find(b => b.status === 'open' && b.matchId === match.id)
      if (existing) {
        return {
          text: `这盘已经开着：${existing.t1} vs ${existing.t2}，`
            + `她押 ${describePicks(existing.picks.her) || '还没押'}，用户押 ${describePicks(existing.picks.user) || '还没押'}。`,
        }
      }

      const bo = match.bo || '1'
      const markets: Market[] = ['winner']
      if (bo !== '1') markets.push('series')
      markets.push('ot')
      const bet: Bet = {
        id: randomUUID().slice(0, 10),
        matchId: match.id,
        event: match.event,
        stage: match.stage,
        t1: match.t1,
        t2: match.t2,
        bo,
        markets,
        openedTs: Math.floor(Date.now() / 1000),
        status: 'open',
        picks: { her: {}, user: {} },
      }
      doc.bets.push(bet)
      await store.save(doc)

      const lines = [`【开盘】${match.event} ${match.stage}｜${match.t1} vs ${match.t2}（${boLabel(bo)}）`]
      if (match.o1 && match.o2) {
        lines.push(`赛前赔率换算胜率：${match.t1} ${match.o1}% / ${match.t2} ${match.o2}%`)
      }
      const marks = ['①', '②', '③']
      const items = [`${marks[0]} 谁赢（${match.t1} / ${match.t2}）`]
      if (markets.includes('series')) {
        items.push(`${marks[1]} 大比分（${seriesOptions(bo).join(' / ')}）`)
        items.push(`${marks[2]} 有没有加时（有 / 没有）`)
      } else {
        items.push(`${marks[1]} 有没有加时（有 / 没有）`)
      }
      lines.push(`盘口：${items.join('；')}`)
      lines.push(`押法：cs_bet_place(who="user", winner="${match.t1}")，她自己也押一注。`)
      lines.push(`开赛：${formatTs(match.planTs)}　盘口 id：${bet.id}`)
      return { text: lines.join('\n'), data: { betId: bet.id, matchId: match.id } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_bet_place',
    description:
      '往当前盘口押一注。用户说"我押 A 队""我赌有加时"之后调用；她自己的那一注用 who="her"。'
      + '一次可以只押一个盘，也可以一次押完。',
    parameters: {
      who: { type: 'string', required: true, enum: ['her', 'user'], description: 'her=她押，user=用户押' },
      winner: { type: 'string', description: '押谁赢（队名）' },
      series: { type: 'string', description: '押大比分，如 "2:1"' },
      ot: { type: 'string', description: '押加时："有" 或 "没有"' },
      bet: { type: 'string', description: '盘口 id，留空=最新一个开着的盘' },
    },
    output,
    async execute(args, _exec) {
      const doc = await store.load()
      const bet = args.bet
        ? doc.bets.find(b => b.id === args.bet)
        : doc.bets.filter(b => b.status === 'open').at(-1)
      if (!bet) return { text: '现在没有开着的盘口，先 cs_bet_open。' }
      if (bet.status !== 'open') return { text: '这个盘口已经结算了。' }

      const picks: Picks = { ...bet.picks[args.who] }
      const notes: string[] = []
      if (args.winner) {
        const matched = [bet.t1, bet.t2].find(t => t.toLowerCase() === args.winner?.trim().toLowerCase())
        if (!matched) return { text: `押注无效：这盘只有 ${bet.t1} 和 ${bet.t2} 两个选项。` }
        picks.winner = matched
        notes.push(`谁赢→${matched}`)
      }
      if (args.series) {
        const normalized = args.series.replace(/\s/g, '').replace(/：/g, ':')
        if (!seriesOptions(bet.bo).includes(normalized)) {
          return { text: `押注无效：大比分只能是 ${seriesOptions(bet.bo).join(' / ')}。` }
        }
        picks.series = normalized
        notes.push(`大比分→${normalized}`)
      }
      if (args.ot) {
        const raw = args.ot.trim()
        const on = ['有', 'yes', 'true', 'y', '1'].includes(raw.toLowerCase())
        const off = ['没有', '无', 'no', 'false', 'n', '0'].includes(raw.toLowerCase())
        if (!on && !off) return { text: '押注无效：加时只能押"有"或"没有"。' }
        picks.ot = on ? '有' : '没有'
        notes.push(`加时→${picks.ot}`)
      }
      if (notes.length === 0) return { text: '这一注什么都没押。至少给一个 winner / series / ot。' }

      bet.picks[args.who] = picks
      await store.save(doc)
      const other = args.who === 'her' ? 'user' : 'her'
      const otherText = describePicks(bet.picks[other]) || '还没押'
      return {
        text: `【已押】${args.who === 'her' ? '她' : '用户'}：${notes.join('，')}\n${bet.t1} vs ${bet.t2}　对方：${otherText}`,
        data: { betId: bet.id },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_bet_settle',
    description:
      '结算所有开着的盘口，拿真实赛果算分，更新战绩与连胜。'
      + '比赛结束后（用户问"谁赢了/我赢没赢/结算一下"，或她发现打完了）调用。'
      + '返回的账本可以直接用，但要用她自己的语气念，别照抄。',
    parameters: {},
    output,
    async execute(_args, _exec) {
      const doc = await store.load()
      const open = doc.bets.filter(b => b.status === 'open')
      if (open.length === 0) return { text: '没有待结算的盘口。' }

      const finished = await runtime.fiveE.finished(1)
      const lines: string[] = []
      let settled = 0

      for (const bet of open) {
        const match = finished.find(m => m.id === bet.matchId)
        if (!match || match.status !== '2') continue
        const actual = actualResult(match)
        const points: Record<Side, number> = { her: 0, user: 0 }
        const detail: Record<Side, string> = { her: '', user: '' }

        for (const side of ['her', 'user'] as const) {
          const picks = bet.picks[side]
          const hits: string[] = []
          const misses: string[] = []
          if (picks.winner) {
            if (picks.winner === actual.winner) { points[side] += 1; hits.push('胜负') } else misses.push('胜负')
          }
          if (picks.series) {
            if (picks.series === actual.series) { points[side] += 1; hits.push('大比分') } else misses.push('大比分')
          }
          if (picks.ot) {
            const pickOt = picks.ot === '有'
            if (pickOt === actual.ot) { points[side] += 1; hits.push('加时') } else misses.push('加时')
          }
          detail[side] = [hits.length ? `中 ${hits.join('/')}` : '', misses.length ? `失 ${misses.join('/')}` : '']
            .filter(Boolean)
            .join('，')
        }

        bet.status = 'settled'
        bet.result = {
          winner: actual.winner,
          series: actual.series,
          ot: actual.ot,
          settledTs: Math.floor(Date.now() / 1000),
          points,
          detail,
        }
        for (const side of ['her', 'user'] as const) {
          const score = doc.score[side]
          score.pts += points[side]
          score.rounds += 1
          doc.streak[side] = points[side] > points[side === 'her' ? 'user' : 'her']
            ? doc.streak[side] + 1
            : 0
        }
        settled += 1
        lines.push(
          `【结算】${bet.t1} ${actual.series} ${bet.t2}｜加时：${actual.ot ? '有' : '没有'}`
          + `\n  她 ${points.her} 分（${detail.her || '没押'}）｜用户 ${points.user} 分（${detail.user || '没押'}）`,
        )
      }

      await store.save(doc)
      if (settled === 0) {
        return { text: '开着的盘口都还没打完。等赛果落定再来结算。' }
      }
      lines.push(`累计：她 ${doc.score.her.pts} 分 / ${doc.score.her.rounds} 场（连胜 ${doc.streak.her}）`
        + `｜用户 ${doc.score.user.pts} 分 / ${doc.score.user.rounds} 场（连胜 ${doc.streak.user}）`)
      return { text: lines.join('\n'), data: { settled } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_bet_board',
    description: '看打赌战绩：累计得分、场数、连胜、欠着的彩头。用户问"现在谁赢着""战绩怎么样"时调用。',
    parameters: {},
    output,
    async execute(_args, _exec) {
      const doc = await store.load()
      const open = doc.bets.filter(b => b.status === 'open').length
      const lines = [
        `【战绩】她 ${doc.score.her.pts} 分 / ${doc.score.her.rounds} 场（当前连胜 ${doc.streak.her}）`,
        `　　　　用户 ${doc.score.user.pts} 分 / ${doc.score.user.rounds} 场（当前连胜 ${doc.streak.user}）`,
      ]
      if (open > 0) lines.push(`还开着 ${open} 个盘口。`)
      const owed = doc.forfeits.filter(f => !f.done)
      if (owed.length > 0) {
        lines.push(`欠着的彩头：${owed.map(f => `${f.owed === 'her' ? '她' : '用户'}欠「${f.text}」`).join('；')}`)
      }
      return { text: lines.join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_bet_forfeit',
    description:
      '记一条彩头（输的人欠的事），或把某条标成已兑现。用户说"输了要…""上次那个我做了"时调用。'
      + '只记账，不会替任何人执行。',
    parameters: {
      text: { type: 'string', description: '彩头内容；留空且 done=true 时结算最早一条' },
      owed: { type: 'string', enum: ['her', 'user'], description: '谁欠的，默认 user' },
      done: { type: 'boolean', description: 'true=标记已兑现' },
    },
    output,
    async execute(args, _exec) {
      const doc = await store.load()
      if (args.done) {
        const target = doc.forfeits.find(f => !f.done)
        if (!target) return { text: '没有欠着的彩头。' }
        target.done = true
        await store.save(doc)
        return { text: `已兑现：${target.owed === 'her' ? '她' : '用户'}欠的「${target.text}」` }
      }
      const text = (args.text ?? '').trim()
      if (!text) return { text: '要记彩头的话，得说清欠的是什么。' }
      const owed: Side = args.owed === 'her' ? 'her' : 'user'
      doc.forfeits.push({
        id: randomUUID().slice(0, 8),
        text,
        owed,
        at: Math.floor(Date.now() / 1000),
        done: false,
      })
      await store.save(doc)
      return { text: `记下了：${owed === 'her' ? '她' : '用户'}欠「${text}」` }
    },
  }))
}

/** 把一注渲染成人话，没有押注时返回空串。 */
function describePicks(picks: Picks): string {
  const parts = [
    picks.winner ? `胜负 ${picks.winner}` : '',
    picks.series ? `比分 ${picks.series}` : '',
    picks.ot ? `加时 ${picks.ot}` : '',
  ].filter(Boolean)
  return parts.join(' / ')
}

/** 暴露给测试：一场比赛的"正确答案"。 */
export const _actual = { actualResult, hasOvertime, seriesOptions, scoreline }
