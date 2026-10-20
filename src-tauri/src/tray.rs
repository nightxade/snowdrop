//! System tray icon, its unread badge, and the close-to-tray decision. See
//! docs/DESKTOP.md, "System tray and badges".
//!
//! Three independent pieces, in order below:
//!
//! 1. Pure, unit-tested logic: `badge_label` (count → what the badge draws),
//!    `RenderCache` (memoises a render by label), the pixel painter
//!    (`paint_badge`/`render_tray_rgba`/`render_overlay_rgba`), and
//!    `close_decision` (tray available × "close to tray" setting → hide or
//!    quit). None of this touches Tauri types, so it's tested without a
//!    running app.
//! 2. `appindicator_available`: a Linux-only, non-panicking preflight check —
//!    see its own doc comment for why this exists at all.
//! 3. The Tauri glue: `init`, `set_unread`, `TrayState`, `CloseToTray`, and
//!    the menu/click handlers. Builds the tray, renders/caches real
//!    `Image`s, and wires everything into `AppHandle`/`WebviewWindow`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::image::Image;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::CloseGate;

// ─── Badge label and rendering (pure; unit-tested) ─────────────────────────

/// What the badge draws for a given unread total — `None` means no badge at
/// all (a plain icon). Capped at a single digit plus "+" rather than two
/// exact digits: at the ~22–24px a cramped SNI host actually renders this
/// icon, one big glyph stays legible where two smaller ones would blur
/// together. The taskbar/dock badge and window title (`set_unread` below)
/// show the real, uncapped count — they have far more room.
pub fn badge_label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// "Snowdrop" or "Snowdrop — 3 unread" — the tray tooltip/title and, with
/// its own wording, the window title fallback below.
fn tooltip_text(count: u32) -> String {
    if count == 0 { "Snowdrop".to_string() } else { format!("Snowdrop — {count} unread") }
}

/// "Snowdrop" or "Snowdrop (3)" — the Discord-style window-title fallback
/// many window managers show even without reading the tray at all.
fn window_title(count: u32) -> String {
    if count == 0 { "Snowdrop".to_string() } else { format!("Snowdrop ({count})") }
}

/// Memoises a render by its label so repeated identical labels — the common
/// case, since most unread *changes* don't cross a `badge_label` boundary
/// (2 → 3 is a cache miss once; every further change that's still "9+"
/// isn't) — never redraw. Keyed by the label, not the raw count: every count
/// ≥ 10 shares the one `"9+"` entry.
struct RenderCache<T: Clone> {
    entries: HashMap<Option<String>, T>,
}

impl<T: Clone> RenderCache<T> {
    fn new() -> Self {
        Self { entries: HashMap::new() }
    }

    fn get_or_render(&mut self, label: Option<String>, render: impl FnOnce() -> T) -> T {
        self.entries.entry(label).or_insert_with(render).clone()
    }
}

const BADGE_RED: [u8; 3] = [0xE5, 0x1C, 0x23];
const WHITE: [u8; 3] = [0xFF, 0xFF, 0xFF];

/// 3 columns × 5 rows, MSB = leftmost column. Legible at a handful of pixels
/// a side, which is all a badge glyph gets once the host downscales — a
/// real font would just blur into the same blob at this size.
const DIGIT_FONT: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b001, 0b001, 0b001], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];
const PLUS_GLYPH: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];

fn glyph_rows(ch: char) -> Option<[u8; 5]> {
    match ch {
        '0'..='9' => Some(DIGIT_FONT[ch as usize - '0' as usize]),
        '+' => Some(PLUS_GLYPH),
        _ => None,
    }
}

fn pixel_mut(buf: &mut [u8], width: u32, x: u32, y: u32) -> &mut [u8] {
    let i = ((y * width + x) * 4) as usize;
    &mut buf[i..i + 4]
}

/// Linear blend of `rgb` over whatever's already at `px`, by `alpha` (0–1).
/// Alpha itself is blended the same way, so painting over a transparent
/// background (the Windows overlay icon) leaves it opaque only where
/// something was actually drawn.
fn blend(px: &mut [u8], rgb: [u8; 3], alpha: f32) {
    for c in 0..3 {
        px[c] = (px[c] as f32 * (1.0 - alpha) + rgb[c] as f32 * alpha).round() as u8;
    }
    px[3] = (px[3] as f32 * (1.0 - alpha) + 255.0 * alpha).round() as u8;
}

