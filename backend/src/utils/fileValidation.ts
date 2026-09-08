import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

export type ComplaintCategory =
  | 'main_feature'
  | 'other_feature'
  | 'non_feature';

export type StoredFileKind =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'txt'
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'mp4';

export type GuideAssetType = 'pdf' | 'video' | 'pptx';

export interface ValidatedStoredFile {
  fileName: string;
  kind: StoredFileKind;
  mimeType: string;
}

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}

const MIME_TYPES: Record<StoredFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

// Complaints can include safe document or image evidence. Video is deliberately
// excluded: it is not needed for an aduan and would expand the upload attack
// surface as well as the storage footprint substantially.
const COMPLAINT_DOCUMENT_AND_IMAGE_EXTENSION_MAP: Record<
  string,
  StoredFileKind
> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.txt': 'txt',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

const PDF_SIGNATURE = Buffer.from('%PDF-', 'ascii');

const OFFICE_MAIN_CONTENT_TYPES: Record<'docx' | 'xlsx' | 'pptx', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};

const GUIDE_ASSET_FORMATS: Record<
  GuideAssetType,
  { extension: string; kind: StoredFileKind; mimeType: string }
> = {
  pdf: { extension: '.pdf', kind: 'pdf', mimeType: MIME_TYPES.pdf },
  video: { extension: '.mp4', kind: 'mp4', mimeType: MIME_TYPES.mp4 },
  pptx: { extension: '.pptx', kind: 'pptx', mimeType: MIME_TYPES.pptx },
};

function cleanFileName(value: string): string {
  const basename = path.basename(value.replace(/\\/g, '/')).normalize('NFKC');
  const cleaned = Array.from(basename)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new FileValidationError('Nama file tidak valid');
  }

  return Array.from(cleaned).slice(0, 255).join('');
}

function fileKindFromName(
  fileName: string,
  category: ComplaintCategory
): ValidatedStoredFile {
  const safeName = cleanFileName(fileName);
  const extension = path.extname(safeName).toLowerCase();

  // A sample for the main PDF tools must remain a PDF so it can be used as a
  // reproducible baseline. Other-feature and non-feature complaints may add
  // document/image evidence, but never video.
  if (category === 'main_feature') {
    if (extension !== '.pdf') {
      throw new FileValidationError(
        'Aduan terkait fitur hanya menerima lampiran PDF'
      );
    }
    return { fileName: safeName, kind: 'pdf', mimeType: MIME_TYPES.pdf };
  }

  const kind = COMPLAINT_DOCUMENT_AND_IMAGE_EXTENSION_MAP[extension];
  if (!kind) {
    throw new FileValidationError(
      'Jenis file tidak diizinkan. Gunakan PDF, DOCX, XLSX, PPTX, TXT, atau gambar.'
    );
  }
  return { fileName: safeName, kind, mimeType: MIME_TYPES[kind] };
}

export function validateComplaintFileName(
  fileName: string,
  category: ComplaintCategory
): ValidatedStoredFile {
  return fileKindFromName(fileName, category);
}

export function validateGuideFileName(
  fileName: string,
  assetType: GuideAssetType
): ValidatedStoredFile {
  const safeName = cleanFileName(fileName);
  const extension = path.extname(safeName).toLowerCase();
  const expected = GUIDE_ASSET_FORMATS[assetType];
  if (extension === expected.extension) {
    return { fileName: safeName, ...expected };
  }
  throw new FileValidationError(
    assetType === 'pdf'
      ? 'Materi PDF harus berekstensi .pdf'
      : assetType === 'video'
        ? 'Materi video harus berekstensi .mp4'
        : 'Materi PowerPoint harus berekstensi .pptx'
  );
}

export function guideAssetExtension(assetType: GuideAssetType): string {
  return GUIDE_ASSET_FORMATS[assetType].extension.slice(1);
}

export function guideAssetMimeType(assetType: GuideAssetType): string {
  return GUIDE_ASSET_FORMATS[assetType].mimeType;
}

async function readHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hasPdfSignature(header: Buffer): boolean {
  return header.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}

function hasJpegSignature(header: Buffer): boolean {
  return (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  );
}

function hasPngSignature(header: Buffer): boolean {
  return header
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function hasWebpSignature(header: Buffer): boolean {
  return (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function hasMp4Signature(header: Buffer): boolean {
  return (
    header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp'
  );
}

function hasZipSignature(header: Buffer): boolean {
  return (
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    header[2] === 0x03 &&
    header[3] === 0x04
  );
}

function looksLikeUtf8Text(header: Buffer): boolean {
  if (header.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(header);
    let controls = 0;
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (
        code < 32 &&
        character !== '\n' &&
        character !== '\r' &&
        character !== '\t'
      ) {
        controls += 1;
      }
    }
    return controls / Math.max(text.length, 1) < 0.01;
  } catch {
    return false;
  }
}

function contentMatchesKind(header: Buffer, kind: StoredFileKind): boolean {
  switch (kind) {
    case 'pdf':
      return hasPdfSignature(header);
    case 'jpeg':
      return hasJpegSignature(header);
    case 'png':
      return hasPngSignature(header);
    case 'webp':
      return hasWebpSignature(header);
    case 'mp4':
      return hasMp4Signature(header);
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return hasZipSignature(header);
    case 'txt':
      return looksLikeUtf8Text(header);
  }
}

async function hasExpectedOfficePackage(
  filePath: string,
  kind: 'docx' | 'xlsx' | 'pptx'
): Promise<boolean> {
  try {
    const archive = await JSZip.loadAsync(await readFile(filePath), {
      checkCRC32: false,
      createFolders: false,
    });
    const entries = Object.keys(archive.files);
    if (entries.length === 0 || entries.length > 10_000) return false;

    const contentTypes = archive.file('[Content_Types].xml');
    if (!contentTypes) return false;
    const xml = await contentTypes.async('text');
    const expectedType = OFFICE_MAIN_CONTENT_TYPES[kind];
    return (
      xml.includes(`ContentType="${expectedType}"`) ||
      xml.includes(`ContentType='${expectedType}'`)
    );
  } catch {
    return false;
  }
}

function isOfficeKind(kind: StoredFileKind): kind is 'docx' | 'xlsx' | 'pptx' {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx';
}

export async function assertFileMatchesKind(
  filePath: string,
  expected: ValidatedStoredFile
): Promise<ValidatedStoredFile> {
  const header = await readHeader(filePath);
  const contentIsValid = contentMatchesKind(header, expected.kind);
  const officePackageIsValid = isOfficeKind(expected.kind)
    ? contentIsValid &&
      (await hasExpectedOfficePackage(filePath, expected.kind))
    : true;
  if (!contentIsValid || !officePackageIsValid) {
    throw new FileValidationError(
      'Isi file tidak sesuai dengan jenis file yang diizinkan'
    );
  }
  return expected;
}
