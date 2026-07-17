import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config/index.js';
import { closePool } from './config/database.js';
import {
  claimNextDocxJob,
  cleanupExpiredDocxJobs,
  cleanupExpiredDocxUploadSlots,
  ensureDocxStorage,
  getDocxJobInputPath,
  getDocxJobOutputPath,
  isDocxCancellationRequested,
  markDocxCompleted,
  markDocxFailed,
  recoverInterruptedDocxJobs,
  type DocxJob,
  updateDocxProgress,
} from './services/docxJobService.js';
import {
  releaseHeavyJobLock,
  tryAcquireHeavyJobLock,
} from './services/heavyJobLockService.js';
import { logger } from './utils/logger.js';

let stopping = false;
let running = false;

interface ManagedChildProcess {
  kill(signal?: NodeJS.Signals): boolean;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

async function oomKillCount(): Promise<number | null> {
  try {
    const events = await readFile('/sys/fs/cgroup/memory.events', 'utf8');
    const match = events.match(/^oom_kill\s+(\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pageLimit(mode: DocxJob['mode']): number {
  if (mode === 'ocr') return config.docx.ocrMaxPages;
  if (mode === 'visual') return config.docx.visualMaxPages;
  return config.docx.nativeMaxPages;
}

type WorkerEvent = {
  type?: 'progress' | 'error';
  stage?: string;
  progress?: number;
  currentPage?: number;
  totalPages?: number;
  code?: string;
};

async function runDocxProcess(job: DocxJob): Promise<void> {
  const input = getDocxJobInputPath(job.id);
  const outputPath = getDocxJobOutputPath(job.id);
  const script = path.join(process.cwd(), 'dist', 'scripts', 'docx_convert.py');
  await rm(outputPath, { force: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'python3',
      [
        script,
        '--input', input,
        '--output', outputPath,
        '--mode', job.mode,
        '--max-pages', String(pageLimit(job.mode)),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ) as unknown as ManagedChildProcess;
    let errorCode = 'PROCESS_FAILED';
    let settled = false;
    let stdoutBuffer = '';

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelCheck);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      errorCode = 'TIMEOUT';
      child.kill('SIGTERM');
    }, config.docx.jobTimeoutMs);
    const cancelCheck = setInterval(() => {
      void isDocxCancellationRequested(job.id).then((cancelled) => {
        if (cancelled && !settled) {
          errorCode = 'CANCELLED';
          child.kill('SIGTERM');
        }
      });
    }, 1500);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as WorkerEvent;
          if (event.type === 'progress' && event.stage && typeof event.progress === 'number') {
            void updateDocxProgress(
              job.id,
              event.stage,
              event.progress,
              event.currentPage,
              event.totalPages
            );
          }
          if (event.type === 'error' && event.code) errorCode = event.code;
        } catch {
          // Worker output is intentionally treated as untrusted diagnostic data.
        }
      }
    });
    child.stderr?.on('data', () => {
      // Do not retain document paths, page content, or engine tracebacks in logs.
    });
    child.on('error', (error) => {
      settle(new Error(error.code === 'ENOENT' ? 'ENGINE_UNAVAILABLE' : 'PROCESS_FAILED'));
    });
    child.on('close', (code, signal) => {
      if (code === 0 && errorCode === 'PROCESS_FAILED') {
        settle();
        return;
      }
      const reason = errorCode === 'PROCESS_FAILED'
        ? signal ? `ENGINE_SIGNAL_${signal}` : `ENGINE_EXIT_${code ?? 'UNKNOWN'}`
        : errorCode;
      settle(new Error(reason));
    });
  });

  const outputStat = await stat(outputPath);
  if (outputStat.size === 0) throw new Error('EMPTY_OUTPUT');
}

async function processJob(job: DocxJob): Promise<void> {
  const oomBefore = await oomKillCount();
  try {
    if (await isDocxCancellationRequested(job.id)) {
      await rm(getDocxJobInputPath(job.id), { force: true });
      await markDocxFailed(job.id, 'CANCELLED');
      return;
    }
    await runDocxProcess(job);
    if (await isDocxCancellationRequested(job.id)) {
      await rm(getDocxJobOutputPath(job.id), { force: true });
      await rm(getDocxJobInputPath(job.id), { force: true });
      await markDocxFailed(job.id, 'CANCELLED');
      return;
    }
    await rm(getDocxJobInputPath(job.id), { force: true });
    await markDocxCompleted(job.id);
    logger.info('DOCX conversion job completed', { jobId: job.id, mode: job.mode });
  } catch (error) {
    await rm(getDocxJobOutputPath(job.id), { force: true });
    await rm(getDocxJobInputPath(job.id), { force: true });
    const oomAfter = await oomKillCount();
    const errorCode = oomBefore !== null && oomAfter !== null && oomAfter > oomBefore
      ? 'MEMORY_LIMIT'
      : error instanceof Error ? error.message : 'PROCESS_FAILED';
    await markDocxFailed(job.id, errorCode);
    logger.warn('DOCX conversion job failed', { jobId: job.id, errorCode });
  }
}

async function tick(): Promise<void> {
  if (stopping || running) return;
  running = true;
  try {
    await cleanupExpiredDocxUploadSlots();
    await cleanupExpiredDocxJobs();
    const lock = await tryAcquireHeavyJobLock();
    if (lock) {
      try {
        const job = await claimNextDocxJob();
        if (job) await processJob(job);
      } finally {
        await releaseHeavyJobLock(lock);
      }
    }
  } catch (error) {
    logger.error('DOCX worker tick failed', error instanceof Error ? { message: error.message } : undefined);
  } finally {
    running = false;
    if (stopping) {
      await closePool();
      process.exit(0);
    }
    setTimeout(() => void tick(), config.docx.workerPollMs);
  }
}

async function start(): Promise<void> {
  ensureDocxStorage();
  try {
    await recoverInterruptedDocxJobs();
    await cleanupExpiredDocxUploadSlots();
    await cleanupExpiredDocxJobs();
  } catch (error) {
    // deploy.sh applies migrations before workers start. Keeping the process
    // alive also makes manual/local starts recover automatically after a migration.
    logger.warn('DOCX worker is waiting for database migrations', error instanceof Error ? { message: error.message } : undefined);
  }
  logger.info('DOCX worker started', { concurrency: 1 });
  await tick();
}

function stop(): void {
  stopping = true;
  if (!running) void closePool().finally(() => process.exit(0));
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start().catch((error) => {
  logger.error('DOCX worker could not start', error instanceof Error ? { message: error.message } : undefined);
  process.exit(1);
});
