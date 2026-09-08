/**
 * PowerPoint stores some SVG graphics as an Office extension inside `a:blip`
 * instead of putting the relationship directly on the `a:blip` element. The
 * renderer already supports SVG media, but cannot resolve that extension by
 * itself. Copy the existing relationship into the standard location before
 * the slide nodes are materialized.
 */
const BLIP_WITH_CHILDREN = /<a:blip\b([^>]*)>([\s\S]*?)<\/a:blip>/gi;
const RELATIONSHIP_ATTRIBUTE = /\b(?:r:)?embed\s*=/i;
const SVG_BLIP_EMBED =
  /<(?:[\w.-]+:)?svgBlip\b[^>]*\b(?:r:)?embed\s*=\s*(["'])([^"'<>]+)\1[^>]*\/?\s*>/i;

export interface SvgBlipNormalizationResult {
  source: string;
  patchedCount: number;
}

export function normalizeOfficeSvgBlips(
  source: string
): SvgBlipNormalizationResult {
  let patchedCount = 0;

  const normalized = source.replace(
    BLIP_WITH_CHILDREN,
    (match, attributes: string, children: string) => {
      if (RELATIONSHIP_ATTRIBUTE.test(attributes)) return match;

      const svgMatch = children.match(SVG_BLIP_EMBED);
      const relationshipId = svgMatch?.[2];
      if (!relationshipId) return match;

      patchedCount += 1;
      return `<a:blip${attributes} r:embed="${relationshipId}">${children}</a:blip>`;
    }
  );

  return { source: normalized, patchedCount };
}
