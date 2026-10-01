import { randomUUID } from "node:crypto";
import {
  CarveReport,
  EnergyConfig,
  LIMITS,
  Order,
  ValidationError,
} from "./types.js";
import {
  validateEnergyConfig,
  validateImageInput,
  validateOrder,
  runCarve,
  buildReportMeta,
} from "./core/carve.js";
import { findSeam, computeEnergy } from "./core/seam.js";
import {
  firstMismatch,
  pixelsEqual,
  replaySteps,
  verifyProtectedKept,
} from "./core/replay.js";
import { Store } from "./store/store.js";

export interface CarveRequest {
  pixels: number[][];
  targetWidth: number;
  targetHeight: number;
  protectMask?: number[][];
  priorityMask?: number[][];
  order?: string;
  energyConfig?: Partial<EnergyConfig>;
}

export interface CarveResult {
  imageId: string;
  reportId: string;
  reused: boolean;
  report: CarveReport;
  finalPixels: number[][];
  finalProtectMask: number[][];
  finalPriorityMask: number[][];
  finalCoordMap: Array<Array<[number, number]>>;
}

export class SeamCarveService {
  constructor(private store: Store) {}

  importImage(input: {
    pixels: number[][];
    protectMask?: number[][];
    priorityMask?: number[][];
  }): { imageId: string; width: number; height: number; reused: boolean } {
    const valid = validateImageInput(input);
    const { row, reused } = this.store.upsertImage({
      id: randomUUID(),
      width: valid.width,
      height: valid.height,
      pixels: valid.pixels,
      protectMask: valid.protectMask,
      priorityMask: valid.priorityMask,
      createdAt: new Date().toISOString(),
    });
    return { imageId: row.id, width: row.width, height: row.height, reused };
  }

  getImage(imageId: string) {
    const row = this.store.getImage(imageId);
    if (!row) throw new ValidationError(`图像 ${imageId} 不存在`);
    return row;
  }

  listImages() {
    return this.store.listImages();
  }

  listReports(imageId?: string) {
    return this.store.listOperations(imageId).map((op) => ({
      reportId: op.id,
      imageId: op.imageId,
      targetWidth: op.targetWidth,
      targetHeight: op.targetHeight,
      order: op.order,
      createdAt: op.createdAt,
      finalWidth: op.report.finalWidth,
      finalHeight: op.report.finalHeight,
      stepCount: op.report.steps.length,
    }));
  }

  previewEnergy(
    imageId: string,
    energyConfig?: Partial<EnergyConfig>,
  ): { width: number; height: number; energy: number[][] } {
    const img = this.getImage(imageId);
    const cfg = validateEnergyConfig(energyConfig);
    const energy = computeEnergy(img.pixels, img.priorityMask, cfg);
    return { width: img.width, height: img.height, energy };
  }

  findOneSeam(
    imageId: string,
    direction: "vertical" | "horizontal",
    energyConfig?: Partial<EnergyConfig>,
  ) {
    const img = this.getImage(imageId);
    const cfg = validateEnergyConfig(energyConfig);
    const { seam, energy } = findSeam(
      direction,
      img.pixels,
      img.protectMask,
      img.priorityMask,
      cfg,
    );
    return { seam, energy, width: img.width, height: img.height };
  }

  /** 执行缩小（或对已冻结 imageId 执行）。成功才落库，重复请求返回同一份报告。 */
  carve(
    req: CarveRequest,
    existingImageId?: string,
  ): CarveResult {
    const valid = validateImageInput({
      pixels: req.pixels,
      protectMask: req.protectMask,
      priorityMask: req.priorityMask,
    });
    const order: Order = validateOrder(req.order);
    const energyConfig = validateEnergyConfig(req.energyConfig);
    if (
      !Number.isInteger(req.targetWidth) ||
      !Number.isInteger(req.targetHeight)
    ) {
      throw new ValidationError("目标宽高必须为整数");
    }

    // 冻结输入
    const { row: image } = this.store.upsertImage({
      id: existingImageId ?? randomUUID(),
      width: valid.width,
      height: valid.height,
      pixels: valid.pixels,
      protectMask: valid.protectMask,
      priorityMask: valid.priorityMask,
      createdAt: new Date().toISOString(),
    });

    // 先查幂等
    const requestHash = Store.operationRequestHash({
      imageId: image.id,
      targetWidth: req.targetWidth,
      targetHeight: req.targetHeight,
      order,
      energyConfig,
    });
    const prior = this.store
      .listOperations(image.id)
      .find((op) => Store.operationRequestHash(op) === requestHash);
    if (prior) {
      return this.toCarveResult(image.id, prior.id, prior, true);
    }

    // 全部计算成功后才写库；阻断时抛错，不产生任何记录
    const result = runCarve({
      pixels: image.pixels,
      protectMask: image.protectMask,
      priorityMask: image.priorityMask,
      targetWidth: req.targetWidth,
      targetHeight: req.targetHeight,
      order,
      energyConfig,
    });
    const reportId = randomUUID();
    const report = buildReportMeta(
      image.id,
      reportId,
      {
        targetWidth: req.targetWidth,
        targetHeight: req.targetHeight,
        order,
        energyConfig,
      },
      result,
      new Date().toISOString(),
    );
    const { row: saved, reused } = this.store.saveOperation({
      id: reportId,
      imageId: image.id,
      targetWidth: req.targetWidth,
      targetHeight: req.targetHeight,
      order,
      energyConfig,
      report,
      finalPixels: result.pixels,
      finalProtectMask: result.protectMask,
      finalPriorityMask: result.priorityMask,
      finalCoordMap: result.coordMap,
      createdAt: report.createdAt,
    });
    return this.toCarveResult(image.id, saved.id, saved, reused);
  }

