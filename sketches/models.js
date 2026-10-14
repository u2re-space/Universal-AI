/**
 * Stable public entry point, Node.js 26+, ESM.
 * Both entry points use native fetch; this file intentionally has no SDK code.
 * Keep models-native.js next to this file. Dependency: ajv.
 *
 * requestStructured(args) preserves the previous contract:
 *   Promise<completed Responses API response>, with convenience output_text.
 * It locally validates the output before returning; it never executes it.
 *
 * parseStructuredResponse(response, schema) returns the parsed validated JSON.
 * createModelClient(options) creates an independently configured native client.
 *
 * This is a facade, not a second independent implementation of the SSE parser.
 * No automatic retries. Budget enforcement remains the caller's responsibility.
 */
export {
  requestStructured,
  createNativeModelClient,
  createNativeModelClient as createModelClient,
  parseStructuredResponse,
  getOutputText,
  ModelRequestError,
} from './models-native.js';
