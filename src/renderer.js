'use strict';

// Suppress the native WebView2 right-click menu everywhere; custom contextmenu
// handlers (image menu, editor button, slideshow button, categorized folder button)
// still run normally and call their own preventDefault.
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ==============================
// State
// ==============================
const state = {
  filePath: null,
  fileBacked: false,
  folderFiles: [],
  folderIndex: -1,

  // Transform state
  zoom: 1,
  panX: 0,
  panY: 0,
  rotation: 0,

  // Interaction tracking
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  panBaseX: 0,
  panBaseY: 0,

  isRotating: false,
  rotationTimer: null,
  rotationStartAngle: 0,
  rotationBase: 0,
  rotationMouseDown: false,

  // Fill bias (persistent pan offset applied in fill mode; positive X = focus right, positive Y = focus down)
  fillBiasX: (() => { const v = parseInt(localStorage.getItem('imageViewer.fillBiasX'), 10); return Number.isFinite(v) ? v : 0; })(),
  fillBiasY: (() => { const v = parseInt(localStorage.getItem('imageViewer.fillBiasY'), 10); return Number.isFinite(v) ? v : 0; })(),

  // View mode
  trueSizeMode: false,
  appFillMode: false,
  randomize: false,
  randomOrder: [],
  randomIndex: -1,
  randomKnownFiles: new Set(),
  lastRandomRefreshAt: 0,

  // Slideshow
  slideshow: false,
  slideshowPausedForPassiveState: false,
  slideshowDuration: (() => {
    const v = parseInt(localStorage.getItem('imageViewer.slideshowDuration'), 10);
    return Number.isFinite(v) && v > 0 ? v : 3000;
  })(),
  slideshowTimer: null,

  // Folder browsing mode: 'multi' (folder list) or 'categorized' (sidecar root)
  mode: 'multi',
  multiFolders: [],
  multiFolderFilter: new Set(),
  multiImages: [],
  categorizedRoot: null,
  categorizedCategories: [],
  categorizedCategoryFilter: new Set(),
  categorizedImages: [],
};

// Which tab the (possibly closed) folder dropdown is showing — independent of state.mode
// so browsing an empty tab doesn't force-activate it.
let viewedFolderTab = 'multi';
let categorizedCategoryFilterExplicit = false;

const ROTATION_DELAY = 150;
const ZOOM_FACTOR = 1.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const RANDOM_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const RANDOM_NEW_IMAGE_DELAY = 30;
const FOLDER_MODE_STORAGE_KEY = 'imageViewer.folderMode';
let loadSequence = 0;
let folderModeLoadSequence = 0;
let externalOpenRequestedDuringStartup = false;

let appSettings = defaultAppSettings();
let windowLabel = null;

function defaultAppSettings() {
  return {
    showEditorButton: false,
    squareAppCorners: false,
    expandBorderlessEdges: false,
    autoOpenSlideshow: false,
    autoSlideshowFillZoom: false,
    edgeArrowsVisible: false,
    edgeArrowsInvisible: false,
    lastFile: null,
  };
}

function normalizeAppSettings(s) {
  return {
    ...defaultAppSettings(),
    ...(s || {}),
    showEditorButton: !!s?.showEditorButton,
    squareAppCorners: !!s?.squareAppCorners,
    expandBorderlessEdges: !!s?.expandBorderlessEdges,
    autoOpenSlideshow: !!s?.autoOpenSlideshow,
    autoSlideshowFillZoom: !!s?.autoSlideshowFillZoom,
    edgeArrowsVisible: !!s?.edgeArrowsVisible,
    edgeArrowsInvisible: !!s?.edgeArrowsInvisible,
    lastFile: typeof s?.lastFile === 'string' && s.lastFile ? s.lastFile : null,
  };
}

function normalizeFolderMode(mode) {
  return mode === 'categorized' ? 'categorized' : 'multi';
}

function getPersistedFolderMode() {
  return normalizeFolderMode(localStorage.getItem(FOLDER_MODE_STORAGE_KEY));
}

function setActiveFolderMode(mode) {
  state.mode = normalizeFolderMode(mode);
  localStorage.setItem(FOLDER_MODE_STORAGE_KEY, state.mode);
}

async function loadAppSettings() {
  try {
    const raw = await window.imageAPI.loadSettings();
    appSettings = normalizeAppSettings(raw);
  } catch {
    appSettings = defaultAppSettings();
  }
  applySettingsInputs();
}

async function saveAppSettings() {
  try {
    await window.imageAPI.saveSettings(appSettings);
  } catch {
    // ignore
  }
  applySettingsInputs();
}

function applyEditorButtonVisibility() {
  if (btnEditor) {
    btnEditor.hidden = !appSettings.showEditorButton;
  }
}

// Edge zones are clickable when either arrow mode is on; the visible class only
// reveals the chevrons. Clicking near the left/right edges then navigates, but
// with both toggles off the zones disappear entirely (see styles.css).
function applyEdgeNavSettings() {
  const active = appSettings.edgeArrowsVisible || appSettings.edgeArrowsInvisible;
  document.body.classList.toggle('edge-nav-active', active);
  document.body.classList.toggle('edge-nav-visible', appSettings.edgeArrowsVisible);
}

function applySettingsInputs() {
  if (settingShowEditorButton) {
    settingShowEditorButton.checked = appSettings.showEditorButton;
  }
  if (settingSquareAppCorners) {
    settingSquareAppCorners.checked = appSettings.squareAppCorners;
  }
  if (settingExpandBorderlessEdges) {
    settingExpandBorderlessEdges.checked = appSettings.expandBorderlessEdges;
  }
  if (settingAutoOpenSlideshow) {
    settingAutoOpenSlideshow.checked = appSettings.autoOpenSlideshow;
  }
  if (settingAutoSlideshowFillZoom) {
    settingAutoSlideshowFillZoom.checked = appSettings.autoSlideshowFillZoom;
    settingAutoSlideshowFillZoom.disabled = !appSettings.autoOpenSlideshow;
  }
  if (settingEdgeArrowsVisible) {
    settingEdgeArrowsVisible.checked = appSettings.edgeArrowsVisible;
  }
  if (settingEdgeArrowsInvisible) {
    settingEdgeArrowsInvisible.checked = appSettings.edgeArrowsInvisible;
  }
  applyEditorButtonVisibility();
  applyEdgeNavSettings();
}
let transformHintTimer = null;
let currentFileUrl = null;
let currentTempPastedFile = null;
let passiveStateCheckSequence = 0;
let lastPasteAttemptAt = 0;
let lastSuccessfulPasteAt = 0;
let lastPasteInputAt = 0;
let lastDragOverDebugAt = 0;
const DEBUG_ACTIVITY_KEY = 'imageViewer.debugActivityEnabled';
const DEBUG_MAX_EVENTS = 300;

// ==============================
// DOM References
// ==============================
const image            = document.getElementById('image');
const imageContainer   = document.getElementById('image-container');
const edgeNavLeft      = document.getElementById('edge-nav-left');
const edgeNavRight     = document.getElementById('edge-nav-right');
const btnOpenEmpty        = document.getElementById('btn-open-empty');
const btnMinimize         = document.getElementById('btn-minimize');
const btnMinimizeAll      = document.getElementById('btn-minimize-all');
const btnClose            = document.getElementById('btn-close');
const btnReset            = document.getElementById('btn-reset');
const btnCopy             = document.getElementById('btn-copy');
const btnEditor           = document.getElementById('btn-editor');
const btnRandomize        = document.getElementById('btn-randomize');
const btnTrueSize         = document.getElementById('btn-true-size');
const btnFullscreen       = document.getElementById('btn-fullscreen');
const btnSlideshow        = document.getElementById('btn-slideshow');
const contextMenu         = document.getElementById('context-menu');
const ctxCopyImage        = document.getElementById('ctx-copy-image');
const ctxOpenNewWindow    = document.getElementById('ctx-open-new-window');
const ctxCategorizeSection = document.getElementById('ctx-categorize-section');
const slideshowDropdown   = document.getElementById('slideshow-dropdown');
const filenameDisplay     = document.getElementById('filename-display');
const positionDisplay     = document.getElementById('position-display');
const btnSettings         = document.getElementById('btn-settings');
const settingsPanel       = document.getElementById('settings-panel');
const settingSaveFirstWindow        = document.getElementById('setting-save-first-window');
const settingResetFirstWindow       = document.getElementById('setting-reset-first-window');
const settingSaveSecondaryWindow    = document.getElementById('setting-save-secondary-window');
const settingResetSecondaryWindow   = document.getElementById('setting-reset-secondary-window');
const settingSquareAppCorners       = document.getElementById('setting-square-app-corners');
const settingExpandBorderlessEdges  = document.getElementById('setting-expand-borderless-edges');
const settingShowEditorButton       = document.getElementById('setting-show-editor-button');
const settingAutoOpenSlideshow      = document.getElementById('setting-auto-open-slideshow');
const settingAutoSlideshowFillZoom  = document.getElementById('setting-auto-slideshow-fill-zoom');
const settingEdgeArrowsVisible      = document.getElementById('setting-edge-arrows-visible');
const settingEdgeArrowsInvisible    = document.getElementById('setting-edge-arrows-invisible');
const btnFolder               = document.getElementById('btn-folder');
const folderButtonLabel       = document.getElementById('folder-button-label');
const folderPanel             = document.getElementById('folder-panel');
const folderModeTabs          = document.querySelectorAll('.folder-mode-tab');
const folderLoading           = document.getElementById('folder-loading');
const folderLoadingText       = document.getElementById('folder-loading-text');
const folderSectionMulti      = document.getElementById('folder-section-multi');
const folderSectionCategorized = document.getElementById('folder-section-categorized');
const folderMultiAdd          = document.getElementById('folder-multi-add');
const multiFolderListEl       = document.getElementById('multi-folder-list');
const categorizedRootNameEl   = document.getElementById('categorized-root-name');
const categorizedRootChoose   = document.getElementById('categorized-root-choose');
const categoriesList          = document.getElementById('categories-list');
const categoriesSelectAll     = document.getElementById('categories-select-all');
const categoriesSelectNone    = document.getElementById('categories-select-none');
const categoriesRescan        = document.getElementById('categories-rescan');

const btnFillBias         = document.getElementById('btn-fill-bias');
const fillBiasPanel       = document.getElementById('fill-bias-panel');
const fillBiasUp          = document.getElementById('fill-bias-up');
const fillBiasDown        = document.getElementById('fill-bias-down');
const fillBiasLeft        = document.getElementById('fill-bias-left');
const fillBiasRight       = document.getElementById('fill-bias-right');
const fillBiasResetBtn    = document.getElementById('fill-bias-reset');
const fillBiasValX        = document.getElementById('fill-bias-val-x');
const fillBiasValY        = document.getElementById('fill-bias-val-y');
const debugConsole        = document.getElementById('debug-console');
const debugActivityToggle = document.getElementById('debug-activity-toggle');
const debugCopy           = document.getElementById('debug-copy');
const debugClear          = document.getElementById('debug-clear');
const debugClose          = document.getElementById('debug-close');
const debugSummary        = document.getElementById('debug-summary');
const debugLogEl          = document.getElementById('debug-log');

// ==============================
// Debug Console
// ==============================
const debugState = {
  visible: false,
  activityEnabled: localStorage.getItem(DEBUG_ACTIVITY_KEY) === 'true',
  events: [],
  actionCounters: {
    paste: 0,
    load: 0,
    drag: 0,
    copy: 0,
    open: 0,
  },
  activeActions: {
    paste: null,
    load: null,
    drag: null,
    copy: null,
    open: null,
  },
  counters: {
    pasteAttempts: 0,
    pasteSuccesses: 0,
    pasteFailures: 0,
    loadAttempts: 0,
    loadSuccesses: 0,
    loadFailures: 0,
    imageErrors: 0,
  },
};

function startDebugAction(kind, label) {
  debugState.actionCounters[kind] = (debugState.actionCounters[kind] || 0) + 1;
  const action = `${label} #${debugState.actionCounters[kind]}`;
  debugState.activeActions[kind] = action;
  return action;
}

function currentDebugAction(kind, fallback = '') {
  return debugState.activeActions[kind] || fallback;
}

function safeDebugString(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, (_key, item) => {
      if (item instanceof Error) return item.message;
      if (typeof item === 'string' && item.length > 500) return item.slice(0, 500) + '...';
      return item;
    }, 2);
  } catch {
    return String(value);
  }
}

function shortPath(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 120) return text;
  return '...' + text.slice(-117);
}

