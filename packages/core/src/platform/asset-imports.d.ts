// Types for `import(specifier, { with: { type: "file" } })` asset embedding.
// The literal specifier must stay visible to Bun's bundler, so these types
// replace a cast at each call site.
declare module "*.wasm" {
  const path: string
  export default path
}

declare module "*.scm" {
  const path: string
  export default path
}

declare module "*.exe" {
  const path: string
  export default path
}
