'use strict';

// Runs the CPU-heavy UTIF decode off the main thread so navigating to a
// large/uncompressed TIFF doesn't stall the UI. UTIF.js already assigns
// itself via `self.UTIF = UTIF`, so it loads the same way in a worker as it
// does on the main document.
//
// The base64->bytes conversion happens on the main thread (see api.js)
// rather than here, so the resulting ArrayBuffer can be handed to this
// worker via a zero-copy transfer instead of a cloned string.
importScripts('./UTIF.js');

self.onmessage = event => {
  const { id, buffer } = event.data;
  try {
    const ifds = self.UTIF.decode(buffer);
    if (!ifds.length) throw new Error('No image found in TIFF.');
    self.UTIF.decodeImage(buffer, ifds[0]);
    const rgba = self.UTIF.toRGBA8(ifds[0]);
    self.postMessage(
      { id, width: ifds[0].width, height: ifds[0].height, rgba },
      [rgba.buffer]
    );
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
