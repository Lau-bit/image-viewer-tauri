use arboard::{Clipboard, ImageData};
use image::{ImageBuffer, ImageFormat, ImageReader, Rgba};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, Size,
    WebviewWindow, WebviewWindowBuilder,
};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
#[cfg(windows)]
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM},
    Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BI_RGB,
        DIB_RGB_COLORS, HBITMAP,
    },
    System::{
        DataExchange::{
            CloseClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW,
            IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
        },
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    UI::Shell::{DragQueryFileW, HDROP},
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, ShowWindowAsync, SW_MINIMIZE,
    },
};

#[cfg(windows)]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(windows)]
const DWMWCP_DEFAULT: u32 = 0;
#[cfg(windows)]
const DWMWCP_DONOTROUND: u32 = 1;

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "avif", "tif", "tiff",
];
const FOLDER_CACHE_TTL: Duration = Duration::from_secs(60);
const SECONDARY_WINDOW_STAGGER: i32 = 28;
const BORDERLESS_EDGE_EXPAND: i32 = 2;

#[derive(Clone)]
struct FolderCacheEntry {
    created_at: Instant,
    modified: Option<std::time::SystemTime>,
    files: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    editor_path: Option<String>,
    #[serde(default)]
    square_app_corners: bool,
    #[serde(default)]
    expand_borderless_edges: bool,
    #[serde(default)]
    auto_open_slideshow: bool,
    #[serde(default)]
    auto_slideshow_fill_zoom: bool,
    #[serde(default)]
    last_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window: Option<WindowState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_window: Option<WindowState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secondary_window: Option<WindowState>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            editor_path: None,
            square_app_corners: false,
            expand_borderless_edges: false,
            auto_open_slideshow: false,
            auto_slideshow_fill_zoom: false,
            last_file: None,
            window: None,
            first_window: None,
            secondary_window: None,
        }
    }
}

// What load_settings returns to the frontend (user-visible prefs + last_file for startup)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedPrefs {
    square_app_corners: bool,
    expand_borderless_edges: bool,
    auto_open_slideshow: bool,
    auto_slideshow_fill_zoom: bool,
    last_file: Option<String>,
}

// What save_settings receives from the frontend (only user-controlled toggles)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPrefs {
    #[serde(default)]
    square_app_corners: bool,
    #[serde(default)]
    expand_borderless_edges: bool,
    #[serde(default)]
    auto_open_slideshow: bool,
    #[serde(default)]
    auto_slideshow_fill_zoom: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardDebugInfo {
    platform: String,
    formats: Vec<String>,
    arboard_file_list: Vec<String>,
    arboard_image: Option<String>,
    arboard_image_error: Option<String>,
    windows_file_drop: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum PasteResult {
    File { file_path: String, temporary: bool },
}

#[derive(Default)]
struct AppState {
    folder_cache: Mutex<HashMap<PathBuf, FolderCacheEntry>>,
    pending_initial_files: Mutex<HashMap<String, String>>,
    window_counter: AtomicUsize,
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            IMAGE_EXTS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("settings.json"))
}

fn normalize_settings(mut settings: Settings) -> Settings {
    if settings.first_window.is_none() {
        settings.first_window = settings.window.take();
    } else {
        settings.window = None;
    }
    settings
}

fn load_settings_inner(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<Settings>(&data).ok())
        .map(normalize_settings)
        .unwrap_or_default()
}

fn save_settings_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create settings directory: {error}"))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, data).map_err(|error| format!("Failed to save settings: {error}"))
}

fn current_logical_window_state(window: &WebviewWindow) -> Result<WindowState, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Failed to read window scale factor: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;

    Ok(WindowState {
        x: (f64::from(position.x) / scale).round() as i32,
        y: (f64::from(position.y) / scale).round() as i32,
        width: (f64::from(size.width) / scale).round() as u32,
        height: (f64::from(size.height) / scale).round() as u32,
    })
}

fn window_bounds_from_state(state: WindowState) -> WindowBounds {
    WindowBounds {
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
    }
}

fn expand_borderless_edges(bounds: &WindowState) -> WindowState {
    let expand = u32::try_from(BORDERLESS_EDGE_EXPAND).unwrap_or(0);
    WindowState {
        x: bounds.x.saturating_sub(BORDERLESS_EDGE_EXPAND),
        y: bounds.y.saturating_sub(BORDERLESS_EDGE_EXPAND),
        width: bounds.width.saturating_add(expand.saturating_mul(2)),
        height: bounds.height.saturating_add(expand.saturating_mul(2)),
    }
}

