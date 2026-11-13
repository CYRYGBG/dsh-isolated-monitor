# 插件索引（Discover）

这个目录是 **DSH 插件市场索引 format 1** 的产物，用于让用户在 **插件 → 发现** 中搜索并安装本插件。

```text
market/
├─ index.json   # 索引文档
└─ icon.svg     # 索引条目图标（相对索引 URL 解析）
```

## 生成

```bash
npm run market:build
# 或指定最终索引 URL / 镜像 / Git 源
node scripts/make-market-index.mjs --index-url https://raw.githubusercontent.com/<you>/dsh-isolated-monitor/main/market/index.json
```

## 托管

把 `market/` 发布到任意 HTTPS 静态位置（GitHub raw / GitHub Pages / 对象存储）。索引 URL 必须是**直链、无重定向、无 query/fragment/凭据**。

## 用户添加

1. 插件 → 实验性插件 → 打开 **自定义插件索引**
2. 发现 → 添加索引源 → 粘贴 `index.json` 的 URL
3. 搜索 `isolated` / `monitor` / `监控` → 安装

索引缓存 10 分钟；更新版本后重新生成并推送即可。

完整发布流程见 [../docs/PUBLISH.md](../docs/PUBLISH.md)。
