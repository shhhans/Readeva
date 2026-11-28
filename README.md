# Readeva

PDF 阅读工作台。当前交付 **Issue #5「按阅读位置调度后台解析」**（父规格 [Issue #1](https://github.com/shhhans/Readeva/issues/1)，基于 Issue #2/#3/#4 交付）：

- 书库导入：保存 PDF 副本，以**文件内容 SHA-256 摘要**作为文档身份（文档名不作为身份依据，相同内容不会重复入库）。
- 原页阅读：使用 PDF.js 按原始排版渲染（文字、表格、图片布局与 PDF 原样一致），支持翻页、页码跳转、缩放。
- 页解析：当前页通过独立 Docling 解析服务解析，原页立即打开不等解析；右侧面板按阅读顺序展示标题、段落、列表、表格与图片资源；解析状态可见（未开始/排队/已开始/成功/失败）；解析以页为单位持久保存，重新打开直接恢复不重新解析。
- **按阅读位置调度（新）**：打开文档/翻页时上报阅读位置，服务端按「当前页及后续页优先，其余降级」重排未开始任务；跳页只重排未开始任务（运行中页不取消）；显式请求/重试的页置顶，不随翻页降级；队列按序闲置补全整本未解析页；已完成页直接复用；失败页标记原因、不阻塞队列、**不自动重试**（整本补全停在 x/y 并显示失败 n），可显式重试；面板展示逐页状态芯片与整体进度（已解析 x/y · 失败 n），点击页码可跳转；进度/重排接口走轻量状态索引（大文档下不逐轮读盘）。并发上限可配置（默认 2，与 docling_service 线程池并发 2 对齐，跳页平均等待约为串行的一半）。
- **双向联动**：原页叠加 bbox 覆盖层，与右侧内容块双向悬浮高亮；点击任一侧主动定位到另一侧对应区域；缩放后覆盖位置按当前渲染缩放重算；缺位置/无效位置的块照常展示，悬浮静默、主动定位失败给短提示不打断阅读。
- 阅读位置：变化后自动持久保存到服务，重启应用/服务后恢复上次阅读页与缩放。
- 独立服务：Readeva 服务为独立进程（Node），关闭浏览器不会终止服务；**Docling 解析服务**也是独立进程（Python，本机用 conda 环境 `readeva` 运行），地址可配置。

查词翻译（ECDICT/MiniMax）、成果包导入导出等属于后续 Issue，不在当前范围。

## 环境要求

- Windows 10/11（首版在本机运行与测试）
- Node.js ≥ 20（在 v24 上验证）
- npm（随 Node 附带）

## 快速开始

```powershell
# 1. 安装依赖
npm install

# 2. 启动 Docling 解析服务（独立进程，需要 conda 环境 readeva）
conda run -n readeva python -m uvicorn docling_service.main:app --host 127.0.0.1 --port 5001
#   首次真实解析时 Docling 会自动下载模型到用户缓存目录。

# 3. 启动 Readeva 服务（另一个终端），并指向解析服务
npm start -- --docling-url http://127.0.0.1:5001
# 输出：
#   Readeva service listening on http://127.0.0.1:8787
#   Readeva data dir: <项目目录>\data
#   Readeva docling service: http://127.0.0.1:5001

# 4. 打开浏览器访问
#   http://127.0.0.1:8787
```

使用流程：点击「导入 PDF」（可多选）→ 书库列出文档 → 点「打开」进入阅读视图 → 原页立即渲染，当前页优先解析并按阅读顺序展示标题/段落/列表/表格/图片 → 后续页在后台按阅读位置优先补全，右侧整本进度区可查看逐页状态与整体进度（点击页码跳转）→ 翻页后调度跟随新阅读位置重排未开始任务 → 失败页在进度区标红并展示原因，跳到该页可重试 → 关闭浏览器或重启服务后再次打开同一文档，阅读位置与**已完成页解析**均直接恢复（不重新解析）。

## 配置

服务为独立进程，地址可按以下优先级配置（命令行参数 > 环境变量 > 默认值）：

| 配置 | 命令行 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 监听端口 | `--port 9000` | `READEVA_PORT` | `8787` |
| 监听地址 | `--host 0.0.0.0` | `READEVA_HOST` | `127.0.0.1` |
| 数据目录 | `--data-dir D:\readeva-data` | `READEVA_DATA_DIR` | `<项目目录>\data` |
| Docling 解析服务地址 | `--docling-url http://127.0.0.1:5001` | `READEVA_DOCLING_URL` | （未配置时页解析不可用） |
| Docling 轮询间隔 | `--docling-poll-interval-ms 500` | `READEVA_DOCLING_POLL_INTERVAL_MS` | `500` |
| Docling 解析超时 | `--docling-timeout-ms 300000` | `READEVA_DOCLING_TIMEOUT_MS` | `300000` |
| 页解析并发上限 | `--parse-concurrency 2` | `READEVA_PARSE_CONCURRENCY` | `2`（与 docling_service 线程池并发对齐，最小 1；本机 2GB pagefile 建议不超过 2） |
| 背景扫全派发节流 | `--parse-sweep-delay-ms 0` | `READEVA_PARSE_SWEEP_DELAY_MS` | `0`（不节流；并发 2 CPU 压力大时可设 500-1000，显式请求不受限） |

