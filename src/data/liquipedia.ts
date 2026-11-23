/**
 * Liquipedia 客户端：选手页、战队页的 wikitext 解析。
 *
 * 条款要求 gzip、可识别 UA（带联系方式）、请求间隔 ≥ 2 秒；429 不重试。
 * 这里的 2.2 秒全局队列是硬约束，不要调小——对方的 API 条款写着的。
 * @module dsh-plugin-cs-companion/liquipedia
 */

import { DataError, fetchJson, sleep } from './http.ts'

const API = 'https://liquipedia.net/counterstrike/api.php'
const MIN_INTERVAL_MS = 2_200

/** 花名册里出现的角色。CEO/分析师这类不属于阵容，必须和选手分开。 */
export type RosterKind = 'player' | 'coach' | 'staff'

/** 一名在队成员。 */
export interface RosterMember {
  readonly id: string
  readonly name: string
  readonly flag: string
  readonly kind: RosterKind
  readonly role: string
  readonly joinDate: string
  readonly leaveDate: string
  readonly newTeam: string
  readonly igl: boolean
  readonly section: 'active' | 'inactive' | 'former'
}

/** 选手卡。`history` 是换队履历，按页面顺序。 */
export interface PlayerCard {
  readonly page: string
  readonly id: string
  readonly name: string
  readonly romanized: string
  readonly country: string
  readonly birthDate: string
  readonly status: string
  readonly team: string
  readonly roles: string
  readonly yearsActive: string
  readonly history: readonly { period: string; team: string; note: string }[]
}

interface CacheEntry<T> {
  readonly at: number
  readonly value: T
}

const PLAYER_TTL_MS = 7 * 24 * 3600 * 1000
const ROSTER_TTL_MS = 12 * 3600 * 1000

/** 删掉 `<ref .../>` 与 `<ref ...>...</ref>`，否则 ref 里的 name= 会覆盖真实姓名。 */
export function stripRefs(text: string): string {
  return text
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
}

/**
 * 花括号配平取一个模板的正文。
 * 非贪婪正则会在第一个 `}}` 就截断——而值里常有 `{{abbr|...}}`。
 * @param text 全文
 * @param start `{{` 的起始下标
 * @returns 内部正文与结束下标（`}}` 之后）
 */
export function braceBlock(text: string, start: number): { body: string; end: number } | null {
  if (!text.startsWith('{{', start)) return null
  let depth = 0
  for (let i = start; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2)
    if (pair === '{{') {
      depth += 1
      i += 1
      continue
    }
    if (pair === '}}') {
      depth -= 1
      i += 1
      if (depth === 0) return { body: text.slice(start + 2, i - 1), end: i + 1 }
    }
  }
  return null
}

/**
 * 取出所有同名模板的正文，按在文中出现的顺序。
 *
 * 关键在于**不能跳过嵌套**：`{{Squad|...|{{Person|...}}}}` 里的 Person 是被 Squad
 * 包住的，如果匹配完 Squad 就把下标跳到块尾，里面的人一个也读不到。
 * 所以这里按名字定位起点，逐个配平，并用起点集合去重（`tabs` 与 `tabs dynamic` 会命中同一块）。
 */
export function templates(text: string, names: readonly string[]): string[] {
  const lower = text.toLowerCase()
  const hits: { at: number; body: string }[] = []
  const seen = new Set<number>()
  for (const name of names) {
    const needle = `{{${name.trim().toLowerCase()}`
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      const after = lower[at + needle.length] ?? ''
      // 排除 `{{Person` 命中 `{{Personality` 这类长名字。
      if (after !== '' && after !== '|' && after !== '}' && after !== '\n' && after !== ' ') {
        from = at + 2
        continue
      }
      if (!seen.has(at)) {
        const block = braceBlock(text, at)
        if (block) {
          seen.add(at)
          hits.push({ at, body: block.body })
        }
      }
      from = at + 2
    }
  }
  return hits.sort((a, b) => a.at - b.at).map(hit => hit.body)
}

