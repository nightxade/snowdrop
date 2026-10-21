//! Parameter validation for `signal_cli_request`.
//!
//! signal-cli treats several string parameters as *file paths on the host*
//! unless they're `data:` URIs: `attachment`, `previewImage`, `avatar`
//! (`updateGroup`), each `customEmoji[].attachment`, and the third segment of
//! a `quoteAttachment` (`contentType:filename:previewFile`). Snowdrop's UI
//! only ever sends data URIs there, so a request that carries anything else
//! can only come from a misbehaving (or compromised) webview trying to make
//! the daemon read a local file. Reject it here, before it reaches signal-cli.
//!
//! signal-cli's JSON-RPC layer is lenient about how a parameter is spelled
//! (`preview-image` and `previewImage` are the same, and list parameters also
//! answer to a plural name like `attachments`), so keys are compared in a
//! canonical form: lowercased with `-` and `_` removed. That's a superset of
//! the spellings signal-cli accepts.
//!
//! Errors never include the offending value.

use serde_json::{Map, Value};

use crate::error::{Error, ErrorKind};

fn canonical(key: &str) -> String {
    key.chars().filter(|c| *c != '-' && *c != '_').flat_map(char::to_lowercase).collect()
}

/// True for a string signal-cli will decode as an inline attachment rather
/// than open as a file: `data:` (lowercase, as its pattern requires), a
/// comma, at least one data character, and no line breaks or NULs in the
/// header (a line break makes signal-cli's pattern fail and fall back to
/// treating the whole string as a path).
pub fn is_data_uri(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("data:") else { return false };
    let Some((header, data)) = rest.split_once(',') else { return false };
    !data.is_empty() && !header.contains(['\n', '\r', '\0'])
}

fn reject(what: &str) -> Error {
    Error::new(
        ErrorKind::Config,
        format!("Snowdrop only sends files to signal-cli inline: {what} must be a data: URI."),
    )
}

/// Each string in `v` (a string, an array of strings, or null) must satisfy `ok`.
fn each_string(v: &Value, what: &str, ok: impl Fn(&str) -> bool) -> Result<(), Error> {
    match v {
        Value::Null => Ok(()),
        Value::String(s) => ok(s).then_some(()).ok_or_else(|| reject(what)),
        Value::Array(items) => items.iter().try_for_each(|i| match i {
            Value::String(s) if ok(s) => Ok(()),
            _ => Err(reject(what)),
        }),
        _ => Err(reject(what)),
    }
}

fn custom_emoji_entry(v: &Value) -> Result<(), Error> {
    match v.as_object().and_then(|o| o.get("attachment")) {
        Some(Value::String(s)) if is_data_uri(s) => Ok(()),
        _ => Err(reject("a custom emoji's attachment")),
    }
}

/// A quote attachment is `contentType[:filename]`; a third part is a path.
fn is_quote_attachment(s: &str) -> bool {
    s.matches(':').count() < 2
}

/// The only keys `updateConfiguration` may carry from the UI: the four privacy
/// settings the phone syncs (canonical form), plus the multi-account selector.
const CONFIGURATION_KEYS: &[&str] =
    &["readreceipts", "typingindicators", "linkpreviews", "unidentifieddeliveryindicators"];

/// `updateConfiguration` also covers things the UI never touches (number
/// visibility, discoverability): only the privacy booleans get through, each a
/// real JSON boolean, and `account` is the one other key allowed.
fn validate_configuration_params(params: Option<&Map<String, Value>>) -> Result<(), Error> {
    let reject = || {
        Error::new(
            ErrorKind::Config,
            "Snowdrop may only change read receipts, typing indicators and link previews through updateConfiguration.",
        )
    };
    let Some(params) = params else { return Ok(()) };
    for (key, value) in params {
        let key = canonical(key);
        if key == "account" {
            if !matches!(value, Value::String(_) | Value::Null) {
                return Err(reject());
            }
        } else if !CONFIGURATION_KEYS.contains(&key.as_str()) || !value.is_boolean() {
            return Err(reject());
        }
    }
    Ok(())
}

