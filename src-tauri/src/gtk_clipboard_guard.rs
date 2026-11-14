//! Keeps WebKitGTK 2.54.0 and 2.54.1 from crashing the app on a paste while
//! the clipboard has no owner (the program the text was copied from has
//! exited, say).
//!
//! When GTK 3 can't get the clipboard's targets it calls the
//! `gtk_clipboard_request_targets` callback with no atoms and a count of -1.
//! Those WebKitGTK releases read that count as a huge length over a null
//! pointer (`Clipboard::formats()`, UIProcess/gtk/ClipboardGtk3.cpp) and
//! segfault. Fixed upstream by WebKit bug 324466.
//!
//! The binary exports its own `gtk_clipboard_request_targets` (build.rs puts
//! it in the dynamic symbol table, so WebKit's call resolves here first). It
//! forwards to GTK's real one with a callback in between that turns the
//! failure into "no targets", what older WebKitGTK releases already did with
//! it. Every other call is unchanged. Remove once those releases are gone.

use std::ffi::{c_int, c_void};
use std::sync::OnceLock;

type TargetsCallback = unsafe extern "C" fn(
    clipboard: *mut c_void,
    atoms: *mut *mut c_void,
    n_atoms: c_int,
    data: *mut c_void,
);
type RequestTargets = unsafe extern "C" fn(
    clipboard: *mut c_void,
    callback: Option<TargetsCallback>,
    data: *mut c_void,
);

/// The caller's callback and data, carried through GTK's `user_data`.
struct Pending {
    callback: TargetsCallback,
    data: *mut c_void,
}

/// GTK's own `gtk_clipboard_request_targets`: the next definition after this binary's.
fn real() -> Option<RequestTargets> {
    static REAL: OnceLock<Option<RequestTargets>> = OnceLock::new();
    *REAL.get_or_init(|| {
        // SAFETY: dlsym with RTLD_NEXT and a NUL-terminated name; the symbol, when found, is
        // GTK 3's `gtk_clipboard_request_targets`, whose C signature `RequestTargets` matches.
        unsafe {
            let sym = libc::dlsym(libc::RTLD_NEXT, c"gtk_clipboard_request_targets".as_ptr());
            if sym.is_null() {
                None
            } else {
                Some(std::mem::transmute::<*mut c_void, RequestTargets>(sym))
            }
        }
    })
}

/// A failed request (count below zero) reaches the caller as no targets at all.
unsafe extern "C" fn deliver(
    clipboard: *mut c_void,
    atoms: *mut *mut c_void,
    n_atoms: c_int,
    data: *mut c_void,
) {
    // SAFETY: `data` is the `Pending` boxed in `gtk_clipboard_request_targets` below; GTK
    // calls this exactly once per request, so it is reclaimed exactly once.
    let pending = unsafe { Box::from_raw(data.cast::<Pending>()) };
    let (atoms, n_atoms) = if n_atoms < 0 {
        (std::ptr::null_mut(), 0)
    } else {
        (atoms, n_atoms)
    };
    // SAFETY: the caller's own callback, with its own data, as GTK would have called it.
    unsafe { (pending.callback)(clipboard, atoms, n_atoms, pending.data) };
}

/// # Safety
/// The C contract of GTK 3's `gtk_clipboard_request_targets`.
#[no_mangle]
pub unsafe extern "C" fn gtk_clipboard_request_targets(
    clipboard: *mut c_void,
    callback: Option<TargetsCallback>,
    data: *mut c_void,
) {
    let Some(real) = real() else { return };
    match callback {
        // GTK rejects a missing callback itself; pass it through unchanged.
        None => unsafe { real(clipboard, None, data) },
        Some(callback) => {
            let pending = Box::into_raw(Box::new(Pending { callback, data }));
            // SAFETY: forwarding the caller's arguments to GTK, with `deliver` and its box.
            unsafe { real(clipboard, Some(deliver), pending.cast()) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! {
        static SEEN: Cell<Option<(bool, c_int, usize)>> = const { Cell::new(None) };
    }

    unsafe extern "C" fn record(
        _: *mut c_void,
        atoms: *mut *mut c_void,
        n_atoms: c_int,
        data: *mut c_void,
    ) {
        SEEN.with(|s| s.set(Some((atoms.is_null(), n_atoms, data as usize))));
    }

    fn call(atoms: *mut *mut c_void, n_atoms: c_int) -> (bool, c_int, usize) {
        let pending = Box::into_raw(Box::new(Pending {
            callback: record,
            data: 0x5eed as *mut c_void,
        }));
        unsafe { deliver(std::ptr::null_mut(), atoms, n_atoms, pending.cast()) };
        SEEN.with(|s| s.take()).expect("callback ran")
    }

    #[test]
    fn a_failed_request_reaches_the_caller_as_no_targets() {
        assert_eq!(call(std::ptr::null_mut(), -1), (true, 0, 0x5eed));
    }

    #[test]
    fn a_successful_request_passes_through_unchanged() {
        let mut atoms = [std::ptr::null_mut::<c_void>(); 2];
        let (null, n, data) = call(atoms.as_mut_ptr(), 2);
        assert_eq!((null, n, data), (false, 2, 0x5eed));
    }
}
