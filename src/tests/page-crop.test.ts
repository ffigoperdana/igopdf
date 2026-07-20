import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  applyNormalizedCropToPage,
  sourceCropToVisualCrop,
  visualCropToSourceCrop,
} from '../js/utils/page-crop';

describe('page crop coordinates', () => {
  const visualCrop = { x: 0.1, y: 0.2, width: 0.55, height: 0.4 };

  it.each([
    [0, { x: 0.1, y: 0.4, width: 0.55, height: 0.4 }],
    [90, { x: 0.2, y: 0.1, width: 0.4, height: 0.55 }],
    [180, { x: 0.35, y: 0.2, width: 0.55, height: 0.4 }],
    [270, { x: 0.4, y: 0.35, width: 0.4, height: 0.55 }],
  ])(
    'maps the visible crop to source coordinates at %i degrees',
    (rotation, expected) => {
      const source = visualCropToSourceCrop(visualCrop, rotation);
      expect(source.x).toBeCloseTo(expected.x);
      expect(source.y).toBeCloseTo(expected.y);
      expect(source.width).toBeCloseTo(expected.width);
      expect(source.height).toBeCloseTo(expected.height);
    }
  );

  it.each([0, 90, 180, 270])(
    'round-trips visual crop at %i degrees',
    (rotation) => {
      const source = visualCropToSourceCrop(visualCrop, rotation);
      const restored = sourceCropToVisualCrop(source, rotation);
      expect(restored.x).toBeCloseTo(visualCrop.x);
      expect(restored.y).toBeCloseTo(visualCrop.y);
      expect(restored.width).toBeCloseTo(visualCrop.width);
      expect(restored.height).toBeCloseTo(visualCrop.height);
    }
  );

  it('writes the normalized crop into the PDF crop box', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([600, 800]);
    applyNormalizedCropToPage(page, {
      x: 0.1,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });

    expect(page.getCropBox()).toEqual({
      x: 60,
      y: 200,
      width: 300,
      height: 400,
    });
  });

  it('applies a new crop relative to an existing PDF crop box', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([600, 800]);
    page.setCropBox(50, 100, 500, 600);

    applyNormalizedCropToPage(page, {
      x: 0.2,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    });

    expect(page.getCropBox()).toEqual({
      x: 150,
      y: 250,
      width: 250,
      height: 300,
    });
  });
});
