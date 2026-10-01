import { AppError } from '../errors.js';
import type { Image, Matrix, OriginCell, OriginGrid, Seam } from '../types.js';

/**
 * 独立核验接缝合法性：越界、断裂、与当时尺寸不符一律拒绝。
 * vertical: path 长度 = height，path[r] ∈ [0,width)，相邻列差 ≤ 1。
 * horizontal: path 长度 = width，path[c] ∈ [0,height)，相邻行差 ≤ 1。
 */
export function validateSeamAgainstImage(seam: Seam, image: Image): void {
  const { path, orientation } = seam;
  if (orientation === 'vertical') {
    if (path.length !== image.height) {
      throw new AppError(
        'SEAM_LENGTH_MISMATCH',
        `垂直接缝长度 ${path.length} 与当前高度 ${image.height} 不符`,
        422,
      );
    }
    for (let r = 0; r < path.length; r++) {
      const c = path[r]!;
      if (!Number.isInteger(c) || c < 0 || c >= image.width) {
        throw new AppError('SEAM_OUT_OF_BOUNDS', `垂直接缝第 ${r} 行位置 ${c} 越界（宽 ${image.width}）`, 422);
      }
      if (r > 0 && Math.abs(c - path[r - 1]!) > 1) {
        throw new AppError('SEAM_BROKEN', `垂直接缝在第 ${r - 1}→${r} 行断裂：列 ${path[r - 1]}→${c}`, 422);
      }
    }
    return;
  }

  if (path.length !== image.width) {
    throw new AppError(
      'SEAM_LENGTH_MISMATCH',
      `水平接缝长度 ${path.length} 与当前宽度 ${image.width} 不符`,
      422,
    );
  }
  for (let c = 0; c < path.length; c++) {
    const r = path[c]!;
    if (!Number.isInteger(r) || r < 0 || r >= image.height) {
      throw new AppError('SEAM_OUT_OF_BOUNDS', `水平接缝第 ${c} 列位置 ${r} 越界（高 ${image.height}）`, 422);
    }
    if (c > 0 && Math.abs(r - path[c - 1]!) > 1) {
      throw new AppError('SEAM_BROKEN', `水平接缝在第 ${c - 1}→${c} 列断裂：行 ${path[c - 1]}→${r}`, 422);
    }
  }
}

export interface RemovedCell {
  r: number;
  c: number;
  origin: OriginCell;
  pixel: number;
  protected: boolean;
  preferDelete: boolean;
}

/**
 * 删除接缝并返回新图像（不可变式：构造新矩阵，不改写源对象）。
 * 同步收缩 protect / preferDelete 掩膜与 origin 坐标映射。
 * 若接缝碰到受保护像素直接拒绝——调用方正常流程不会出现（搜索已排除），
 * 这里是回放与外部提交接缝时的最终防线。
 */
export function removeSeam(image: Image, seam: Seam): { image: Image; removed: RemovedCell[] } {
  validateSeamAgainstImage(seam, image);
  const removed: RemovedCell[] = [];

  if (seam.orientation === 'vertical') {
    const newWidth = image.width - 1;
    if (newWidth < 1) {
      throw new AppError('DIMENSION_TOO_SMALL', '删除后宽度将小于 1', 422);
    }
    const matrix: Matrix = [];
    const protect: Matrix = [];
    const preferDelete: Matrix = [];
    const origin: OriginGrid = [];
    for (let r = 0; r < image.height; r++) {
      const cut = seam.path[r]!;
      if (image.protect[r]![cut] === 1) {
        throw new AppError(
          'PROTECTED_PIXEL_ON_SEAM',
          `拒绝删除：接缝经过受保护像素 (${r},${cut})。保护强度不可降低。`,
          422,
        );
      }
      removed.push({
        r,
        c: cut,
        origin: image.origin[r]![cut]!,
        pixel: image.matrix[r]![cut]!,
        protected: false,
        preferDelete: image.preferDelete[r]![cut] === 1,
      });
      matrix.push(image.matrix[r]!.filter((_, c) => c !== cut));
      protect.push(image.protect[r]!.filter((_, c) => c !== cut));
      preferDelete.push(image.preferDelete[r]!.filter((_, c) => c !== cut));
      origin.push(image.origin[r]!.filter((_, c) => c !== cut));
    }
    return { image: { width: newWidth, height: image.height, matrix, protect, preferDelete, origin }, removed };
  }

  const newHeight = image.height - 1;
  if (newHeight < 1) {
    throw new AppError('DIMENSION_TOO_SMALL', '删除后高度将小于 1', 422);
  }
  const matrix: Matrix = Array.from({ length: newHeight }, () => new Array<number>(image.width));
  const protect: Matrix = Array.from({ length: newHeight }, () => new Array<number>(image.width).fill(0));
  const preferDelete: Matrix = Array.from({ length: newHeight }, () => new Array<number>(image.width).fill(0));
  const origin: OriginGrid = Array.from({ length: newHeight }, () => new Array<OriginCell>(image.width));
  for (let c = 0; c < image.width; c++) {
    const cut = seam.path[c]!;
    if (image.protect[cut]![c] === 1) {
      throw new AppError(
        'PROTECTED_PIXEL_ON_SEAM',
        `拒绝删除：接缝经过受保护像素 (${cut},${c})。保护强度不可降低。`,
        422,
      );
    }
    removed.push({
      r: cut,
      c,
      origin: image.origin[cut]![c]!,
      pixel: image.matrix[cut]![c]!,
      protected: false,
      preferDelete: image.preferDelete[cut]![c] === 1,
    });
    let writeRow = 0;
    for (let r = 0; r < image.height; r++) {
      if (r === cut) continue;
      matrix[writeRow]![c] = image.matrix[r]![c]!;
      protect[writeRow]![c] = image.protect[r]![c]!;
      preferDelete[writeRow]![c] = image.preferDelete[r]![c]!;
      origin[writeRow]![c] = image.origin[r]![c]!;
      writeRow++;
    }
  }
  return { image: { width: image.width, height: newHeight, matrix, protect, preferDelete, origin }, removed };
}
