'use strict';

const { adapter, invoke } = require('./python');

module.exports = { ...adapter('pytest'), available: (timeoutMs) => invoke('pytest', 'available', { timeoutMs }) };
