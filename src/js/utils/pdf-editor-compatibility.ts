import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib';

const HELVETICA_RESOURCE = PDFName.of('Helv');
const PDFIUM_HELVETICA_RESOURCE = PDFName.of('FXF_Helvetica');

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

function hasValidFontResource(
  pdfDoc: PDFDocument,
  value: ReturnType<PDFDict['get']>
): value is PDFDict | PDFRef {
  if (value instanceof PDFDict) return true;
  return (
    value instanceof PDFRef &&
    value.objectNumber > 0 &&
    Boolean(pdfDoc.context.lookupMaybe(value, PDFDict))
  );
}

/**
 * Ensures PDFium has a valid AcroForm Helvetica resource before opening the
 * document. Without an AcroForm, or with a malformed `/Helv 0 0 R`, PDFium's
 * worker can persist a FreeText annotation but fail to generate its `/AP`,
 * leaving the text invisible after export.
 *
 * Files that already contain a valid Helvetica resource are returned
 * byte-for-byte unchanged.
 */
export async function repairPdfEditorFontResources(file: File): Promise<File> {
  const originalBytes = new Uint8Array(await file.arrayBuffer());

  try {
    const pdfDoc = await PDFDocument.load(originalBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    let changed = false;
    let acroForm = lookupDict(
      pdfDoc,
      pdfDoc.catalog,
      PDFName.of('AcroForm')
    );
    if (!acroForm) {
      acroForm = pdfDoc.context.obj({
        Fields: [],
        DA: PDFString.of('/Helv 12 Tf 0 g'),
      });
      pdfDoc.catalog.set(
        PDFName.of('AcroForm'),
        pdfDoc.context.register(acroForm)
      );
      changed = true;
    }

    let defaultResources = lookupDict(pdfDoc, acroForm, PDFName.of('DR'));
    if (!defaultResources) {
      defaultResources = pdfDoc.context.obj({});
      acroForm.set(PDFName.of('DR'), defaultResources);
      changed = true;
    }

    let fonts = lookupDict(pdfDoc, defaultResources, PDFName.of('Font'));
    if (!fonts) {
      fonts = pdfDoc.context.obj({});
      defaultResources.set(PDFName.of('Font'), fonts);
      changed = true;
    }

    const helvetica = fonts.get(HELVETICA_RESOURCE);
    if (hasValidFontResource(pdfDoc, helvetica)) {
      if (!changed) return file;
    } else {
      const pdfiumHelvetica = fonts.get(PDFIUM_HELVETICA_RESOURCE);
      const validPdfiumHelvetica = hasValidFontResource(
        pdfDoc,
        pdfiumHelvetica
      )
        ? pdfiumHelvetica
        : null;
      const replacement =
        validPdfiumHelvetica ??
        (await pdfDoc.embedFont(StandardFonts.Helvetica)).ref;

      fonts.set(HELVETICA_RESOURCE, replacement);
    }

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
      '[PDF Editor] Could not prepare the Helvetica resource; using the original file.',
      error
    );
    return file;
  }
}
