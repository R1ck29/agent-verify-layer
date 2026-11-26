'use strict';

const { importedNames, parseSource, walk } = require('./node-ast-check');

const OMIT = new Set(['start', 'end', 'loc', 'raw']);
const HOOKS = new Set(['before', 'beforeEach', 'after', 'afterEach', 'only']);
const CONFIG = new Set(['default', '__proto__', 'prototype', 'constructor']);
const canonical = (node) => JSON.stringify(node, (key, value) => {
  if (OMIT.has(key)) return undefined;
  return typeof value === 'bigint' ? { bigint: String(value) } : value;
});

function namesInPattern(node) {
  if (!node) return [];
  switch (node.type) {
    case 'Identifier': return [node.name];
    case 'RestElement': return namesInPattern(node.argument);
    case 'AssignmentPattern': return namesInPattern(node.left);
    case 'ArrayPattern': return node.elements.flatMap(namesInPattern);
    case 'ObjectPattern':
      return node.properties.flatMap((prop) => namesInPattern(prop.value ?? prop));
    default: return [];
  }
}

function declaredNames(node) {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'FunctionExpression':
    case 'ClassExpression':
      return namesInPattern(node.id);
    case 'VariableDeclaration':
      return node.declarations.flatMap(({ id }) => namesInPattern(id));
    case 'ImportDeclaration':
      return node.specifiers.map(({ local }) => local.name);
    default:
      return [];
  }
}

function nodeDefinitions(source, file) {
  const names = new Set();
  walk(parseSource(source, file), (node) => {
    for (const name of declaredNames(node)) names.add(name);
    if (['MethodDefinition', 'PropertyDefinition', 'ExportSpecifier'].includes(node.type)) {
      const member = node.exported ?? node.key;
      const name = member?.name ?? member?.value;
      if (typeof name === 'string') names.add(name);
    }
    if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
      const name = node.left.property?.name ?? node.left.property?.value;
      if (typeof name === 'string') names.add(name);
    }
  });
  return [...names].sort();
}

function scopeStatements(body) {
  return body.flatMap((statement) => {
    if (statement.type === 'ImportDeclaration' && statement.specifiers.length) {
      return statement.specifiers.map((specifier) => ({ ...statement, specifiers: [specifier] }));
    }
    return [statement];
  });
}

function onlyOrHook(node) {
  let prohibited = false;
  walk(node, (part) => {
    if (part.type !== 'CallExpression') return;
    const { callee } = part;
    const name = callee.name ?? callee.property?.name ?? callee.property?.value;
    if (HOOKS.has(name)) prohibited = true;
    if (part.arguments.some((arg) => arg.type === 'ObjectExpression' &&
        arg.properties.some((prop) => (prop.key?.name ?? prop.key?.value) === 'only'))) prohibited = true;
  });
  return prohibited;
}

function pureValue(node, values, paths, shadowed) {
  if (!node) return true;
  const pure = (item) => pureValue(item, values, paths, shadowed);
  switch (node.type) {
    case 'Literal': return !node.regex;
    case 'Identifier':
      return values.has(node.name) || node.name === '__filename' || node.name === '__dirname';
    case 'ArrayExpression':
      return node.elements.every((part) => part && pure(part));
    case 'ObjectExpression':
      return node.properties.every((prop) => prop.type === 'Property' && prop.kind === 'init' &&
        !prop.method && !prop.computed && !CONFIG.has(prop.key.name ?? prop.key.value) && pure(prop.value));
    case 'UnaryExpression':
      return ['+', '-', '!', '~', 'typeof', 'void'].includes(node.operator) && pure(node.argument);
    case 'LogicalExpression':
    case 'BinaryExpression':
      return pure(node.left) && pure(node.right);
    case 'TemplateLiteral': return node.expressions.every(pure);
    case 'CallExpression': {
      if (node.optional || !node.arguments.every(pure)) return false;
      const { callee } = node;
      if (callee.type === 'Identifier') {
        return !shadowed.has(callee.name) && ['String', 'Number', 'Boolean', 'BigInt'].includes(callee.name);
      }
      if (callee.type !== 'MemberExpression' || callee.computed || callee.optional ||
          callee.object.type !== 'Identifier') return false;
      const base = callee.object.name;
      const method = callee.property.name;
      return (base === 'Object' && !shadowed.has(base) && method === 'freeze') ||
        (paths.has(base) && method === 'join');
    }
    default:
      return false;
  }
}

function allowedTest(statement, tests, values, paths, shadowed) {
  const call = statement.expression;
  if (statement.type !== 'ExpressionStatement' || call?.type !== 'CallExpression' ||
      !tests.has(call.callee.name) || call.optional || onlyOrHook(statement)) return false;
  const [title, second, third] = call.arguments;
  const callback = third ?? second;
  return call.arguments.length >= 2 && call.arguments.length <= 3 && title?.type === 'Literal' &&
    typeof title.value === 'string' && ['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type) &&
    (!third || pureValue(second, values, paths, shadowed));
}

function checkNodeProtection(beforeText, afterText, { file }) {
  try {
    const before = parseSource(beforeText, file);
    const after = parseSource(afterText, file);
    checkScope(before.body, after.body, importedNames(after));
    return null;
  } catch (error) {
    return error.message;
  }
}

function checkScope(oldBody, newBody, imports) {
  const old = scopeStatements(oldBody);
  const fresh = scopeStatements(newBody);
  const used = new Set();
  const shadowed = new Set(fresh.flatMap(declaredNames));
  const values = new Set();
  const pathBindings = new Set(imports.filter(({module, symbol}) =>
    ['node:path', 'path'].includes(module) && ['*', 'default'].includes(symbol)).map(({name}) => name));
  const testBindings = new Set(imports.filter(({module, symbol}) =>
    ['node:test', 'test'].includes(module) && ['*', 'default', 'test'].includes(symbol)).map(({name}) => name));
  walk({ type: 'Program', body: old }, (node) => {
    if (node.type === 'Identifier') used.add(node.name);
  });

  let cursor = 0;
  for (const statement of fresh) {
    if (cursor < old.length && canonical(statement) === canonical(old[cursor])) {
      cursor++;
      continue;
    }
    if (statement.type === 'ImportDeclaration' &&
        old.some((prior) => canonical(prior) === canonical(statement))) continue;
    const names = declaredNames(statement);
    if (names.some((name) => used.has(name) || HOOKS.has(name))) {
      throw new Error('new binding affects an existing test');
    }
    if (statement.type === 'ImportDeclaration' && statement.specifiers.length) continue;
    if (statement.type === 'FunctionDeclaration' && !onlyOrHook(statement)) continue;
    if (statement.type === 'ClassDeclaration' && (statement.superClass === null ||
        statement.superClass.type === 'Identifier') && statement.body.body.every((item) =>
      item.type === 'MethodDefinition' && !item.computed ||
      item.type === 'PropertyDefinition' && !item.computed && pureValue(item.value, values, pathBindings, shadowed)) &&
      !onlyOrHook(statement)) continue;
    if (statement.type === 'VariableDeclaration' && statement.declarations.every(({ id, init }) =>
      id.type === 'Identifier' && pureValue(init, values, pathBindings, shadowed))) {
      for (const name of names) values.add(name);
      continue;
    }
    if (allowedTest(statement, testBindings, values, pathBindings, shadowed)) continue;
    throw new Error('existing JavaScript test element changed or unsafe top-level statement added');
  }
  if (cursor !== old.length) throw new Error('existing JavaScript test element removed or reordered');
}

module.exports = { checkNodeProtection, nodeDefinitions };