function debugSnapshot() {
  return {
    activity: debugState.activityEnabled ? 'on' : 'off',
    file: shortPath(state.filePath),
    fileBacked: state.fileBacked,
    folder: state.folderFiles.length ? `${state.folderIndex + 1}/${state.folderFiles.length}` : 'none',
    tempPaste: shortPath(currentTempPastedFile),
    image: image.complete
      ? `${image.naturalWidth || 0}x${image.naturalHeight || 0}`
      : 'loading',
    src: shortPath(image.currentSrc || image.src || ''),
    hidden: document.hidden,
    loadSequence,
    ...debugState.counters,
  };
}

function debugDescriptor(event, data = {}, options = {}) {
  const descriptor = {
    category: options.category || 'Debug',
    action: options.action || '',
    message: options.message || event,
  };

  if (event.startsWith('paste:')) {
    descriptor.category = 'Paste';
    descriptor.action = options.action || currentDebugAction('paste', 'Paste');
  } else if (event.startsWith('clipboard:')) {
    descriptor.category = 'Clipboard';
    descriptor.action = options.action || currentDebugAction('paste', '');
  } else if (event.startsWith('load:') || event.startsWith('image:')) {
    descriptor.category = 'Load';
    descriptor.action = options.action || currentDebugAction('load', data?.sequence ? `Load #${data.sequence}` : '');
  } else if (event.startsWith('drag:') || event.startsWith('tauri-drag:')) {
    descriptor.category = 'Drag';
    descriptor.action = options.action || currentDebugAction('drag', '');
  } else if (event.startsWith('copy:')) {
    descriptor.category = 'Copy';
    descriptor.action = options.action || currentDebugAction('copy', '');
  } else if (event.startsWith('open-dialog:')) {
    descriptor.category = 'Open';
    descriptor.action = options.action || currentDebugAction('open', '');
  } else if (event.startsWith('window:')) {
    descriptor.category = 'Window';
  } else if (event.startsWith('input:')) {
    descriptor.category = 'Input';
  }

  switch (event) {
    case 'app:ready':
      descriptor.category = 'Startup';
      descriptor.message = 'Renderer initialized';
      break;
    case 'debug:activity-on':
      descriptor.message = 'Activity tracking enabled';
      break;
    case 'debug:copy-report':
      descriptor.message = 'Debug report copy requested';
      break;
    case 'input:ctrl-v':
      descriptor.category = 'Input';
      descriptor.action = options.action || currentDebugAction('paste', '');
      descriptor.message = 'Ctrl+V detected';
      break;
    case 'paste:browser-event':
      descriptor.category = 'Input';
      descriptor.message = 'Browser paste event received';
      break;
    case 'paste:browser-file-candidate':
      descriptor.message = 'Browser exposed an image-like file';
      break;
    case 'paste:browser-file':
      descriptor.message = 'Inspecting browser clipboard file';
      break;
    case 'paste:browser-save-bytes':
      descriptor.message = `Saving browser clipboard bytes as ${data?.extension || 'image'}`;
      break;
    case 'paste:browser-save-result':
      descriptor.message = 'Browser clipboard bytes saved';
      break;
    case 'paste:browser-file-fallback-native':
    case 'paste:browser-item-fallback-native':
    case 'paste:browser-html-fallback-native':
      descriptor.message = 'Browser paste path did not open an image, trying native paste';
      break;
    case 'paste:native-start':
      descriptor.category = 'Native Paste';
      descriptor.message = 'Native paste command started';
      break;
    case 'paste:native-result':
      descriptor.category = 'Native Paste';
      descriptor.message = data ? 'Native paste returned a file result' : 'Native paste returned no compatible image';
      break;
    case 'paste:native-error':
      descriptor.category = 'Native Paste';
      descriptor.message = 'Native paste command failed';
      break;
    case 'paste:open-file':
      descriptor.category = 'Result';
      descriptor.message = 'Opening pasted file';
      break;
    case 'paste:open-skipped':
      descriptor.category = 'Result';
      descriptor.message = 'Paste result was empty or unsupported';
      break;
    case 'paste:success':
      descriptor.category = 'Result';
      descriptor.message = 'Paste succeeded';
      break;
    case 'clipboard:snapshot':
      descriptor.message = `Clipboard snapshot: ${data?.stage || 'unknown stage'}`;
      break;
    case 'clipboard:snapshot-error':
      descriptor.message = 'Clipboard snapshot failed';
      break;
    case 'load:start':
      descriptor.message = 'File load started';
      break;
    case 'load:folder-files':
      descriptor.message = `Folder scan returned ${data?.count ?? 0} image(s)`;
      break;
    case 'load:file-url':
      descriptor.message = 'Display URL resolved';
      break;
    case 'load:image-src-set':
      descriptor.message = 'Image element source updated';
      break;
    case 'image:load':
      descriptor.message = 'Image rendered successfully';
      break;
    case 'image:error':
      descriptor.message = 'Image element failed to load';
      break;
    case 'open-dialog:start':
      descriptor.message = 'Open file dialog requested';
      break;
    case 'open-dialog:result':
      descriptor.message = data?.filePath ? 'Open file dialog selected a file' : 'Open file dialog was cancelled';
      break;
    case 'drag:drop':
    case 'tauri-drag:drop':
      descriptor.message = 'Drop event received';
      break;
    case 'window:error':
      descriptor.category = 'Runtime';
      descriptor.message = 'Window error event';
      break;
    case 'window:unhandled-rejection':
      descriptor.category = 'Runtime';
      descriptor.message = 'Unhandled promise rejection';
      break;
  }

  return descriptor;
}

function renderDebugConsole() {
  if (!debugConsole) return;

  debugActivityToggle.checked = debugState.activityEnabled;

  const snapshot = debugSnapshot();
  debugSummary.replaceChildren(...Object.entries(snapshot).flatMap(([key, value]) => {
    const keyEl = document.createElement('div');
    keyEl.className = 'debug-summary-key';
    keyEl.textContent = key;
    const valueEl = document.createElement('div');
    valueEl.className = 'debug-summary-value';
    valueEl.title = String(value);
    valueEl.textContent = String(value);
    return [keyEl, valueEl];
  }));

  if (!debugState.events.length) {
    const empty = document.createElement('div');
    empty.className = 'debug-empty';
    empty.textContent = debugState.activityEnabled
      ? 'No activity recorded yet.'
      : 'Activity is off.';
    debugLogEl.replaceChildren(empty);
    return;
  }

  const rows = debugState.events.slice(-DEBUG_MAX_EVENTS).map(entry => {
    const row = document.createElement('div');
    row.className = 'debug-row';

    const header = document.createElement('div');
    header.className = 'debug-row-header';

    const time = document.createElement('div');
    time.className = 'debug-time';
    time.textContent = entry.time;

    const category = document.createElement('div');
    category.className = 'debug-category';
    category.textContent = entry.category;

    const action = document.createElement('div');
    action.className = 'debug-action';
    action.textContent = entry.action || '-';
    action.title = entry.action || '';

    const message = document.createElement('div');
    message.className = 'debug-message';
    message.textContent = entry.message;

    const eventName = document.createElement('div');
    eventName.className = 'debug-event-name';
    eventName.textContent = entry.event;

    const data = document.createElement('div');
    data.className = 'debug-data';
    data.textContent = entry.data;

    header.append(time, category, action, message);
    row.append(header, eventName);
    if (entry.data) {
      const dataLabel = document.createElement('div');
      dataLabel.className = 'debug-data-label';
      dataLabel.textContent = 'technical data';
      row.append(dataLabel, data);
    }
    return row;
  });
  debugLogEl.replaceChildren(...rows);
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

function debugLog(event, data, options = {}) {
  if (!debugState.activityEnabled) return;

  const descriptor = debugDescriptor(event, data, options);
  debugState.events.push({
    time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
    timestamp: new Date().toISOString(),
    event,
    category: descriptor.category,
    action: descriptor.action,
    message: descriptor.message,
    data: safeDebugString(data),
  });
  if (debugState.events.length > DEBUG_MAX_EVENTS) {
    debugState.events.splice(0, debugState.events.length - DEBUG_MAX_EVENTS);
  }
  if (debugState.visible) renderDebugConsole();
}

function setDebugConsoleVisible(visible) {
  debugState.visible = visible;
  debugConsole.classList.toggle('open', visible);
  debugConsole.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) renderDebugConsole();
}

function toggleDebugConsole() {
  setDebugConsoleVisible(!debugState.visible);
}

function setDebugActivity(enabled) {
  debugState.activityEnabled = enabled;
  localStorage.setItem(DEBUG_ACTIVITY_KEY, enabled ? 'true' : 'false');
  if (enabled) {
    debugLog('debug:activity-on', debugSnapshot(), { category: 'Debug', message: 'Activity tracking enabled' });
  }
  renderDebugConsole();
}

function clearDebugLog() {
  debugState.events = [];
  debugState.counters = {
    pasteAttempts: 0,
    pasteSuccesses: 0,
    pasteFailures: 0,
    loadAttempts: 0,
    loadSuccesses: 0,
    loadFailures: 0,
    imageErrors: 0,
  };
  renderDebugConsole();
}

function isDebugToggleKey(e) {
  return e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '§' || e.code === 'Backquote');
}

function isAppFillToggleKey(e) {
  return !e.ctrlKey && !e.altKey && !e.metaKey &&
    (e.key === '§' || e.code === 'Backquote' || e.key === 'z' || e.key === 'Z');
}

function buildDebugReport() {
  const snapshot = debugSnapshot();
  const lines = [
    'Image Viewer Debug Report',
    `Generated: ${new Date().toISOString()}`,
    `App URL: ${window.location.href}`,
    `User Agent: ${navigator.userAgent}`,
    '',
    'Summary:',
  ];

  for (const [key, value] of Object.entries(snapshot)) {
    lines.push(`- ${key}: ${value}`);
  }

  lines.push('', 'Events:');
  if (!debugState.events.length) {
    lines.push(debugState.activityEnabled ? '- No activity recorded yet.' : '- Activity tracking was off.');
  } else {
    let lastAction = null;
    for (const entry of debugState.events) {
      if (entry.action && entry.action !== lastAction) {
        lines.push('', `[${entry.action}]`);
        lastAction = entry.action;
      }
      lines.push(`${entry.timestamp || entry.time} | ${entry.category} | ${entry.message} | ${entry.event}`);
      if (entry.data) {
        lines.push('  data:');
        for (const line of entry.data.split('\n')) {
          lines.push(`    ${line}`);
        }
      }
    }
  }

  return lines.join('\n');
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  return ok;
}

async function copyDebugReport() {
  debugLog('debug:copy-report', {
    eventCount: debugState.events.length,
    activityEnabled: debugState.activityEnabled,
  }, { category: 'Debug', message: 'Debug report copy requested' });
  const report = buildDebugReport();
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(report);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyText(report);
  }

  const previous = debugCopy.textContent;
  debugCopy.textContent = copied ? 'Copied' : 'Copy failed';
  showToast(copied ? 'Debug report copied' : 'Failed to copy debug report');
  setTimeout(() => {
    debugCopy.textContent = previous;
  }, 1200);
  if (debugState.visible) renderDebugConsole();
}

async function logClipboardDebug(stage) {
  if (!debugState.activityEnabled) return;
  try {
    const info = await window.imageAPI.getClipboardDebugInfo();
    debugLog('clipboard:snapshot', { stage, ...info });
  } catch (error) {
    debugLog('clipboard:snapshot-error', { stage, error: error?.message || String(error) });
  }
}

