// Netlify function entry point — handles all /api/* routes
exports.handler = require("./server").handler;