/// Paints a filled red circle (anti-aliased edge) in the top-right corner of
/// a `width`×`height` RGBA buffer, with `label` in white glyphs centered on
/// it. Every measurement is derived from `width`, so the same function
/// draws a crisp badge on the 128px tray base and the smaller Windows
/// overlay canvas alike.
fn paint_badge(buf: &mut [u8], width: u32, height: u32, label: &str) {
    let w = width as i32;
    let h = height as i32;
    let margin = (w / 32).max(1);
    let r = (w * 19 / 64).max(5);
    let cx = w - r - margin;
    let cy = r + margin;

    let x0 = (cx - r - 1).max(0);
    let x1 = (cx + r + 1).min(w - 1);
    let y0 = (cy - r - 1).max(0);
    let y1 = (cy + r + 1).min(h - 1);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 - cx as f32 + 0.5;
            let dy = y as f32 - cy as f32 + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            let coverage = (r as f32 + 0.5 - dist).clamp(0.0, 1.0);
            if coverage > 0.0 {
                blend(pixel_mut(buf, width, x as u32, y as u32), BADGE_RED, coverage);
            }
        }
    }

    let chars: Vec<char> = label.chars().collect();
    let scale = (r * 2 / 10).max(1);
    let cols = (chars.len() as i32 * 3 + (chars.len() as i32 - 1).max(0)).max(1);
    let total_w = cols * scale;
    let total_h = 5 * scale;
    let gx0 = cx - total_w / 2;
    let gy0 = cy - total_h / 2;

    let mut col_cursor = gx0;
    for ch in chars {
        let Some(rows) = glyph_rows(ch) else { continue };
        for (row_i, bits) in rows.iter().enumerate() {
            for bit in 0..3u32 {
                if bits & (1 << (2 - bit)) == 0 {
                    continue;
                }
                let px0 = col_cursor + bit as i32 * scale;
                let py0 = gy0 + row_i as i32 * scale;
                for py in py0..py0 + scale {
                    for px in px0..px0 + scale {
                        if px < 0 || py < 0 || px >= w || py >= h {
                            continue;
                        }
                        blend(pixel_mut(buf, width, px as u32, py as u32), WHITE, 1.0);
                    }
                }
            }
        }
        col_cursor += 4 * scale; // 3 glyph columns + 1 column of gap.
    }
}

/// The tray icon for `label`: a clone of `base` (the app icon) with the
/// badge painted over it, or `base` itself unchanged when `label` is `None`
/// (zero unread — a plain icon).
fn render_tray_rgba(base: &[u8], width: u32, height: u32, label: Option<&str>) -> Vec<u8> {
    let mut buf = base.to_vec();
    if let Some(label) = label {
        paint_badge(&mut buf, width, height, label);
    }
    buf
}

/// The Windows taskbar overlay icon: the badge alone, on a transparent
/// canvas (the overlay sits on top of the real taskbar icon, so it must not
/// repaint the app icon itself underneath it). Only ever called on Windows
/// (`overlay_image` below) — kept compiled (and unit-testable) on every
/// platform rather than `#[cfg]`-gated away, since it's pure and platform-
/// independent itself.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn render_overlay_rgba(size: u32, label: &str) -> Vec<u8> {
    let mut buf = vec![0u8; (size * size * 4) as usize];
    paint_badge(&mut buf, size, size, label);
    buf
}

// ─── Close-to-tray decision (pure; unit-tested) ────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Quit,
}

/// The main window's `CloseRequested` (`lib.rs`): hide behind the tray only
/// when both a tray actually exists *and* the user opted in — either being
/// false falls back to today's behaviour (run the quit handshake).
pub fn close_decision(tray_available: bool, close_to_tray: bool) -> CloseAction {
    if tray_available && close_to_tray { CloseAction::Hide } else { CloseAction::Quit }
}

/// Settings → Behaviour's "Keep running in the tray" (`behaviour.closeToTray`
/// in src/core/stores/settings.ts), mirrored here by the `app_set_close_to_tray`
/// command since Rust has no access to the frontend's own settings store.
/// Starts `false` (quit) until the frontend's boot-time subscriber
/// (`src/app/createSnowdrop.ts`) sends the real value — a safe default for
/// the brief instant between the window existing and that first call.
pub struct CloseToTray(AtomicBool);

impl CloseToTray {
    pub(crate) fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub fn set(&self, enabled: bool) {
        self.0.store(enabled, Ordering::SeqCst);
    }

    fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

// ─── Linux: guarding the AppIndicator dlopen panic ─────────────────────────

/// Whether a StatusNotifierItem/AppIndicator host library can actually be
/// loaded here.
///
/// `tray-icon`'s default Linux backend (the `libappindicator` crate) dlopen's
/// `libayatana-appindicator3.so.1` or `libappindicator3.so.1` the first time
/// a tray icon is built — and **panics** if neither is found
/// (`libappindicator-sys`'s `LIB: Lazy<Library>` does `panic!()` with no
/// fallback). This binary's release profile is `panic = "abort"`
/// (Cargo.toml), so nothing downstream — not even `catch_unwind` — could
/// ever rescue that panic in a real build; the whole process would just
/// die. So this probes for the exact same two library names first, with a
/// bare, non-panicking `dlopen`/`dlclose`, and `init` below only calls into
/// `tray-icon` at all when this says yes. A Linux box with no AppIndicator
/// library (plain GNOME without the extension, a minimal WM, most
/// containers) just runs with no tray instead of crashing.
#[cfg(target_os = "linux")]
fn appindicator_available() -> bool {
    use std::ffi::CString;

    const CANDIDATES: [&str; 2] =
        ["libayatana-appindicator3.so.1", "libappindicator3.so.1"];
    CANDIDATES.iter().any(|name| {
        let Ok(cname) = CString::new(*name) else { return false };
        // SAFETY: `cname` is a valid, NUL-terminated C string for the call's
        // duration; the handle (if any) is closed again immediately and
        // never dereferenced.
        let handle = unsafe { libc::dlopen(cname.as_ptr(), libc::RTLD_LAZY) };
        if handle.is_null() {
            false
        } else {
            unsafe { libc::dlclose(handle) };
            true
        }
    })
}

#[cfg(not(target_os = "linux"))]
fn appindicator_available() -> bool {
    true
}

// ─── Tauri glue ─────────────────────────────────────────────────────────────

/// The bundle's own icon, supersampled relative to the ~22–32px most tray
/// hosts actually render it at, so the host's own downscale stays crisp
/// instead of upscaling a small bitmap (also used, unmodified, for zero
/// unread). Decoded with the `png` crate (Cargo.toml has the full
/// justification for going straight to it instead of `tauri`'s own
/// `image-png` feature) into raw RGBA for the badge renderer to draw on;
/// `tauri::image::Image` itself never decodes anything — `Image::new_owned`
/// just wraps already-decoded bytes.
const BASE_ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

/// The Windows overlay badge's own canvas (badge only, no base icon —
/// see `render_overlay_rgba`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const OVERLAY_SIZE: u32 = 64;

struct BaseIcon {
    rgba: Vec<u8>,
    width: u32,
    height: u32,
}

fn decode_base_icon() -> BaseIcon {
    let decoder = png::Decoder::new(std::io::Cursor::new(BASE_ICON_PNG));
    let mut reader = decoder.read_info().expect("the embedded tray icon PNG is well-formed");
    let mut buf = vec![0u8; reader.output_buffer_size().expect("the embedded tray icon PNG has exactly one frame")];
    let info = reader.next_frame(&mut buf).expect("the embedded tray icon PNG decodes cleanly");
    assert_eq!(info.color_type, png::ColorType::Rgba, "the embedded tray icon PNG must be 8-bit RGBA");
    assert_eq!(info.bit_depth, png::BitDepth::Eight, "the embedded tray icon PNG must be 8-bit RGBA");
    buf.truncate((info.width * info.height * 4) as usize);
    BaseIcon { rgba: buf, width: info.width, height: info.height }
}

/// Everything the tray needs at runtime: the tray handle itself (`None` when
/// there's no usable host — see `appindicator_available`, or `build` below
/// failing for some other reason), the decoded base icon, and the rendered-
/// icon caches (tray + Windows overlay).
pub struct TrayState {
    tray: Option<TrayIcon>,
    base: BaseIcon,
    cache: RenderCache<Vec<u8>>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    overlay_cache: RenderCache<Vec<u8>>,
}

/// Whether a tray icon exists right now — `desktop_info` (`commands.rs`)
/// reports this to the frontend as `trayAvailable`, so Settings → Behaviour
/// can hide "Keep running in the tray" when there's nothing to keep it in.
pub fn available(app: &AppHandle) -> bool {
    app.state::<Arc<Mutex<TrayState>>>().lock().expect("tray lock").tray.is_some()
}

/// Builds the tray icon and its menu, or leaves it absent if this host can't
/// have one. Safe to call unconditionally on every platform: the Linux
/// guard above, and `TrayIconBuilder::build`'s own `Result`, both degrade to
/// "no tray" rather than ever panicking or erroring out of `setup()`.
pub fn init(app: &AppHandle) -> TrayState {
    let base = decode_base_icon();
    #[cfg(target_os = "linux")]
    let host_ok = appindicator_available();
    #[cfg(not(target_os = "linux"))]
    let host_ok = true;

    let tray = if host_ok {
        let icon = Image::new_owned(base.rgba.clone(), base.width, base.height);
        build_tray(app, icon)
    } else {
        log::info!(
            "snowdrop: no AppIndicator/StatusNotifierItem library found; running without a tray icon."
        );
        None
    };

    TrayState { tray, base, cache: RenderCache::new(), overlay_cache: RenderCache::new() }
}

fn build_tray(app: &AppHandle, icon: Image<'static>) -> Option<TrayIcon> {
    // No "Mark all as read": there's no command for marking *every*
    // conversation read today (only per-space/per-folder, in
    // src/ui/features/spaces/useSpaceMenu.tsx, and per-conversation,
    // CoreCommand.MarkRead) — only wiring up what already exists.
    let menu = match MenuBuilder::new(app)
        .text("show", "Show Snowdrop")
        .separator()
        .text("quit", "Quit Snowdrop")
        .build()
    {
        Ok(menu) => menu,
        Err(e) => {
            log::warn!("snowdrop: couldn't build the tray menu: {e}");
            return None;
        }
    };

    let result = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Snowdrop")
        .menu(&menu)
        // We handle left-click ourselves (toggle show/hide) rather than
        // always opening the menu for it; unsupported on Linux regardless
        // (see `on_tray_icon_event` below), where the menu's own "Show
        // Snowdrop" item is the one guaranteed affordance.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => crate::focus_main(app),
            "quit" => begin_quit_from_menu(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_or_focus(tray.app_handle());
            }
        })
        .build(app);

    match result {
        Ok(tray) => Some(tray),
        Err(e) => {
            log::warn!("snowdrop: couldn't create the tray icon: {e}");
            None
        }
    }
}

