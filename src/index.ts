/**
 * DeepSeek Harness 版「CS 观赛陪伴」插件。
 *
 * 六个子能力、22 个工具，映射到 AstrBot 版的同名实现：
 * - 陪看台：比分注入从 `on_llm_request` 换成 `agent/pre-step` 瀑布；
 * - 开赛雷达：后台轮询 + `agent.followup()` 投递（dsh 没有 QQ 通道，投递到会话本身）；
 * - 其余四组：纯工具 + 本地 JSON 账本。
 *
 * 一切以"能查的真查、查不到的明说不知道"为准，具体约束见 docs/DATA_SOURCES.md。
 * @module dsh-plugin-cs-companion
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import { FiveEClient, type CsMatch } from './data/fivee.ts'
import { LiquipediaClient } from './data/liquipedia.ts'
import { resolveDataDir } from './data/store.ts'
import { AlertStore, composePush, registerAlert, rememberEvents, scanEvents } from './tools/alert.ts'
import { BetStore, registerBet } from './tools/bet.ts'
import { type CsRuntime, refreshById } from './tools/common.ts'
import { registerPlayer } from './tools/player.ts'
import { registerReview } from './tools/review.ts'
import { registerSchedule } from './tools/schedule.ts'
import { registerWatchParty, WatchStore, renderInjection } from './tools/watchparty.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'cs-companion': { kind: 'cs-companion' } & ContextFormed
  }
}

/** Loader 里显示的名字。 */
export const name = 'cs-companion'

/** 只依赖工具注册表；`agent/pre-step` 与 `agents` 都不用注入，事件监听是纯注册。 */
export const inject = ['tools']

/** 部署配置。全部有默认值，`cordis.patch.yml` 里只写要改的项。 */
export interface Config {
  /** Liquipedia 要求的联系方式，会写进 User-Agent。 */
  contact: string
  /** 账本目录，留空=~/.dsh/cs-companion */
  dataDir: string
  /** 总开关：false 时只注册工具，不做比分注入与雷达推送。 */
  inject: boolean
  /** 六组能力的开关。 */
  groups: {
    watchparty: boolean
    alert: boolean
    bet: boolean
    schedule: boolean
    player: boolean
    review: boolean
  }
  alert: {
    /** 关掉就只记录不投递。 */
    push: boolean
    /** 轮询间隔，单位秒，最小 30。 */
    intervalSeconds: number
    /** 提前多久提醒开赛。 */
    soonMinutes: number
  }
  fiveE: {
    /** 赛程缓存秒数。 */
    listTtlSeconds: number
    /** 逐人数据缓存秒数（已结束的比赛不变，可以长）。 */
    infoTtlSeconds: number
  }
}

/** Schemastery 校验，非法值在加载期就失败，不留到运行期。 */
export const Config: Schema<Config> = Schema.object({
  contact: Schema.string().default('you@example.com').description('Liquipedia 要求的联系方式'),
  dataDir: Schema.string().default('').description('账本目录，留空=~/.dsh/cs-companion'),
  inject: Schema.boolean().default(true).description('是否启用比分注入与雷达推送'),
  groups: Schema.object({
    watchparty: Schema.boolean().default(true),
    alert: Schema.boolean().default(true),
    bet: Schema.boolean().default(true),
    schedule: Schema.boolean().default(true),
    player: Schema.boolean().default(true),
    review: Schema.boolean().default(true),
  }).description('六组能力的开关'),
  alert: Schema.object({
    push: Schema.boolean().default(true).description('是否往会话里投递提醒'),
    intervalSeconds: Schema.natural().min(30).max(3600).default(60).description('轮询间隔（秒）'),
    soonMinutes: Schema.natural().min(5).max(120).default(15).description('提前多久提醒开赛'),
  }).description('开赛雷达'),
  fiveE: Schema.object({
    listTtlSeconds: Schema.natural().min(30).max(3600).default(180),
    infoTtlSeconds: Schema.natural().min(60).max(86400).default(900),
  }).description('5Eplay 缓存'),
})

/** 比赛内存缓存：注入时直接读，不在 pre-step 里发网络请求。 */
interface CachedMatch {
  readonly at: number
  readonly match: CsMatch
}

