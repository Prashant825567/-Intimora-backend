// Vercel function — handles ALL /api/* routes via rewrite
// vercel.json rewrites /api/* to /api, which hits this function
const app = require("../backend/server");

module.exports = (req, res) => {
  // Vercel rewrites /api/* to /api, but Express needs the original path
  // The original path is preserved in req.originalUrl
  if (req.originalUrl && req.originalUrl !== req.url) {
    req.url = req.originalUrl;
  }
  app(req, res);
};
