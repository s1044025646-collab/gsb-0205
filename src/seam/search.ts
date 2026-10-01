import type { BlockReason, Image, Seam, SeamOrientation, SeamSearchResult } from '../types.js';
import { computeEnergy } from './energy.js';

/**
 * 动态规划最小代价接缝搜索（自行实现，无第三方 seam carving 库）。
 *
 * 垂直接缝：每行恰好一个像素，相邻行列差 ≤ 1，共 height 个像素。
 *   dp[r][c] = energy[r][c] + min(dp[r-1][c-1], dp[r-1][c], dp[r-1][c+1])
 * 水平接缝：对图像概念转置后按同一规则处理（每列一个像素，相邻行差 ≤ 1）。
 *
 * 平局确定性规则（公开承诺）：
 *   父代代价相等时，固定优先顺序为 左上/上左 → 正上 → 右上/上右
 *   （即优先选择“路径位置更靠左”的父代）；首行等价地从最左列开始扫描。
 *   因此同一张图、同一配置永远得到同一条接缝，不依赖 Map/对象遍历顺序。
 *
 * 保护像素在能量中为 Infinity：任何经过保护像素的路径代价都是 Infinity，
 * 不会被选中；不存在有限代价路径时返回阻塞原因，绝不降低保护强度。
 */

interface DpOutcome {
  path: number[];
  cost: number;
  feasible: boolean;
  blockReason?: BlockReason;
}

/**
 * 在 rows×cols 的能量网格上搜索跨全部 rows 行的路径。
 * path[r] 为第 r 行选择的列；横向移动限制 ±1。
 * fullLineCode：某一整行都不可通行时的原因（用于区分行/列语义）。
 */
function runDp(
  energy: number[][],
  rows: number,
  cols: number,
  fullLineCode: BlockReason['code'],
  lineLabel: 'row' | 'column',
): DpOutcome {
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols));
  const parent: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));

  for (let c = 0; c < cols; c++) {
    dp[0]![c] = energy[0]![c]!;
  }

  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const here = energy[r]![c]!;
      // 固定优先顺序：c-1（左上）→ c（正上）→ c+1（右上），平局自然由扫描顺序保证。
      const candidates: Array<[number, number]> = [];
      if (c - 1 >= 0) candidates.push([c - 1, dp[r - 1]![c - 1]!]);
      candidates.push([c, dp[r - 1]![c]!]);
      if (c + 1 < cols) candidates.push([c + 1, dp[r - 1]![c + 1]!]);

      let bestParent = candidates[0]![0];
      let bestCost = candidates[0]![1];
      for (let k = 1; k < candidates.length; k++) {
        const [pc, pcCost] = candidates[k]!;
        if (pcCost < bestCost) {
          bestCost = pcCost;
          bestParent = pc;
        }
      }
      parent[r]![c] = bestParent;
      dp[r]![c] = here === Number.POSITIVE_INFINITY || bestCost === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : here + bestCost;
    }
  }

  // 末行选择全局最小，平局取最左列。
  let endCol = -1;
  let endCost = Number.POSITIVE_INFINITY;
  for (let c = 0; c < cols; c++) {
    if (dp[rows - 1]![c]! < endCost) {
      endCost = dp[rows - 1]![c]!;
      endCol = c;
    }
  }

  if (endCol === -1 || endCost === Number.POSITIVE_INFINITY) {
    // 定位第一行“整行都不可通行”的位置，给出最直观的阻塞点。
    for (let r = 0; r < rows; r++) {
      let reachable = 0;
      const blockedLocations: Array<[number, number]> = [];
      for (let c = 0; c < cols; c++) {
        if (dp[r]![c]! !== Number.POSITIVE_INFINITY) reachable++;
        else blockedLocations.push([r, c]);
      }
      if (reachable === 0) {
        const allProtected = blockedLocations.every(([br, bc]) => energy[br]![bc] === Number.POSITIVE_INFINITY);
        const code = allProtected && blockedLocations.length === cols ? fullLineCode : 'PROTECTED_BARRIER';
        return {
          path: [],
          cost: Number.POSITIVE_INFINITY,
          feasible: false,
          blockReason: {
            code,
            message:
              code === fullLineCode
                ? `${lineLabel === 'row' ? '第' : '第'} ${r} ${lineLabel === 'row' ? '行' : '列'}的所有像素均受保护，不存在可行接缝`
                : `受保护像素在第 ${r} ${lineLabel === 'row' ? '行' : '列'}形成屏障，接缝无法从顶到底连通`,
            locations: blockedLocations.slice(0, 50),
          },
        };
      }
    }
    return {
      path: [],
      cost: Number.POSITIVE_INFINITY,
      feasible: false,
      blockReason: {
        code: 'PROTECTED_BARRIER',
        message: '受保护像素阻断了全部合法接缝',
        locations: [],
      },
    };
  }

  const path = new Array<number>(rows);
  let cur = endCol;
  for (let r = rows - 1; r >= 0; r--) {
    path[r] = cur;
    if (r > 0) cur = parent[r]![cur]!;
  }
  return { path, cost: endCost, feasible: true };
}

export function findSeam(image: Image, orientation: SeamOrientation, energy?: number[][]): SeamSearchResult {
  const e = energy ?? computeEnergy(image, {
    gradient: 'l1',
    boundary: 'zero',
    preferWeight: 0,
    protectCost: Number.POSITIVE_INFINITY,
  });

  if (orientation === 'vertical') {
    const out = runDp(e, image.height, image.width, 'PROTECTED_FULL_ROW', 'row');
    if (!out.feasible) {
      return { seam: { orientation, path: [] }, cost: Infinity, feasible: false, blockReason: out.blockReason };
    }
    return { seam: { orientation, path: out.path }, cost: out.cost, feasible: true };
  }

  // 水平接缝：概念转置。转置网格 transE[c][r] = energy[r][c]，
  // 搜索得到的 path[c] 即第 c 列经过的行号。
  const transE: number[][] = Array.from({ length: image.width }, () => new Array<number>(image.height));
  for (let r = 0; r < image.height; r++) {
    for (let c = 0; c < image.width; c++) {
      transE[c]![r] = e[r]![c]!;
    }
  }
  const out = runDp(transE, image.width, image.height, 'PROTECTED_FULL_COLUMN', 'column');
  if (!out.feasible) {
    return { seam: { orientation, path: [] }, cost: Infinity, feasible: false, blockReason: out.blockReason };
  }
  return { seam: { orientation, path: out.path }, cost: out.cost, feasible: true };
}
