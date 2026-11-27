// Older Nodes run module.register hooks on a separate thread.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let port;
let testUrl;
let entry;

export function initialize(data) {
  ({ port, testUrl, entry } = data);
}

export async function resolve(specifier, context, nextResolve) {
  const direct = context.parentURL === testUrl && specifier === entry;
  try {
    const result = await nextResolve(specifier, context);
    if (direct && result.url.startsWith('file:')) port.postMessage({ entryUrl: result.url });
    return result;
  } catch (error) {
    if (direct && error.code === 'ERR_MODULE_NOT_FOUND') port.postMessage({ missingUrl: error.url });
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.startsWith('file:')) {
    let realFile = null;
    try { realFile = realpathSync(fileURLToPath(url)); } catch { /* reported by the preload */ }
    port.postMessage({ loadedUrl: url, realFile });
  }
  return result;
}