fn set_window_bounds(
    window: &WebviewWindow,
    bounds: &WindowState,
    expand_edges: bool,
) -> Result<(), String> {
    if bounds.width == 0 || bounds.height == 0 {
        return Ok(());
    }
    let adjusted;
    let bounds = if expand_edges {
        adjusted = expand_borderless_edges(bounds);
        &adjusted
    } else {
        bounds
    };

    window
        .set_position(Position::Logical(LogicalPosition {
            x: f64::from(bounds.x),
            y: f64::from(bounds.y),
        }))
        .map_err(|error| format!("Failed to restore window position: {error}"))?;
    window
        .set_size(Size::Logical(LogicalSize {
            width: f64::from(bounds.width),
            height: f64::from(bounds.height),
        }))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;
    window
        .set_position(Position::Logical(LogicalPosition {
            x: f64::from(bounds.x),
            y: f64::from(bounds.y),
        }))
        .map_err(|error| format!("Failed to restore final window position: {error}"))
}

fn ensure_window_visible(window: &WebviewWindow) -> Result<(), String> {
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Failed to read monitors: {error}"))?;
    if monitors.is_empty() {
        return Ok(());
    }

    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .outer_size()
        .or_else(|_| window.inner_size())
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    let window_left = i64::from(position.x);
    let window_top = i64::from(position.y);
    let window_right = window_left + i64::from(size.width);
    let window_bottom = window_top + i64::from(size.height);
    let min_visible_width = i64::from(size.width.min(160));
    let min_visible_height = i64::from(size.height.min(80));

    let mut best_index = 0usize;
    let mut best_score = i64::MIN;

    for (index, monitor) in monitors.iter().enumerate() {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let monitor_left = i64::from(monitor_position.x);
        let monitor_top = i64::from(monitor_position.y);
        let monitor_right = monitor_left + i64::from(monitor_size.width);
        let monitor_bottom = monitor_top + i64::from(monitor_size.height);

        let overlap_width =
            (window_right.min(monitor_right) - window_left.max(monitor_left)).max(0);
        let overlap_height =
            (window_bottom.min(monitor_bottom) - window_top.max(monitor_top)).max(0);
        if overlap_width >= min_visible_width && overlap_height >= min_visible_height {
            return Ok(());
        }

        let window_center_x = window_left + i64::from(size.width) / 2;
        let window_center_y = window_top + i64::from(size.height) / 2;
        let monitor_center_x = monitor_left + i64::from(monitor_size.width) / 2;
        let monitor_center_y = monitor_top + i64::from(monitor_size.height) / 2;
        let dx = window_center_x - monitor_center_x;
        let dy = window_center_y - monitor_center_y;
        let overlap_area = overlap_width * overlap_height;
        let distance_score = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
        let score = overlap_area
            .saturating_mul(1_000_000)
            .saturating_sub(distance_score);
        if score > best_score {
            best_score = score;
            best_index = index;
        }
    }

    let monitor = &monitors[best_index];
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let max_x = i64::from(monitor_position.x)
        + i64::from(monitor_size.width).saturating_sub(i64::from(size.width));
    let max_y = i64::from(monitor_position.y)
        + i64::from(monitor_size.height).saturating_sub(i64::from(size.height));

    let x = window_left.clamp(
        i64::from(monitor_position.x),
        max_x.max(i64::from(monitor_position.x)),
    );
    let y = window_top.clamp(
        i64::from(monitor_position.y),
        max_y.max(i64::from(monitor_position.y)),
    );

    window
        .set_position(Position::Physical(PhysicalPosition {
            x: x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
            y: y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        }))
        .map_err(|error| format!("Failed to move window onto primary monitor: {error}"))
}

fn stagger_window_state(bounds: &WindowState, stagger_index: usize) -> WindowState {
    let max_steps = usize::try_from(i32::MAX / SECONDARY_WINDOW_STAGGER).unwrap_or(usize::MAX);
    let steps = i32::try_from(stagger_index.min(max_steps)).unwrap_or(0);
    let offset = steps.saturating_mul(SECONDARY_WINDOW_STAGGER);

    WindowState {
        x: bounds.x.saturating_add(offset),
        y: bounds.y.saturating_add(offset),
        width: bounds.width,
        height: bounds.height,
    }
}

fn secondary_window_count(app: &AppHandle) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| label.as_str() != "main")
        .count()
}

fn first_image_arg<I>(args: I, cwd: Option<&Path>) -> Option<PathBuf>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .map(|arg| {
            let arg = arg.trim_matches('"');
            let path = arg
                .strip_prefix("file:///")
                .map(|path| path.replace('/', "\\"))
                .or_else(|| {
                    arg.strip_prefix("file://")
                        .map(|path| path.replace('/', "\\"))
                })
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(arg));
            if path.is_relative() {
                cwd.map(|cwd| cwd.join(&path)).unwrap_or(path)
            } else {
                path
            }
        })
        .find(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('-'))
                && path.exists()
                && is_image_path(path)
        })
}

fn initial_file_arg() -> Option<PathBuf> {
    first_image_arg(std::env::args().skip(1), None)
}

