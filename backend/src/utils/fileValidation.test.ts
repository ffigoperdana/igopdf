import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileValidationError,
  assertFileMatchesKind,
  validateComplaintFileName,
  validateGuideFileName,
} from './fileValidation.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryFile(
  filename: string,
  content: Buffer
): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'igo-file-validation-')
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, filename);
  await writeFile(filePath, content);
  return filePath;
}

describe('support upload file validation', () => {
  it('requires PDF files for feature-related complaints', async () => {
    expect(() =>
      validateComplaintFileName('sample.exe', 'main_feature')
    ).toThrow(FileValidationError);

    const fakePdf = await temporaryFile(
      'sample.pdf',
      Buffer.from('not a pdf with %PDF- embedded later', 'utf8')
    );
    await expect(
      assertFileMatchesKind(
        fakePdf,
        validateComplaintFileName('sample.pdf', 'main_feature')
      )
    ).rejects.toThrow(FileValidationError);
  });

  it('accepts a PDF signature at the start of the file', async () => {
    const filePath = await temporaryFile(
      'sample.pdf',
      Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF', 'ascii')
    );
    await expect(
      assertFileMatchesKind(
        filePath,
        validateComplaintFileName('sample.pdf', 'main_feature')
      )
    ).resolves.toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' });
  });

  it('checks the OOXML content type instead of trusting a ZIP extension', async () => {
    const fakeOffice = await temporaryFile(
      'sample.docx',
      Buffer.from('PK\u0003\u0004not an Office document', 'binary')
    );
    await expect(
      assertFileMatchesKind(
        fakeOffice,
        validateComplaintFileName('sample.docx', 'non_feature')
      )
    ).rejects.toThrow(FileValidationError);

    const archive = new JSZip();
    archive.file(
      '[Content_Types].xml',
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    archive.file('word/document.xml', '<document/>');
    const validOffice = await temporaryFile(
      'sample.docx',
      await archive.generateAsync({ type: 'nodebuffer' })
    );
    const validated = await assertFileMatchesKind(
      validOffice,
      validateComplaintFileName('sample.docx', 'non_feature')
    );
    expect(validated.kind).toBe('docx');

    // Keep the generated fixture observable in the test if a platform writes
    // a different Buffer implementation than expected.
    expect((await readFile(validOffice)).length).toBeGreaterThan(4);
  });

  it('accepts valid PPTX packages for Guide materials', async () => {
    const archive = new JSZip();
    archive.file(
      '[Content_Types].xml',
      '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
    );
    archive.file('ppt/presentation.xml', '<presentation/>');
    const validPptx = await temporaryFile(
      'guide-material.pptx',
      await archive.generateAsync({ type: 'nodebuffer' })
    );

    await expect(
      assertFileMatchesKind(
        validPptx,
        validateGuideFileName('guide-material.pptx', 'pptx')
      )
    ).resolves.toMatchObject({
      kind: 'pptx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    expect(() => validateGuideFileName('guide-material.pdf', 'pptx')).toThrow(
      FileValidationError
    );
  });
});
