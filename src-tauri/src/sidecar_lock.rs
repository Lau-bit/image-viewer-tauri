// Cross-process advisory lock over a categorized root's `.image-categorizer.json`.
//
// That sidecar is a read-modify-write of one JSON document, and TWO separate
// applications perform it: image-categorizer-tauri, which owns the file, and
// image-viewer-tauri's "Move to category". Nothing stopped them interleaving —
// both read the same starting state, both write, and whichever renames last
// silently discards the other's edit. Measured with two viewer windows writing
// at the same instant: one edit landed, the other vanished, with no corruption
// and no error surfaced.
//
// The lock is a separate `.image-categorizer.lock` file held open for exclusive
// access. Windows closes the handle when the owning process dies, so a crash
// mid-edit cannot strand the lock the way a create_new()-style marker file
// would — there is no staleness to detect and no lock to reap.
//
// It FAILS OPEN. If the lock cannot be taken — read-only folder, or a peer
// holding it far longer than any real edit takes — the caller proceeds without
// it, which is exactly the behaviour that existed before. Refusing the user's
// edit outright would be a worse outcome than the rare clobber this prevents.
//
// Both applications must agree on the file name and these semantics: keep this
// module identical in image-viewer-tauri and image-categorizer-tauri.

use std::cell::Cell;
use std::fs::File;
use std::path::Path;

pub const SIDECAR_LOCK_FILE_NAME: &str = ".image-categorizer.lock";

// Generous on purpose. One read-modify-write is a parse plus a re-serialise of
// the whole sidecar, which on a large library is seconds rather than
// milliseconds (measured at 19MB / 32k records), and the categorizer's write is
// followed by a reconcile scan under the same lock. Waiting out a peer is the
// entire point; the timeout exists only so a pathological holder cannot wedge
// the UI indefinitely.
#[cfg(windows)]
const ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
#[cfg(windows)]
const RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(20);
#[cfg(windows)]
const ERROR_SHARING_VIOLATION: i32 = 32;

thread_local! {
    // Re-entrancy guard: a call chain that already holds the lock must not block
    // on itself when a helper it calls locks the same root again.
    static DEPTH: Cell<usize> = const { Cell::new(0) };
}

pub struct SidecarLock {
    file: Option<File>,
    outermost: bool,
}

impl SidecarLock {
    /// Hold until the end of the read-modify-write. Never fails: a lock that
    /// cannot be acquired yields an unlocked guard rather than an error.
    pub fn acquire(root: &Path) -> Self {
        if DEPTH.with(|depth| depth.get()) > 0 {
            return Self { file: None, outermost: false };
        }
        DEPTH.with(|depth| depth.set(1));
        Self {
            file: open_exclusive(&root.join(SIDECAR_LOCK_FILE_NAME)),
            outermost: true,
        }
    }
}

impl Drop for SidecarLock {
    fn drop(&mut self) {
        // Closing the handle is what releases it; the file itself stays behind
        // deliberately, so the next acquire is an open rather than a create.
        self.file.take();
        if self.outermost {
            DEPTH.with(|depth| depth.set(0));
        }
    }
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::time::Instant;

    let deadline = Instant::now() + ACQUIRE_TIMEOUT;
    loop {
        // share_mode(0) is FILE_SHARE_NONE: any other opener, in this process or
        // another, gets ERROR_SHARING_VIOLATION until this handle closes.
        match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .share_mode(0)
            .open(path)
        {
            Ok(file) => return Some(file),
            Err(error) => {
                if error.raw_os_error() != Some(ERROR_SHARING_VIOLATION) {
                    return None;
                }
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
        }
    }
}

#[cfg(not(windows))]
fn open_exclusive(_path: &Path) -> Option<File> {
    None
}
