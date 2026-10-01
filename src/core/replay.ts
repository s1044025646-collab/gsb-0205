import { ReplayMismatchError, StepRecord } from "../types.js";
import {
  removeHorizontalSeam,
  removeVerticalSeam,
} from "./seam.js";
import { initCoordMap } from "./carve.js";

/**
 * 用已保存接缝独立重放。
 * 仅依据 steps 中的 path 与 sizeBefore/sizeAfter，从原始输入重新删除，
 * 不读取当时计算出的像素，因此可作为独立核验。
 * 任何接缝越界、断裂（相邻位置差 > 1）、重复/长度不符、与当时尺寸不符，
 * 都会拒绝并抛出 ReplayMismatchError；不会返回半成品。
 */
export function replaySteps(params: {
  originalPixels: number[][];
  steps: Pick<
    StepRecord,
    "direction" | "path" | "sizeBefore" | "sizeAfter"
  >[];
}): {
  pixels: number[][];
  coordMap: Array<Array<[number, number]>>;
} {
  let pixels = params.originalPixels.map((row) => row.slice());
  let coordMap = initCoordMap(
    params.originalPixels.length,
    params.originalPixels[0]!.length,
  );

  params.steps.forEach((step, i) => {
    const h = pixels.length;
    const w = pixels[0]!.length;
    if (step.sizeBefore[0] !== w || step.sizeBefore[1] !== h) {
      throw new ReplayMismatchError(
        `第 ${i + 1} 步尺寸不符：记录删除前为 ${step.sizeBefore[0]}x${step.sizeBefore[1]}，实际为 ${w}x${h}`,
      );
    }

    if (step.direction === "vertical") {
      if (step.path.length !== h) {
        throw new ReplayMismatchError(
          `第 ${i + 1} 步垂直接缝长度 ${step.path.length} 不等于图像高度 ${h}`,
        );
      }
      if (step.sizeAfter[0] !== w - 1 || step.sizeAfter[1] !== h) {
        throw new ReplayMismatchError(`第 ${i + 1} 步删除后尺寸记录错误`);
      }
      let prev: number | null = null;
      for (let r = 0; r < h; r++) {
        const c = step.path[r]!;
        if (!Number.isInteger(c) || c < 0 || c >= w) {
          throw new ReplayMismatchError(
            `第 ${i + 1} 步接缝在第 ${r} 行列值 ${c} 越界（宽度 ${w}）`,
          );
        }
        if (prev !== null && Math.abs(c - prev) > 1) {
          throw new ReplayMismatchError(
            `第 ${i + 1} 步接缝在第 ${r} 行断裂：${prev} -> ${c}，列差超过 1`,
          );
        }
        prev = c;
      }
      pixels = removeVerticalSeam(pixels, step.path);
      coordMap = removeVerticalSeam(coordMap, step.path);
    } else {
      if (step.path.length !== w) {
        throw new ReplayMismatchError(
          `第 ${i + 1} 步水平接缝长度 ${step.path.length} 不等于图像宽度 ${w}`,
        );
      }
      if (step.sizeAfter[0] !== w || step.sizeAfter[1] !== h - 1) {
        throw new ReplayMismatchError(`第 ${i + 1} 步删除后尺寸记录错误`);
      }
      let prev: number | null = null;
      for (let c = 0; c < w; c++) {
        const r = step.path[c]!;
        if (!Number.isInteger(r) || r < 0 || r >= h) {
          throw new ReplayMismatchError(
            `第 ${i + 1} 步接缝在第 ${c} 列行值 ${r} 越界（高度 ${h}）`,
          );
        }
        if (prev !== null && Math.abs(r - prev) > 1) {
          throw new ReplayMismatchError(
            `第 ${i + 1} 步接缝在第 ${c} 列断裂：${prev} -> ${r}，行差超过 1`,
          );
        }
        prev = r;
      }
      pixels = removeHorizontalSeam(pixels, step.path);
      coordMap = removeHorizontalSeam(coordMap, step.path);
    }
  });

  return { pixels, coordMap };
}

/** 逐像素比较两个矩阵是否一致。 */
export function pixelsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r]!.length !== b[r]!.length) return false;
    for (let c = 0; c < a[r]!.length; c++) {
      if (a[r]![c] !== b[r]![c]) return false;
    }
  }
  return true;
}

/** 找出首个不一致像素坐标（用于报告）。 */
export function firstMismatch(
  a: number[][],
  b: number[][],
): { r: number; c: number; expected: number; actual: number } | null {
  const rows = Math.max(a.length, b.length);
  for (let r = 0; r < rows; r++) {
    const ra = a[r] ?? [];
    const rb = b[r] ?? [];
    const cols = Math.max(ra.length, rb.length);
    for (let c = 0; c < cols; c++) {
      if (ra[c] !== rb[c]) {
        return { r, c, expected: ra[c] ?? NaN, actual: rb[c] ?? NaN };
      }
    }
  }
  return null;
}

/**
 * 保护区域核验：重放后，原保护像素一个都不得出现在删除集合中。
 * 返回被删除的保护原始像素列表（为空表示通过）。
 */
export function verifyProtectedKept(params: {
  originalProtectMask: number[][];
  removedOriginalPixels: Array<[number, number]>;
}): { kept: boolean; violated: Array<[number, number]> } {
  const violated: Array<[number, number]> = [];
  for (const [r, c] of params.removedOriginalPixels) {
    if (params.originalProtectMask[r]?.[c] === 1) violated.push([r, c]);
  }
  return { kept: violated.length === 0, violated };
}
