/**
 * 陪看台：把「正在看的那场」变成持续状态。
 *
 * 与 AstrBot 版的差别只在两处：比分注入从 `on_llm_request` 换成
 * `agent/pre-step` 瀑布（见 index.ts）；状态按 session 隔离，不再需要 QQ 号。
 * @module dsh-plugin-cs-companion/tools/watchparty
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CsMatch } from '../data/fivee.ts'
import { JsonFile } from '../data/store.ts'
import { boLabel } from '../util/text.ts'
import {
  type CsRuntime,
  mapsLine,
  matchTitle,
  pickMatch,
  refreshById,
  scoreline,
  sessionIdOf,
  textOutput,
} from './common.ts'

/** 图间话头的常识卡池。都是不会过时的硬事实，具体选手数据一律不入池。 */
const GAP_CARDS: readonly { q: string; fact?: string }[] = [
  { q: '一回合正赛是 1 分 55 秒，购买时间 20 秒。可以问她：开局那 20 秒她一般在想什么', fact: 'MR12 制' },
  { q: 'C4 下包后 40 秒爆炸，这个数字比很多人以为的长', fact: '40 秒' },
  { q: '拆包没钳子 10 秒、有钳子 5 秒 —— 所以最后一秒的假拆永远值钱', fact: '钳子减半' },
  { q: '12:12 进加时，加时是 MR3、先到 4 分。可以问她：你觉得加时更考验心态还是枪法', fact: '加时先到 4 分' },
  { q: '打满 12 回合换边。可以问她：换边后你更爱看哪边' },
  { q: '图池（Active Duty）常年就那 7 张，所以每张图的固定套路才那么深', fact: '7 张图' },
  { q: '烟雾弹大概 18 秒，燃烧弹大概 7 秒 —— 进攻方的时间窗口基本就是拿这个算的', fact: '约 18s / 7s' },
  { q: '省一口气的经济局不是放弃，是攒下一把的枪。可以问她：你受得了队友硬 eco 吗' },
  { q: 'AWP 除了打腿基本一枪一个，所以架点的人比冲点的人更怕被发现', fact: '躯干一枪' },
  { q: 'Major 小组赛多是 BO1、淘汰赛才 BO3，所以 BO1 里一个手枪局就能决定一整天', fact: 'BO1 容错极低' },
  { q: '她觉得这行里最像"永远差一口气"的是哪支队' },
  { q: '如果只能留一张图，她留哪张' },
  { q: '她第一次看 CS 是哪一年，看的谁' },
  { q: '看比赛她更在意操作还是配合' },
  { q: '她打的时候最怕队友干什么' },
  { q: '有没有哪场她看完当天睡不着' },
  { q: '她觉得解说的哪句话最没用' },
  { q: '如果让她挑一个选手的打法去学，她学谁' },
]

/** 一条临场判断。记下当时比分，事后回看才知道她说得对不对。 */
export interface WatchNote {
  readonly at: number
  readonly score: string
  readonly text: string
}

/** 一个会话的陪看状态。 */
export interface WatchState {
  matchId: string
  t1: string
  t2: string
  event: string
  stage: string
  bo: string
  startedAt: number
  notes: WatchNote[]
  gapUsed: number[]
  /** 上一次注入给模型的比分串，用来判重，别每轮都塞同样的话 */
  lastInjected?: string
}

interface WatchDocument {
  sessions: Record<string, WatchState>
}

/** 陪看状态的存取。一个 session 一条，互不干扰。 */
export class WatchStore {
  private readonly file: JsonFile<WatchDocument>

  constructor(dir: string) {
    this.file = new JsonFile<WatchDocument>(dir, 'watch.json')
  }

  private async doc(): Promise<WatchDocument> {
    return this.file.load(() => ({ sessions: {} }))
  }

  /** 读某会话的陪看状态。 */
  async get(sessionId: string): Promise<WatchState | null> {
    const doc = await this.doc()
    return doc.sessions[sessionId] ?? null
  }

