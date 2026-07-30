import { describe, expect, it } from 'vitest';
import {
  getServerCompressionAlgorithmOptions,
  isCompressionResultSmaller,
} from '@/js/logic/compress-pdf-page';

describe('compress PDF flow', () => {
  it('defaults eligible server-side files to balanced and keeps lossless available', () => {
    expect(
      getServerCompressionAlgorithmOptions(270 * 1024 * 1024, 500 * 1024 * 1024)
    ).toEqual([
      { value: 'server-balanced', label: 'Balanced (Server)' },
      { value: 'server-lossless', label: 'Lossless (Server)' },
    ]);
  });

  it('offers only lossless above the configured balanced limit', () => {
    expect(
      getServerCompressionAlgorithmOptions(501 * 1024 * 1024, 500 * 1024 * 1024)
    ).toEqual([{ value: 'server-lossless', label: 'Lossless (Server)' }]);
  });

  it('rejects equal or larger compression candidates', () => {
    expect(isCompressionResultSmaller(200, 199)).toBe(true);
    expect(isCompressionResultSmaller(200, 200)).toBe(false);
    expect(isCompressionResultSmaller(200, 201)).toBe(false);
  });
});
