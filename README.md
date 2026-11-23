# dsh-plugin-cs-companion

**让你的大肥鱼能陪你看 CS 比赛。**

[DeepSeek Harness](https://deepseek.com/harness/)（dsh）版：一个插件、六组能力、22 个工具。
她是 AstrBot 版 `astrbot_plugin_cs_companion` 的同功能移植——同样的接口、同样的判据、同样"查不到就说查不到"。

> Companion plugin for DeepSeek Harness that lets an agent follow a CS2 tournament with you:
> live score injection, match-day radar, bet ledger, schedule/stat queries, player cards,
> and a post-match review that names a scapegoat with reasons.
> All data comes from **5Eplay** and **Liquipedia** — nothing is guessed.

`dsh >= 0.2.2` · `MIT`

---

## 快速开始

### 1. 装上

```bash
# 方式一：本地产出后装进 profile
cd dsh-plugin-cs-companion
npm install --ignore-scripts && npm run build
dsh plugin --profile default add ./dsh-plugin-cs-companion   # 路径用绝对路径更稳

# 方式二：开发期用 scratch overlay，不打包
dsh web --patch ./cordis.patch.yml
```

`cordis.patch.yml` 就是装配清单，改配置只改它：

```yaml
- insert:
    - id: cs-companion
      name: dsh-plugin-cs-companion
      config:
        contact: 'you@example.com'   # ← 换成你的邮箱，Liquipedia 要求的
        groups:
          watchparty: true
          alert: true
          bet: true
          schedule: true
          player: true
          review: true
```

### 2. 必配一项

`contact` 会写进发给 Liquipedia 的 User-Agent。条款要求"可识别 + 带联系方式"，
留占位值能用，但被限流的概率上升。插件启动时会在日志里提醒你。

### 3. 验证

对着 agent 说「今天有什么比赛」，它应该调 `cs_major_today` 并给出真实场次与赛前胜率。
没有数据时会明确说没有——那就是对的。

---

## 和 AstrBot 版的差别

功能一样，落点不一样。dsh 是 agent harness，没有 QQ 通道，所以"功能"要重新找载体：

| AstrBot 版 | dsh 版 | 说明 |
|---|---|---|
| `@filter.command` 指令（`/watch` 等） | 只用工具，不注册斜杠命令 | 模型自己决定何时调；要人类入口的话用 dsh 的 skill 包一层 |
| `on_llm_request` 每轮拼提示词 | `agent/pre-step` 瀑布追加一条 `user` 消息（`form: 'snapshot'`） | 形状与官方 `time-context` 插件一致；内容没变就不重复注入 |
| `push_umo`（QQ 号）主动推送 | `agent.followup()` 投到当前会话 | 投递语义不变，通道换成会话本身；没人的时候它只是躺在会话里 |
| `asyncio` 后台轮询 | `ctx.effect` + `setInterval`（卸载自动清） | 不依赖 timer 插件，任何组装都跑得起来 |
| `data/plugin_data/*.json` | `~/.dsh/cs-companion/*.json` | 原子写（tmp + rename），坏文件不拖死插件 |
| `StarTools.get_data_dir()` | `dataDir` 配置项 | 想放项目里就填相对路径 |
| `aiohttp` | 全局 `fetch` | 零运行时依赖 |

**没变的是核心**：判据、盘口规则、瑞士轮算法、缓存时长、限速、以及"不编数据"这条红线。

---

## 22 个工具

| 组 | 工具 | 做什么 |
|---|---|---|
| 陪看台 | `cs_watch_start` `cs_watch_now` `cs_watch_note` `cs_watch_end` `cs_gap_talk` | 把"正在看的那场"做成持续状态；每轮请求前自动注入真实比分；图间给话题素材 |
| 开赛雷达 | `cs_major_today` `cs_alert_recent` | 按悬念排序的今日清单；最近推过什么。后台轮询抓开赛/开打/图结束/赛点/结束 |
| 打赌台 | `cs_bet_open` `cs_bet_place` `cs_bet_settle` `cs_bet_board` `cs_bet_forfeit` | 真实赛前赔率开三档盘口，赛后按真实赛果结算，累计积分与连胜 |
| 赛程簿 | `cs_schedule` `cs_history` `cs_swiss` `cs_predict` | 未来赛程（含 TBD）、历史统计（地图胜率）、瑞士轮推演、胜率估算 |
| 选手簿 | `cs_player` `cs_roster` `cs_lineup_change` `cs_prematch` | 选手卡、首发五人 + 教练、人员进出、赛前对位 |
| 复盘台 | `cs_review` `cs_match_stats` | 逐人 K-D-A / ADR / KAST / 评分 / 首杀差，按写死的判据判「扛把子 / 悲情英雄 / 背锅位 / 隐身」 |

### 判据（写死在代码里，每次输出都带上）

```
赢方 rating>=1.25（或 >=1.10 且首杀差>=+3）→ 扛把子
输方 rating>=1.15 且（KD>0 或 rating>=1.25）→ 悲情英雄
rating<=0.85，或首杀差<=-3 且 KAST<=65%      → 背锅位
KAST<=60% 且 rating 0.85~1.05                → 隐身
```

背锅位只点一个人：并列时留评分最低的，其余记"低迷"。
一句话：**它只评价纸上写着的数字，不给选手加心理戏。**

---

## 配置项

| 项 | 默认 | 含义 |
|---|---|---|
| `contact` | `you@example.com` | Liquipedia 要求的联系方式 |
| `dataDir` | `''` | 账本目录，留空 = `~/.dsh/cs-companion` |
| `inject` | `true` | 总开关：关掉就只注册工具，不注入比分、不跑雷达 |
| `groups.*` | 全 `true` | 六组能力各自开关，独立可拆 |
| `alert.push` | `true` | 雷达是否往会话投递 |
| `alert.intervalSeconds` | `60` | 轮询间隔，最小 30 |
| `alert.soonMinutes` | `15` | 提前多久提醒开赛 |
| `fiveE.listTtlSeconds` | `180` | 赛程缓存 |
| `fiveE.infoTtlSeconds` | `900` | 逐人数据缓存（已结束的比赛不变） |

---

## 数据源与边界

| 数据 | 来源 | 覆盖 |
|---|---|---|
| 赛程 / 比分 / 逐图 | 5Eplay `session_list` | 未来两日 + 整届预排（TBD 占位）+ 可翻约 1 个月历史 |
| 逐人数据 | 5Eplay `session_info` | 每图每队 5 人：K/D/A、ADR、KAST、rating、首杀差、多杀、回合 MVP |
| 赔率 / 支持率 | `session_list` 内嵌字段 | 赛前胜率百分比，开赛后不再变 |
| 选手 / 阵容 / 换人 | Liquipedia `action=parse` | 百科快照，转会期可能滞后 |

**查不到的**：HLTV（Cloudflare 403）、bo3.gg（同）、5Eplay 其它方法（一律 `Unknown method`）。
所以**没有选手级实时数据流**，只有赛后落库的整场汇总——复盘台依赖这个，刚打完的几分钟内取不到，
会自动往前翻最多 8 场。

接口细节、字段表、踩过的坑见 [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)。

### Liquipedia 条款

gzip、可识别 UA、**请求间隔 ≥ 2 秒**（代码里 2.2 秒全局串行队列）、429 不重试。
**请不要把这个间隔改小。**

---

## 已知限制

- 瑞士轮后续轮次官方不给对阵，`cs_swiss` 按"3 胜晋级 / 同战绩组内 Buchholz 高打低 / 避免重赛"推算，
  输出里写明了这是推算；它只统计轮次赛，不把淘汰赛算进战绩；
- `cs_player` 的阵容来自百科快照，转会窗口期间可能滞后，**不含任何比赛数据**；
- 雷达的"推送"是往会话投 follow-up，不是手机通知；没人看着的时候它只是留在会话里；
- 比分注入只在**该会话有陪看状态**时生效，且内容不变就不重复注入（省 token，也避免复读）；
- 一套账本只服务一个部署（不按 QQ 号分人），多人共用需要给每人挂不同 `dataDir`。

## License

MIT. 数据来自 [5Eplay](https://event.5eplay.com/csgo/matches) 与
[Liquipedia](https://liquipedia.net/counterstrike)（CC BY-SA 3.0）。
