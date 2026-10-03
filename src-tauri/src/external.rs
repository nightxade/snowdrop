//! External-daemon mode: a signal-cli HTTP daemon the user runs themselves
//! (`signal-cli daemon --http 127.0.0.1:8080`). The Rust side proxies to it,
//! so the webview never makes cross-origin requests (the daemon sends no CORS
//! headers and checks the Host header). Its SSE event ids are real resume
//! positions: they pass through as cursors (`sse:<id>`) and go back as
//! `Last-Event-ID`.

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::config::DaemonUrl;
use crate::error::{Error, ErrorKind};

pub const CURSOR_PREFIX: &str = "sse:";

#[derive(Clone)]
pub struct ExternalDaemon {
    base: String,
    agent: ureq::Agent,
    next_id: Arc<AtomicU64>,
}

/// Events and stream state from an SSE subscription.
pub enum StreamUpdate {
    Open,
    Event { kind: String, data: Value, cursor: Option<String> },
    /// Disconnected; reconnecting after `delay`.
    Waiting { attempt: u32, delay: Duration, reason: String },
    /// A response retrying can't fix (e.g. 400: unknown account).
    Failed { message: String },
}

impl ExternalDaemon {
    pub fn new(url: &DaemonUrl) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .redirects(0)
            .build();
        Self { base: url.base.clone(), agent, next_id: Arc::new(AtomicU64::new(1)) }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn unreachable(&self, error: impl std::fmt::Display) -> Error {
        Error::new(ErrorKind::Unreachable, format!("Can't reach the signal-cli daemon at {}: {error}", self.base))
    }

    /// `GET /api/v1/check`.
    pub fn check(&self, timeout: Duration) -> Result<(), Error> {
        self.agent
            .get(&format!("{}/api/v1/check", self.base))
            .timeout(timeout)
            .call()
            .map(|_| ())
            .map_err(|e| self.unreachable(e))
    }

