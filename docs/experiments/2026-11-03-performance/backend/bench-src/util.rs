//! Scratch-only measurement helpers: a counting allocator and result reporting.
#![allow(clippy::all, clippy::pedantic, dead_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

pub struct Counting;
pub static ALLOCS: AtomicU64 = AtomicU64::new(0);
pub static BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        BYTES.fetch_add(l.size() as u64, Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        BYTES.fetch_add(n as u64, Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

pub fn allocs() -> (u64, u64) {
    (ALLOCS.load(Relaxed), BYTES.load(Relaxed))
}

/// Print a result line and append it to $PERF_OUT (TSV: area, metric, value, unit, note).
pub fn report(area: &str, metric: &str, value: f64, unit: &str, note: &str) {
    let line = format!("{area}\t{metric}\t{value:.3}\t{unit}\t{note}");
    println!("RESULT\t{line}");
    if let Ok(path) = std::env::var("PERF_OUT") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub struct Stats {
    pub mean: f64,
    pub p50: f64,
    pub p99: f64,
    pub max: f64,
    pub n: usize,
}

/// Microseconds of each sample.
pub fn stats(mut us: Vec<f64>) -> Stats {
    us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = us.len().max(1);
    let mean = us.iter().sum::<f64>() / n as f64;
    let at = |q: f64| us.get(((n as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0.0);
    Stats { mean, p50: at(0.5), p99: at(0.99), max: us.last().copied().unwrap_or(0.0), n: us.len() }
}

/// Run `f` `iters` times (after `warm` warm-ups) and return per-call stats in µs.
pub fn bench(warm: usize, iters: usize, mut f: impl FnMut()) -> Stats {
    for _ in 0..warm {
        f();
    }
    let mut v = Vec::with_capacity(iters);
    for _ in 0..iters {
        let t = Instant::now();
        f();
        v.push(t.elapsed().as_secs_f64() * 1e6);
    }
    stats(v)
}

pub fn us(d: Duration) -> f64 {
    d.as_secs_f64() * 1e6
}

pub fn report_stats(area: &str, metric: &str, s: &Stats, note: &str) {
    report(area, &format!("{metric} mean"), s.mean, "us", note);
    report(area, &format!("{metric} p50"), s.p50, "us", note);
    report(area, &format!("{metric} p99"), s.p99, "us", note);
}

pub fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("yaah-perf-{tag}-{}", crate::random::token()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A string of `n` chars of prose-like text.
pub fn prose(n: usize) -> String {
    let base = "The quick brown fox jumps over the lazy dog; `code` and **bold** text, then a newline.\n";
    base.chars().cycle().take(n).collect()
}
