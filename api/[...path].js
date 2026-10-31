// Vercel catch-all route for /api/* — handles all API requests
// Vercel auto-maps this to /api/* (all paths under /api/)
const { handler } = require("../functions/server");
module.exports = handler;
