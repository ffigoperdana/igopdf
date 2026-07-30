import type { CompressionMode } from './compressionJobService.js';

const MEBIBYTE = 1024 * 1024;

export const LARGE_BALANCED_PDF_BYTES = 200 * MEBIBYTE;

export type CompressionProfile = 'lossless' | 'balanced' | 'balanced-large';

export interface CompressionCommandInput {
  inputBytes: number;
  mode: CompressionMode;
  inputPath: string;
  outputPath: string;
}

export interface CompressionCommand {
  executable: 'gs' | 'qpdf';
  args: string[];
  profile: CompressionProfile;
}

export type CompressionOutputDecision =
  | 'accept-output'
  | 'retry-lossless'
  | 'preserve-original';

export interface CompressionOutputDecisionInput {
  requestedMode: CompressionMode;
  attemptedMode: CompressionMode;
  inputBytes: number;
  outputBytes: number;
}

interface GhostscriptImageProfile {
  colorResolution: number;
  grayResolution: number;
  monoResolution: number;
  downsampleThreshold: number;
  qFactor: number;
}

const BALANCED_PROFILE: GhostscriptImageProfile = {
  colorResolution: 120,
  grayResolution: 120,
  monoResolution: 300,
  downsampleThreshold: 1.1,
  qFactor: 0.78,
};

const LARGE_BALANCED_PROFILE: GhostscriptImageProfile = {
  colorResolution: 96,
  grayResolution: 96,
  monoResolution: 300,
  downsampleThreshold: 1.05,
  // Ghostscript's QFactor rises with JPEG quality/file size; 0.70 is the
  // documented pdfwrite example and is intentionally lower than balanced.
  qFactor: 0.7,
};

export function selectBalancedCompressionProfile(
  inputBytes: number
): Exclude<CompressionProfile, 'lossless'> {
  return inputBytes >= LARGE_BALANCED_PDF_BYTES ? 'balanced-large' : 'balanced';
}

function imageProfileFor(
  profile: Exclude<CompressionProfile, 'lossless'>
): GhostscriptImageProfile {
  return profile === 'balanced-large'
    ? LARGE_BALANCED_PROFILE
    : BALANCED_PROFILE;
}

function distillerImageSettings(profile: GhostscriptImageProfile): string {
  const jpegSettings =
    `/QFactor ${profile.qFactor} /Blend 1 /ColorTransform 1 ` +
    '/HSamples [2 1 1 2] /VSamples [2 1 1 2]';
  const graySettings =
    `/QFactor ${profile.qFactor} /Blend 1 ` +
    '/HSamples [1 1 1 1] /VSamples [1 1 1 1]';

  return (
    `<< /ColorImageDict << ${jpegSettings} >> ` +
    `/GrayImageDict << ${graySettings} >> ` +
    '/LockDistillerParams true >> setdistillerparams'
  );
}

export function decideCompressionOutput({
  requestedMode,
  attemptedMode,
  inputBytes,
  outputBytes,
}: CompressionOutputDecisionInput): CompressionOutputDecision {
  if (outputBytes < inputBytes) return 'accept-output';

  if (requestedMode === 'balanced' && attemptedMode === 'balanced') {
    return 'retry-lossless';
  }

  return 'preserve-original';
}

export function buildCompressionCommand({
  inputBytes,
  mode,
  inputPath,
  outputPath,
}: CompressionCommandInput): CompressionCommand {
  if (mode === 'lossless') {
    return {
      executable: 'qpdf',
      profile: 'lossless',
      args: [
        '--warning-exit-0',
        '--compress-streams=y',
        '--decode-level=generalized',
        '--recompress-flate',
        '--compression-level=9',
        '--object-streams=generate',
        inputPath,
        outputPath,
      ],
    };
  }

  const profileName = selectBalancedCompressionProfile(inputBytes);
  const profile = imageProfileFor(profileName);

  return {
    executable: 'gs',
    profile: profileName,
    args: [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.7',
      '-dAutoRotatePages=/None',
      '-dDetectDuplicateImages=true',
      '-dCompressPages=true',
      '-dCompressFonts=true',
      '-dCompressStreams=true',
      '-dSubsetFonts=true',
      '-dEmbedAllFonts=true',
      '-dPreserveAnnots=true',
      '-dDownsampleColorImages=true',
      '-dColorImageDownsampleType=/Bicubic',
      `-dColorImageResolution=${profile.colorResolution}`,
      `-dColorImageDownsampleThreshold=${profile.downsampleThreshold}`,
      '-dEncodeColorImages=true',
      '-dAutoFilterColorImages=false',
      '-dColorImageFilter=/DCTEncode',
      '-dDownsampleGrayImages=true',
      '-dGrayImageDownsampleType=/Bicubic',
      `-dGrayImageResolution=${profile.grayResolution}`,
      `-dGrayImageDownsampleThreshold=${profile.downsampleThreshold}`,
      '-dEncodeGrayImages=true',
      '-dAutoFilterGrayImages=false',
      '-dGrayImageFilter=/DCTEncode',
      '-dDownsampleMonoImages=true',
      '-dMonoImageDownsampleType=/Subsample',
      `-dMonoImageResolution=${profile.monoResolution}`,
      '-dMonoImageDownsampleThreshold=1.1',
      '-dEncodeMonoImages=true',
      '-dMonoImageFilter=/CCITTFaxEncode',
      // The pdfwrite defaults pass already-compressed JPEG/JPX streams through.
      // Disabling pass-through is essential for photo-heavy PDFs whose images
      // are below the old /ebook preset's 225 DPI effective threshold.
      '-dPassThroughJPEGImages=false',
      '-dPassThroughJPXImages=false',
      `-sOutputFile=${outputPath}`,
      '-c',
      distillerImageSettings(profile),
      '-f',
      inputPath,
    ],
  };
}
