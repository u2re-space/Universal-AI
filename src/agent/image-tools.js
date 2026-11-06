/**
 * @file src/agent/image-tools.js
 * @module agent/image-tools
 * @purpose Select the image handler family from the configured model.
 * @usedBy agent/tools
 * @exports createImageHandlers
 */
import { imageModelFamily, imageModelFor } from '../openai/images.js';
import { createImageHandlers as createGptImageHandlers } from './gpt-image/image-tools.js';
import { createImageHandlers as createRiverflowHandlers } from './riverflow/image-tools.js';

/**
 * Build image handlers using the model family's request and post-processing behavior.
 * @param {object} options
 * @returns {object}
 * @exports
 */
export function createImageHandlers(options) {
    const model = imageModelFor(options?.config ?? {});
    const create = imageModelFamily(model) === 'riverflow'
        ? createRiverflowHandlers
        : createGptImageHandlers;
    return create(options);
}
