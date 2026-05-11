// Vitest runs outside Next.js module transforms, so this test-only shim avoids
// executing the NPM "server-only" runtime throw in Node test imports.
export {};
