// Netlify directory function — handles ALL /api/* routes
const serverless = require("serverless-http");
exports.handler = serverless(require("../server"));
