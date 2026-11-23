/**
 * 选手簿：选手卡、首发名单、人员进出、赛前对位。
 *
 * 数据全部来自 Liquipedia 百科快照，`cs_player` 里**没有任何比赛数据**——
 * 比赛数据在复盘台。这两件事分开，是为了"查不到就说查不到"。
 * @module dsh-plugin-cs-companion/tools/player
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countryName, type PlayerCard, type RosterMember } from '../data/liquipedia.ts'
import { type CsRuntime, textOutput } from './common.ts'

/** 从 "2017-05-24" 这种日期算在队月数；解析不出来返回 null。 */
function monthsInTeam(since: string, now = Date.now()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(since.replace(/\?\?/g, '01'))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || !month) return null
  const joined = Date.UTC(year, month - 1, day || 1)
  const months = (now - joined) / (30.44 * 86400 * 1000)
  return Math.max(0, Math.round(months))
}

/** 月数转人话："2 年 3 个月" / "5 个月"。 */
function humanMonths(months: number | null): string {
  if (months === null) return '入队时间未知'
  if (months < 12) return `${months} 个月`
  const years = Math.floor(months / 12)
  const rest = months % 12
  return rest === 0 ? `${years} 年` : `${years} 年 ${rest} 个月`
}

/** 卡片转成几行字。 */
function renderCard(card: PlayerCard): string {
  const lines = [`【${card.id || card.page}】${card.name || card.romanized || ''}`]
  if (card.name && card.romanized && card.name !== card.romanized) lines.push(`真名：${card.name}（${card.romanized}）`)
  const meta = [
    card.country ? `国籍 ${card.country}` : '',
    card.birthDate ? `生日 ${card.birthDate}` : '',
    card.roles ? `位置 ${card.roles}` : '',
    card.team ? `在队 ${card.team}` : '',
  ].filter(Boolean)
  if (meta.length > 0) lines.push(meta.join(' · '))
  if (card.yearsActive) lines.push(`职业年限：${card.yearsActive}`)
  if (card.status) lines.push(`状态：${card.status}`)
  const history = card.history.slice(0, 8)
  if (history.length > 0) {
    lines.push('换队履历（新→旧）：')
    for (const entry of history) {
      const note = entry.note ? `（${entry.note}）` : ''
      lines.push(`- ${entry.period} ${entry.team}${note}`.trim())
    }
  } else {
    lines.push('换队履历：页面里没写。')
  }
  return lines.join('\n')
}

/** 一名成员一行。 */
function renderMember(member: RosterMember): string {
  const parts = [`${member.id}`]
  if (member.name) parts.push(`(${member.name})`)
  parts.push(countryName(member.flag))
  if (member.igl) parts.push('指挥')
  else if (member.role && member.role.toLowerCase() !== 'player') parts.push(member.role)
  if (member.joinDate) parts.push(`入队 ${member.joinDate}`)
  return parts.join(' ')
}