debugActivityToggle.checked = debugState.activityEnabled;
debugActivityToggle.addEventListener('change', () => setDebugActivity(debugActivityToggle.checked));
debugCopy.addEventListener('click', copyDebugReport);
debugClear.addEventListener('click', clearDebugLog);
debugClose.addEventListener('click', () => setDebugConsoleVisible(false));
debugLog('app:ready', {
  tauri: !!window.__TAURI__,
  href: window.location.href,
  debugActivity: debugState.activityEnabled,
});
setInterval(() => {
  if (debugState.visible) renderDebugConsole();
}, 1000);
window.addEventListener('error', event => {
  debugLog('window:error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});
window.addEventListener('unhandledrejection', event => {
  debugLog('window:unhandled-rejection', {
    reason: event.reason?.message || String(event.reason),
  });
});

// ==============================
// Transform Application
// ==============================
function applyTransform(animate = false) {
  document.body.classList.add('image-transforming');
  clearTimeout(transformHintTimer);
  transformHintTimer = setTimeout(() => {
    if (!state.isPanning && !state.isRotating) {
      document.body.classList.remove('image-transforming');
    }
  }, animate ? 400 : 200);

  if (animate) {
    image.style.transition = 'transform 0.3s ease-out';
    image.addEventListener('transitionend', () => {
      image.style.transition = '';
    }, { once: true });
  } else {
    image.style.transition = '';
  }

  image.style.transform =
    `translate(${state.panX}px, ${state.panY}px) ` +
    `scale(${state.zoom}) ` +
    `rotate(${state.rotation}deg)`;

  updateResetButton();
}

// High-frequency interactions (wheel zoom, pan drag, rotate drag) can fire well
// above the display refresh rate. Coalesce their transform writes into one per
// frame so we don't recompute styles / touch the DOM more often than the screen
// can show. State is mutated synchronously by the handlers; the frame just reads
// the latest values, so no input is lost.
let transformFrame = null;
function scheduleTransform() {
  if (transformFrame !== null) return;
  transformFrame = requestAnimationFrame(() => {
    transformFrame = null;
    applyTransform(false);
  });
}

function isTransformed() {
  return state.zoom !== 1 || state.panX !== 0 || state.panY !== 0 ||
         state.rotation !== 0;
}

function updateResetButton() {
  btnReset.classList.toggle('visible', isTransformed());
}

function centerImage(animate = true) {
  if (state.appFillMode) {
    applyAppFillTransform(animate);
    return;
  }
  state.panX = 0;
  state.panY = 0;
  applyTransform(animate);
}

function resetTransform(animate = true) {
  if (state.appFillMode) {
    applyAppFillTransform(animate);
    return;
  }

  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.rotation = 0;
  applyTransform(animate);
}

function getContainedImageSize() {
  const rect = imageContainer.getBoundingClientRect();
  const imageWidth = image.naturalWidth || 0;
  const imageHeight = image.naturalHeight || 0;
  if (!rect.width || !rect.height || !imageWidth || !imageHeight) {
    return null;
  }

  const containScale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
  return {
    width: imageWidth * containScale,
    height: imageHeight * containScale,
    containerWidth: rect.width,
    containerHeight: rect.height,
  };
}

function applyAppFillTransform(animate = false) {
  const size = getContainedImageSize();
  if (!size) {
    applyTransform(animate);
    return;
  }

  // Zoom must be large enough to fill the container AND leave room for the bias pan.
  // This means for any bias, the image always fills — no clamping to a tiny natural overflow.
  const biasX = Math.abs(state.fillBiasX);
  const biasY = Math.abs(state.fillBiasY);
  const fillZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.max(
    (size.containerWidth  + 2 * biasX) / size.width,
    (size.containerHeight + 2 * biasY) / size.height,
  )));

  const maxPanX = Math.max(0, (size.width  * fillZoom - size.containerWidth)  / 2);
  const maxPanY = Math.max(0, (size.height * fillZoom - size.containerHeight) / 2);

  state.zoom = fillZoom;
  state.panX = Math.max(-maxPanX, Math.min(maxPanX, -state.fillBiasX));
  state.panY = Math.max(-maxPanY, Math.min(maxPanY, -state.fillBiasY));
  state.rotation = 0;
  applyTransform(animate);
}

function setUiHidden(hidden) {
  const changed = document.body.classList.contains('ui-hidden') !== hidden;
  document.body.classList.toggle('ui-hidden', hidden);
  if (changed && state.appFillMode) {
    requestAnimationFrame(() => applyAppFillTransform(false));
  }
}

function isUiHidden() {
  return document.body.classList.contains('ui-hidden');
}

function toggleUiHidden() {
  setUiHidden(!isUiHidden());
}

function setAppFillMode(enabled) {
  if (enabled === state.appFillMode) return;

  if (enabled) {
    state.appFillMode = true;
    document.body.classList.add('app-fill-mode');
    requestAnimationFrame(() => applyAppFillTransform(true));
  } else {
    state.appFillMode = false;
    document.body.classList.remove('app-fill-mode');
    resetTransform(true);
  }
}

function toggleAppFillMode() {
  setAppFillMode(!state.appFillMode);
}

function exitAppFillModePreservingUi() {
  if (!state.appFillMode) return false;
  state.appFillMode = false;
  document.body.classList.remove('app-fill-mode');
  resetTransform(true);
  return true;
}

function exitHiddenAndFillModes() {
  if (state.appFillMode) {
    exitAppFillModePreservingUi();
    return true;
  }

  if (isUiHidden()) {
    setUiHidden(false);
    return true;
  }

  return false;
}

// ==============================
// Load File
// ==============================
function cleanupTempPastedFile(filePath) {
  if (filePath) {
    window.imageAPI.cleanupPastedFile(filePath).catch(() => {});
  }
}

function finishStartupLoadingAfterImageReady(timeoutMs = 5000) {
  if (!document.body.classList.contains('app-starting')) return;

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    image.removeEventListener('load', finish);
    image.removeEventListener('error', finish);
    // Remove the class directly rather than inside requestAnimationFrame: when the
    // window launches occluded at Windows login the compositor suspends rAF
    // indefinitely, which would leave the near-black startup overlay up forever.
    document.body.classList.remove('app-starting');
  };
  const timeoutId = setTimeout(finish, timeoutMs);

  image.addEventListener('load', finish);
  image.addEventListener('error', finish);

  // Cover the case where the image finished loading before the listeners above
  // were attached. A timer (not rAF) so it still runs while the window is occluded.
  setTimeout(() => {
    if (image.complete && (image.currentSrc || image.src)) {
      finish();
    }
  }, 0);
}

// Defense-in-depth: the body.app-starting overlay hides the whole UI until the
// first image is ready. If anything during startup stalls — a hung IPC call, a
// requestAnimationFrame that never fires because the window launched occluded at
// Windows login, an unexpected throw — never leave that near-black panel up
// forever ("black screen, image never appears"). setTimeout fires even while the
// window is occluded, so this always reveals the UI as a last resort.
setTimeout(() => {
  if (document.body.classList.contains('app-starting')) {
    document.body.classList.remove('app-starting');
    debugLog('startup:overlay-force-clear', {});
  }
}, 8000);

async function loadFile(filePath, { temporary = false, fromRandom = false } = {}) {
  if (!filePath) return;
  const sequence = ++loadSequence;
  const loadAction = startDebugAction('load', 'Load');
  const previousTempPastedFile = currentTempPastedFile;
  debugState.counters.loadAttempts++;
  debugLog('load:start', { filePath, temporary, sequence }, { action: loadAction });

  state.filePath = filePath;
  state.fileBacked = true;

  let folderFiles;
  try {
    folderFiles = temporary
      ? [filePath]
      : (fromRandom || state.mode === 'multi' || state.mode === 'categorized') && state.folderFiles.length
        ? state.folderFiles
        : await window.imageAPI.getFolderFiles(filePath);
    debugLog('load:folder-files', { sequence, count: folderFiles.length });
  } catch (error) {
    debugState.counters.loadFailures++;
    debugLog('load:folder-files-error', { sequence, error: error?.message || String(error) });
    throw error;
  }
  if (sequence !== loadSequence) return;

  let fileUrl;
  try {
    fileUrl = await window.imageAPI.getFileUrl(filePath);
    debugLog('load:file-url', { sequence, fileUrl: shortPath(fileUrl) });
  } catch (error) {
    debugState.counters.loadFailures++;
    debugLog('load:file-url-error', { sequence, error: error?.message || String(error) });
    throw error;
  }
  if (sequence !== loadSequence) return;

  state.folderFiles = folderFiles;
  state.folderIndex = state.folderFiles.indexOf(filePath);
  currentTempPastedFile = temporary ? filePath : null;
  if (state.randomize && !fromRandom && !temporary) {
    buildRandomOrder(state.folderFiles, filePath);
  }

  const previousFileUrl = currentFileUrl;
  currentFileUrl = fileUrl;
  image.src = fileUrl;
  debugLog('load:image-src-set', { sequence, src: shortPath(fileUrl) });
  window.imageAPI.revokeFileUrl(previousFileUrl);
  if (previousTempPastedFile && previousTempPastedFile !== currentTempPastedFile) {
    cleanupTempPastedFile(previousTempPastedFile);
  }

  const name = filePath.replace(/\\/g, '/').split('/').pop();
  filenameDisplay.textContent = name;
  document.title = name + ' \u2014 Image Viewer';

  renderPositionDisplay();

  document.body.classList.add('has-image');

  // Reset transforms when loading a new image
  resetTransform(false);
  if (!temporary) {
    appSettings.lastFile = filePath;
    queueLastFilePersist(filePath);
  }
  debugState.counters.loadSuccesses++;
  if (debugState.visible) renderDebugConsole();
}

// Persisting lastFile hits disk in Rust (read + parse + write settings.json).
// During an active slideshow that fires on every image, which is pure churn
// since only the most recent value matters. Debounce the write and flush it
// when the window goes to the background / closes so nothing is lost.
let lastFilePersistTimer = null;
let pendingLastFile = null;
const LAST_FILE_PERSIST_DELAY = 1500;

function flushLastFilePersist() {
  if (lastFilePersistTimer) {
    clearTimeout(lastFilePersistTimer);
    lastFilePersistTimer = null;
  }
  if (pendingLastFile === null) return;
  const filePath = pendingLastFile;
  pendingLastFile = null;
  window.imageAPI.setLastFile(filePath).catch(() => {});
}

function queueLastFilePersist(filePath) {
  pendingLastFile = filePath;
  if (lastFilePersistTimer) clearTimeout(lastFilePersistTimer);
  lastFilePersistTimer = setTimeout(flushLastFilePersist, LAST_FILE_PERSIST_DELAY);
}

window.addEventListener('beforeunload', flushLastFilePersist);

image.addEventListener('load', () => {
  debugLog('image:load', {
    filePath: state.filePath,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    src: shortPath(image.currentSrc || image.src),
  });
  if (state.appFillMode) {
    applyAppFillTransform(false);
  }
  if (debugState.visible) renderDebugConsole();
});

image.addEventListener('error', () => {
  debugState.counters.imageErrors++;
  debugLog('image:error', {
    filePath: state.filePath,
    src: shortPath(image.currentSrc || image.src),
  });
  if (debugState.visible) renderDebugConsole();
});

function setFullscreenUi(isFullscreen) {
  document.body.classList.toggle('window-fullscreen', isFullscreen);
  debugLog('window:fullscreen-ui', { isFullscreen });
}

// ==============================
// Folder Navigation
// ==============================
const NAV_MIN_INTERVAL = 1000 / 10; // cap at 10 images per second
let lastNavTime = 0;
let lastNavigationBlockedByThrottle = false;

function fileKey(filePath) {
  return String(filePath || '').toLocaleLowerCase();
}

