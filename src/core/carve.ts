import {
  CarveReport,
  EnergyConfig,
  LIMITS,
  Order,
  ValidationError,
} from "../types.js";
import {
  applyOneStep,
  findSeam,
} from "./seam.js";

/** 校验灰度矩阵与掩膜：尺寸、像素范围、掩膜冲突。全部通过返回规范化结果。 */
export function validateImageInput(input: {
  width?: number;
  height?: number;
  pixels?: number[][];
  protectMask?: number[][];
  priorityMask?: number[][];
}): {
  width: number;
  height: number;
  pixels: number[][];
  protectMask: number[][];
  priorityMask: number[][];
} {
  const { pixels, protectMask, priorityMask } = input;
  if (!Array.isArray(pixels) || pixels.length === 0) {
    throw new ValidationError("像素矩阵必须为非空二维数组");
  }
  const height = pixels.length;
  const width = pixels[0]!.length;
  if (!Number.isInteger(width) || width <= 0) {
    throw new ValidationError("图像宽度必须为正整数");
  }
  if (width > LIMITS.maxWidth) {
    throw new ValidationError(`宽度 ${width} 超过上限 ${LIMITS.maxWidth}`);
  }
  if (height > LIMITS.maxHeight) {
    throw new ValidationError(`高度 ${height} 超过上限 ${LIMITS.maxHeight}`);
  }
  if (width * height > LIMITS.maxPixels) {
    throw new ValidationError(
      `像素总数 ${width * height} 超过上限 ${LIMITS.maxPixels}`,
    );
  }
  for (let r = 0; r < height; r++) {
    const row = pixels[r]!;
    if (!Array.isArray(row) || row.length !== width) {
      throw new ValidationError(`第 ${r} 行长度与宽度 ${width} 不一致（出现锯齿矩阵）`);
    }
    for (let c = 0; c < width; c++) {
      const v = row[c];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new ValidationError(`像素 (${r},${c}) 不是 0..255 的整数`);
      }
    }
  }

  const checkMask = (mask: number[][] | undefined, name: string): number[][] => {
    if (mask === undefined) {
      return Array.from({ length: height }, () => new Array<number>(width).fill(0));
    }
    if (!Array.isArray(mask) || mask.length !== height) {
      throw new ValidationError(`${name} 行数必须等于图像高度 ${height}`);
    }
    for (let r = 0; r < height; r++) {
      if (!Array.isArray(mask[r]) || mask[r]!.length !== width) {
        throw new ValidationError(`${name} 第 ${r} 行长度必须等于宽度 ${width}`);
      }
      for (let c = 0; c < width; c++) {
        const v = mask[r]![c];
        if (v !== 0 && v !== 1) {
          throw new ValidationError(`${name} (${r},${c}) 必须为 0 或 1`);
        }
      }
    }
    return mask.map((row) => row.slice());
  };

  const protect = checkMask(protectMask, "保护掩膜");
  const priority = checkMask(priorityMask, "优先删除掩膜");
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (protect[r]![c] === 1 && priority[r]![c] === 1) {
        throw new ValidationError(
          `保护掩膜与优先删除掩膜在 (${r},${c}) 冲突：同一像素不能既受保护又被优先删除`,
        );
      }
    }
  }
  return { width, height, pixels: pixels.map((r) => r.slice()), protectMask: protect, priorityMask: priority };
}

export function validateTarget(
  width: number,
  height: number,
  currentWidth: number,
  currentHeight: number,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new ValidationError("目标宽高必须为整数");
  }
  if (width < 1 || height < 1) {
    throw new ValidationError("每个维度至少保留 1 个像素");
  }
  if (width > currentWidth || height > currentHeight) {
    throw new ValidationError(
      `本服务只支持缩小：目标 ${width}x${height} 不得大于当前 ${currentWidth}x${currentHeight}`,
    );
  }
}

