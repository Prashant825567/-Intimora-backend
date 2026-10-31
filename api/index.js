// Vercel serverless function — entry point for /api/* routes
// Vercel auto-maps this file to /api/*
const { handler } = require("../functions/server");
module.exports = handler;
