'use strict';

const { parse } = require('../../../vendor/acorn.cjs');
const { sameValue } = require('../case-policy');

function parseSource(source, file) {
  const options = { ecmaVersion: 'latest', locations: true };
  if (file.endsWith('.cjs')) return parse(source, { ...options, sourceType: 'commonjs' });
  try {
    return parse(source, { ...options, sourceType: 'module' });
  } catch (error) {
    if (file.endsWith('.mjs')) throw error;
    return parse(source, { ...options, sourceType: 'commonjs' });
  }
}

function walk(node, visit, parent) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit, node);
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}

function literalValue(node) {
  if (node.type === 'Literal' && !node.regex) return node.value;
  if (node.type === 'Identifier' && node.name === 'undefined') return undefined;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator) &&
      node.argument.type === 'Literal' && ['number', 'bigint'].includes(typeof node.argument.value)) {
    if (node.operator === '+') return +node.argument.value;
    return -node.argument.value;
  }
  if (node.type === 'ArrayExpression') {
    if (node.elements.some((item) => item === null)) throw new Error('sparse array literal');
    return node.elements.map(literalValue);
  }
  if (node.type === 'ObjectExpression') {
    const result = {};
    for (const prop of node.properties) {
      const key = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.value;
      if (prop.type !== 'Property' || prop.shorthand || prop.computed || prop.method ||
          prop.kind !== 'init' || !['string', 'number'].includes(typeof key) ||
          key === '__proto__' || Object.hasOwn(result, key)) throw new Error('unsupported object literal');
      result[key] = literalValue(prop.value);
    }
    return result;
  }
  throw new Error('expected a literal value');
}

function requiredModule(node) {
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier' &&
      node.callee.name === 'require' && node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' && typeof node.arguments[0].value === 'string') {
    return node.arguments[0].value;
  }
  return null;
}

function importedNames(tree) {
  const imports = [];
  for (const statement of tree.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        imports.push({
          name: specifier.local.name,
          symbol: specifier.imported?.name ?? specifier.imported?.value ?? (specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*'),
          module: statement.source.value,
          declaration: specifier.local,
          commonjs: false,
        });
      }
    }
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const item of statement.declarations) {
      const module = requiredModule(item.init);
      if (!module) continue;
      if (item.id.type === 'Identifier') {
        imports.push({ name: item.id.name, symbol: '*', module, declaration: item.id, commonjs: true });
      }
      if (item.id.type === 'ObjectPattern') for (const prop of item.id.properties) {
        if (prop.type === 'Property' && !prop.computed && prop.value.type === 'Identifier') {
          imports.push({ name: prop.value.name, symbol: prop.key.name ?? prop.key.value, module,
            declaration: prop.value, property: prop.key, commonjs: true });
        }
      }
    }
  }
  return imports;
}

function member(node, base, key) {
  return node?.type === 'MemberExpression' && !node.computed && !node.optional &&
    node.object.type === 'Identifier' && node.object.name === base &&
    node.property.type === 'Identifier' && node.property.name === key;
}

