# #125 群成员数虚高(跨群污染)修复设计

- 日期: 2026-06-23
- Issue: Mininglamp-OSS/openclaw-channel-octo#125
- 分支: `fix/group-member-count-cross-group`

## 背景与现象

群里 @bot 问"群成员数多少",bot 回答的人数远大于实际,并会列出**不在本群**的成员。

真机证据(bot `mintest`,本群真实 3 人:齐乐 / caster-Q / mintest):

- 一次答 "4 个人:齐乐、caster-Q,以及两个机器人 costest 和 mintest"
- bot 自陈纠正:"costest 其实不在群里"

`costest` 是 `mintest` 在**另一个群**("costest、mintest、cast")的成员,被泄漏进了本群上下文。

线上反馈(原 issue):7 人群答 87 人、不到 20 人群答 500 多人。

## 根因

`buildMemberListPrefix(uidToNameMap)`(`src/inbound.ts`)把一个 **per-account 累积** 的 `uidToNameMap` 当成了"本群名单":

1. `getOrCreateUidToNameMap(accountId)`(`src/channel.ts`)按 accountId 缓存,**同一 bot 的所有群共用同一个 Map**。
2. startup prefetch(`src/channel.ts` 群预取循环)遍历 bot 加入的**所有群**,把每个群的成员都 `set` 进这同一个 Map。
3. inbound 的 `refreshGroupMemberCache`(`src/inbound.ts`)刷新成员时**只 `set` 不 `clear`**,退群成员永久残留。
4. `buildMemberListPrefix` 用 `uidToNameMap.size` 当人数、用 `uidToNameMap.entries()` 当名单喂给 LLM(`[Group Members]` / `[Group Info] This group has N members`)。

四者叠加 → 注入给 LLM 的"本群成员"实为 bot 待过的所有群成员**并集**,人数虚高且泄漏外群成员。LLM 偶尔能把不认识的名字滤掉(表现为"有时答对"),但数据源本身是脏的。

## 关键约束

`uidToNameMap`(及对应 `memberMap`)的**累积语义必须保留**。除 `buildMemberListPrefix` 外,它还服务于:

- senderName 解析(`resolveSenderName`)
- @mention 解析(`findUidByName` / `buildEntitiesFromFallback`)
- bot 名查找(防 bot-to-bot loop 的 fallback mention)
- persona-clone grantor 名解析

这些用途**需要跨群累积**才能解析名字。因此**不得 clear 该 Map、不得改其填充逻辑**。本 bug 的唯一缺陷是 `buildMemberListPrefix` 误用它当本群名单。

## 方案

**复用 inbound 这条消息已经拉到的当前群名单**,不引入第二套数据源。

`handleGroupMessage`(`src/inbound.ts`)在每条群消息里已经调用 `refreshGroupMemberCache({ sessionId: memberCacheGroupNo, ... })`(~1700),其中 `memberCacheGroupNo = extractParentGroupNo(message.channel_id)`(~1696,已正确处理线程复合 channelId)。该函数内部已用 `getGroupMembers({ groupNo: sessionId })` 拉到**当前群**的 `GroupMember[]`(~1281),但只把成员 `set` 进累积 map,没有把名单交出来。

> 为什么不用 `getGroupMembersFromCache`:`member-cache.ts` 的 `_memberCache` **不被 inbound 刷新写入**(inbound 走 api-fetch 的 `getGroupMembers` 直连,只有 startup preload 和该模块内部的 `refreshGroupMembers` 才写 `_memberCache`)。走它会引入第二套数据源 + 退群最长 5min 才剔除 + 同一消息重复打一次 API。复用 inbound 实拉名单可一次性规避这三点。

### 改动 1:把当前群名单写入一个 per-account 的 `currentGroupMembersMap`

**不改 `refreshGroupMemberCache` 的 `boolean` 返回类型**(避免漏改 ~2535 mention force-refresh 调用点 `if (refreshed)`)。改为让它在写累积 map 的同时,把"本次当前群名单"写进一个**新的 per-account map**:

- `channel.ts` 照 `memberRobotMap` 的模式新增 `_currentGroupMembersMaps`(`Map<accountId, Map<groupNo, GroupMember[]>>`)+ `getOrCreateCurrentGroupMembersMap(accountId)`(内部 `normalizeAccountId`),在 `handleInboundMessage` 调用点(~1371)随其它 per-account map 一起传入。**key 跟随 per-account 传入 map,与 `groupCacheTimestamps` 同源同账号隔离**(不新开模块级仅 groupNo 的缓存)。
- **`currentGroupMembersMap` 在 `handleInboundMessage` / `refreshGroupMemberCache` 中均为可选参数**,函数内 `?? new Map()` fallback。这样 `src/inbound-mention-gate.test.ts`(14 处)、`src/inbound-dispatch-timeout.test.ts`(1 处)等现有 `handleInboundMessage` 直接调用点**无需改动**(不传即用临时 Map,行为等价于本轮无成员上下文)。
- `refreshGroupMemberCache` 内,以 `sessionId`(=parent groupNo)为 key:
  - **成功分支(~1311)**:`currentGroupMembersMap.set(sessionId, members)`(本次拉到的当前群名单)。
  - **空返回 / catch 失败分支(~1315 / ~1320)**:`currentGroupMembersMap.delete(sessionId)`(**负缓存**:失败即清当前群名单,下条消息 early-return 也拿不到旧名单,兑现"失败就不注入")。
  - **命中缓存 early-return 分支(~1274,未过期)**:不动 map,沿用上次成功写入的当前群名单(语义与 `groupCacheTimestamps` 的 TTL 一致)。
