'use strict';

const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;
const listen = tauri?.event?.listen;
const dialog = tauri?.dialog;
const convertFileSrc = tauri?.core?.convertFileSrc;

if (!invoke || !listen || !dialog || !convertFileSrc) {
  console.error('Tauri API is not available.');
}

const IMAGE_FILTERS = [
  {
    name: 'Image Files',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif', 'tif', 'tiff'],
  },
  { name: 'All Files', extensions: ['*'] },
];

// Converting a TIFF (read bytes -> UTIF decode -> RGBA -> canvas -> PNG blob)
// is expensive in both CPU and RAM, and slideshows / back-and-forth navigation
// revisit the same files repeatedly. Cache the resulting blob URLs in a small
// LRU so a revisit is a free Map hit instead of a full re-decode. The cache
// owns these URLs; revokeFileUrl below must not revoke a cached one, and
// eviction is the only place we revoke.
const TIFF_URL_CACHE_LIMIT = 12;
const tiffUrlCache = new Map(); // filePath -> objectURL (insertion order = LRU)

function rememberTiffUrl(filePath, url) {
  tiffUrlCache.set(filePath, url);
  while (tiffUrlCache.size > TIFF_URL_CACHE_LIMIT) {
    const oldestPath = tiffUrlCache.keys().next().value;
    const oldestUrl = tiffUrlCache.get(oldestPath);
    tiffUrlCache.delete(oldestPath);
    if (oldestUrl?.startsWith('blob:')) URL.revokeObjectURL(oldestUrl);
  }
}

// Tauri's IPC serializes a Vec<u8> as a JSON array of numbers, which is much
// slower to encode/decode and larger on the wire than base64 for multi-MB
// image files. The Rust side sends/accepts base64 (see read_file_bytes /
// save_pasted_image_bytes); these convert to/from the Uint8Array the rest of
// this module works with.
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// The actual UTIF decode (LZW/etc. decompression) is CPU-heavy and was
// blocking the main thread — large/uncompressed TIFFs would visibly freeze
// navigation. It runs in a worker instead; the worker is created lazily and
// reused, with requests multiplexed by id since messages could otherwise
// resolve out of order under fast navigation.
let tiffWorker = null;
let tiffWorkerRequestId = 0;
const tiffWorkerPending = new Map();

function getTiffWorker() {
  if (tiffWorker) return tiffWorker;
  tiffWorker = new Worker('tiff-worker.js');
  tiffWorker.onmessage = event => {
    const { id, width, height, rgba, error } = event.data;
    const pending = tiffWorkerPending.get(id);
    if (!pending) return;
    tiffWorkerPending.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve({ width, height, rgba });
  };
  tiffWorker.onerror = event => {
    for (const pending of tiffWorkerPending.values()) {
      pending.reject(new Error(event.message || 'TIFF worker error'));
    }
    tiffWorkerPending.clear();
  };
  return tiffWorker;
}

function decodeTiffInWorker(buffer) {
  const worker = getTiffWorker();
  const id = ++tiffWorkerRequestId;
  return new Promise((resolve, reject) => {
    tiffWorkerPending.set(id, { resolve, reject });
    worker.postMessage({ id, buffer }, [buffer]);
  });
}

async function tiffToObjectUrl(filePath) {
  if (!window.UTIF) return convertFileSrc(filePath);

  const cached = tiffUrlCache.get(filePath);
  if (cached) {
    // Refresh recency so hot images survive eviction.
    tiffUrlCache.delete(filePath);
    tiffUrlCache.set(filePath, cached);
    return cached;
  }

  const base64 = await invoke('read_file_bytes', { filePath });
  const buffer = base64ToUint8Array(base64).buffer;

  let decoded;
  try {
    decoded = await decodeTiffInWorker(buffer);
  } catch {
    return convertFileSrc(filePath);
  }

  const canvas = document.createElement('canvas');
  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(decoded.rgba), canvas.width, canvas.height),
    0,
    0
  );

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode TIFF preview.'));
    }, 'image/png');
  });
  const url = URL.createObjectURL(blob);
  rememberTiffUrl(filePath, url);
  return url;
}

