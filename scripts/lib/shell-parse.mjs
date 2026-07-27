/**
 * A small, deliberately conservative POSIX-shell splitter.
 *
 * Spec §14.4 is explicit that a regex is not sufficient for the Git policy: the hook must
 * decompose the command and "refuse any command it cannot classify safely". This module
 * provides the decomposition; `git-policy.mjs` provides the classification.
 *
 * Design stance: this is NOT a shell. It never evaluates anything. Its only contract is —
 *
 *   1. every simple command that the shell *could* execute appears in the returned list, and
 *   2. anything it cannot confidently decompose is surfaced as `unparseable`, which callers
 *      must treat as a denial.
 *
 * Over-reporting commands is safe (a false denial). Under-reporting is not, so ambiguous
 * constructs (command substitution, `eval`, process substitution) are reported *in addition
 * to* the surrounding command rather than instead of it.
 */

const OPERATORS = [';;', '&&', '||', '|&', ';', '|', '&', '\n'];

/**
 * Redirection operators, longest first.
 *
 * These must be matched *before* `OPERATORS`, and must never be treated as command separators.
 * `>>` was in `OPERATORS`, so `echo x >> .git/config` split into two commands and `.git/config`
 * became a command name — allowed, while the single-`>` form was correctly denied. A redirect
 * target is data, not a command, and the policy has to see it as one.
 */
const REDIRECT_OPERATORS = ['&>>', '<<<', '&>', '>>', '>|', '<>', '<<', '>', '<'];

/**
 * A word plus the provenance a security classifier needs.
 *
 * `quoted` means *some* part of the word was quoted. `startedQuoted` means the word began
 * with a quote character — the distinction matters: in `GIT_SSH_COMMAND="evil" git fetch`
 * the word is partially quoted but its `NAME=` prefix is bare, so it really is an
 * environment assignment. Conflating the two hid the assignment and let the `git fetch`
 * behind it escape classification entirely.
 */
class Word {
  constructor(text, { quoted = false, startedQuoted = false, hadSubstitution = false } = {}) {
    this.text = text;
    this.quoted = quoted;
    this.startedQuoted = startedQuoted;
    this.hadSubstitution = hadSubstitution;
  }
}

/**
 * Tokenize into words and operators, extracting nested command strings from `$( )`, backticks
 * and `<( )` / `>( )` so callers can analyse them recursively.
 *
 * @returns {{tokens: Array, nested: string[], unparseable: string|null}}
 */
