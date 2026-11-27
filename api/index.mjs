// Vercel entry point: every path is routed here (see vercel.json).
// The service is bundled as an ES module (dist/serverless.mjs) by `npm run build:serverless`:
// Vercel's runtime cannot require() ES-module-only packages such as @concordium/web-sdk.
export { default } from '../dist/serverless.mjs';
