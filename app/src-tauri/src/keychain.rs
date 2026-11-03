//! Secrets in the OS keychain: macOS Keychain, the Secret Service on Linux
//! (GNOME Keyring, KWallet), through the `keyring` crate.
//!
//! Everything goes through the [`Keychain`] trait, so the stores that use it
//! can be handed an in-memory one. Under `cfg(test)` [`system`] *is* the
//! in-memory one: no unit test ever reads or writes the real keychain (the one
//! test that does is `#[ignore]`d and builds an [`OsKeychain`] itself).
//!
//! A keychain that can't be reached (no Secret Service on a headless Linux box)
//! is an error that says so. There is no fallback to a plain-text file.

use std::fmt;
use std::sync::Arc;

/// yaah's keychain service name; entries are told apart by their account.
pub const SERVICE: &str = "dev.yaah.app";

/// A secret held in memory: never printed (its `Debug` is redacted), never
/// serialized, cleared on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    /// The secret itself. Only for handing it to the one place that needs it
    /// (a request header, a child process's environment).
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

/// Read from the UI (a key pasted into a form). There is deliberately no `Serialize`.
impl<'de> serde::Deserialize<'de> for SecretString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(Self)
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        bytes.fill(0);
        std::hint::black_box(&bytes);
    }
}

/// Where secrets are kept, by account name (within [`SERVICE`]).
pub trait Keychain: Send + Sync {
    /// The secret, or `None` when there is none.
    fn get(&self, account: &str) -> Result<Option<SecretString>, String>;
    fn set(&self, account: &str, secret: &SecretString) -> Result<(), String>;
    /// Removing a secret that isn't there succeeds.
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The keychain the app uses: the OS one, except in unit tests (an in-memory one).
pub fn system() -> Arc<dyn Keychain> {
    #[cfg(not(test))]
    return Arc::new(OsKeychain::new(SERVICE));
    #[cfg(test)]
    return Arc::new(Memory::default());
}

/// The OS keychain.
pub struct OsKeychain {
    service: String,
}

impl OsKeychain {
    pub fn new(service: &str) -> Self {
        Self { service: service.to_owned() }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account).map_err(|e| unreachable_keychain(&e))
    }
}

/// An error in words, without anything from the stored data (some `keyring`
/// errors carry the raw bytes they couldn't decode).
fn unreachable_keychain(e: &keyring::Error) -> String {
    use keyring::Error as E;
    let why = match e {
        E::NoDefaultStore | E::PlatformFailure(_) | E::NoStorageAccess(_) => format!("{e}"),
        E::BadEncoding(_) | E::BadDataFormat(..) => "the stored secret isn't readable".to_owned(),
        E::Ambiguous(items) => format!("{} entries match", items.len()),
        other => format!("{other}"),
    };
    let hint = if cfg!(target_os = "linux") { " On Linux yaah needs a Secret Service (GNOME Keyring, KWallet) running and unlocked." } else { "" };
    format!("Couldn't use the system keychain: {why}.{hint} The secret was not saved anywhere else.")
}

impl Keychain for OsKeychain {
    fn get(&self, account: &str) -> Result<Option<SecretString>, String> {
        match self.entry(account)?.get_password() {
            Ok(s) => Ok(Some(SecretString(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(unreachable_keychain(&e)),
        }
    }

    fn set(&self, account: &str, secret: &SecretString) -> Result<(), String> {
        self.entry(account)?.set_password(secret.expose()).map_err(|e| unreachable_keychain(&e))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(unreachable_keychain(&e)),
        }
    }
}

/// A keychain in memory, for tests. `failing` makes every call fail the way an
/// unreachable Secret Service does.
#[cfg(test)]
#[derive(Default)]
pub struct Memory {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
    pub failing: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl Memory {
    fn check(&self) -> Result<(), String> {
        if self.failing.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("Couldn't use the system keychain: no Secret Service. The secret was not saved anywhere else.".into());
        }
        Ok(())
    }

    pub fn accounts(&self) -> Vec<String> {
        let mut v: Vec<String> = self.entries.lock().unwrap().keys().cloned().collect();
        v.sort();
        v
    }
}

#[cfg(test)]
impl Keychain for Memory {
    fn get(&self, account: &str) -> Result<Option<SecretString>, String> {
        self.check()?;
        Ok(self.entries.lock().unwrap().get(account).cloned().map(SecretString))
    }

    fn set(&self, account: &str, secret: &SecretString) -> Result<(), String> {
        self.check()?;
        self.entries.lock().unwrap().insert(account.to_owned(), secret.expose().to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.check()?;
        self.entries.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_print() {
        let s = SecretString::new("sk-or-v1-very-secret");
        assert_eq!(format!("{s:?}"), "SecretString(<redacted>)");
        assert_eq!(format!("{:?}", Some(s.clone())), "Some(SecretString(<redacted>))");
        assert_eq!(s.expose(), "sk-or-v1-very-secret");
    }

    #[test]
    fn the_test_keychain_is_in_memory() {
        let k = system();
        assert_eq!(k.get("provider:x").unwrap(), None);
        k.set("provider:x", &SecretString::new("v")).unwrap();
        assert_eq!(k.get("provider:x").unwrap().map(|s| s.expose().to_owned()).as_deref(), Some("v"));
        k.delete("provider:x").unwrap();
        k.delete("provider:x").unwrap();
        assert_eq!(k.get("provider:x").unwrap(), None);
        // A fresh one each time: nothing is shared between tests.
        k.set("provider:y", &SecretString::new("v")).unwrap();
        assert_eq!(system().get("provider:y").unwrap(), None);
    }

    /// The real keychain, under a service of its own. Run by hand:
    /// `cargo test --lib keychain::tests::os_keychain_round_trip -- --ignored`
    /// (macOS may ask to allow access; Linux needs a Secret Service).
    #[test]
    #[ignore = "touches the real OS keychain"]
    fn os_keychain_round_trip() {
        let k = OsKeychain::new("dev.yaah.app.test");
        let account = format!("provider:test-{}", crate::random::token());
        assert_eq!(k.get(&account).unwrap(), None);
        k.set(&account, &SecretString::new("sk-or-v1-test")).unwrap();
        assert_eq!(k.get(&account).unwrap().map(|s| s.expose().to_owned()).as_deref(), Some("sk-or-v1-test"));
        k.set(&account, &SecretString::new("sk-or-v1-again")).unwrap();
        assert_eq!(k.get(&account).unwrap().map(|s| s.expose().to_owned()).as_deref(), Some("sk-or-v1-again"));
        k.delete(&account).unwrap();
        k.delete(&account).unwrap();
        assert_eq!(k.get(&account).unwrap(), None);
    }
}
