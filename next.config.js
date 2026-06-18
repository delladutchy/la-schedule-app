/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No images/fonts from external hosts; keep CSP-friendly.
  experimental: {
    // Keep @react-pdf/renderer in Node.js runtime so renderToBuffer() works
    // in API route handlers without bundling issues.
    serverComponentsExternalPackages: ["@react-pdf/renderer"],
  },
};

module.exports = nextConfig;
