/**
 * @file src/agent/image-alpha.js
 * @module agent/image-alpha
 * @purpose Dispatch alpha processing to the configured image model family.
 * @usedBy commands/image, agent/image-tools
 * @exports ALPHA_MASK_PROMPT, BACKGROUND_PAINT_PROMPT, applyGeneratedAlphaMask, hasRealAlpha
 */
import { imageModelFamily } from '../openai/images.js';
import * as gptImage from './gpt-image/image-alpha.js';
import * as riverflow from './riverflow/image-alpha.js';

export const ALPHA_MASK_PROMPT = gptImage.ALPHA_MASK_PROMPT;
export const BACKGROUND_PAINT_PROMPT = gptImage.BACKGROUND_PAINT_PROMPT;
export const hasRealAlpha = riverflow.hasRealAlpha;

/** Apply alpha with the implementation selected for the configured model family. */
export async function applyGeneratedAlphaMask(options) {
    const model = options?.model || options?.config?.imageModel || null;
    const implementation = imageModelFamily(model) === 'riverflow' ? riverflow : gptImage;
    return implementation.applyGeneratedAlphaMask(options);
}
