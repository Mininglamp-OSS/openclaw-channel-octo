# 发版流程

本仓库的 release 流程基于 [release-please](https://github.com/googleapis/release-please) + 自动化 CI。这份文档把"想发一版要做什么"按步骤写清楚，新人接手或久未发版回忆细节都看这一份。

## 日常开发约定（决定下次发什么版本号）

PR 的 commit message 用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀。merge 到 `main` 之后 release-please 会按前缀决定版本 bump：

| 前缀 | 含义 | 版本号变化 | 出现在 CHANGELOG |
|---|---|---|---|
| `fix:` | bug 修复 | patch (1.0.x) | ✅ |
| `feat:` | 新功能 | minor (1.x.0) | ✅ |
| `feat!:` / `fix!:` / commit body 含 `BREAKING CHANGE:` | 不兼容改动 | major (x.0.0) | ✅ |
| `chore:` / `docs:` / `ci:` / `refactor:` / `test:` | 内部改动 | 不 bump | ❌ |

**关键**：commit message 前缀直接决定下次发什么版本号，认真写。

### ⚠️ commit message 里的括号必须在同一行闭合

conventional-commits parser 解析整条 commit message（标题 **加 body**）。遇到 `(` 就等 `)`，
中间碰到换行会直接抛 `unexpected token '\n' ... valid tokens [)]`，**整条 message 解析失败**。

后果是静默的：release-please 把这条 commit 算作「无法解析」，于是

```
❯ commits: 0
✔ Considering: 0 commits
✔ No commits for path: ., skipping
```

workflow 仍然 **conclusion=success**，但 release PR 根本不会出现，看起来就像自动发版坏了。
1.4.1 就是这么撞上的：某条 commit body 里为了排版把 `(.ts/.mts/.cts/` 的括号折了行，
squash 之后毁掉整次扫描，只能改走本文末尾的手动 override 路径。

所以写 commit body 时，**宁可让那行超长，也不要把括号拆到两行**：

```
✅ 匹配全部可执行扩展名(.ts/.mts/.cts/.js/.mjs/.cjs)，这样新目录默认也在范围内
❌ 匹配全部可执行扩展名(.ts/.mts/.cts/
   .js/.mjs/.cjs)，这样新目录默认也在范围内
```

merge 之后可以顺手确认一眼，比事后补救便宜：

```bash
gh run view <release-please run id> --log | grep -E "could not be parsed|Considering:"
```

---

## 想发版时（4 步）

### Step 1：编辑 release-please 自动维护的 release PR

它一直挂着，每次 `main` 有新 commit 自动更新 `package.json` 版本号 + `CHANGELOG.md`。找到它（标题形如 `chore(release): release vX.Y.Z`），把它的 branch 拉下来改 `CHANGELOG.md`：

```bash
git fetch origin release-please--branches--main--components--octo
git checkout -b release-edit-X.Y.Z origin/release-please--branches--main--components--octo
```

**把 release-please 自动生成的一行式 commit dump 重写成我们的 prose 风格** —— 参考 `CHANGELOG.md` 里 1.0.14 / 1.0.13 那种写法：

- 主标题 **bold 一句话症状**，加 `(#issue, PR #pr)` 引用
- 缩进 bullet 分层写 **根因 / 修复方案 / 影响范围 / 兼容性**
- 分组用中文 `### Fixed` / `### Added` / `### Changed` / `### Internal`

写完推回 release-please 的 branch：

```bash
git add CHANGELOG.md
git commit -m "chore(release): rewrite X.Y.Z CHANGELOG in project house style"
git push origin release-edit-X.Y.Z:release-please--branches--main--components--octo
```

release-please 后续再跑会**保留**手工编辑（这是它的官方行为）。

### Step 2：reviewer approve 后点 Merge

merge 之后**全自动**：

- release-please 机器人打 tag `vX.Y.Z`
- tag push 触发 `.github/workflows/publish-clawhub.yml`
- 包推到 ClawHub
- release-please 创建 GitHub Release
- CI 自动同步 Release notes = CHANGELOG.md 那段（不再是 release-please 自动生成的一行式）
- CI 自动上传 tarball 到 Release 附件

### Step 3：验证

```bash
clawhub package inspect octo
```

看到 `Latest: X.Y.Z` 即可。

⚠️ **不要只看 GitHub Actions 状态** —— ClawHub 服务端目前偶尔有响应回写问题，CI 可能标记 failure 但**包其实已经成功入库**。`clawhub package inspect` 是 ground truth。

另外也建议看一下：

- https://github.com/Mininglamp-OSS/openclaw-channel-octo/releases —— Release notes 是 prose 风格，附件 `octo-X.Y.Z.tgz` 已挂
- https://github.com/Mininglamp-OSS/openclaw-channel-octo/blob/main/CHANGELOG.md —— 第一段是 X.Y.Z

### Step 4：发面向用户的 changelog 到 OctoPush（手工）

线上 changelog 页面：https://im.deepminer.com.cn/changelog/

这一步**不会自动触发**，因为面向用户的语言跟开发 CHANGELOG 风格完全不一样（参考 web/android/ios 模块的现有条目），需要人工翻译。

调 `octo-changelog` skill：

```
/octo-changelog 发我们的 changelog
```

skill 会引导你：

1. 拿仓库 CHANGELOG.md 里 X.Y.Z 那一段作为原料
2. 翻译成用户语言：去 PR # / 文件路径 / 函数名 / 根因分析；保留"用户能感受到的"
3. 按 `【修复】/【新增】/【优化】` 分组
4. **先发测试环境**（`im-test.deepminer.com.cn`）看页面渲染 OK
5. **再发线上**（`im.deepminer.com.cn`）

⚠️ **entry 一旦 POST 不可撤回**（API 不支持 PUT/PATCH/DELETE，重发同 version 会创建副本不会覆盖）。发线上前必须 100% 确认文案，发错只能找运维直接改 DB。

---

## 异常处理

### ClawHub publish CI 失败但包其实已入库

已知问题，CI 那条路会卡 12 分钟 timeout。判断方式：

```bash
clawhub package inspect octo
```

如果 `Latest: X.Y.Z`，发版**已经成功**，CI 红只是个误导信号。Release notes 同步 + tarball 上传那两步因为 workflow 用 `if: always()` 也会跑，应该都齐了；如果没齐手动补：

```bash
gh release upload vX.Y.Z octo-X.Y.Z.tgz --repo Mininglamp-OSS/openclaw-channel-octo
gh release edit vX.Y.Z --notes-file <(./scripts/extract-changelog.sh X.Y.Z)
```

### ClawHub publish 真的没成功（`clawhub package inspect` 看不到新版本）

本地手工兜底：

```bash
git checkout vX.Y.Z
npm run build && npm pack
clawhub auth login   # 如未登录
clawhub package publish --family code-plugin --version X.Y.Z \
  --source-repo Mininglamp-OSS/openclaw-channel-octo \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref vX.Y.Z \
  --changelog "$(./scripts/extract-changelog.sh X.Y.Z)" \
  octo-X.Y.Z.tgz
```

### im.deepminer.com.cn changelog 发错了

entry **不能 PUT / DELETE / PATCH**。重发同 version 会创建副本（不会覆盖）。**唯一干净的修法**：找运维直接改 DB 删条目。

### release-please PR 一直不出现

检查 `main` 上最新几个 commit 的 message 有没有 conventional commits 前缀。纯 `chore:` / `docs:` / `ci:` 不会触发新版本——必须至少有一个 `fix:` 或 `feat:`。

---

## 一页 cheatsheet

```
发版 4 步：
  1. 改 release-please PR 的 CHANGELOG.md（写人话，prose 风格）
  2. merge 它（自动打 tag + 推 ClawHub + 同步 Release notes + 上传 tarball）
  3. clawhub package inspect octo 验证（不要只信 CI 状态）
  4. /octo-changelog 发用户语言公告到 im.deepminer.com.cn/changelog/
     （先测试环境后线上；entry 不可撤回，确认文案）

绝对不要：
  ❌ 手工改 package.json 版本号
  ❌ 手工改 src/version.ts（prebuild 自动生成）
  ❌ 手工 git tag
  ❌ 发 im.deepminer changelog 不先发测试
  ❌ 假设 CI 失败 = 发版失败（看 clawhub package inspect）
```

---

## 相关链接

- ClawHub 包页：通过 `clawhub package inspect octo` 查
- GitHub Releases：https://github.com/Mininglamp-OSS/openclaw-channel-octo/releases
- 用户面 changelog（线上）：https://im.deepminer.com.cn/changelog/
- 用户面 changelog（测试）：https://im-test.deepminer.com.cn/changelog/
- release-please workflow：`.github/workflows/release-please.yml`
- ClawHub publish workflow：`.github/workflows/publish-clawhub.yml`
- octo-changelog skill：`~/.claude/skills/octo-changelog/SKILL.md`
