/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No images/fonts from external hosts; keep CSP-friendly.
  experimental: {},
};

module.exports = nextConfig;
