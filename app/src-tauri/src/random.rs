//! Randomness from the OS (`/dev/urandom`; yaah runs on macOS and Linux only):
//! session tokens that guard the UI-MCP URLs and previews, and OAuth PKCE secrets.

use std::io::Read;

/// `n` random bytes.
pub fn bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    // Never fails on a working macOS or Linux system; without it nothing here is safe to run.
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).expect("read /dev/urandom");
    buf
}

/// 128 random bits as 32 hex characters.
pub fn token() -> String {
    use std::fmt::Write;
    bytes(16).iter().fold(String::with_capacity(32), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn tokens_are_hex_and_differ() {
        let (a, b) = (super::token(), super::token());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