/** 拆分模板正文里的 `key=value` 与位置参数。 */
export function templateParams(body: string): { named: Map<string, string>; positional: string[] } {
  const named = new Map<string, string>()
  const positional: string[] = []
  const parts: string[] = []
  let depth = 0
  let buffer = ''
  for (let i = 0; i < body.length; i += 1) {
    const pair = body.slice(i, i + 2)
    if (pair === '{{' || pair === '[[') {
      depth += 1
      buffer += pair
      i += 1
      continue
    }
    if (pair === '}}' || pair === ']]') {
      depth -= 1
      buffer += pair
      i += 1
      continue
    }
    const ch = body[i] as string
    if (ch === '|' && depth === 0) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  parts.push(buffer)

  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq > 0) named.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    else if (part.trim()) positional.push(part.trim())
  }
  return { named, positional }
}

function cleanValue(value: string | undefined): string {
  return (value ?? '')
    .replace(/\{\{[Aa]bbr\|([^|}]*)[^}]*\}\}/g, '$1')
    .replace(/\[\[([^|\]]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

/** 常见旗帜码 → 中文国名。查不到就原样返回代码。 */
const COUNTRY_CN: Record<string, string> = {
  cn: '中国', ru: '俄罗斯', ua: '乌克兰', us: '美国', br: '巴西', dk: '丹麦',
  se: '瑞典', fr: '法国', de: '德国', pl: '波兰', ca: '加拿大', au: '澳大利亚',
  mn: '蒙古', kz: '哈萨克斯坦', tr: '土耳其', il: '以色列', fi: '芬兰', no: '挪威',
  cz: '捷克', sk: '斯洛伐克', hu: '匈牙利', ro: '罗马尼亚', rs: '塞尔维亚', ba: '波黑',
  bg: '保加利亚', lt: '立陶宛', lv: '拉脱维亚', ee: '爱沙尼亚', es: '西班牙', pt: '葡萄牙',
  it: '意大利', gb: '英国', nl: '荷兰', be: '比利时', ar: '阿根廷', cl: '智利',
  za: '南非', in: '印度', id: '印尼', my: '马来西亚', th: '泰国', vn: '越南',
  jp: '日本', kr: '韩国', tw: '中国台湾', hk: '中国香港', sg: '新加坡', by: '白俄罗斯',
  mx: '墨西哥', pe: '秘鲁', uy: '乌拉圭', co: '哥伦比亚', hr: '克罗地亚', si: '斯洛文尼亚',
}

/** 旗帜码转中文国名。 */
export function countryName(code: string): string {
  const key = (code ?? '').trim().toLowerCase()
  if (!key) return '未知'
  return COUNTRY_CN[key] ?? key.toUpperCase()
}

/** 英文国名 → 中文，用于选手页 `country=`（那里是全名不是代码）。 */
const COUNTRY_EN_CN: Record<string, string> = {
  china: '中国', russia: '俄罗斯', ukraine: '乌克兰', 'united states': '美国', brazil: '巴西',
  denmark: '丹麦', sweden: '瑞典', france: '法国', germany: '德国', poland: '波兰',
  canada: '加拿大', australia: '澳大利亚', mongolia: '蒙古', kazakhstan: '哈萨克斯坦',
  turkey: '土耳其', israel: '以色列', finland: '芬兰', norway: '挪威', 'czech republic': '捷克',
  slovakia: '斯洛伐克', hungary: '匈牙利', romania: '罗马尼亚', serbia: '塞尔维亚',
  bosnia: '波黑', 'bosnia and herzegovina': '波黑', bulgaria: '保加利亚', lithuania: '立陶宛',
  latvia: '拉脱维亚', estonia: '爱沙尼亚', spain: '西班牙', portugal: '葡萄牙', italy: '意大利',
  'united kingdom': '英国', netherlands: '荷兰', belgium: '比利时', argentina: '阿根廷',
  chile: '智利', 'south africa': '南非', india: '印度', indonesia: '印尼', malaysia: '马来西亚',
  thailand: '泰国', vietnam: '越南', japan: '日本', 'south korea': '韩国', singapore: '新加坡',
  belarus: '白俄罗斯', mexico: '墨西哥', peru: '秘鲁', uruguay: '乌拉圭', colombia: '哥伦比亚',
  croatia: '克罗地亚', slovenia: '斯洛文尼亚', georgia: '格鲁吉亚', azerbaijan: '阿塞拜疆',
}

function englishCountryCN(value: string): string {
  const cleaned = cleanValue(value).replace(/^flag of\s+/i, '').trim().toLowerCase()
  if (!cleaned) return '未知'
  return COUNTRY_EN_CN[cleaned] ?? cleanValue(value) ?? '未知'
}

/** 从 `{{Person|flag=cn|id=xx|role=Coach}}` 里读一名成员。 */
export function parsePerson(body: string): RosterMember | null {
  const { named } = templateParams(stripRefs(body))
  const id = cleanValue(named.get('id'))
  if (!id) return null
  const role = cleanValue(named.get('role'))
  const roleLower = role.toLowerCase()
  let kind: RosterKind = 'player'
  if (roleLower.includes('coach')) kind = 'coach'
  else if (/manager|analyst|owner|ceo|director|psychologist|content|streamer/.test(roleLower)) kind = 'staff'
  return {
    id,
    name: cleanValue(named.get('name')),
    flag: cleanValue(named.get('flag')),
    kind,
    role,
    joinDate: cleanValue(named.get('joindate')),
    leaveDate: cleanValue(named.get('leavedate')),
    newTeam: cleanValue(named.get('newteam')),
    igl: /^(y|yes|true|1)$/i.test(cleanValue(named.get('igl'))),
    section: 'active',
  }
}

/**
 * 解析战队页的阵容。
 * 只取 `{{tabs dynamic|...|content1=...}}` 里的第一段（CS2 名单），
 * 否则会把 CS:GO 时代的老阵容也算进来。
 */
export function parseRoster(wikitext: string): RosterMember[] {
  const cleaned = stripRefs(wikitext)
  // 页面里可能有好几个 tabs 框（荣誉、阵容、旧名单），要挑 content1 里真有人物的那个。
  const tabs = templates(cleaned, ['tabs dynamic', 'tabs'])
  let scope = cleaned
  for (const body of tabs) {
    const { named } = templateParams(body)
    const content1 = named.get('content1') ?? ''
    if (content1.includes('Person')) {
      scope = content1
      break
    }
  }

  const markers = ['===Active===', '===Inactive===', '===Former===']
  const members: RosterMember[] = []
  let section: RosterMember['section'] = 'active'
  let index = 0
  while (index < scope.length) {
    const nextMarker = markers
      .map(marker => ({ marker, at: scope.indexOf(marker, index) }))
      .filter(item => item.at >= 0)
      .sort((a, b) => a.at - b.at)[0]
    const at = nextMarker ? nextMarker.at : scope.length
    const chunk = scope.slice(index, at)
    for (const body of templates(chunk, ['Person'])) {
      const person = parsePerson(body)
      if (person) members.push({ ...person, section })
    }
    if (!nextMarker) break
    const label = nextMarker.marker.replace(/=/g, '').toLowerCase()
    section = label === 'inactive' ? 'inactive' : label === 'former' ? 'former' : 'active'
    index = nextMarker.at + nextMarker.marker.length
  }
  return members
}

/** 从选手页 wikitext 里读选手卡。 */
export function parsePlayerCard(page: string, wikitext: string): PlayerCard | null {
  const cleaned = stripRefs(wikitext)
  const boxes = templates(cleaned, ['Infobox player', 'Infobox Player'])
  if (boxes.length === 0) return null
  const { named } = templateParams(boxes[0] as string)
  const history: { period: string; team: string; note: string }[] = []
  for (const body of templates(cleaned, ['TH', 'TeamHistory'])) {
    const { positional } = templateParams(body)
    const period = cleanValue(positional[0])
    const team = cleanValue(positional[1])
    if (!team) continue
    history.push({ period, team, note: cleanValue(positional[2]) })
  }
  return {
    page,
    id: cleanValue(named.get('id')),
    name: cleanValue(named.get('name')),
    romanized: cleanValue(named.get('romanized_name')),
    country: englishCountryCN(named.get('country') ?? ''),
    birthDate: cleanValue(named.get('birth_date')),
    status: cleanValue(named.get('status')),
    team: cleanValue(named.get('team')),
    roles: cleanValue(named.get('roles')),
    yearsActive: cleanValue(named.get('years_active')),
    history: history.reverse(),
  }
}

/** Liquipedia 客户端：全局 2.2 秒节流 + 页级缓存。 */
export class LiquipediaClient {
  private readonly contact: string
  private readonly playerCache = new Map<string, CacheEntry<PlayerCard>>()
  private readonly rosterCache = new Map<string, CacheEntry<RosterMember[]>>()
  private readonly teamPageCache = new Map<string, string | null>()
  private lastRequestAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(contact: string) {
    this.contact = contact.trim() || 'you@example.com'
  }

  private userAgent(): string {
    return `dsh-plugin-cs-companion/0.1 (CS2 companion plugin; contact: ${this.contact})`
  }

  /** 串行化所有请求，保证任意两次之间 ≥ 2.2 秒。 */
  private async throttled<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastRequestAt = Date.now()
      return work()
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async call<T>(params: Record<string, string>, label: string): Promise<T> {
    const query = new URLSearchParams({ format: 'json', ...params })
    return this.throttled(() => fetchJson<T>(`${API}?${query.toString()}`, {
      headers: { 'User-Agent': this.userAgent(), 'Accept-Encoding': 'gzip, deflate' },
      // 429 不重试：条款要求直接放弃本轮，重试只会让限流更久。
      retryOnRateLimit: false,
      timeoutMs: 15_000,
      label,
    }))
  }

  /** 取某页的 wikitext。页面不存在返回 null。 */
  async wikitext(title: string): Promise<string | null> {
    const payload = await this.call<{ parse?: { wikitext?: { '*': string } } }>(
      { action: 'parse', page: title, prop: 'wikitext', redirects: '1' },
      'Liquipedia parse',
    ).catch(error => {
      if (error instanceof DataError && error.code === 'UPSTREAM_STATUS') return null
      throw error
    })
    const text = payload?.parse?.wikitext?.['*']
    return typeof text === 'string' ? text : null
  }

  /** 搜索页面标题，命名空间 0。 */
  async search(keyword: string, limit = 5): Promise<string[]> {
    const payload = await this.call<{ query?: { search?: { title: string }[] } }>(
      { action: 'query', list: 'search', srsearch: keyword, srlimit: String(limit), srnamespace: '0' },
      'Liquipedia search',
    )
    return (payload?.query?.search ?? []).map(item => item.title).filter(Boolean)
  }

  /** 选手卡，带 7 天缓存。 */
  async player(page: string): Promise<PlayerCard | null> {
    const hit = this.playerCache.get(page)
    if (hit && Date.now() - hit.at < PLAYER_TTL_MS) return hit.value
    const text = await this.wikitext(page)
    if (!text) return null
    const card = parsePlayerCard(page, text)
    if (card) this.playerCache.set(page, { at: Date.now(), value: card })
    return card
  }

  /** 战队花名册，带 12 小时缓存（转会期页面更新快，别缓存太久）。 */
  async roster(page: string): Promise<RosterMember[]> {
    const hit = this.rosterCache.get(page)
    if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.value
    const text = await this.wikitext(page)
    if (!text) return []
    const members = parseRoster(text)
    this.rosterCache.set(page, { at: Date.now(), value: members })
    return members
  }

  /**
   * 队名 → 战队页标题。
   *
   * 不能只信搜索结果：搜 "Liquid" 第一条可能是某个赛事子页，搜 "FaZe Clan" 第一条可能是教练。
   * 所以每个候选标题都必须**真解析出在队选手**才算命中，否则继续试。
   * 每次尝试都要花 2.2 秒节流，所以最多试 4 个候选。
   */
  async resolveTeamPage(team: string): Promise<string | null> {
    const key = team.trim().toLowerCase()
    const cached = this.teamPageCache.get(key)
    if (cached !== undefined) return cached

    const attempts: string[] = []
    const raw = team.trim()
    if (raw) attempts.push(`Team:${raw}`, raw)

    const verify = async (title: string): Promise<boolean> => {
      const text = await this.wikitext(title).catch(() => null)
      if (!text) return false
      const members = parseRoster(text)
      return members.some(member => member.kind === 'player' && member.section === 'active')
    }

    for (const title of attempts) {
      if (await verify(title)) {
        this.teamPageCache.set(key, title)
        return title
      }
    }

    const candidates = (await this.search(`${raw} Counter-Strike`, 5).catch(() => []))
      .flatMap(title => (title.startsWith('Team:') ? [title] : [`Team:${title}`, title]))
      .slice(0, 4)
    for (const title of candidates) {
      if (await verify(title)) {
        this.teamPageCache.set(key, title)
        return title
      }
    }

    this.teamPageCache.set(key, null)
    return null
  }
}
