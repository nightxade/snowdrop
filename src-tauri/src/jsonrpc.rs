//! JSON-RPC 2.0 framing for `signal-cli jsonRpc`: one JSON object per line
//! on stdin (requests) and stdout (responses and notifications).
//!
//! Pure functions: no I/O, so the framing is unit-tested on its own.

use serde_json::{json, Map, Value};

/// A line read from signal-cli's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// The answer to one of our requests (`result` or `error`), id stripped.
    Response { id: u64, reply: Value },
    /// A notification, e.g. `receive` with the subscription's envelope.
    Notification { method: String, params: Value },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Not JSON, or JSON that isn't an object.
    NotAnObject,
    /// A response whose id isn't one of ours (we only send numeric ids).
    ForeignId(String),
    /// Neither a response nor a notification.
    Unrecognised,
}

/// Builds one request line (with the trailing newline signal-cli expects).
pub fn request_line(id: u64, method: &str, params: Option<&Map<String, Value>>) -> String {
    let mut request = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    if let Some(params) = params.filter(|p| !p.is_empty()) {
        request["params"] = Value::Object(params.clone());
    }
    let mut line = request.to_string();
    line.push('\n');
    line
}

/// Parses one line of signal-cli output. Blank lines are the caller's to skip.
pub fn parse_line(line: &str) -> Result<Incoming, FrameError> {
    let value: Value = serde_json::from_str(line.trim()).map_err(|_| FrameError::NotAnObject)?;
    let Value::Object(mut object) = value else {
        return Err(FrameError::NotAnObject);
    };
    if let Some(Value::String(method)) = object.get("method").cloned() {
        if !object.contains_key("id") || object.get("id") == Some(&Value::Null) {
            let params = object.remove("params").unwrap_or(Value::Null);
            return Ok(Incoming::Notification { method, params });
        }
    }
    if object.contains_key("result") || object.contains_key("error") {
        let id = match object.get("id") {
            Some(Value::Number(n)) => n.as_u64().ok_or_else(|| FrameError::ForeignId(n.to_string()))?,
            Some(other) => return Err(FrameError::ForeignId(other.to_string())),
            None => return Err(FrameError::ForeignId("none".into())),
        };
        let mut reply = Map::new();
        if let Some(error) = object.remove("error").filter(|e| !e.is_null()) {
            reply.insert("error".into(), error);
        } else {
            reply.insert("result".into(), object.remove("result").unwrap_or(Value::Null));
        }
        return Ok(Incoming::Response { id, reply: Value::Object(reply) });
    }
    Err(FrameError::Unrecognised)
}

/// A JSON-RPC error reply in the shape the UI expects (`{ error: { code, message } }`).
pub fn error_reply(code: i64, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message, "data": null } })
}

/// The payload of a `receive` notification: subscriptions (`--receive-mode=manual`)
/// wrap the envelope in `{ subscription, result }`; automatic receiving doesn't.
pub fn receive_payload(params: Value) -> Value {
    match params {
        Value::Object(mut object) if object.contains_key("subscription") && object.contains_key("result") => {
            object.remove("result").unwrap_or(Value::Null)
        }
        other => other,
    }
}

/// The account a receive payload belongs to (multi-account mode labels every event).
pub fn payload_account(payload: &Value) -> Option<&str> {
    payload.get("account").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_request_lines() {
        assert_eq!(
            request_line(7, "listAccounts", None),
            "{\"id\":7,\"jsonrpc\":\"2.0\",\"method\":\"listAccounts\"}\n"
        );
        let mut params = Map::new();
        params.insert("account".into(), json!("+15550001"));
        let line = request_line(8, "listGroups", Some(&params));
        let parsed: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(parsed["params"]["account"], "+15550001");
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        // Empty params are left out, like the HTTP transport does.
        assert!(!request_line(9, "version", Some(&Map::new())).contains("params"));
    }

    #[test]
    fn parses_results_and_errors() {
        assert_eq!(
            parse_line("{\"jsonrpc\":\"2.0\",\"result\":[],\"id\":1}").unwrap(),
            Incoming::Response { id: 1, reply: json!({ "result": [] }) }
        );
        // Real signal-cli 0.14.8 output for an unknown method.
        let line = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not implemented\",\"data\":null},\"id\":3}";
        let Incoming::Response { id, reply } = parse_line(line).unwrap() else { panic!() };
        assert_eq!(id, 3);
        assert_eq!(reply["error"]["code"], -32601);
        assert!(reply.get("result").is_none());
        // A null result is still a result (sendTyping and friends).
        assert_eq!(
            parse_line("{\"jsonrpc\":\"2.0\",\"result\":null,\"id\":4}").unwrap(),
            Incoming::Response { id: 4, reply: json!({ "result": null }) }
        );
    }

    #[test]
    fn parses_notifications() {
        let line = r#"{"jsonrpc":"2.0","method":"receive","params":{"subscription":0,"result":{"envelope":{"source":"+1"},"account":"+2"}}}"#;
        let Incoming::Notification { method, params } = parse_line(line).unwrap() else { panic!() };
        assert_eq!(method, "receive");
        let payload = receive_payload(params);
        assert_eq!(payload["envelope"]["source"], "+1");
        assert_eq!(payload_account(&payload), Some("+2"));
        // Automatic receive mode: no wrapper.
        let auto = receive_payload(json!({ "envelope": { "source": "+3" } }));
        assert_eq!(auto["envelope"]["source"], "+3");
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_line("not json"), Err(FrameError::NotAnObject));
        assert_eq!(parse_line("[1,2]"), Err(FrameError::NotAnObject));
        assert_eq!(parse_line("{\"jsonrpc\":\"2.0\"}"), Err(FrameError::Unrecognised));
        assert!(matches!(
            parse_line("{\"jsonrpc\":\"2.0\",\"result\":1,\"id\":\"theirs\"}"),
            Err(FrameError::ForeignId(_))
        ));
        // signal-cli's reply to a request it couldn't parse has a null id.
        assert!(matches!(
            parse_line("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32600,\"message\":\"x\"},\"id\":null}"),
            Err(FrameError::ForeignId(_))
        ));
    }
}