/// Every request's parameter check: the file-reference rules for all methods,
/// plus the strict key allow-list for `updateConfiguration`.
pub fn validate_request(method: &str, params: Option<&Map<String, Value>>) -> Result<(), Error> {
    validate_params(params)?;
    if method == "updateConfiguration" {
        validate_configuration_params(params)?;
    }
    Ok(())
}

/// Rejects any request whose file-reference parameters aren't inline data.
pub fn validate_params(params: Option<&Map<String, Value>>) -> Result<(), Error> {
    let Some(params) = params else { return Ok(()) };
    for (key, value) in params {
        match canonical(key).as_str() {
            "attachment" | "attachments" => each_string(value, "an attachment", is_data_uri)?,
            "previewimage" | "previewimages" => each_string(value, "a link preview image", is_data_uri)?,
            "avatar" | "avatars" => each_string(value, "an avatar", is_data_uri)?,
            "quoteattachment" | "quoteattachments" => {
                each_string(value, "a quote attachment (no preview file part)", is_quote_attachment)?
            }
            "customemoji" | "customemojis" => match value {
                Value::Null => {}
                Value::Array(items) => items.iter().try_for_each(custom_emoji_entry)?,
                other => custom_emoji_entry(other)?,
            },
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn check(v: Value) -> Result<(), Error> {
        validate_params(v.as_object())
    }

    const URI: &str = "data:image/png;filename=a.png;base64,AAAA";

    #[test]
    fn accepts_inline_data_in_every_shape() {
        assert!(check(json!({})).is_ok());
        assert!(validate_params(None).is_ok());
        assert!(check(json!({ "attachment": [URI, URI] })).is_ok());
        assert!(check(json!({ "attachment": URI })).is_ok());
        assert!(check(json!({ "previewImage": URI, "message": "hi" })).is_ok());
        assert!(check(json!({ "avatar": URI })).is_ok());
        assert!(check(json!({ "customEmoji": [{ "name": "x", "attachment": URI }] })).is_ok());
        assert!(check(json!({ "quoteAttachment": ["image/png", "image/png:a.png"] })).is_ok());
        assert!(check(json!({ "attachment": null })).is_ok());
    }

    #[test]
    fn rejects_paths_for_attachment() {
        for bad in ["/etc/passwd", "~/.ssh/id_ed25519", "../x", "file:///etc/passwd", "DATA:x,y", "data:x", "data:x,"] {
            assert!(check(json!({ "attachment": bad })).is_err(), "{bad}");
            assert!(check(json!({ "attachment": [URI, bad] })).is_err(), "{bad}");
        }
        assert!(check(json!({ "attachment": "data:text/plain\n;base64,../../etc/passwd" })).is_err());
        assert!(check(json!({ "attachment": 5 })).is_err());
        assert!(check(json!({ "attachment": [URI, 5] })).is_err());
        assert!(check(json!({ "attachment": { "a": URI } })).is_err());
    }

    #[test]
    fn rejects_paths_for_preview_image_and_avatar() {
        assert!(check(json!({ "previewImage": "/home/u/.ssh/id_rsa" })).is_err());
        assert!(check(json!({ "avatar": "/home/u/.ssh/id_rsa" })).is_err());
        assert!(check(json!({ "avatar": ["/x"] })).is_err());
    }

    #[test]
    fn rejects_paths_in_custom_emoji() {
        assert!(check(json!({ "customEmoji": [{ "name": "x", "attachment": "/etc/passwd" }] })).is_err());
        assert!(check(json!({ "customEmoji": [{ "name": "x" }] })).is_err());
        assert!(check(json!({ "customEmoji": [{ "name": "x", "attachment": URI }, "nope"] })).is_err());
        assert!(check(json!({ "customEmoji": { "name": "x", "attachment": "/etc/passwd" } })).is_err());
    }

    #[test]
    fn rejects_a_quote_attachment_preview_file_segment() {
        assert!(check(json!({ "quoteAttachment": ["image/png:a.png:/etc/passwd"] })).is_err());
        assert!(check(json!({ "quoteAttachment": "image/png:a.png:/etc/passwd" })).is_err());
        assert!(check(json!({ "quoteAttachment": ["image/png", "a:b:c"] })).is_err());
        assert!(check(json!({ "quoteAttachment": [1] })).is_err());
    }

    #[test]
    fn catches_alternate_spellings_signal_cli_accepts() {
        for key in [
            "attachments",
            "Attachment",
            "preview-image",
            "previewImage",
            "quote-attachment",
            "quoteAttachments",
            "custom-emoji",
            "customEmojis",
            "avatar",
        ] {
            let value = if key.to_lowercase().contains("emoji") {
                json!([{ "attachment": "/x" }])
            } else {
                json!("/etc/passwd:x:y")
            };
            assert!(check(json!({ key: value })).is_err(), "{key}");
        }
    }

    fn check_request(method: &str, v: Value) -> Result<(), Error> {
        validate_request(method, v.as_object())
    }

    #[test]
    fn update_configuration_accepts_only_the_privacy_booleans() {
        assert!(check_request("updateConfiguration", json!({})).is_ok());
        assert!(check_request("updateConfiguration", json!({ "account": "+15550001" })).is_ok());
        assert!(check_request(
            "updateConfiguration",
            json!({ "readReceipts": false, "typingIndicators": true, "linkPreviews": false, "unidentifiedDeliveryIndicators": true }),
        )
        .is_ok());
        // signal-cli accepts the flag spelling too.
        assert!(check_request("updateConfiguration", json!({ "read-receipts": true })).is_ok());
    }

    #[test]
    fn update_configuration_rejects_everything_else() {
        for bad in [
            json!({ "phoneNumberSharingMode": "nobody" }),
            json!({ "phone-number-unlisted": true }),
            json!({ "username": "x" }),
            json!({ "readReceipts": "false" }),
            json!({ "readReceipts": null }),
            json!({ "readReceipts": 0 }),
            json!({ "readReceipts": true, "somethingElse": true }),
            json!({ "account": 5 }),
        ] {
            assert!(check_request("updateConfiguration", bad.clone()).is_err(), "{bad}");
        }
    }

    /// The message-request calls (accept/delete, block/unblock, quit a group)
    /// carry only an address or a group id, so they pass untouched; the
    /// file-reference rules still apply to them like to every method.
    #[test]
    fn message_request_calls_pass_the_guard_with_their_real_params() {
        assert!(check_request(
            "sendMessageRequestResponse",
            json!({ "recipient": ["+15550001"], "type": "accept" })
        )
        .is_ok());
        assert!(check_request(
            "sendMessageRequestResponse",
            json!({ "groupId": "Zm9v", "type": "delete" })
        )
        .is_ok());
        assert!(check_request("block", json!({ "recipient": ["+15550001"] })).is_ok());
        assert!(check_request("unblock", json!({ "groupId": ["Zm9v"] })).is_ok());
        assert!(check_request("quitGroup", json!({ "groupId": "Zm9v", "delete": true })).is_ok());
        assert!(check_request("block", json!({ "recipient": ["+15550001"], "attachment": "/etc/passwd" })).is_err());
    }

    #[test]
    fn the_configuration_allow_list_applies_to_that_method_only() {
        assert!(check_request("getConfiguration", json!({})).is_ok());
        assert!(check_request("send", json!({ "message": "hi", "unrelated": 1 })).is_ok());
        // File-reference rules still run for it too.
        assert!(check_request("updateConfiguration", json!({ "attachment": "/etc/passwd" })).is_err());
    }

    #[test]
    fn error_message_does_not_echo_the_value() {
        let err = check(json!({ "attachment": "/home/secret-user/key" })).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Config);
        assert!(!err.message.contains("secret-user"));
    }
}