- 累积 map / `memberRobotMap` 的 `set` 逻辑、`refreshGroupMemberCache` 的返回值与所有调用点(~1700 / ~2535)**全部保持不变**。
- **`cleanupStaleCaches`(`channel.ts:349`)同步清理**:在现有 `_memberMaps`/`_groupCacheTimestamps` 的 stale 群条目删除处(~356/359)旁补一行 `_currentGroupMembersMaps.get(accountId)?.delete(groupId)`(与邻居两行**同 key 同删除时机**)。
  - **为何按 raw `groupId` 删(而非 `extractParentGroupNo(groupId)`)**:cleanup 遍历的 `groupId` 来自 `touchCache(account.accountId, msg.channel_id)`(`channel.ts:1357`,raw key)。让 roster 缓存与 `_groupCacheTimestamps` **同 key 同生命周期**,可保证一条强不变量:`roster` 存在 ⟺ `timestamp` 存在(两者同写、同删、同 key)。若改按 parent 删 roster 而 timestamp 仍按 raw 删,会脱节:同群线程 A stale 删了 parent roster、但线程 B 仍活跃使 timestamp[parent] fresh → 下条 B 消息 `refreshGroupMemberCache` early-return 不重拉 → roster 空 → 丢成员上下文。按 raw 删彻底规避此回归。
  - **代价(有界、可接受)**:纯线程活跃的群,roster 按 parent key 存、cleanup 按 raw key 删 → 清不到,常驻一条。但这与 `_memberMaps`/`_groupCacheTimestamps` 的**既有行为完全一致**(它们也 parent-key 写 / raw-key 删),且**有界**:每群至多一条 `GroupMember[]`,每条消息刷新即覆盖,不随时间增长。本 issue 不顺手修既有 raw/parent 错配(避免扩大改动面、动既有 `_groupCacheTimestamps` 清理逻辑),仅保证新 map 与既有缓存行为一致、不引入新的不变量破坏。

### 改动 2:`buildMemberListPrefix` 改签名

```
- export function buildMemberListPrefix(uidToNameMap: Map<string, string>): string
+ export function buildMemberListPrefix(members: GroupMember[]): string
```

内部逻辑不变(`length <= 10` 列名 + mention hint;`> 10` 报数 + 查询指引),数据源改为传入的 `members`:

- `members.length === 0` → 返回 `""`(与旧 `size === 0` 等价)
- `length <= 10` → 用 `members.map(m => `  ${m.name} (${m.uid})`)` 列名,mention 示例锚点取 `members[0]`
- `> 10` → `This group has ${members.length} members`

### 改动 3:调用点(`src/inbound.ts` ~2128)

~1700 那次 `refreshGroupMemberCache` 已把当前群名单写进 `currentGroupMembersMap`。调用点直接读它,不再传累积 map:

```
- const memberListPrefix = isGroup ? buildMemberListPrefix(uidToNameMap) : "";
+ const currentGroupMembers = isGroup
+   ? (currentGroupMembersMap.get(memberCacheGroupNo) ?? [])
+   : [];
+ const memberListPrefix = isGroup ? buildMemberListPrefix(currentGroupMembers) : "";
```

`memberCacheGroupNo`(parent groupNo)在 ~1696 已算好;命中则为当前群名单,失败/空已被负缓存 `delete` → `?? []` → prefix 空。

### 数据流(改后)

```
message.channel_id ──extractParentGroupNo──> memberCacheGroupNo (线程安全)
        │
        ▼
refreshGroupMemberCache(memberCacheGroupNo)   [每条消息已调,零额外 API]
   ├─ set 进累积 map(senderName/mention 用,不变)
   ├─ 成功: currentGroupMembersMap.set(groupNo, 当前群名单)
   └─ 失败/空: currentGroupMembersMap.delete(groupNo)  (负缓存)
        │
        ▼
currentGroupMembersMap.get(memberCacheGroupNo) ──> buildMemberListPrefix ──> [Group Members] 仅含本群
```

per-account `uidToNameMap` 继续服务 senderName / mention 解析,**保持不变**。

## 边界处理

