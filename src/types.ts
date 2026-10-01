/**
 * 核心数据类型定义。
 * 所有像素矩阵均为 8 位灰度：rows 为行（高 H），每行长度为宽 W，取值 0..255。
 * 掩膜矩阵尺寸必须与对应图像完全一致，取值为 0/1。
 */

export type Order = "width-first" | "height-first";

/** 接缝方向：vertical 表示一条纵向贯穿的接缝（删除后宽度减 1）。 */
export type SeamDirection = "vertical" | "horizontal";

export interface EnergyConfig {
  /**
   * 边界策略：
   * - replicate（默认，确定性）：边界外像素复制最近边界像素，边界处梯度可能为 0。
   * - zero：边界外像素视为 0，边界处通常产生非零梯度。
   */
  boundary: "replicate" | "zero";
  /**
   * 优先删除掩膜的负代价权重（>=0）。
   * 像素位于优先掩膜上时，其能量额外减去 priorityWeight（不低于 -ENERGY_FLOOR，见实现）。
   * 0 表示关闭偏好。
   */
  priorityWeight: number;
}

export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  boundary: "replicate",
  priorityWeight: 0,
};

/** 服务公开的尺寸上限（像素总数与单边长度）。 */
export const LIMITS = {
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 4_000_000,
  maxPixelValue: 255,
  minTargetDim: 1,
} as const;

/** 找到的单条接缝。 */
export interface Seam {
  direction: SeamDirection;
  /**
   * 长度等于该方向上的“贯穿维”像素数：
   * vertical 时 length === H，seam[r] 为第 r 行被选像素的列；
   * horizontal 时 length === W，seam[c] 为第 c 列被选像素的行。
   * 相邻元素差的绝对值 <= 1。
   */
  path: number[];
  /** 该接缝总代价（能量求和，可能为负）。 */
  cost: number;
  /** 是否因保护掩膜导致无可行接缝。 */
  blocked: boolean;
  /** blocked 为 true 时的中文阻塞原因。 */
  blockReason?: string;
}

/** 单步缩放记录。 */
export interface StepRecord {
  stepIndex: number;
  direction: SeamDirection;
  path: number[];
  cost: number;
  /** 本步删除的像素在“操作开始前”矩阵中的坐标 [row, col]。 */
  removedPixels: Array<[number, number]>;
  /** 本步删除像素对应的“原始输入图像”坐标 [row, col]（通过映射追踪）。 */
  removedOriginalPixels: Array<[number, number]>;
  /** 删除前尺寸 [宽, 高]。 */
  sizeBefore: [number, number];
  /** 删除后尺寸 [宽, 高]。 */
  sizeAfter: [number, number];
}

/** 一次完整缩小操作的报告。 */
export interface CarveReport {
  reportId: string;
  imageId: string;
  targetWidth: number;
  targetHeight: number;
  order: Order;
  energyConfig: EnergyConfig;
  steps: StepRecord[];
  finalWidth: number;
  finalHeight: number;
  completed: boolean;
  /** 若中途被保护阻断，记录发生于第几步及原因；此前步骤不会落库（见服务层事务）。 */
  blockReason?: string;
  /**
   * 算法保证说明（中文）：
   * 本实现每一条接缝都是“当前能量场下的动态规划全局最小代价接缝”，
   * 但逐条贪心删除不等于“最终图像在所有删除序列中的全局最优”。
   */
  guaranteeNote: string;
  createdAt: string;
}

export interface ImportedImage {
  width: number;
  height: number;
  pixels: number[][];
  protectMask?: number[][];
  priorityMask?: number[][];
}

export class ValidationError extends Error {
 constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class BlockedError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = "BlockedError";
  }
}

export class ReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayMismatchError";
  }
}
