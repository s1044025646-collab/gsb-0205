import {
  BlockedError,
  EnergyConfig,
  Seam,
  SeamDirection,
  StepRecord,
} from "../types.js";

/**
 * 能量与接缝搜索（全部自行实现，无第三方 seam carving 库）。
 *
 * 能量定义（L1 梯度）：
 *   E(r,c) = | down - up | + | right - left |
 * 边界外像素取值由 boundary 决定：
 *   replicate：复制最近边界像素（边界处差分常为 0）；
 *   zero：边界外视为 0。
 * 优先删除掩膜：E'(r,c) = E(r,c) - priorityWeight * priorityMask[r][c]。
 * 保护掩膜：保护像素不可位于接缝上（DP 中代价置为 +Infinity，硬约束，绝不放松）。
 *
 * 垂直接缝：每行恰好一个像素 seam[r]，|seam[r]-seam[r-1]| <= 1。
 * DP：M[r][c] = E'[r][c] + min(M[r-1][c-1], M[r-1][c], M[r-1][c+1])。
 * 确定性平局规则（重要、对外公开）：
 *   1) 起点行（第 0 行）代价相同取“列号最小”者；
 *   2) 向上回溯时三个父节点（c-1、c、c+1）代价相同，按 c-1、c、c+1 的顺序取最先者
 *      （即整体偏向更靠左的路径）；
 *   3) 水平接缝通过转置复用同一规则，转置坐标下“列号更小”对应原图“行号更小”。
 * 因此相同输入永远产生相同接缝，且结果不依赖对象键遍历顺序。
 */

const INF = Number.POSITIVE_INFINITY;

export function transpose(matrix: number[][]): number[][] {
  const h = matrix.length;
  const w = h === 0 ? 0 : (matrix[0]?.length ?? 0);
  const out: number[][] = Array.from({ length: w }, () => new Array<number>(h));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      out[c]![r] = matrix[r]![c]!;
    }
  }
  return out;
}

export function computeEnergy(
  pixels: number[][],
  priorityMask: number[][] | undefined,
  config: EnergyConfig,
): number[][] {
  const h = pixels.length;
  const w = h === 0 ? 0 : (pixels[0]?.length ?? 0);
  const energy: number[][] = Array.from({ length: h }, () =>
    new Array<number>(w),
  );

  const at = (r: number, c: number): number => {
    if (r < 0 || r >= h || c < 0 || c >= w) {
      if (config.boundary === "zero") return 0;
      const rr = Math.min(h - 1, Math.max(0, r));
      const cc = Math.min(w - 1, Math.max(0, c));
      return pixels[rr]![cc]!;
    }
    return pixels[r]![c]!;
  };

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = Math.abs(at(r + 1, c) - at(r - 1, c));
      const horiz = Math.abs(at(r, c + 1) - at(r, c - 1));
      let e = v + horiz;
      if (priorityMask && priorityMask[r]![c] === 1 && config.priorityWeight > 0) {
        e -= config.priorityWeight;
      }
      energy[r]![c] = e;
    }
  }
  return energy;
}

/**
 * 在给定能量矩阵上搜索垂直接缝。
 * blocked 矩阵（0/1）标记硬约束不可删除像素。
 */
export function findVerticalSeam(
  energy: number[][],
  blocked: number[][],
): Seam {
  const h = energy.length;
  const w = h === 0 ? 0 : (energy[0]?.length ?? 0);
  if (h === 0 || w === 0) {
    return { direction: "vertical", path: [], cost: 0, blocked: true, blockReason: "空图像，不存在接缝" };
  }

  const dp: Float64Array[] = [];
  const parent: Int32Array[] = [];

  const first = new Float64Array(w);
  const firstParent = new Int32Array(w).fill(-1);
  for (let c = 0; c < w; c++) {
    first[c] = blocked[0]![c] === 1 ? INF : energy[0]![c]!;
  }
  dp.push(first);
  parent.push(firstParent);

  for (let r = 1; r < h; r++) {
    const row = new Float64Array(w);
    const par = new Int32Array(w);
    for (let c = 0; c < w; c++) {
      if (blocked[r]![c] === 1) {
        row[c] = INF;
        par[c] = -1;
        continue;
      }
      // 平局优先级固定：c-1 -> c -> c+1（先比较 -1，再 0，再 +1，严格 < 才更新）
      let bestCol = c - 1;
      let bestVal = c - 1 >= 0 ? dp[r - 1]![c - 1]! : INF;
      const straight = dp[r - 1]![c]!;
      if (straight < bestVal) {
        bestVal = straight;
        bestCol = c;
      }
      if (c + 1 < w) {
        const right = dp[r - 1]![c + 1]!;
        if (right < bestVal) {
          bestVal = right;
          bestCol = c + 1;
        }
      }
      row[c] = bestVal === INF ? INF : bestVal + energy[r]![c]!;
      par[c] = bestCol;
    }
    dp.push(row);
    parent.push(par);
  }

  // 终点：代价最小，平局取列号最小（从左向右扫描，严格 < 才更新）
  let endCol = 0;
  let endCost = dp[h - 1]![0]!;
  for (let c = 1; c < w; c++) {
    if (dp[h - 1]![c]! < endCost) {
      endCost = dp[h - 1]![c]!;
      endCol = c;
    }
  }
  if (endCost === INF) {
    return {
      direction: "vertical",
      path: [],
      cost: NaN,
      blocked: true,
      blockReason:
        "保护掩膜完全阻断：不存在一条从顶到底、每行一个且相邻列差不超过 1 的合法接缝（保护强度未被放松）",
    };
  }

  const path = new Array<number>(h);
  let col = endCol;
  for (let r = h - 1; r >= 0; r--) {
    path[r] = col;
    if (r > 0) col = parent[r]![col]!;
  }
  return { direction: "vertical", path, cost: endCost, blocked: false };
}

