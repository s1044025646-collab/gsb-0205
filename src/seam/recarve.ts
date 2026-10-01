import { AppError } from '../errors.js';
import type {
  EnergyConfig,
  Image,
  OperationOrder,
  OriginCell,
  ReplayResult,
  Seam,
  ShrinkReport,
  ShrinkStep,
} from '../types.js';
import { computeEnergy } from './energy.js';
import { findSeam } from './search.js';
import { removeSeam, validateSeamAgainstImage } from './remove.js';

export interface ShrinkPlan {
  targetWidth: number;
  targetHeight: number;
  order: OperationOrder;
}

function sameOrigin(a: OriginCell, b: OriginCell): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * 逐步贪心缩小：
 * 每删除一条接缝后，都在“当前图像”上重新计算能量再找下一条接缝；
 * 两种操作顺序决定先减宽还是先减高。
 *
 * 最优性边界（不夸大）：每一步是当时图像上的最小代价接缝（逐步最优），
 * 但接缝删除会改变后续能量场，因此这不是整个缩放序列的全局最优保证。
 */
export function shrink(
  start: Image,
  plan: ShrinkPlan,
  config: EnergyConfig,
  meta: { reportId: string; imageId: string; requestHash: string; createdAt: string },
): ShrinkReport {
  let current = start;
  const steps: ShrinkStep[] = [];
  const removeVerticalCount = start.width - plan.targetWidth;
  const removeHorizontalCount = start.height - plan.targetHeight;

  const sequence: Array<'vertical' | 'horizontal'> =
    plan.order === 'width-first'
      ? [
          ...Array.from({ length: removeVerticalCount }, () => 'vertical' as const),
          ...Array.from({ length: removeHorizontalCount }, () => 'horizontal' as const),
        ]
      : [
          ...Array.from({ length: removeHorizontalCount }, () => 'horizontal' as const),
          ...Array.from({ length: removeVerticalCount }, () => 'vertical' as const),
        ];

  let stepIndex = 0;
  for (const orientation of sequence) {
    const energy = computeEnergy(current, config);
    const result = findSeam(current, orientation, energy);
    if (!result.feasible) {
      throw new AppError(
        result.blockReason?.code ?? 'NO_FEASIBLE_SEAM',
        result.blockReason?.message ?? '无可行接缝',
        422,
        {
          stepIndex,
          orientation,
          currentWidth: current.width,
          currentHeight: current.height,
          blockReason: result.blockReason,
          completedSteps: steps,
        },
      );
    }
    const { image: next, removed } = removeSeam(current, result.seam);
    steps.push({
      stepIndex,
      orientation,
      seamPath: result.seam.path,
      cost: result.cost,
      resultingWidth: next.width,
      resultingHeight: next.height,
      removedOrigins: removed.map((cell) => cell.origin),
    });
    current = next;
    stepIndex++;
  }

  // 受保护原始像素的存活/删除核验。
  const protectedOrigins: OriginCell[] = [];
  for (let r = 0; r < start.height; r++) {
    for (let c = 0; c < start.width; c++) {
      if (start.protect[r]![c] === 1) protectedOrigins.push([r, c]);
    }
  }
  const survivingSet = new Set<string>();
  for (let r = 0; r < current.height; r++) {
    for (let c = 0; c < current.width; c++) {
      survivingSet.add(current.origin[r]![c]!.join(','));
    }
  }
  const survivingProtectedOrigins = protectedOrigins.filter((o) => survivingSet.has(o.join(',')));
  const removedProtectedOrigins = protectedOrigins.filter((o) => !survivingSet.has(o.join(',')));

  return {
    reportId: meta.reportId,
    imageId: meta.imageId,
    initialWidth: start.width,
    initialHeight: start.height,
    targetWidth: plan.targetWidth,
    targetHeight: plan.targetHeight,
    order: plan.order,
    energyConfig: config,
    steps,
    finalWidth: current.width,
    finalHeight: current.height,
    finalMatrix: current.matrix,
    finalOrigin: current.origin,
    finalProtect: current.protect,
    finalPreferDelete: current.preferDelete,
    survivingProtectedOrigins,
    removedProtectedOrigins,
    optimalityClaim: 'stepwise-greedy',
    createdAt: meta.createdAt,
    requestHash: meta.requestHash,
  };
}

