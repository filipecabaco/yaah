//! The small JSON files yaah keeps in `~/.config/yaah/` (integrations, MCP
//! servers, database connections, settings): read whole, written atomically (a
//! fresh temp file renamed over the old one), with a lock around each
//! read-modify-write. Files that may hold secrets are created 0600.
//!
//! Reads are cached in memory while the file is unchanged on disk (its
//! [`Stamp`]): hot paths (a token per API call, connections per live poll)
//! cost a `stat` instead of a read and parse. Any write, ours or another
//! program's, changes the stamp.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

/// What a file looks like on disk. An atomic replace (a new inode) or any write
/// (a new time or size) changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
    ino: u64,
}

impl Stamp {
    /// The file's stamp now; `None` if it can't be read.
    pub fn of(path: &Path) -> Option<Self> {
        std::fs::metadata(path).ok().map(|m| Self { modified: m.modified().ok(), len: m.len(), ino: m.ino() })
    }
}

pub struct JsonFile {
    path: PathBuf,
    /// 0600 rather than the umask's default: tokens, passwords, MCP env and headers.
    private: bool,
    /// Serialises read-modify-write within the app, and guards the cache.
    lock: Mutex<Option<(Stamp, Value)>>,
}

impl JsonFile {
    pub fn new(path: PathBuf, private: bool) -> Self {
        Self { path, private, lock: Mutex::new(None) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn guard(&self) -> MutexGuard<'_, Option<(Stamp, Value)>> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The contents; a missing or unreadable file reads as the default.
    pub fn read<T: DeserializeOwned + Default>(&self) -> T {
        let mut cache = self.guard();
        self.cached(&mut cache)
    }

    /// The contents through the cache (held under the lock).
    fn cached<T: DeserializeOwned + Default>(&self, cache: &mut Option<(Stamp, Value)>) -> T {
        let Some(stamp) = Stamp::of(&self.path) else {
            *cache = None;
            return T::default();
        };
        if cache.as_ref().is_none_or(|(s, _)| *s != stamp) {
            *cache = Some((stamp, read::<Value>(&self.path)));
        }
        let value = cache.as_ref().map_or(&Value::Null, |(_, v)| v);
        if value.is_null() {
            return T::default();
        }
        T::deserialize(value).unwrap_or_else(|e| {
            eprintln!("[config] {} is unreadable, ignoring it: {e}", self.path.display());
            T::default()
        })
    }

    /// Change the contents under the lock and save them. Nothing is written if `f` fails.
    pub fn update<T, R>(&self, f: impl FnOnce(&mut T) -> Result<R, String>) -> Result<R, String>
    where
        T: DeserializeOwned + Serialize + Default,
    {
        let mut cache = self.guard();
        let mut value: T = self.cached(&mut cache);
        let out = f(&mut value)?;
        write(&self.path, &value, self.private)?;
        // What was just written, as of the stamp it left.
        *cache = Stamp::of(&self.path).zip(serde_json::to_value(&value).ok());
        Ok(out)
    }
}

fn read<T: DeserializeOwned + Default>(path: &Path) -> T {
    match std::fs::read_to_string(path) {
        // serde_json's message has a position, never the file's contents (which may be secret).
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            eprintln!("[config] {} is unreadable, ignoring it: {e}", path.display());
            T::default()
        }),
        Err(_) => T::default(),
    }
}