/// Left click (Windows/macOS; Linux never delivers this — see `build_tray`):
/// show + focus, or hide again if it's already the focused, visible window.
fn toggle_or_focus(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        crate::focus_main(app);
    }
}

/// The tray menu's "Quit Snowdrop": always runs the real quit handshake
/// (`crate::begin_quit`), regardless of the close-to-tray setting — unlike
/// the window's own close button, which may just hide it instead.
fn begin_quit_from_menu(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => {
            let gate = app.state::<Arc<CloseGate>>().inner().clone();
            crate::begin_quit(&window, gate);
        }
        // No window to flush from (shouldn't happen in practice — hiding
        // never destroys it) — exit directly rather than get stuck unable
        // to quit at all.
        None => app.exit(0),
    }
}

/// Mirrors `count` (the frontend's `totalUnread(...).count` — muted chats
/// excluded, same as the TUI shell's own status line) to the tray icon's
/// badge and tooltip/title, the taskbar/dock badge, and the window title.
/// Called by the `app_set_unread` command, already debounced to ~250ms and
/// change-only on the frontend side (`src/app/createSnowdrop.ts`).
pub fn set_unread(app: &AppHandle, count: u32) {
    let label = badge_label(count);
    update_tray(app, label.clone(), count);

    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.set_title(&window_title(count));

    #[cfg(target_os = "windows")]
    {
        // `set_badge_count` is unsupported on Windows (its own doc comment);
        // `set_overlay_icon` is the platform's equivalent.
        let overlay = label.as_deref().map(|l| overlay_image(app, l));
        let _ = window.set_overlay_icon(overlay);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Unity LauncherEntry (Linux) and the dock badge (macOS) both take
        // the real count, uncapped — unlike the tray glyph, they have room.
        let _ = window.set_badge_count(if count == 0 { None } else { Some(count as i64) });
    }
}

