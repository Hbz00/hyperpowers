/**
 * The three Mermaid forms that stop a diagram rendering, refused before publication (§V24).
 *
 * Literal checks, not a parser: zero dependencies, and a hand-rolled grammar would be a second
 * thing to be wrong. This rejects what is known to fail and says nothing about the rest.
 */

/** @returns {string[]} one message per problem, empty when the source is safe to publish. */
export function lintMermaid(source) {
  const problems = [];
  if (/\\n/.test(source)) problems.push('`\\n` is not a line break in Mermaid. Use `<br/>`.');
  if (/\\"/.test(source)) {
    problems.push('`\\"` inside a label: Mermaid ends the label at the first `"`, so the rest is a syntax error. Use `#quot;`.');
  }
  // Scoped to quoted labels: `#` is legitimate in `style … fill:#f9f`, and a guard that rejects
  // valid syntax gets removed.
  for (const [, inner] of source.matchAll(/"([^"\n]*)"/g)) {
    if (/#(?![0-9a-zA-Z]+;)/.test(inner)) {
      problems.push(`\`#\` in the label "${inner.slice(0, 40)}" opens an entity code. Use \`#35;\`.`);
      break;
    }
  }
  return problems;
}

/**
 * The diagram source, from either container. Both are live — the page is HTML now and was Markdown
 * before — and reading only the fence would silently empty `diagram.mmd` on every HTML page.
 */
export function extractMermaid(page) {
  const match = /```mermaid\s*\n([\s\S]*?)```/.exec(page)
    ?? /<pre[^>]*class=["'][^"']*\bmermaid\b[^"']*["'][^>]*>([\s\S]*?)<\/pre>/i.exec(page);
  return match && match[1].trim() ? match[1].trim() : null;
}
