import { describe, expect, it } from 'vitest';
import {
  buildCompressionCommand,
  decideCompressionOutput,
  LARGE_BALANCED_PDF_BYTES,
  selectBalancedCompressionProfile,
} from './compressionCommand.js';

describe('compression command', () => {
  it('keeps lossless mode on qpdf with maximum Flate compression', () => {
    const command = buildCompressionCommand({
      inputBytes: 300 * 1024 * 1024,
      mode: 'lossless',
      inputPath: '/jobs/input.pdf',
      outputPath: '/jobs/output.pdf',
    });

    expect(command).toEqual({
      executable: 'qpdf',
      profile: 'lossless',
      args: [
        '--warning-exit-0',
        '--compress-streams=y',
        '--decode-level=generalized',
        '--recompress-flate',
        '--compression-level=9',
        '--object-streams=generate',
        '/jobs/input.pdf',
        '/jobs/output.pdf',
      ],
    });
  });

  it('uses explicit balanced image settings instead of the ebook preset', () => {
    const command = buildCompressionCommand({
      inputBytes: LARGE_BALANCED_PDF_BYTES - 1,
      mode: 'balanced',
      inputPath: '/jobs/input.pdf',
      outputPath: '/jobs/output.pdf',
    });

    expect(command.executable).toBe('gs');
    expect(command.profile).toBe('balanced');
    expect(command.args).not.toContain('-dPDFSETTINGS=/ebook');
    expect(command.args).toContain('-dColorImageResolution=120');
    expect(command.args).toContain('-dGrayImageResolution=120');
    expect(command.args).toContain('-dColorImageDownsampleThreshold=1.1');
    expect(command.args).toContain('-dPassThroughJPEGImages=false');
    expect(command.args).toContain('-dPassThroughJPXImages=false');
    expect(command.args.at(-2)).toBe('-f');
    expect(command.args.at(-1)).toBe('/jobs/input.pdf');
  });

  it('selects the aggressive profile for PDFs of at least 200 MiB', () => {
    expect(selectBalancedCompressionProfile(LARGE_BALANCED_PDF_BYTES - 1)).toBe(
      'balanced'
    );
    expect(selectBalancedCompressionProfile(LARGE_BALANCED_PDF_BYTES)).toBe(
      'balanced-large'
    );

    const command = buildCompressionCommand({
      inputBytes: 270 * 1024 * 1024,
      mode: 'balanced',
      inputPath: '/jobs/large.pdf',
      outputPath: '/jobs/large-compressed.pdf',
    });

    expect(command.profile).toBe('balanced-large');
    expect(command.args).toContain('-dColorImageResolution=96');
    expect(command.args).toContain('-dGrayImageResolution=96');
    expect(command.args).toContain('-dColorImageDownsampleThreshold=1.05');
    expect(command.args).toContain('-dGrayImageDownsampleThreshold=1.05');

    const distillerSettings = command.args[command.args.indexOf('-c') + 1];
    expect(distillerSettings).toContain('/QFactor 0.7');
    expect(distillerSettings).toContain('/LockDistillerParams true');
  });

  it('accepts only a genuinely smaller compression result', () => {
    expect(
      decideCompressionOutput({
        requestedMode: 'balanced',
        attemptedMode: 'balanced',
        inputBytes: 270,
        outputBytes: 230,
      })
    ).toBe('accept-output');
  });

  it('retries a non-shrinking balanced result with lossless compression', () => {
    expect(
      decideCompressionOutput({
        requestedMode: 'balanced',
        attemptedMode: 'balanced',
        inputBytes: 270,
        outputBytes: 270,
      })
    ).toBe('retry-lossless');
    expect(
      decideCompressionOutput({
        requestedMode: 'balanced',
        attemptedMode: 'balanced',
        inputBytes: 270,
        outputBytes: 280,
      })
    ).toBe('retry-lossless');
  });

  it('preserves the original when lossless output does not shrink', () => {
    expect(
      decideCompressionOutput({
        requestedMode: 'lossless',
        attemptedMode: 'lossless',
        inputBytes: 270,
        outputBytes: 280,
      })
    ).toBe('preserve-original');
    expect(
      decideCompressionOutput({
        requestedMode: 'balanced',
        attemptedMode: 'lossless',
        inputBytes: 270,
        outputBytes: 270,
      })
    ).toBe('preserve-original');
  });
});
