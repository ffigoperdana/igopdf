import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import { repairPdfEditorFontResources } from '../js/utils/pdf-editor-compatibility';

async function createPdfWithHelveticaResource(
  helveticaRef: 'invalid' | 'valid'
): Promise<File> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage();
  const validFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fonts = pdfDoc.context.obj({
    FXF_Helvetica: validFont.ref,
    Helv: helveticaRef === 'invalid' ? PDFRef.of(0, 0) : validFont.ref,
  });
  const acroForm = pdfDoc.context.obj({
    DA: PDFName.of('Helv'),
    DR: { Font: fonts },
  });
  pdfDoc.catalog.set(PDFName.of('AcroForm'), acroForm);

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new File([buffer], 'test.pdf', {
    type: 'application/pdf',
    lastModified: 123,
  });
}

function getHelveticaResource(pdfDoc: PDFDocument): PDFRef {
  const acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const resources = acroForm.lookup(PDFName.of('DR'), PDFDict);
  const fonts = resources.lookup(PDFName.of('Font'), PDFDict);
  return fonts.get(PDFName.of('Helv')) as PDFRef;
}

describe('PDF editor compatibility repair', () => {
  it('creates AcroForm font resources when the PDF has none', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage();
    const bytes = await pdfDoc.save();
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const input = new File([buffer], 'without-acroform.pdf', {
      type: 'application/pdf',
    });

    const repaired = await repairPdfEditorFontResources(input);
    const repairedDoc = await PDFDocument.load(await repaired.arrayBuffer());
    const helvetica = getHelveticaResource(repairedDoc);

    expect(repaired).not.toBe(input);
    expect(helvetica.objectNumber).toBeGreaterThan(0);
    expect(repairedDoc.context.lookupMaybe(helvetica, PDFDict)).toBeInstanceOf(
      PDFDict
    );
  });

  it('replaces a null Helvetica reference with a valid font resource', async () => {
    const input = await createPdfWithHelveticaResource('invalid');

    const repaired = await repairPdfEditorFontResources(input);
    const repairedDoc = await PDFDocument.load(await repaired.arrayBuffer());
    const helvetica = getHelveticaResource(repairedDoc);

    expect(repaired).not.toBe(input);
    expect(repaired.name).toBe(input.name);
    expect(repaired.lastModified).toBe(input.lastModified);
    expect(helvetica.objectNumber).toBeGreaterThan(0);
    expect(repairedDoc.context.lookupMaybe(helvetica, PDFDict)).toBeInstanceOf(
      PDFDict
    );
  });

  it('leaves PDFs with a valid Helvetica resource untouched', async () => {
    const input = await createPdfWithHelveticaResource('valid');

    const result = await repairPdfEditorFontResources(input);

    expect(result).toBe(input);
  });
});
