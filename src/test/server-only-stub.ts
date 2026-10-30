// No-op stand-in for the `server-only` package under vitest. The real package
// throws if imported into a client bundle; there is no client bundle in a test
// run, and the guard still applies to the actual Next.js build.
export {};