    /// `POST /api/v1/rpc`: the reply as `{ result }` / `{ error }`.
    pub fn request(&self, method: &str, params: Option<&Map<String, Value>>, timeout: Duration) -> Result<Value, Error> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut body = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params.filter(|p| !p.is_empty()) {
            body["params"] = Value::Object(params.clone());
        }
        let response = self
            .agent
            .post(&format!("{}/api/v1/rpc", self.base))
            .timeout(timeout)
            .set("Content-Type", "application/json")
            .send_string(&body.to_string());
        let response = match response {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => {
                return Err(Error::new(ErrorKind::Unreachable, format!("The signal-cli daemon answered HTTP {code}.")))
            }
            Err(ureq::Error::Transport(t)) if t.to_string().contains("timed out") => {
                return Err(Error::new(ErrorKind::Timeout, format!("The signal-cli daemon didn't answer {method} in time.")))
            }
            Err(e) => return Err(self.unreachable(e)),
        };
        if response.status() == 201 {
            return Ok(json!({ "result": {} }));
        }
        let text = response
            .into_string()
            .map_err(|e| Error::new(ErrorKind::InvalidResponse, format!("{method}: {e}")))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| Error::new(ErrorKind::InvalidResponse, format!("{method}: the daemon's answer isn't JSON")))?;
        let Value::Object(mut object) = value else {
            return Err(Error::new(ErrorKind::InvalidResponse, format!("{method}: the daemon's answer isn't an object")));
        };
        let mut reply = Map::new();
        if let Some(error) = object.remove("error").filter(|e| !e.is_null()) {
            reply.insert("error".into(), error);
        } else {
            reply.insert("result".into(), object.remove("result").unwrap_or(Value::Null));
        }
        Ok(Value::Object(reply))
    }

    /// Streams `GET /api/v1/events` on a background thread until `stop` is set,
    /// reconnecting with backoff and resuming with `Last-Event-ID`.
    pub fn subscribe(
        &self,
        account: Option<String>,
        resume_from: Option<String>,
        stop: Arc<AtomicBool>,
        on_update: impl Fn(StreamUpdate) + Send + 'static,
    ) {
        let daemon = self.clone();
        std::thread::spawn(move || {
            let query = account.map(|a| format!("?account={}", encode_query(&a))).unwrap_or_default();
            let url = format!("{}/api/v1/events{query}", daemon.base);
            // Keep-alives arrive every 15 s; silence for 45 s means a dead connection.
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(45))
                .redirects(0)
                .build();
            let mut last_id = resume_from;
            let mut attempt: u32 = 0;
            while !stop.load(Ordering::Relaxed) {
                let mut request = agent.get(&url).set("Accept", "text/event-stream");
                if let Some(id) = last_id.as_deref().filter(|id| !id.is_empty()) {
                    request = request.set("Last-Event-ID", id);
                }
                let reason = match request.call() {
                    Ok(response) => {
                        attempt = 0;
                        on_update(StreamUpdate::Open);
                        let mut parser = SseParser::default();
                        let reader = BufReader::new(response.into_reader());
                        for line in reader.lines() {
                            if stop.load(Ordering::Relaxed) {
                                return;
                            }
                            let Ok(line) = line else { break };
                            if let Some(event) = parser.feed_line(&line) {
                                if event.id.is_some() {
                                    last_id = event.id.clone();
                                }
                                let data = serde_json::from_str(&event.data).unwrap_or(Value::String(event.data));
                                on_update(StreamUpdate::Event {
                                    kind: event.kind,
                                    data,
                                    cursor: last_id.as_ref().map(|id| format!("{CURSOR_PREFIX}{id}")),
                                });
                            }
                        }
                        "the event stream ended".to_owned()
                    }
                    Err(ureq::Error::Status(code, _)) if matches!(code, 400 | 401 | 403 | 404 | 405 | 421) => {
                        on_update(StreamUpdate::Failed { message: format!("The daemon refused the event stream (HTTP {code}).") });
                        return;
                    }
                    Err(e) => e.to_string(),
                };
                let delay = Duration::from_millis((1000u64 << attempt.min(5)).min(30_000));
                on_update(StreamUpdate::Waiting { attempt, delay, reason });
                attempt += 1;
                let until = std::time::Instant::now() + delay;
                while std::time::Instant::now() < until {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
    }
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub kind: String,
    pub data: String,
    pub id: Option<String>,
}

/// Line-at-a-time Server-Sent Events parser (enough of the WHATWG rules for signal-cli).
#[derive(Default)]
pub struct SseParser {
    kind: String,
    data: Vec<String>,
    id: Option<String>,
}

impl SseParser {
    pub fn feed_line(&mut self, line: &str) -> Option<SseEvent> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if self.data.is_empty() {
                self.kind.clear();
                return None;
            }
            let event = SseEvent {
                kind: if self.kind.is_empty() { "message".into() } else { std::mem::take(&mut self.kind) },
                data: std::mem::take(&mut self.data).join("\n"),
                id: self.id.clone(),
            };
            return Some(event);
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').map_or((line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
        match field {
            "event" => self.kind = value.to_owned(),
            "data" => self.data.push(value.to_owned()),
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            _ => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signal_cli_events() {
        let mut p = SseParser::default();
        let mut out = Vec::new();
        for line in [":keep-alive", "", "id:41", "event:receive", "data:{\"a\":", "data:1}", "", "id: 42", "data: x", ""] {
            out.extend(p.feed_line(line));
        }
        assert_eq!(
            out,
            vec![
                SseEvent { kind: "receive".into(), data: "{\"a\":\n1}".into(), id: Some("41".into()) },
                SseEvent { kind: "message".into(), data: "x".into(), id: Some("42".into()) },
            ]
        );
    }

    #[test]
    fn encodes_accounts_for_the_query() {
        assert_eq!(encode_query("+4477"), "%2B4477");
        assert_eq!(encode_query("1111-aaaa"), "1111-aaaa");
    }
}
