# 发布与分发指南

目标：让其他 DSH 用户能像截图里那样，在 **插件 → 添加插件** 输入一个名字就安装，或者在 **插件 → 发现** 里搜索到并安装。

先说明一个关键事实：

> **截图里的“添加插件”输入框不是搜索框**，它接收的是 pnpm 安装标识（包名 / GitHub 仓库地址 / 本地绝对路径）。
> 真正的“搜名字”发生在 **发现（Discover）** 标签页，而该页只读取用户手动添加的**插件索引（plugin market index）**。
> 截至 DSH `0.2.2-rc.1`，官方**没有内置公共索引**（`dsh-experimental-plugin-market-bundle` README 明确写着 “There is no official index”）。所以“可搜索”需要你发布一个索引 JSON，或把你的插件登记到某个第三方公共索引。

因此有两条互补的路：

| 方式 | 用户体验 | 你需要做什么 |
|---|---|---|
| **A. 发布到 npm** | 在“添加插件”里输入 `dsh-isolated-monitor` 精确安装 | `npm publish` |
| **B. 发布插件索引** | 在“发现”里搜索 `isolated` / `监控`，点安装 | 托管一个 `index.json`（format 1）并在 README 给出索引 URL |

推荐两者都做：npm 提供安装源，索引提供可发现性。

---

## 1. 发布前检查

```bash
cd dsh-isolated-monitor
node scripts/check-publish-ready.mjs
```

它会检查：

- `engines.dsh`、`dsh.bundle.patch`、`files` 白名单、`type: module`；
- 入口、`cordis.patch.yml`、README、LICENSE、icon、locale 是否存在；
- icon 是否 ≤256 KiB 且为 SVG/PNG/JPEG/WebP；
- 测试是否全部通过；
- `market/index.json` 是否与当前版本一致（缺失会警告）。

**先把占位仓库地址换掉**（否则 `--strict` 会拒绝）：

```bash
npm pkg set repository.url=git+https://github.com/<你>/dsh-isolated-monitor.git
npm pkg set homepage=https://github.com/<你>/dsh-isolated-monitor#readme
npm pkg set bugs.url=https://github.com/<你>/dsh-isolated-monitor/issues
```

包名 `dsh-isolated-monitor` 当前在 npm registry 上**未被占用**（2026-11-13 查询返回 404）。如果之后被占用，改发布 scoped 包：

```bash
npm pkg set name=@<你的scope>/dsh-isolated-monitor
npm publish --access public
```

插件管理器、索引格式、`/monitor` 都接受 scoped 包名；记得同步修改 `market/index.json`（脚本会自动读取包名）。

---

## 2. 路线 A：发布到 npm（精确名字安装）

```bash
npm login                       # 只需一次
npm test                        # 37 项
npm pack --dry-run              # 确认打包内容
npm publish --access public
```

验证：

```bash
npm view dsh-isolated-monitor version dist.tarball
```

之后用户在 **插件 → 添加插件** 输入：

```text
dsh-isolated-monitor
```

安装器会：

1. 通过 `pnpm view` 读取该版本；
2. 校验 `engines.dsh` / peerDependencies 与当前 DSH（`0.2.2-rc.1`）兼容；
3. `pnpm add dsh-isolated-monitor`；
4. 自动启用 bundle（`dsh-isolated-monitor` 出现在 `dsh.profile.bundles`）。

### 中国大陆网络

插件页的“安装源”可切到 **中国大陆镜像源**；用户也可以显式加镜像 registry。发布仍发布到 npmjs，镜像会延迟同步（通常几分钟到几十分钟）：

```bash
npm view dsh-isolated-monitor version --registry https://registry.npmmirror.com
```

如果希望索引里默认走镜像，可在生成索引时加：

```bash
node scripts/make-market-index.mjs --registry https://registry.npmmirror.com
```

代价是海外用户会先访问镜像；更稳妥的做法是索引不写 registry，让用户在安装对话框选择安装源。

### 发布新版本

```bash
npm version patch            # 或 minor/major；会更新 package.json 和 git tag
# 更新 CHANGELOG.md
npm run market:build         # 重新生成 market/index.json（版本/时间戳）
npm publish
```

---

## 3. 路线 B：发布插件索引（Discover 搜索）

### 3.1 生成索引

```bash
node scripts/make-market-index.mjs \
  --index-url https://raw.githubusercontent.com/<你>/dsh-isolated-monitor/main/market/index.json
```

