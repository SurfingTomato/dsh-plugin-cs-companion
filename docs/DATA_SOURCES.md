# 数据源笔记

写这批插件时把能试的接口都试了一遍，成功和失败的都记在这里，省下一个人再摸一遍的时间。

---

## 一、5Eplay（主数据源）

站点 `https://event.5eplay.com/csgo/matches` 是 SPA，页面本身不含数据，数据走 app 端接口。
**只探测到两个可用方法**，其余全部返回 `Unknown method`。

### 1.1 `session_list`

```
GET https://app.5eplay.com/api/tournament/session_list
    ?game_status=<0|1|2>&game_type=1&page=<n>&limit=<n>
Referer: https://event.5eplay.com/csgo/matches
User-Agent: <一个正常的浏览器 UA>
```

| 参数 | 含义 | 覆盖 |
|---|---|---|
| `game_status=0` | 未开始 | 第 1–2 页（limit=100）能拿到整届赛事的预排场次，含后续轮次的 TBD 占位 |
| `game_status=1` | 今日 | 今天 + 明天 |
| `game_status=2` | 已结束 | 分页可翻约 1 个月；limit=100 约 2.5 天/页，单请求约 1.1 秒 |

返回结构（裁剪）：

```jsonc
{"data": {"matches": [{
  "mc_info": {
    "id": "csgo_mc_2400755",
    "plan_ts": "1795399200",          // 计划开赛时间（秒）
    "format": "3",                    // 1/2/3/5 → BO1/BO2/BO3/BO5
    "round_name": "第一轮",
    "t1_info": {"disp_name": "Detonate"},
    "t2_info": {"disp_name": "NXG"}
  },
  "tt_info": {"disp_name": "PGL 新加坡 Major 2026 第1阶段"},
  "state": {
    "status": "0|1|2",                // 未开始 / 进行中 / 已结束
    "t1_score": "2", "t2_score": "0",
    "t1_odds_percent": "64",          // 赛前支持率/赔率
    "t2_odds_percent": "36"
  }
}]}}
```

注意：`t1_odds_percent` 是**赛前**数值，比赛开始后不再变，所以可以拿来当"市场预期"用，
并在赛后判断是否爆冷。

### 1.2 `session_info` ← 逐人数据的唯一来源

```
GET https://app.5eplay.com/api/tournament/session_info?match_id=<id>&id=<id>
```

同一个 id 传两次即可（两个参数名都认）。

结构（裁剪，只列有意义的）：

```
data.match
├── mc_info                // 同上
├── global_state
│   └── avg_player_stats   // 全场平均：adr / dpr / kast / kpr / kd_rate …
└── bouts_state[]          // 每张图一条
    ├── map_name           // "Inferno" / "Cache"；未开赛时是 "" 或 "TBA"/"Default"
    ├── status             // 2 = 这张图已结束
    ├── t1_stats
    │   ├── all_score      // 本图比分
    │   ├── fh_score / sh_score / ot_score   // 半场、加时
    │   ├── fh_role / sh_role                // 上下半场谁打 CT
    │   ├── fh_data[12] / sh_data[12]        // 逐回合胜负（1 胜 0 负），可做"连丢几局"
    │   └── flags
    ├── t1_pr_stats[5]     // ★ 五名选手
    └── t2_pr_stats[5]
```

单名选手的字段（全部为字符串，注意转换）：

| 字段 | 示例 | 用途 |
|---|---|---|
| `id` / `name` | `csgo_pl_20429` / `CrePoW` | 选手标识与显示名 |
| `kill` `death` `assist` | `19` `7` `4` | K-D-A |
| `kd_diff` | `+12` | K-D 差 |
| `adr` | `126.8` | 每回合伤害 |
| `kast` | `93.8%` | 回合参与率 |
| `rating` | `1.73` | **5E 自己的评分**，不是 HLTV Rating，别混称 |
| `mk_rating` | `1.15` | 另一套评分，慎用 |
| `impact` | `0.00` | 实测常为空/0，没敢用 |
| `headshot` / `head_shot_rate` | `10` / `52.6%` | 爆头 |
| `first_blood_num` / `first_death_num` | `4` / `1` | 首杀 / 首死 |
| `fkdiff` | `+3` | 首杀差（开局贡献） |
| `k2` `k3` `k4` `k5` | | 双杀到五杀回合数 |
| `round_mvp` | `4` | 回合 MVP 次数 |
| `swing` | `+6.80%` | 对回合胜负的影响力合计 |
| `round_swing[]` | `{"round":"1","swing":"0.19"}` | **逐回合**影响力，可定位"哪一回合送掉的" |
| `cl_win_num` | `0` | 残局获胜数 |
| `traded_death` | `1` | 死后被队友换掉的次数 |
| `v1`–`v5` | | 1vX 残局次数 |
| `alive` | `+3` | 存活人数合计 |

复盘台的判定就建立在这些字段上，映射关系见 `astrbot_plugin_cs_review/main.py` 的 `_verdict()`。

**坑**：刚结束的比赛 `t1_pr_stats` 是 `[]`，要等几分钟才落库。所以 `_pick()` 会往后翻最多 8 场，
直到找到真有数据的那一场，而不是拿最新一场硬跑。

