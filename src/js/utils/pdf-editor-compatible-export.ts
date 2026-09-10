import { PDFDocument } from 'pdf-lib';
import { flattenAnnotations } from './flatten-annotations.js';

/**
 * Produces a PDF that does not leave editor annotations as interactive PDF
 * comments. FreeText annotation appearances are moved into the page content,
 * so recipients that do not support annotations still see the edited text.
 *
 * This operates on an exported copy, never on the document currently open in
 * the editor.
 */
export async function createCompatiblePdfEditorExport(
  source: ArrayBuffer
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(source, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  flattenAnnotations(pdfDoc);

  // Avoid object streams for better interoperability with conservative
  // third-party document previewers and attachment validators.
  return pdfDoc.save({
    addDefaultPage: false,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
}
