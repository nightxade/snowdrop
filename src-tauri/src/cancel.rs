//! Caller-side cancellation of in-flight `signal_cli_request`s.
//!
//! The UI names a request with a short `cancel_id` and can later call
//! `signal_cli_cancel` with it. The request then stops waiting and fails with
//! [`ErrorKind::Aborted`]; dropping its future is what releases the pending
//! entry in `process.rs`. A cancel is the user's own decision about one call,
//! so it never asks the supervisor to give up on signal-cli (that is the
//! hang fallback, for a primary that doesn't answer).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use crate::error::{Error, ErrorKind};

/// Longest accepted `cancel_id`.
const MAX_ID_LEN: usize = 64;

/// A `cancel_id` is a short client-chosen token: ASCII letters, digits, `-`, `_`, `.`.
pub fn validate_cancel_id(id: &str) -> Result<(), Error> {
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if ok {
        Ok(())
    } else {
        Err(Error::new(ErrorKind::Config, "The request's cancel id isn't valid."))
    }
}

type Entries = Mutex<HashMap<String, oneshot::Sender<()>>>;

/// `cancel_id` → the handle that stops that request.
#[derive(Default)]
pub struct CancelRegistry {
    entries: Arc<Entries>,
}

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `id`, validated, for the life of the returned guard. An id
    /// that is already in flight is refused, so one cancel can't hit two requests.
    pub fn register(&self, id: &str) -> Result<CancelGuard, Error> {
        validate_cancel_id(id)?;
        let (tx, rx) = oneshot::channel();
        let mut entries = self.entries.lock().expect("cancel registry lock");
        if entries.contains_key(id) {
            return Err(Error::new(ErrorKind::Config, "A request with this cancel id is already in flight."));
        }
        entries.insert(id.to_owned(), tx);
        drop(entries);
        Ok(CancelGuard { entries: self.entries.clone(), id: id.to_owned(), rx: Some(rx) })
    }

    /// Cancels the request registered under `id`. A no-op for an id that is
    /// unknown (never registered, or already finished).
    pub fn cancel(&self, id: &str) {
        let tx = self.entries.lock().expect("cancel registry lock").remove(id);
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
    }

    /// Requests that can still be cancelled (for tests).
    pub fn len(&self) -> usize {
        self.entries.lock().expect("cancel registry lock").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Holds one registration; dropping it (answer, error, timeout, cancel, or
/// the future being dropped) removes the entry.
pub struct CancelGuard {
    entries: Arc<Entries>,
    id: String,
    rx: Option<oneshot::Receiver<()>>,
}

impl CancelGuard {
    /// Runs `work`, giving up with [`ErrorKind::Aborted`] if the id is cancelled first.
    pub async fn run<T>(mut self, work: impl Future<Output = Result<T, Error>>) -> Result<T, Error> {
        let rx = self.rx.take().expect("cancel receiver taken once");
        tokio::select! {
            result = work => result,
            // A closed channel without a send can't happen while the guard is
            // alive (it owns the registry entry's only other half until drop).
            Ok(()) = rx => Err(Error::new(ErrorKind::Aborted, "The request was cancelled.")),
        }
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.entries.lock().expect("cancel registry lock").remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn accepts_short_safe_ids_and_rejects_the_rest() {
        for ok in ["a", "7-k3j9x2", "req_1.2", &"x".repeat(MAX_ID_LEN)] {
            assert!(validate_cancel_id(ok).is_ok(), "{ok}");
        }
        for bad in ["", "has space", "a/b", "é", "a\n", &"x".repeat(MAX_ID_LEN + 1)] {
            assert_eq!(validate_cancel_id(bad).unwrap_err().kind, ErrorKind::Config, "{bad:?}");
        }
    }

    #[test]
    fn register_rejects_an_invalid_or_duplicate_id() {
        let registry = CancelRegistry::new();
        assert!(registry.register("bad id").is_err());
        let _held = registry.register("one").unwrap();
        assert_eq!(registry.register("one").err().unwrap().kind, ErrorKind::Config);
        assert_eq!(registry.len(), 1);
    }

    #[tokio::test]
    async fn cancel_stops_the_work_with_aborted_and_empties_the_registry() {
        let registry = Arc::new(CancelRegistry::new());
        let guard = registry.register("c1").unwrap();
        let task = tokio::spawn(guard.run(std::future::pending::<Result<(), Error>>()));
        while registry.is_empty() {
            tokio::task::yield_now().await;
        }
        registry.cancel("c1");
        let result = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err().kind, ErrorKind::Aborted);
        assert!(registry.is_empty());
    }

    #[test]
    fn cancelling_an_unknown_id_is_a_no_op() {
        let registry = CancelRegistry::new();
        registry.cancel("nobody");
        let _held = registry.register("other").unwrap();
        registry.cancel("nobody");
        assert_eq!(registry.len(), 1);
    }

    #[tokio::test]
    async fn the_registry_is_empty_after_an_answer_and_after_an_error() {
        let registry = CancelRegistry::new();
        let answered = registry.register("a").unwrap().run(async { Ok::<_, Error>(5) }).await;
        assert_eq!(answered.unwrap(), 5);
        assert!(registry.is_empty());
        let failed = registry
            .register("b")
            .unwrap()
            .run(async { Err::<(), _>(Error::new(ErrorKind::Timeout, "slow")) })
            .await;
        assert_eq!(failed.unwrap_err().kind, ErrorKind::Timeout);
        assert!(registry.is_empty());
        // The id can be used again once its request is done.
        assert!(registry.register("a").is_ok());
    }

    #[tokio::test]
    async fn a_dropped_request_future_releases_its_entry() {
        let registry = CancelRegistry::new();
        let run = registry.register("d").unwrap().run(std::future::pending::<Result<(), Error>>());
        assert_eq!(registry.len(), 1);
        drop(run);
        assert!(registry.is_empty());
    }
}
