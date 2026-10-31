// Vercel catch-all route for /api/* — handles all API requests
// Vercel auto-maps this to /api/* (all paths under /api/)
const { handler } = require("../backend/server");
module.exports = handler;
