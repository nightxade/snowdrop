//! Resume positions for the desktop event stream.
//!
//! The HTTP daemon numbers its SSE events and replays them after a
//! reconnect; a `jsonRpc` child on stdin/stdout has nothing like that, and
//! signal-cli acknowledges a message to Signal's servers as soon as it has
//! received it. So the Rust side keeps the events it forwarded until the UI
//! acknowledges them (after its repository write), numbered per process run:
//!
//! - A cursor is `"<run>:<seq>"`. The UI persists the last acknowledged one.
//! - On subscribe the UI hands its cursor back: events after it that are
//!   still held are replayed (a webview reload loses nothing).
//! - A cursor from another run (the app was restarted) matches nothing and is
//!   ignored: whatever that run held is gone, and nothing wrong is replayed.
//!
//! Pure data structure; unit-tested.

use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;

/// Unacknowledged events held at most (the oldest are dropped beyond this).
pub const MAX_HELD: usize = 5_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeldEvent {
    pub cursor: String,
    /// Which subscription it belongs to: the account, or "" for single-account.
    #[serde(skip)]
    pub account: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Value,
}

#[derive(Debug)]
pub struct EventLog {
    run: String,
    next: u64,
    held: VecDeque<(u64, HeldEvent)>,
    max: usize,
}

impl EventLog {
    pub fn new(run: impl Into<String>) -> Self {
        Self::with_capacity(run, MAX_HELD)
    }

    pub fn with_capacity(run: impl Into<String>, max: usize) -> Self {
        Self { run: run.into(), next: 1, held: VecDeque::new(), max: max.max(1) }
    }

    pub fn run(&self) -> &str {
        &self.run
    }

    /// Numbers and holds an event; returns it (with its cursor) for forwarding.
    pub fn push(&mut self, account: &str, kind: &str, data: Value) -> HeldEvent {
        let seq = self.next;
        self.next += 1;
        let event = HeldEvent {
            cursor: format!("{}:{}", self.run, seq),
            account: account.to_owned(),
            kind: kind.to_owned(),
            data,
        };
        self.held.push_back((seq, event.clone()));
        while self.held.len() > self.max {
            self.held.pop_front();
        }
        event
    }

    /// The sequence number of a cursor from *this* run.
    fn seq_of(&self, cursor: &str) -> Option<u64> {
        let (run, seq) = cursor.rsplit_once(':')?;
        if run != self.run {
            return None;
        }
        seq.parse().ok()
    }

    /// Held events of `account` after `cursor` ('' or another run's cursor: none).
    pub fn replay_after(&self, account: &str, cursor: &str) -> Vec<HeldEvent> {
        let Some(after) = self.seq_of(cursor) else { return Vec::new() };
        self.held
            .iter()
            .filter(|(seq, e)| *seq > after && e.account == account)
            .map(|(_, e)| e.clone())
            .collect()
    }

    /// Everything still held for `account` (a fresh subscription with no usable cursor).
    pub fn held_for(&self, account: &str) -> Vec<HeldEvent> {
        self.held.iter().filter(|(_, e)| e.account == account).map(|(_, e)| e.clone()).collect()
    }

    /// The UI stored everything up to `cursor`: stop holding it.
    pub fn acknowledge(&mut self, cursor: &str) {
        if let Some(upto) = self.seq_of(cursor) {
            while self.held.front().is_some_and(|(seq, _)| *seq <= upto) {
                self.held.pop_front();
            }
        }
    }

    pub fn held_count(&self) -> usize {
        self.held.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_events_per_run() {
        let mut log = EventLog::new("r1");
        assert_eq!(log.push("+1", "receive", json!(1)).cursor, "r1:1");
        assert_eq!(log.push("+1", "receive", json!(2)).cursor, "r1:2");
        assert_eq!(log.held_count(), 2);
    }

    #[test]
    fn replays_unacknowledged_events_after_a_cursor() {
        let mut log = EventLog::new("r1");
        for i in 1..=4 {
            log.push("+1", "receive", json!(i));
        }
        log.push("+2", "receive", json!("other account"));
        let replay = log.replay_after("+1", "r1:2");
        assert_eq!(replay.iter().map(|e| e.data.clone()).collect::<Vec<_>>(), vec![json!(3), json!(4)]);
        assert!(log.replay_after("+1", "r1:9").is_empty());
    }

    #[test]
    fn ignores_cursors_from_another_run() {
        let mut log = EventLog::new("r2");
        log.push("+1", "receive", json!(1));
        assert!(log.replay_after("+1", "r1:0").is_empty());
        assert!(log.replay_after("+1", "").is_empty());
        assert!(log.replay_after("+1", "garbage").is_empty());
        log.acknowledge("r1:5");
        assert_eq!(log.held_count(), 1);
        assert_eq!(log.held_for("+1").len(), 1);
    }

    #[test]
    fn acknowledging_releases_events() {
        let mut log = EventLog::new("r1");
        for i in 1..=3 {
            log.push("", "receive", json!(i));
        }
        log.acknowledge("r1:2");
        assert_eq!(log.held_count(), 1);
        assert_eq!(log.held_for("")[0].cursor, "r1:3");
        // Acknowledging again (or out of order) is harmless.
        log.acknowledge("r1:1");
        assert_eq!(log.held_count(), 1);
    }

    #[test]
    fn caps_what_it_holds() {
        let mut log = EventLog::with_capacity("r1", 2);
        for i in 1..=3 {
            log.push("", "receive", json!(i));
        }
        assert_eq!(log.held_count(), 2);
        assert_eq!(log.held_for("")[0].cursor, "r1:2");
    }
}
