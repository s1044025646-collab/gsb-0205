import { resolve } from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  dbPath: string;
}

/** 配置完全来自环境变量，提供项目内默认数据目录 data/。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portRaw = env.PORT ?? env.SEAMCARVE_PORT ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`非法端口: ${portRaw}`);
  }
  const dataDir = resolve(env.SEAMCARVE_DATA_DIR ?? resolve(process.cwd(), 'data'));
  return {
    port,
    dataDir,
    dbPath: resolve(dataDir, 'seamcarve.sqlite'),
  };
}
