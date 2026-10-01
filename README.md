# 灰度图接缝缩放（Seam Carving）与保护区域追踪后端

Windows 本地可运行的**内容感知灰度图缩小**服务，只提供 **HTTP API 与 CLI**（无网页、无识别模型、无在线服务）。

- 语言/运行时：TypeScript + Node.js（要求 Node `>= 22.5`，开发环境为 Node 25）
- 数据库：**SQLite**，使用 Node 内置 `node:sqlite`，**无需原生编译、无需 Docker/WSL**
- 运行时第三方依赖：**零**（仅开发依赖 `typescript` 与 `@types/node`）
- 算法全部自行实现：梯度能量 + 动态规划最小代价接缝，**未使用任何 seam carving 库，也不做等比例插值**

## 能力与约束

- 输入：8 位灰度像素矩阵（0..255）或文本 PGM（Netpbm **P2**）。
- **只缩小**：目标宽高均不得大于原图，且每个维度至少保留 1 个像素。
- 两种掩膜（与图像同尺寸、取值 0/1）：
  - `protect` 保护掩膜：**硬约束**，接缝永远不能经过；不存在可行接缝时返回明确阻塞原因，绝不降低保护强度。
  - `preferDelete` 优先删除掩膜：**可配置负代价偏好**（`energyConfig.preferWeight`），不是硬约束。
  - 同一像素不能同时为两种掩膜，否则请求被拒绝（`MASKS_CONFLICT`）。
- 公开尺寸上限：单边 `MAX_DIMENSION=2000`、总像素 `MAX_PIXELS=1,000,000`（见 `GET /api/limits`）。

## 算法说明（公开承诺）

### 能量

- 默认 `gradient: "l1"`：每像素能量 = 与左/右邻居灰度差绝对值之和 + 与上/下邻居差绝对值之和。
- 也支持只看水平梯度（`"horizontal"`）或只看垂直梯度（`"vertical"`）。
- 图像边界策略 `boundary`（显式可配）：
  - `zero`（默认）：越界邻居按灰度 0 处理。
  - `replicate`：越界方向复制边界像素（这些方向梯度恒为 0）。
  - `wrap`：环形边界（左右相接、上下相接）。
- 掩膜代价叠加：`preferDelete` 像素能量减去 `preferWeight`（必须为非负数，0 表示关闭偏好）；
  `protect` 像素能量**最后**置为 `Infinity`，不会被偏好抵消。

### 接缝搜索（动态规划）

- 垂直接缝：每行恰好一个像素，共 `height` 个；相邻两行所在列之差不超过 1。
  `dp[r][c] = energy[r][c] + min(dp[r-1][c-1], dp[r-1][c], dp[r-1][c+1])`。
- 水平接缝：对能量网格做**概念转置**后按同一规则处理（每列一个像素，相邻列行差 ≤ 1）。
- **同代价路径的确定性选择**：父代代价相等时固定优先 `左上/上左 → 正上 → 右上/上右`
  （即总是优先更靠左的父代）；末行平局取最左列。同一输入与配置永远得到同一条接缝。
- 无可行接缝时返回 `feasible:false` 与机器可读阻塞原因：
  `PROTECTED_FULL_ROW` / `PROTECTED_FULL_COLUMN`（某行/列整线被保护）或
  `PROTECTED_BARRIER`（保护像素形成无法从一边连通到另一边的屏障）。

### 连续删除与追踪

- 每删除一条接缝，都在**当前图像上重新计算能量**，再找下一条接缝。
- 两种明确操作顺序：`width-first`（先减宽再减高）与 `height-first`（先减高再减宽）。
- 每一步记录：接缝路径、代价、删除后中间尺寸、被删像素映射回**原图的坐标**。
- 同步更新像素值、`protect`、`preferDelete` 两个掩膜，以及 `origin[r][c] = [原图行, 原图列]` 来源映射。
- **最优性边界（不夸大）**：每一步是当时图像上的最小代价接缝（`stepwise-greedy` 逐步最优）；
  由于删除会改变后续能量场，**不保证**整个缩放序列的全局最优。

### 回放与独立核验

`/api/reports/{id}/replay` 用报告里冻结的接缝序列，从冻结的初始图像重新播放：

- 逐步检查接缝长度、越界、断裂、与当时尺寸是否一致，任一不满足即拒绝；
- 重算能量并核对该步代价、结果尺寸、被删原始像素坐标；
- 最终逐像素比对矩阵、两个掩膜与来源映射，并确认没有任何受保护像素被删除。