fn create_viewer_window(app: &AppHandle, initial_file: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let window_id = state.window_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("viewer-{window_id}");
    let stagger_index = secondary_window_count(app);
    let settings = load_settings_inner(app);

    if let Some(file_path) = initial_file {
        state
            .pending_initial_files
            .lock()
            .map_err(|_| "Failed to lock pending files.".to_string())?
            .insert(label.clone(), file_path);
    }

    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "No window configuration found.".to_string())?;
    config.label = label;

    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| format!("Failed to create viewer window: {error}"))?
        .build()
        .map_err(|error| format!("Failed to build viewer window: {error}"))?;

    let _ = set_square_window_corners(&window, settings.square_app_corners);
    if let Some(bounds) = settings.secondary_window.as_ref() {
        let bounds = stagger_window_state(bounds, stagger_index);
        let _ = set_window_bounds(&window, &bounds, settings.expand_borderless_edges);
    }
    let _ = ensure_window_visible(&window);

    let _ = window.unminimize();
    let _ = window.set_focus();

    Ok(())
}

fn image_to_clipboard(file_path: &Path) -> Result<bool, String> {
    if file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("svg"))
        .unwrap_or(false)
    {
        return Ok(false);
    }

    let image = ImageReader::open(file_path)
        .map_err(|error| format!("Failed to open image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("Failed to detect image format: {error}"))?
        .decode()
        .map_err(|error| format!("Failed to decode image: {error}"))?
        .to_rgba8();

    let width = usize::try_from(image.width()).map_err(|_| "Image is too wide.".to_string())?;
    let height = usize::try_from(image.height()).map_err(|_| "Image is too tall.".to_string())?;
    let data = ImageData {
        width,
        height,
        bytes: Cow::Owned(image.into_raw()),
    };

    Clipboard::new()
        .map_err(|error| format!("Failed to access clipboard: {error}"))?
        .set_image(data)
        .map_err(|error| format!("Failed to copy image: {error}"))?;
    Ok(true)
}

fn temp_paste_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve app cache directory: {error}"))?
        .join("clipboard-pastes"))
}

fn clean_temp_paste_dir(app: &AppHandle) {
    let Ok(dir) = temp_paste_dir(app) else {
        return;
    };
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
}

fn temp_paste_path(app: &AppHandle, extension: &str) -> Result<PathBuf, String> {
    let dir = temp_paste_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create clipboard paste directory: {error}"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Failed to build pasted image name: {error}"))?
        .as_millis();
    Ok(dir.join(format!("clipboard-{timestamp}.{extension}")))
}

fn sanitized_image_extension(extension: &str) -> Option<&'static str> {
    let extension = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    IMAGE_EXTS
        .iter()
        .copied()
        .find(|candidate| candidate.eq_ignore_ascii_case(&extension))
}

fn temp_paste_result(path: PathBuf) -> PasteResult {
    PasteResult::File {
        file_path: path.to_string_lossy().to_string(),
        temporary: true,
    }
}

fn save_clipboard_bmp(app: &AppHandle, bmp: Vec<u8>) -> Option<PasteResult> {
    let path = temp_paste_path(app, "bmp").ok()?;
    fs::write(&path, bmp).ok()?;
    Some(temp_paste_result(path))
}

fn bitmap_clipboard_image_to_file(app: &AppHandle) -> Result<Option<PasteResult>, String> {
    let image = match Clipboard::new()
        .map_err(|error| format!("Failed to access clipboard: {error}"))?
        .get_image()
    {
        Ok(image) => image,
        Err(_) => return Ok(None),
    };

    let width =
        u32::try_from(image.width).map_err(|_| "Clipboard image is too wide.".to_string())?;
    let height =
        u32::try_from(image.height).map_err(|_| "Clipboard image is too tall.".to_string())?;
    let buffer =
        ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, image.bytes.into_owned())
            .ok_or_else(|| "Clipboard image data is invalid.".to_string())?;

    let path = temp_paste_path(app, "png")?;
    buffer
        .save_with_format(&path, ImageFormat::Png)
        .map_err(|error| format!("Failed to save clipboard image: {error}"))?;

    Ok(Some(temp_paste_result(path)))
}

fn clipboard_file_list_image() -> Option<PasteResult> {
    let files = Clipboard::new().ok()?.get().file_list().ok()?;
    files
        .into_iter()
        .find(|path| path.is_file() && is_image_path(path))
        .map(|path| PasteResult::File {
            file_path: path.to_string_lossy().to_string(),
            temporary: false,
        })
}