1. **线程消息**:成员名单一律用 `memberCacheGroupNo = extractParentGroupNo(message.channel_id)`,不直接用 raw `channel_id`(复合格式会查错群)。
2. **fetch 失败 / 空返回**:`refreshGroupMemberCache` 的空/catch 分支 `currentGroupMembersMap.delete(groupNo)`(负缓存)。即使 30s backoff 期内下条消息 early-return,`get` 也拿不到旧名单 → prefix 空。**绝不回退 per-account 累积 Map**。"不注入" 优于 "注入错的"。
3. **缓存命中(未过期)**:沿用上次成功写入的当前群名单;成员变动在下次过期/强刷后反映(与现有 `refreshGroupMemberCache` 的 TTL/backoff 语义一致,不新增延迟)。
4. **零额外 API / 不重复拉取**:复用 ~1700 已有的那次刷新,不新增 API 调用。
5. **多账号隔离**:`currentGroupMembersMap` 按 accountId 建(`getOrCreateCurrentGroupMembersMap` 内 `normalizeAccountId`),与 `groupCacheTimestamps` / `memberRobotMap` 同源,不会跨账号串名单。
6. **mention / bot 区分 / 返回值不受影响**:`memberRobotMap`、mention 解析、`refreshGroupMemberCache` 的 boolean 返回值与 ~1700 / ~2535 两调用点全部不变。

## 测试(TDD)

新增 / 改写测试(`src/inbound.test.ts`):

| 测试 | 验证 |
|---|---|
| 跨群隔离 | `buildMemberListPrefix(群B名单)` 只报 4 人、不含群 A 成员(脏累积 map 同时存在也不影响) |
| ≤10 列名 | 列出的成员与传入名单逐条一致 |
| >10 报数 | `This group has N members` 的 N == members.length |
| 空名单 | `buildMemberListPrefix([])` 返回 `""` |
| 线程 channelId | 当前群名单按 `extractParentGroupNo(groupNo____shortId)` 解析,不查错群 |
| 当前群名单来源 | 刷新成功后 `currentGroupMembersMap.get(groupNo)` == 当前群名单(非累积 map) |
| 失败负缓存 | 先成功缓存名单 → 再失败/空返回 → `get` 为空 → 连续第二条消息(backoff 内)仍不注入旧名单 |
| 多账号隔离 | 账号 A、账号 B 同 groupNo,各自 `currentGroupMembersMap` 互不串名单 |
| mention 不回归 | ~2535 force-refresh 调用点行为不变(刷新失败时 `if (refreshed)` 仍为 false,不跑脏 mention 解析) |
| 缓存清理 | (`channel.test.ts`)`cleanupStaleCaches` 清 stale 条目时,`_currentGroupMembersMaps` 按 raw `groupId` 同步删除(与 `_groupCacheTimestamps` 同 key 同生命周期) |
| roster⟺timestamp 不变量 | 同群多线程(一条 stale 一条 active)下,roster 与 timestamp 不脱节:不会出现 timestamp fresh 但 roster 已被清致丢成员上下文 |
| 可选参数兼容 | 不传 `currentGroupMembersMap` 时 `handleInboundMessage` 用临时 Map,现有 mention-gate / dispatch-timeout 测试零改动通过 |

现有 6 个 `buildMemberListPrefix` 单测(`src/inbound.test.ts:1532+`)随签名改为传数组。

## 影响面

- 改动文件:
  - `src/inbound.ts`:`refreshGroupMemberCache` 增**可选** `currentGroupMembersMap` 参数 + 三分支写/删名单(返回值不变);`buildMemberListPrefix` 改签名;调用点 ~2128 读 map。
  - `src/channel.ts`:新增 `_currentGroupMembersMaps` + `getOrCreateCurrentGroupMembersMap`(照 `memberRobotMap` 模式),`handleInboundMessage` 调用点(~1371)传入,`cleanupStaleCaches`(~349)同步清理。**新增 `import type { GroupMember } from "./api-fetch.js"`**(`_currentGroupMembersMaps` 的 value 类型 `GroupMember[]` 需要)。
  - `src/inbound.test.ts`:`buildMemberListPrefix` 签名改 + 成员上下文相关用例。
  - `src/channel.test.ts`:`cleanupStaleCaches` 对 `_currentGroupMembersMaps` 的清理用例(该 map 与 cleanup 同在 `channel.ts` 私有作用域,清理测试放此文件,通过公开行为 / 既有 test helper 触发 cleanup)。
- **不需改动**的现有调用点(靠可选参数 + fallback):`src/inbound-mention-gate.test.ts`(14 处)、`src/inbound-dispatch-timeout.test.ts`(1 处)直接调用 `handleInboundMessage` 处。
- 新增 import:`src/inbound.ts` 与 `src/channel.ts` 各加 `import type { GroupMember } from "./api-fetch.js"`。`GroupMember` 已是 inbound 内 `getGroupMembers` 返回元素类型,无新依赖。
- 不改:`src/member-cache.ts`、mention / senderName / persona 路径、累积 map 的 set 逻辑、`refreshGroupMemberCache` 返回值与既有调用点语义。
- 无新增依赖,无 child_process。

## 非目标

- 不重构 `uidToNameMap` 的 per-account 累积模型。
- 不处理 #124(多条回复丢失)——独立 issue。
- 不动 octo-server 侧。
