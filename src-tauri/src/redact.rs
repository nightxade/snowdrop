//! Privacy scrubbing applied by [`crate::applog`] to every log line, no
//! matter the source (Rust, the frontend, or signal-cli's stderr): a log
//! file is the one place Snowdrop writes plaintext to disk outside the
//! vault, so nothing that could identify a person or unlock their data may
//! land in it unredacted.
//!
//! What's scrubbed, in order:
//! 1. Control characters (including bidi override/isolate marks) and
//!    newlines, so one log record can never smuggle in a second fake one.
//! 2. `sgnl://` URIs (they carry link keys) → `<sgnl-uri>`.
//! 3. UUIDs/ACIs → `<uuid>`.
//! 4. Phone numbers (`+` then 7–15 digits, allowing spaces/dashes) → `<phone>`.
//! 5. Long base64/base64url runs (32+ chars: group ids, keys) → `<b64>`.
//! 6. A final cap at [`MAX_LINE`] chars.
//!
//! This is a safety net, not the only line of defence: call sites should
//! still never log message bodies, contact names or raw JSON-RPC payloads
//! in the first place (lengths and types instead) — see the audit notes on
//! `process::read_loop`'s and `drain_stderr`'s own log calls.

use std::sync::OnceLock;

/// The longest a redacted line is allowed to be.
pub const MAX_LINE: usize = 2000;

fn sgnl_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"sgnl://\S+").expect("static regex"))
}

fn uuid_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").expect("static regex")
    })
}

fn base64_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[A-Za-z0-9+/_=-]{32,}").expect("static regex"))
}

/// True for C0/C1 control characters (`char::is_control`, which already
/// covers `\n`/`\r`/`\t`) and for the Unicode bidi override/isolate marks,
/// which `is_control` doesn't: those are formatting characters, not
/// controls, but letting them through would let a malicious contact name or
/// payload visually reorder or hide parts of a log line.
fn is_stripped(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn strip_controls(input: &str) -> String {
    input.chars().filter(|c| !is_stripped(*c)).collect()
}

/// Replaces `+` followed by 7–15 digits (spaces/dashes allowed between
/// digits) with `<phone>`. Written by hand rather than as one regex: the
/// digit-count bound (not just a character-class shape) is what keeps
/// versions, ports and byte counts from ever reaching this function in the
/// first place — they don't start with `+` — while still rejecting
/// unrelated `+`-prefixed runs that are too short or too long to be a real
/// phone number.
fn redact_phones(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '+' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut digits = 0u32;
        let mut last_digit_end = i + 1;
        while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ' ' || chars[j] == '-') {
            if chars[j].is_ascii_digit() {
                digits += 1;
                last_digit_end = j + 1;
            }
            j += 1;
            if digits > 15 {
                break;
            }
        }
        if (7..=15).contains(&digits) {
            out.push_str("<phone>");
            i = last_digit_end;
        } else {
            out.push('+');
            i += 1;
        }
    }
    out
}

/// Replaces 32+-char runs of base64/base64url characters with `<b64>`,
/// except a run that's entirely ASCII digits — that's far more likely to be
/// a byte count or similar plain number than key material, and the task
/// that defined this redaction explicitly wants byte counts to survive.
fn redact_base64(input: &str) -> String {
    base64_re()
        .replace_all(input, |caps: &regex::Captures<'_>| {
            let text = &caps[0];
            if text.bytes().all(|b| b.is_ascii_digit()) {
                text.to_string()
            } else {
                "<b64>".to_string()
            }
        })
        .into_owned()
}

fn cap(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    input.chars().take(max_chars).collect()
}

/// Redacts one log message. Idempotent-ish: running it twice is harmless
/// (the placeholders themselves never match any of the patterns above).
pub fn redact(input: &str) -> String {
    let stripped = strip_controls(input);
    let no_sgnl = sgnl_re().replace_all(&stripped, "<sgnl-uri>");
    let no_uuid = uuid_re().replace_all(&no_sgnl, "<uuid>");
    let no_phone = redact_phones(&no_uuid);
    let no_b64 = redact_base64(&no_phone);
    cap(&no_b64, MAX_LINE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_a_plain_phone_number() {
        assert_eq!(redact("calling +15551234567 now"), "calling <phone> now");
    }

    #[test]
    fn redacts_a_phone_number_with_spaces_and_dashes() {
        assert_eq!(redact("to +1 555-123-4567 please"), "to <phone> please");
    }

    #[test]
    fn leaves_too_short_a_number_alone() {
        // 6 digits: below the 7-digit floor.
        assert_eq!(redact("code +123456"), "code +123456");
    }

    #[test]
    fn leaves_too_long_a_number_alone() {
        // 16 digits: above the 15-digit ceiling.
        assert_eq!(redact("id +1234567890123456"), "id +1234567890123456");
    }

    #[test]
    fn redacts_a_uuid_lower_and_upper_case() {
        assert_eq!(redact("aci 11111111-1111-4111-8111-111111111111 linked"), "aci <uuid> linked");
        assert_eq!(redact("ACI 11111111-1111-4111-8111-111111111111 linked"), "ACI <uuid> linked");
    }

    #[test]
    fn redacts_an_sgnl_uri_whole() {
        let line = redact("open sgnl://signal.me/#p/+15551234567 to link");
        assert_eq!(line, "open <sgnl-uri> to link");
    }

    #[test]
    fn redacts_a_long_base64_run() {
        let b64 = "QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=";
        assert!(b64.len() >= 32);
        assert_eq!(redact(&format!("group {b64} synced")), "group <b64> synced");
    }

    #[test]
    fn leaves_a_short_base64_like_run_alone() {
        assert_eq!(redact("key QWJjZGVmZ2g="), "key QWJjZGVmZ2g=");
    }

    #[test]
    fn leaves_a_long_run_of_pure_digits_alone() {
        // A big byte count, not base64.
        let digits = "1".repeat(40);
        assert_eq!(redact(&digits), digits);
    }

    #[test]
    fn leaves_timestamps_versions_ports_and_byte_counts_alone() {
        for safe in ["2026-10-06T09:12:03.123Z", "signal-cli 0.14.8", "listening on port 8080", "wrote 1048576 bytes"] {
            assert_eq!(redact(safe), safe, "false positive on {safe:?}");
        }
    }

    #[test]
    fn strips_control_characters_and_newlines() {
        assert_eq!(redact("a\nb\tc\u{0007}d"), "abcd");
    }

    #[test]
    fn strips_bidi_control_characters() {
        assert_eq!(redact("a\u{202E}b\u{2066}c"), "abc");
    }

    #[test]
    fn caps_line_length() {
        // Plain digits: long, but not base64 (all-digit runs are exempt)
        // and not anything else this module redacts, so the cap is the
        // only thing that can act on it.
        let long = "1".repeat(3000);
        let out = redact(&long);
        assert_eq!(out.chars().count(), MAX_LINE);
    }

    #[test]
    fn redaction_happens_before_the_length_cap() {
        // A phone number sitting right at the edge of the cap must still be
        // redacted, not left half-truncated.
        let line = format!("{}+15551234567", "a".repeat(1990));
        let out = redact(&line);
        assert!(out.contains("<phone>"), "{out}");
    }

    #[test]
    fn multiple_patterns_in_one_line_are_all_redacted() {
        let line = "from +15551234567 aci 11111111-1111-4111-8111-111111111111";
        assert_eq!(redact(line), "from <phone> aci <uuid>");
    }
}
