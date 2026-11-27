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

### 原页与内容块双向联动（Issue #4）

文件：`tests/e2e/linkage.spec.js`（串行，mock Docling 固定结果；固定数据 `linkage-page.json` 含 TOPLEFT 全块定位与一个 `BOTTOMLEFT` 坐标系样例，`broken-positions-page.json` 含零尺寸无效 bbox 与缺位置样例）。

| # | 验收标准 | 用例与关键断言 |
| --- | --- | --- |
| 1 | 原页区域与右侧内容块支持双向悬浮高亮 | 「双向悬浮高亮」：每个带 bbox 的块有覆盖框（6/6）；悬浮右侧块 → 原页覆盖框 `.hot`，悬浮覆盖框 → 右侧块 `.hot`，移开/切换目标后高亮清除 |
| 2 | 主动选择定位可找到另一侧对应内容 | 「主动定位」：缩小视口并放大到 120% 后点击右侧底部块 → 原页覆盖框 `.active` 且进入视口（此前不可见）；滚动右侧到底后点击覆盖框 → 右侧块进入视口，选中态独占 |
| 3 | 正确处理页面缩放下的有效位置 | 「缩放后覆盖层按当前缩放重算」：120%/100%/83.3% 三档断言覆盖框渲染位置 = bbox（PDF 点坐标）× 当前缩放（±2px）；`BOTTOMLEFT` 样例按页面点高度翻转后仍准；重建不丢框、悬浮继续可用 |
| 4 | 缺失或无效位置仍展示内容；悬浮失败静默，主动定位失败可提示 | 「缺失/无效位置」：零尺寸 bbox（`data-has-position=true`）与缺位置（`false`）块均照常展示且无覆盖框；悬浮静默（自身与原页均不高亮、无提示）；点击 → toast「没有可用位置」且状态仍「已完成」、无错误、无选中残留，提示约 3s 自动消失；同页有效块定位不受影响 |
| 5 | 浏览器测试覆盖双向联动、缩放及无可用位置场景 | 上述用例均为真实浏览器操作（hover/click/缩放按钮/跳页），另覆盖「翻页后覆盖层按新页 bbox 重建并继续联动」 |
| 6 | （审查 B1 回归）画布宽于可视区时主动定位仍可达 | 「画布宽于可视区」：窄视口（700px）+ 放大到 144% 使画布溢出 → 滚到最右后点击左侧内容块 → 原页覆盖框进入视口（此前完全在视口外）；反向点击覆盖框 → 右侧块进入视口 |

### 按阅读位置的解析调度（Issue #5）

服务接口测试 `tests/e2e/parse-scheduler.spec.js`（串行；每用例独立服务进程与 mock，队列内存态隔离后顺序断言才确定；`READEVA_PARSE_CONCURRENCY=1` + 高轮询频率保证确定性）：

| # | 验收标准 | 用例与关键断言 |
| --- | --- | --- |
| 1 | 当前页及后续页优先 | 「阅读位置更新：当前页立即解析，后续页优先排队，前置页降级」：`PUT reading-position {page:3}` 后第 3 页 running、4-8 按 queuePosition 0-4 排队、1-2 降级到队尾（仍 queued，闲置补全覆盖）；mock 实际提交顺序为 page-3 → page-4 → page-5，前置页尚未开始 |
| 2 | 跳页后更新未开始任务优先级 | 「跳页后重排未开始任务」：第 2 页运行中跳到第 6 页 → 队列重排为 [6,7,8,1,3,4,5]（运行中页不取消不重复入队），转换提交顺序 page-2 → 6 → 7 → 8 → 1 → 3 → 4 → 5 |
| 3 | 闲置时解析其他未解析页；已完成结果直接复用 | 「闲置补全」：上报阅读位置后无需其他请求，整本 8 页全部 succeeded（每页有 parseId）；已完成页 POST 解析 → `reused:true` 且转换请求数不变 |
| 4 | 失败页可显式重试，其他页面继续处理 | 「失败页不阻塞队列」（mock 按页失败注入 page-4）：其余 7 页全部完成，失败页状态 failed 带原因、结果 404、不自动重试；「失败页显式重试」：解除注入后 POST 重试 → 202 running → succeeded，仅新增 1 次转换，其他页结果不受影响 |
| 5 | 服务接口测试覆盖 | 以上用例全部走服务 HTTP 接口（import/reading-position/parse/status/progress/result），断言基于 mock 记录的真实提交顺序 |

