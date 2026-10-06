//! Privacy scrubbing applied by [`crate::applog`] to every log line, no
//! matter the source (Rust, the frontend, or signal-cli's stderr): a log
//! file is the one place Snowdrop writes plaintext to disk outside the
//! vault, so nothing that could identify a person or unlock their data may
//! land in it unredacted.
//!
//! What's scrubbed, in order:
//! 1. Newlines (`\n`, `\r\n`, `\r`) → ` ⏎ `, so a multi-line message (a JS
//!    stack trace, a crash dump line) stays readable as separated frames
//!    instead of being smashed into one line or, worse, split into what
//!    looks like two separate log records.
//! 2. Remaining control characters (including bidi override/isolate marks),
//!    so nothing in the message can smuggle in a fake second log record or
//!    visually reorder/hide part of the line.
//! 3. `sgnl://` URIs (they carry link keys) → `<sgnl-uri>`.
//! 4. UUIDs/ACIs → `<uuid>`.
//! 5. Phone numbers (`+` then 7–15 digits, allowing spaces/dashes) → `<phone>`.
//! 6. Long base64/base64url runs (32+ chars: group ids, keys) → `<b64>`,
//!    *except* inside a URL or file path (any `scheme://…` other than
//!    `sgnl://`, or a `/`-separated path): see [`redact_base64`].
//! 7. A final cap at [`MAX_LINE`] chars.
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

/// Replaces every newline — `\n`, `\r\n` or a lone old-Mac `\r` — with
/// ` ⏎ `. Must run before `strip_controls`, which deletes `\n`/`\r`
/// themselves (they're control characters): deleting them outright is what
/// used to smash a multi-line message (a stack trace, a crash dump) into
/// one unreadable line. ` ⏎ ` is neither a control character nor one of the
/// bidi marks `strip_controls` removes, so it survives that pass intact.
fn mark_newlines(input: &str) -> String {
    input.replace("\r\n", "\n").replace(['\n', '\r'], " ⏎ ")
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

/// Body characters for a candidate base64/base64url run. Deliberately
/// excludes `/`, even though it's part of the standard base64 alphabet:
/// including it let one match span multiple path segments of a URL or file
/// path (`tauri://localhost/assets/index-DFVCqG64.js` → `tauri:<b64>.js`),
/// since `/` and the run's other characters look identical to the regex. A
/// real base64 run that happens to contain a `/` is simply split into
/// shorter pieces at it; as long as a piece is still 32+ chars it's still
/// redacted, and the common case — logging URLs and paths without mangling
/// them — matters more here than that corner case.
fn is_base64_body(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '_' | '=')
}

/// A run is only redacted when it stands alone — not visibly part of a URL
/// or file path. The character immediately before and after it must be the
/// start/end of the string, whitespace, a quote, or one of `` =,:;()[]{} ``;
/// specifically *not* `/` (a path/URL separator) or `.` (a file extension,
/// or a domain/sentence boundary). This is what keeps the base64 rule from
/// firing on `tauri://…`, `file://…`, `http(s)://…/path`, a
/// `/home/user/.local/share/…` path, or a `name@scheme://host/file.js:1:2`
/// stack frame: the candidate run in each of those is always touching a
/// `/` or `.` on at least one side.
fn is_standalone_boundary(c: Option<char>) -> bool {
    match c {
        None => true,
        Some(c) => c.is_whitespace() || matches!(c, '\'' | '"' | '`' | '=' | ',' | ':' | ';' | '(' | ')' | '[' | ']' | '{' | '}'),
    }
}

/// Worth treating as key material rather than an ordinary word, path
/// segment or plain number: 32+ chars, and containing either both a letter
/// and a digit, or a `+`/`=` (base64 padding/alphabet characters that are
/// otherwise rare in plain prose or identifiers). A run of pure digits (a
/// byte count) or pure letters (a long word or path segment) doesn't count.
fn looks_like_base64(run: &[char]) -> bool {
    if run.len() < 32 {
        return false;
    }
    let has_letter = run.iter().any(|c| c.is_ascii_alphabetic());
    let has_digit = run.iter().any(|c| c.is_ascii_digit());
    let has_marker = run.iter().any(|c| matches!(c, '+' | '='));
    (has_letter && has_digit) || has_marker
}