产物：

```text
market/
├─ index.json     # format 1，JSON
└─ icon.svg       # index 中 "icon": "./icon.svg"，相对索引 URL 解析
```

脚本会用 DSH 官方 `parseMarketIndex` 做校验（可选）：

```bash
# 本机 DSH 安装里没有可直接 import 的路径时，可跳过；DSH 读取时仍会校验
$env:DSH_PLUGIN_MARKET_INDEX = "<path-to>/@deepseek-ai/dsh-plugin-market-index/lib/index.js"
node scripts/make-market-index.mjs --check
```

索引关键字段（format 1）：

```jsonc
{
  "format": 1,
  "title": { "en": "...", "zh": "..." },
  "metadata": {
    "categories": { "monitoring": { "title": { "en": "Monitoring", "zh": "监控" } } },
    "labels": { "host": { "title": { "en": "Host plugin", "zh": "宿主插件" } } },
    "sortKeys": {}
  },
  "plugins": [{
    "name": "dsh-isolated-monitor",
    "title": { "en": "...", "zh": "..." },
    "description": { "en": "...", "zh": "..." },
    "author": "...",
    "homepage": "https://...",
    "repository": { "url": "https://github.com/<你>/dsh-isolated-monitor" },
    "icon": "./icon.svg",
    "metadata": { "category": "monitoring", "keywords": ["monitor", "cron"], "labels": ["host"], "sortKeys": {} },
    "versions": [{
      "version": "0.1.0",
      "publishTimestamp": 1794568739,
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
    }]
  }]
}
```

> `publishTimestamp` 是 Unix 秒；`source.type` 只能是 `npm` 或 `git`；同一插件的版本不能重复；`engines.dsh` 必须是非 `workspace:` 的 SemVer 范围。

### 3.2 托管索引

要求：**HTTPS、直链、无重定向、URL 不带 query/fragment/凭据**。三种常用方式：

| 托管 | 索引 URL 示例 |
|---|---|
| GitHub raw | `https://raw.githubusercontent.com/<你>/dsh-isolated-monitor/main/market/index.json` |
| GitHub Pages | `https://<你>.github.io/dsh-isolated-monitor/market/index.json` |
| 对象存储 / 静态站点 | `https://cdn.example.com/dsh/market/index.json` |

GitHub raw 的优点是零配置、直链；缺点是 `main` 分支每次提交立即可见。索引缓存 `cacheTtlMs=10min`，更新后用户点刷新或等 10 分钟。

图标必须与索引同源或 HTTPS：`./icon.svg` 会解析成 `<索引目录>/icon.svg`。

### 3.3 用户在 DSH 中添加索引

1. **插件** 页 → **实验性插件** → 打开 **自定义插件索引**；
2. 出现 **发现** 标签 → **添加索引源**；
3. 粘贴上面的 `index.json` URL；
4. 搜索 `isolated`、`monitor`、`监控`、`定时` 任一关键词，即可看到条目并点击 **安装**。

安装走的是与“添加插件”相同的 `pluginManager.installBundle`，会做版本兼容检查与信任确认。

### 3.4 追加到已有公共索引

如果你不想自己维护索引，可以向已有的第三方 DSH 插件索引提交 PR，把上面的 plugin 条目加进它的 `plugins` 数组。索引之间互不影响，用户可以同时添加多个源。

---

## 4. 路线 C：不发布 npm，用 GitHub 仓库 / Release tarball

### 4.1 GitHub 仓库直装

把插件目录推到 GitHub（根目录就是 `package.json` 所在目录），用户输入：

```text
https://github.com/<你>/dsh-isolated-monitor
```

`plugin_manager` 会做 `git ls-remote` 预检，然后 `pnpm add github:<你>/dsh-isolated-monitor`。适合内网或尚未发 npm 的阶段。

注意：

- 仓库根目录必须包含 `package.json`、`src/`、`cordis.patch.yml`；
- 依赖的 `@deepseek-ai/*` 是 peer，由 DSH 运行时提供，不需要 `node_modules`；
- 公开仓库不需要凭据；私有仓库需要用户本机 Git 凭据。

### 4.2 Release tarball

```bash
npm pack
# dsh-isolated-monitor-0.1.0.tgz
```

把 tgz 上传到 GitHub Release，用户安装时输入 tgz 的**绝对本地路径**或 https tarball URL（以 `.tgz` 结尾）。tarball 安装不经过 npm registry，适合离线环境。