补充用例：「显式解析请求优先于队列」（并发占满时 202 queued 且置于队首，完成后先解析显式页）；「显式请求置顶不被随后的阅读位置重排降级（pinned）」（置顶页重排后仍在队首：队列 [5,8,2,3,4,6,7]，提交顺序 page-1 → 5 → 8 → 2 → …）；「单页解析请求不触发整本调度」（Issue #3 行为保持）；「进度快照基于持久化记录：重启服务后进度不丢、已完成页不重新解析」；「阅读位置与进度接口的参数校验与降级」（非法页 400、未知文档 404）；「未配置解析服务：阅读位置更新降级不调度，进度接口仍可用」。

B1 规模回归：「B1 规模回归：进度/重排接口走轻量状态索引，不逐轮全量读盘」——导入 210 页 PDF，直接落盘 210 条 ~600KB 成功记录（含 base64 图片资源，等价真实单页记录体积）；首次调用建立轻量状态索引后，连续 3 次 `GET /parse/progress` 与 1 次 `PUT reading-position` 各自耗时 < 250ms（退回全量读盘会退化到数百 ms/轮，审核官实测 ~0.3s/139MB），且不触发任何新增解析。

浏览器级用例 `tests/e2e/parse-progress-ui.spec.js`（mock Docling，验收第 3/4 条界面可见）：整本进度区逐页芯片与摘要「已解析 8/8」；闲置补全后台完成无需用户操作；点击页码芯片跳转且已完成页复用（转换请求数不变）；失败页芯片状态与失败原因（aria-label/面板错误区）可见，点击跳到失败页后重试按钮恢复，整体进度回到「已解析 4/4」；「进度轮询自愈」——删除已解析页落盘记录模拟「队列丢失 + 记录缺失」状态后，面板自动重报阅读位置，该页重新入队解析并回到 8/8（转换请求数 +1）。

既有浏览器用例适配（调度交付后的行为变化，意图不变）：`parse-panel.spec.js` 的「跳页到第 3 页」改为断言 page-3.pdf 确实被请求（整本调度会补全其他页，提交顺序断言移至 parse-scheduler.spec.js）；「回到已解析页与重开文档」先等待后台补全完成再断言复用；「解析失败状态与原因可见，重试后恢复」改用未解析的 sample-b（行为脚本第 1 次成功、其后失败）。

## 真实 Docling 接入验证

非自动化层，验收时以真实服务执行（脚本已入库：仓库根目录运行 `node scripts/verify-real-docling.mjs`，结果记录见 PR 描述）。脚本退出清理自证（Windows）：启动即以 `READEVA_VERIFY_PYTHON`（默认环境内 python.exe，绕过 conda 包装层）直连 docling，成功与异常退出路径均用 `taskkill /PID <pid> /T /F` 杀整棵进程树、等待子进程 exit（8s 超时）并探测 5001/8899 健康端口已不可达，防止 uvicorn 孙进程（~2GB）残留；端口仍可达时打警告（可能是外部遗留进程）：

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
- `tests/fixtures/docling/linkage-page.json`（双向联动样例页：全部块带位置，含 `BOTTOMLEFT` 坐标系样例）、`tests/fixtures/docling/broken-positions-page.json`（零尺寸无效 bbox 与缺位置样例）供联动用例使用。
