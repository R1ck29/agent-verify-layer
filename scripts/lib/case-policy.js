'use strict';
const path = require('node:path').posix;
const { repoPath } = require('./snapshot');

const label = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const qualified = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const source = /\.(?:py|js|mjs|cjs)$/;
const pythonTypes = new Set(['none', 'bool', 'int', 'float', 'str', 'bytes', 'list', 'tuple', 'dict']);
const nodeTypes = new Set(['null', 'undefined', 'bool', 'number', 'bigint', 'str', 'array', 'object']);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
}

const canonical = (v) => JSON.stringify(normalized(v));
const sameValue = (a, b) => canonical(a) === canonical(b);

function pairs(entries, valueOK) {
  return Array.isArray(entries) && entries.every((pair) => Array.isArray(pair) && pair.length === 2 &&
    typeof pair[0] === 'string' && valueOK(pair[1])) && new Set(entries.map(([key]) => key)).size === entries.length;
}

function typed(box, types, depth = 0) {
  if (depth > 64 || !record(box) || Object.keys(box).length !== 2 || !types.has(box.type)) return false;
  const v = box.value;
  const child = (value) => typed(value, types, depth + 1);
  switch (box.type) {
    case 'none': case 'null': case 'undefined': return v === null;
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isSafeInteger(v);
    case 'float': case 'number': return Number.isFinite(v);
    case 'str': return typeof v === 'string';
    case 'bytes': return typeof v === 'string' && Buffer.from(v, 'base64').toString('base64') === v;
    case 'bigint': return typeof v === 'string' && /^(?:0|-?[1-9]\d*)$/.test(v);
    case 'list': case 'tuple': case 'array': return Array.isArray(v) && v.every(child);
    case 'dict': case 'object': return pairs(v, child);
    default: return false;
  }
}

function validateCase(data, requestId, runner) {
  if (!record(data) || typeof data.caseId !== 'string' || !label.test(data.caseId)) throw new Error('Invalid caseId');
  const { candidates, selectedCandidateId, selectionReason, entry, input, expected, inputFiles, testFile, testId, assertion } = data;
  if (!Array.isArray(candidates) || candidates.length < 3 || candidates.length > 5 ||
      !candidates.every((item) => record(item) && typeof item.id === 'string' && label.test(item.id) &&
        nonempty(item.requestQuote) && Object.hasOwn(item, 'input') && nonempty(item.boundaryKind) && typeof item.handled === 'boolean') ||
      new Set(candidates.map((item) => item.id)).size !== candidates.length) throw new Error('List 3–5 distinct boundary candidates');
  if (!candidates.some((item) => item.id === selectedCandidateId) || !nonempty(selectionReason)) {
    throw new Error('Select a listed candidate and explain the choice');
  }
  const node = runner === 'node';
  if (!record(entry) || !nonempty(entry.symbol) || !qualified.test(entry.symbol) || !nonempty(entry.module) ||
      (!node && !qualified.test(entry.module)) || !nonempty(entry.call)) throw new Error('Invalid public entry');
  const validValue = (v) => typed(v, node ? nodeTypes : pythonTypes);
  if (!record(input) || !Array.isArray(input.args) || !input.args.every(validValue) || !pairs(input.kwargs, validValue) ||
      input.kwargs.some(([key]) => !qualified.test(key) || key.includes('.')) || (node && input.kwargs.length)) {
    throw new Error('Invalid typed input or keyword arguments');
  }
  if (!record(expected) || !(expected.kind === 'value' && validValue(expected.value) ||
      expected.kind === 'exception' && nonempty(expected.type) && qualified.test(expected.type))) {
    throw new Error('Invalid typed expected result');
  }
  if (!Array.isArray(inputFiles) || new Set(inputFiles).size !== inputFiles.length) throw new Error('Invalid inputFiles list');
  for (const item of inputFiles) repoPath(item);
  repoPath(testFile);
  const base = path.basename(testFile);
  const name = node ? new RegExp(`^[a-z0-9_-]+\\.vl_${escape(requestId)}\\.test\\.m?js$`) :
    new RegExp(`^test_vl_${escape(requestId)}_[a-z0-9_]+\\.py$`);
  if (!name.test(base) || inputFiles.includes(testFile)) throw new Error('Invalid request-specific test file');
  if (!nonempty(testId) || !record(assertion) || !Number.isSafeInteger(assertion.line) || assertion.line < 1) {
    throw new Error('Specify the test identifier and one-based assertion line');
  }
  if ((data.entryAdditionQuote !== undefined && !nonempty(data.entryAdditionQuote)) ||
      (data.nonBoundary !== undefined && typeof data.nonBoundary !== 'boolean')) throw new Error('Invalid case metadata');
  return data;
}

