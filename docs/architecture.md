# 架构

## 进程模型

```
┌────────────────────┐         HTTP (同源默认)          ┌──────────────────────────┐
│  浏览器应用 (web/)  │  ── 静态页面 + /api/* ──────────▶ │  独立服务进程 (server/)   │
│  原生 ES Modules   │  ◀── JSON / PDF 字节流 ───────── │  Node.js + Express       │
│  + PDF.js 渲染     │                                  │  书库 / 数据目录          │
└────────────────────┘                                  └──────────────────────────┘
```

- 客户端是浏览器应用，由服务静态托管（默认同源）；关闭浏览器不影响服务进程。
- 服务是独立进程，监听地址/端口可配置（CLI 参数或环境变量，见 README「配置」）。
- 客户端可在「服务设置」中指向其他服务地址（localStorage），为未来服务端部署保留边界；契约不依赖客户端与服务共享文件路径——导入上传字节流，阅读按 HTTP URL 取回 PDF 副本。

## 数据模型

文档身份以**文件内容 SHA-256 摘要**确定（`server/library.js`）：

- 导入时计算摘要；`library/<sha256>.pdf` 为内容寻址副本，同一内容永不重复入库（导入幂等）。
- 文档名只是元数据：改名再导入仍返回同一文档（`created: false`）。
- 阅读位置按文档保存在 `progress/<sha256>.json`，变化后立即原子写入；服务端为真源，客户端打开文档时从服务取回恢复。

JSON 持久化使用「临时文件 + rename」原子写；Windows 上 rename 可能因文件句柄冲突抛 EPERM/EBUSY，实现中带有限重试。

## API（当前 Issue #2 范围）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 `{ ok, service, version }` |
| POST | `/api/documents/import` | 原始字节流上传（`x-filename` 头携带文件名）；校验为可解析 PDF；成功返回 `{ document, created }`，201 新建 / 200 已存在（相同内容） |
| GET | `/api/documents` | 列出全部文档（按最近阅读排序） |
| GET | `/api/documents/:id` | 单个文档元数据 |
| GET | `/api/documents/:id/file` | PDF 副本字节流（不可变缓存头） |
| GET | `/api/documents/:id/progress` | 阅读位置 `{ page, zoom, updatedAt }`（无记录时默认第 1 页、100%） |
| PUT | `/api/documents/:id/progress` | 保存阅读位置；页码按 PDF 页数钳制，缩放钳制到 [0.25, 5] |

错误返回 `{ error }`；非 PDF 导入返回 400；未知文档返回 404。

## 后续扩展边界（本任务不实现）

- **页解析调度（Issue #5）**：Docling 通过服务适配层接入同一服务进程，新增「页解析请求 / 任务状态 / 结果获取 / 阅读页优先级」等端点；服务端持久保留已完成页解析。
- **双向联动（Issue #4）**：阅读视图右侧预留结构化内容区域；PDF.js 渲染与 `#viewer` 容器已将原页独立成组件（`web/pdf-viewer.js`），便于叠加 bbox 覆盖层。
- **查词翻译、成果包导入导出**：继续复用文档内容身份与阅读位置数据。