function shuffleFiles(files) {
  const shuffled = [...files];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function uniqueFiles(files) {
  const seen = new Set();
  const unique = [];
  for (const file of files || []) {
    const key = fileKey(file);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

function setRandomKnownFiles(files) {
  state.randomKnownFiles = new Set(uniqueFiles(files).map(fileKey));
}

function buildRandomOrder(files, currentFile = state.filePath) {
  const unique = uniqueFiles(files);
  const currentKey = fileKey(currentFile);
  const hasCurrent = unique.some(file => fileKey(file) === currentKey);
  const remaining = unique.filter(file => fileKey(file) !== currentKey);
  const shuffled = shuffleFiles(remaining);

  state.randomOrder = hasCurrent ? [currentFile, ...shuffled] : shuffled;
  state.randomIndex = hasCurrent ? 0 : -1;
  setRandomKnownFiles(unique);
}

function syncRandomizeButton() {
  btnRandomize.classList.toggle('active', state.randomize);
}

function setRandomize(enabled) {
  state.randomize = enabled;
  if (enabled) {
    buildRandomOrder(state.folderFiles, state.filePath);
    state.lastRandomRefreshAt = performance.now();
  } else {
    state.randomOrder = [];
    state.randomIndex = -1;
    state.randomKnownFiles = new Set();
  }
  syncRandomizeButton();
}

function toggleRandomize() {
  setRandomize(!state.randomize);
}

// After a folder/category filter change, rebuild the shuffled deck from the now
// active file set. Without this the deck keeps entries from deselected folders
// or categories, so randomized navigation and the slideshow keep drawing images
// the UI shows as inactive (the deck is only rebuilt by loadFile, and only when
// the current image itself leaves the filter).
function resyncRandomOrderAfterFilterChange() {
  if (!state.randomize) return;
  buildRandomOrder(state.folderFiles, state.filePath);
}

function randomInsertIndex() {
  const firstDelayedIndex = state.randomIndex + RANDOM_NEW_IMAGE_DELAY;
  const start = Math.min(Math.max(state.randomIndex + 1, firstDelayedIndex), state.randomOrder.length);
  if (start >= state.randomOrder.length) return state.randomOrder.length;
  return start + Math.floor(Math.random() * (state.randomOrder.length - start + 1));
}

async function refreshRandomFolderFiles(force = false) {
  if (!state.randomize || !state.filePath || currentTempPastedFile) return;

  const now = performance.now();
  if (!force && now - state.lastRandomRefreshAt < RANDOM_REFRESH_INTERVAL_MS) return;
  state.lastRandomRefreshAt = now;

  let refreshed;
  if (state.mode === 'multi' || state.mode === 'categorized') {
    // Multi-folder and categorized modes maintain their own filtered aggregation
    // in state.folderFiles. Re-scanning the raw on-disk folder here would ignore
    // the active folder/category filter and pull siblings from other categories
    // into the deck. Stay within the filtered set; rescans update it elsewhere.
    refreshed = uniqueFiles(state.folderFiles);
  } else {
    try {
      refreshed = uniqueFiles(await window.imageAPI.getFolderFiles(state.filePath));
    } catch (error) {
      debugLog('random:refresh-error', { error: error?.message || String(error) });
      return;
    }
  }

  const refreshedKeys = new Set(refreshed.map(fileKey));
  const newFiles = refreshed.filter(file => !state.randomKnownFiles.has(fileKey(file)));

  state.folderFiles = refreshed;
  state.folderIndex = state.folderFiles.findIndex(file => fileKey(file) === fileKey(state.filePath));

  state.randomOrder = state.randomOrder.filter((file, index) => {
    return index <= state.randomIndex || refreshedKeys.has(fileKey(file));
  });

  if (!state.randomOrder.some(file => fileKey(file) === fileKey(state.filePath))) {
    state.randomOrder.splice(Math.max(0, state.randomIndex), 0, state.filePath);
  }

  state.randomIndex = state.randomOrder.findIndex(file => fileKey(file) === fileKey(state.filePath));
  if (state.randomIndex < 0) state.randomIndex = 0;

  for (const file of shuffleFiles(newFiles)) {
    state.randomOrder.splice(randomInsertIndex(), 0, file);
  }

  setRandomKnownFiles(refreshed);
  debugLog('random:refresh', {
    known: state.randomKnownFiles.size,
    added: newFiles.length,
    index: state.randomIndex,
    order: state.randomOrder.length,
  });
}

async function reshuffleRandomDeck() {
  await refreshRandomFolderFiles(true);
  const previousFile = state.filePath;
  const files = state.folderFiles.length ? state.folderFiles : state.randomOrder;
  const nextDeck = shuffleFiles(uniqueFiles(files));

  if (nextDeck.length > 1 && fileKey(nextDeck[0]) === fileKey(previousFile)) {
    const swapIndex = 1 + Math.floor(Math.random() * (nextDeck.length - 1));
    [nextDeck[0], nextDeck[swapIndex]] = [nextDeck[swapIndex], nextDeck[0]];
  }

  state.randomOrder = nextDeck;
  state.randomIndex = -1;
  setRandomKnownFiles(files);
}

async function navigateRandomNext() {
  await refreshRandomFolderFiles(false);
  let nextIndex = state.randomIndex + 1;
  if (nextIndex >= state.randomOrder.length) {
    await reshuffleRandomDeck();
    nextIndex = 0;
  }

  const next = state.randomOrder[nextIndex];
  if (!next) return false;
  state.randomIndex = nextIndex;
  loadFile(next, { fromRandom: true });
  return true;
}

function navigateRandomPrev() {
  if (state.randomIndex <= 0) return false;
  state.randomIndex--;
  const prev = state.randomOrder[state.randomIndex];
  if (!prev) return false;
  loadFile(prev, { fromRandom: true });
  return true;
}

async function navigateNext() {
  if (!state.folderFiles.length) return false;
  const now = performance.now();
  lastNavigationBlockedByThrottle = false;
  if (now - lastNavTime < NAV_MIN_INTERVAL) {
    lastNavigationBlockedByThrottle = true;
    return false;
  }
  lastNavTime = now;

  if (state.randomize) {
    return navigateRandomNext();
  }

  const next = state.folderIndex + 1;
  if (next >= state.folderFiles.length) return false;
  loadFile(state.folderFiles[next]);
  return true;
}

function navigatePrev() {
  if (!state.folderFiles.length) return false;
  const now = performance.now();
  lastNavigationBlockedByThrottle = false;
  if (now - lastNavTime < NAV_MIN_INTERVAL) {
    lastNavigationBlockedByThrottle = true;
    return false;
  }
  lastNavTime = now;

  if (state.randomize) {
    return navigateRandomPrev();
  }

  const prev = state.folderIndex - 1;
  if (prev < 0) return false;
  loadFile(state.folderFiles[prev]);
  return true;
}

// Legacy wrapper kept for slideshow which always goes forward
function navigateFolder(delta) {
  if (delta > 0) void navigateNext();
  else navigatePrev();
}

// ==============================
// Folder Modes (Multi-Folder / Categorized)
// ==============================
function baseName(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

function parentFolder(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index).replace(/\//g, '\\');
}

function enabledMultiFolders() {
  return state.multiFolders.filter(folder => state.multiFolderFilter.has(fileKey(folder)));
}

function persistMultiFolderFilter() {
  localStorage.setItem('imageViewer.multiFolderFilter', JSON.stringify([...state.multiFolderFilter]));
}

function normalizeMultiFolderFilter({ defaultAll = true } = {}) {
  const folderKeys = new Set(state.multiFolders.map(fileKey));
  state.multiFolderFilter = new Set([...state.multiFolderFilter].filter(key => folderKeys.has(key)));
  if (defaultAll && !state.multiFolderFilter.size) {
    state.multiFolderFilter = new Set(folderKeys);
  }
  persistMultiFolderFilter();
}

function nextAnimationFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function beginFolderModeLoad(mode, message) {
  const sequence = ++folderModeLoadSequence;
  folderPanel.classList.add('loading');
  folderPanel.dataset.loadingMode = mode;
  if (folderLoadingText) folderLoadingText.textContent = message;
  if (folderLoading) folderLoading.hidden = false;
  return sequence;
}

function isCurrentFolderModeLoad(sequence, mode) {
  return sequence === folderModeLoadSequence && viewedFolderTab === mode;
}

function endFolderModeLoad(sequence) {
  if (sequence !== folderModeLoadSequence) return;
  folderPanel.classList.remove('loading');
  delete folderPanel.dataset.loadingMode;
  if (folderLoading) folderLoading.hidden = true;
}

function setFolderPanelOpen(open) {
  folderPanel.classList.toggle('open', open);
}

function toggleFolderPanelOpen() {
  setFolderPanelOpen(!folderPanel.classList.contains('open'));
}

function renderFolderButton() {
  let label = 'Open';
  if (state.mode === 'multi') {
    const enabled = enabledMultiFolders();
    label = !state.multiFolders.length
      ? 'Open'
      : enabled.length === 1
      ? baseName(enabled[0])
      : `${enabled.length} / ${state.multiFolders.length} folders`;
  } else if (state.mode === 'categorized') {
    label = state.categorizedRoot ? baseName(state.categorizedRoot) : 'Categorized';
  }
  folderButtonLabel.textContent = label;
  btnFolder.classList.toggle('mode-multi', state.mode === 'multi');
  btnFolder.classList.toggle('mode-categorized', state.mode === 'categorized');
}

function renderFolderPanelSections() {
  folderModeTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === viewedFolderTab);
    tab.classList.toggle('current-mode', tab.dataset.mode === state.mode);
  });
  folderSectionMulti.classList.toggle('visible', viewedFolderTab === 'multi');
  folderSectionCategorized.classList.toggle('visible', viewedFolderTab === 'categorized');
}

function applyAggregatedFolderFiles(images) {
  const files = images
    .slice()
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .map(image => image.path);

  state.folderFiles = files;
  state.folderIndex = files.indexOf(state.filePath);
  renderPositionDisplay();
  return files;
}

// --- Multi-folder mode ---

function renderMultiFolderList() {
  multiFolderListEl.innerHTML = '';
  normalizeMultiFolderFilter({ defaultAll: false });
  if (!state.multiFolders.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'No folders added yet.';
    multiFolderListEl.append(empty);
    return;
  }
  for (const folder of state.multiFolders) {
    const row = document.createElement('div');
    row.className = 'multi-folder-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.multiFolderFilter.has(fileKey(folder));
    checkbox.addEventListener('change', () => toggleMultiFolder(folder));
    const name = document.createElement('span');
    name.className = 'multi-folder-name';
    name.textContent = baseName(folder);
    name.title = folder;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'multi-folder-remove';
    removeButton.textContent = '✕';
    removeButton.title = `Remove ${folder}`;
    removeButton.addEventListener('click', (e) => {
      e.stopPropagation();
      removeMultiFolder(folder);
    });
    row.append(checkbox, name, removeButton);
    multiFolderListEl.append(row);
  }
}

function persistMultiFolders() {
  window.imageAPI.setMultiFolders([...state.multiFolders]).catch(() => {});
}

function recomputeMultiFolderFiles() {
  return applyAggregatedFolderFiles(state.multiImages);
}

async function enterMultiMode({ loadSequence: sequence = null } = {}) {
  if (!state.multiFolders.length) {
    if (sequence && !isCurrentFolderModeLoad(sequence, 'multi')) return null;
    setActiveFolderMode('multi');
    state.multiImages = [];
    applyAggregatedFolderFiles([]);
    renderFolderButton();
    return null;
  }
  normalizeMultiFolderFilter({ defaultAll: false });
  const folders = enabledMultiFolders();
  if (!folders.length) {
    if (sequence && !isCurrentFolderModeLoad(sequence, 'multi')) return null;
    setActiveFolderMode('multi');
    state.multiImages = [];
    applyAggregatedFolderFiles([]);
    renderFolderButton();
    return null;
  }
  let images;
  try {
    images = await window.imageAPI.listMultiFolderFiles(folders);
  } catch (error) {
    if (sequence && !isCurrentFolderModeLoad(sequence, 'multi')) return null;
    showToast(errorText(error));
    return null;
  }
  if (sequence && !isCurrentFolderModeLoad(sequence, 'multi')) return null;
  state.multiImages = images;
  setActiveFolderMode('multi');
  renderFolderButton();
  const filtered = recomputeMultiFolderFiles();
  return filtered[0] || null;
}

async function addMultiFolder() {
  const folderPath = await window.imageAPI.chooseMultiFolder();
  if (!folderPath) return;
  const key = fileKey(folderPath);
  if (state.multiFolders.some(folder => fileKey(folder) === key)) {
    showToast('Folder already added');
    return;
  }
  state.multiFolders.push(folderPath);
  state.multiFolderFilter.add(key);
  persistMultiFolderFilter();
  renderMultiFolderList();
  persistMultiFolders();
  const firstPath = await enterMultiMode();
  if (firstPath && !state.folderFiles.includes(state.filePath)) {
    loadFile(firstPath);
  }
}

async function openFileInMultiFolderMode(filePath, loadOptions = {}) {
  if (!filePath) return;
  const folder = parentFolder(filePath);
  if (folder) {
    const key = fileKey(folder);
    if (!state.multiFolders.some(item => fileKey(item) === key)) {
      state.multiFolders.push(folder);
    }
    state.multiFolderFilter = new Set([key]);
    persistMultiFolders();
    persistMultiFolderFilter();
    renderMultiFolderList();
    await enterMultiMode();
  } else {
    setActiveFolderMode('multi');
    renderFolderButton();
  }
  await loadFile(filePath, loadOptions);
  viewedFolderTab = 'multi';
  renderFolderPanelSections();
}

async function removeMultiFolder(folder) {
  const key = fileKey(folder);
  state.multiFolders = state.multiFolders.filter(item => fileKey(item) !== key);
  state.multiFolderFilter.delete(key);
  persistMultiFolderFilter();
  renderMultiFolderList();
  persistMultiFolders();
  if (!state.multiFolders.length) {
    await enterMultiMode();
    return;
  }
  const firstPath = await enterMultiMode();
  if (!state.folderFiles.includes(state.filePath)) {
    if (firstPath) {
      loadFile(firstPath);
    } else {
      showToast('No images found in the remaining folders');
    }
  } else {
    resyncRandomOrderAfterFilterChange();
  }
}

async function toggleMultiFolder(folder) {
  const key = fileKey(folder);
  if (state.multiFolderFilter.has(key)) {
    state.multiFolderFilter.delete(key);
  } else {
    state.multiFolderFilter.add(key);
  }
  persistMultiFolderFilter();
  renderMultiFolderList();
  const firstPath = await enterMultiMode();
  if (!state.folderFiles.includes(state.filePath)) {
    if (firstPath) {
      loadFile(firstPath);
    } else {
      showToast('No folders are enabled');
    }
  } else {
    resyncRandomOrderAfterFilterChange();
  }
}

async function activateMultiTab({ loadSequence: sequence = null } = {}) {
  if (!state.multiFolders.length) return;
  const firstPath = await enterMultiMode({ loadSequence: sequence });
  if (sequence && !isCurrentFolderModeLoad(sequence, 'multi')) return;
  if (firstPath) await loadFile(firstPath);
}

// --- Categorized root mode ---

function renderCategorizedRootRow() {
  categorizedRootNameEl.textContent = state.categorizedRoot ? baseName(state.categorizedRoot) : 'No root chosen';
  categorizedRootNameEl.title = state.categorizedRoot || '';
}

function renderCategoriesPanel() {
  categoriesList.innerHTML = '';
  if (!state.categorizedCategories.length) {
    const empty = document.createElement('div');
    empty.className = 'categories-empty';
    empty.textContent = 'No categorized images found.';
    categoriesList.append(empty);
    return;
  }
  for (const category of state.categorizedCategories) {
    const row = document.createElement('label');
    row.className = 'category-checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.categorizedCategoryFilter.has(category.name);
    checkbox.addEventListener('change', () => toggleCategorizedCategory(category.name));
    const name = document.createElement('span');
    name.className = 'category-checkbox-name';
    name.textContent = category.name;
    const count = document.createElement('span');
    count.className = 'category-checkbox-count';
    count.textContent = String(category.count);
    row.append(checkbox, name, count);
    categoriesList.append(row);
  }
}

function persistCategorizedState() {
  categorizedCategoryFilterExplicit = true;
  window.imageAPI
    .setCategorizedState(state.categorizedRoot, [...state.categorizedCategoryFilter])
    .catch(() => {});
}

function recomputeCategorizedFolderFiles() {
  const filtered = state.categorizedImages.filter(image => state.categorizedCategoryFilter.has(image.category));
  return applyAggregatedFolderFiles(filtered);
}

async function enterCategorizedMode(root, { loadSequence: sequence = null, force = false } = {}) {
  let scan;
  try {
    scan = await window.imageAPI.scanCategorizedRoot(root, force);
  } catch (error) {
    if (sequence && !isCurrentFolderModeLoad(sequence, 'categorized')) return null;
    showToast(errorText(error));
    return null;
  }
  if (sequence && !isCurrentFolderModeLoad(sequence, 'categorized')) return null;

  state.categorizedRoot = scan.root;
  state.categorizedImages = scan.images;
  state.categorizedCategories = scan.categories;

  const availableNames = new Set(scan.categories.map(category => category.name));
  const persisted = [...state.categorizedCategoryFilter].filter(name => availableNames.has(name));
  state.categorizedCategoryFilter = categorizedCategoryFilterExplicit
    ? new Set(persisted)
    : new Set(availableNames);

  setActiveFolderMode('categorized');
  renderFolderButton();
  renderCategorizedRootRow();
  renderCategoriesPanel();
  persistCategorizedState();

  const filtered = recomputeCategorizedFolderFiles();
  return filtered[0] || null;
}

async function toggleCategorizedCategory(name) {
  if (state.categorizedCategoryFilter.has(name)) {
    state.categorizedCategoryFilter.delete(name);
  } else {
    state.categorizedCategoryFilter.add(name);
  }
  persistCategorizedState();
  const filtered = recomputeCategorizedFolderFiles();
  if (!filtered.includes(state.filePath)) {
    if (filtered.length) {
      loadFile(filtered[0]);
    } else {
      showToast('No images match the selected categories');
    }
  } else {
    resyncRandomOrderAfterFilterChange();
  }
}

function setAllCategorizedCategories(checked) {
  state.categorizedCategoryFilter = checked
    ? new Set(state.categorizedCategories.map(category => category.name))
    : new Set();
  renderCategoriesPanel();
  persistCategorizedState();
  const filtered = recomputeCategorizedFolderFiles();
  if (!filtered.includes(state.filePath)) {
    if (filtered.length) {
      loadFile(filtered[0]);
    } else {
      showToast('No images match the selected categories');
    }
  } else {
    resyncRandomOrderAfterFilterChange();
  }
}

// ==============================
// Right-click "Move to category" + instant filter (categorized mode)
// ==============================
function categoryForPath(path) {
  const entry = state.categorizedImages.find(image => image.path === path);
  return entry ? entry.category : null;
}

// Reflect a category change locally so counts and the filter panel update
// without re-hashing the whole root; the sidecar on disk is the source of
// truth on the next rescan.
function applyLocalCategoryChange(path, category) {
  const entry = state.categorizedImages.find(image => image.path === path);
  const previous = entry ? entry.category : null;
  if (previous === category) return;
  if (entry) entry.category = category;

  if (previous) {
    const prevCategory = state.categorizedCategories.find(item => item.name === previous);
    if (prevCategory) prevCategory.count = Math.max(0, prevCategory.count - 1);
  }
  let nextCategory = state.categorizedCategories.find(item => item.name === category);
  if (!nextCategory) {
    nextCategory = { name: category, count: 0 };
    state.categorizedCategories.push(nextCategory);
  }
  nextCategory.count += 1;

  renderCategoriesPanel();
}

// Write the new category to the sidecar, update local counts, and — when the
// image lands in a category that's currently filtered out — instantly drop it
// from the view by advancing to its neighbour in the filtered list.
async function categorizeImage(path, category) {
  if (!state.categorizedRoot) return;
  try {
    await window.imageAPI.setImageCategory(state.categorizedRoot, path, category);
  } catch (error) {
    showToast(errorText(error));
    return;
  }

  applyLocalCategoryChange(path, category);

  const wasIndex = state.folderFiles.indexOf(path);
  const filtered = recomputeCategorizedFolderFiles();

  // Still in the active filter — nothing leaves the view.
  if (state.categorizedCategoryFilter.has(category)) {
    showToast(`Moved to ${category}`);
    return;
  }

  // Instant filter: the image left the active view.
  if (!filtered.length) {
    showToast(`Moved to ${category}`);
    return;
  }
  if (path === state.filePath) {
    const nextIndex = wasIndex < 0 ? 0 : Math.min(wasIndex, filtered.length - 1);
    loadFile(filtered[nextIndex]);
  } else {
    // The moved image left the active filter but isn't the one on screen, so no
    // navigation happens — prune it from the deck so the slideshow can't surface it.
    resyncRandomOrderAfterFilterChange();
  }
  showToast(`Moved to ${category} — hidden`);
}

// Rebuild the "Move to category" portion of the right-click menu for `path`.
// Only shown when browsing a categorized root; lists every known category and
// marks the image's current one.
function buildCategorizeMenu(path) {
  ctxCategorizeSection.innerHTML = '';
  if (state.mode !== 'categorized' || !state.categorizedRoot) return;

  const separator = document.createElement('div');
  separator.className = 'context-menu-separator';
  ctxCategorizeSection.append(separator);

  const title = document.createElement('div');
  title.className = 'context-menu-title';
  title.textContent = 'Move to category';
  ctxCategorizeSection.append(title);

  if (!state.categorizedCategories.length) {
    const empty = document.createElement('div');
    empty.className = 'context-menu-empty';
    empty.textContent = 'No categories available';
    ctxCategorizeSection.append(empty);
    return;
  }

  const current = categoryForPath(path);
  for (const category of state.categorizedCategories) {
    const isCurrent = category.name === current;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.toggle('current', isCurrent);
    const name = document.createElement('span');
    name.textContent = category.name;
    const mark = document.createElement('span');
    mark.textContent = isCurrent ? '✓' : '';
    btn.append(name, mark);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      contextMenu.classList.remove('open');
      if (!isCurrent) categorizeImage(path, category.name);
    });
    ctxCategorizeSection.append(btn);
  }
}

