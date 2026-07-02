import { ClassicPreset } from 'rete';
import * as pdfjsLib from 'pdfjs-dist';
import type { NodeCategory, NodeMeta, SocketData } from '../types';

// Every workflow node extends BaseWorkflowNode, so setting the pdf.js worker
// here guarantees any node that calls pdfjsLib.getDocument directly
// (adjust-colors, greyscale, invert-colors, posterize, remove-blank-pages,
// scanner-effect, watermark, pdf-to-images, …) has it configured before it runs.
// Only loaded on the workflow page, so no homepage-bundle impact.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export abstract class BaseWorkflowNode extends ClassicPreset.Node {
  abstract readonly category: NodeCategory;
  abstract readonly icon: string;
  abstract description: string;

  width = 280;
  height = 140;
  execStatus: 'idle' | 'running' | 'completed' | 'error' = 'idle';
  nodeType: string = '';

  constructor(label: string) {
    super(label);
  }

  abstract data(
    inputs: Record<string, SocketData[]>
  ): Promise<Record<string, SocketData>>;

  getMeta(): NodeMeta {
    return {
      id: this.id,
      label: this.label,
      category: this.category,
      icon: this.icon,
      description: this.description,
    };
  }
}
