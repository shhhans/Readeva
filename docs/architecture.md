# 架构

## 进程模型

```
┌────────────────────┐    HTTP (同源默认)     ┌──────────────────────────┐    HTTP (地址可配置)    ┌────────────────────────┐
│  浏览器应用 (web/)  │ ─ 静态页面 + /api/* ─▶ │  Readeva 服务 (server/)   │ ─ 单页字节流 / 结果 ──▶ │ Docling 解析服务        │
│  原生 ES Modules   │ ◀── JSON / PDF 字节流 │  Node.js + Express        │ ◀── DoclingDocument ── │ (docling_service/,      │
│  + PDF.js 渲染     │                       │  书库 / 解析编排 / 数据    │                       │  Python+FastAPI)        │
└────────────────────┘                       └──────────────────────────┘                        └────────────────────────┘
```

- 客户端是浏览器应用，由 Readeva 服务静态托管（默认同源）；关闭浏览器不影响两个服务进程。
- Readeva 服务是独立进程，监听地址/端口可配置（CLI 参数或环境变量，见 README「配置」）。
- **Docling 解析服务**（Issue #3）是另一个独立进程（本机用 conda 环境 `readeva` 运行）：无状态，接收单页 PDF 字节流、返回结构化内容；地址在 Readeva 服务端配置（`--docling-url` / `READEVA_DOCLING_URL`），**客户端不接触解析服务地址与密钥**。
- 客户端可在「服务设置」中指向其他 Readeva 服务地址（localStorage）；所有契约不依赖客户端与服务共享文件路径——导入上传字节流，阅读按 HTTP URL 取回 PDF 副本，**页解析由 Readeva 服务抽取单页后以字节流发送**。
- 解析服务实现 docling-serve 兼容线协议（异步提交/状态轮询/结果获取），可被远端 docling-serve 或解析项目的正式服务替换；解析内容质量修复由解析项目承担，本项目只消费结果。

## 数据模型

文档身份以**文件内容 SHA-256 摘要**确定（`server/library.js`）：

- 导入时计算摘要；`library/<sha256>.pdf` 为内容寻址副本，同一内容永不重复入库（导入幂等）。
- 文档名只是元数据：改名再导入仍返回同一文档（`created: false`）。
- 阅读位置按文档保存在 `progress/<sha256>.json`，变化后立即原子写入；服务端为真源，客户端打开文档时从服务取回恢复。
- **页解析（Issue #3）按「文档身份 + 页码」保存在 `parses/<sha256>/page-N.json`**：记录解析身份（`parseId`，对内容块做 SHA-256，内容不变则身份不变）、按阅读顺序的内容块（结构、文字、资源、可用位置）及元信息/失败原因；服务重启后直接取回，不重新解析。

JSON 持久化使用「临时文件 + rename」原子写；Windows 上 rename 可能因文件句柄冲突抛 EPERM/EBUSY，实现中带有限重试（`server/fs-utils.js`）。

## 内容块模型（页解析）

解析服务返回 DoclingDocument JSON（docling-core 序列化格式），服务端适配层（`server/docling.js`）按 body 子节点顺序规范化为内容块：

| 块类型 | 来源 | 字段 |
| --- | --- | --- |
| `heading` | `title` / `section_header` | `text`、`level` (1/2) |
| `paragraph` | `paragraph`、`text`、`caption`、`footnote` 等 | `text` |
| `list` | `list_item`（相邻合并，含 list 组） | `items[]`、`ordered` |
| `table` | `table`（grid 解引用 table_cells） | `rows[][]`、`columnHeader` |
| `image` | `picture`（内嵌 data URI 或 http(s) URI） | `image.uri`、`image.mimeType` |