  /** 写某会话的陪看状态。 */
  async set(sessionId: string, state: WatchState): Promise<void> {
    await this.file.update(doc => {
      doc.sessions[sessionId] = state
    })
  }

  /** 结束陪看，返回被清掉的状态。 */
  async clear(sessionId: string): Promise<WatchState | null> {
    const doc = await this.doc()
    const previous = doc.sessions[sessionId] ?? null
    if (!previous) return null
    await this.file.update(next => {
      delete next.sessions[sessionId]
    })
    return previous
  }

  /** 所有正在陪看的会话，雷达与注入都用得上。 */
  async active(): Promise<{ sessionId: string; state: WatchState }[]> {
    const doc = await this.doc()
    return Object.entries(doc.sessions).map(([sessionId, state]) => ({ sessionId, state }))
  }
}

function toState(match: CsMatch): WatchState {
  return {
    matchId: match.id,
    t1: match.t1,
    t2: match.t2,
    event: match.event,
    stage: match.stage,
    bo: match.bo,
    startedAt: Math.floor(Date.now() / 1000),
    notes: [],
    gapUsed: [],
    lastInjected: '',
  }
}

/**
 * 给模型看的比分块。注入和 `cs_watch_now` 共用同一份渲染，
 * 免得"注入的是真比分、回答里是另一套"。
 */
export function renderInjection(match: CsMatch, state: WatchState): string {
  const lines = [`[陪看中｜真实数据] ${scoreline(match)}`, matchTitle(match)]
  const maps = mapsLine(match)
  if (maps) lines.push(`逐图：${maps}`)
  if (match.o1 && match.o2) lines.push(`赛前胜率：${match.t1} ${match.o1}% / ${match.t2} ${match.o2}%`)
  const notes = state.notes.slice(-3)
  if (notes.length > 0) {
    lines.push(`她之前说过：${notes.map(n => n.text).join('；')}`)
  }
  lines.push('（比分是接口实取；没给的数字不要补。）')
  return lines.join('\n')
}