/**
 * 挂载插件。
 * @param ctx 插件作用域，工具注册与事件监听都随它卸载。
 * @param config 已按 {@link Config} 校验并填好默认值的部署配置。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = resolveDataDir(config.dataDir)
  // 嵌在别人的进程里时可能没有 logger 服务，退化成 console，不让插件起不来。
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('cs-companion')
    : { info: (m: string) => console.log(`[cs-companion] ${m}`), warn: (m: string) => console.warn(`[cs-companion] ${m}`) }
  const cache = new Map<string, CachedMatch>()
  let lastAgent: Agent | null = null

  if (config.contact === 'you@example.com') {
    logger.warn('contact 还是占位值，Liquipedia 可能限流；请在 cordis.patch.yml 里填真实邮箱。')
  }

  const runtime: CsRuntime = {
    fiveE: new FiveEClient({
      listTtlMs: config.fiveE.listTtlSeconds * 1000,
      infoTtlMs: config.fiveE.infoTtlSeconds * 1000,
    }),
    liquipedia: new LiquipediaClient(config.contact),
    dataDir,
    contact: config.contact,
    log: message => logger.info(message),
    remember: match => { cache.set(match.id, { at: Date.now(), match }) },
  }

  const watchStore = new WatchStore(dataDir)
  const betStore = new BetStore(dataDir)
  const alertStore = new AlertStore(dataDir)

  if (config.groups.watchparty) registerWatchParty(ctx, runtime, watchStore)
  if (config.groups.alert) registerAlert(ctx, runtime, alertStore)
  if (config.groups.bet) registerBet(ctx, runtime, betStore)
  if (config.groups.schedule) registerSchedule(ctx, runtime)
  if (config.groups.player) registerPlayer(ctx, runtime)
  if (config.groups.review) registerReview(ctx, runtime)

  logger.info(`已注册工具；账本目录 ${dataDir}`)

  if (!config.inject) return

  // ── 比分注入：每轮请求前把真实比分塞进上下文 ──────────────────────────
  // AstrBot 版是 on_llm_request 动态拼提示词；这里走 pre-step 瀑布追加一条
  // user 消息，形状和 time-context 一致（form: 'snapshot'）。内容没变就不重复注入。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    lastAgent = payload.agent

    const sessionId = payload.agent.session.id
    const state = await watchStore.get(sessionId).catch(() => null)
    if (!state) return decision

    const cached = cache.get(state.matchId)
    if (!cached) return decision

    const text = renderInjection(cached.match, state)
    if (text === state.lastInjected) return decision
    await watchStore.set(sessionId, { ...state, lastInjected: text }).catch(() => undefined)

    const content: ContentBlock[] = [{ type: 'text', text }]
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content,
          source: { kind: 'cs-companion', form: 'snapshot', sections: [{ name: 'cs-scoreline', text }] },
        }),
      ],
    }
  })

  // ── 开赛雷达：轮询 + 合并投递 ─────────────────────────────────────────
  const intervalMs = Math.max(30, config.alert.intervalSeconds) * 1000
  ctx.effect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        await runRadarRound()
      } catch (error) {
        logger.warn(`雷达轮询失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const timer = setInterval(() => { void tick() }, intervalMs)
    void tick()

    return () => {
      stopped = true
      clearInterval(timer)
    }
  })

  async function runRadarRound(): Promise<void> {
    // 1) 暖缓存：正在陪看的比赛顺手刷新，注入端零网络请求。
    const watching = await watchStore.active().catch(() => [])
    for (const { state } of watching) {
      const fresh = await refreshById(runtime, state.matchId).catch(() => null)
      if (fresh) cache.set(fresh.id, { at: Date.now(), match: fresh })
    }

    // 2) 扫事件：开赛 / 开打 / 图结束 / 赛点 / 结束，同一轮合并成一条。
    const matches = await runtime.fiveE.upcoming()
    const doc = await alertStore.load()
    const events = scanEvents(matches, doc, Math.floor(Date.now() / 1000), config.alert.soonMinutes)
    if (events.length === 0) return

    const nextDoc = rememberEvents(doc, events)
    await alertStore.save(nextDoc)
    logger.info(`雷达产出 ${events.length} 条事件`)

    if (!config.alert.push) return
    const text = composePush(events)
    if (!text || !lastAgent) return
    try {
      lastAgent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'cs-companion', form: 'notice', summary: `${events.length} 条赛事提醒` },
      }))
    } catch (error) {
      // agent 可能已经被 dispose（会话关闭），这不值得让雷达停摆。
      logger.warn(`投递失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