async function rescanCategorizedRoot() {
  if (!state.categorizedRoot) return;
  const firstPath = await enterCategorizedMode(state.categorizedRoot, { force: true });
  if (!state.folderFiles.includes(state.filePath)) {
    if (firstPath) {
      loadFile(firstPath);
    } else {
      showToast('No images match the selected categories');
    }
  } else {
    resyncRandomOrderAfterFilterChange();
  }
}

async function chooseAndEnterCategorizedRoot() {
  const folderPath = await window.imageAPI.chooseCategorizedFolder();
  if (!folderPath) return;
  categorizedCategoryFilterExplicit = false;
  state.categorizedCategoryFilter = new Set();
  const firstPath = await enterCategorizedMode(folderPath);
  if (firstPath) loadFile(firstPath);
}

async function activateCategorizedTab({ loadSequence: sequence = null } = {}) {
  if (!state.categorizedRoot) return;
  const firstPath = await enterCategorizedMode(state.categorizedRoot, { loadSequence: sequence });
  if (sequence && !isCurrentFolderModeLoad(sequence, 'categorized')) return;
  if (firstPath) await loadFile(firstPath);
}

async function selectFolderTab(mode) {
  viewedFolderTab = mode;
  renderFolderPanelSections();
  const sequence = beginFolderModeLoad(
    mode,
    mode === 'multi' ? 'Loading folders…' : 'Loading categories…'
  );
  await nextAnimationFrame();
  if (!isCurrentFolderModeLoad(sequence, mode)) return;
  try {
    if (mode === 'multi') {
      await activateMultiTab({ loadSequence: sequence });
    } else if (mode === 'categorized') {
      await activateCategorizedTab({ loadSequence: sequence });
    }
  } finally {
    endFolderModeLoad(sequence);
  }
}

folderModeTabs.forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    selectFolderTab(tab.dataset.mode);
  });
});

btnFolder.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!folderPanel.classList.contains('open')) {
    viewedFolderTab = state.mode;
    renderFolderPanelSections();
  }
  toggleFolderPanelOpen();
});

folderMultiAdd.addEventListener('click', (e) => {
  e.stopPropagation();
  addMultiFolder();
});

categorizedRootChoose.addEventListener('click', (e) => {
  e.stopPropagation();
  chooseAndEnterCategorizedRoot();
});

categoriesSelectAll.addEventListener('click', (e) => {
  e.stopPropagation();
  setAllCategorizedCategories(true);
});

categoriesSelectNone.addEventListener('click', (e) => {
  e.stopPropagation();
  setAllCategorizedCategories(false);
});

categoriesRescan.addEventListener('click', (e) => {
  e.stopPropagation();
  rescanCategorizedRoot();
});

folderPanel.addEventListener('click', (e) => e.stopPropagation());

// ==============================
// Open File Dialog
// ==============================
async function openFileDialog() {
  setFolderPanelOpen(false);
  const openAction = startDebugAction('open', 'Open');
  debugLog('open-dialog:start', {}, { action: openAction });
  const filePath = await window.imageAPI.openFile();
  debugLog('open-dialog:result', { filePath });
  if (filePath) await openFileInMultiFolderMode(filePath, { addToHistory: true });
}

// ==============================
// Zoom (Mouse Wheel)
// ==============================
imageContainer.addEventListener('wheel', (e) => {
  if (!state.filePath) return;
  e.preventDefault();

  const rect = imageContainer.getBoundingClientRect();
  const cursorX = e.clientX - rect.left - rect.width / 2;
  const cursorY = e.clientY - rect.top - rect.height / 2;

  const oldZoom = state.zoom;
  const direction = e.deltaY < 0 ? 1 : -1;
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldZoom * (direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR)));

  // Adjust pan to zoom toward cursor position
  const zoomRatio = state.zoom / oldZoom;
  state.panX = cursorX - (cursorX - state.panX) * zoomRatio;
  state.panY = cursorY - (cursorY - state.panY) * zoomRatio;

  scheduleTransform();
}, { passive: false });

// ==============================
// CTRL+Drag 2D Rotation
// ==============================
function imageCenterPoint() {
  const rect = imageContainer.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 + state.panX,
    y: rect.top + rect.height / 2 + state.panY,
  };
}

