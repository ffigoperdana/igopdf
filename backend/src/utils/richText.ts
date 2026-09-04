import sanitizeHtml from 'sanitize-html';

export interface SanitizedRichText {
  html: string;
  text: string;
  characterCount: number;
}

const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    'ul',
    'ol',
    'li',
    'blockquote',
    'code',
    'pre',
    'a',
  ],
  allowedAttributes: {
    a: ['href'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    a: ['http', 'https', 'mailto'],
  },
  disallowedTagsMode: 'discard',
};

export function plainTextFromHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeRichText(value: string): SanitizedRichText {
  const html = sanitizeHtml(value, RICH_TEXT_OPTIONS).trim();
  const text = plainTextFromHtml(html);
  return {
    html,
    text,
    characterCount: Array.from(text).length,
  };
}
