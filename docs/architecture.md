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
| POST | `/api/documents/:id/pages/:page/parse` | **页解析请求**（幂等）：未开始 → 202 后台解析；进行中 → 200；已完成 → 200 `{ reused: true }` 复用不重新解析；未配置解析服务 → 503 |
| GET | `/api/documents/:id/pages/:page/parse` | **任务状态**：`idle`（未开始）/ `running`（已开始）/ `succeeded`（含 `parseId`）/ `failed`（含 `error`） |
| GET | `/api/documents/:id/pages/:page/parse/result` | **结果获取**：按页返回 `{ parse: { parseId, blocks, meta } }`；仅成功后可得，否则 404 |

错误返回 `{ error }`；非 PDF 导入返回 400；未知文档返回 404；非法页码返回 400。

解析任务在服务端后台执行（`server/page-tasks.js`）：抽取单页字节流（pdf-lib，固定元数据保证字节确定）→ 提交解析服务 → 轮询状态 → 取结果 → 规范化 → 自动持久保存（成功与失败都落盘）。服务重启丢失的进行中任务回落为「未开始」，已完成页永远从磁盘取回。

## 后续扩展边界（本任务不实现）

- **页解析调度（Issue #5）**：当前页及后续页优先、跳页重排优先级、闲置补全剩余页、失败隔离与显式重试、客户端退出宽限期与重连重新调度；任务状态机与持久化基础已在本任务就位。
- **双向联动（Issue #4）**：内容块已带 `id` 与可用 `bbox`（页内坐标系），PDF.js 渲染与 `#viewer` 容器独立成组件（`web/pdf-viewer.js`），右侧面板块带 `data-block-id` / `data-has-position`，可直接叠加 bbox 覆盖层与双向高亮。
- **查词翻译、成果包导入导出**：译文将绑定「文档 + 页解析身份（parseId）」；成果包可从 `parses/` + `progress/` + 文档身份组成一致快照。
