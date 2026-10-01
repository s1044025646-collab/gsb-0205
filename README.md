# seamcarve-gray：灰度图内容感知缩小后端（API + CLI）

纯本地运行的八位灰度图 **接缝缩放（seam carving）只缩小** 服务。自行实现梯度能量与动态规划最小代价接缝搜索，**不使用** 任何现成 seam carving 库，也**不使用** 等比例缩放/插值冒充接缝删除。仅提供 HTTP/JSON API 与命令行（CLI），无网页、无图像识别模型、无在线服务。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22.5，开发验证环境 Node v25.5.0）
- 数据库：内置 `node:sqlite`（`DatabaseSync`），无需原生编译，无需 Docker/WSL
- 平台：Windows 本地（PowerShell 命令已验证），同样适用于 macOS/Linux

## 算法约定（对外公开、确定性）

- **能量**：`E(r,c) = |下 - 上| + |右 - 左|`（L1 梯度）。
- **边界策略**（可配置 `energyConfig.boundary`）：
  - `replicate`（默认）：边界外复制最近像素，边界处差分常为 0；
  - `zero`：边界外视为 0。
- **优先删除掩膜**：`E' = E - priorityWeight × priorityMask`，权重 `priorityWeight ≥ 0` 可配置，默认 0（关闭）。它只是“偏好”，不会强制删除。
- **保护掩膜是硬约束**：保护像素不允许出现在接缝上（DP 中代价为 +∞）。无可行接缝时直接返回中文阻塞原因，**绝不会偷偷降低保护强度**。
- **垂直接缝**：每行恰好 1 个像素 `seam[r]`，相邻行 `|seam[r]-seam[r-1]| ≤ 1`，删除后宽度减 1。
- **水平接缝**：按“转置后等价于垂直接缝”处理（每列 1 行，相邻列行差 ≤ 1），删除后高度减 1。
- **同代价（平局）确定性选择**：
  1. 终点在底行取最小代价列，代价相同取**最左**列；
  2. 回溯时父节点固定按 `c-1 → c → c+1` 比较，代价相同取先出现者（整体偏左）；
  3. 水平接缝经转置复用同一规则（对应偏向更靠上的行）。
  相同输入永远得到相同接缝。
- **连续性**：每删一条接缝都基于**当前**图像重新计算能量，并同步更新两个掩膜与“当前像素 → 原图坐标”的映射。
- **操作顺序**：显式支持 `width-first`（先缩宽再缩高）与 `height-first`，每一步保存接缝路径、代价、删除像素的当前坐标与原图坐标、删除前后尺寸。
- **算法保证的边界（不夸大）**：每条接缝都是“当前能量场下动态规划的全局最小代价合法接缝”（逐步最优）；但逐条贪心删除**不保证**最终图在全部删除序列中全局最优，也不保证主观语义效果。
- **独立重放**：仅凭已保存接缝从原图重新删除，检查接缝长度、越界、断裂（相邻差 > 1）、与当时尺寸是否相符；任一不符即拒绝，并与存储产物逐像素核对。失败操作不写库、不留半成品、不改写源图。

## 尺寸与输入限制

`GET /api/limits` 或 `seamcarve limits` 返回，默认：单边 ≤ 4096、总像素 ≤ 4,000,000、像素 ∈ 0..255、目标每维 ≥ 1 且不得大于当前（只缩小）。掩膜必须与图像同尺寸、取值 0/1；同一像素不允许同时被保护与优先删除。

## 快速开始（Windows / PowerShell）

```powershell
npm install
npm run build      # 类型检查并编译到 dist/
npm test           # 编译并运行全部测试（node:test）
npm run demo       # 保护前后路线 + 两种顺序 + 重启后复核 的完整演示

# HTTP 服务（默认端口 8787，数据目录 .\data）
npm start
# 自定义端口与数据目录
$env:SEAMCARVE_PORT="9000"; $env:SEAMCARVE_DATA="$PWD\mydata"; npm start

# CLI（使用编译产物）
node --experimental-sqlite dist/src/cli/index.js limits
```

开发期也可不经编译直接运行 TS：`npm run dev`（服务）、`npm run cli -- ...`（CLI，需 Node 支持 `--experimental-strip-types`）。