function appearsInPrompt(prompt, name) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`).test(prompt);
}

function compact(s) {
  return s.trim().replace(/\s+/g, ' ');
}

function moduleName(module) {
  const base = path.basename(module);
  if (/^(?:__init__\.py|index\.(?:m?js|cjs))$/.test(base)) return path.basename(path.dirname(module));
  if (source.test(base)) return base.replace(source, '');
  return base.split('.').at(-1);
}

function dotPaths(token) {
  const stem = token.replaceAll('.', '/');
  return [`${stem}.py`, `${stem}/__init__.py`, `src/${stem}.py`, `src/${stem}/__init__.py`];
}

function pathHints(prompt, name, isModule, beforeFiles, afterFiles, publicTestFiles) {
  const files = [...new Set([...beforeFiles, ...afterFiles])];
  const publicTests = new Set(publicTestFiles);
  const prose = prompt.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s`'"<>()]+/gi, ' ');
  const paths = [...prose.matchAll(/(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|py)(?![\w/])/g)];
  const hints = [];
  for (const [raw] of paths) {
    const ref = raw.replace(/^\.\//, '');
    if (isModule && moduleName(ref) !== name) continue;
    const fileMatches = (file) => ref.includes('/') ? file === ref : path.basename(file) === ref;
    const matches = files.filter(fileMatches);
    if (!isModule && matches.length && matches.every((file) => publicTests.has(file))) continue;
    hints.push(fileMatches);
  }
  const withoutPaths = prose.replace(/(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|py)(?![\w/])/g, ' ');
  for (const [token] of withoutPaths.matchAll(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+/g)) {
    if (isModule && token.split('.').at(-1) !== name) continue;
    const possible = dotPaths(token);
    if (!isModule && token.endsWith('.' + name)) possible.push(...dotPaths(token.slice(0, -name.length - 1)));
    const matches = files.filter((file) => possible.includes(file));
    if (!isModule && matches.every((file) => publicTests.has(file))) continue;
    hints.push((file) => possible.includes(file));
  }
  return hints;
}

