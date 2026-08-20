let cpdfLoaded = false;

function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return fallback;
}

function postProgress(stage, progress, current, total) {
  self.postMessage({
    status: 'progress',
    stage,
    progress: Math.max(0, Math.min(100, progress)),
    ...(current === undefined ? {} : { current }),
    ...(total === undefined ? {} : { total }),
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadCpdf(cpdfUrl) {
  if (cpdfLoaded) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (typeof coherentpdf !== 'undefined') {
      cpdfLoaded = true;
      resolve();
      return;
    }

    try {
      self.importScripts(cpdfUrl);
      cpdfLoaded = true;
      resolve();
    } catch (error) {
      reject(
        new Error(
          'Failed to load CoherentPDF: ' +
            errorMessage(error, 'unknown loading error')
        )
      );
    }
  });
}

self.onmessage = async function (e) {
  const { command, files, jobs, cpdfUrl, retainPageLabels } = e.data || {};

  try {
    if (!cpdfUrl) {
      throw new Error(
        'CoherentPDF URL not provided. Please configure it in WASM Settings.'
      );
    }

    postProgress('loading-engine', 5);
    await loadCpdf(cpdfUrl);

    if (command !== 'merge') {
      throw new Error('Unknown merge worker command.');
    }

    await mergePDFs(
      Array.isArray(files) ? files : [],
      Array.isArray(jobs) ? jobs : [],
      retainPageLabels === true
    );
  } catch (error) {
    self.postMessage({
      status: 'error',
      message: errorMessage(error, 'Unknown error during merge'),
    });
  }
};

async function mergePDFs(files, jobs, retainPageLabels) {
  const loadedPdfs = {};
  const pdfsToMerge = [];
  const rangesToMerge = [];
  let mergedPdf;

  try {
    if (files.length === 0) {
      throw new Error('No PDF files were provided for merging.');
    }

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file || !file.name || !file.data) {
        throw new Error(`Invalid PDF data for file ${index + 1}.`);
      }

      const uint8Array = new Uint8Array(file.data);
      loadedPdfs[file.name] = coherentpdf.fromMemory(uint8Array, '');
      postProgress(
        'loading-files',
        10 + ((index + 1) / files.length) * 30,
        index + 1,
        files.length
      );
      // Let progress messages reach the UI before parsing the next file.
      await yieldToEventLoop();
    }

    postProgress('preparing', 45, jobs.length, jobs.length);
    await yieldToEventLoop();

    for (const job of jobs) {
      const sourcePdf = loadedPdfs[job.fileName];
      if (!sourcePdf) continue;

      let range;
      if (job.rangeType === 'all') {
        range = coherentpdf.all(sourcePdf);
      } else if (job.rangeType === 'specific') {
        const rangeString =
          typeof job.rangeString === 'string' ? job.rangeString : '';
        if (rangeString && coherentpdf.validatePagespec(rangeString)) {
          range = coherentpdf.parsePagespec(sourcePdf, rangeString);
        } else {
          range = coherentpdf.all(sourcePdf);
        }
      } else if (job.rangeType === 'single') {
        const pageNum = Number(job.pageIndex) + 1;
        range = coherentpdf.range(pageNum, pageNum);
      } else if (job.rangeType === 'range') {
        range = coherentpdf.range(job.startPage, job.endPage);
      }

      if (range) {
        pdfsToMerge.push(sourcePdf);
        rangesToMerge.push(range);
      }
    }

    if (pdfsToMerge.length === 0) {
      throw new Error('No valid files or pages to merge.');
    }

    postProgress('merging', 55, pdfsToMerge.length, pdfsToMerge.length);
    // mergeSame is synchronous in CoherentPDF. Yield once so the progress
    // state is painted before the potentially expensive operation starts.
    await yieldToEventLoop();
    mergedPdf = coherentpdf.mergeSame(
      pdfsToMerge,
      retainPageLabels,
      true,
      rangesToMerge
    );

    postProgress('finalizing', 90);
    await yieldToEventLoop();

    const mergedPdfBytes = coherentpdf.toMemory(mergedPdf, false, true);
    const outputBytes =
      mergedPdfBytes instanceof Uint8Array
        ? mergedPdfBytes
        : new Uint8Array(mergedPdfBytes);
    const outputBuffer =
      outputBytes.byteOffset === 0 &&
      outputBytes.byteLength === outputBytes.buffer.byteLength
        ? outputBytes.buffer
        : outputBytes.slice().buffer;

    self.postMessage(
      {
        status: 'success',
        pdfBytes: outputBuffer,
      },
      [outputBuffer]
    );
  } finally {
    if (mergedPdf) {
      try {
        coherentpdf.deletePdf(mergedPdf);
      } catch {
        // Best-effort cleanup; the worker is terminated by the caller.
      }
    }

    Object.values(loadedPdfs).forEach((pdf) => {
      try {
        coherentpdf.deletePdf(pdf);
      } catch {
        // Best-effort cleanup; one invalid PDF must not mask the real error.
      }
    });
  }
}