## HTTP API（均为 JSON，错误返回 400/404/500 与中文信息）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/limits` | 尺寸上限、边界策略、平局规则、可选顺序 |
| POST | `/api/images/import` | 导入图像（`{pixels, protectMask?, priorityMask?}` 或 `{pgm:"P2 ..."}`），相同内容幂等 |
| GET | `/api/images` / `/api/images/:id` | 列表 / 冻结的图像详情（含两个掩膜） |
| POST | `/api/images/:id/energy` | 预览能量矩阵（body 可带 `energyConfig`） |
| POST | `/api/images/:id/seam` | 只查找单条接缝（`{direction:"vertical"|"horizontal"}`），含 blocked 与原因 |
| POST | `/api/carve` | 执行完整缩小，成功后落库；重复请求返回同一报告（幂等） |
| GET | `/api/reports/:id` | 读取报告（每步接缝、代价、删除原图坐标、中间尺寸） |
| POST | `/api/reports/:id/replay` | 独立重放 + 逐像素/映射/保护核验 |
| POST | `/api/reports/compare` | 版本比较（`{reportIdA, reportIdB}`） |
| GET | `/api/reports/:id/export?format=json\|pgm` | 导出最终图为 JSON 或文本 PGM(P2) |

`/api/carve` 请求体示例：

```json
{
  "pixels": [[10,20,30,40],[10,20,30,40],[10,20,30,40]],
  "protectMask": [[0,0,1,0],[0,0,1,0],[0,0,1,0]],
  "priorityMask": [[1,0,0,0],[1,0,0,0],[1,0,0,0]],
  "targetWidth": 2,
  "targetHeight": 2,
  "order": "width-first",
  "energyConfig": { "boundary": "replicate", "priorityWeight": 50 }
}
```

快速调用：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/limits
$r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/carve -ContentType 'application/json' -Body (Get-Content req.json -Raw)
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/reports/$($r.reportId)/replay"
```

## CLI

```powershell
node --experimental-sqlite dist/src/cli/index.js import --json image.json --protect protect.json --priority priority.json
node --experimental-sqlite dist/src/cli/index.js import --pgm image.pgm
node --experimental-sqlite dist/src/cli/index.js energy --image <imageId> --boundary zero
node --experimental-sqlite dist/src/cli/index.js seam --image <imageId> --direction vertical
node --experimental-sqlite dist/src/cli/index.js carve --image <imageId> --to 3x2 --order width-first --priority-weight 50
node --experimental-sqlite dist/src/cli/index.js replay <reportId>
node --experimental-sqlite dist/src/cli/index.js report <reportId>
node --experimental-sqlite dist/src/cli/index.js compare <reportIdA> <reportIdB>
node --experimental-sqlite dist/src/cli/index.js export <reportId> --pgm out.pgm
node --experimental-sqlite dist/src/cli/index.js list
```

文本 PGM 使用标准 **P2**（ASCII、`maxval=255`、支持 `#` 注释）；掩膜在 JSON 中以 0/1 二维数组提供。

## 持久化与幂等

- 数据文件：`<SEAMCARVE_DATA>/seamcarve.db`（SQLite，WAL 模式）。
- 输入冻结：图像按“像素+两掩膜”的 SHA-256 去重；重复导入返回同一 `imageId`。
- 操作冻结与幂等：`(imageId, 目标宽高, 顺序, 能量配置)` 哈希相同即返回同一 `reportId` 与同一份报告。
- 原子性：先在内存完成全部接缝计算，成功后在单事务中写库；被保护阻断时根本不写，不留半份结果；源输入永不被修改。
- 重启可复核：报告、每步接缝、最终像素与坐标映射都在库中，重启后可再次重放逐像素核对（`npm run demo` 已演示）。

## 目录结构

```
src/
  types.ts            类型、上限、错误类型
  core/seam.ts        能量、DP 接缝搜索（含转置/平局规则）、单步删除与映射
  core/carve.ts       输入校验、多步缩小编排（两种顺序）、报告
  core/replay.ts      独立重放、逐像素比较、保护核验
  core/pgm.ts         P2 PGM 解析/生成
  store/store.ts      SQLite 持久化（冻结、幂等、事务）
  service.ts          API/CLI 共用业务编排
  server.ts           原生 node:http JSON API
  cli/index.ts        CLI
  *.test.ts           node:test 测试
scripts/demo.ts       端到端演示
```

## 已覆盖的测试

常量图、梯度/细线图案、负代价偏好吸引路径、单行/单列、保护完全阻断、小矩阵**穷举全部合法接缝**核对 DP 最小值与平局路径、掩膜冲突与越界校验、每步尺寸、像素→原图坐标映射、保护像素零丢失、水平接缝与转置对应、重放逐像素一致、越界/断裂接缝被拒绝、两种顺序差异、版本比较、重复请求幂等、**重启后复核原报告**。

## 已知限制

- 只缩小、单通道 8 位灰度；不支持彩色、放大、旋转或交互式接缝编辑。
- 目标尺寸在启动时校验但受上限保护；超大图主要受内存与 DP 的 O(H·W) 时间约束。
- `node:sqlite` 在当前 Node 版本带实验性警告（需 `--experimental-sqlite`），API 未来可能随 Node 版本调整。
