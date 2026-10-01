#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../db.js';
import { isAppError } from '../errors.js';
import { SeamCarveService } from '../service.js';
import { loadConfig } from '../config.js';

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    }
  }
  return { command, flags };
}

function readPayload(flags: Map<string, string>): unknown {
  const file = flags.get('json-file');
  if (file) return JSON.parse(readFileSync(resolve(file), 'utf8'));
  const inline = flags.get('json');
  if (inline !== undefined) return JSON.parse(inline);
  return {};
}

const HELP = [
  'seamcarve - 灰度图接缝缩放 CLI（仅缩小）',
  '',
  '用法:',
  '  seamcarve limits',
  '  seamcarve list-images | list-reports',
  '  seamcarve import --json-file req.json [--name 名称]',
  '  seamcarve import-pgm --pgm-file input.p2 [--protect-file m.json] [--prefer-file p.json]',
  '  seamcarve energy --image-id ID [--json-file body.json]',
  '  seamcarve seam --image-id ID --orientation vertical|horizontal [--json-file body.json]',
  '  seamcarve shrink --json-file shrink.json',
  '  seamcarve report --report-id ID',
  '  seamcarve replay --report-id ID',
  '  seamcarve verify-protection --report-id ID',
  '  seamcarve compare --a-image-id ID (--b-image-id ID | --b-report-id ID)',
  '  seamcarve export --report-id ID --format json|pgm [--out file]',
  '',
  '环境变量: PORT / SEAMCARVE_PORT（默认 8787）; SEAMCARVE_DATA_DIR（默认 ./data）',
].join('\n');

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const service = new SeamCarveService(store);

  try {
    const out = dispatch(args, service);
    if (out !== undefined) {
      if (args.command === 'export' && args.flags.has('out')) {
        emitText(args.flags, (out as { content: string }).content);
      } else {
        process.stdout.write(JSON.stringify(out, jsonReplacer, 2) + '\n');
      }
    }
  } catch (err) {
    if (isAppError(err)) {
      process.stderr.write(`错误 [${err.code}] ${err.message}\n`);
      if (err.details !== undefined) process.stderr.write(JSON.stringify(err.details, jsonReplacer, 2) + '\n');
    } else {
      process.stderr.write(`错误 [INTERNAL] ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value === Infinity ? 'Infinity' : value;
}

function emitText(flags: Map<string, string>, content: string): void {
  const out = flags.get('out')!;
  writeFileSync(resolve(out), content, 'utf8');
  process.stdout.write(`已写入 ${resolve(out)}\n`);
}

function dispatch(args: ParsedArgs, service: SeamCarveService): unknown {
  const f = args.flags;
  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP + '\n');
      return undefined;
    case 'limits':
      return service.limits();
    case 'list-images':
      return { images: service.listImages() };
    case 'list-reports':
      return { reports: service.listReports() };
    case 'import': {
      const payload = readPayload(f) as Record<string, unknown>;
      if (f.has('name') && payload.name === undefined) payload.name = f.get('name');
      return service.importImage(payload);
    }
    case 'import-pgm': {
      const pgmPath = requireFlag(f, 'pgm-file');
      const payload: Record<string, unknown> = { pgm: readFileSync(resolve(pgmPath), 'utf8') };
      if (f.has('name')) payload.name = f.get('name');
      if (f.has('protect-file')) payload.protect = JSON.parse(readFileSync(resolve(f.get('protect-file')!), 'utf8'));
      if (f.has('prefer-file')) payload.preferDelete = JSON.parse(readFileSync(resolve(f.get('prefer-file')!), 'utf8'));
      return service.importImage(payload);
    }
    case 'energy':
      return service.previewEnergy(requireFlag(f, 'image-id'), (readPayload(f) as Record<string, unknown>).energyConfig);
    case 'seam': {
      const body = readPayload(f) as Record<string, unknown>;
      return service.findSingleSeam(
        requireFlag(f, 'image-id'),
        requireFlag(f, 'orientation') as 'vertical' | 'horizontal',
        body.energyConfig,
      );
    }
    case 'shrink':
      return service.shrink(readPayload(f) as Parameters<SeamCarveService['shrink']>[0]);
    case 'report':
      return service.getReportOrThrow(requireFlag(f, 'report-id'));
    case 'replay':
      return service.replay(requireFlag(f, 'report-id'));
    case 'verify-protection':
      return service.verifyProtection(requireFlag(f, 'report-id'));
    case 'compare':
      return service.compare(requireFlag(f, 'a-image-id'), {
        imageId: f.get('b-image-id'),
        reportId: f.get('b-report-id'),
      });
    case 'export':
      return service.exportMatrix(requireFlag(f, 'report-id'), f.get('format') === 'pgm' ? 'pgm' : 'json');
    default:
      process.stderr.write(HELP + '\n');
      throw new Error(`未知命令: ${args.command}`);
  }
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined) throw new Error(`缺少必需参数 --${key}`);
  return value;
}

main();