- 每块携带 `id`（块内唯一）与阅读顺序 `order`；页眉页脚（furniture 层与 page_header/page_footer/page_number）不进入阅读顺序。
- 位置取自 `prov[0].bbox`（记录 l/t/r/b/coordOrigin，页码归一为用户阅读页）；**缺少位置不阻断展示**，仅 `bbox: null`。
- 坐标为 PDF 点距（页面尺寸坐标系，`coordOrigin` 记录原点方向：Docling 默认 `BOTTOMLEFT`，PDF 原生；也兼容 `TOPLEFT`）；客户端换算时按原点显式翻转（见「双向联动」）。
- 图片资源仅接受 data URI 或 http(s) URI；服务端本地路径等不可达资源以占位展示，内容块仍然保留。
- 解析身份 `parseId = sha256(blocks)`：同一内容重新解析身份不变（为后续译文绑定提供稳定关联）。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 `{ ok, service, version }` |
| POST | `/api/documents/import` | 原始字节流上传（`x-filename` 头携带文件名）；校验为可解析 PDF；成功返回 `{ document, created }`，201 新建 / 200 已存在（相同内容） |
| GET | `/api/documents` | 列出全部文档（按最近阅读排序） |
| GET | `/api/documents/:id` | 单个文档元数据 |
| GET | `/api/documents/:id/file` | PDF 副本字节流（不可变缓存头） |
| GET | `/api/documents/:id/progress` | 阅读位置 `{ page, zoom, updatedAt }`（无记录时默认第 1 页、100%） |
| PUT | `/api/documents/:id/progress` | 保存阅读位置；页码按 PDF 页数钳制，缩放钳制到 [0.25, 5] |
| GET | `/api/parse/service` | 解析服务可用性 `{ configured, engine }`（不含地址/密钥） |
| POST | `/api/documents/:id/pages/:page/parse` | **页解析请求**（幂等，兼作失败页显式重试）：未开始 → 202 后台解析；并发占满 → 202 `{status:"queued"}` 排队且置于队首；进行中 → 200；已完成 → 200 `{ reused: true }` 复用不重新解析；未配置解析服务 → 503 |
| GET | `/api/documents/:id/pages/:page/parse` | **任务状态**：`idle`（未开始）/ `queued`（已接受、队列中）/ `running`（已开始）/ `succeeded`（含 `parseId`）/ `failed`（含 `error`） |
| GET | `/api/documents/:id/pages/:page/parse/result` | **结果获取**：按页返回 `{ parse: { parseId, blocks, meta } }`；仅成功后可得，否则 404 |
| PUT | `/api/documents/:id/reading-position` | **阅读页优先级更新**（Issue #5）：`{ page }` → 服务端按「当前页及后续页优先，其余降级」重排未开始任务（显式请求置顶的页不降级），返回调度后的整本进度快照；未配置解析服务时 `{ scheduled: false }` |
| GET | `/api/documents/:id/parse/progress` | **整本解析进度**（Issue #5）：逐页状态（idle/queued/running/succeeded/failed + `queuePosition` + 失败原因）+ 计数（succeeded/failed/running/queued/idle、total）；基于轻量状态索引构建（B1：不逐轮读盘解析内容块），服务重启后进度不丢 |

错误返回 `{ error }`；非 PDF 导入返回 400；未知文档返回 404；非法页码返回 400。

解析任务在服务端后台执行（`server/page-tasks.js`）：抽取单页字节流（pdf-lib，固定元数据保证字节确定）→ 提交解析服务 → 轮询状态 → 取结果 → 规范化 → 自动持久保存（成功与失败都落盘）。服务重启丢失的进行中任务回落为「未开始」，已完成页永远从磁盘取回。

## 按阅读位置的解析调度（Issue #5）

`server/page-tasks.js` 的 `ParseTaskManager` 在单页编排之上维护**按文档的未开始任务优先队列**（内存态；已开始/成功/失败状态仍以 parse-store 落盘记录为唯一状态源，不另存一份）：

- **优先级规则**：`PUT /api/documents/:id/reading-position` 上报阅读位置后，未开始任务按「当前页 → 后续页 → 前置页」升序重排；跳页只重排未开始任务，进行中的页不取消、不重复启动。
- **队列成员**：仅收未开始（无落盘记录且未运行）的页；已完成页从队列摘除、复用结果；**失败页不入自动队列、不自动重试**——标记失败、不阻塞队列，仅通过显式解析请求（`POST …/parse`）重试，成功后由 `saveResult` 替换失败记录。用户视角：整本补全会停在「解析 x/y · 失败 n」（面板头部静态文本），失败页保持可见可重试。
- **派发**：全局并发上限可配置（`--parse-concurrency` / `READEVA_PARSE_CONCURRENCY`，默认 2，与 docling_service 线程池 `max_workers=2` 对齐——同进程共享已加载模型，内存不翻倍、CPU 翻倍；跨文档共享；本机 2GB pagefile 下 2 是稳妥上限）；任务结束（成功或失败）后继续派发队列下一页——队列按序补全其余未解析页（闲置补全）。跳页插队为 staggered 语义：新页插入队首，任一并发槽释放即开始，不做「保留空槽」，平均跳页等待约为串行的一半。
- **开局填充**：每次扫全会话（文档打开/首次阅读位置上报）立即填满所有并发槽（并发 2 → 两页同时开始，不做 pacing）；pacing 只作用于后续背景派发。会话在队列排空且无运行中任务时结束，下次上报重新授予。
- **动态 pacing（默认）**：连续背景派发之间的间隔 = 最近 3 页转换耗时（派发→succeeded/failed，不含排队）均值 × `--parse-sweep-pacing-factor` / `READEVA_PARSE_SWEEP_PACING_FACTOR`（默认 0.5），钳制 [0, 5000]ms——设备快→间隔小吞吐高，设备慢→间隔大留 CPU 给阅读交互（系数 >0.5 时并发 2 下出现 CPU 空隙）。**代价与边界**：pacing 默认开启，稳态整本补全吞吐低于「不节流」（单页耗时 T 时约 1.5T/页）；**当前页（非 pinned）同样受 pacing 约束**，翻页后最多可能等待一个 pacing 间隔（上限 5s）；系数传 0/非法值会回落默认 0.5（当前无「完全关闭」档，需固定节流时用 `READEVA_PARSE_SWEEP_DELAY_MS`）。pacing 状态目前是服务级全局（`sweepTimer`/`lastSweepDispatchAt`/耗时样本），队列则按文档隔离——多文档并行时耗时样本互相污染，待后续按 docId 分桶。
- **固定节流覆盖（可选）**：`--parse-sweep-delay-ms` / `READEVA_PARSE_SWEEP_DELAY_MS` 设 >0 时以固定间隔覆盖动态 pacing。显式请求/置顶页在两种模式下均不受限（等待期间任务留在队首、不占并发槽）。
- **显式请求插队**：`POST …/pages/:page/parse` 将目标页置于队首并标记置顶（pinned）：随后的阅读位置重排不会把显式请求/重试的页降级；页离开队列（开始执行或复用跳过）即消耗置顶标记。
- **进度查询**：`GET /api/documents/:id/parse/progress` 返回逐页状态（含队列位置与失败原因）与计数（succeeded/total + failed/running/queued/idle）；已完成/失败页以落盘记录的轻量状态索引为准，服务重启后进度不丢。
- **轻量状态索引（B1）**：进度快照、优先级重排与单页状态查询经 `parse-store.getStatus()` 只读状态字段（status/parseId/error/updatedAt），按 mtime+size 命中缓存、写路径主动失效——不逐轮全量读盘解析内容块（实测 215 页 × ~660KB/页 从每轮 ~139MB 读盘 / ~0.3s 同步阻塞降至每轮仅 stat）；内容块仅在 `GET …/parse/result` 时读取。
- **触发边界与自愈**：整本调度仅由阅读位置更新触发（客户端打开文档/翻页时上报）；单独的页解析请求不触发整本调度（Issue #3 行为保持）。客户端退出宽限期与重连重新调度属 Issue #6，本阶段队列一旦建立即运行至完成；作为低成本兑底，面板在事件式刷新整体进度快照时发现「无 queued/running 且仍有 idle 页」（如服务重启导致内存队列丢失）会自动重报阅读位置恢复调度（带冷却）。
- **前端呈现（收敛轮）**：右侧面板**不再有独立进度区**（逐页状态芯片已彻底移除）。单页解析状态、失败原因与显式重试**内联在内容列表**（状态徽标 + 失败原因 + 重试按钮）；整本进度只有**面板头部一处静态文本**（如「解析 12/215 · 失败 1」），仅在事件（派发/完成/失败/重试/翻页）时取一次快照更新——无定时轮询、不重建逐页芯片；未配置解析服务时界面无任何进度残留（仅一行静态提示）。

