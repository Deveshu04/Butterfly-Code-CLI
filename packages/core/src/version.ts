import pkg from "../package.json"

/**
 * The package version, read from package.json so it cannot drift. It keys
 * the compiled-exe asset cache, so a release bump re-extracts assets.
 * `bun build --compile` inlines the JSON at build time.
 */
export const VERSION: string = pkg.version
