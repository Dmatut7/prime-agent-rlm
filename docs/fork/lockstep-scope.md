# Lockstep 版本边界（谁在步进、谁不在）

> 本文回答一个问题：**版本 lockstep 覆盖哪些清单，不覆盖哪些**。
> 基线取证于 `8ed6d73bc`（2026-09-18）；结论性条目不随例行 bump 失效——本文只钉**成员关系与规则**，不钉任何具体版本号。
> 相关文件：根 `package.json`、`packages/*/package.json`、`package-lock.json`、`prime-agent-runtime/pyproject.toml`、`scripts/sync-versions.js`（L2 席主笔，演进中）。

## 一、在 lockstep 内（npm 侧 9 个 manifest，一律同版本）

| 清单 | 身份 | 发布面 |
| --- | --- | --- |
| 根 `package.json` | `prime-agent`（工作区根） | 不发布，但版本是 lockstep 的锚 |
| `packages/agent` | `@earendil-works/pi-agent-core` | npm 发布包 |
| `packages/ai` | `@earendil-works/pi-ai` | npm 发布包 |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | npm 发布包 |
| `packages/tui` | `@earendil-works/pi-tui` | npm 发布包 |
| `packages/coding-agent/examples/extensions/with-deps` | `pi-extension-with-deps` | `private: true`，不发布，但同版本步进 |
| `packages/coding-agent/examples/extensions/custom-provider-anthropic` | `pi-extension-custom-provider-anthropic` | 同上 |
| `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo` | `pi-extension-custom-provider-gitlab-duo` | 同上 |
| `packages/coding-agent/examples/extensions/sandbox` | `pi-extension-sandbox` | 同上 |

- 4 个 example workspace 是**私有演示扩展**：不进 npm，但被根 `workspaces` 收编、与发布包同 bump（0.10.0 lockstep 把它们一并带入是上游有意的动作）。私有不等于退出 lockstep。
- 包间互依（`@earendil-works/*`）一律 `^<lockstep 版本>`，由 `scripts/sync-versions.js` 对齐。
- **package-lock 一致性也是 lockstep 的一部分**：`package-lock.json` 的 workspace 条目（根 + `packages/*` 各 manifest 对应条目）必须与 manifest 的 `version` 逐条相等。lock 里 `node_modules/@earendil-works/*` 这类条目是 workspace 的**符号链接条目**（无独立 version，继承目标），不算不一致。

## 二、不在 lockstep：`prime-agent-runtime/`

`prime-agent-runtime/pyproject.toml`（当前 `0.1.0`）**独立演进，不参与 npm lockstep**。理由（都有机械证据）：

1. **异生态**：它是 Python 项目（`pyproject.toml` + uv venv），不是 node workspace——根 `package.json` 的 `workspaces` 不含它，`package-lock.json` 里也**零条目**（实测 `Object.keys(lock.packages)` 中含 `prime-agent-runtime` 的键为 0）。npm 侧版本机械根本够不到它。
2. **消费方不看版本**：TS 侧唯一消费入口 `packages/coding-agent/src/core/kernel/bootstrap.ts` 对它的身份判定是**源码目录 + 内容 sha256**（`sha256:` 前缀指纹，`bootstrap.ts:266/334-346`），不是 semver；PyPI 上 `prime-agent-runtime` 名字未注册（404），registry 安装路径默认拒绝、仅显式 pin 才允许。锁进 npm lockstep 约束不了任何真实消费检查。
3. **fork 自有资产、独立节奏**：它是本 fork 的内核核心（`docs/fork/merge-upstream-20260917.md` 的 no-take 白名单成员），改动节奏与 npm 发版完全解耦，版本号自管。

**边界后果**：改 `prime-agent-runtime/**` 不需要动 `packages/*/package.json` 的版本；反过来 npm 侧 bump 也不该去碰 `pyproject.toml` 的 `version`。两边各自有破坏性变更时按各自的兼容面记录（JS 侧协议面记根 `CHANGELOG.md`；runtime 侧记自己的变更说明）。

## 三、机制与守门（谁在执行 lockstep）

- **bump 入口**（根 `package.json` scripts）：`version:patch/minor/major/set` = `npm version -ws` 全工作区同 bump → `node scripts/sync-versions.js` 对齐包间 `^` 依赖 → 删 `node_modules`/`package-lock.json` → `npm install` 重建 lock。**任何人手工单改某个包的版本号都是违规**；发现漂移先跑 `node scripts/sync-versions.js`（它会拒绝多版本并存）。
- `scripts/sync-versions.js`、`scripts/preflight-push.sh` 等守门脚本归 L2 席主笔演进（含递归 workspace 发现、package-lock 一致性与 `--self-test`，以其当前实现为准）；本文只钉**范围契约**，不钉脚本实现细节。
- 例行 bump 后应跑的速核（见下节针命令）：成员关系不变、lock 与 manifest 逐条相等、四个发布包 `files[]` 仍不含 `CHANGELOG.md`。

