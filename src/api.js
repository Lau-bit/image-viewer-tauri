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

async function tiffToObjectUrl(filePath) {
  if (!window.UTIF) return convertFileSrc(filePath);

  const bytes = await invoke('read_file_bytes', { filePath });
  const buffer = Uint8Array.from(bytes).buffer;
  const ifds = window.UTIF.decode(buffer);
  if (!ifds.length) return convertFileSrc(filePath);

  window.UTIF.decodeImage(buffer, ifds[0]);
  const rgba = window.UTIF.toRGBA8(ifds[0]);
  const canvas = document.createElement('canvas');
  canvas.width = ifds[0].width;
  canvas.height = ifds[0].height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode TIFF preview.'));
    }, 'image/png');
  });
  return URL.createObjectURL(blob);
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
  scanCategorizedRoot: root => invoke('scan_categorized_root', { root }),
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
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
  },

  copyToClipboard: filePath => invoke('copy_to_clipboard', { filePath }),
  getClipboardDebugInfo: () => invoke('get_clipboard_debug_info'),
  pasteFromClipboard: () => invoke('paste_from_clipboard'),
  savePastedImageBytes: (bytes, extension) => invoke('save_pasted_image_bytes', { bytes, extension }),
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