fn arboard_file_list_debug() -> Vec<String> {
    Clipboard::new()
        .ok()
        .and_then(|mut clipboard| clipboard.get().file_list().ok())
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn arboard_image_debug() -> (Option<String>, Option<String>) {
    let Ok(mut clipboard) = Clipboard::new() else {
        return (None, Some("failed to access clipboard".to_string()));
    };

    match clipboard.get_image() {
        Ok(image) => (
            Some(format!(
                "{}x{} rgbaBytes={}",
                image.width,
                image.height,
                image.bytes.len()
            )),
            None,
        ),
        Err(error) => (None, Some(error.to_string())),
    }
}

#[cfg(windows)]
fn windows_standard_clipboard_format_name(format: u32) -> Option<&'static str> {
    match format {
        1 => Some("CF_TEXT"),
        2 => Some("CF_BITMAP"),
        3 => Some("CF_METAFILEPICT"),
        4 => Some("CF_SYLK"),
        5 => Some("CF_DIF"),
        6 => Some("CF_TIFF"),
        7 => Some("CF_OEMTEXT"),
        8 => Some("CF_DIB"),
        9 => Some("CF_PALETTE"),
        10 => Some("CF_PENDATA"),
        11 => Some("CF_RIFF"),
        12 => Some("CF_WAVE"),
        13 => Some("CF_UNICODETEXT"),
        14 => Some("CF_ENHMETAFILE"),
        15 => Some("CF_HDROP"),
        16 => Some("CF_LOCALE"),
        17 => Some("CF_DIBV5"),
        _ => None,
    }
}

#[cfg(windows)]
fn windows_clipboard_format_name(format: u32) -> String {
    if let Some(name) = windows_standard_clipboard_format_name(format) {
        return format!("{format}: {name}");
    }

    unsafe {
        let mut buffer = vec![0u16; 256];
        let len = GetClipboardFormatNameW(format, buffer.as_mut_ptr(), buffer.len() as i32);
        if len > 0 {
            buffer.truncate(len as usize);
            return format!("{format}: {}", String::from_utf16_lossy(&buffer));
        }
    }

    format!("{format}: Format{format}")
}

#[cfg(windows)]
fn windows_clipboard_formats() -> Vec<String> {
    let Some(_guard) = ClipboardGuard::open() else {
        return vec!["failed to open clipboard".to_string()];
    };

    let mut formats = Vec::new();
    let mut current = 0u32;
    loop {
        current = unsafe { EnumClipboardFormats(current) };
        if current == 0 {
            break;
        }
        formats.push(windows_clipboard_format_name(current));
    }
    formats
}

#[cfg(not(windows))]
fn windows_clipboard_formats() -> Vec<String> {
    Vec::new()
}

#[cfg(windows)]
fn windows_file_drop_debug() -> Vec<String> {
    const CF_HDROP: u32 = 15;
    let Some(_guard) = ClipboardGuard::open() else {
        return Vec::new();
    };

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return Vec::new();
        }

        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            return Vec::new();
        }

        let drop = handle as HDROP;
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        let mut paths = Vec::new();

        for index in 0..count {
            let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }

            let mut buffer = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), len + 1);
            if copied == 0 {
                continue;
            }

            buffer.truncate(copied as usize);
            paths.push(
                PathBuf::from(OsString::from_wide(&buffer))
                    .to_string_lossy()
                    .to_string(),
            );
        }

        paths
    }
}

#[cfg(not(windows))]
fn windows_file_drop_debug() -> Vec<String> {
    Vec::new()
}

fn clipboard_debug_info() -> ClipboardDebugInfo {
    let (arboard_image, arboard_image_error) = arboard_image_debug();
    ClipboardDebugInfo {
        platform: std::env::consts::OS.to_string(),
        formats: windows_clipboard_formats(),
        arboard_file_list: arboard_file_list_debug(),
        arboard_image,
        arboard_image_error,
        windows_file_drop: windows_file_drop_debug(),
    }
}

fn has_image_signature(bytes: &[u8], extension: &str) -> bool {
    match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1A\n"),
        "jpg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        _ => false,
    }
}

fn save_encoded_clipboard_image(
    app: &AppHandle,
    bytes: Vec<u8>,
    extension: &str,
) -> Option<PasteResult> {
    if !has_image_signature(&bytes, extension) {
        return None;
    }

    let path = temp_paste_path(app, extension).ok()?;
    fs::write(&path, bytes).ok()?;
    Some(temp_paste_result(path))
}

fn dib_to_bmp_bytes(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }

    let dib_header_size = u32::from_le_bytes(dib.get(0..4)?.try_into().ok()?) as usize;
    if dib_header_size < 40 || dib_header_size > dib.len() {
        return None;
    }

    let bits_per_pixel = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?);
    let compression = u32::from_le_bytes(dib.get(16..20)?.try_into().ok()?);
    let colors_used = u32::from_le_bytes(dib.get(32..36)?.try_into().ok()?) as usize;
    let palette_entries = if colors_used > 0 || bits_per_pixel > 8 {
        colors_used
    } else {
        1usize.checked_shl(bits_per_pixel.into()).unwrap_or(0)
    };
    let palette_size = palette_entries.checked_mul(4)?;
    let bitfields_size = if dib_header_size == 40 && (compression == 3 || compression == 6) {
        if dib.len() >= dib_header_size + palette_size + 16 {
            16
        } else {
            12
        }
    } else {
        0
    };
    let pixel_offset = 14usize
        .checked_add(dib_header_size)?
        .checked_add(bitfields_size)?
        .checked_add(palette_size)?;
    let file_size = 14usize.checked_add(dib.len())?;

    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

