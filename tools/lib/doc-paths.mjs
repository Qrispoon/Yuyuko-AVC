// Parse documented repository paths without running the release checker.
const PATH_TOKEN = /^(?:docs|tools|src|tests|web)\/[A-Za-z0-9_./-]+$/;
const AUDIT_TEMPLATE = 'docs/audits/YYYY-MM-DD/PROJECT_AUDIT.md';

export function collectDocPaths(text, { documentPath = '' } = {}) {
  const source = String(text);
  const lines = source.split(/\r?\n/);
  const result = [];
  for (const span of source.matchAll(/`([^`\n]+)`/g)) {
    const line = source.slice(0, span.index).split('\n').length;
    for (const raw of span[1].split(/\s+/)) {
      const token = raw.replace(/[.,;:!?，。；：、]+$/, '');
      if (!PATH_TOKEN.test(token)) continue;
      let kind = token.split('/').includes('..') ? 'unsafe' : 'literal';
      // Only this explicitly declared date template is exempt; real audit links
      // and arbitrary uppercase paths must still exist.
      if (token === AUDIT_TEMPLATE && documentPath.replace(/\\/g, '/') === 'docs/PROJECT_AUDIT_PROMPT.md' && /日期采用实际审查日期/.test(lines[line - 1])) kind = 'template';
      result.push({ path: token, line, kind });
    }
  }
  return result;
}

export async function invalidDocPaths(text, { documentPath = '', exists } = {}) {
  if (typeof exists !== 'function') throw new TypeError('exists callback required');
  const invalid = [];
  for (const reference of collectDocPaths(text, { documentPath })) {
    if (reference.kind === 'unsafe' || reference.kind === 'literal' && !await exists(reference.path)) invalid.push(reference);
  }
  return invalid;
}
