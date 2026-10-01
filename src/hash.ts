import { createHash } from 'node:crypto';

/** 稳定 JSON（键排序），用于请求指纹与内容哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 图像内容指纹：矩阵 + 两个掩膜，不含 id。 */
export function hashImagePayload(payload: {
  matrix: unknown;
  protect?: unknown;
  preferDelete?: unknown;
}): string {
  return sha256Hex(stableStringify(payload));
}

/** 缩小请求指纹：冻结输入图像、目标尺寸、顺序与能量配置，保证重复请求幂等。 */
export function hashShrinkRequest(payload: {
  imageHash: string;
  targetWidth: number;
  targetHeight: number;
  order: string;
  energyConfig: unknown;
}): string {
  return sha256Hex(stableStringify(payload));
}