function namesAddition(quote, name, isModule) {
  const q = quote.replace(/[`'"「」]/g, '');
  const jaVerb = '(?:追加|新設|作成|実装|用意|公開)';
  const enVerb = '(?:add|create|implement|introduce|expose|provide)';
  const jaKind = isModule ? '(?:モジュール|パッケージ)' : '(?:関数|メソッド|クラス|API|入口)';
  const enKind = isModule ? '(?:module|package)' : '(?:function|method|class|api)';
  const namePattern = isModule ? `(?:[A-Za-z_]\\w*\\.)*${escape(name)}` : escape(name);
  const target = `(?<![A-Za-z0-9_/-])${namePattern}(?![A-Za-z0-9_])`;
  const call = `${target}\\((?:[A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*)?\\)`;
  const enPrefix = `\\b${enVerb}\\s+(?:(?:a|an|the)\\s+)?(?:(?:new|public)\\s+)*`;
  const enTail = '(?=$|[.,!?;:])|(?=\\s+(?:to|in|for|that|which|with|and|or|into|from)\\b)';
  if (/(?:しない|せず|するな|不要|必要はない|ません|不可|いけない|控え|禁止|避け|ではなく|代わりに|やめ|既存)/.test(q) ||
      /\b(?:not|don['’]?t|never|without|instead|avoid|no|existing)\b/i.test(quote)) return false;
  const ja = new RegExp(`(?:${jaKind}\\s*${target}|${target}\\s*(?:という\\s*)?${jaKind})\\s*(?:を\\s*)?${jaVerb}`);
  // Keep identifier matching case-sensitive while allowing English command verbs and kinds in either case.
  const english = q.replace(/\b(?:add|create|implement|introduce|expose|provide|a|an|the|new|public|module|package|function|method|class|api|to|in|for|that|which|with|and|or|into|from)\b/gi,
    (word) => word === name ? word : word.toLowerCase());
  const en = new RegExp(`${enPrefix}(?:${enKind}\\s+${target}|${target}\\s+${enKind}(?:${enTail}))`);
  if (ja.test(q) || en.test(english)) return true;
  if (!isModule) return new RegExp(`${call}\\s*(?:を\\s*)?${jaVerb}`).test(q) || new RegExp(enPrefix + call).test(english);
  for (const match of q.matchAll(/(?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|py)(?![\w/])/g)) {
    if (moduleName(match[0]) !== name) continue;
    if (new RegExp(`^\\s*(?:を\\s*)?${jaVerb}`).test(q.slice(match.index + match[0].length)) ||
        new RegExp(enPrefix + '$').test(english.slice(0, match.index))) return true;
  }
  return false;
}

function additionAllowed({ prompt, caseData, evidence, modulePath, beforeFiles, afterFiles, definitions, publicTestFiles }) {
  if (!nonempty(prompt) || !nonempty(caseData.entryAdditionQuote) || !source.test(modulePath) || !afterFiles.includes(modulePath)) return false;
  const isModule = evidence.absence === 'module';
  if (!isModule && evidence.absence !== 'symbol') return false;
  const name = isModule ? moduleName(caseData.entry.module) : caseData.entry.symbol.split('.').at(-1);
  if (!name || !appearsInPrompt(prompt, name) || (!isModule && definitions.includes(name))) return false;
  if (isModule && beforeFiles.some((file) => moduleName(file) === name || file.split('/').slice(0, -1).includes(name))) return false;
  const quote = compact(caseData.entryAdditionQuote).replace(/[。．！？!?\.]$/, '');
  const sentences = prompt.split(/[。．！？!?\r\n]|\.(?=\s|$)/).map(compact);
  if (!sentences.includes(quote) || definitions.some((item) => item !== name && appearsInPrompt(quote, item)) ||
      !namesAddition(quote, name, isModule)) return false;
  return pathHints(prompt, name, isModule, beforeFiles, afterFiles, publicTestFiles).every((match) => match(modulePath));
}

function promptHasInput(prompt, input, runner) {
  const rawLiterals = [];
  // Recover calls embedded in prose, keeping nested literals and their order intact.
  for (const call of prompt.matchAll(/[$A-Za-z_][$\w]*(?:\.[$A-Za-z_][$\w]*)*\s*\(/g)) {
    let depth = 1;
    let quote = '';
    const start = call.index + call[0].length;
    for (let index = start; index < prompt.length; index++) {
      const char = prompt[index];
      if (quote) {
        if (char === '\\') index++;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '(') depth++;
      else if (char === ')' && --depth === 0) {
        rawLiterals.push(prompt.slice(call.index, index + 1));
        break;
      }
    }
  }
  for (const match of prompt.matchAll(/`([^`\r\n]*)`|"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'/g)) {
    rawLiterals.push(match[0]);
    if (match[1] !== undefined) rawLiterals.push(match[1]);
  }
  for (const [match] of prompt.matchAll(/(?<![\w.])(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?|true|false|null|undefined|True|False|None)(?![\w.])/g)) {
    rawLiterals.push(match);
  }
  if (!input.kwargs.length && input.args.length === 1 && input.args[0].type === 'str' &&
      rawLiterals.includes('`' + input.args[0].value + '`')) return true;
  if (runner !== 'node') {
    return require('./ast-guard').samePythonInput({}, null, input, [
      ...rawLiterals, ...prompt.split(/[\r\n。！？]/).map((line) => line.trim()),
    ]);
  }
  const { parseSource, literalValue } = require('./runners/node-ast-check');
  const { serializeInput } = require('./runners/node-values');
  for (const raw of rawLiterals) {
    try {
      const [statement, extra] = parseSource('(' + raw + ')', 'prompt.mjs').body;
      if (extra) continue;
      const value = statement.expression;
      const args = value.type === 'CallExpression' ? value.arguments : [value];
      if (sameValue(serializeInput(args.map(literalValue)), input)) return true;
    } catch {
      // A fragment of prose may not be a literal or an example call.
    }
  }
  return false;
}

module.exports = { canonical, sameValue, validateCase, appearsInPrompt, additionAllowed, promptHasInput };
