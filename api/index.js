// Vercel entry point: every path is routed here (see vercel.json).
// The TypeScript sources are compiled to dist/ by the build step.
module.exports = require('../dist/serverless.js').default;
