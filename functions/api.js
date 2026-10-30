// Netlify function wrapper — re-exports the Express handler from src/server.js
// This function handles all /api/* routes
exports.handler = require("../src/server").handler;
