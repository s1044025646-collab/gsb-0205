import type { BoundaryStrategy, EnergyConfig, Image, Matrix } from '../types.js';

/** 按边界策略取邻居灰度，越界处理完全显式且可公开说明。 */
function neighborGray(image: Image, r: number, c: number, boundary: BoundaryStrategy): number {
  const { width, height, matrix } = image;
  if (r >= 0 && r < height && c >= 0 && c < width) {
    return matrix[r]![c]!;
  }
  switch (boundary) {
    case 'zero':
      return 0;
    case 'replicate': {
      const rr = Math.min(Math.max(r, 0), height - 1);
      const cc = Math.min(Math.max(c, 0), width - 1);
      return matrix[rr]![cc]!;
    }
    case 'wrap': {
      const rr = ((r % height) + height) % height;
      const cc = ((c % width) + width) % width;
      return matrix[rr]![cc]!;
    }
  }
}

/**
 * 计算每像素能量：
 * - horizontal 梯度 = 与左右邻居差的绝对值之和
 * - vertical   梯度 = 与上下邻居差的绝对值之和
 * - l1（默认） = 两者之和
 * 再叠加掩膜代价：protect → Infinity；preferDelete → -preferWeight。
 */
export function computeEnergy(image: Image, config: EnergyConfig): Matrix {
  const { width, height } = image;
  const energy: Matrix = Array.from({ length: height }, () => new Array<number>(width).fill(0));
  const useH = config.gradient !== 'vertical';
  const useV = config.gradient !== 'horizontal';

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const center = image.matrix[r]![c]!;
      let value = 0;
      if (useH) {
        value += Math.abs(center - neighborGray(image, r, c - 1, config.boundary));
        value += Math.abs(center - neighborGray(image, r, c + 1, config.boundary));
      }
      if (useV) {
        value += Math.abs(center - neighborGray(image, r - 1, c, config.boundary));
        value += Math.abs(center - neighborGray(image, r + 1, c, config.boundary));
      }
      if (image.preferDelete[r]![c] === 1) {
        value -= config.preferWeight;
      }
      energy[r]![c] = value;
    }
  }
  // 保护像素单独最后置 Infinity，避免被偏好抵消。
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (image.protect[r]![c] === 1) {
        energy[r]![c] = Number.POSITIVE_INFINITY;
      }
    }
  }
  return energy;
}
