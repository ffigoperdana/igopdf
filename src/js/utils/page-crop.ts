import type { PDFPage } from 'pdf-lib';

export interface NormalizedCropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VisualCropBox = NormalizedCropBox;

const EPSILON = 0.0005;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeQuarterTurn(rotation: number): 0 | 90 | 180 | 270 {
  const normalized = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  return normalized as 0 | 90 | 180 | 270;
}

export function clampNormalizedCrop(
  crop: NormalizedCropBox
): NormalizedCropBox {
  const x = clamp(crop.x);
  const y = clamp(crop.y);
  const width = clamp(crop.width, 0, 1 - x);
  const height = clamp(crop.height, 0, 1 - y);
  return { x, y, width, height };
}

export function visualCropToSourceCrop(
  visualCrop: VisualCropBox,
  rotation: number
): NormalizedCropBox {
  const { x, y, width, height } = clampNormalizedCrop(visualCrop);

  switch (normalizeQuarterTurn(rotation)) {
    case 90:
      return clampNormalizedCrop({ x: y, y: x, width: height, height: width });
    case 180:
      return clampNormalizedCrop({
        x: 1 - x - width,
        y,
        width,
        height,
      });
    case 270:
      return clampNormalizedCrop({
        x: 1 - y - height,
        y: 1 - x - width,
        width: height,
        height: width,
      });
    default:
      return clampNormalizedCrop({
        x,
        y: 1 - y - height,
        width,
        height,
      });
  }
}

export function sourceCropToVisualCrop(
  sourceCrop: NormalizedCropBox,
  rotation: number
): VisualCropBox {
  const { x, y, width, height } = clampNormalizedCrop(sourceCrop);

  switch (normalizeQuarterTurn(rotation)) {
    case 90:
      return clampNormalizedCrop({ x: y, y: x, width: height, height: width });
    case 180:
      return clampNormalizedCrop({
        x: 1 - x - width,
        y,
        width,
        height,
      });
    case 270:
      return clampNormalizedCrop({
        x: 1 - y - height,
        y: 1 - x - width,
        width: height,
        height: width,
      });
    default:
      return clampNormalizedCrop({
        x,
        y: 1 - y - height,
        width,
        height,
      });
  }
}

export function isFullPageCrop(crop: NormalizedCropBox): boolean {
  const normalized = clampNormalizedCrop(crop);
  return (
    normalized.x <= EPSILON &&
    normalized.y <= EPSILON &&
    Math.abs(normalized.width - 1) <= EPSILON &&
    Math.abs(normalized.height - 1) <= EPSILON
  );
}

export function applyNormalizedCropToPage(
  page: PDFPage,
  crop?: NormalizedCropBox
): void {
  if (!crop || isFullPageCrop(crop)) return;

  const normalized = clampNormalizedCrop(crop);
  const base = page.getCropBox();
  page.setCropBox(
    base.x + normalized.x * base.width,
    base.y + normalized.y * base.height,
    normalized.width * base.width,
    normalized.height * base.height
  );
}