  private toCarveResult(
    imageId: string,
    reportId: string,
    op: ReturnType<Store["listOperations"]>[number],
    reused: boolean,
  ): CarveResult {
    return {
      imageId,
      reportId,
      reused,
      report: op.report,
      finalPixels: op.finalPixels,
      finalProtectMask: op.finalProtectMask,
      finalPriorityMask: op.finalPriorityMask,
      finalCoordMap: op.finalCoordMap,
    };
  }

  getReport(reportId: string): CarveResult {
    const op = this.store.getOperation(reportId);
    if (!op) throw new ValidationError(`报告 ${reportId} 不存在`);
    return this.toCarveResult(op.imageId, op.id, op, true);
  }

  /**
   * 按已保存接缝独立重放，并与存储的实际产物逐像素核验。
   * 同时核验保护像素未被删除。任一项失败都会明确指出。
   */
  replayAndVerify(reportId: string) {
    const op = this.store.getOperation(reportId);
    if (!op) throw new ValidationError(`报告 ${reportId} 不存在`);
    const image = this.getImage(op.imageId);

    const replayed = replaySteps({
      originalPixels: image.pixels,
      steps: op.report.steps,
    });
    const pixelMatch = pixelsEqual(replayed.pixels, op.finalPixels);
    const mismatch = pixelMatch
      ? null
      : firstMismatch(replayed.pixels, op.finalPixels);
    const mapMatch = pixelsEqual(
      replayed.coordMap.map((row) => row.map(([r, c]) => r * 100000 + c)),
      op.finalCoordMap.map((row) => row.map(([r, c]) => r * 100000 + c)),
    );

    const allRemovedOriginal = op.report.steps.flatMap(
      (s) => s.removedOriginalPixels,
    );
    const protection = verifyProtectedKept({
      originalProtectMask: image.protectMask,
      removedOriginalPixels: allRemovedOriginal,
    });

    const ok = pixelMatch && mapMatch && protection.kept;
    return {
      ok,
      reportId,
      stepCount: op.report.steps.length,
      pixelMatch,
      coordMapMatch: mapMatch,
      firstPixelMismatch: mismatch,
      protectionKept: protection.kept,
      violatedProtectedPixels: protection.violated,
      finalSize: [op.finalPixels[0]!.length, op.finalPixels.length] as [
        number,
        number,
      ],
      replayedPixels: replayed.pixels,
    };
  }

  /** 版本比较：两个报告的尺寸、代价汇总与差异像素。 */
  compareReports(reportIdA: string, reportIdB: string) {
    const a = this.getReport(reportIdA);
    const b = this.getReport(reportIdB);
    const sameFinalSize =
      a.finalPixels.length === b.finalPixels.length &&
      a.finalPixels[0]!.length === b.finalPixels[0]!.length;
    let differingPixels = 0;
    if (sameFinalSize) {
      for (let r = 0; r < a.finalPixels.length; r++) {
        for (let c = 0; c < a.finalPixels[0]!.length; c++) {
          if (a.finalPixels[r]![c] !== b.finalPixels[r]![c]) differingPixels++;
        }
      }
    }
    const sumCost = (rep: CarveReport) =>
      rep.steps.reduce((acc, s) => acc + s.cost, 0);
    return {
      reportA: {
        reportId: a.reportId,
        order: a.report.order,
        finalWidth: a.report.finalWidth,
        finalHeight: a.report.finalHeight,
        totalStepCost: sumCost(a.report),
        stepCount: a.report.steps.length,
      },
      reportB: {
        reportId: b.reportId,
        order: b.report.order,
        finalWidth: b.report.finalWidth,
        finalHeight: b.report.finalHeight,
        totalStepCost: sumCost(b.report),
        stepCount: b.report.steps.length,
      },
      sameFinalSize,
      differingPixels,
      note:
        "totalStepCost 是各步最小代价之和，仅用于比较同一配置/顺序下的路径差异，" +
        "不代表跨顺序的全局最优度量。",
    };
  }

  listLimits() {
    return {
      ...LIMITS,
      boundaryStrategies: ["replicate", "zero"] as const,
      tieBreakRule:
        "终点取最小代价列，平局取最左列；回溯父节点按 c-1、c、c+1 顺序，平局取先出现者；水平接缝按转置等价规则（偏向更靠上的行）。",
      orders: ["width-first", "height-first"] as const,
      shrinkOnly: true,
    };
  }
}
