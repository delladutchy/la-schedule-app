/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No images/fonts from external hosts; keep CSP-friendly.
  experimental: {
    // Keep @react-pdf/renderer in Node.js runtime so renderToBuffer() works
    // in API route handlers without bundling issues. sharp ships a native
    // binary (used to normalize receipt images before PDF embedding) that
    // must be resolved via normal node_modules require at runtime rather
    // than webpack-bundled, or the native module fails to load in production.
    serverComponentsExternalPackages: ["@react-pdf/renderer", "sharp"],
  },
};

module.exports = nextConfig;
