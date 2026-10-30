// Netlify directory function — handles ALL /api/* routes
// Netlify routes /api/* to this function automatically
exports.handler = require("../server").handler;