fn save_dib_clipboard_image(app: &AppHandle, dib: Vec<u8>) -> Option<PasteResult> {
    let bmp = dib_to_bmp_bytes(&dib)?;
    save_clipboard_bmp(app, bmp)
}

#[cfg(windows)]
fn save_hbitmap_clipboard_image(app: &AppHandle, hbitmap: HBITMAP) -> Option<PasteResult> {
    if hbitmap.is_null() {
        return None;
    }

    unsafe {
        let mut bitmap = BITMAP::default();
        let object_size = std::mem::size_of::<BITMAP>();
        if GetObjectW(
            hbitmap.cast(),
            i32::try_from(object_size).ok()?,
            (&mut bitmap as *mut BITMAP).cast(),
        ) == 0
        {
            return None;
        }

        let width = bitmap.bmWidth;
        let height = bitmap.bmHeight.abs();
        if width <= 0 || height <= 0 {
            return None;
        }

        let stride = usize::try_from(width).ok()?.checked_mul(4)?;
        let image_size = stride.checked_mul(usize::try_from(height).ok()?)?;
        let header_size = std::mem::size_of_val(&BITMAPINFO::default().bmiHeader);
        let pixel_offset = 14usize.checked_add(header_size)?;
        let file_size = pixel_offset.checked_add(image_size)?;

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = u32::try_from(header_size).ok()?;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        info.bmiHeader.biSizeImage = u32::try_from(image_size).ok()?;

        let dc = CreateCompatibleDC(std::ptr::null_mut());
        if dc.is_null() {
            return None;
        }

        let mut pixels = vec![0u8; image_size];
        let lines = GetDIBits(
            dc,
            hbitmap,
            0,
            u32::try_from(height).ok()?,
            pixels.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        DeleteDC(dc);

        if lines == 0 {
            return None;
        }

        let mut bmp = Vec::with_capacity(file_size);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0]);
        bmp.extend_from_slice(&(pixel_offset as u32).to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biSize.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biWidth.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biHeight.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biPlanes.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biBitCount.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biCompression.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biSizeImage.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biXPelsPerMeter.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biYPelsPerMeter.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biClrUsed.to_le_bytes());
        bmp.extend_from_slice(&info.bmiHeader.biClrImportant.to_le_bytes());
        bmp.extend_from_slice(&pixels);

        save_clipboard_bmp(app, bmp)
    }
}

#[cfg(windows)]
struct ClipboardGuard;

#[cfg(windows)]
impl ClipboardGuard {
    fn open() -> Option<Self> {
        Self::open_attempts(10)
    }

    fn open_attempts(attempts: usize) -> Option<Self> {
        for attempt in 0..attempts {
            unsafe {
                if OpenClipboard(std::ptr::null_mut()) != 0 {
                    return Some(Self);
                }
            }
            if attempt + 1 < attempts {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        None
    }
}

#[cfg(windows)]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn powershell_clipboard_image(app: &AppHandle) -> Option<PasteResult> {
    let temp_path = temp_paste_path(app, "png").ok()?;
    let extensions = IMAGE_EXTS
        .iter()
        .map(|ext| powershell_single_quoted(&format!(".{ext}")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$exts = @({extensions})
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
foreach ($file in $files) {{
  if ([System.IO.File]::Exists($file) -and $exts -contains [System.IO.Path]::GetExtension($file).ToLowerInvariant()) {{
    [Console]::Out.WriteLine("FILE`t" + $file)
    exit 0
  }}
}}
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $image) {{
  $out = $env:IMAGE_VIEWER_PASTE_OUT
  $image.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
  [Console]::Out.WriteLine("TEMP`t" + $out)
  exit 0
}}
exit 2
"#
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .env("IMAGE_VIEWER_PASTE_OUT", &temp_path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        let _ = fs::remove_file(temp_path);
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim();
    if let Some(file_path) = line.strip_prefix("FILE\t") {
        let path = PathBuf::from(file_path);
        if path.is_file() && is_image_path(&path) {
            let _ = fs::remove_file(temp_path);
            return Some(PasteResult::File {
                file_path: path.to_string_lossy().to_string(),
                temporary: false,
            });
        }
    }

    if let Some(file_path) = line.strip_prefix("TEMP\t") {
        let path = PathBuf::from(file_path);
        if path.is_file() && is_image_path(&path) {
            return Some(temp_paste_result(path));
        }
    }

    let _ = fs::remove_file(temp_path);
    None
}

#[cfg(not(windows))]
fn powershell_clipboard_image(_app: &AppHandle) -> Option<PasteResult> {
    None
}

#[cfg(windows)]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn clipboard_format_bytes(format: u32) -> Option<Vec<u8>> {
    unsafe {
        if IsClipboardFormatAvailable(format) == 0 {
            return None;
        }

        let handle = GetClipboardData(format);
        if handle.is_null() {
            return None;
        }

        let size = GlobalSize(handle);
        if size == 0 {
            return None;
        }

        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return None;
        }

        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), size).to_vec();
        GlobalUnlock(handle);
        Some(bytes)
    }
}

