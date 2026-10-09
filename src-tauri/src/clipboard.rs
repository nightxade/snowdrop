//! Read native image/file clipboard formats only when the composer requests a paste.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 16;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    name: String,
    content_type: String,
    base64: String,
}

#[cfg(target_os = "linux")]
enum Selection {
    Files(Vec<std::path::PathBuf>),
    Image(Vec<u8>),
    Empty,
}

#[cfg(target_os = "linux")]
fn local_uri(uri: &str) -> Result<std::path::PathBuf, String> {
    let (path, host) = gtk::glib::filename_from_uri(uri)
        .map_err(|_| "Only local files can be pasted.".to_string())?;
    if host.is_some_and(|host| !host.is_empty() && host != "localhost") {
        return Err("Only local files can be pasted.".to_string());
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn gnome_files(bytes: &[u8]) -> Result<Vec<std::path::PathBuf>, String> {
    if bytes.len() > 1024 * 1024 {
        return Err("The copied file list is too large.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid copied file list.".to_string())?;
    let mut lines = text.lines();
    if !matches!(lines.next(), Some("copy" | "cut")) {
        return Err("Invalid copied file operation.".into());
    }
    // Both operations attach a copy. Never remove or move a clipboard source.
    let paths = lines.filter(|line| !line.is_empty()).map(local_uri)
        .take(MAX_FILES + 1).collect::<Result<Vec<_>, _>>()?;
    if paths.len() > MAX_FILES { return Err("Paste up to 16 files at a time.".into()); }
    Ok(paths)
}

#[cfg(target_os = "linux")]
fn request_selection(done: tokio::sync::oneshot::Sender<Result<Selection, String>>) {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard.request_uris(move |clipboard, uris| {
        if !uris.is_empty() {
            let files = uris.iter().map(|uri| local_uri(uri)).collect::<Result<Vec<_>, String>>();
            let _ = done.send(files.map(Selection::Files));
        } else {
            clipboard.request_contents(&gtk::gdk::Atom::intern("x-special/gnome-copied-files"), move |clipboard, data| {
                if data.length() > 1024 * 1024 {
                    let _ = done.send(Err("The copied file list is too large.".into()));
                    return;
                }
                if data.length() > 0 {
                    let _ = done.send(gnome_files(&data.data()).map(Selection::Files));
                    return;
                }
                clipboard.request_image(move |_, image| {
                    let result = match image {
                        Some(image) if i64::from(image.width()) * i64::from(image.height()) > 16_000_000 => {
                            Err("The clipboard image is too large. Save it and attach the file instead.".to_string())
                        }
                        Some(image) => image.save_to_bufferv("png", &[])
                            .map(Selection::Image).map_err(|e| e.to_string()),
                        None => Ok(Selection::Empty),
                    };
                    let _ = done.send(result);
                });
            });
        }
    });
}

fn read_files(paths: Vec<std::path::PathBuf>) -> Result<Vec<ClipboardFile>, String> {
    use std::io::Read;
    if paths.len() > MAX_FILES { return Err("Paste up to 16 files at a time.".into()); }
    let mut remaining = MAX_BYTES;
    let mut result = Vec::new();
    for path in paths {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = options.open(&path).map_err(|_| "Could not open a copied file.".to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err("Folders cannot be pasted. Choose files instead.".into()); }
        if meta.len() > remaining as u64 { return Err("Paste up to 32 MB at a time.".into()); }
        let mut bytes = Vec::new();
        file.take(remaining as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > remaining { return Err("Paste up to 32 MB at a time.".into()); }
        remaining -= bytes.len();
        let name = path.file_name().ok_or("A copied file has no name.")?.to_string_lossy().into_owned();
        // Let GIO identify media from both its filename and content, including extensionless images.
        #[cfg(target_os = "linux")]
        let content_type = {
            let (kind, _) = gtk::gio::content_type_guess(Some(&path), &bytes);
            gtk::gio::content_type_get_mime_type(&kind).unwrap_or_else(|| "application/octet-stream".into()).to_string()
        };
        #[cfg(not(target_os = "linux"))]
        let content_type = "application/octet-stream".to_string();
        result.push(ClipboardFile { name, content_type, base64: STANDARD.encode(bytes) });
    }
    Ok(result)
}

pub async fn read(app: tauri::AppHandle) -> Result<Vec<ClipboardFile>, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || request_selection(send)).map_err(|e| e.to_string())?;
        let selection = tokio::time::timeout(std::time::Duration::from_secs(5), receive).await
            .map_err(|_| "Clipboard did not respond. Try copying again.".to_string())?
            .map_err(|e| e.to_string())??;
        tauri::async_runtime::spawn_blocking(move || match selection {
            Selection::Files(paths) => read_files(paths),
            Selection::Image(bytes) if bytes.len() <= MAX_BYTES => Ok(vec![ClipboardFile {
                name: "pasted-image.png".into(), content_type: "image/png".into(), base64: STANDARD.encode(bytes),
            }]),
            Selection::Image(_) => Err("Paste images up to 32 MB.".into()),
            Selection::Empty => Ok(Vec::new()),
        }).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    { let _ = app; Ok(Vec::new()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn gnome_file_list_requires_local_uris() {
        assert_eq!(gnome_files(b"copy\nfile:///tmp/a%20b.txt\n").unwrap(),
            vec![std::path::PathBuf::from("/tmp/a b.txt")]);
        assert!(gnome_files(b"copy\nfile://remote/tmp/a.txt").is_err());
        assert!(gnome_files(b"copy\nhttps://example.com/a.txt").is_err());
        assert!(gnome_files(b"delete\nfile:///tmp/a.txt").is_err());
    }
    #[test]
    fn copied_files_preserve_names_and_bytes_and_reject_folders() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, b"clipboard test").unwrap();
        let files = read_files(vec![path]).unwrap();
        assert_eq!(files[0].name, "notes.txt");
        assert_eq!(STANDARD.decode(&files[0].base64).unwrap(), b"clipboard test");
        assert!(read_files(vec![dir.path().to_path_buf()]).is_err());
    }
    #[test]
    fn rejects_oversized_files_before_loading_them() {
        let file = tempfile::NamedTempFile::new().unwrap();
        file.as_file().set_len(MAX_BYTES as u64 + 1).unwrap();
        assert!(read_files(vec![file.path().to_path_buf()]).is_err());
        assert!(read_files(vec![file.path().to_path_buf(); MAX_FILES + 1]).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated GTK display; never run against the user's clipboard"]
    fn native_clipboard_roundtrip() {
        gtk::init().unwrap();
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let image = gtk::gdk_pixbuf::Pixbuf::new(gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, 2, 2).unwrap();
        image.fill(0x61bca0ff);
        clipboard.set_image(&image);
        fn receive() -> Selection {
            let (tx, mut rx) = tokio::sync::oneshot::channel();
            request_selection(tx);
            let context = gtk::glib::MainContext::default();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                if let Ok(value) = rx.try_recv() { return value.unwrap(); }
                assert!(std::time::Instant::now() < deadline, "clipboard callback timed out");
                context.iteration(false);
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        match receive() {
            Selection::Image(bytes) => assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n")),
            _ => panic!("expected a clipboard image"),
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a file.txt");
        std::fs::write(&path, b"test").unwrap();
        let uri = gtk::glib::filename_to_uri(&path, None).unwrap();
        clipboard.set_with_data(&[gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0)],
            move |_, data, _| { data.set_uris(&[uri.as_str()]); });
        match receive() {
            Selection::Files(paths) => assert_eq!(paths, vec![path.clone()]),
            _ => panic!("expected clipboard file URIs"),
        }
        for operation in ["copy", "cut"] {
            let uri = gtk::glib::filename_to_uri(&path, None).unwrap();
            let payload = format!("{operation}\n{uri}\n");
            clipboard.set_with_data(&[gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 0)],
                move |_, data, _| {
                    data.set(&gtk::gdk::Atom::intern("x-special/gnome-copied-files"), 8, payload.as_bytes());
                });
            match receive() {
                Selection::Files(paths) => assert_eq!(paths, vec![path.clone()]),
                _ => panic!("expected GNOME copied files"),
            }
            assert!(path.exists(), "pasting a cut file must not delete the original");
        }
        clipboard.set_text("ordinary text");
        assert!(matches!(receive(), Selection::Empty));
    }

}
