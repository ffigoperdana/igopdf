import type { PdfDocumentObject } from '@embedpdf/models';

export interface DocManagerPlugin {
  onDocumentClosed: (
    callback: (data: { id?: string } | string) => void
  ) => void;
  onDocumentOpened: (
    callback: (data: { id?: string; name?: string }) => void
  ) => void;
  openDocumentBuffer: (opts: {
    buffer: ArrayBuffer;
    name?: string;
    autoActivate?: boolean;
  }) => void;
  closeDocument: (id: string) => void;
  getActiveDocumentId: () => string | null;
  getDocument: (id: string) => PdfDocumentObject | null;
  saveAsCopy: (id: string) => Promise<Uint8Array>;
}