export function tokenize(input) {
  const tokens = [];
  const nested = [];
  let i = 0;
  let current = '';
  let currentQuoted = false;
  let currentStartedQuoted = false;
  let currentHadSub = false;
  let started = false;

  const pushWord = () => {
    if (!started) return;
    tokens.push({
      type: 'word',
      value: new Word(current, {
        quoted: currentQuoted,
        startedQuoted: currentStartedQuoted,
        hadSubstitution: currentHadSub,
      }),
    });
    current = '';
    currentQuoted = false;
    currentStartedQuoted = false;
    currentHadSub = false;
    started = false;
  };

  const src = String(input ?? '');
  const pendingHeredocs = [];

  while (i < src.length) {
    const ch = src[i];

    // --- escaped character -------------------------------------------------
    if (ch === '\\') {
      if (i + 1 >= src.length) {
        // Trailing backslash: line continuation or malformed. Treat as whitespace.
        i += 1;
        continue;
      }
      const next = src[i + 1];
      if (next === '\n') {
        i += 2;
        continue;
      }
      current += next;
      started = true;
      i += 2;
      continue;
    }

    // --- single quotes: fully literal --------------------------------------
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return { tokens, nested, unparseable: 'unterminated single quote' };
      if (!started) currentStartedQuoted = true;
      current += src.slice(i + 1, end);
      currentQuoted = true;
      started = true;
      i = end + 1;
      continue;
    }

    // --- double quotes: literal except substitutions ------------------------
    if (ch === '"') {
      const res = readDoubleQuoted(src, i);
      if (res.error) return { tokens, nested, unparseable: res.error };
      if (!started) currentStartedQuoted = true;
      current += res.text;
      currentQuoted = true;
      currentHadSub = currentHadSub || res.nested.length > 0;
      started = true;
      nested.push(...res.nested);
      i = res.next;
      continue;
    }

    // --- command substitution $( ) and arithmetic $(( )) --------------------
    if (ch === '$' && src[i + 1] === '(') {
      if (src[i + 2] === '(') {
        const end = findMatching(src, i + 2, '(', ')');
        if (end === -1) return { tokens, nested, unparseable: 'unterminated arithmetic expansion' };
        // Arithmetic cannot execute a command; keep it as opaque text.
        current += src.slice(i, end + 1);
        started = true;
        currentHadSub = true;
        i = end + 1;
        continue;
      }
      const end = findMatching(src, i + 1, '(', ')');
      if (end === -1) return { tokens, nested, unparseable: 'unterminated command substitution' };
      nested.push(src.slice(i + 2, end));
      current += ' ';
      started = true;
      currentHadSub = true;
      i = end + 1;
      continue;
    }

    // --- backtick substitution ---------------------------------------------
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end === -1) return { tokens, nested, unparseable: 'unterminated backtick substitution' };
      nested.push(src.slice(i + 1, end));
      current += ' ';
      started = true;
      currentHadSub = true;
      i = end + 1;
      continue;
    }

    // --- process substitution <( ) >( ) -------------------------------------
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      const end = findMatching(src, i + 1, '(', ')');
      if (end === -1) return { tokens, nested, unparseable: 'unterminated process substitution' };
      nested.push(src.slice(i + 2, end));
      i = end + 1;
      continue;
    }

    // --- subshell / group boundaries ----------------------------------------
    if (ch === '(' || ch === ')') {
      pushWord();
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    if ((ch === '{' || ch === '}') && !started && isWordBoundary(src[i + 1])) {
      pushWord();
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    // --- whitespace ----------------------------------------------------------
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pushWord();
      i += 1;
      continue;
    }

    // --- redirections, including a leading file descriptor (`2>`, `1>>`) ------
    // This must run BEFORE the operator scan: `>>` used to be an operator, which split the
    // command there and turned the redirect *target* into a command name. `echo x >> .git/config`
    // was therefore allowed while `echo x > .git/config` was denied.
    {
      let fd = i;
      while (/[0-9]/.test(src[fd] ?? '')) fd += 1;
      const at = fd > i && (src[fd] === '>' || src[fd] === '<') ? fd : i;
      const redirect = REDIRECT_OPERATORS.find((o) => src.startsWith(o, at));
      if (redirect) {
        pushWord();
        let k = at + redirect.length;
        if (src[k] === '&') k += 1; // `2>&1` duplicates a descriptor; its operand is never a path
        // `<<` opens a heredoc, whose delimiter and body are both data. `<<<` is a here-string:
        // the word after it is data too, so the ordinary redirect path already handles it.
        if (redirect === '<<') {
          const delimiter = readHeredocDelimiter(src, k);
          if (delimiter.error) return { tokens, nested, unparseable: delimiter.error };
          // The op token carries the body once it is read, so a caller can decide whether this
          // heredoc is data (`cat <<EOF > file`) or a script (`bash <<EOF`). Discarding it made
          // both look identical, and the second is a shell executing plainly visible commands.
          const token = { type: 'op', value: 'heredoc', body: '' };
          pendingHeredocs.push({ delimiter: delimiter.value, token });
          tokens.push(token);
          i = delimiter.next;
          continue;
        }
        // `<<<` feeds its operand to the command's stdin. For an interpreter that is a script,
        // not a filename, so it is kept distinct from an ordinary redirect target.
        tokens.push({ type: 'op', value: redirect === '<<<' ? 'herestring' : 'redirect' });
        i = k;
        continue;
      }
    }

    // --- operators ------------------------------------------------------------
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      pushWord();
      tokens.push({ type: 'op', value: op === '\n' ? ';' : op });
      i += op.length;
      // A heredoc body starts at the newline that follows its operator. It is text, not code.
      if (op === '\n' && pendingHeredocs.length) {
        i = skipHeredocBodies(src, i, pendingHeredocs);
        pendingHeredocs.length = 0;
      }
      continue;
    }

    current += ch;
    started = true;
    i += 1;
  }

  pushWord();
  return { tokens, nested, unparseable: null };
}

function isWordBoundary(ch) {
  return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === ';';
}

/**
 * Read the delimiter word of a `<<` heredoc, honouring `<<-` and quoted delimiters.
 * Returns the position just past the delimiter, so any redirection that follows on the same
 * line (`cat <<EOF > out.sh`) is still tokenized rather than swallowed with the body.
 */
function readHeredocDelimiter(src, start) {
  let i = start;
  if (src[i] === '-') i += 1;
  while (src[i] === ' ' || src[i] === '\t') i += 1;
  let value = '';
  while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
    const ch = src[i];
    if (ch === '\\') {
      value += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) return { error: 'unterminated heredoc delimiter' };
      value += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    value += ch;
    i += 1;
  }
  if (!value) return { error: 'heredoc without a delimiter' };
  return { value, next: i };
}