function pointerAngle(e) {
  const center = imageCenterPoint();
  return Math.atan2(e.clientY - center.y, e.clientX - center.x) * 180 / Math.PI;
}

function onRotationMouseDown(e) {
  if (!e.ctrlKey || e.button !== 0 || !state.filePath) return;

  e.preventDefault();

  state.rotationMouseDown = true;
  state.rotationStartAngle = pointerAngle(e);
  state.rotationBase = state.rotation;

  clearTimeout(state.rotationTimer);
  state.rotationTimer = setTimeout(() => {
    if (state.rotationMouseDown) {
      state.isRotating = true;
    }
  }, ROTATION_DELAY);
}

function onRotationMouseMove(e) {
  if (!state.isRotating) return;

  state.rotation = state.rotationBase + pointerAngle(e) - state.rotationStartAngle;

  scheduleTransform();
}

function onRotationMouseUp() {
  clearTimeout(state.rotationTimer);
  state.rotationMouseDown = false;
  state.isRotating = false;
  document.body.classList.remove('image-transforming');
}

imageContainer.addEventListener('mousedown', onRotationMouseDown);
document.addEventListener('mousemove', onRotationMouseMove);
document.addEventListener('mouseup', onRotationMouseUp);

// ==============================
// Pan (Drag without CTRL when zoomed)
// ==============================
imageContainer.addEventListener('mousedown', (e) => {
  if (e.ctrlKey || e.button !== 0 || !state.filePath) return;

  e.preventDefault();
  state.isPanning = true;
  state.panStartX = e.clientX;
  state.panStartY = e.clientY;
  state.panBaseX = state.panX;
  state.panBaseY = state.panY;
  imageContainer.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!state.isPanning) return;

  state.panX = state.panBaseX + (e.clientX - state.panStartX);
  state.panY = state.panBaseY + (e.clientY - state.panStartY);
  scheduleTransform();
});

document.addEventListener('mouseup', () => {
  if (state.isPanning) {
    state.isPanning = false;
    imageContainer.style.cursor = '';
    document.body.classList.remove('image-transforming');
  }
});

// ==============================
// Copy to Clipboard
// ==============================
async function copyToClipboard() {
  if (!state.filePath) return;
  const copyAction = startDebugAction('copy', 'Copy');
  debugLog('copy:start', { filePath: state.filePath, fileBacked: state.fileBacked }, { action: copyAction });
  if (!state.fileBacked) {
    debugLog('copy:blocked', { reason: 'not file backed' });
    showToast('Cannot copy this image format');
    return;
  }
  const ok = await window.imageAPI.copyToClipboard(state.filePath);
  debugLog('copy:result', { ok });
  if (ok) {
    showToast('Copied to clipboard');
  } else {
    showToast('Cannot copy this image format');
  }
}

async function pasteFromClipboard() {
  if (!currentDebugAction('paste') || performance.now() - lastPasteInputAt > 500) {
    startDebugAction('paste', 'Paste');
  }
  lastPasteAttemptAt = performance.now();
  debugState.counters.pasteAttempts++;
  debugLog('paste:native-start', { attemptAt: lastPasteAttemptAt });
  await logClipboardDebug('before-native-paste');
  try {
    const result = await window.imageAPI.pasteFromClipboard();
    debugLog('paste:native-result', result || null);
    if (!(await openPastedFile(result))) {
      debugState.counters.pasteFailures++;
      await logClipboardDebug('native-no-compatible-image');
      showToast('No compatible image in clipboard');
    }
  } catch (error) {
    debugState.counters.pasteFailures++;
    debugLog('paste:native-error', { error: error?.message || String(error) });
    await logClipboardDebug('native-error');
    showToast('Failed to paste image');
  }
  if (debugState.visible) renderDebugConsole();
}

async function openPastedFile(result) {
  if (result?.type !== 'file' || !result.filePath) {
    debugLog('paste:open-skipped', { result });
    return false;
  }
  debugLog('paste:open-file', result);
  if (result.temporary) {
    await loadFile(result.filePath, { addToHistory: true, temporary: true });
  } else {
    await openFileInMultiFolderMode(result.filePath, { addToHistory: true });
  }
  lastSuccessfulPasteAt = performance.now();
  debugState.counters.pasteSuccesses++;
  debugLog('paste:success', { filePath: result.filePath, temporary: !!result.temporary });
  showToast('Pasted image');
  return true;
}

function extensionFromPastedImage(file) {
  const nameExt = file.name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (nameExt && IMAGE_EXTS.test(`.${nameExt}`)) return nameExt;

  switch (file.type.toLowerCase()) {
    case 'image/png':
    case 'image/x-png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
    case 'image/pjpeg':
      return 'jpg';
    case 'image/bmp':
    case 'image/x-ms-bmp':
      return 'bmp';
    case 'image/vnd.microsoft.icon':
    case 'image/x-icon':
      return 'ico';
    case 'image/svg+xml':
      return 'svg';
    case 'image/tif':
    case 'image/tiff':
      return 'tiff';
    default:
      return file.type.toLowerCase().replace(/^image\//, '').replace(/[^a-z0-9]/g, '');
  }
}

async function savePastedBrowserFile(file) {
  if (!file) return false;
  const isImageType = file.type?.toLowerCase().startsWith('image/');
  const isImageName = IMAGE_EXTS.test(file.name || '');
  debugLog('paste:browser-file', {
    name: file.name,
    type: file.type,
    size: file.size,
    isImageType,
    isImageName,
  });
  if (!isImageType && !isImageName) {
    debugLog('paste:browser-file-skip', { reason: 'not image' });
    return false;
  }
  const extension = extensionFromPastedImage(file);
  if (!extension) {
    debugLog('paste:browser-file-skip', { reason: 'no extension' });
    return false;
  }

  const buffer = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buffer));
  debugLog('paste:browser-save-bytes', { extension, byteLength: bytes.length });
  const result = await window.imageAPI.savePastedImageBytes(bytes, extension);
  debugLog('paste:browser-save-result', result);
  return openPastedFile(result);
}

function filePathFromFileUrl(src) {
  try {
    const url = new URL(src);
    if (url.protocol !== 'file:') return null;
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    return path.replace(/\//g, '\\');
  } catch {
    return null;
  }
}

async function savePastedDataUrl(src) {
  const match = src.match(/^data:(image\/[^;,]+)([^,]*),(.*)$/i);
  if (!match) {
    debugLog('paste:data-url-skip', { reason: 'no data url match', src: shortPath(src) });
    return false;
  }

  const type = match[1].toLowerCase();
  const extension = extensionFromPastedImage({ type, name: '' });
  if (!extension) return false;

  const metadata = match[2];
  const data = match[3];
  const bytes = /;base64/i.test(metadata)
    ? Array.from(atob(data.replace(/\s/g, '')), char => char.charCodeAt(0))
    : Array.from(new TextEncoder().encode(decodeURIComponent(data)));
  const result = await window.imageAPI.savePastedImageBytes(bytes, extension);
  debugLog('paste:data-url-save-result', { type, extension, byteLength: bytes.length, result });
  return openPastedFile(result);
}

function pastedHtmlImageSrc(html) {
  if (!html) return false;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector('img[src]')?.getAttribute('src') || null;
}

async function tryPasteHtmlImage(html) {
  const src = pastedHtmlImageSrc(html);
  if (!src) return false;

  const filePath = filePathFromFileUrl(src);
  if (filePath && IMAGE_EXTS.test(filePath)) {
    await openFileInMultiFolderMode(filePath, { addToHistory: true });
    showToast('Pasted image');
    return true;
  }

  return savePastedDataUrl(src);
}

async function handleBrowserPaste(e) {
  const clipboardData = e.clipboardData;
  if (!clipboardData) return;
  if (!currentDebugAction('paste') || performance.now() - lastPasteInputAt > 500) {
    startDebugAction('paste', 'Paste');
  }
  debugLog('paste:browser-event', {
    fileCount: clipboardData.files?.length || 0,
    itemTypes: Array.from(clipboardData.items || []).map(item => `${item.kind}:${item.type}`),
    types: Array.from(clipboardData.types || []),
  });
  await logClipboardDebug('browser-paste-event');

  const files = Array.from(clipboardData.files || []);
  const imageFile = files.find(file => file.type?.toLowerCase().startsWith('image/') || IMAGE_EXTS.test(file.name || ''));
  if (imageFile) {
    e.preventDefault();
    debugLog('paste:browser-file-candidate', { name: imageFile.name, type: imageFile.type, size: imageFile.size });
    try {
      if (await savePastedBrowserFile(imageFile)) {
        return;
      }
      debugLog('paste:browser-file-fallback-native', {});
      pasteFromClipboard();
    } catch (error) {
      debugLog('paste:browser-file-error', { error: error?.message || String(error) });
      pasteFromClipboard();
      return;
    }
  }

  const itemImage = Array.from(clipboardData.items || [])
    .find(item => item.kind === 'file' && item.type?.toLowerCase().startsWith('image/'));
  if (itemImage) {
    e.preventDefault();
    debugLog('paste:browser-item-candidate', { type: itemImage.type });
    try {
      const file = itemImage.getAsFile();
      if (file && await savePastedBrowserFile(file)) {
        return;
      }
      debugLog('paste:browser-item-fallback-native', { gotFile: !!file });
      pasteFromClipboard();
    } catch (error) {
      debugLog('paste:browser-item-error', { error: error?.message || String(error) });
      pasteFromClipboard();
      return;
    }
  }

  const html = clipboardData.getData('text/html');
  if (pastedHtmlImageSrc(html)) {
    e.preventDefault();
    debugLog('paste:browser-html-candidate', { length: html.length });
    try {
      if (await tryPasteHtmlImage(html)) {
        return;
      }
      debugLog('paste:browser-html-fallback-native', {});
      pasteFromClipboard();
    } catch (error) {
      debugLog('paste:browser-html-error', { error: error?.message || String(error) });
      pasteFromClipboard();
      return;
    }
  }
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  toast.addEventListener('animationend', () => toast.remove());
}

// Normalize a thrown value (Error, Tauri string error, etc.) into a short
// human-readable message for toasts.
function errorText(error) {
  if (!error) return 'Something went wrong';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

// ==============================
// True Size Toggle
// ==============================
function toggleTrueSizeMode() {
  state.trueSizeMode = !state.trueSizeMode;
  image.classList.toggle('true-size', state.trueSizeMode);
  btnTrueSize.classList.toggle('active', state.trueSizeMode);
  resetTransform(false);
}

// ==============================
// Fill Bias Adjuster
// ==============================
let fillBiasHoldTimer = null;
let fillBiasHoldInterval = null;

function updateFillBiasDisplay() {
  const x = state.fillBiasX;
  const y = state.fillBiasY;
  const fmt = v => (v > 0 ? '+' : '') + v;
  if (x === 0 && y === 0) {
    fillBiasValX.textContent = '·';
    fillBiasValY.textContent = '';
  } else {
    fillBiasValX.textContent = fmt(x);
    fillBiasValY.textContent = fmt(y);
  }
}

function adjustFillBias(dx, dy) {
  state.fillBiasX += dx;
  state.fillBiasY += dy;
  localStorage.setItem('imageViewer.fillBiasX', String(state.fillBiasX));
  localStorage.setItem('imageViewer.fillBiasY', String(state.fillBiasY));
  updateFillBiasDisplay();
  if (state.appFillMode) applyAppFillTransform(false);
}

function resetFillBias() {
  state.fillBiasX = 0;
  state.fillBiasY = 0;
  localStorage.removeItem('imageViewer.fillBiasX');
  localStorage.removeItem('imageViewer.fillBiasY');
  updateFillBiasDisplay();
  if (state.appFillMode) applyAppFillTransform(false);
}

function setFillBiasPanelOpen(open) {
  fillBiasPanel.classList.toggle('open', open);
  btnFillBias.classList.toggle('active', open);
}

function toggleFillBiasPanel() {
  setFillBiasPanelOpen(!fillBiasPanel.classList.contains('open'));
}

function stopFillBiasHold() {
  clearTimeout(fillBiasHoldTimer);
  clearInterval(fillBiasHoldInterval);
  fillBiasHoldTimer = null;
  fillBiasHoldInterval = null;
}

function startFillBiasHold(dx, dy) {
  stopFillBiasHold();
  adjustFillBias(dx, dy);
  fillBiasHoldTimer = setTimeout(() => {
    fillBiasHoldInterval = setInterval(() => adjustFillBias(dx, dy), Math.round(1000 / 12));
  }, 300);
}

function attachFillBiasDir(el, dx, dy) {
  // Stop pointerdown from reaching the document handler so it can't call preventDefault,
  // which would suppress the mousedown compatibility event we rely on for hold detection.
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startFillBiasHold(dx, dy);
  });
  el.addEventListener('mouseup', stopFillBiasHold);
  el.addEventListener('mouseleave', stopFillBiasHold);
}