/** 注册选手簿的 4 个工具。 */
export function registerPlayer(ctx: Context, runtime: CsRuntime): void {
  const output = textOutput()

  ctx.tools.register(defineTool({
    name: 'cs_player',
    description:
      '查一名选手的选手卡：真名、国籍、生日、位置、当前队伍、换队履历。'
      + '数据来自 Liquipedia 百科快照，不含任何比赛数据（比赛数据在 cs_match_stats / cs_review）。'
      + '用户问"XX 是谁""他是哪国人""他以前在哪队"时调用。',
    parameters: {
      name: { type: 'string', required: true, description: '选手 id 或昵称，如 "Twistzz"' },
    },
    output,
    async execute(args, exec) {
      const query = args.name.trim()
      const pages = await runtime.liquipedia.search(`${query} Counter-Strike player`, 5)
      const candidate = pages[0]
      if (!candidate) return { text: `Liquipedia 搜不到「${query}」。直接说查不到，别编履历。` }
      const card = await runtime.liquipedia.player(candidate)
      if (!card) return { text: `「${candidate}」页面里没有选手卡（可能是战队页或消歧义页）。` }
      void exec
      const lines = [renderCard(card)]
      if (pages.length > 1) lines.push(`\n其他可能：${pages.slice(1).join('、')}`)
      return { text: lines.join('\n'), data: { page: candidate } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_roster',
    description:
      '查一支队的首发五人 + 教练 + 工作人员。只取 CS2 名单，不会把 CS:GO 时代的老阵容算进来。'
      + '用户问"XX 队现在谁在打""他们教练是谁"时调用。',
    parameters: {
      team: { type: 'string', required: true, description: '队名，如 "FaZe" 或 "Liquid"' },
    },
    output,
    async execute(args, _exec) {
      const page = await runtime.liquipedia.resolveTeamPage(args.team)
      if (!page) return { text: `Liquipedia 找不到「${args.team}」这个队。直接说查不到。` }
      const members = await runtime.liquipedia.roster(page)
      if (members.length === 0) return { text: `${page} 页面里没解析出名单，可能是页面结构变了。` }

      const active = members.filter(m => m.section === 'active')
      const roster = active.filter(m => m.kind === 'player')
      const coaches = active.filter(m => m.kind === 'coach')
      const staff = active.filter(m => m.kind === 'staff')

      const lines = [`【${args.team}｜${page}】`]
      lines.push(roster.length > 0 ? `首发/在队选手（${roster.length}）：` : '没有解析到在队选手。')
      for (const member of roster) lines.push(`- ${renderMember(member)}`)
      if (coaches.length > 0) {
        lines.push('教练：')
        for (const member of coaches) lines.push(`- ${renderMember(member)}`)
      }
      if (staff.length > 0) {
        lines.push(`工作人员（不算阵容）：${staff.map(m => m.id).join('、')}`)
      }
      const inactive = members.filter(m => m.section === 'inactive')
      if (inactive.length > 0) lines.push(`不活跃：${inactive.map(m => m.id).join('、')}`)
      return { text: lines.join('\n'), data: { page, count: roster.length } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_lineup_change',
    description:
      '查一支队近期的人员进出（谁走了、去了哪、谁来了）。'
      + '用户问"他们换人了吗""XX 怎么不在了"时调用。百科快照在转会期可能滞后，回答时要说明。',
    parameters: {
      team: { type: 'string', required: true, description: '队名' },
      months: { type: 'integer', description: '看近几个月，默认 6' },
    },
    output,
    async execute(args, _exec) {
      const span = Math.min(24, Math.max(1, args.months ?? 6))
      const page = await runtime.liquipedia.resolveTeamPage(args.team)
      if (!page) return { text: `Liquipedia 找不到「${args.team}」这个队。` }
      const members = await runtime.liquipedia.roster(page)
      const former = members.filter(m => m.section === 'former')
      if (former.length === 0) return { text: `${args.team} 页面里没有"离队"栏，可能没人走，也可能页面没更新。` }

      const recent = former
        .map(member => ({ member, ago: monthsInTeam(member.leaveDate) }))
        .filter(item => item.ago !== null && item.ago <= span)
        .sort((a, b) => (a.ago ?? 999) - (b.ago ?? 999))

      const lines = [`【${args.team} 近 ${span} 个月离队】`]
      if (recent.length === 0) {
        lines.push('近几个月没有记录到离队。')
      } else {
        for (const { member, ago } of recent) {
          const to = member.newTeam ? ` → ${member.newTeam}` : ''
          lines.push(`- ${member.id}${to}（${member.leaveDate || '日期未知'}，约 ${humanMonths(ago)}前）`)
        }
      }
      const joined = members
        .filter(m => m.section === 'active')
        .map(member => ({ member, ago: monthsInTeam(member.joinDate) }))
        .filter(item => item.ago !== null && item.ago <= span)
        .sort((a, b) => (a.ago ?? 999) - (b.ago ?? 999))
      if (joined.length > 0) {
        lines.push(`近 ${span} 个月加入：`)
        for (const { member, ago } of joined) {
          lines.push(`- ${member.id}（${member.joinDate}，约 ${humanMonths(ago)}前）`)
        }
      }
      lines.push('（百科快照，转会期可能滞后。）')
      return { text: lines.join('\n'), data: { page } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cs_prematch',
    description:
      '赛前对位：两队的首发名单、平均在队时长、近期人员进出，给出"哪边阵容更稳"的一句话。'
      + '用户问"这两队谁阵容更稳""赛前看看人"时调用。不含比赛数据，也不做胜负预测（那是 cs_predict）。',
    parameters: {
      t1: { type: 'string', required: true, description: '第一支队' },
      t2: { type: 'string', required: true, description: '第二支队' },
    },
    output,
    async execute(args, _exec) {
      const sides: { team: string; page: string; members: RosterMember[] }[] = []
      for (const team of [args.t1, args.t2]) {
        const page = await runtime.liquipedia.resolveTeamPage(team)
        if (!page) {
          sides.push({ team, page: '', members: [] })
          continue
        }
        const members = await runtime.liquipedia.roster(page)
        sides.push({ team, page, members: members.filter(m => m.section === 'active' && m.kind === 'player') })
      }

      const lines: string[] = []
      const tenure: { team: string; avg: number | null }[] = []
      for (const side of sides) {
        if (side.members.length === 0) {
          lines.push(`【${side.team}】没取到名单（百科页面缺失或结构变了）。`)
          tenure.push({ team: side.team, avg: null })
          continue
        }
        lines.push(`【${side.team}】${side.members.map(renderMember).join('、')}`)
        const months = side.members
          .map(member => monthsInTeam(member.joinDate))
          .filter((value): value is number => value !== null)
        const avg = months.length > 0 ? Math.round(months.reduce((a, b) => a + b, 0) / months.length) : null
        const newest = months.length > 0 ? Math.min(...months) : null
        lines.push(`  · 平均在队 ${humanMonths(avg)}${newest !== null ? `，最近加入 ${humanMonths(newest)}前` : ''}`)
        tenure.push({ team: side.team, avg })

        const page = side.page
        if (page) {
          const all = await runtime.liquipedia.roster(page)
          const gone = all
            .filter(m => m.section === 'former')
            .map(member => ({ member, ago: monthsInTeam(member.leaveDate) }))
            .filter(item => item.ago !== null && item.ago <= 4)
          if (gone.length > 0) {
            lines.push(`  · 近 4 个月离队 ${gone.length} 人：${gone.map(i => `${i.member.id}${i.member.newTeam ? `→${i.member.newTeam}` : ''}`).join('、')}`)
          }
        }
      }

      const known = tenure.filter((item): item is { team: string; avg: number } => item.avg !== null)
      if (known.length === 2) {
        const [a, b] = known as [{ team: string; avg: number }, { team: string; avg: number }]
        const stable = a.avg >= b.avg ? a : b
        const fresh = stable === a ? b : a
        lines.push(`· 默契：${stable.team} 平均 ${humanMonths(stable.avg)}，${fresh.team} 平均 ${humanMonths(fresh.avg)}，后者的阵容更新。`)
      } else if (known.length === 1) {
        lines.push('· 只有一边取到名单，比不了默契。')
      } else {
        lines.push('· 两边都没取到名单，别硬比。')
      }
      return { text: lines.join('\n') }
    },
  }))
}