#[cfg(windows)]
fn clipboard_file_paths() -> Option<PasteResult> {
    const CF_HDROP: u32 = 15;

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP) == 0 {
            return None;
        }

        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            return None;
        }

        let drop = handle as HDROP;
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);

        for index in 0..count {
            let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }

            let mut buffer = vec![0u16; len as usize + 1];
            let copied = DragQueryFileW(drop, index, buffer.as_mut_ptr(), len + 1);
            if copied == 0 {
                continue;
            }

            buffer.truncate(copied as usize);
            let path = PathBuf::from(OsString::from_wide(&buffer));
            if path.is_file() && is_image_path(&path) {
                return Some(PasteResult::File {
                    file_path: path.to_string_lossy().to_string(),
                    temporary: false,
                });
            }
        }
    }

    None
}

#[cfg(windows)]
fn encoded_clipboard_image(app: &AppHandle) -> Option<PasteResult> {
    let candidates = [
        ("PNG", "png"),
        ("image/png", "png"),
        ("JFIF", "jpg"),
        ("JPEG", "jpg"),
        ("image/jpeg", "jpg"),
        ("image/jpg", "jpg"),
    ];

    for (format_name, extension) in candidates {
        let format = unsafe { RegisterClipboardFormatW(wide_null(format_name).as_ptr()) };
        if format == 0 {
            continue;
        }

        if let Some(bytes) = clipboard_format_bytes(format) {
            if let Some(result) = save_encoded_clipboard_image(app, bytes, extension) {
                return Some(result);
            }
        }
    }

    None
}

#[cfg(windows)]
fn dib_clipboard_image(app: &AppHandle) -> Option<PasteResult> {
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    for format in [CF_DIBV5, CF_DIB] {
        if let Some(bytes) = clipboard_format_bytes(format) {
            if let Some(result) = save_dib_clipboard_image(app, bytes) {
                return Some(result);
            }
        }
    }

    None
}

#[cfg(windows)]
fn hbitmap_clipboard_image(app: &AppHandle) -> Option<PasteResult> {
    const CF_BITMAP: u32 = 2;

    unsafe {
        if IsClipboardFormatAvailable(CF_BITMAP) == 0 {
            return None;
        }

        let handle = GetClipboardData(CF_BITMAP);
        if handle.is_null() {
            return None;
        }

        save_hbitmap_clipboard_image(app, handle as HBITMAP)
    }
}

#[cfg(windows)]
fn rich_clipboard_image(app: &AppHandle) -> Option<PasteResult> {
    let _guard = ClipboardGuard::open()?;
    encoded_clipboard_image(app)
        .or_else(|| hbitmap_clipboard_image(app))
        .or_else(|| dib_clipboard_image(app))
        .or_else(clipboard_file_paths)
}

#[cfg(not(windows))]
fn rich_clipboard_image(_app: &AppHandle) -> Option<PasteResult> {
    None
}

fn clipboard_image(app: &AppHandle) -> Result<Option<PasteResult>, String> {
    if let Some(result) = clipboard_file_list_image() {
        return Ok(Some(result));
    }

    #[cfg(windows)]
    if let Some(result) = rich_clipboard_image(app) {
        return Ok(Some(result));
    }

    if let Some(result) = bitmap_clipboard_image_to_file(app)? {
        return Ok(Some(result));
    }

    if let Some(result) = powershell_clipboard_image(app) {
        return Ok(Some(result));
    }

    #[cfg(windows)]
    return Ok(None);

    #[cfg(not(windows))]
    Ok(rich_clipboard_image(app))
}