attachFillBiasDir(fillBiasUp, 0, -1);
attachFillBiasDir(fillBiasDown, 0, 1);
attachFillBiasDir(fillBiasLeft, -1, 0);
attachFillBiasDir(fillBiasRight, 1, 0);

fillBiasResetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  resetFillBias();
});

btnFillBias.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFillBiasPanel();
});

fillBiasPanel.addEventListener('click', (e) => e.stopPropagation());

document.addEventListener('mouseup', stopFillBiasHold);

updateFillBiasDisplay();

// ==============================
// Slideshow
// ==============================
function startSlideshow() {
  if (!state.filePath || !state.folderFiles.length) return;
  state.slideshow = true;
  state.slideshowPausedForPassiveState = false;
  btnSlideshow.classList.add('active');
  refreshSlideshowPassiveState();
}

function stopSlideshow() {
  state.slideshow = false;
  state.slideshowPausedForPassiveState = false;
  btnSlideshow.classList.remove('active');
  clearTimeout(state.slideshowTimer);
  state.slideshowTimer = null;
}

function toggleSlideshow() {
  if (state.slideshow) {
    stopSlideshow();
  } else {
    startSlideshow();
  }
}

function scheduleSlideshowNext() {
  clearTimeout(state.slideshowTimer);
  if (!state.slideshow || state.slideshowPausedForPassiveState) return;
  state.slideshowTimer = setTimeout(async () => {
    if (!state.slideshow || state.slideshowPausedForPassiveState) return;
    if (!await navigateNext()) {
      if (lastNavigationBlockedByThrottle) {
        scheduleSlideshowNext();
        return;
      }
      stopSlideshow();
      return;
    }
    scheduleSlideshowNext();
  }, state.slideshowDuration);
}

function setSlideshowDuration(ms) {
  state.slideshowDuration = ms;
  localStorage.setItem('imageViewer.slideshowDuration', String(ms));
  // Update active state on dropdown buttons
  slideshowDropdown.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.duration) === ms);
  });
  // Restart timer if slideshow is running
  if (state.slideshow) {
    scheduleSlideshowNext();
  }
}

function pauseSlideshowForPassiveState() {
  if (!state.slideshow) return;
  state.slideshowPausedForPassiveState = true;
  clearTimeout(state.slideshowTimer);
  state.slideshowTimer = null;
}

function resumeSlideshowFromPassiveState() {
  if (!state.slideshow || !state.slideshowPausedForPassiveState) return;
  state.slideshowPausedForPassiveState = false;
  scheduleSlideshowNext();
}

// Apply a known passive/active determination to the running slideshow.
// Resuming also reschedules a dropped timer (e.g. a setTimeout frozen by the
// OS during sleep that never fired), so the slideshow always re-enables once
// the window is in the foreground again.
function applySlideshowPassiveState(isPassive) {
  if (!state.slideshow) return;
  if (isPassive) {
    pauseSlideshowForPassiveState();
  } else {
    resumeSlideshowFromPassiveState();
    if (!state.slideshowTimer) scheduleSlideshowNext();
  }
}

// Resume the slideshow when the window is definitively in the foreground
// (a `focus`/visible/`resume` event). We trust the event rather than the async
// isMinimized() probe, which can still report `true` mid-restore and otherwise
// leave the slideshow stuck paused with no further event to revive it.
function activateSlideshowIfForeground() {
  if (document.hidden) return;
  applySlideshowPassiveState(false);
}

// For ambiguous triggers (blur, startup) where foreground state is unknown,
// consult the OS. Only ever transitions toward "paused"; resuming is handled
// by the foreground events above to avoid the restore race.
async function refreshSlideshowPassiveState() {
  if (!state.slideshow) return;

  const sequence = ++passiveStateCheckSequence;
  const isMinimized = await window.imageAPI.isMinimized().catch(() => false);
  if (sequence !== passiveStateCheckSequence || !state.slideshow) return;

  applySlideshowPassiveState(document.hidden || isMinimized);
}

// Slideshow dropdown: right-click opens dropdown, left-click toggles slideshow
btnSlideshow.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSlideshow();
});

btnSlideshow.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  slideshowDropdown.classList.toggle('open');
});

slideshowDropdown.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-duration]');
  if (!btn) return;
  e.stopPropagation();
  setSlideshowDuration(Number(btn.dataset.duration));
  slideshowDropdown.classList.remove('open');
});

// Close dropdowns/menus/panels when clicking elsewhere
document.addEventListener('click', () => {
  slideshowDropdown.classList.remove('open');
  contextMenu.classList.remove('open');
  setSettingsPanelOpen(false);
  setFillBiasPanelOpen(false);
  setFolderPanelOpen(false);
});

// ==============================
// Image Right-Click Context Menu
// ==============================
let rightClickStartX = 0;
let rightClickStartY = 0;

imageContainer.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    rightClickStartX = e.clientX;
    rightClickStartY = e.clientY;
  }
});

imageContainer.addEventListener('contextmenu', (e) => {
  if (!state.filePath) return;
  e.preventDefault();
  const dx = e.clientX - rightClickStartX;
  const dy = e.clientY - rightClickStartY;
  if (dx * dx + dy * dy > 25) return; // >5px drag = suppress menu
  buildCategorizeMenu(state.filePath);
  // Open first, then clamp using the real menu size — the categorize section
  // makes the menu variably tall/wide depending on the category list.
  contextMenu.classList.add('open');
  const maxX = window.innerWidth - contextMenu.offsetWidth - 4;
  const maxY = window.innerHeight - contextMenu.offsetHeight - 4;
  contextMenu.style.left = Math.max(4, Math.min(e.clientX, maxX)) + 'px';
  contextMenu.style.top = Math.max(4, Math.min(e.clientY, maxY)) + 'px';
});

ctxCopyImage.addEventListener('click', (e) => {
  e.stopPropagation();
  contextMenu.classList.remove('open');
  copyToClipboard();
});

ctxOpenNewWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  contextMenu.classList.remove('open');
  openInNewWindow();
});

// Open the current image in a separate viewer window. Used to "pin" a slideshow
// frame for closer viewing while the original window keeps cycling — the new
// window has its own state, so the running slideshow is unaffected.
async function openInNewWindow() {
  if (!state.filePath) return;
  try {
    await window.imageAPI.openInNewWindow(state.filePath);
  } catch (error) {
    showToast(errorText(error));
  }
}

// ==============================
// Editor
// ==============================
let editorPath = null;

async function openInEditor() {
  if (!state.filePath) return;
  if (!editorPath) {
    editorPath = await window.imageAPI.setEditorPath();
    if (!editorPath) return;
    updateEditorButton();
  }
  await copyToClipboard();
  const ok = await window.imageAPI.openInEditor(state.filePath);
  if (!ok) showToast('Failed to open editor');
}

async function chooseEditor() {
  editorPath = await window.imageAPI.setEditorPath();
  updateEditorButton();
  if (editorPath) {
    const name = editorPath.replace(/\\/g, '/').split('/').pop();
    showToast(`Editor set: ${name}`);
  }
}

function updateEditorButton() {
  btnEditor.classList.toggle('editor-set', !!editorPath);
  btnEditor.title = editorPath
    ? `Open in editor: ${editorPath.replace(/\\/g, '/').split('/').pop()} (right-click to change)`
    : 'Open in editor (click to choose editor)';
}

btnEditor.addEventListener('click', openInEditor);
btnEditor.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  chooseEditor();
});

// Load persisted editor path on startup
window.imageAPI.getEditorPath().then(p => {
  editorPath = p;
  updateEditorButton();
});

// ==============================
// Button Click Handlers
// ==============================
document.addEventListener('pointerdown', (e) => {
  const button = e.target.closest('button');
  if (button) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) button.blur();
});

// ==============================
// Settings Panel
// ==============================
function setSettingsPanelOpen(open) {
  settingsPanel.classList.toggle('open', open);
  btnSettings.classList.toggle('active', open);
}

function toggleSettingsPanel() {
  setSettingsPanelOpen(!settingsPanel.classList.contains('open'));
}

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSettingsPanel();
});

async function saveWindowPositionPreset(preset) {
  try {
    await window.imageAPI.saveWindowPositionPreset(preset);
    showToast(preset === 'first' ? 'Saved 1st window default' : 'Saved 2nd+ window default');
  } catch (error) {
    debugLog('window:preset-save-error', {
      preset,
      error: error?.message || String(error),
    });
    showToast('Failed to save window default');
  }
}

async function resetWindowPositionPreset(preset) {
  try {
    await window.imageAPI.resetWindowPositionPreset(preset);
    showToast(preset === 'first' ? 'Reset 1st window default' : 'Reset 2nd+ window default');
  } catch (error) {
    debugLog('window:preset-reset-error', {
      preset,
      error: error?.message || String(error),
    });
    showToast('Failed to reset window default');
  }
}

settingSaveFirstWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  saveWindowPositionPreset('first');
});

settingResetFirstWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  resetWindowPositionPreset('first');
});

settingSaveSecondaryWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  saveWindowPositionPreset('secondary');
});

settingResetSecondaryWindow.addEventListener('click', (e) => {
  e.stopPropagation();
  resetWindowPositionPreset('secondary');
});

settingSquareAppCorners.addEventListener('change', async () => {
  appSettings.squareAppCorners = settingSquareAppCorners.checked;
  await saveAppSettings();
  await window.imageAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});
});

settingExpandBorderlessEdges.addEventListener('change', async () => {
  appSettings.expandBorderlessEdges = settingExpandBorderlessEdges.checked;
  await saveAppSettings();
  await window.imageAPI.adjustWindowBorderlessEdges(appSettings.expandBorderlessEdges).catch(() => {});
});

settingShowEditorButton.addEventListener('change', async () => {
  appSettings.showEditorButton = settingShowEditorButton.checked;
  await saveAppSettings();
});

settingAutoOpenSlideshow.addEventListener('change', async () => {
  appSettings.autoOpenSlideshow = settingAutoOpenSlideshow.checked;
  if (!appSettings.autoOpenSlideshow) {
    appSettings.autoSlideshowFillZoom = false;
  }
  await saveAppSettings();
});

settingAutoSlideshowFillZoom.addEventListener('change', async () => {
  appSettings.autoSlideshowFillZoom = settingAutoSlideshowFillZoom.checked;
  await saveAppSettings();
});

settingEdgeArrowsVisible.addEventListener('change', async () => {
  appSettings.edgeArrowsVisible = settingEdgeArrowsVisible.checked;
  applyEdgeNavSettings();
  await saveAppSettings();
});

settingEdgeArrowsInvisible.addEventListener('change', async () => {
  appSettings.edgeArrowsInvisible = settingEdgeArrowsInvisible.checked;
  applyEdgeNavSettings();
  await saveAppSettings();
});

settingsPanel.addEventListener('click', (e) => e.stopPropagation());

// ==============================
// Edge click-to-navigate zones
// ==============================
// A click (not a drag) on an active edge zone steps the folder. mousedown is
// swallowed so it never starts a pan/rotate on the image underneath; a small
// movement threshold lets an accidental drag fall through without navigating.
function setupEdgeNav(el, navigate) {
  let downX = 0;
  let downY = 0;
  let armed = false;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !state.filePath) return;
    e.preventDefault();
    e.stopPropagation();
    downX = e.clientX;
    downY = e.clientY;
    armed = true;
  });

  el.addEventListener('mouseup', (e) => {
    if (!armed || e.button !== 0) return;
    armed = false;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (dx * dx + dy * dy > 36) return; // >6px movement = drag, not a click
    e.stopPropagation();
    navigate();
  });

  el.addEventListener('mouseleave', () => { armed = false; });
}

setupEdgeNav(edgeNavLeft, () => navigatePrev());
setupEdgeNav(edgeNavRight, () => navigateNext());

// ==============================
// Position display: click to jump to image number
// ==============================
let positionEditing = false;

function renderPositionDisplay() {
  if (positionEditing) return;
  const total = state.folderFiles.length;
  positionDisplay.textContent = total > 1
    ? `${state.folderIndex + 1} / ${total}`
    : '';
}