fn update_tray(app: &AppHandle, label: Option<String>, count: u32) {
    let state = app.state::<Arc<Mutex<TrayState>>>();
    let (tray, rgba, width, height) = {
        let mut state = state.lock().expect("tray lock");
        let Some(tray) = state.tray.clone() else { return };
        let width = state.base.width;
        let height = state.base.height;
        let base_rgba = state.base.rgba.clone();
        let key = label.clone();
        let rgba = state
            .cache
            .get_or_render(key, move || render_tray_rgba(&base_rgba, width, height, label.as_deref()));
        (tray, rgba, width, height)
    };
    let _ = tray.set_icon(Some(Image::new_owned(rgba, width, height)));
    let text = tooltip_text(count);
    let _ = tray.set_tooltip(Some(&text));
    let _ = tray.set_title(Some(&text));
}

#[cfg(target_os = "windows")]
fn overlay_image(app: &AppHandle, label: &str) -> Image<'static> {
    let state = app.state::<Arc<Mutex<TrayState>>>();
    let mut state = state.lock().expect("tray lock");
    let rgba = state
        .overlay_cache
        .get_or_render(Some(label.to_string()), || render_overlay_rgba(OVERLAY_SIZE, label));
    Image::new_owned(rgba, OVERLAY_SIZE, OVERLAY_SIZE)
}

/// Reads the mirrored `behaviour.closeToTray` setting for `lib.rs`'s
/// `CloseRequested` handler.
pub fn close_to_tray(app: &AppHandle) -> bool {
    app.state::<Arc<CloseToTray>>().get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_zero_as_no_badge() {
        assert_eq!(badge_label(0), None);
    }

    #[test]
    fn labels_one_to_nine_as_the_exact_digit() {
        for n in 1..=9 {
            assert_eq!(badge_label(n), Some(n.to_string()));
        }
    }

    #[test]
    fn caps_ten_and_above_at_nine_plus() {
        assert_eq!(badge_label(10), Some("9+".to_string()));
        assert_eq!(badge_label(99), Some("9+".to_string()));
        assert_eq!(badge_label(12_345), Some("9+".to_string()));
    }

    #[test]
    fn zero_unread_leaves_the_base_icon_unchanged() {
        let base = [10u8, 20, 30, 255].repeat(8 * 8);
        let rendered = render_tray_rgba(&base, 8, 8, badge_label(0).as_deref());
        assert_eq!(rendered, base);
    }

    #[test]
    fn nonzero_unread_paints_something_near_the_top_right_corner() {
        let base = [0u8, 0, 0, 0].repeat(32 * 32);
        let rendered = render_tray_rgba(&base, 32, 32, badge_label(3).as_deref());
        assert_ne!(rendered, base);
        // The very top of the badge circle is always background colour (far
        // from the centered glyph) but must still be solid red. Mirrors
        // `paint_badge`'s own geometry for width = 32 (margin = 1, r = 9).
        let margin: i32 = 1;
        let r: i32 = 9;
        let cx = (32 - r - margin) as u32;
        let cy_top = (margin + 1) as u32; // one past the circle's top edge.
        let i = ((cy_top * 32 + cx) * 4) as usize;
        assert_eq!(&rendered[i..i + 3], &BADGE_RED);
    }

    #[test]
    fn caches_renders_by_label_not_raw_count() {
        let mut cache = RenderCache::new();
        let calls = std::cell::Cell::new(0u32);
        let render = |n: u32| {
            calls.set(calls.get() + 1);
            vec![n as u8]
        };
        cache.get_or_render(badge_label(11), || render(11)); // "9+": first time
        cache.get_or_render(badge_label(12), || render(12)); // "9+" again: cached
        assert_eq!(calls.get(), 1);
        cache.get_or_render(badge_label(3), || render(3)); // "3": a new label
        assert_eq!(calls.get(), 2);
        cache.get_or_render(badge_label(0), || render(0)); // None: also a new label
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn close_decision_hides_only_with_a_tray_and_the_setting_both_on() {
        assert_eq!(close_decision(true, true), CloseAction::Hide);
        assert_eq!(close_decision(true, false), CloseAction::Quit);
        assert_eq!(close_decision(false, true), CloseAction::Quit);
        assert_eq!(close_decision(false, false), CloseAction::Quit);
    }

    #[test]
    fn close_to_tray_defaults_to_off() {
        assert!(!CloseToTray::new().get());
    }

    #[test]
    fn tooltip_and_title_text() {
        assert_eq!(tooltip_text(0), "Snowdrop");
        assert_eq!(tooltip_text(3), "Snowdrop — 3 unread");
        assert_eq!(window_title(0), "Snowdrop");
        assert_eq!(window_title(3), "Snowdrop (3)");
    }
}
