import { describe, expect, it } from 'vitest';

import { shouldUseServerDocxConversion } from '@/js/logic/pdf-to-docx-page';

const MEBIBYTE = 1024 * 1024;

describe('PDF to DOCX conversion routing', () => {
  it('routes a small single native editable PDF through the enabled server', () => {
    expect(
      shouldUseServerDocxConversion({
        serverEnabled: true,
        fileCount: 1,
        mode: 'editable',
        fileSize: 1 * MEBIBYTE,
        clientMaxBytes: 50 * MEBIBYTE,
        textLayerKind: 'native',
      })
    ).toBe(true);
  });

  it('keeps the browser fallback when the server is disabled', () => {
    expect(
      shouldUseServerDocxConversion({
        serverEnabled: false,
        fileCount: 1,
        mode: 'editable',
        fileSize: 1 * MEBIBYTE,
        clientMaxBytes: 50 * MEBIBYTE,
        textLayerKind: 'native',
      })
    ).toBe(false);
  });

  it('keeps an eligible editable batch in the browser', () => {
    expect(
      shouldUseServerDocxConversion({
        serverEnabled: true,
        fileCount: 2,
        mode: 'editable',
        fileSize: 1 * MEBIBYTE,
        clientMaxBytes: 50 * MEBIBYTE,
        textLayerKind: 'native',
      })
    ).toBe(false);
  });

  it.each([
    ['ocr', 'image'],
    ['visual', 'native'],
    ['editable', 'mixed'],
  ] as const)(
    'retains the server-required route for %s/%s input',
    (mode, textLayerKind) => {
      expect(
        shouldUseServerDocxConversion({
          serverEnabled: false,
          fileCount: 1,
          mode,
          fileSize: 1 * MEBIBYTE,
          clientMaxBytes: 50 * MEBIBYTE,
          textLayerKind,
        })
      ).toBe(true);
    }
  );
});