/**
 * 用已保存的接缝序列在冻结的初始图像上独立重放：
 * - 逐步校验接缝长度、越界、断裂与当时尺寸；
 * - 逐步重新计算能量并核对当时选择的代价与记录代价（浮点精确相等）；
 * - 最终逐像素比对矩阵、尺寸、掩膜与像素来源映射。
 * 任何不一致都返回 ok=false 与原因列表；不抛出即代表数据完整可核。
 */
export function replayReport(start: Image, report: ShrinkReport): ReplayResult {
  const mismatches: string[] = [];
  let current = start;
  let checked = 0;

  if (report.initialWidth !== start.width || report.initialHeight !== start.height) {
    mismatches.push(
      `初始尺寸不符：报告 ${report.initialWidth}x${report.initialHeight}，图像 ${start.width}x${start.height}`,
    );
  }

  for (const step of report.steps) {
    const seam: Seam = { orientation: step.orientation, path: step.seamPath };
    try {
      validateSeamAgainstImage(seam, current);
    } catch (err) {
      mismatches.push(`步骤 ${step.stepIndex} 接缝非法：${(err as Error).message}`);
      break;
    }
    // 保护像素最终防线：若回放接缝经过保护像素也拒绝。
    let hitsProtected = false;
    if (step.orientation === 'vertical') {
      for (let r = 0; r < current.height; r++) {
        if (current.protect[r]![seam.path[r]!] === 1) hitsProtected = true;
      }
    } else {
      for (let c = 0; c < current.width; c++) {
        if (current.protect[seam.path[c]!]![c] === 1) hitsProtected = true;
      }
    }
    if (hitsProtected) {
      mismatches.push(`步骤 ${step.stepIndex} 接缝经过受保护像素，拒绝重放`);
      break;
    }

    const energy = computeEnergy(current, report.energyConfig);
    const search = findSeam(current, step.orientation, energy);
    if (!search.feasible || search.cost !== step.cost) {
      mismatches.push(
        `步骤 ${step.stepIndex} 代价不符：记录 ${step.cost}，重算 ${search.feasible ? search.cost : 'Infeasible'}`,
      );
    }

    const { image: next, removed } = removeSeam(current, seam);
    if (next.width !== step.resultingWidth || next.height !== step.resultingHeight) {
      mismatches.push(
        `步骤 ${step.stepIndex} 结果尺寸不符：重放 ${next.width}x${next.height}，记录 ${step.resultingWidth}x${step.resultingHeight}`,
      );
    }
    const removedKeys = removed.map((cell) => cell.origin.join(','));
    const recordedKeys = step.removedOrigins.map((o) => o.join(','));
    if (removedKeys.length !== recordedKeys.length || removedKeys.some((k, i) => k !== recordedKeys[i])) {
      mismatches.push(`步骤 ${step.stepIndex} 删除的原始像素坐标与记录不一致`);
    }
    current = next;
    checked++;
  }

  if (current.width !== report.finalWidth || current.height !== report.finalHeight) {
    mismatches.push(
      `最终尺寸不符：重放 ${current.width}x${current.height}，报告 ${report.finalWidth}x${report.finalHeight}`,
    );
  } else {
    for (let r = 0; r < current.height; r++) {
      for (let c = 0; c < current.width; c++) {
        if (current.matrix[r]![c] !== report.finalMatrix[r]![c]) {
          mismatches.push(`最终像素不一致：(${r},${c}) 重放 ${current.matrix[r]![c]}，报告 ${report.finalMatrix[r]![c]}`);
        }
        const o1 = current.origin[r]![c]!;
        const o2 = report.finalOrigin[r]![c]!;
        if (!sameOrigin(o1, o2)) mismatches.push(`最终来源映射不一致：(${r},${c})`);
        if (current.protect[r]![c] !== report.finalProtect[r]![c]) {
          mismatches.push(`最终保护掩膜不一致：(${r},${c})`);
        }
        if (current.preferDelete[r]![c] !== report.finalPreferDelete[r]![c]) {
          mismatches.push(`最终优先删除掩膜不一致：(${r},${c})`);
        }
      }
    }
  }

  if (report.removedProtectedOrigins.length !== 0) {
    mismatches.push(`报告自身记录了 ${report.removedProtectedOrigins.length} 个被删除的保护像素，违反硬约束`);
  }

  return {
    reportId: report.reportId,
    ok: mismatches.length === 0,
    mismatches,
    checkedSteps: checked,
    finalWidth: current.width,
    finalHeight: current.height,
  };
}