function checkNodeCase(source, caseData) {
  try {
    return { ok: true, ...nodeShape(source, caseData) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function nodeShape(source, caseData) {
  const tree = parseSource(source, caseData.testFile);
  const imports = importedNames(tree);
  const { entry, expected } = caseData;
  const candidates = imports.filter(({ name, symbol, module }) =>
    name === entry.call && module === entry.module && symbol === entry.symbol && !['*', 'default'].includes(symbol));
  if (candidates.length !== 1) throw new Error('expected one named import for the public entry');
  const binding = candidates[0];
  if (binding.commonjs && !/^\.\.?\//.test(binding.module)) throw new Error('require must use a relative path');

  const testBindings = imports.filter(({ module, symbol }) =>
    module === 'node:test' && ['test', 'default', '*'].includes(symbol));
  const registrations = tree.body.filter((statement) =>
    statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' &&
    statement.expression.callee.type === 'Identifier' &&
    testBindings.some(({ name }) => name === statement.expression.callee.name));
  if (registrations.length !== 1) throw new Error('expected exactly one node:test registration');
  const registration = registrations[0].expression;
  const [title, callback] = registration.arguments;
  if (registration.arguments.length !== 2 || title.type !== 'Literal' ||
      title.value !== caseData.testId || !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type) ||
      callback.generator || callback.body.type !== 'BlockStatement' ||
      callback.params.length !== 1 || callback.params[0].type !== 'Identifier') {
    throw new Error('expected a named node:test callback without skip or todo options');
  }
  for (const statement of tree.body) {
    if (statement === registrations[0] || statement.type === 'ImportDeclaration' ||
        (statement.type === 'ExpressionStatement' && statement.directive)) continue;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' &&
        statement.declarations.every(({ init }) => requiredModule(init))) continue;
    throw new Error('additional test must place setup inside its test callback');
  }

  const context = callback.params[0].name;
  const [plan] = callback.body.body;
  const planCall = plan?.expression;
  if (plan?.type !== 'ExpressionStatement' || planCall?.type !== 'CallExpression' ||
      !member(planCall.callee, context, 'plan') || planCall.arguments.length !== 1 ||
      planCall.arguments[0].type !== 'Literal' || planCall.arguments[0].value !== 1) {
    throw new Error('the first callback statement must be t.plan(1)');
  }

  const statements = callback.body.body.filter(({ loc }) => loc.start.line === caseData.assertion.line);
  const [assertion] = statements;
  const awaited = assertion?.expression?.type === 'AwaitExpression';
  const comparison = awaited ? assertion.expression.argument : assertion?.expression;
  if (statements.length !== 1 || assertion.type !== 'ExpressionStatement' ||
      comparison?.type !== 'CallExpression' || comparison.optional || comparison.callee.type !== 'MemberExpression' ||
      comparison.callee.optional || comparison.callee.computed ||
      !member(comparison.callee.object, context, 'assert') || comparison.arguments.length !== 2) {
    throw new Error('expected a direct assertion expression at the specified line');
  }
  for (const statement of callback.body.body) {
    if (statement !== assertion && statement.loc.end.line >= assertion.loc.start.line &&
        statement.loc.start.line <= assertion.loc.end.line) throw new Error('assertion must be alone on its line');
  }

  const method = comparison.callee.property.name;
  const [actual, wanted] = comparison.arguments;
  let wantedDeclaration;
  let entryCall;
  if (expected.kind === 'exception') {
    if (wanted.type !== 'Identifier' || wanted.name !== expected.type) {
      throw new Error('exception type must match the case');
    }
    if (method === 'throws' && !awaited && actual.type === 'ArrowFunctionExpression' &&
        !actual.async && actual.params.length === 0) entryCall = actual.body;
    if (method === 'rejects' && awaited) entryCall = actual;
  } else if (expected.kind === 'value' && ['strictEqual', 'deepStrictEqual'].includes(method) && !awaited) {
    const { serializeInput } = require('./node-values');
    let literal = wanted;
    if (wanted.type === 'Identifier') {
      const declarations = callback.body.body.slice(0, callback.body.body.indexOf(assertion))
        .filter((statement) => statement.type === 'VariableDeclaration')
        .flatMap((statement) => statement.declarations)
        .filter(({ id }) => id.type === 'Identifier' && id.name === wanted.name);
      if (declarations.length !== 1 || !declarations[0].init) {
        throw new Error('expected one literal binding before the assertion');
      }
      wantedDeclaration = declarations[0].id;
      literal = declarations[0].init;
    }
    if (!sameValue(serializeInput([literalValue(literal)]).args[0], expected.value)) {
      throw new Error('literal expectation does not match the case');
    }
    entryCall = actual.type === 'AwaitExpression' ? actual.argument : actual;
  }
  if (entryCall?.type !== 'CallExpression' || entryCall.optional ||
      entryCall.callee.type !== 'Identifier' || entryCall.callee.name !== binding.name) {
    throw new Error('the measured value must call the imported entry directly');
  }
  for (const arg of entryCall.arguments) if (arg.type !== 'Identifier') literalValue(arg);

  const allowedContext = new Set([callback.params[0], planCall.callee.object, comparison.callee.object.object]);
  const allowedEntry = new Set([binding.declaration, binding.property, entryCall.callee]);
  const importedLocals = new Set(imports.map(({ name }) => name));
  walk(tree, (node, parent) => {
    if (wantedDeclaration && node.type === 'Identifier' && node.name === wanted.name &&
        node !== wanted && node !== wantedDeclaration) throw new Error('expectation binding may only be used once');
    if (node.type === 'Identifier' && node.name === context && !allowedContext.has(node)) {
      throw new Error('testing context may only be used for the plan and assertion');
    }
    if (node.type === 'Identifier' && node.name === binding.name && !allowedEntry.has(node)) {
      throw new Error('public entry may only be referenced once by the test');
    }
    if (node.type === 'Identifier' && node.name === expected.type && node !== wanted &&
        parent?.type !== 'ImportSpecifier') throw new Error('exception type cannot be rebound');
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' ||
        (node.type === 'UnaryExpression' && node.operator === 'delete')) {
      walk(node.left ?? node.argument, (part) => {
        if (part.type === 'Identifier' && importedLocals.has(part.name)) throw new Error('import mutation');
      });
    }
  });

  return {
    binding: { commonjs: binding.commonjs, module: binding.module, name: binding.name, symbol: binding.symbol },
    context, method, plan: plan.loc.start, range: assertion.loc,
    args: entryCall.arguments.map(({ start, end }) => source.slice(start, end)),
  };
}

module.exports = { checkNodeCase, importedNames, literalValue, member, parseSource, requiredModule, walk };