解析服务地址是**服务端配置**：客户端不接触解析服务地址与密钥；未来解析服务部署到远端时仅需修改该地址，客户端与应用代码不变。未配置时阅读功能完整可用，右侧面板提示「解析服务未配置」。

浏览器端默认使用同源地址访问服务；如需指向其他地址（如未来部署在服务器上的服务），在书库页点「服务设置」填写服务基地址（保存在浏览器 localStorage）。

示例：

```powershell
npm start -- --port 9000 --data-dir D:\readeva-data
```

## 数据存储

```
data/
  documents.json              # 文档元数据（名称、页数、大小、内容身份、上次阅读）
  library/<sha256>.pdf        # PDF 副本（内容寻址，字节不变）
  progress/<sha256>.json      # 每份文档的阅读位置 { page, zoom, updatedAt }
  parses/<sha256>/page-N.json # 每页解析记录（解析身份、内容块、可用位置、元信息/失败原因）
```

- 文档身份 = 文件内容 SHA-256；把同一 PDF 改名后再导入不会产生新文档。
- 阅读位置在变化后立即写入磁盘（原子写入），服务重启、浏览器重启后均可恢复。
- 页解析完成后自动持久保存（成功与失败都落盘）；服务重启后已完成页直接取回，**不重新解析**。
- 删除 `data/` 目录即可完全重置书库。

## 运行测试

浏览器端到端测试覆盖：导入多份 PDF → 相同内容不重复入库 → 再次打开并验证原页渲染 → 翻页/页码跳转/缩放 → 阅读位置自动保存 → **重启服务**并使用全新浏览器会话验证恢复；以及解析行为（全部使用固定 Docling 结果的 mock 服务，不依赖真实外部服务）：

- 服务级：解析请求/状态流转/结果获取、按阅读顺序的内容块（标题/段落/列表/表格/图片、缺位置不阻断、页眉页脚跳过）、单页字节流上传校验、**重启后不重新解析**、已完成页复用、失败重试、参数校验；以及 Issue #5 的调度行为：阅读位置优先级（当前页及后续页优先、前置页降级）、跳页重排未开始任务、闲置补全整本、失败隔离（不阻塞、不自动重试）、显式重试、显式请求插队、进度快照重启恢复（断言基于 mock 记录的真实提交顺序）。
- 浏览器级：原页立即渲染、解析状态可见、右侧内容展示、翻页按页解析、重开/重启恢复不重新解析、失败状态与重试、未配置降级；以及 Issue #5 的整本进度展示（逐页状态芯片、整体进度、闲置补全后台完成、页码跳转、失败原因与重试恢复）。
- 联动级（Issue #4）：双向悬浮高亮、点击主动定位（双向滚动定位，含画布宽于可视区的窄视口溢出场景）、缩放后 bbox 定位仍准（含 `BOTTOMLEFT` 坐标系样例）、缺失/无效位置场景（悬浮静默、主动定位提示）、翻页后覆盖层重建。

```powershell
# 首次需要安装 Playwright 浏览器（或已安装 Edge 时可改用 channel: "msedge"）
npx playwright install chromium

# 运行测试（自动以临时数据目录启动独立服务，含真实的服务重启步骤）
npm test
```

固定测试数据（带文字层的多页 PDF）位于 `tests/fixtures/`，由脚本生成，可重新生成：

```powershell
npm run fixtures
```

固定 Docling 解析结果（DoclingDocument JSON 固定结果）位于 `tests/fixtures/docling/`，由 `tests/helpers/mock-docling.js` 以 docling-serve 兼容线协议返回。

真实 Docling 接入验证（非自动化）：按「快速开始」启动 conda 环境 `readeva` 中的解析服务与 `--docling-url` 指向它的 Readeva 服务，手动导入目标 PDF 验证解析与展示；也可直接运行入库脚本 `node scripts/verify-real-docling.mjs`（它以环境内 python.exe 直连启动解析服务，退出时用 `taskkill /T /F` 杀整棵进程树并自证端口释放，无残留进程）。测试说明与验收标准映射见 [docs/testing.md](docs/testing.md)。

## 架构简述

- `server/` —— 独立服务进程（Node/Express）：书库 API（导入、列表、文件、阅读位置）+ **页解析 API（请求/状态/结果、阅读页优先级更新、整本进度，Docling 服务适配层与调度器）** + 托管静态前端 + PDF.js 资源。接口契约不依赖客户端与服务共享文件路径（上传字节流、按 URL 取回文件、解析发送单页字节流）。
- `docling_service/` —— 独立 Docling 解析服务（Python/FastAPI，本机 conda 环境 `readeva`）：包装 docling 库，实现 docling-serve 兼容线协议（异步提交/状态轮询/结果获取），无状态，可被远端 docling-serve 或其他兼容服务替换。
- `web/` —— 浏览器应用（原生 ES Modules + PDF.js）：书库视图、阅读视图（原页 + 右侧解析面板 + bbox 覆盖层双向联动 + 整本解析进度）、阅读位置自动保存/恢复、解析状态与结构化内容展示。
- 后续任务（查词翻译、成果包、客户端退出宽限期/重连调度）将在同一服务进程内扩展端点。

详见 [docs/architecture.md](docs/architecture.md)。

## CI

`.github/workflows/ci.yml` 在 `windows-latest` 上执行 `npm ci` → 安装 Chromium → `npm test`。