/**
 * Skip past the bodies of every heredoc opened on the preceding line.
 *
 * The body is data. Tokenizing it as code caused two distinct false denials: a body that merely
 * *mentions* `git commit` (writing a release script, say) was classified as executing it, and a
 * body containing an unmatched quote made the whole command "unparseable", which fails closed.
 */
function skipHeredocBodies(src, from, pending) {
  let i = from;
  for (const { delimiter, token } of pending) {
    const start = i;
    for (;;) {
      const end = src.indexOf('\n', i);
      const line = end === -1 ? src.slice(i) : src.slice(i, end);
      if (line.trim() === delimiter) {
        token.body = src.slice(start, i);
        i = end === -1 ? src.length : end + 1;
        break;
      }
      if (end === -1) {
        token.body = src.slice(start);
        return src.length; // unterminated heredoc: the rest is body text
      }
      i = end + 1;
    }
  }
  return i;
}

function readDoubleQuoted(src, start) {
  let i = start + 1;
  let text = '';
  const nested = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      text += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (ch === '"') return { text, nested, next: i + 1 };
    if (ch === '$' && src[i + 1] === '(') {
      const end = findMatching(src, i + 1, '(', ')');
      if (end === -1) return { error: 'unterminated command substitution in double quotes' };
      nested.push(src.slice(i + 2, end));
      text += ' ';
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end === -1) return { error: 'unterminated backtick in double quotes' };
      nested.push(src.slice(i + 1, end));
      text += ' ';
      i = end + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { error: 'unterminated double quote' };
}

/** Index of the closing delimiter matching the opener at `start`, honouring quotes. */
function findMatching(src, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j += 1;
      }
      if (j >= src.length) return -1;
      i = j + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Split a command line into simple commands.
 *
 * Redirection targets are captured separately rather than dropped: `echo x > .git/config` is
 * a mutation the Git policy must see, and treating `.git/config` as a command name would
 * both miss it and invent a bogus command.
 *
 * `stdin` carries text the command receives on standard input — heredoc bodies and here-strings.
 * For most commands that is data; for a shell binary invoked without `-c` it is the script the
 * shell will execute, which is why it must not be discarded.
 *
 * @returns {{commands: Array<{argv: Word[], assignments: Record<string,string>, redirects: Word[],
 *            stdin: string[]}>, nested: string[], unparseable: string|null}}
 */
export function splitCommands(input) {
  const { tokens, nested, unparseable } = tokenize(input);
  if (unparseable) return { commands: [], nested, unparseable };

  const commands = [];
  let currentWords = [];
  let currentRedirects = [];
  let currentStdin = [];
  let pendingRedirect = false;
  let pendingHereString = false;

  const flush = () => {
    if (currentWords.length === 0 && currentRedirects.length === 0 && currentStdin.length === 0) return;
    const assignments = {};
    let idx = 0;
    // Leading NAME=VALUE pairs are environment assignments, not the command name.
    while (idx < currentWords.length) {
      const w = currentWords[idx];
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.text);
      if (!m || w.startedQuoted) break;
      assignments[m[1]] = m[2];
      idx += 1;
    }
    commands.push({ argv: currentWords.slice(idx), assignments, redirects: currentRedirects, stdin: currentStdin });
    currentWords = [];
    currentRedirects = [];
    currentStdin = [];
  };

  for (const t of tokens) {
    if (t.type === 'word') {
      if (pendingRedirect) {
        currentRedirects.push(t.value);
        pendingRedirect = false;
      } else if (pendingHereString) {
        currentStdin.push(t.value.text);
        pendingHereString = false;
      } else {
        currentWords.push(t.value);
      }
      continue;
    }
    if (t.value === 'redirect') {
      pendingRedirect = true;
      continue;
    }
    if (t.value === 'herestring') {
      pendingHereString = true;
      continue;
    }
    // A heredoc's delimiter and body were consumed during tokenization. The operator itself
    // neither ends the command nor introduces a target — but its body is text this command
    // receives on stdin, which for an interpreter is a script.
    if (t.value === 'heredoc') {
      if (t.body) currentStdin.push(t.body);
      continue;
    }
    pendingRedirect = false;
    pendingHereString = false;
    flush();
  }
  flush();

  return {
    commands: commands.filter((c) => c.argv.length > 0 || c.redirects.length > 0 || c.stdin.length > 0),
    nested,
    unparseable: null,
  };
}
