import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';

const HELVETICA_RESOURCE = PDFName.of('Helv');
const PDFIUM_HELVETICA_RESOURCE = PDFName.of('FXF_Helvetica');

function containsInvalidHelveticaReference(bytes: Uint8Array): boolean {
  const marker = [0x2f, 0x48, 0x65, 0x6c, 0x76]; // /Helv

  for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    if (!marker.every((value, offset) => bytes[index + offset] === value)) {
      continue;
    }

    let cursor = index + marker.length;
    const skipWhitespace = () => {
      while (
        cursor < bytes.length &&
        [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[cursor])
      ) {
        cursor += 1;
      }
    };

    skipWhitespace();
    if (bytes[cursor] !== 0x30) continue;
    cursor += 1;
    skipWhitespace();
    if (bytes[cursor] !== 0x30) continue;
    cursor += 1;
    skipWhitespace();
    if (bytes[cursor] === 0x52) return true; // R
  }

  return false;
}

function lookupDict(
  pdfDoc: PDFDocument,
  parent: PDFDict,
  key: PDFName
): PDFDict | undefined {
  const value = parent.get(key);
  if (!value) return undefined;
  if (value instanceof PDFDict) return value;
  return pdfDoc.context.lookupMaybe(value, PDFDict);
}

/**
 * Repairs a malformed `/Helv 0 0 R` AcroForm font resource before PDFium
 * opens the document. PDFium can otherwise persist a FreeText annotation but
 * fail to generate its `/AP`, leaving the text invisible after export.
 *
 * Files without the malformed marker are returned byte-for-byte unchanged.
 */
export async function repairPdfEditorFontResources(file: File): Promise<File> {
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  if (!containsInvalidHelveticaReference(originalBytes)) return file;

  try {
    const pdfDoc = await PDFDocument.load(originalBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const acroForm = lookupDict(pdfDoc, pdfDoc.catalog, PDFName.of('AcroForm'));
    const defaultResources = acroForm
      ? lookupDict(pdfDoc, acroForm, PDFName.of('DR'))
      : undefined;
    const fonts = defaultResources
      ? lookupDict(pdfDoc, defaultResources, PDFName.of('Font'))
      : undefined;
    const helvetica = fonts?.get(HELVETICA_RESOURCE);

    if (
      !fonts ||
      !(helvetica instanceof PDFRef) ||
      helvetica.objectNumber !== 0
    ) {
      return file;
    }

    const pdfiumHelvetica = fonts.get(PDFIUM_HELVETICA_RESOURCE);
    const validPdfiumHelvetica =
      pdfiumHelvetica instanceof PDFRef &&
      pdfiumHelvetica.objectNumber > 0 &&
      pdfDoc.context.lookupMaybe(pdfiumHelvetica, PDFDict)
        ? pdfiumHelvetica
        : null;
    const replacement =
      validPdfiumHelvetica ??
      (await pdfDoc.embedFont(StandardFonts.Helvetica)).ref;

    fonts.set(HELVETICA_RESOURCE, replacement);

    const repairedBytes = await pdfDoc.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    const repairedBuffer = repairedBytes.buffer.slice(
      repairedBytes.byteOffset,
      repairedBytes.byteOffset + repairedBytes.byteLength
    ) as ArrayBuffer;
    return new File([repairedBuffer], file.name, {
      type: file.type || 'application/pdf',
      lastModified: file.lastModified,
    });
  } catch (error) {
    console.warn(
      '[PDF Editor] Could not repair the malformed Helvetica resource; using the original file.',
      error
    );
    return file;
  }
}