## 双向联动（Issue #4）

原页与内容块的对照阅读在纯前端实现（`web/page-linkage.js`），服务端无新增接口：

- **覆盖层**：`#page-stage`（position relative）包住 canvas，`#page-overlay` 覆盖层内按内容块 bbox 叠加定位框 `.page-block-box`。bbox（PDF 点坐标）→ 渲染坐标的换算系数取「canvas CSS 尺寸 / 页面点尺寸」，与 devicePixelRatio 无关，天然跟随缩放（含「适配宽度」）；`coordOrigin=BOTTOMLEFT` 时按页面点高度翻转后映射到顶部原点。
- **滚动布局契约**：`#viewer` 用 `justify-content: flex-start` + `align-items: flex-start`、`#page-stage` 用 `margin: 0 auto`——画布宽/高于可视区时只向右/向下溢出，起始侧始终可达（居中溢出会使起始侧落在可滚动区之外，scrollLeft/scrollTop 无法为负，主动定位会静默失效）；不拉伸 stage 保证覆盖层贴合 canvas 实际尺寸。
- **主动定位滚动**：直接设 `viewer.scrollTop/scrollLeft`（`#viewer`）与 `content.scrollTop`（右侧面板）居中目标元素，不用 `scrollIntoView`（可能连带滚动外层文档）。
- **组件间零耦合**：数据全部经 DOM 与事件流转——渲染完成后 `PdfViewer` 在 `#viewer` 上派发 `pdf-rendered`（携带 page/zoom/页面点尺寸）；`ParsePanel` 渲染内容后派发 `parse-blocks-changed`，内容块带 `data-bbox`（原始 bbox JSON）。联动层监听两类事件重建覆盖框，翻页/缩放后位置自动重算，选中态跨缩放保留、跨翻页重置。
- **双向交互**：悬浮右侧内容块 ↔ 悬浮原页覆盖框互相高亮（`.hot`）；点击右侧块 → 原页滚动定位到对应区域，点击覆盖框 → 右侧滚动定位到对应块（`.active` 选中态独占）。
- **失败语义**：位置不可用（`bbox: null` 或无效坐标，如零尺寸/出页）的内容块照常展示、无覆盖框；悬浮静默（无框可亮即无操作）；主动定位失败给 `#locate-toast` 短提示（约 3s 自动消失），均不报错、不打断阅读。

## 后续扩展边界（本任务不实现）

- **客户端退出宽限期与重连重新调度（Issue #6）**：客户端退出/连接失效后完成已开始页并清除未开始排队、重连取回结果并重新调度；调度与持久化基础已在本任务就位。
- **查词翻译、成果包导入导出**：译文将绑定「文档 + 页解析身份（parseId）」；成果包可从 `parses/` + `progress/` + 文档身份组成一致快照。
