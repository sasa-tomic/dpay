//! Injectable clock — lets tests pin `now` (matching the canister, which divides
//! `ic_cdk::api::time()` ns down to seconds).

/// A clock returning unix seconds. Injectable so tests can pin `now` (matching the canister,
/// which divides `ic_cdk::api::time()` ns down to seconds).
pub trait Clock: Send + Sync {
    fn now_secs(&self) -> u64;
}

/// Real wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A clock pinned to a fixed instant (tests / deterministic demos).
pub struct FixedClock(pub u64);

impl Clock for FixedClock {
    fn now_secs(&self) -> u64 {
        self.0
    }
}