/** 注册陪看台的 5 个工具。 */
export function registerWatchParty(ctx: Context, runtime: CsRuntime, store: WatchStore): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_watch_start',
    description:
      '开始陪看一场比赛：把这场做成持续状态，之后每轮对话前都会自动带上真实比分。'
      + '用户说"一起看这场""陪我看看""开始看比赛"，或指定了队名时调用。'
      + '留空则挑一场正在打的，没有在打的就挑最近要开的。',
    parameters: {
      match: { type: 'string', description: '队名或赛事名关键词，留空=自动挑一场' },
    },
    output,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const rows = [
        ...(await runtime.fiveE.upcoming()),
        ...(await runtime.fiveE.scheduled()),
      ]
      const match = pickMatch(rows, args.match ?? '')
      if (!match) {
        return { text: '赛程里没找到这一场，直接说没找到，别编比分。' }
      }
      const state = toState(match)
      runtime.remember(match)
      await store.set(sessionId, state)
      const lines = [`【开始陪看】${scoreline(match)}`, matchTitle(match)]
      const maps = mapsLine(match)
      if (maps) lines.push(`逐图：${maps}`)
      if (match.status === '0') lines.push('还没开打，先用赛前信息聊；开打后每轮会自动带上比分。')
      return { text: lines.join('\n'), data: { matchId: match.id } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_watch_now',
    description:
      '刷新当前陪看比赛的比分。用户问"现在几比几""打到哪张图了"，或你想确认状态时调用。'
      + '返回的是接口实取的数据；如果接口没数据，就照实说没取到。',
    parameters: {},
    output,
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const state = await store.get(sessionId)
      if (!state) return { text: '现在没在陪看。要开就调 cs_watch_start。' }
      const match = await refreshById(runtime, state.matchId)
      if (!match) return { text: '这场从赛程里消失了，接口没返回。直接说查不到，别猜比分。' }
      runtime.remember(match)
      return { text: `【当前比分】\n${renderInjection(match, state)}`, data: { matchId: match.id } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_watch_note',
    description:
      '记一条她的临场判断，连带当时的真实比分一起存档。'
      + '她说了"我觉得这局要没了""他这波不该上"这类预判时调用，赛后可以回看准不准。',
    parameters: {
      text: { type: 'string', required: true, description: '要说的话，用她自己的语气，别加工' },
    },
    output,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const state = await store.get(sessionId)
      if (!state) return { text: '现在没在陪看，先 cs_watch_start 再记判断。' }
      const match = await refreshById(runtime, state.matchId)
      if (match) runtime.remember(match)
      const score = match ? scoreline(match) : `${state.t1} vs ${state.t2}`
      const notes = [...state.notes, { at: Math.floor(Date.now() / 1000), score, text: args.text.trim() }]
      await store.set(sessionId, { ...state, notes: notes.slice(-30) })
      return { text: `已记下（${score}）：${args.text.trim()}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_watch_end',
    description:
      '结束陪看，返回这一场的临场判断清单。用户说"看完了""不看了"，或比赛已结束你想收尾时调用。',
    parameters: {},
    output,
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const state = await store.clear(sessionId)
      if (!state) return { text: '现在没在陪看，不用收尾。' }
      const meta = [state.event, state.stage, boLabel(state.bo)].filter(Boolean).join(' · ')
      const lines = [`【陪看结束】${state.t1} vs ${state.t2}${meta ? `　${meta}` : ''}`]
      if (state.notes.length === 0) {
        lines.push('这场她没留下判断。')
      } else {
        lines.push('她这场的判断：')
        for (const note of state.notes) lines.push(`- [${note.score}] ${note.text}`)
      }
      return { text: lines.join('\n'), data: { notes: state.notes.length } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_gap_talk',
    description:
      '图与图之间没话说时，拿几条可抛的话头。比分部分来自接口实取，常识卡来自固定池子，'
      + '除此之外不要自己补数字。用户沉默了一阵、或比赛在暂停时调用。',
    parameters: {},
    output,
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const state = await store.get(sessionId)
      if (!state) return { text: '现在没在陪看，不用找话头。' }
      const match = await refreshById(runtime, state.matchId)
      if (!match) return { text: '比分接口没返回，先别找话头，容易说错。' }
      runtime.remember(match)

      const material: string[] = []
      const maps = match.maps.filter(m => m.done && m.name)
      if (maps.length > 0) {
        const last = maps.at(-1)
        if (last) {
          const diff = Math.abs(last.s1 - last.s2)
          const close = diff <= 2
          material.push(
            `刚打完 ${last.name}，${last.s1}:${last.s2}`
            + (close ? `，只差 ${diff} 分——这图是不是被谁一波带走的` : `，分差 ${diff}，可以问她这张图哪边先崩的`),
          )
        }
      }
      if (match.status === '1' && match.o1 && match.o2) {
        const favored = match.o1 >= match.o2 ? match.t1 : match.t2
        const underdog = favored === match.t1 ? match.t2 : match.t1
        const lead = Math.max(match.s1, match.s2)
        const behind = Math.min(match.s1, match.s2)
        if (lead > behind) {
          const leading = match.s1 > match.s2 ? match.t1 : match.t2
          if (leading === favored) {
            material.push(`赛前 ${favored} 被看好，现在也确实领先，可以问她觉得会不会被翻`)
          } else {
            material.push(`${underdog} 正在领先，赛前只有 ${Math.min(match.o1, match.o2)}%，这波能守住吗`)
          }
        }
      }
      const pool = GAP_CARDS.filter((_card, index) => !state.gapUsed.includes(index))
      const usable = pool.length > 0 ? pool : GAP_CARDS.slice()
      const picked = usable[Math.floor(Math.random() * usable.length)]
      if (picked) {
        const index = GAP_CARDS.indexOf(picked)
        const used = [...state.gapUsed, index].slice(-GAP_CARDS.length)
        await store.set(sessionId, { ...state, gapUsed: used })
        material.push(picked.fact ? `${picked.q}（${picked.fact}）` : picked.q)
      }
      return { text: `【图间可用的话头】\n${material.map(item => `- ${item}`).join('\n')}` }
    },
  }))
}
