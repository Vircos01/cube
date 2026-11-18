const mimeV1 = require('../../node_modules/mime/mime.js');
const mimeV2 = require('./node_modules/mime');

const combined = {
  ...mimeV1,
  ...mimeV2,
  charsets: mimeV1.charsets,
  lookup: mimeV1.lookup ? mimeV1.lookup.bind(mimeV1) : mimeV2.getType.bind(mimeV2),
  getType: mimeV2.getType ? mimeV2.getType.bind(mimeV2) : mimeV1.lookup.bind(mimeV1),
  getExtension: mimeV2.getExtension ? mimeV2.getExtension.bind(mimeV2) : mimeV1.extension.bind(mimeV1),
};

module.exports = combined;