window.imageAPI = {
  openFile: async () => {
    const selected = await dialog.open({
      multiple: false,
      directory: false,
      filters: IMAGE_FILTERS,
    });
    return selected || null;
  },

  getFolderFiles: filePath => invoke('get_folder_files', { filePath }),

  chooseCategorizedFolder: async () => {
    const selected = await dialog.open({
      title: 'Choose Categorized Root Folder',
      directory: true,
      multiple: false,
    });
    return selected || null;
  },
  scanCategorizedRoot: (root, force = false) => invoke('scan_categorized_root', { root, force }),
  getCategorizedState: () => invoke('get_categorized_state'),
  setCategorizedState: (root, categoryFilter) => invoke('set_categorized_state', { root, categoryFilter }),
  setImageCategory: (root, path, category) => invoke('set_image_category', { root, path, category }),

  getMultiFolders: () => invoke('get_multi_folders'),
  setMultiFolders: folders => invoke('set_multi_folders', { folders }),
  chooseMultiFolder: async () => {
    const selected = await dialog.open({
      title: 'Add Folder',
      directory: true,
      multiple: false,
    });
    return selected || null;
  },
  listMultiFolderFiles: folders => invoke('list_multi_folder_files', { folders }),

  getFileUrl: async filePath => {
    if (/\.(tif|tiff)$/i.test(filePath)) {
      try {
        return await tiffToObjectUrl(filePath);
      } catch {
        return convertFileSrc(filePath);
      }
    }
    return convertFileSrc(filePath);
  },
  revokeFileUrl: url => {
    if (!url?.startsWith('blob:')) return;
    // Don't revoke URLs the TIFF cache still owns — eviction handles those.
    for (const cachedUrl of tiffUrlCache.values()) {
      if (cachedUrl === url) return;
    }
    URL.revokeObjectURL(url);
  },

  copyToClipboard: filePath => invoke('copy_to_clipboard', { filePath }),
  getClipboardDebugInfo: () => invoke('get_clipboard_debug_info'),
  pasteFromClipboard: () => invoke('paste_from_clipboard'),
  savePastedImageBytes: (bytes, extension) =>
    invoke('save_pasted_image_bytes', { bytes: uint8ArrayToBase64(bytes), extension }),
  cleanupPastedFile: filePath => invoke('cleanup_pasted_file', { filePath }),

  getWindowLabel: () => invoke('get_window_label'),
  loadSettings: () => invoke('load_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
  setLastFile: (filePath) => invoke('set_last_file', { filePath }),
  saveWindowPositionPreset: (preset) => invoke('save_window_position_preset', { preset }),
  resetWindowPositionPreset: (preset) => invoke('reset_window_position_preset', { preset }),
  setWindowSquareCorners: (square) => invoke('set_window_square_corners', { square }),
  adjustWindowBorderlessEdges: (expand) => invoke('adjust_window_borderless_edges', { expand }),

  getEditorPath: () => invoke('get_editor_path'),
  setEditorPath: async () => {
    const selected = await dialog.open({
      title: 'Choose image editor',
      multiple: false,
      directory: false,
      filters: [
        { name: 'Executables & Scripts', extensions: ['exe', 'bat', 'cmd', 'ps1', 'sh', 'py', 'js'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (!selected) return null;
    await invoke('set_editor_path', { editorPath: selected });
    return selected;
  },
  openInEditor: filePath => invoke('open_in_editor', { filePath }),

  toggleFullscreen: () => invoke('window_toggle_fullscreen'),
  isFullscreen: () => invoke('window_is_fullscreen'),
  isMinimized: () => invoke('window_is_minimized'),
  minimize: () => invoke('window_minimize'),
  minimizeAll: () => invoke('window_minimize_all'),
  close: () => invoke('window_close'),
  openInNewWindow: (path) => invoke('open_in_new_window', { path }),
  startWindowDrag: () => invoke('window_start_drag'),
  getInitialFile: () => invoke('get_initial_file'),

  onOpenFile: callback => listen('image-open-file', event => callback(event.payload)),
  onExternalOpenRequested: callback => listen('image-external-open-requested', event => callback(event.payload)),
  onFullscreenChanged: callback => listen('window-fullscreen-changed', event => callback(event.payload)),
  onTauriDragEnter: callback => listen('tauri://drag-enter', event => callback(event.payload)),
  onTauriDragLeave: callback => listen('tauri://drag-leave', event => callback(event.payload)),
  onTauriDragDrop: callback => listen('tauri://drag-drop', event => callback(event.payload)),
};
