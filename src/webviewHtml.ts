/**
 * Escaping primitives for the pairing webview.
 *
 * These live outside `pairing.ts` because that module imports `vscode`, which
 * makes it unloadable under vitest — and escaping is exactly the kind of code
 * that should be under test rather than eyeballed.
 */

/** Escape a value interpolated into HTML text or an attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Embed a string as a JS literal inside an inline `<script>`.
 *
 * `JSON.stringify` alone is not enough: HTML ends the script at the first
 * literal `</script>`, whatever the JS quoting says. U+2028/U+2029 need escaping
 * too — JSON leaves them raw, but a JS parser treats them as line terminators.
 *
 * Every field that reaches the pairing URL is `encodeURIComponent`'d today, so
 * `<` cannot survive to get here. That is a property of the URL builder though,
 * not of this sink, and a sink should not depend on its callers staying careful.
 */
export function embedJsString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