/// Write `value` as pretty JSON to `path`, atomically. The temp file is created
/// fresh (never following a planted link, never keeping an old file's mode).
pub fn write<T: Serialize + ?Sized>(path: &Path, value: &T, private: bool) -> Result<(), String> {
    let fail = |e: &dyn std::fmt::Display| format!("couldn't save {}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| fail(&e))?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| fail(&e))?;
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let _ = std::fs::remove_file(&tmp);
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(if private { 0o600 } else { 0o644 })
        .open(&tmp)
        .and_then(|mut f| f.write_all(&json).and_then(|()| f.sync_all()))
        .and_then(|()| std::fs::rename(&tmp, path));
    written.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        fail(&e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Map, Value, json};
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yaah-json-{}", crate::session::random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn private_files_are_0600_and_replaced_atomically() {
        let dir = temp_dir();
        let file = JsonFile::new(dir.join("nested/secrets.json"), true);
        assert_eq!(file.read::<Map<String, Value>>(), Map::new(), "missing reads as empty");
        file.update(|m: &mut Map<String, Value>| {
            m.insert("token".into(), json!("t1"));
            Ok(())
        })
        .unwrap();
        assert_eq!(mode(file.path()), 0o600);

        // A world-readable leftover temp file (or one an old version wrote) doesn't widen the result.
        let tmp = dir.join("nested/secrets.json.tmp");
        std::fs::write(&tmp, "junk").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o666)).unwrap();
        file.update(|m: &mut Map<String, Value>| {
            m.insert("token".into(), json!("t2"));
            Ok(())
        })
        .unwrap();
        assert_eq!(mode(file.path()), 0o600);
        assert!(!tmp.exists());
        assert_eq!(file.read::<Map<String, Value>>()["token"], "t2");

        // A failed change writes nothing.
        let err = file.update(|_: &mut Map<String, Value>| Err::<(), _>("no".into())).unwrap_err();
        assert_eq!(err, "no");
        assert_eq!(file.read::<Map<String, Value>>()["token"], "t2");

        let public = JsonFile::new(dir.join("settings.json"), false);
        public.update(|m: &mut Map<String, Value>| Ok(m.insert("a".into(), json!(1)))).unwrap();
        assert_eq!(mode(public.path()) & 0o600, 0o600);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_files_read_as_default_and_writes_explain_failures() {
        let dir = temp_dir();
        let file = JsonFile::new(dir.join("bad.json"), true);
        std::fs::write(file.path(), "{ not json").unwrap();
        assert!(file.read::<Map<String, Value>>().is_empty());
        // The parent is a file: saving can't work, and says where.
        let blocked = JsonFile::new(dir.join("bad.json/x.json"), true);
        let err = blocked
            .update(|m: &mut Map<String, Value>| {
                m.clear();
                Ok(())
            })
            .unwrap_err();
        assert!(err.starts_with("couldn't save") && err.contains("x.json"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[derive(serde::Deserialize, Default)]
    struct Typed {
        t: String,
    }

    /// Reads come from memory while the file is unchanged, and see any change made to it.
    #[test]
    fn reads_are_cached_until_the_file_changes() {
        let dir = temp_dir();
        let file = JsonFile::new(dir.join("tokens.json"), true);
        file.update(|m: &mut Map<String, Value>| Ok(m.insert("t".into(), json!("one")))).unwrap();
        assert_eq!(file.read::<Map<String, Value>>()["t"], "one");
        // Unreadable but unchanged: the cached contents (no read happens).
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        assert_eq!(file.read::<Map<String, Value>>()["t"], "one", "served from memory");
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        // Another program rewrites it, same size: seen at once.
        std::fs::write(file.path(), r#"{"t":"two"}"#).unwrap();
        let other = file.path().with_file_name("other.json");
        std::fs::write(&other, r#"{"t":"six"}"#).unwrap();
        std::fs::rename(&other, file.path()).unwrap();
        assert_eq!(file.read::<Map<String, Value>>()["t"], "six", "a replaced file is read again");
        // Our own write updates the cache.
        file.update(|m: &mut Map<String, Value>| Ok(m.insert("t".into(), json!("three")))).unwrap();
        assert_eq!(file.read::<Map<String, Value>>()["t"], "three");
        // Typed reads go through the same cache.
        assert_eq!(file.read::<Typed>().t, "three");
        std::fs::remove_file(file.path()).unwrap();
        assert!(file.read::<Map<String, Value>>().is_empty(), "deleted: the default again");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_updates_are_not_lost() {
        let dir = temp_dir();
        let file = std::sync::Arc::new(JsonFile::new(dir.join("count.json"), true));
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let file = file.clone();
                std::thread::spawn(move || {
                    file.update(|m: &mut Map<String, Value>| {
                        m.insert(format!("k{i}"), json!(i));
                        Ok(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(file.read::<Map<String, Value>>().len(), 8);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
