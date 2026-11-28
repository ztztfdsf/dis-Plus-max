import './file-media.js';
import core from './engine.mjs';
export const {maxBytes, makeCarrier, encodeFile, restorePixels, decodeFile} = globalThis.MoeGuardFileMedia(core);
