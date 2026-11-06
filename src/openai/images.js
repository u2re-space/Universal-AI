/**
 * @file src/openai/images.js
 * @module openai/images
 * @purpose Backward-compatible image API entry point.
 * @exports All model-aware image API helpers and shared image utilities.
 */
export * from './riverflow/images.js';
export { imageModelFamily } from './shared/images.js';