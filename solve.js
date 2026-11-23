// Fast static site generator — a from-scratch, byte-identical reimplementation of
// makefun-site 1.0.0's build, written for speed.
//
// Behaviour follows the makefun-site README (front matter, template dialect,
// Markdown subset, slug rule, report) exactly; the code below is my own
// implementation of that behaviour. Hot paths avoid regular expressions and
// per-character string building: the Markdown renderer scans by character code
// and buffers literal runs, slugify caches and shortcuts ASCII text, and every
// template is compiled once to a small JavaScript function that renders
// straight into an output array.
//
// `run(input)` returns the output tree: { path: text } for one case's input.

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a UTF-16 code unit is JavaScript `\s` whitespace. */
function isWs(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
    c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The HTML escape, applied in one pass; returns the input unchanged when nothing needs escaping. */
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESC_MAP[c]);
}

// ---------------------------------------------------------------- text: slugs, dates, words

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
 * characters other than a-z and 0-9 one `-`, none at either end, at most 64
 * characters (a `-` left at the cut dropped), `untitled` when nothing is left.
 * ASCII-only text normalises to itself, so it skips the normaliser entirely.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12) inWord = false;
    else if (c > 127) {
      // A non-ASCII character: a word character, unless it is exotic whitespace.
      if (isWs(c)) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    } else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEY_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: `"..."` with `\"` and `\\` its only escapes, or bare. */
function stringVal(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function hasNoTagChars(t) {
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 34 || c === 91 || c === 93) return false;
  }
  return t.length > 0;
}

