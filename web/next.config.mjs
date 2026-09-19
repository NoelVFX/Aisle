import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This repo has lockfiles above `web/`; pin tracing to the app so Vercel builds cleanly.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // Product imagery in demo mode comes from picsum; plain <img> is used, so no image config needed.
};

export default nextConfig;
