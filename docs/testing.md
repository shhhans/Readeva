# 测试

## 测试边界

按父规格 Testing Decisions：**浏览器完整操作流程为主要测试边界**；日常自动化使用固定数据，不依赖外部服务；外部能力（Docling）通过固定结果和真实接入两层验证。

端到端测试使用 Playwright（Chromium 无头模式，Windows 本机可运行），测试自行以**生产同一入口**（`server/index.js`，临时数据目录）启动独立服务进程，并在用例中真实重启服务。日常自动化的 Docling 依赖由 `tests/helpers/mock-docling.js` 提供：实现 docling-serve 兼容线协议（异步提交/状态轮询/结果获取）的 HTTP mock，返回固定 DoclingDocument JSON（`tests/fixtures/docling/`），验证对外行为及保存成果，不依赖真实外部服务。

## 用例与验收标准映射

### 书库与原页阅读（Issue #2）

文件：`tests/e2e/library.spec.js`（串行执行，状态按顺序流转）。

| # | 验收标准 | 用例与关键断言 |
| --- | --- | --- |
| 1 | Windows 启动浏览器应用与独立服务，可重复启动并有说明 | 测试每次运行以 `node server/index.js` 启动服务并等待 `listening on` 输出；启动/配置说明见 README；`npm test` 即可重复验证 |
| 2 | 导入多份有文字层 PDF，保存副本，内容摘要身份，同内容不重复 | 「导入多份 PDF 后书库列出」+「相同内容不同文件名不会产生重复身份」：导入后列表 2 行；改名重导后仍 2 行且提示「已存在」；身份列为 SHA-256 前缀 |
| 3 | 书库可列出及再次打开，原页保留原始排版 | 「书库可再次打开文档，原页按原始排版渲染」：书库行点「打开」；PDF.js canvas 渲染完成且像素断言存在大量文字像素（非空白），页数与 PDF 内容一致（8 页） |
| 4 | 翻页、页码跳转、缩放；自动保存并恢复上次阅读页 | 「支持翻页、页码跳转和缩放」（下一页 ×2、跳页到 5、放大 120%/还原 100%）+「阅读位置变化后自动持久保存」（轮询服务端进度直至 `6:1.2`）+「重启服务后新浏览器会话恢复」（杀掉服务进程、同数据目录重启、全新浏览器上下文打开恢复第 6 页与 120%） |
| 5 | 浏览器测试验证导入、再次打开、阅读操作与重启恢复 | 全部用例在真实浏览器中通过 UI 操作（文件选择、按钮点击、输入跳页）完成，无内部函数调用 |

### 页解析与结构化内容（Issue #3）

| 文件 | 覆盖 |
| --- | --- |
| `tests/e2e/parse-api.spec.js`（服务级，mock Docling） | 解析请求 202 → 状态流转 succeeded（含 parseId）；结果按阅读顺序：标题/小节/无序与有序列表/表格（列头+数据行）/图片（data URI 资源）/缺位置段落（bbox null）齐备，页眉页脚（furniture）跳过；**单页字节流上传校验**（mock 收到的上传字节 sha256 = pdf-lib 抽取的单页字节，filename `page-3.pdf`，契约不依赖共享文件路径）；**重启服务后同 parseId 恢复且解析服务零新增请求**；已完成页重复请求 `{ reused: true }` 不重新解析；失败 → 状态 `failed` 带原因 → 重试成功；不同页解析独立（按页保存）；非法页码/未知文档 400/404 |
| `tests/e2e/parse-panel.spec.js`（浏览器级，mock Docling） | 原页先渲染（`data-page` 先就绪）解析不等阅读；面板状态可见（未开始/解析中…/已完成）；右侧按阅读顺序渲染标题/段落/列表（ul+ol）/表格（th+td）/图片（img naturalWidth>0），缺位置块照常展示（`data-has-position=false`），页眉页脚不出现；翻页按页解析（mock 收到 `page-1.pdf`、`page-3.pdf`）；回到已解析页与重开文档直接取回（转换请求数不变）；**重启服务后新会话恢复内容且不重新解析**；解析失败状态+原因可见、重试按钮恢复 |
| `tests/e2e/parse-unconfigured.spec.js` | 未配置解析服务降级：`/api/parse/service` `{configured:false}`、解析请求 503、状态 idle、结果 404；浏览器打开阅读不受影响，面板提示「解析服务未配置」 |

## 真实 Docling 接入验证

非自动化层，验收时以真实服务执行（脚本 `node .tmp/verify-real.mjs`，见仓库 PR 描述中的结果记录）：

1. 启动解析服务：`conda run -n readeva python -m uvicorn docling_service.main:app --host 127.0.0.1 --port 5001`（conda 环境 `readeva`，docling 2.153.0）。
2. 启动 Readeva 服务：`npm start -- --docling-url http://127.0.0.1:5001`。
3. 导入 Hans 指定 PDF「Inflight Service Manual - Chapter 3 Business Service.pdf」（215 页），解析代表页：状态流转成功；标题/段落/列表/表格/图片资源按阅读顺序返回（第 15 页含全部五类内容块）；全部块带可用位置。
4. 重启 Readeva 服务：已完成页状态/parseId/完成时间不变，解析服务零新增转换请求（不重新解析）。
5. 浏览器打开阅读视图：右侧面板展示真实解析内容（截图留档 `.tmp/real-docling-panel.png`）。

解析输出质量（内容准确性）由解析项目负责，本项目只验证结果消费、展示与保存恢复。

## 运行

```powershell
npx playwright install chromium   # 首次
npm test
```

- 测试使用临时数据目录（`os.tmpdir()` 下随机目录），不污染开发书库。
- 服务重启用例验证「关闭浏览器/重启服务后恢复」契约：位置与解析保存在服务端，新浏览器会话即应用重启。
- 失败时 `test-results/`、`playwright-report/` 保留 trace 与报告。

## 固定数据

- `tests/fixtures/sample-a.pdf`（8 页）、`tests/fixtures/sample-b.pdf`（4 页）由 `scripts/make-fixtures.mjs`（pdf-lib）生成：带真实文字层、含标题/段落/表格/矢量图形页，创建日期固定。`npm run fixtures` 可再生成。
- `tests/fixtures/docling/default-page.json`、`tests/fixtures/docling/page-3.json` 为固定 Docling 结果（DoclingDocument JSON）：标题/小节、段落（含缺位置样例）、无序/有序列表、4×3 表格（列头+数据）、内嵌 PNG 图片资源、furniture 页眉页脚（应被跳过）。
