# 云游 · 3D 全景城市漫游：开工须知

纯前端的 3D 城市旅游网站（Vite + MapLibre GL JS 6 + three.js），功能和结构见 `README.md`。

## 开工流程

1. **先读 `.claude/TASKS.md`**，从优先级最高的待办开始做。每完成一项，就更新该文件（移到「已完成」，写明怎么验证的）。
2. 运行 `npm ci`，再 `npm run dev`（端口 5173；Claude 预览用 `.claude/launch.json` 里的 `dev` 配置）。
3. 在内置浏览器里验证：先 `resize_window` 到 1280×720，否则截图比例会错乱。浏览器控制台里可以直接用 `map` `state` `setMode` `enterCity` `playTour` `CITIES` `showShot`。
   - 检查宣传片取景不要实时播放：`showShot(i, t)` 把镜头定格在第 `i` 个镜头的进度 `t`，再截图。
   - **内置浏览器面板没显示在屏幕上时**，`requestAnimationFrame` 会被限到约 1 帧/秒，地图加载、飞行和宣传片都会卡住，截图也可能停在旧画面。用 `map.redraw()` 循环推进渲染；截图不动了就改用无头 Edge。
4. 提交前 `npm run build` 必须通过。**提交信息里不要加 `Co-Authored-By`**，不要把 Claude 列为共同作者。

## 约定与坑

- **坐标一律用 OpenStreetMap 的 WGS84**。中国地图 App 用的是 GCJ-02，会偏 300–700 m，不能用。另外，OSM 关系的中心点可能落在水里（外滩曾经出过这个问题）。
- MapLibre v6 只有具名导出，要写 `import * as maplibregl`。worker 必须用 `?worker&url` 加 `setWorkerUrl` 加载，否则打包后找不到。
- 宣传片镜头的相机高度不能低于目标点（`maxPitch` 是 85）。
- `mapstyle.js` 里的图层 id 和导出名都被 `main.js` 依赖，不要改名。地标替换 OSM 建筑靠 `hideLandmarkBuildings`（`distance` 过滤）。
- MapLibre v6 在超过瓦片 `maxzoom` 后会重新切分矢量瓦片，**只保留被样式图层用到的 source-layer**。`querySourceFeatures` 要用的图层必须有一个样式层引用它（`poi` 层就是为此加的不可见图层）。
- `fill-extrusion` 的光照颜色会乘到建筑颜色上。黄昏光太橙会让整座城变成砖红色，调黄昏要同时看光色和立面底色。
- OSM 里有些超高层只画了裙楼的 3D 部件（香港环球贸易广场），地图上看不到塔楼，只能在 `landmarks.js` 里补模型。
- 无头 Edge：直接 `puppeteer.launch` 会失败（Edge 把启动转交给后台进程后自己退出）。先用 `msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>` 启动，再 `puppeteer.connect({ browserURL })`。同源只改 `#城市` 不会重新加载页面，换城前先跳到 `about:blank`。puppeteer-core 临时装在仓库外的目录里，用完不留。
- 并行 agent：用 worktree 隔离（放在 `.claude/worktrees/`，已加入 .gitignore），按 TASKS.md 的文件归属分工。内置浏览器只给一个 agent 用；其他 agent 用无头 Edge 截图（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，puppeteer-core 装在仓库外）。

## 用户偏好

- 用中文交流。