/// Replaces standalone 32+-char base64/base64url-looking runs with `<b64>`.
/// Hand-written rather than one regex, like [`redact_phones`]: the `regex`
/// crate has no look-around, and "is this run standalone, not part of a URL
/// or path" is exactly a look-around question (see [`is_standalone_boundary`]).
fn redact_base64(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if !is_base64_body(chars[i]) {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_base64_body(chars[i]) {
            i += 1;
        }
        let run = &chars[start..i];
        let before = start.checked_sub(1).map(|p| chars[p]);
        let after = chars.get(i).copied();
        if looks_like_base64(run) && is_standalone_boundary(before) && is_standalone_boundary(after) {
            out.push_str("<b64>");
        } else {
            out.extend(run);
        }
    }
    out
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
    let newlines_marked = mark_newlines(input);
    let stripped = strip_controls(&newlines_marked);
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
    fn leaves_a_long_run_of_pure_letters_alone() {
        // Not base64-looking: no digit and no +/= marker.
        let letters = "a".repeat(40);
        assert_eq!(redact(&letters), letters);
    }

    #[test]
    fn does_not_mangle_a_tauri_asset_url() {
        // The exact false positive from a real user log: this used to come
        // out as "tauri:<b64>.js:1:4460".
        let line = "tauri://localhost/assets/index-DFVCqG64.js:1:4460";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn does_not_mangle_a_js_stack_frame_crossing_a_tauri_url() {
        let line = "chooseAccount@tauri://localhost/assets/signal-cli-BNewf0fZ.js:5:10012";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn does_not_mangle_a_file_url() {
        let line = "file:///home/user/.local/share/Snowdrop/snowdrop.log";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn does_not_mangle_an_http_url_with_a_path() {
        let line = "GET https://example.com/assets/app-ab12cd34.js failed";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn does_not_mangle_a_local_share_path() {
        let line = "wrote snowdrop.log to /home/user/.local/share/Snowdrop/logs";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn still_redacts_a_uuid_and_a_phone_number_inside_a_url() {
        let line = "http://example.com/users/11111111-1111-4111-8111-111111111111/+15551234567";
        assert_eq!(redact(line), "http://example.com/users/<uuid>/<phone>");
    }

    #[test]
    fn redacts_a_standalone_base64_run_even_next_to_punctuation() {
        let b64 = "QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=";
        assert_eq!(redact(&format!("(group: {b64})")), "(group: <b64>)");
    }

    #[test]
    fn leaves_timestamps_versions_ports_and_byte_counts_alone() {
        for safe in ["2026-10-06T09:12:03.123Z", "signal-cli 0.14.8", "listening on port 8080", "wrote 1048576 bytes"] {
            assert_eq!(redact(safe), safe, "false positive on {safe:?}");
        }
    }

    #[test]
    fn strips_control_characters_but_keeps_newlines_as_separators() {
        // `\n` becomes a visible separator, not nothing: a multi-line
        // message must stay readable as separated frames. The other
        // control characters (tab, bell) are still stripped outright.
        assert_eq!(redact("a\nb\tc\u{0007}d"), "a ⏎ bcd");
    }

    #[test]
    fn replaces_crlf_and_lone_cr_with_the_same_separator_as_lf() {
        assert_eq!(redact("a\r\nb"), "a ⏎ b");
        assert_eq!(redact("a\rb"), "a ⏎ b");
    }

    #[test]
    fn keeps_a_multi_line_stack_trace_readable() {
        let trace = "SignalCliError: not found\n  at P (app.js:1:1)\n  at check (app.js:1:2)";
        assert_eq!(
            redact(trace),
            "SignalCliError: not found ⏎   at P (app.js:1:1) ⏎   at check (app.js:1:2)",
        );
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
