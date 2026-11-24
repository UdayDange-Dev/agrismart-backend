const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text before it is placed in any HTML context (e.g. ERPNext comments). */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * Convert ERPNext rich text (HTML) into plain text. The result is rendered by React
 * as text, so this is formatting cleanup rather than the security boundary.
 */
export function htmlToPlainText(html: string | null | undefined, maxLength = 5000): string {
  if (!html) return '';
  return html
    .slice(0, maxLength * 4)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

/** Collapse whitespace for single-line fields. */
export const normalizeLine = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim();
