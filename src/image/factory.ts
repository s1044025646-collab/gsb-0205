import type { Image, Matrix, OriginGrid } from '../types.js';

function identityOrigin(width: number, height: number): OriginGrid {
  const origin: OriginGrid = [];
  for (let r = 0; r < height; r++) {
    const row = [];
    for (let c = 0; c < width; c++) row.push([r, c] as [number, number]);
    origin.push(row);
  }
  return origin;
}

/** 以输入矩阵构造图像；缺省掩膜补零，origin 初始化为恒等映射（当前像素即原图像素）。 */
export function createImage(
  width: number,
  height: number,
  matrix: Matrix,
  protect?: Matrix,
  preferDelete?: Matrix,
): Image {
  return {
    width,
    height,
    matrix,
    protect: protect ?? Array.from({ length: height }, () => Array<number>(width).fill(0)),
    preferDelete: preferDelete ?? Array.from({ length: height }, () => Array<number>(width).fill(0)),
    origin: identityOrigin(width, height),
  };
}
