# 云游 · 3D 全景城市漫游：开工须知

纯前端的 3D 城市旅游网站（Vite + MapLibre GL JS 6 + three.js），功能和结构见 `README.md`。

## 开工流程

1. **先读 `.claude/TASKS.md`**，从优先级最高的待办开始做。每完成一项，就更新该文件（移到「已完成」，写明怎么验证的）。
2. 运行 `npm ci`，再 `npm run dev`（端口 5173；Claude 预览用 `.claude/launch.json` 里的 `dev` 配置）。
3. 在内置浏览器里验证：先 `resize_window` 到 1280×720，否则截图比例会错乱。浏览器控制台里可以直接用 `map` `state` `setMode` `enterCity` `playTour` `CITIES`。
4. 提交前 `npm run build` 必须通过。提交信息末尾加一行 `Co-Authored-By`。

## 约定与坑

- **坐标一律用 OpenStreetMap 的 WGS84**。中国地图 App 用的是 GCJ-02，会偏 300–700 m，不能用。另外，OSM 关系的中心点可能落在水里（外滩曾经出过这个问题）。
- MapLibre v6 只有具名导出，要写 `import * as maplibregl`。worker 必须用 `?worker&url` 加 `setWorkerUrl` 加载，否则打包后找不到。
- 宣传片镜头的相机高度不能低于目标点（`maxPitch` 是 85）。
- `mapstyle.js` 里的图层 id 和导出名都被 `main.js` 依赖，不要改名。地标替换 OSM 建筑靠 `hideLandmarkBuildings`（`distance` 过滤）。
- 并行 agent：用 worktree 隔离（放在 `.claude/worktrees/`，已加入 .gitignore），按 TASKS.md 的文件归属分工。内置浏览器只给一个 agent 用；其他 agent 用无头 Edge 截图（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，puppeteer-core 装在仓库外）。

## 用户偏好

- 用中文交流。
- **用量到上限，或到晚上 8 点，就停止工作**。停之前先保存进度：提交代码，并更新 TASKS.md。
