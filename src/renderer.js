'use strict';

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
};

const ROTATION_DELAY = 150;
const ZOOM_FACTOR = 1.1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const RANDOM_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const RANDOM_NEW_IMAGE_DELAY = 30;
let loadSequence = 0;

let appSettings = defaultAppSettings();
let windowLabel = null;

function defaultAppSettings() {
  return {
    squareAppCorners: false,
    expandBorderlessEdges: false,
    autoOpenSlideshow: false,
    autoSlideshowFillZoom: false,
    lastFile: null,
  };
}

function normalizeAppSettings(s) {
  return {
    ...defaultAppSettings(),
    ...(s || {}),
    squareAppCorners: !!s?.squareAppCorners,
    expandBorderlessEdges: !!s?.expandBorderlessEdges,
    autoOpenSlideshow: !!s?.autoOpenSlideshow,
    autoSlideshowFillZoom: !!s?.autoSlideshowFillZoom,
    lastFile: typeof s?.lastFile === 'string' && s.lastFile ? s.lastFile : null,
  };
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

function applySettingsInputs() {
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
const btnOpen             = document.getElementById('btn-open');
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
const settingAutoOpenSlideshow      = document.getElementById('setting-auto-open-slideshow');
const settingAutoSlideshowFillZoom  = document.getElementById('setting-auto-slideshow-fill-zoom');
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
      : fromRandom && state.folderFiles.length
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

  positionDisplay.textContent = state.folderFiles.length > 1
    ? `${state.folderIndex + 1} / ${state.folderFiles.length}`
    : '';

  document.body.classList.add('has-image');

  // Reset transforms when loading a new image
  resetTransform(false);
  if (!temporary) {
    appSettings.lastFile = filePath;
    window.imageAPI.setLastFile(filePath).catch(() => {});
  }
  debugState.counters.loadSuccesses++;
  if (debugState.visible) renderDebugConsole();
}

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
  try {
    refreshed = uniqueFiles(await window.imageAPI.getFolderFiles(state.filePath));
  } catch (error) {
    debugLog('random:refresh-error', { error: error?.message || String(error) });
    return;
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
  if (now - lastNavTime < NAV_MIN_INTERVAL) return false;
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
  if (now - lastNavTime < NAV_MIN_INTERVAL) return false;
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
// Open File Dialog
// ==============================
async function openFileDialog() {
  const openAction = startDebugAction('open', 'Open');
  debugLog('open-dialog:start', {}, { action: openAction });
  const filePath = await window.imageAPI.openFile();
  debugLog('open-dialog:result', { filePath });
  if (filePath) loadFile(filePath, { addToHistory: true });
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

  applyTransform();
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

  applyTransform();
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
  applyTransform();
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
  await loadFile(result.filePath, {
    addToHistory: true,
    temporary: !!result.temporary,
  });
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
    await loadFile(filePath, { addToHistory: true });
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

async function refreshSlideshowPassiveState() {
  if (!state.slideshow) return;

  const sequence = ++passiveStateCheckSequence;
  const isMinimized = await window.imageAPI.isMinimized().catch(() => false);
  if (sequence !== passiveStateCheckSequence || !state.slideshow) return;

  if (document.hidden || isMinimized) {
    pauseSlideshowForPassiveState();
  } else {
    resumeSlideshowFromPassiveState();
    if (!state.slideshowTimer) scheduleSlideshowNext();
  }
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
  const x = Math.min(e.clientX, window.innerWidth - 140);
  const y = Math.min(e.clientY, window.innerHeight - 44);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.add('open');
});

ctxCopyImage.addEventListener('click', (e) => {
  e.stopPropagation();
  contextMenu.classList.remove('open');
  copyToClipboard();
});

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

settingsPanel.addEventListener('click', (e) => e.stopPropagation());

btnOpen.addEventListener('click', openFileDialog);
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

document.addEventListener('visibilitychange', refreshSlideshowPassiveState);
window.addEventListener('focus', refreshSlideshowPassiveState);
window.addEventListener('blur', () => {
  refreshSlideshowPassiveState();
});
window.addEventListener('resize', () => {
  if (state.appFillMode) {
    applyAppFillTransform(false);
  }
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
    loadFile(imageFile.path, { addToHistory: true });
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
    loadFile(imageFile, { addToHistory: true });
  }
});

// ==============================
// CLI / File Association
// ==============================
window.imageAPI.onOpenFile((filePath) => {
  loadFile(filePath, { addToHistory: true });
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
(async () => {
  windowLabel = await window.imageAPI.getWindowLabel().catch(() => 'main');
  await loadAppSettings();
  setSlideshowDuration(state.slideshowDuration); // sync dropdown active state
  await window.imageAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch(() => {});

  const initialFile = await window.imageAPI.getInitialFile().catch(() => null);
  const isFirstWindow = windowLabel === 'main';
  const shouldAutoOpenSlideshow = isFirstWindow && appSettings.autoOpenSlideshow;
  const startupFile = initialFile || (shouldAutoOpenSlideshow ? appSettings.lastFile : null);
  if (startupFile) {
    await loadFile(startupFile);
    if (!initialFile && shouldAutoOpenSlideshow) {
      setRandomize(true);
      if (appSettings.autoSlideshowFillZoom) {
        setUiHidden(true);
        setAppFillMode(true);
      }
      startSlideshow();
    }
  }
})();
