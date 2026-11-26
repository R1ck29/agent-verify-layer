'use strict';

const { adapter, invoke } = require('./python');

module.exports = { ...adapter('pytest'), available: () => invoke('pytest', 'available') };
