'use strict';

const { types: { isProxy } } = require('node:util');

function serializeInput(values) {
  const seen = new Set();
  const serialize = (value) => {
    if (value === null) return { type: 'null', value: null };
    switch (typeof value) {
      case 'undefined': return { type: 'undefined', value: null };
      case 'boolean': return { type: 'bool', value };
      case 'string': return { type: 'str', value };
      case 'number':
        if (Number.isFinite(value) && !Object.is(value, -0)) return { type: 'number', value };
        break;
      case 'bigint': return { type: 'bigint', value: String(value) };
      case 'object': {
        if (isProxy(value) || seen.has(value)) break;
        seen.add(value);
        const array = Array.isArray(value);
        if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) ||
            !Object.isExtensible(value) || Object.getOwnPropertySymbols(value).length) break;
        const keys = Object.getOwnPropertyNames(value);
        if (array && (!Object.getOwnPropertyDescriptor(value, 'length').writable ||
            keys.length !== value.length + 1 || keys.slice(0, -1).some((key, i) => key !== String(i)))) break;
        const items = (array ? keys.slice(0, -1) : keys).map((key) => {
          const desc = Object.getOwnPropertyDescriptor(value, key);
          if (!desc.writable || !desc.enumerable || !desc.configurable || !Object.hasOwn(desc, 'value')) {
            throw new Error('non-JSON input property');
          }
          const result = serialize(desc.value);
          return array ? result : [key, result];
        });
        return { type: array ? 'array' : 'object', value: items };
      }
    }
    throw new Error('input cannot be represented as an unshared typed value');
  };
  return { args: values.map(serialize), kwargs: [] };
}

module.exports = { serializeInput };
