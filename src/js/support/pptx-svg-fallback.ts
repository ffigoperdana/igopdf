/**
 * PowerPoint stores some SVG and Office Graphic references as extension
 * children of `a:blip`, instead of putting the relationship on the `a:blip`
 * element itself. The renderer already supports the related media, but cannot
 * resolve a nested relationship. Copy that relationship into the standard
 * location before the slide nodes are materialized.
 */
const BLIP_OPENING = '<a:blip';
const BLIP_CLOSING = '</a:blip>';
const DIRECT_IMAGE_REFERENCE = /\b(?:r:)?(?:embed|link)\s*=/i;
const NESTED_IMAGE_REFERENCE = /\b(?:r:)?embed\s*=\s*(["'])([^"'<>]+)\1/i;

export interface SvgBlipNormalizationResult {
  source: string;
  patchedCount: number;
}

function isXmlWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t'
  );
}

function isBlipOpeningTag(openingTag: string): boolean {
  const characterAfterName = openingTag.charAt(BLIP_OPENING.length);
  return (
    characterAfterName === '>' ||
    characterAfterName === '/' ||
    isXmlWhitespace(characterAfterName)
  );
}

function isSelfClosingTag(openingTag: string): boolean {
  return openingTag.slice(0, -1).trimEnd().endsWith('/');
}

function findXmlTagEnd(source: string, start: number): number {
  let quote = '';

  for (let index = start; index < source.length; index += 1) {
    const character = source.charAt(index);

    if (quote) {
      if (character === quote) quote = '';
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '>') return index;
  }

  return -1;
}

export function normalizeOfficeSvgBlips(
  source: string
): SvgBlipNormalizationResult {
  let patchedCount = 0;
  let cursor = 0;
  let normalized = '';

  // Use a small linear XML scan instead of a regex. A regex can accidentally
  // treat `<a:blip .../>` as the start of the next full `a:blip` element,
  // which is exactly how some Office Graphic references were skipped.
  while (cursor < source.length) {
    const openingStart = source.indexOf(BLIP_OPENING, cursor);

    if (openingStart === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const openingEnd = findXmlTagEnd(
      source,
      openingStart + BLIP_OPENING.length
    );

    if (openingEnd === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const openingTag = source.slice(openingStart, openingEnd + 1);

    if (!isBlipOpeningTag(openingTag) || isSelfClosingTag(openingTag)) {
      normalized += source.slice(cursor, openingEnd + 1);
      cursor = openingEnd + 1;
      continue;
    }

    const closingStart = source.indexOf(BLIP_CLOSING, openingEnd + 1);

    if (closingStart === -1) {
      normalized += source.slice(cursor);
      break;
    }

    const closingEnd = closingStart + BLIP_CLOSING.length;
    const blipAttributes = source.slice(
      openingStart + BLIP_OPENING.length,
      openingEnd
    );
    const children = source.slice(openingEnd + 1, closingStart);
    const relationshipId = children.match(NESTED_IMAGE_REFERENCE)?.[2];

    if (DIRECT_IMAGE_REFERENCE.test(blipAttributes) || !relationshipId) {
      normalized += source.slice(cursor, closingEnd);
      cursor = closingEnd;
      continue;
    }

    patchedCount += 1;
    normalized += `${source.slice(
      cursor,
      openingStart
    )}${BLIP_OPENING}${blipAttributes} r:embed="${relationshipId}">${children}${BLIP_CLOSING}`;
    cursor = closingEnd;
  }

  return { source: normalized, patchedCount };
}