export function validateEnergyConfig(config: Partial<EnergyConfig> | undefined): EnergyConfig {
  const cfg: EnergyConfig = {
    boundary: config?.boundary ?? "replicate",
    priorityWeight: config?.priorityWeight ?? 0,
  };
  if (cfg.boundary !== "replicate" && cfg.boundary !== "zero") {
    throw new ValidationError("energyConfig.boundary 只能是 replicate 或 zero");
  }
  if (
    typeof cfg.priorityWeight !== "number" ||
    !Number.isFinite(cfg.priorityWeight) ||
    cfg.priorityWeight < 0
  ) {
    throw new ValidationError("priorityWeight 必须为非负有限数");
  }
  return cfg;
}

export function validateOrder(order: string | undefined): Order {
  const o = order ?? "width-first";
  if (o !== "width-first" && o !== "height-first") {
    throw new ValidationError("order 只能是 width-first 或 height-first");
  }
  return o;
}

/** 初始坐标映射：当前像素 (r,c) -> 原图坐标 (r,c)。 */
export function initCoordMap(h: number, w: number): Array<Array<[number, number]>> {
  return Array.from({ length: h }, (_, r) =>
    Array.from({ length: w }, (_, c) => [r, c] as [number, number]),
  );
}

/**
 * 执行完整缩小序列（纯计算，不触碰数据库）。
 * 若中途被保护阻断，抛出 BlockedError；此时调用方不得写入任何结果（由服务层事务保证）。
 */
export function runCarve(params: {
  pixels: number[][];
  protectMask: number[][];
  priorityMask: number[][];
  targetWidth: number;
  targetHeight: number;
  order: Order;
  energyConfig: EnergyConfig;
}): {
  steps: ReturnType<typeof applyOneStep>["record"][];
  pixels: number[][];
  protectMask: number[][];
  priorityMask: number[][];
  coordMap: Array<Array<[number, number]>>;
} {
  let { pixels, protectMask, priorityMask } = params;
  const h0 = pixels.length;
  const w0 = pixels[0]!.length;
  validateTarget(params.targetWidth, params.targetHeight, w0, h0);

  let coordMap = initCoordMap(h0, w0);
  const steps = [];
  let stepIndex = 0;

  const passes: Array<"vertical" | "horizontal"> =
    params.order === "width-first"
      ? ["vertical", "horizontal"]
      : ["horizontal", "vertical"];

  for (const pass of passes) {
    while (true) {
      const h = pixels.length;
      const w = pixels[0]!.length;
      const done =
        pass === "vertical" ? w <= params.targetWidth : h <= params.targetHeight;
      if (done) break;
      const { seam } = findSeam(
        pass,
        pixels,
        protectMask,
        priorityMask,
        params.energyConfig,
      );
      if (seam.blocked) {
        throw new ValidationError(
          `第 ${stepIndex + 1} 步（${pass === "vertical" ? "缩宽" : "缩高"}）被阻断：${seam.blockReason}`,
        );
      }
      const next = applyOneStep(
        stepIndex,
        pass,
        seam,
        pixels,
        protectMask,
        priorityMask,
        coordMap,
      );
      pixels = next.pixels;
      protectMask = next.protectMask;
      priorityMask = next.priorityMask;
      coordMap = next.coordMap;
      steps.push(next.record);
      stepIndex++;
    }
  }

  return { steps, pixels, protectMask, priorityMask, coordMap };
}

export const GUARANTEE_NOTE =
  "每一步接缝均为当前能量场下动态规划求得的全局最小代价合法接缝（逐步最优）；" +
  "但逐条贪心删除不保证最终图像在所有可能删除序列中全局最优，也不保证语义层面的主观效果。";

export function buildReportMeta(
  imageId: string,
  reportId: string,
  params: {
    targetWidth: number;
    targetHeight: number;
    order: Order;
    energyConfig: EnergyConfig;
  },
  result: ReturnType<typeof runCarve>,
  createdAt: string,
): CarveReport {
  return {
    reportId,
    imageId,
    targetWidth: params.targetWidth,
    targetHeight: params.targetHeight,
    order: params.order,
    energyConfig: params.energyConfig,
    steps: result.steps,
    finalWidth: result.pixels[0]!.length,
    finalHeight: result.pixels.length,
    completed: true,
    guaranteeNote: GUARANTEE_NOTE,
    createdAt,
  };
}