### 4.3 Git 源索引

如果只有 Git 仓库、没有 npm 包，可生成 Git 源索引：

```bash
node scripts/make-market-index.mjs \
  --source git \
  --git-url https://github.com/<你>/dsh-isolated-monitor \
  --commit <40 位 commit SHA> \
  --index-url https://raw.githubusercontent.com/<你>/dsh-isolated-monitor/main/market/index.json
```

安装器会按 commit 固定拉取，适合审计/可复现部署。注意 commit 必须是完整 40 位十六进制。

---

## 5. 自动发布（GitHub Actions / Trusted Publishing）

工作流 `.github/workflows/publish.yml` 使用 Node 24、npm 11.12.1 和 OIDC，不需要 `NPM_TOKEN`。先完成真实首发，然后在 npm 包 Settings → Trusted Publisher 配置 GitHub Actions：owner `CYRYGBG`、repository `dsh-isolated-monitor`、workflow `publish.yml`，允许 `npm publish`；Environment 留空。由账户本人保存并完成安全密钥确认。

本地首次发布执行 `npm publish --access public` 后，如提示浏览器认证，回车打开页面并由本人确认 Security Key。不要使用六位 `--otp` 代替安全密钥。

注意：CLI 返回 `+ package@version` 仍需验证 registry。若公开的是 `0.0.0-stage` / Temporary Holding Version，正式版本尚未可用；核对账户 Staged Packages，存在条目时审批，不存在时等待 npm 处理。不能把占位版本当作成功发布或拿它进行安装验收。

后续更新版本和 CHANGELOG，测试与严格检查通过后，经授权推送对应 `v*` tag。工作流校验 tag 与 package.version 一致，再发布并生成 provenance。已在本地提交发布的版本不要重复触发 CI 发布；待正式版本公开后，以真实 npm 时间戳重建索引并提交。

---

## 6. 发布检查清单

- [ ] `node scripts/check-publish-ready.mjs` 通过
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 已从 `your-org` 换成真实地址
- [ ] `version` 与 `CHANGELOG.md` 一致
- [ ] `engines.dsh` 覆盖目标 DSH 版本（当前 `>=0.2.2-rc.1 <0.3.0`）
- [ ] `npm pack --dry-run` 只包含 `src/docs/assets/locale/cordis.patch.yml/README/CHANGELOG/LICENSE`
- [ ] npm 包名可用（或改用 scope）
- [ ] `market/index.json` 已重新生成并提交（使用 npm 源时，先 publish 再生成/更新索引更稳）
- [ ] 索引 URL 可在浏览器直接打开，且无重定向
- [ ] 用另一个干净 profile 实测：`插件 → 添加插件` 输入包名 → 安装 → `/monitor` 可用
- [ ] 在 **发现** 添加索引 → 搜索到 → 安装成功

---

## 7. 常见问题

**Q：只发布 npm，用户能在“发现”里搜到吗？**
不能。Discover 只读索引源；npm 只解决“安装源”。要么让用户输入精确包名，要么发布/加入索引。

**Q：为什么“添加插件”里输入名字后没有候选？**
它是安装输入框，不是搜索框；输入完整包名后回车/安装即可。名字打错会走 `pnpm view` 失败并提示 `not-found`。

**Q：索引加进去但列表为空/报错？**
按顺序检查：URL 是否直链 HTTPS、是否 302 重定向（会被拒绝）、`format` 是否 `1`、`title.en` 是否存在、`versions[].source` 是否合法、图标是否可访问。

**Q：安装被拒绝 `incompatible-version`？**
索引/包里的 `engines.dsh` 与用户 DSH 不匹配。调宽范围或让用户升级 DSH；不要用 `workspace:` 范围。

**Q：包体太大？**
`files` 白名单只发 `src`（约 200KB 源码）、docs、assets、locale；不要提交 `node_modules`、测试临时目录或 `.tgz`。

**Q：需要改 DSH 官方配置才能被发现吗？**
不需要。索引完全由用户自行添加；官方无内置索引。唯一会改的是用户自己的 profile bundle 列表（安装时自动写入）。

**Q：撤销发布？**
npm unpublish 受当前官方政策、时间与依赖条件限制，不能保证 72 小时内无条件撤销；更推荐 `npm deprecate dsh-isolated-monitor@x.y.z "reason"` 并发布修复版本。索引里删除对应版本并重新生成。