function endPositionEdit() {
  if (!positionEditing) return;
  positionEditing = false;
  positionDisplay.classList.remove('editing');
  renderPositionDisplay();
}

function commitPositionEdit(value) {
  const total = state.folderFiles.length;
  const requested = parseInt(value, 10);
  positionEditing = false;
  positionDisplay.classList.remove('editing');
  if (Number.isFinite(requested) && total > 1) {
    const target = state.folderFiles[Math.max(1, Math.min(total, requested)) - 1];
    if (target && target !== state.filePath) {
      loadFile(target);
      return;
    }
  }
  renderPositionDisplay();
}

function beginPositionEdit() {
  const total = state.folderFiles.length;
  if (positionEditing || total <= 1) return;
  positionEditing = true;
  positionDisplay.classList.add('editing');

  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.id = 'position-input';
  input.value = String(state.folderIndex + 1);
  input.setAttribute('aria-label', 'Go to image number');

  input.addEventListener('keydown', (e) => {
    // Keep typing local: global shortcuts (arrows, §/z fill-mode toggles) must
    // not fire while editing the number.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitPositionEdit(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endPositionEdit();
    }
  });
  input.addEventListener('blur', endPositionEdit);
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());

  positionDisplay.replaceChildren(input, document.createTextNode(` / ${total}`));
  input.focus();
  input.select();
}

positionDisplay.addEventListener('click', (e) => {
  if (positionEditing) return;
  e.stopPropagation();
  beginPositionEdit();
});

btnOpenEmpty.addEventListener('click', openFileDialog);
btnMinimize.addEventListener('click', async () => {
  pauseSlideshowForPassiveState();
  window.imageAPI.minimize();
});
btnMinimizeAll.addEventListener('click', async () => {
  pauseSlideshowForPassiveState();
  window.imageAPI.minimizeAll();
});
btnClose.addEventListener('click', async () => {
  window.imageAPI.close();
});
btnReset.addEventListener('click', () => resetTransform(true));
btnCopy.addEventListener('click', copyToClipboard);
btnRandomize.addEventListener('click', toggleRandomize);
btnTrueSize.addEventListener('click', toggleTrueSizeMode);
btnFullscreen.addEventListener('click', () => window.imageAPI.toggleFullscreen());

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushLastFilePersist();
    applySlideshowPassiveState(true);
  } else {
    activateSlideshowIfForeground();
  }
});
// Window regained focus / page resumed from an OS freeze (minimize restore,
// wake from sleep, etc.) — re-enable the slideshow.
window.addEventListener('focus', activateSlideshowIfForeground);
document.addEventListener('resume', activateSlideshowIfForeground);
// A bare blur (another window took focus) shouldn't pause; only pause if we've
// actually gone passive (minimized/hidden), which the async probe determines.
window.addEventListener('blur', () => {
  refreshSlideshowPassiveState();
});
window.addEventListener('resize', () => {
  if (state.appFillMode) {
    applyAppFillTransform(false);
  }
  requestAnimationFrame(() => {
    if (state.appFillMode) {
      applyAppFillTransform(false);
    } else {
      applyTransform();
    }
  });
});
document.addEventListener('paste', handleBrowserPaste);

// ==============================
// Keyboard Shortcuts
// ==============================
document.addEventListener('keydown', async (e) => {
  if (isAppFillToggleKey(e)) {
    e.preventDefault();
    toggleAppFillMode();
    return;
  }

  if (isDebugToggleKey(e)) {
    e.preventDefault();
    toggleDebugConsole();
    return;
  }

  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT' && focused.type !== 'range') return;

  switch (true) {
    case e.key === 'ArrowLeft' && !e.ctrlKey: {
      e.preventDefault();
      navigatePrev();
      break;
    }

    case e.key === 'ArrowRight' && !e.ctrlKey: {
      e.preventDefault();
      navigateNext();
      break;
    }

    case e.key === 'c' && e.ctrlKey && !e.shiftKey: {
      e.preventDefault();
      copyToClipboard();
      break;
    }

    case e.key === 'v' && e.ctrlKey && !e.shiftKey: {
      const pasteAction = startDebugAction('paste', 'Paste');
      const startedAt = performance.now();
      lastPasteInputAt = startedAt;
      debugLog('input:ctrl-v', { startedAt }, { action: pasteAction });
      setTimeout(() => {
        if (lastSuccessfulPasteAt < startedAt && lastPasteAttemptAt < startedAt) {
          pasteFromClipboard();
        }
      }, 120);
      break;
    }

    case e.key === 'o' && e.ctrlKey: {
      e.preventDefault();
      openFileDialog();
      break;
    }

    case (e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      resetTransform(true);
      break;
    }

    case (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      centerImage(true);
      break;
    }

    case (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      window.imageAPI.toggleFullscreen();
      break;
    }

    case (e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      toggleTrueSizeMode();
      break;
    }

    case e.key === 'Escape': {
      e.preventDefault();
      if (exitHiddenAndFillModes()) {
        break;
      }

      const isFS = await window.imageAPI.isFullscreen();
      if (isFS) {
        window.imageAPI.toggleFullscreen();
      }
      break;
    }

    case (e.key === 'Q' || e.key === 'q') && e.shiftKey && !e.ctrlKey && !e.metaKey: {
      e.preventDefault();
      toggleUiHidden();
      break;
    }
  }
});

// ==============================
// Drag-and-Drop (file drop onto window)
// ==============================
const IMAGE_EXTS = /\.(jpe?g|png|gif|bmp|webp|svg|ico|avif|tiff?)$/i;

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const now = performance.now();
  if (now - lastDragOverDebugAt > 500) {
    lastDragOverDebugAt = now;
    debugLog('drag:over', {
      types: Array.from(e.dataTransfer?.types || []),
      fileCount: e.dataTransfer?.files?.length || 0,
    });
  }
  document.body.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) {
    document.body.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.remove('drag-over');

  const dragAction = startDebugAction('drag', 'Drop');
  const files = Array.from(e.dataTransfer.files);
  debugLog('drag:drop', {
    files: files.map(file => ({ name: file.name, type: file.type, path: file.path || null })),
  }, { action: dragAction });
  const imageFile = files.find(f => IMAGE_EXTS.test(f.name) && f.path);
  if (imageFile) {
    openFileInMultiFolderMode(imageFile.path, { addToHistory: true }).catch(error => showToast(errorText(error)));
  }
});

window.imageAPI.onTauriDragEnter(() => {
  debugLog('tauri-drag:enter', {});
  document.body.classList.add('drag-over');
});

window.imageAPI.onTauriDragLeave(() => {
  debugLog('tauri-drag:leave', {});
  document.body.classList.remove('drag-over');
});

window.imageAPI.onTauriDragDrop(({ paths = [] } = {}) => {
  const dragAction = startDebugAction('drag', 'Drop');
  debugLog('tauri-drag:drop', { paths }, { action: dragAction });
  document.body.classList.remove('drag-over');
  const imageFile = paths.find(path => IMAGE_EXTS.test(path));
  if (imageFile) {
    openFileInMultiFolderMode(imageFile, { addToHistory: true }).catch(error => showToast(errorText(error)));
  }
});

// ==============================
// CLI / File Association
// ==============================
window.imageAPI.onOpenFile((filePath) => {
  openFileInMultiFolderMode(filePath, { addToHistory: true }).catch(error => showToast(errorText(error)));
});

window.imageAPI.onExternalOpenRequested(() => {
  externalOpenRequestedDuringStartup = true;
  if (windowLabel === 'main' && state.slideshow) {
    stopSlideshow();
  }
});

window.imageAPI.onFullscreenChanged(setFullscreenUi);
window.imageAPI.isFullscreen().then(setFullscreenUi);

document.getElementById('titlebar-drag').addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    window.imageAPI.startWindowDrag();
  }
});

// ==============================
// Startup: load settings
// ==============================
async function loadPersistedCategorizedState() {
  try {
    const persisted = await window.imageAPI.getCategorizedState();
    const filter = persisted?.categoryFilter;
    state.categorizedRoot = persisted?.root || null;
    categorizedCategoryFilterExplicit = Array.isArray(filter);
    state.categorizedCategoryFilter = new Set(categorizedCategoryFilterExplicit ? filter : []);
  } catch {
    state.categorizedRoot = null;
    state.categorizedCategoryFilter = new Set();
    categorizedCategoryFilterExplicit = false;
  }
}

async function loadPersistedMultiFolders() {
  try {
    state.multiFolders = await window.imageAPI.getMultiFolders();
  } catch {
    state.multiFolders = [];
  }
  try {
    const raw = localStorage.getItem('imageViewer.multiFolderFilter');
    const parsed = JSON.parse(raw);
    state.multiFolderFilter = new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    state.multiFolderFilter = new Set();
  }
  normalizeMultiFolderFilter({ defaultAll: true });
  renderMultiFolderList();
}

function availableStartupFolderModes({ preferCategorized = false } = {}) {
  const preferred = preferCategorized ? 'categorized' : getPersistedFolderMode();
  const modes = preferred === 'categorized'
    ? ['categorized', 'multi']
    : ['multi', 'categorized'];

  return modes.filter(mode => {
    if (mode === 'categorized') return !!state.categorizedRoot;
    return state.multiFolders.length > 0;
  });
}

(async () => {
  let startupFile = null;
  try {
    // Yield a frame so the loading overlay paints first, but never block on it:
    // a window created occluded at Windows login suspends requestAnimationFrame
    // indefinitely, which would hang the entire startup and the overlay would
    // never clear. Race rAF against a short timer so startup always proceeds.
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(finish);
      setTimeout(finish, 200);
    });
    windowLabel = await window.imageAPI.getWindowLabel().catch(() => 'main');
    await Promise.all([loadAppSettings(), loadPersistedMultiFolders(), loadPersistedCategorizedState()]);
    setSlideshowDuration(state.slideshowDuration); // sync dropdown active state
    await window.imageAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});
    const isFirstWindow = windowLabel === 'main';
    const autoSlideshowStartup = isFirstWindow && appSettings.autoOpenSlideshow;
    const persistedFolderMode = getPersistedFolderMode();
    if ((autoSlideshowStartup && state.categorizedRoot) || (persistedFolderMode === 'categorized' && state.categorizedRoot)) {
      setActiveFolderMode('categorized');
    } else {
      setActiveFolderMode('multi');
    }
    viewedFolderTab = state.mode;
    renderFolderPanelSections();
    renderCategorizedRootRow();

    const initialFile = await window.imageAPI.getInitialFile().catch(() => null);
    const shouldAutoOpenSlideshow = isFirstWindow && appSettings.autoOpenSlideshow && !externalOpenRequestedDuringStartup;

    startupFile = initialFile;
    if (!startupFile && shouldAutoOpenSlideshow && !externalOpenRequestedDuringStartup) {
      // Priority: categorized mode > other configured folder mode > last opened file.
      const startupFolderModes = availableStartupFolderModes({ preferCategorized: true });
      for (const mode of startupFolderModes) {
        if (mode === 'categorized') {
          startupFile = await enterCategorizedMode(state.categorizedRoot);
          if (!startupFile && !externalOpenRequestedDuringStartup) showToast('Categorized folder no longer available');
        } else {
          startupFile = await enterMultiMode();
        }
        if (startupFile || externalOpenRequestedDuringStartup) {
          break;
        }
      }
      if (!startupFile && !startupFolderModes.length && !externalOpenRequestedDuringStartup) {
        startupFile = appSettings.lastFile;
      }
    }

    if (startupFile && !initialFile && shouldAutoOpenSlideshow && externalOpenRequestedDuringStartup) {
      startupFile = null;
    }

    if (startupFile) {
      if (initialFile) {
        await openFileInMultiFolderMode(startupFile);
      } else {
        await loadFile(startupFile);
      }
      viewedFolderTab = state.mode;
      renderFolderPanelSections();
      if (!initialFile && shouldAutoOpenSlideshow) {
        setRandomize(true);
        if (appSettings.autoSlideshowFillZoom) {
          setUiHidden(true);
          setAppFillMode(true);
        }
        startSlideshow();
      }
    }
    if (startupFile) {
      finishStartupLoadingAfterImageReady();
      return;
    }
  } catch (error) {
    debugLog('startup:error', { error: error?.message || String(error) });
    showToast('Startup loading failed');
    // Reveal the UI on error too — otherwise app-starting keeps the titlebar and
    // everything else hidden, leaving a permanently black window.
    document.body.classList.remove('app-starting');
  } finally {
    if (!startupFile) {
      document.body.classList.remove('app-starting');
    }
  }
})();