#[tauri::command]
fn get_folder_files(
    state: tauri::State<'_, AppState>,
    file_path: String,
) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&file_path);
    let dir = path.parent().map(Path::to_path_buf);
    let Some(dir) = dir else {
        return Ok(vec![file_path]);
    };

    let modified = fs::metadata(&dir).and_then(|meta| meta.modified()).ok();
    if let Ok(cache) = state.folder_cache.lock() {
        if let Some(entry) = cache.get(&dir) {
            if entry.modified == modified && entry.created_at.elapsed() < FOLDER_CACHE_TTL {
                return Ok(entry.files.clone());
            }
        }
    }

    let mut files = fs::read_dir(&dir)
        .map_err(|error| format!("Failed to read folder: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_image_path(path))
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| b.1.cmp(&a.1));
    let files = files
        .into_iter()
        .map(|(path, _)| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let files = if files.is_empty() {
        vec![file_path]
    } else {
        files
    };

    if let Ok(mut cache) = state.folder_cache.lock() {
        cache.insert(
            dir,
            FolderCacheEntry {
                created_at: Instant::now(),
                modified,
                files: files.clone(),
            },
        );
    }

    Ok(files)
}

#[tauri::command]
fn read_file_bytes(file_path: String) -> Result<Vec<u8>, String> {
    fs::read(file_path).map_err(|error| format!("Failed to read file: {error}"))
}

#[tauri::command]
fn copy_to_clipboard(file_path: String) -> bool {
    image_to_clipboard(Path::new(&file_path)).unwrap_or(false)
}

#[tauri::command]
fn get_clipboard_debug_info() -> ClipboardDebugInfo {
    clipboard_debug_info()
}

#[tauri::command]
fn paste_from_clipboard(app: AppHandle) -> Result<Option<PasteResult>, String> {
    clipboard_image(&app)
}

#[tauri::command]
fn save_pasted_image_bytes(
    app: AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<PasteResult, String> {
    let extension = sanitized_image_extension(&extension)
        .ok_or_else(|| "Unsupported pasted image format.".to_string())?;
    let path = temp_paste_path(&app, extension)?;
    fs::write(&path, bytes).map_err(|error| format!("Failed to save pasted image: {error}"))?;
    Ok(temp_paste_result(path))
}

#[tauri::command]
fn cleanup_pasted_file(app: AppHandle, file_path: String) -> bool {
    let Ok(dir) = temp_paste_dir(&app).and_then(|path| {
        path.canonicalize()
            .map_err(|error| format!("Failed to resolve paste directory: {error}"))
    }) else {
        return false;
    };

    let path = PathBuf::from(file_path);
    let Ok(path) = path.canonicalize() else {
        return false;
    };

    if !path.starts_with(dir) {
        return false;
    }

    fs::remove_file(path).is_ok()
}

#[tauri::command]
fn get_initial_file(state: tauri::State<'_, AppState>, window: WebviewWindow) -> Option<String> {
    if let Ok(mut pending) = state.pending_initial_files.lock() {
        if let Some(file_path) = pending.remove(window.label()) {
            return Some(file_path);
        }
    }

    if window.label() == "main" {
        return initial_file_arg().map(|path| path.to_string_lossy().to_string());
    }

    None
}

#[cfg(windows)]
fn set_square_window_corners(window: &WebviewWindow, square: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to read window handle: {error}"))?;
    let preference = if square {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_DEFAULT
    };
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&preference as *const u32).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("Failed to set window corner preference: {result}"))
    }
}

#[cfg(not(windows))]
fn set_square_window_corners(_window: &WebviewWindow, _square: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_window_square_corners(window: WebviewWindow, square: bool) -> Result<(), String> {
    set_square_window_corners(&window, square)
}

#[tauri::command]
fn adjust_window_borderless_edges(window: WebviewWindow, expand: bool) -> Result<(), String> {
    let bounds = current_logical_window_state(&window)?;
    let adjusted = if expand {
        expand_borderless_edges(&bounds)
    } else {
        let shrink = u32::try_from(BORDERLESS_EDGE_EXPAND).unwrap_or(0);
        WindowState {
            x: bounds.x.saturating_add(BORDERLESS_EDGE_EXPAND),
            y: bounds.y.saturating_add(BORDERLESS_EDGE_EXPAND),
            width: bounds.width.saturating_sub(shrink.saturating_mul(2)).max(1),
            height: bounds
                .height
                .saturating_sub(shrink.saturating_mul(2))
                .max(1),
        }
    };

    set_window_bounds(&window, &adjusted, false)?;
    ensure_window_visible(&window)
}

#[tauri::command]
fn get_window_label(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
fn load_settings(app: AppHandle) -> LoadedPrefs {
    let s = load_settings_inner(&app);
    LoadedPrefs {
        square_app_corners: s.square_app_corners,
        expand_borderless_edges: s.expand_borderless_edges,
        auto_open_slideshow: s.auto_open_slideshow,
        auto_slideshow_fill_zoom: s.auto_slideshow_fill_zoom,
        last_file: s.last_file,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: SavedPrefs) -> Result<(), String> {
    let mut full = load_settings_inner(&app);
    full.square_app_corners = settings.square_app_corners;
    full.expand_borderless_edges = settings.expand_borderless_edges;
    full.auto_open_slideshow = settings.auto_open_slideshow;
    full.auto_slideshow_fill_zoom = settings.auto_slideshow_fill_zoom;
    save_settings_inner(&app, &full)
}

#[tauri::command]
fn set_last_file(app: AppHandle, file_path: String) -> Result<(), String> {
    let mut settings = load_settings_inner(&app);
    settings.last_file = Some(file_path);
    save_settings_inner(&app, &settings)
}

#[tauri::command]
fn save_window_position_preset(
    app: AppHandle,
    window: WebviewWindow,
    preset: String,
) -> Result<WindowBounds, String> {
    let state = current_logical_window_state(&window)?;
    let mut settings = load_settings_inner(&app);
    let bounds = window_bounds_from_state(state);

    match preset.as_str() {
        "first" => settings.first_window = Some(state),
        "secondary" => settings.secondary_window = Some(state),
        _ => return Err(format!("Unknown window position preset: {preset}")),
    }

    settings.window = None;
    save_settings_inner(&app, &settings)?;
    Ok(bounds)
}

#[tauri::command]
fn reset_window_position_preset(app: AppHandle, preset: String) -> Result<(), String> {
    let mut settings = load_settings_inner(&app);

    match preset.as_str() {
        "first" => settings.first_window = None,
        "secondary" => settings.secondary_window = None,
        _ => return Err(format!("Unknown window position preset: {preset}")),
    }

    settings.window = None;
    save_settings_inner(&app, &settings)
}

#[tauri::command]
fn get_editor_path(app: AppHandle) -> Option<String> {
    load_settings_inner(&app).editor_path
}

#[tauri::command]
fn set_editor_path(app: AppHandle, editor_path: String) -> Result<String, String> {
    let mut settings = load_settings_inner(&app);
    settings.editor_path = Some(editor_path.clone());
    save_settings_inner(&app, &settings)?;
    Ok(editor_path)
}

#[tauri::command]
fn open_in_editor(app: AppHandle, file_path: String) -> bool {
    let Some(editor_path) = load_settings_inner(&app).editor_path else {
        return false;
    };

    Command::new(editor_path)
        .arg(file_path)
        .spawn()
        .map(|_| true)
        .unwrap_or(false)
}

#[cfg(windows)]
struct MinimizeWindowsState {
    current_exe: PathBuf,
    minimized_count: usize,
}

#[cfg(windows)]
fn paths_match(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(windows)]
fn process_exe_path(process_id: u32) -> Option<PathBuf> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }

        let mut buffer = vec![0u16; 32768];
        let mut size = u32::try_from(buffer.len()).ok()?;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
        let _ = CloseHandle(process);

        if ok == 0 || size == 0 {
            return None;
        }

        buffer.truncate(size as usize);
        Some(PathBuf::from(OsString::from_wide(&buffer)))
    }
}