失败操作不会写入报告（缩小在落库前完成计算），删除操作以不可变方式生成新矩阵，**源对象不被改写**。

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 编译测试并运行 node --test（29 个用例）
npm run demo       # 端到端演示：保护前后路线、两种顺序、重启复核
npm start          # 启动 HTTP API（默认 http://127.0.0.1:8787）
```

配置（环境变量）：

- `PORT` 或 `SEAMCARVE_PORT`：HTTP 端口，默认 `8787`。
- `SEAMCARVE_DATA_DIR`：项目内数据目录，默认 `./data`（SQLite 文件 `data/seamcarve.sqlite`）。

```powershell
$env:PORT='9000'
$env:SEAMCARVE_DATA_DIR='E:\GSB\0205\A\data'
npm start
```

## HTTP API

所有请求/响应均为 JSON；成功响应包一层 `{ "data": ... }`，失败为
`{ "error": { "code", "message", "details" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/limits` | 公开尺寸上限与默认能量配置 |
| POST | `/api/images` | 导入图像（`matrix` 或 `pgm`，含两个可选掩膜） |
| GET | `/api/images` | 列出图像版本 |
| GET | `/api/images/{id}` | 取图像完整内容（矩阵/掩膜/来源映射） |
| POST | `/api/images/{id}/energy` | 预览能量矩阵（body 可带 `energyConfig`） |
| POST | `/api/images/{id}/seams/vertical` | 只查找单条垂直接缝，不删除 |
| POST | `/api/images/{id}/seams/horizontal` | 只查找单条水平接缝，不删除 |
| POST | `/api/images/{id}/seams/{vertical\|horizontal}/check` | 校验外部接缝是否合法 |
| POST | `/api/shrink` | 执行缩小，生成版本报告 |
| GET | `/api/reports` | 列出报告 |
| GET | `/api/reports/{id}` | 取完整报告（逐步接缝/代价/来源/最终产物） |
| POST | `/api/reports/{id}/replay` | 用已保存接缝独立重放并逐像素核验 |
| POST | `/api/reports/{id}/verify-protection` | 保护区域核验 |
| POST | `/api/compare` | 版本比较（图像对图像，或图像对报告产物） |
| POST | `/api/reports/{id}/export` | 导出 `json` 或 `pgm`（P2） |

### API 示例

```powershell
# 导入（也可用 -- 见 examples/import.json）
$body = Get-Content -Raw examples\import.json
$imp = Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/images -ContentType 'application/json' -Body $body
$id = $imp.data.imageId

# 缩小到 3x2，先宽后高
$shrink = @{ imageId=$id; targetWidth=3; targetHeight=2; order='width-first' } | ConvertTo-Json
$res = Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/shrink -ContentType 'application/json' -Body $shrink
$rid = $res.data.report.reportId

# 独立回放核验 / 保护核验 / 导出 PGM
Invoke-RestMethod -Method Post "http://127.0.0.1:8787/api/reports/$rid/replay"
Invoke-RestMethod -Method Post "http://127.0.0.1:8787/api/reports/$rid/verify-protection"
$exp = @{ format='pgm' } | ConvertTo-Json
(Invoke-RestMethod -Method Post "http://127.0.0.1:8787/api/reports/$rid/export" -ContentType 'application/json' -Body $exp).data.content
```

## CLI

```powershell
npm run cli -- limits
npm run cli -- import --json-file examples\import.json
npm run cli -- import-pgm --pgm-file examples\sample.p2
npm run cli -- energy --image-id <ID>
npm run cli -- seam --image-id <ID> --orientation vertical
# 把 import 返回的 imageId 填入 examples\shrink.json 后：
npm run cli -- shrink --json-file examples\shrink.json
npm run cli -- report --report-id <RID>
npm run cli -- replay --report-id <RID>
npm run cli -- verify-protection --report-id <RID>
npm run cli -- compare --a-image-id <A> --b-report-id <RID>
npm run cli -- export --report-id <RID> --format pgm --out out.p2
```

## 幂等与持久化

- 图像按“矩阵+两个掩膜”的内容哈希去重，重复导入返回同一 `imageId`（`created:false`）。
- 缩小请求按“图像哈希 + 目标宽高 + 操作顺序 + 能量配置”的 SHA-256 指纹去重，
  重复请求返回同一份报告；服务重启后依然幂等（SQLite 唯一索引保证）。
- 输入与操作配置随图像/报告以 JSON **冻结**在 SQLite 中。

## 目录结构

```
src/
  types.ts                类型、公开上限、默认能量配置
  errors.ts               结构化业务错误
  hash.ts                 稳定哈希（导入/请求幂等）
  db.ts                   SQLite 持久层（node:sqlite）
  service.ts              用例编排（导入/能量/接缝/缩小/回放/比较/导出）
  config.ts               端口与数据目录配置
  image/                  校验、图像工厂、P2 编解码
  seam/
    energy.ts             梯度能量
    search.ts             动态规划接缝搜索 + 平局规则 + 阻塞原因
    remove.ts             接缝删除、掩膜/来源映射更新、接缝合法性
    recarve.ts            连续缩小编排 + 独立回放核验
    bruteforce.ts         穷举全部接缝（仅测试交叉核验）
  server/api.ts           纯 JSON HTTP API
  cli/cli.ts              命令行
  demo.ts                 端到端演示
  *.test.ts               node:test 测试
```

## 测试覆盖

`npm test` 覆盖：常量图、梯度图、细线图案、负代价偏好、单行单列、受保护区域完全阻断；
对 2x2 至 5x5 随机小矩阵**穷举全部合法接缝**核对最小代价与平局路径；每步尺寸、
像素来源映射、保护像素零丢失、水平操作与转置对应；报告被篡改（越界/断裂）时拒绝回放；
导入与缩小请求幂等；SQLite 关闭重开后的重启复核。

## 限制与合理假设

- 仅支持**文本 PGM（P2）**与 JSON 矩阵；二进制 P5 及其它图像格式不在范围内。
- 只缩小、不放大；总像素受 `MAX_PIXELS` 约束，动态规划内存约为 `O(宽×高)`。
- 逐步贪心最优，**不是**整条删除序列的全局最优。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，功能稳定可用。
- 请求体上限 50MB；并发写入依赖 SQLite 的串行写特性。