/** 水平接缝：转置后搜索，再把转置坐标（行）映射回原图的行号。 */
export function findHorizontalSeam(
  energy: number[][],
  blocked: number[][],
): Seam {
  const tEnergy = transpose(energy);
  const tBlocked = transpose(blocked);
  const tSeam = findVerticalSeam(tEnergy, tBlocked);
  if (tSeam.blocked) {
    return {
      direction: "horizontal",
      path: [],
      cost: NaN,
      blocked: true,
      blockReason:
        "保护掩膜完全阻断：不存在一条从左到右、每列一个且相邻行差不超过 1 的合法水平接缝（保护强度未被放松）",
    };
  }
  return { direction: "horizontal", path: tSeam.path, cost: tSeam.cost, blocked: false };
}

export function findSeam(
  direction: SeamDirection,
  pixels: number[][],
  protectMask: number[][] | undefined,
  priorityMask: number[][] | undefined,
  config: EnergyConfig,
): { seam: Seam; energy: number[][] } {
  const energy = computeEnergy(pixels, priorityMask, config);
  const h = pixels.length;
  const w = h === 0 ? 0 : (pixels[0]?.length ?? 0);
  const blocked =
    protectMask ??
    Array.from({ length: h }, () => new Array<number>(w).fill(0));
  const seam =
    direction === "vertical"
      ? findVerticalSeam(energy, blocked)
      : findHorizontalSeam(energy, blocked);
  return { seam, energy };
}

/**
 * 从矩阵的每一行（垂直接缝）删除指定列，或每一列（水平接缝）删除指定行。
 * 返回删除后矩阵，不修改入参。
 */
export function removeVerticalSeam<T>(matrix: T[][], seam: number[]): T[][] {
  return matrix.map((row, r) => row.filter((_, c) => c !== seam[r]));
}

export function removeHorizontalSeam<T>(matrix: T[][], seam: number[]): T[][] {
  const h = matrix.length;
  const w = h === 0 ? 0 : (matrix[0]?.length ?? 0);
  // 每一列独立删除该列指定的行；按列过滤后再转置回行主序，避免不同列删除不同行时错位。
  const columns: T[][] = Array.from({ length: w }, () => new Array<T>(h - 1));
  for (let c = 0; c < w; c++) {
    const removeRow = seam[c]!;
    let tr = 0;
    for (let r = 0; r < h; r++) {
      if (r === removeRow) continue;
      columns[c]![tr] = matrix[r]![c]!;
      tr++;
    }
  }
  const out: T[][] = Array.from({ length: h - 1 }, () => new Array<T>(w));
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w; c++) out[r]![c] = columns[c]![r]!;
  }
  return out;
}

/** 单步删除：更新像素、两个掩膜和原始坐标映射，产出一步记录。 */
export function applyOneStep(
  stepIndex: number,
  direction: SeamDirection,
  seam: Seam,
  pixels: number[][],
  protectMask: number[][],
  priorityMask: number[][],
  coordMap: Array<Array<[number, number]>>,
): {
  pixels: number[][];
  protectMask: number[][];
  priorityMask: number[][];
  coordMap: Array<Array<[number, number]>>;
  record: StepRecord;
} {
  if (seam.blocked) throw new BlockedError(seam.blockReason ?? "无可行接缝");
  const h = pixels.length;
  const w = pixels[0]!.length;
  const sizeBefore: [number, number] = [w, h];

  const removedPixels: Array<[number, number]> = [];
  const removedOriginalPixels: Array<[number, number]> = [];
  if (direction === "vertical") {
    for (let r = 0; r < h; r++) removedPixels.push([r, seam.path[r]!]);
  } else {
    for (let c = 0; c < w; c++) removedPixels.push([seam.path[c]!, c]);
  }
  for (const [r, c] of removedPixels) {
    removedOriginalPixels.push(coordMap[r]![c]!);
  }

  if (direction === "vertical") {
    return {
      pixels: removeVerticalSeam(pixels, seam.path),
      protectMask: removeVerticalSeam(protectMask, seam.path),
      priorityMask: removeVerticalSeam(priorityMask, seam.path),
      coordMap: removeVerticalSeam(coordMap, seam.path),
      record: {
        stepIndex,
        direction,
        path: seam.path.slice(),
        cost: seam.cost,
        removedPixels,
        removedOriginalPixels,
        sizeBefore,
        sizeAfter: [w - 1, h],
      },
    };
  }
  return {
    pixels: removeHorizontalSeam(pixels, seam.path),
    protectMask: removeHorizontalSeam(protectMask, seam.path),
    priorityMask: removeHorizontalSeam(priorityMask, seam.path),
    coordMap: removeHorizontalSeam(coordMap, seam.path),
    record: {
      stepIndex,
      direction,
      path: seam.path.slice(),
      cost: seam.cost,
      removedPixels,
      removedOriginalPixels,
      sizeBefore,
      sizeAfter: [w, h - 1],
    },
  };
}
