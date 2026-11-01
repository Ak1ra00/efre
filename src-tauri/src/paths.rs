//! Where the vault lives: `%LOCALAPPDATA%\efre\vault.efre` (ARCHITECTURE §7).
//!
//! The folder is created if it is missing. efre refuses to use it if it is a reparse
//! point (junction or symbolic link), so the vault can't be redirected to another
//! drive, a network share or a synced folder. efre-core separately refuses a vault
//! *file* that is a symbolic link.

use std::fmt;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};

/// The vault file name. A `dev-mock` build uses its own file, so a vault enrolled
/// with simulated keys never takes the place of the real one.
#[cfg(not(feature = "dev-mock"))]
const VAULT_FILE: &str = "vault.efre";
#[cfg(feature = "dev-mock")]
const VAULT_FILE: &str = "vault.dev-mock.efre";

const APP_DIR: &str = "efre";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VaultPaths {
    /// `%LOCALAPPDATA%\efre`
    pub(crate) dir: PathBuf,
    /// `%LOCALAPPDATA%\efre\vault.efre`
    pub(crate) vault: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PathError {
    /// The OS did not report a local app data folder.
    NoLocalAppData,
    /// `%LOCALAPPDATA%\efre` is a junction or symbolic link.
    Link(PathBuf),
    /// `%LOCALAPPDATA%\efre` exists but is not a folder.
    NotAFolder(PathBuf),
    /// The folder could not be created or inspected.
    Io(PathBuf, io::ErrorKind),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoLocalAppData => f.write_str(
                "Windows did not report a local app data folder, so efre has nowhere to keep \
                 the vault.",
            ),
            Self::Link(dir) => write!(
                f,
                "{} is a link (junction or symbolic link). efre keeps the vault only in a real \
                 folder on this PC. Replace the link with a normal folder and restart efre.",
                dir.display()
            ),
            Self::NotAFolder(dir) => write!(
                f,
                "{} exists but is not a folder. Move it away and restart efre.",
                dir.display()
            ),
            Self::Io(dir, kind) => write!(
                f,
                "efre could not use its folder {} ({kind}).",
                dir.display()
            ),
        }
    }
}

/// True if `meta` (from `symlink_metadata`) describes a link of any kind.
#[cfg(windows)]
pub(crate) fn is_link(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    /// `FILE_ATTRIBUTE_REPARSE_POINT`: junctions, symbolic links, mount points and
    /// cloud placeholders all carry it.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// True if `meta` (from `symlink_metadata`) describes a link of any kind.
#[cfg(not(windows))]
pub(crate) fn is_link(meta: &Metadata) -> bool {
    meta.file_type().is_symlink()
}

fn check_folder(dir: &Path, meta: &Metadata) -> Result<(), PathError> {
    if is_link(meta) {
        return Err(PathError::Link(dir.to_owned()));
    }
    if !meta.is_dir() {
        return Err(PathError::NotAFolder(dir.to_owned()));
    }
    Ok(())
}

/// Resolves (and if needed creates) efre's folder inside `local_app_data`.
pub(crate) fn prepare(local_app_data: &Path) -> Result<VaultPaths, PathError> {
    let dir = local_app_data.join(APP_DIR);
    let io_error = |e: io::Error| PathError::Io(dir.clone(), e.kind());
    match fs::symlink_metadata(&dir) {
        Ok(meta) => check_folder(&dir, &meta)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // Not `create_dir_all`: the local app data folder itself must exist.
            match fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io_error(e)),
            }
            // Check what is there now, not what we think we created.
            let meta = fs::symlink_metadata(&dir).map_err(io_error)?;
            check_folder(&dir, &meta)?;
        }
        Err(e) => return Err(io_error(e)),
    }
    Ok(VaultPaths {
        vault: dir.join(VAULT_FILE),
        dir,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    /// A unique temporary directory, removed on drop.
    pub(crate) struct TempDir(PathBuf);

    impl TempDir {
        pub(crate) fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let dir = std::env::temp_dir().join(format!(
                "efre-app-test-{}-{nanos}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        pub(crate) fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_the_folder_when_missing() {
        let tmp = TempDir::new();
        let paths = prepare(tmp.path()).expect("prepared");
        assert_eq!(paths.dir, tmp.path().join("efre"));
        assert_eq!(paths.vault, tmp.path().join("efre").join(VAULT_FILE));
        assert!(paths.dir.is_dir());
        // Idempotent.
        assert_eq!(prepare(tmp.path()).expect("prepared again"), paths);
    }

    #[test]
    fn missing_local_app_data_is_an_error() {
        let tmp = TempDir::new();
        let missing = tmp.path().join("nope");
        assert!(matches!(
            prepare(&missing),
            Err(PathError::Io(_, io::ErrorKind::NotFound))
        ));
        assert!(!missing.exists(), "parents are never created");
    }

    #[test]
    fn a_file_in_place_of_the_folder_is_refused() {
        let tmp = TempDir::new();
        fs::write(tmp.path().join("efre"), b"not a folder").expect("write");
        assert_eq!(
            prepare(tmp.path()),
            Err(PathError::NotAFolder(tmp.path().join("efre")))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_folder_is_refused() {
        let tmp = TempDir::new();
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir(&elsewhere).expect("dir");
        std::os::unix::fs::symlink(&elsewhere, tmp.path().join("efre")).expect("symlink");
        let error = prepare(tmp.path()).expect_err("refused");
        assert_eq!(error, PathError::Link(tmp.path().join("efre")));
        assert!(error.to_string().contains("is a link"), "{error}");
        // A dangling link is refused too, and never replaced by a new folder.
        fs::remove_dir(&elsewhere).expect("remove target");
        assert_eq!(
            prepare(tmp.path()),
            Err(PathError::Link(tmp.path().join("efre")))
        );
    }

    #[test]
    fn messages_name_the_folder() {
        let dir = PathBuf::from("X").join("efre");
        assert!(
            PathError::NotAFolder(dir.clone())
                .to_string()
                .contains(&dir.display().to_string())
        );
        assert!(
            PathError::Io(dir, io::ErrorKind::PermissionDenied)
                .to_string()
                .contains("permission denied")
        );
    }
}