### 1.3 走不通的（别浪费时间）

```
/api/tournament/match_detail      → {"status":false,"error":"Unknown method"}
/api/tournament/team_detail       → 同上
/api/tournament/player_list       → 同上
/api/tournament/match_stat        → 同上
/api/tournament/player_stat       → 同上
/api/tournament/session_detail    → 同上
```

---

## 二、Liquipedia（选手与阵容）

```
GET https://liquipedia.net/counterstrike/api.php
    ?action=parse&page=<Title>&prop=wikitext&format=json&redirects=1
GET ...?action=query&format=json&list=search&srsearch=<kw>&srlimit=5&srnamespace=0
```

### 2.1 必须遵守的条款

- **必须 gzip**（`Accept-Encoding: gzip, deflate`，aiohttp 默认就会解）；
- **UA 必须能识别并带联系方式**；
- **请求间隔 ≥ 2 秒**。代码里是 `MIN_INTERVAL = 2.2` + 全局 `asyncio.Lock`；
- 429 不要重试，直接放弃本轮。

### 2.2 选手页

`{{Infobox player}}` 里可用字段：

```
|id= |name= |romanized_name= |birth_date= |country= |status=
|team= |roles= |nicknames= |years_active=
|team_history= {{TH|起 — 止|队名|注}}   ← 租借/替补写在第三个参数
```

`country` 是**英文全名**（`Ukraine`），不是旗帜码；花名册里反而是旗帜码（`ua`）。
两个映射表都要有。

### 2.3 战队页

`==Player Roster==` 下面是：

```
{{tabs dynamic |name1=CS2 |content1=
===Active===
{{Squad|status=active
|{{Person|flag=cn|id=westmelon|igl=y|name=Niu Zhe|joindate=2017-05-24 <ref .../>}}
|{{Person|flag=cn|id=GUM|role=Coach|name=Dai Yifei|joindate=2023-03-??}}
}}
===Inactive=== ...
===Former=== ... {{Person|...|leavedate=2026-04-20|newteam=falcons}}
|content2=<CS:GO 时代的老名单，必须切掉>
```

四个必须处理的细节：

1. **只取 `content1`**（CS2），否则会把 CS:GO 时代的老阵容也算进来；
2. **`{{Person|...}}` 要按花括号配平取**，非贪婪正则会第一个 `}}` 就截断
   （值里常有 `{{abbr|...}}`）；
3. 解析 `key=value` 前先删 `<ref .../>`，否则 ref 里的 `name="+xxx"` 会覆盖真实姓名；
4. Active 栏里混着 `owner` / `ceo` / `team manager` / `analyst` / `assistant coach`，
   不分层就会把 CEO 当首发（BC.Game 实测 9 条里 4 条是工作人员）。

---

## 三、被拦死的

| 源 | 结果 |
|---|---|
| `hltv.org`（含完整浏览器头、Referer、Accept-Language） | **403**，Cloudflare "Just a moment..." |
| `api.bo3.gg` | 返回 Cloudflare 拦截页，非 JSON |
| Liquipedia 抓 `action=parse` 的 HTML 渲染版 | 不必要，wikitext 更省流量 |

所以"选手级实时数据"这条路在这个项目里就走 5Eplay 的赛后汇总，不追求 live rating。

---

## 四、其他实现要点

- **时区**：所有时间统一 `UTC+8`，`plan_ts` 是秒。
- **同批事件合并**：8 场 Major BO1 会在 12:00 同时开打，雷达必须把同一轮询周期的事件
  合成一条，否则就是刷屏。
- **缓存**：赛程 180 秒、已结束比赛 3600 秒、选手卡 7 天、花名册 12 小时。
  花名册短是因为转会期页面更新快。
- **500 兜底**：5E 偶尔返回空 `matches`，`_finished()` 会重试一次再放弃。

---

## 五、dsh 版实现备注

同样是这份数据契约，落到 TypeScript 后有几处值得记下来：

- **嵌套模板**：`{{Squad|...|{{Person|...}}}}` 里的人物被外层包住。按名字定位起点再配平花括号，
  不能"匹配完外层就跳到块尾"，否则一个人都读不到（AstrBot 版踩过，这里也踩了一次）。
- **战队页标题不是搜索第一条**：搜 `FaZe Clan` 第一条可能是个教练页，搜 `Liquid` 可能是个赛事子页。
  必须"真解析出在队选手才算命中"，最多试 4 个候选（每次 2.2 秒节流，试太多会很慢）。
- **两个已结束页会重叠**：`page=1` 与 `page=2` 有交叉，统计前必须按比赛 id 去重，
  否则瑞士轮战绩会算出 4-1 这种不存在的记录。
- **瑞士轮只算轮次赛**：`第一轮/第2轮/round N` 算，`半决赛/决赛/淘汰赛` 不算——混在一起口径就废了。
- **缓存分层**：`FiveEClient` 管列表与逐人数据的 TTL；比赛的最新状态另外放一层内存缓存（`remember`），
  注入时只读内存，`pre-step` 里绝不发网络请求——那会把每一步都拖慢。
