import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  buildPresentation,
  materializeAllSlideNodes,
  parseZipLazyMedia,
  RECOMMENDED_ZIP_LIMITS,
} from '@aiden0z/pptx-renderer/browser';
import { normalizeOfficeSvgBlips } from '../js/support/pptx-svg-fallback';

describe('normalizeOfficeSvgBlips', () => {
  it('makes an Office SVG extension available as a regular blip relationship', () => {
    const source = `
      <p:pic>
        <p:blipFill>
          <a:blip>
            <a:extLst>
              <a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">
                <asvg:svgBlip r:embed="rId3"/>
              </a:ext>
            </a:extLst>
          </a:blip>
        </p:blipFill>
      </p:pic>`;

    const result = normalizeOfficeSvgBlips(source);

    expect(result.patchedCount).toBe(1);
    expect(result.source).toContain('<a:blip r:embed="rId3">');
    expect(result.source).toContain('<asvg:svgBlip r:embed="rId3"/>');
  });

  it('does not overwrite an existing image relationship', () => {
    const source = `
      <a:blip r:embed="rId2">
        <a:extLst><a:ext><asvg:svgBlip r:embed="rId3"/></a:ext></a:extLst>
      </a:blip>`;

    const result = normalizeOfficeSvgBlips(source);

    expect(result.patchedCount).toBe(0);
    expect(result.source).toBe(source);
  });

  it('leaves non-SVG graphics untouched', () => {
    const source = '<a:blip><a:extLst><a:ext/></a:extLst></a:blip>';

    const result = normalizeOfficeSvgBlips(source);

    expect(result.patchedCount).toBe(0);
    expect(result.source).toBe(source);
  });

  it('feeds the SVG relationship into the renderer model before slides render', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    );
    zip.file(
      'ppt/presentation.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:sldSz cx="12192000" cy="6858000"/>
        <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      </p:presentation>`
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      </Relationships>`
    );
    zip.file(
      'ppt/slides/slide1.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"
        xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld><p:spTree>
          <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
          <p:grpSpPr/>
          <p:pic>
            <p:nvPicPr><p:cNvPr id="2" name="Graphic 5"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
            <p:blipFill><a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="rId3"/></a:ext></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>
            <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
          </p:pic>
        </p:spTree></p:cSld>
      </p:sld>`
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.svg"/>
      </Relationships>`
    );
    zip.file(
      'ppt/media/image1.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"/>'
    );

    const files = await parseZipLazyMedia(
      await zip.generateAsync({ type: 'arraybuffer' }),
      RECOMMENDED_ZIP_LIMITS
    );
    const presentation = buildPresentation(files, { lazySlides: true });
    const slide = presentation.slides[0];
    const normalized = normalizeOfficeSvgBlips(slide.sourceXml || '');
    slide.sourceXml = normalized.source;
    materializeAllSlideNodes(presentation);

    expect(normalized.patchedCount).toBe(1);
    expect(slide.nodes[0]).toMatchObject({
      nodeType: 'picture',
      blipEmbed: 'rId3',
    });
  });
});
