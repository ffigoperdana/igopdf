import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { config } from './config/index.js';
import { closePool } from './config/database.js';
import {
  claimNextJob,
  cleanupExpiredJobs,
  ensureCompressionStorage,
  getJobInputPath,
  getJobOutputPath,
  isCancellationRequested,
  markJobCompleted,
  markJobFailed,
  recoverInterruptedJobs,
  type CompressionJob,
} from './services/compressionJobService.js';
import { logger } from './utils/logger.js';

let stopping = false;
let running = false;

interface ManagedChildProcess {
  kill(signal?: NodeJS.Signals): boolean;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
}

function commandFor(job: CompressionJob): { executable: string; args: string[] } {
  const input = getJobInputPath(job.id);
  const output = getJobOutputPath(job.id);

  if (job.mode === 'lossless') {
    return {
      executable: 'qpdf',
      args: [
        '--compress-streams=y',
        '--decode-level=generalized',
        '--recompress-flate',
        '--compression-level=6',
        '--object-streams=generate',
        input,
        output,
      ],
    };
  }

  return {
    executable: 'gs',
    args: [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.6',
      '-dPDFSETTINGS=/ebook',
      '-dDownsampleColorImages=true',
      '-dColorImageResolution=150',
      '-dDownsampleGrayImages=true',
      '-dGrayImageResolution=150',
      '-dDownsampleMonoImages=true',
      '-dMonoImageResolution=300',
      `-sOutputFile=${output}`,
      input,
    ],
  };
}

async function runJobProcess(job: CompressionJob): Promise<void> {
  const { executable, args } = commandFor(job);
  const outputPath = getJobOutputPath(job.id);
  await rm(outputPath, { force: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] }) as unknown as ManagedChildProcess;
    let errorCode = 'PROCESS_FAILED';
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellationCheck);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      errorCode = 'TIMEOUT';
      child.kill('SIGTERM');
    }, config.compression.jobTimeoutMs);

    const cancellationCheck = setInterval(() => {
      void isCancellationRequested(job.id).then((cancelled) => {
        if (cancelled && !settled) {
          errorCode = 'CANCELLED';
          child.kill('SIGTERM');
        }
      });
    }, 1500);

    child.on('error', (error: NodeJS.ErrnoException) => {
      settle(new Error(error.code === 'ENOENT' ? 'ENGINE_UNAVAILABLE' : 'PROCESS_FAILED'));
    });
    child.stderr?.on('data', () => {
      // Do not retain document paths or contents in application logs.
    });
    child.on('close', (code: number | null) => {
      if (code === 0 && errorCode === 'PROCESS_FAILED') {
        settle();
      } else {
        settle(new Error(errorCode));
      }
    });
  });

  const output = await stat(outputPath);
  if (output.size === 0) throw new Error('EMPTY_OUTPUT');
}

async function processJob(job: CompressionJob): Promise<void> {
  try {
    if (await isCancellationRequested(job.id)) {
      await rm(getJobInputPath(job.id), { force: true });
      await markJobFailed(job.id, 'CANCELLED');
      return;
    }
    await runJobProcess(job);
    if (await isCancellationRequested(job.id)) {
      await rm(getJobOutputPath(job.id), { force: true });
      await rm(getJobInputPath(job.id), { force: true });
      await markJobFailed(job.id, 'CANCELLED');
      return;
    }
    await rm(getJobInputPath(job.id), { force: true });
    await markJobCompleted(job.id);
    logger.info('Compression job completed', { jobId: job.id, mode: job.mode });
  } catch (error) {
    await rm(getJobOutputPath(job.id), { force: true });
    await rm(getJobInputPath(job.id), { force: true });
    const errorCode = error instanceof Error ? error.message : 'PROCESS_FAILED';
    await markJobFailed(job.id, errorCode);
    logger.warn('Compression job failed', { jobId: job.id, errorCode });
  }
}

async function tick(): Promise<void> {
  if (stopping || running) return;
  running = true;
  try {
    await cleanupExpiredJobs();
    const job = await claimNextJob();
    if (job) await processJob(job);
  } catch (error) {
    logger.error('Compression worker tick failed', error instanceof Error ? { message: error.message } : undefined);
  } finally {
    running = false;
    if (stopping) {
      await closePool();
      process.exit(0);
    }
    setTimeout(() => void tick(), config.compression.workerPollMs);
  }
}

async function start(): Promise<void> {
  ensureCompressionStorage();
  await recoverInterruptedJobs();
  await cleanupExpiredJobs();
  logger.info('Compression worker started', { concurrency: 1 });
  await tick();
}

function stop(): void {
  stopping = true;
  if (!running) {
    void closePool().finally(() => process.exit(0));
  }
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

start().catch((error) => {
  logger.error('Compression worker could not start', error instanceof Error ? { message: error.message } : undefined);
  process.exit(1);
});
