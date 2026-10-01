import { AppError } from '../errors.js';
import { LIMITS, type EnergyConfig, type Matrix, type OriginGrid } from '../types.js';

function isInteger2D(value: unknown): value is Matrix {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length > 0 &&
        row.every((v) => typeof v === 'number' && Number.isInteger(v)),
    )
  );
}

/** 校验灰度矩阵的尺寸与像素范围，返回归一化后的宽高。 */
export function validateMatrix(matrix: unknown, label = 'matrix'): { width: number; height: number } {
  if (!isInteger2D(matrix)) {
    throw new AppError('INVALID_MATRIX', `${label} 必须是非空二维整数数组`);
  }
  const height = matrix.length;
  const width = matrix[0]!.length;
  if (width > LIMITS.MAX_DIMENSION || height > LIMITS.MAX_DIMENSION) {
    throw new AppError(
      'DIMENSION_EXCEEDED',
      `宽/高不得超过 ${LIMITS.MAX_DIMENSION}（收到 ${width}x${height}）`,
      422,
      { maxDimension: LIMITS.MAX_DIMENSION },
    );
  }
  if (width * height > LIMITS.MAX_PIXELS) {
    throw new AppError(
      'TOO_MANY_PIXELS',
      `总像素数不得超过 ${LIMITS.MAX_PIXELS}（收到 ${width * height}）`,
      422,
    );
  }
  for (let r = 0; r < height; r++) {
    if (matrix[r]!.length !== width) {
      throw new AppError('RAGGED_MATRIX', `第 ${r} 行长度 ${matrix[r]!.length} 与首行 ${width} 不一致`);
    }
    for (let c = 0; c < width; c++) {
      const v = matrix[r]![c]!;
      if (v < 0 || v > LIMITS.MAX_PIXEL_VALUE) {
        throw new AppError(
          'PIXEL_OUT_OF_RANGE',
          `${label}[${r}][${c}]=${v} 超出 8 位灰度范围 [0,255]`,
          422,
        );
      }
    }
  }
  return { width, height };
}

/** 校验二值掩膜尺寸/取值，并检查与保护掩膜是否冲突。 */
export function validateMask(
  mask: unknown,
  width: number,
  height: number,
  label: string,
): Matrix {
  if (mask === undefined || mask === null) {
    return Array.from({ length: height }, () => Array<number>(width).fill(0));
  }
  if (!isInteger2D(mask)) {
    throw new AppError('INVALID_MASK', `${label} 必须是二维整数数组`);
  }
  if (mask.length !== height || mask[0]!.length !== width) {
    throw new AppError(
      'MASK_SIZE_MISMATCH',
      `${label} 尺寸 ${mask[0]!.length}x${mask.length} 与图像 ${width}x${height} 不一致`,
      422,
    );
  }
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const v = mask[r]![c]!;
      if (v !== 0 && v !== 1) {
        throw new AppError('MASK_VALUE_INVALID', `${label}[${r}][${c}]=${v}，只允许 0 或 1`, 422);
      }
    }
  }
  return mask as Matrix;
}

/** 两个掩膜在同一像素上同时为 1 视为相互冲突。 */
export function assertMasksNoConflict(protect: Matrix, preferDelete: Matrix, width: number, height: number): void {
  const conflicts: Array<[number, number]> = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (protect[r]![c] === 1 && preferDelete[r]![c] === 1) {
        conflicts.push([r, c]);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new AppError(
      'MASKS_CONFLICT',
      `有 ${conflicts.length} 个像素同时被标记为保护与优先删除，例如 ${JSON.stringify(conflicts[0])}`,
      422,
      { conflicts: conflicts.slice(0, 50), total: conflicts.length },
    );
  }
}

export function validateShrinkTargets(
  targetWidth: unknown,
  targetHeight: unknown,
  width: number,
  height: number,
): { targetWidth: number; targetHeight: number } {
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)) {
    throw new AppError('INVALID_TARGET', 'targetWidth/targetHeight 必须为整数');
  }
  const tw = targetWidth as number;
  const th = targetHeight as number;
  if (tw < LIMITS.MIN_DIMENSION || th < LIMITS.MIN_DIMENSION) {
    throw new AppError('TARGET_TOO_SMALL', `目标宽高都至少为 1（收到 ${tw}x${th}）`, 422);
  }
  if (tw > width || th > height) {
    throw new AppError(
      'UPSCALE_FORBIDDEN',
      `本服务只支持缩小：当前 ${width}x${height}，目标 ${tw}x${th}`,
      422,
    );
  }
  return { targetWidth: tw, targetHeight: th };
}

export function validateEnergyConfig(config: unknown): EnergyConfig {
  if (config === undefined || config === null || typeof config !== 'object') {
    throw new AppError('INVALID_ENERGY_CONFIG', 'energyConfig 必须是对象');
  }
  const cfg = config as Record<string, unknown>;
  const gradient = cfg.gradient === undefined ? 'l1' : cfg.gradient;
  const boundary = cfg.boundary === undefined ? 'zero' : cfg.boundary;
  const preferWeight = cfg.preferWeight === undefined ? 0 : cfg.preferWeight;
  if (gradient !== 'l1' && gradient !== 'horizontal' && gradient !== 'vertical') {
    throw new AppError('INVALID_GRADIENT', `未知梯度方式: ${String(gradient)}`);
  }
  if (boundary !== 'zero' && boundary !== 'replicate' && boundary !== 'wrap') {
    throw new AppError('INVALID_BOUNDARY', `未知边界策略: ${String(boundary)}`);
  }
  if (typeof preferWeight !== 'number' || !Number.isFinite(preferWeight) || preferWeight < 0) {
    throw new AppError('INVALID_PREFER_WEIGHT', 'preferWeight 必须是非负有限数值');
  }
  return { gradient, boundary, preferWeight, protectCost: Number.POSITIVE_INFINITY };
}

export function assertOriginGrid(origin: OriginGrid, width: number, height: number): void {
  if (origin.length !== height || origin.some((row) => row.length !== width)) {
    throw new AppError('INTERNAL_ORIGIN_MISMATCH', '像素来源映射尺寸与图像不一致');
  }
}