#[cfg(windows)]
unsafe extern "system" fn enum_matching_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    let state = &mut *(lparam as *mut MinimizeWindowsState);

    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }

    let mut process_id = 0;
    GetWindowThreadProcessId(hwnd, &mut process_id);

    if process_id != 0 {
        if let Some(exe_path) = process_exe_path(process_id) {
            if paths_match(&exe_path, &state.current_exe) {
                ShowWindowAsync(hwnd, SW_MINIMIZE);
                state.minimized_count += 1;
            }
        }
    }

    1
}

#[cfg(windows)]
fn minimize_same_executable_windows() -> usize {
    let Ok(current_exe) = std::env::current_exe() else {
        return 0;
    };
    let mut state = MinimizeWindowsState {
        current_exe,
        minimized_count: 0,
    };

    unsafe {
        EnumWindows(Some(enum_matching_window), &mut state as *mut _ as LPARAM);
    }

    state.minimized_count
}

#[cfg(not(windows))]
fn minimize_same_executable_windows() -> usize {
    0
}

#[tauri::command]
fn window_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(next)
        .map_err(|error| error.to_string())?;
    window
        .emit("window-fullscreen-changed", next)
        .map_err(|error| error.to_string())?;
    Ok(next)
}

#[tauri::command]
fn window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_is_minimized(window: WebviewWindow) -> Result<bool, String> {
    window.is_minimized().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize_all(app: AppHandle) -> usize {
    let mut minimized_count = 0;

    for window in app.webview_windows().values() {
        if window.minimize().is_ok() {
            minimized_count += 1;
        }
    }

    minimized_count + minimize_same_executable_windows()
}

#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let app = app.clone();
            let cwd = PathBuf::from(cwd);
            let initial_file =
                first_image_arg(args, Some(&cwd)).map(|path| path.to_string_lossy().to_string());
            let app_for_task = app.clone();

            let _ = app.run_on_main_thread(move || {
                if create_viewer_window(&app_for_task, initial_file).is_ok() {
                    return;
                }

                if let Some(window) = app_for_task.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            clean_temp_paste_dir(app.handle());
            let settings = load_settings_inner(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                let _ = set_square_window_corners(&window, settings.square_app_corners);
                if let Some(bounds) = settings.first_window.as_ref() {
                    let _ = set_window_bounds(&window, bounds, settings.expand_borderless_edges);
                }
                let _ = ensure_window_visible(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            adjust_window_borderless_edges,
            cleanup_pasted_file,
            copy_to_clipboard,
            get_clipboard_debug_info,
            get_editor_path,
            get_folder_files,
            get_initial_file,
            get_window_label,
            load_settings,
            open_in_editor,
            paste_from_clipboard,
            read_file_bytes,
            reset_window_position_preset,
            save_pasted_image_bytes,
            save_settings,
            save_window_position_preset,
            set_editor_path,
            set_last_file,
            set_window_square_corners,
            window_close,
            window_is_fullscreen,
            window_is_minimized,
            window_minimize,
            window_minimize_all,
            window_start_drag,
            window_toggle_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