function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugVal(s) {
  if (s.length === 0 || s.length > 64) return false;
  let i = 0;
  for (;;) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) return false;
    i++;
    while (i < s.length && ((s.charCodeAt(i) >= 97 && s.charCodeAt(i) <= 122) || (s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57))) i++;
    if (i === s.length) return true;
    if (s.charCodeAt(i) !== 45) return false;
    i++;
    if (i === s.length) return false;
  }
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringVal(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (!hasNoTagChars(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugVal(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/** One front-matter line (not blank, not a comment) checked against `data`, or its error. */
function fmLine(line, n, data) {
  let i = 0;
  const L = line.length;
  while (i < L) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0) return 'line ' + n + ' is not "key: value"';
  const key = line.slice(0, i);
  if (i >= L || line.charCodeAt(i) !== 58) return 'line ' + n + ' is not "key: value"';
  i++;
  let raw;
  if (i >= L) raw = '';
  else if (line.charCodeAt(i) === 32) raw = line.slice(i + 1);
  else return 'line ' + n + ' is not "key: value"';
  let e = raw.length;
  while (e > 0) {
    const c = raw.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  raw = raw.slice(0, e);
  if (!KEY_SET.has(key)) return 'unknown key "' + key + '"';
  if (Object.hasOwn(data, key)) return 'key "' + key + '" is given twice';
  if (raw === '') return 'key "' + key + '" has no value';
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (text.length !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  // Find the closing `---` line first: a missing close outranks any bad line.
  const lineStart = text.length === 3 ? 3 : 4;
  let closeStart = -1;
  let closeEnd = -1;
  let p = lineStart;
  for (;;) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2;
  p = lineStart;
  while (p < closeStart) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(p, lineEnd);
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      const err = fmLine(line, lineNo, data);
      if (err !== null) return { error: err };
    }
    p = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 95 || c === 43 || c === 45
  );
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth (0 when the line is no heading). */
function headingDepth(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return 0;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return 0;
  let s = h;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return e === s ? 0 : h;
}

/** A heading line's text (its depth is known to be non-zero). */
function headingText(line, depth) {
  let s = depth;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` continues a list item. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2) return false;
  return j < line.length && !isWs(line.charCodeAt(j));
}

/**
 * A list's first line: { ordered, start } (start 1 for bullets), or null.
 * `marker` below reads later lines of the same kind.
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    return line.charCodeAt(1) === 32 ? { ordered: false, start: 1 } : null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j > 9) return null;
    if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, j)) };
    }
  }
  return null;
}

/** A later list line's item text for a list of `ordered` kind, or null. */
function listItem(line, ordered) {
  if (!ordered) {
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
    return null;
  }
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j > 9) return null;
  if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return line.slice(j + 2);
  return null;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingDepth(line) !== 0;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** Whether `c` (a code unit) is one a backslash escapes. */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace. */
function hasWs(s) {
  for (let i = 0; i < s.length; i++) {
    if (isWs(s.charCodeAt(i))) return true;
  }
  return false;
}

/** `s` rendered inline; `link(target)` is a link's href. */
const INLINE_RE = /[\\`*\[&<>"']/g;
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function inline(s, link) {
  let out = '';
  const n = s.length;
  let i = 0;
  let lit = 0;
  for (;;) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (lit < j) out += s.slice(lit, j);
      out += HTML_ESC[s[j]];
      i = j + 1;
      lit = i;
      continue;
    }
    if (c === 92) {
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        if (lit < j) out += s.slice(lit, j);
        const nx = s[j + 1];
        out += nx === '>' ? '&gt;' : nx;
        i = j + 2;
        lit = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (lit < j) out += s.slice(lit, j);
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
        lit = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (lit < j) out += s.slice(lit, j);
          out += '<strong>' + inline(s.slice(j + 2, k), link) + '</strong>';
          i = k + 2;
          lit = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (lit < j) out += s.slice(lit, j);
        out += '<em>' + inline(s.slice(j + 1, k), link) + '</em>';
        i = k + 1;
        lit = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !hasWs(target)) {
      if (lit < j) out += s.slice(lit, j);
      out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(j + 1, k), link) + '</a>';
      i = m2 + 1;
      lit = i;
      continue;
    }
    i = j + 1;
  }
  if (lit < n) out += s.slice(lit, n);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMd(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // A line opening on a space or tab is blank, or a paragraph line.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const parts = ['<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>'];
        while (i < n && !fenceClose(lines[i])) {
          parts.push(esc(lines[i]) + '\n');
          i++;
        }
        if (i < n) i++;
        parts.push('</code></pre>\n');
        out.push(parts.join(''));
        continue;
      }
    } else if (c0 === 35) {
      const depth = headingDepth(line);
      if (depth !== 0) {
        const text = headingText(line, depth);
        const id = uniqueSlug(slugify(text), ids);
        const html = inline(text, link);
        out.push('<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>\n');
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const ls = listStart(line);
      if (ls !== null) {
        i = renderList(lines, i, n, ls, out, link);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(trimLine(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      out.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : '<blockquote>\n<p>' + inline(kept.join('\n'), link) + '</p>\n</blockquote>\n',
      );
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ls = listStart(line);
      if (ls !== null) {
        i = renderList(lines, i, n, ls, out, link);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

/** A list block starting at `i`: renders it into `out`, returns the next line index. */
function renderList(lines, i, n, ls, out, link) {
  const ordered = ls.ordered;
  const items = [];
  while (i < n) {
    const m = listItem(lines[i], ordered);
    if (m !== null) {
      items.push([trimLine(m)]);
      i++;
    } else if (isContinued(lines[i])) {
      items[items.length - 1].push(trimLine(lines[i]));
      i++;
    } else break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const parts = [(ordered && ls.start !== 1 ? '<ol start="' + ls.start + '">' : '<' + tag + '>') + '\n'];
  for (const item of items) parts.push('<li>' + inline(item.join('\n'), link) + '</li>\n');
  parts.push('</' + tag + '>\n');
  out.push(parts.join(''));
  return i;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function isPathText(text) {
  if (text.length === 0) return false;
  const c0 = text.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return false;
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      const nx = text.charCodeAt(i + 1);
      if (!((nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122) || nx === 95)) return false;
    } else if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) {
      return false;
    }
  }
  return true;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPathText(text)) {
    throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

/** Whether `s` from `from` holds only spaces and tabs up to `to`. */
function onlySpaceTab(s, from, to) {
  for (let k = from; k < to; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaceTab(src, lineStart, open) && onlySpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseForTag(tag) {
  // `for <name> in <path>`
  if (!tag.startsWith('for ')) return null;
  const rest = tag.slice(4);
  const sp = rest.indexOf(' ');
  if (sp === -1) return null;
  const varName = rest.slice(0, sp);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return null;
  if (!rest.slice(sp + 1).startsWith('in ')) return null;
  const pathText = rest.slice(sp + 4);
  if (pathText === '' || /\s/.test(pathText)) return null;
  return { name: varName, pathText };
}

function parseIfTag(tag) {
  // `if <path>` or `if not <path>`
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '' || /\s/.test(rest)) return null;
  return { not, pathText: rest };
}

function parseIncludeTag(tag) {
  // `include "<name>"`
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const inner = tag.slice(9, -1);
  if (!/^[a-z0-9-]+$/.test(inner)) return null;
  return inner;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      const f = parseForTag(tag);
      if (f !== null) {
        const node = { kind: 'for', name: f.name, path: pathOf(name, f.pathText), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
      const c = parseIfTag(tag);
      if (c !== null) {
        const node = { kind: 'if', not: c.not, path: pathOf(name, c.pathText), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
      if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError('template "' + name + '": an else outside an if');
        }
        top.else = [];
        body = top.else;
        continue;
      }
      if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
        continue;
      }
      const inc = parseIncludeTag(tag);
      if (inc !== null) {
        body.push({ kind: 'include', name: inc });
        continue;
      }
      throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

// --- rendering helpers shared by every compiled template -------------------

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lk(F, p) {
  const p0 = p[0];
  for (let s = F.length - 1; s >= 0; s--) {
    const fr = F[s];
    let v;
    if (fr.n === undefined) {
      if (!Object.hasOwn(fr.v, p0)) continue;
      v = fr.v[p0];
    } else if (p0 === 'loop') v = fr.l;
    else if (p0 === fr.n) v = fr.x;
    else continue;
    for (let k = 1; k < p.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[k])) return undefined;
      v = v[p[k]];
    }
    return v;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tx(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += tx(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- compiling a parsed template to a function ------------------------------
//
// A compiled template is `fn(F, T, d, o, esc, tx, tr, lk, P)` where `F` is the
// scope chain (an array of frames: `{ v }` for the root scope, `{ n, x, l }`
// for a for-loop frame), `T` the map of compiled templates, `d` the include
// depth, `o` the output array it appends to, and `P` the template's table of
// paths (so no path array is built per lookup).

function compileNodes(nodes, parts, ctx) {
  for (const node of nodes) {
    if (node.kind === 'text') {
      parts.push('o.push(' + JSON.stringify(node.text) + ');');
    } else if (node.kind === 'var') {
      parts.push('o.push(esc(tx(lk(F,' + ctx.p(node.path) + '))));');
    } else if (node.kind === 'raw') {
      parts.push('o.push(tx(lk(F,' + ctx.p(node.path) + ')));');
    } else if (node.kind === 'if') {
      const cond = node.not
        ? '!tr(lk(F,' + ctx.p(node.path) + '))'
        : 'tr(lk(F,' + ctx.p(node.path) + '))';
      parts.push('if(' + cond + '){');
      compileNodes(node.then, parts, ctx);
      parts.push('}');
      if (node.else !== null) {
        parts.push('else{');
        compileNodes(node.else, parts, ctx);
        parts.push('}');
      }
    } else if (node.kind === 'for') {
      const id = ctx.uid.next++;
      const p = ctx.p(node.path);
      parts.push(
        '{const _x' + id + '=lk(F,' + p + ');' +
        'if(Array.isArray(_x' + id + ')){' +
        'const _f' + id + '={n:' + JSON.stringify(node.name) + ',x:null,l:{index:0,first:false,last:false,length:_x' + id + '.length}};' +
        'F.push(_f' + id + ');' +
        'for(let _k' + id + '=0;_k' + id + '<_x' + id + '.length;_k' + id + '++){' +
        '_f' + id + '.x=_x' + id + '[_k' + id + '];' +
        'const _l' + id + '=_f' + id + '.l;' +
        '_l' + id + '.index=_k' + id + '+1;_l' + id + '.first=_k' + id + '===0;_l' + id + '.last=_k' + id + '===_x' + id + '.length-1;',
      );
      compileNodes(node.body, parts, ctx);
      parts.push('}F.pop();}}');
    } else if (node.kind === 'include') {
      const id = ctx.uid.next++;
      parts.push(
        '{const _t' + id + '=T.get(' + JSON.stringify(node.name) + ');' +
        'if(_t' + id + '!==undefined&&d<8)_t' + id + '(F,T,d+1,o,esc,tx,tr,lk,_t' + id + '.P);}',
      );
    }
  }
}

/** A parsed template compiled to its render function. */
function compileTemplate(nodes) {
  const parts = [];
  const paths = [];
  const pathIdx = new Map();
  const ctx = {
    uid: { next: 0 },
    p(path) {
      const key = JSON.stringify(path);
      let idx = pathIdx.get(key);
      if (idx === undefined) {
        idx = paths.length;
        paths.push(path);
        pathIdx.set(key, idx);
      }
      return 'P[' + idx + ']';
    },
  };
  compileNodes(nodes, parts, ctx);
  const fn = new Function('F', 'T', 'd', 'o', 'esc', 'tx', 'tr', 'lk', 'P', parts.join(''));
  fn.P = paths;
  return fn;
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `t` opens with a scheme (`https:`, `mailto:` ...). */
function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 45 || c === 46)
    ) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(s) {
  const card = cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer === undefined ? null : s.newer),
    older: linkOf(s.older === undefined ? null : s.older),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const output = {};
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + spath + ' -> ' + target);
      return target;
    };
    const md = renderMd(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  let pageCount = 0;
  for (const s of kept) {
    if (s.post) posts.push(s);
    else pageCount++;
  }
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const tags = p.data.tags ?? [];
    for (let ti = 0; ti < tags.length; ti++) {
      const name = tags[ti];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const tags = s.data.tags ?? [];
    for (let ti = 0; ti < tags.length; ti++) {
      const name = tags[ti];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const rootVars = { site, tags: allTags, recent, ...vars };
    const F = [{ v: rootVars }];
    const o = [];
    fn(F, templates, 0, o, esc, tx, tr, lk, fn.P);
    return o.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  lines.push(
    'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files',
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
