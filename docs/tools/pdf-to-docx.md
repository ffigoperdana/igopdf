---
title: PDF to Word
description: Convert internal PDF files to DOCX using browser conversion or a private, temporary IGO server job.
---

# PDF to Word

IGO offers three DOCX conversion modes selected after the PDF is inspected. The tool samples up to five pages locally to identify whether the document contains a usable text layer, mixed content, or scanned/image-only pages.

## Conversion Modes

- **Auto**: uses editable conversion for native-text PDFs and OCR for image-based or mixed PDFs.
- **Editable text**: reconstructs Word paragraphs, basic formatting, and layout from the PDF text layer. It is the best option for office PDFs exported from Word, PowerPoint, or similar applications.
- **OCR text**: renders each page and recognizes Indonesian and English text. This helps with scanned documents, but spelling, tables, and positions need review.
- **Visual layout**: places each PDF page as an image in DOCX. This preserves the page appearance most reliably, but the page content is not editable as Word text.

## Private Processing

Small native-text PDFs are converted in the browser. OCR, repair fallback, visual-layout conversion, and files that exceed the browser threshold are processed on the private IGO server.

Server conversion uses resumable, chunked upload and a single heavy-job queue shared with server-side compression. Source PDFs and generated DOCX files are stored only in the private job volume, scoped to the signed-in user, and deleted automatically after download or the configured retention period. No file is sent to an external conversion service.

## Limits

- Maximum PDF size for this deployment: **50 MB per file**.
- Editable mode: up to **200 pages**.
- OCR and visual-layout modes: up to **100 pages**.
- Server conversion processes one PDF at a time. A later job remains queued until the current heavy job, including server-side compression, has completed.

These limits protect the 2 vCPU / 6 GB production VM. A complex scanned PDF can require substantially more memory than its original file size suggests.

## Quality Expectations

- DOCX is a reconstruction, not the original source file. Review fonts, tables, page breaks, spacing, and complex layout after conversion.
- A scanned PDF does not contain editable text. Use **OCR text** when editable text is required, or **Visual layout** when appearance is more important.
- Some PDFs contain invalid font references or damaged cross-reference data. IGO automatically attempts a safe repair for editable conversion; if it still fails, use OCR or visual layout, or export the PDF again from the source application.

## Output

- A single PDF downloads as `filename.docx`.
- Browser mode can convert a batch of compatible native-text PDFs into `converted-documents.zip`.
- Server modes intentionally process one PDF per job to preserve predictable memory usage and queue order.

## Related Tools

- [OCR PDF](./ocr-pdf)
- [PDF to Text](./pdf-to-text)
- [Edit PDF](./edit-pdf)
