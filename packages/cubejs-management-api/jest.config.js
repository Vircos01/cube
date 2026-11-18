const path = require('path');
const base = require('../../jest.base-ts.config');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  rootDir: '.',
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^mime$': path.resolve(__dirname, 'jest-mime-shim.js'),
  },
};
