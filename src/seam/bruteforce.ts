import type { EnergyConfig, Image, SeamOrientation } from '../types.js';
import { computeEnergy } from './energy.js';

export interface BruteForceResult {
  minCost: number;
  /** 所有取得最小代价的合法接缝路径（按最左优先的确定性顺序）。 */
  bestPaths: number[][];
}

/**
 * 穷举全部合法接缝，仅供测试交叉核验动态规划。
 * 路径按“父代左上→正上→右上”的 DFS 顺序生成，因此平局时的第一条
 * 必须与 DP 在同一平局规则下选出的路径完全一致。
 */
export function bruteForceBestSeam(
  image: Image,
  orientation: SeamOrientation,
  config: EnergyConfig,
): BruteForceResult {
  const energy = computeEnergy(image, config);
  const rows = orientation === 'vertical' ? image.height : image.width;
  const cols = orientation === 'vertical' ? image.width : image.height;

  const cell = (r: number, c: number): number =>
    orientation === 'vertical' ? energy[r]![c]! : energy[c]![r]!;

  let minCost = Infinity;
  let bestPaths: number[][] = [];

  const walk = (r: number, path: number[], sum: number): void => {
    if (r === rows) {
      if (sum < minCost) {
        minCost = sum;
        bestPaths = [path.slice()];
      } else if (sum === minCost) {
        bestPaths.push(path.slice());
      }
      return;
    }
    if (r === 0) {
      for (let c = 0; c < cols; c++) walk(1, [c], cell(0, c));
      return;
    }
    const prev = path[r - 1]!;
    for (const dc of [-1, 0, 1]) {
      const c = prev + dc;
      if (c < 0 || c >= cols) continue;
      const value = cell(r, c);
      const nextSum = value === Infinity || sum === Infinity ? Infinity : sum + value;
      path.push(c);
      walk(r + 1, path, nextSum);
      path.pop();
    }
  };

  walk(0, [], 0);
  return { minCost, bestPaths };
}
