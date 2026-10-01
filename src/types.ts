/**
 * 全局类型定义。
 *
 * 坐标约定：
 * - 图像矩阵 matrix[r][c]：行 r ∈ [0,height)，列 c ∈ [0,width)，8 位灰度 0..255。
 * - 掩膜与图像同尺寸，元素为 0/1：
 *   protect：1 表示该像素受保护，任何接缝都不允许经过（硬约束）。
 *   preferDelete：1 表示优先删除，仅作为可配置负代价偏好，不是硬约束。
 * - origin[r][c] = [or, oc]：当前像素来自原始输入图像的坐标，用于像素来源追踪。
 */

export type Matrix = number[][];

/** 像素在原始图像中的坐标 [行, 列]。 */
export type OriginCell = [number, number];
export type OriginGrid = OriginCell[][];

export interface Image {
  width: number;
  height: number;
  /** height 行、每行 width 个 0..255 的灰度值。 */
  matrix: Matrix;
  protect: Matrix;
  preferDelete: Matrix;
  origin: OriginGrid;
}

/** 接缝方向：vertical 每条接缝跨所有行（删除一列），horizontal 跨所有列（删除一行）。 */
export type SeamOrientation = 'vertical' | 'horizontal';

/** 操作顺序：先宽后高（先减宽再减高）或先高后宽。 */
export type OperationOrder = 'width-first' | 'height-first';

/** 图像边界能量策略。 */
export type BoundaryStrategy =
  | 'zero' // 越界邻居按 0 灰度处理（默认，对背景安全）
  | 'replicate' // 越界邻居复制边界像素（边界梯度恒为 0）
  | 'wrap'; // 环形边界（左右/上下相接）

export interface EnergyConfig {
  /** 梯度组合方式：水平+垂直梯度的 L1，或只用水平/垂直梯度。 */
  gradient: 'l1' | 'horizontal' | 'vertical';
  boundary: BoundaryStrategy;
  /** 优先删除掩膜的负代价权重：经过 preferDelete 像素时附加 -preferWeight。 */
  preferWeight: number;
  /** 受保护像素的代价：Infinity（不可删除的硬约束）。仅作记录，不可调小。 */
  protectCost: number;
}

export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  gradient: 'l1',
  boundary: 'zero',
  preferWeight: 0,
  protectCost: Number.POSITIVE_INFINITY,
};

/**
 * 一条接缝。
 * vertical：path[r] = 第 r 行经过的列，长度必须等于当前 height，相邻行列差 ≤ 1。
 * horizontal：path[c] = 第 c 列经过的行，长度必须等于当前 width，相邻列行差 ≤ 1。
 */
export interface Seam {
  orientation: SeamOrientation;
  path: number[];
}

export interface SeamSearchResult {
  seam: Seam;
  /** 该接缝的总代价（含偏好负代价；若含受保护像素则为 Infinity 表示不可行）。 */
  cost: number;
  feasible: boolean;
  /** 不可行时的机器可读阻塞原因。 */
  blockReason?: BlockReason;
}

export type BlockReasonCode =
  | 'PROTECTED_FULL_ROW' // 垂直接缝：某一行所有像素都受保护
  | 'PROTECTED_FULL_COLUMN' // 水平接缝：某一列所有像素都受保护
  | 'PROTECTED_BARRIER'; // 受保护像素形成屏障，无任何合法连通路径

export interface BlockReason {
  code: BlockReasonCode;
  message: string;
  /** 触发原因的关键坐标（屏障行/列等），便于调用方定位。 */
  locations: Array<[number, number]>;
}

/** 单次接缝删除步骤的记录。 */
export interface ShrinkStep {
  stepIndex: number;
  orientation: SeamOrientation;
  /** 本步使用的接缝（基于删除前图像的坐标）。 */
  seamPath: number[];
  cost: number;
  /** 删除后尺寸。 */
  resultingWidth: number;
  resultingHeight: number;
  /** 被删除像素映射回原始输入的坐标列表。 */
  removedOrigins: OriginCell[];
}

export interface ShrinkRequest {
  targetWidth: number;
  targetHeight: number;
  order: OperationOrder;
  energyConfig: EnergyConfig;
}

export interface ShrinkReport {
  reportId: string;
  imageId: string;
  initialWidth: number;
  initialHeight: number;
  targetWidth: number;
  targetHeight: number;
  order: OperationOrder;
  energyConfig: EnergyConfig;
  steps: ShrinkStep[];
  finalWidth: number;
  finalHeight: number;
  finalMatrix: Matrix;
  finalOrigin: OriginGrid;
  finalProtect: Matrix;
  finalPreferDelete: Matrix;
  /** 剩余的受保护原始像素坐标（核验用）。 */
  survivingProtectedOrigins: OriginCell[];
  /** 已被删除的受保护原始像素——必须始终为空。 */
  removedProtectedOrigins: OriginCell[];
  /**
   * 最优性声明：逐步贪心最优（每一步在当时图像上选最小代价接缝），
   * 不保证整个删除序列的全局最优。
   */
  optimalityClaim: 'stepwise-greedy';
  createdAt: string;
  requestHash: string;
}

/** 回放核验结果。 */
export interface ReplayResult {
  reportId: string;
  ok: boolean;
  mismatches: string[];
  checkedSteps: number;
  finalWidth: number;
  finalHeight: number;
}

export const LIMITS = {
  /** 单边最大像素数（公开尺寸上限）。 */
  MAX_DIMENSION: 2000,
  /** 图像总像素上限，防止动态规划内存爆炸。 */
  MAX_PIXELS: 1_000_000,
  MAX_PIXEL_VALUE: 255,
  MIN_DIMENSION: 1,
} as const;
