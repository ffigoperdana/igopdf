export interface MergeJob {
  fileName: string;
  rangeType: 'all' | 'specific' | 'single' | 'range';
  rangeString?: string;
  pageIndex?: number;
  startPage?: number;
  endPage?: number;
}

export interface MergeFile {
  name: string;
  data: ArrayBuffer;
}

export interface MergeMessage {
  command: 'merge';
  files: MergeFile[];
  jobs: MergeJob[];
  cpdfUrl?: string;
  retainPageLabels?: boolean;
}

export type MergeStage =
  | 'loading-engine'
  | 'loading-files'
  | 'preparing'
  | 'merging'
  | 'finalizing';

export interface MergeProgressResponse {
  status: 'progress';
  stage: MergeStage;
  progress: number;
  current?: number;
  total?: number;
}

export interface MergeSuccessResponse {
  status: 'success';
  pdfBytes: ArrayBuffer;
}

export interface MergeErrorResponse {
  status: 'error';
  message: string;
}

export type MergeResponse =
  | MergeSuccessResponse
  | MergeErrorResponse
  | MergeProgressResponse;
