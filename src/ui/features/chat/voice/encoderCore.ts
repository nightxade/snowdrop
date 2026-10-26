// Re-exports only what the recorder needs. A dynamic `import()` of the package
// itself keeps every export, including the inlined copies of both encoders
// (about 780 kB); going through this one binding lets the bundler drop them.
export { createEncoder } from 'wasm-media-encoders/esnext';