## 四、机器可核针（不硬编码版本值，bump 不炸）

在仓库根执行（任何一条输出 `RED` 即回退查因）：

```bash
# 针 1：lockstep 成员关系 = 根 workspaces 全集（glob 展开）；且 lock 与 manifest 逐条一致
node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
// Expand workspace globs: "packages/*" -> every subdir of packages/ holding a package.json.
const manifests = ["package.json"];
for (const w of root.workspaces) {
  if (!w.includes("*")) { manifests.push(w + "/package.json"); continue; }
  const dir = w.slice(0, w.lastIndexOf("/"));
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && fs.existsSync(dir + "/" + d.name + "/package.json")) manifests.push(dir + "/" + d.name + "/package.json");
  }
}
let bad = 0, checked = 0;
for (const m of manifests) {
  const man = JSON.parse(fs.readFileSync(m, "utf8"));
  const key = m === "package.json" ? "" : m.slice(0, -"/package.json".length);
  const lockEntry = lock.packages[key];
  checked++;
  if (!lockEntry) { console.log("RED: lock missing workspace entry", key || "(root)"); bad++; continue; }
  if (man.version !== lockEntry.version) { console.log("RED:", key || "(root)", "manifest", man.version, "≠ lock", lockEntry.version); bad++; }
}
if (manifests.length !== 9) { console.log("RED: workspace set changed (" + manifests.length + " manifests):", manifests); bad++; }
console.log(bad ? "NEEDLE-LOCKSTEP: RED" : "NEEDLE-LOCKSTEP: GREEN (" + checked + " manifest↔lock entries checked)");
process.exit(bad ? 1 : 0);
'

# 针 2：四个发布包 files[] 不携带 CHANGELOG.md（本 fork 不随包分发包内 CHANGELOG）
node -e '
const fs = require("fs");
let bad = 0;
for (const p of ["agent", "ai", "coding-agent", "tui"]) {
  const files = JSON.parse(fs.readFileSync("packages/" + p + "/package.json", "utf8")).files || [];
  if (files.includes("CHANGELOG.md")) { console.log("RED: packages/" + p + " files[] still lists CHANGELOG.md"); bad++; }
}
console.log(bad ? "NEEDLE-FILES: RED" : "NEEDLE-FILES: GREEN");
process.exit(bad ? 1 : 0);
'

# 针 3：prime-agent-runtime 保持在 lockstep 之外（不在 node workspaces、不在 package-lock）
node -e '
const fs = require("fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
let bad = 0;
if (root.workspaces.some((w) => w.includes("prime-agent-runtime"))) { console.log("RED: prime-agent-runtime became a node workspace"); bad++; }
if (Object.keys(lock.packages).some((k) => k.includes("prime-agent-runtime"))) { console.log("RED: prime-agent-runtime entered package-lock.json"); bad++; }
console.log(bad ? "NEEDLE-RUNTIME-EXCL: RED" : "NEEDLE-RUNTIME-EXCL: GREEN");
process.exit(bad ? 1 : 0);
'
```

三针的含义：**针 1** 红 ⇒ lockstep 成员漂移或 lock/manifest 失同步；**针 2** 红 ⇒ 有人把 CHANGELOG.md 塞回了 `files[]`；**针 3** 红 ⇒ Python runtime 被并入了 npm 侧（那要按「新增 node workspace」的完整仪式评估，不是顺手加）。

## 五、包内 CHANGELOG 与 `.changes/` fragment（fork 政策）

- **本 fork 不维护 `packages/*/CHANGELOG.md`**：包内 CHANGELOG 停在上游时代的版本（fork 接手后由根 `CHANGELOG.md` 承担版本台账，发版即更新根文件），且 npm tarball **不再随包分发** CHANGELOG（见针 2；`packages/coding-agent/package.json` 的 `files[]` 已摘除，agent/ai/tui 从未携带——npm 不自动收录 CHANGELOG.md）。
- **`.changes/` fragment 在本 fork 不被消费**：唯一消费者 `scripts/release.mjs`（聚合进包内 CHANGELOG 并发布 npm）本线不运行；强制新增 fragment 的 `changelog-fragment.yml` 在本 fork 结构性不可达（远端唯一分支 `merge/repl-kernel`，该 workflow 只挂 `pull_request` 到 `main`，而远端无 `main` 分支、全部 20 个 PR 的 base 都是 `merge/repl-kernel`、该 workflow 历史运行数为 0）。存量 fragment 的处置结论与理由见当期 REPORT（packaging-lockstep 席），本节只钉政策面：**发版叙述一律写根 `CHANGELOG.md`，不再往 `packages/*/.changes/` 新增 fragment**。
