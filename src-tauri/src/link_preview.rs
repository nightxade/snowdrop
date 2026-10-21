//! Link previews (Settings → Behaviour → "Link previews"): fetches a URL's
//! Open Graph / Twitter-card / `<title>` metadata, and its image if any,
//! directly from this device — the same as Signal Desktop, which also
//! fetches previews directly (its `contentproxy.signal.org` relay only
//! tunnels to Giphy). Like Signal Desktop, an `HTTPS_PROXY` / `https_proxy`
//! environment variable routes every fetch through that proxy instead
//! (which then resolves the names itself — no local DNS lookup); no other
//! proxy variable is honoured. Without one, the fetch is direct, hardened
//! against being pointed somewhere it shouldn't:
//!
//! - https only, both for the page and its image.
//! - Every hostname is resolved to a concrete address *before* connecting,
//!   that address is checked against loopback/private/link-local/
//!   multicast/unspecified ranges, and the connection is pinned to exactly
//!   that address (no second DNS lookup for the TLS handshake to race).
//!   Every redirect hop repeats the same check from scratch.
//! - At most [`MAX_REDIRECTS`] redirects, an [`FETCH_TIMEOUT`] total
//!   deadline, and a byte cap on both the page (stopping early once
//!   `</head>` is seen — everything we want lives there) and the image.
//! - The page is parsed with a real HTML5 tokenizer ([`html5gum`]), not
//!   regex, which also means character references (`&amp;`, …) are decoded
//!   for free.
//!
//! Never logs the url, the page's content, or anything derived from it —
//! only error kinds (see `src/redact.rs`'s broader logging policy).

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use html5gum::{StartTag, Token, Tokenizer};
use serde::Serialize;
use url::Url;

/// A redirect chain longer than this is almost certainly a tracker or a
/// dead link, not a page worth generating a preview for.
const MAX_REDIRECTS: u8 = 3;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The page itself: stops well short of this once `</head>` is seen.
const MAX_HTML_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// The User-Agent Signal's own clients send for previews. Many sites only
/// serve their Open Graph tags to user agents they know as link-preview
/// fetchers, so a generic one gets no preview from them.
const USER_AGENT: &str = "WhatsApp/2";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedImage {
    pub content_type: String,
    /// Base64 of the raw bytes; the frontend turns this into a `Blob`.
    pub base64: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPreview {
    /// Always exactly the input string, byte for byte — the frontend only
    /// shows a preview whose url still appears in the composer text, which
    /// is a literal substring match against what it sent us.
    pub url: String,
    pub title: String,
    pub description: Option<String>,
    pub image: Option<FetchedImage>,
}

/// Wrapped as the `link_preview_fetch` Tauri command in `commands.rs`.
/// Ordinary failures (blocked scraper, timeout, nothing usable in the page)
/// all resolve to `Ok(None)` — the same silent degradation Signal's own
/// clients show — so the composer never has to show a scary error for what
/// is, to the user, just "no preview".
pub async fn link_preview_fetch(url: String) -> Result<Option<FetchedPreview>, String> {
    match fetch_preview(&url).await {
        Ok(preview) => Ok(preview),
        Err(err) => {
            log::debug!("link preview: no preview ({err})");
            Ok(None)
        }
    }
}

#[derive(Debug)]
enum FetchError {
    InvalidUrl,
    DisallowedAddress,
    Dns,
    Request,
    TooManyRedirects,
    BadRedirect,
    Status(u16),
    BadContentType,
    NoTitle,
    BadProxy,
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::InvalidUrl => write!(f, "invalid or non-https url"),
            FetchError::DisallowedAddress => write!(f, "resolved to a disallowed address"),
            FetchError::BadProxy => write!(f, "HTTPS_PROXY isn't a usable proxy URL"),
            FetchError::Dns => write!(f, "dns resolution failed"),
            FetchError::Request => write!(f, "request failed"),
            FetchError::TooManyRedirects => write!(f, "too many redirects"),
            FetchError::BadRedirect => write!(f, "malformed redirect"),
            FetchError::Status(s) => write!(f, "http status {s}"),
            FetchError::BadContentType => write!(f, "unexpected content type"),
            FetchError::NoTitle => write!(f, "no usable title"),
        }
    }
}

async fn fetch_preview(input: &str) -> Result<Option<FetchedPreview>, FetchError> {
    let start = validate_url(input, "https")?;
    let page = fetch_capped_https(
        start,
        MAX_HTML_BYTES,
        |content_type| content_type.to_ascii_lowercase().contains("html"),
        Some(b"</head"),
    )
    .await?;
    let html = String::from_utf8_lossy(&page.body);
    let meta = parse_meta(&html);
    let Some(title) = meta.title else {
        return Err(FetchError::NoTitle);
    };

    let image = match meta.image_url.as_deref().and_then(|raw| page.final_url.join(raw).ok()) {
        Some(resolved) if resolved.scheme() == "https" => fetch_preview_image(resolved).await,
        _ => None,
    };

    Ok(Some(FetchedPreview { url: input.to_string(), title, description: meta.description, image }))
}

/// Raster types only — notably not `image/svg+xml`, which the frontend
/// would otherwise have to sanitise before ever labelling bytes with it.
fn is_safe_raster_image(content_type: &str) -> bool {
    let bare = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(
        bare.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp" | "image/bmp" | "image/avif"
    )
}

async fn fetch_preview_image(start: Url) -> Option<FetchedImage> {
    let img = fetch_capped_https(start, MAX_IMAGE_BYTES, is_safe_raster_image, None).await.ok()?;
    let size = imagesize::blob_size(&img.body).ok();
    Some(FetchedImage {
        content_type: img.content_type,
        base64: STANDARD.encode(&img.body),
        width: size.and_then(|s| u32::try_from(s.width).ok()),
        height: size.and_then(|s| u32::try_from(s.height).ok()),
    })
}

// ─── Hardened fetch ─────────────────────────────────────────────────────

struct CappedFetch {
    final_url: Url,
    content_type: String,
    body: Vec<u8>,
}

/// [`fetch_capped`] pinned to `https` and the real (loopback/private/…)
/// address filter — the only way production code calls it. Tests drive the
/// generic function directly against a plain local server instead.
async fn fetch_capped_https(
    start: Url,
    max_bytes: usize,
    accept: impl Fn(&str) -> bool,
    early_stop: Option<&[u8]>,
) -> Result<CappedFetch, FetchError> {
    let proxy = configured_proxy()?;
    fetch_capped(start, max_bytes, accept, early_stop, "https", proxy.as_ref(), |ip| !is_disallowed_ip(ip))
        .await
}

/// Signal Desktop's rule: `HTTPS_PROXY`, else `https_proxy`, else none. A
/// value that isn't a usable proxy URL fails the preview rather than
/// silently going direct.
fn configured_proxy() -> Result<Option<reqwest::Proxy>, FetchError> {
    proxy_from(std::env::var("HTTPS_PROXY").ok(), std::env::var("https_proxy").ok())
}

fn proxy_from(upper: Option<String>, lower: Option<String>) -> Result<Option<reqwest::Proxy>, FetchError> {
    let Some(raw) = upper.filter(|v| !v.trim().is_empty()).or(lower.filter(|v| !v.trim().is_empty())) else {
        return Ok(None);
    };
    reqwest::Proxy::https(raw.trim()).map(Some).map_err(|_| FetchError::BadProxy)
}

/// Follows redirects (re-validating scheme and address on every hop),
/// reads the body capped at `max_bytes` (stopping early at `early_stop` if
/// given), and rejects a final content type `accept` doesn't allow.
///
/// `required_scheme` and `ip_allowed` are parameters (not hardcoded to
/// `https`/the real address filter) purely so tests can run this exact
/// redirect/cap/early-stop logic against a plain local test server; see
/// [`fetch_capped_https`] for what production actually uses.
async fn fetch_capped(
    start: Url,
    max_bytes: usize,
    accept: impl Fn(&str) -> bool,
    early_stop: Option<&[u8]>,
    required_scheme: &str,
    proxy: Option<&reqwest::Proxy>,
    ip_allowed: impl Fn(&IpAddr) -> bool,
) -> Result<CappedFetch, FetchError> {
    let mut current = start;
    let mut redirects = 0u8;
    loop {
        let client = match proxy {
            // The proxy resolves the name; resolving it here too would
            // leak the lookup outside the proxy.
            Some(proxy) => proxied_client(proxy.clone())?,
            None => {
                let host = current.host_str().ok_or(FetchError::InvalidUrl)?.to_string();
                let port = current.port_or_known_default().ok_or(FetchError::InvalidUrl)?;
                let addr = resolve_allowed(&host, port, &ip_allowed).await?;
                pinned_client(&host, addr)?
            }
        };
        let resp = client.get(current.as_str()).send().await.map_err(|_| FetchError::Request)?;

        if resp.status().is_redirection() {
            redirects += 1;
            if redirects > MAX_REDIRECTS {
                return Err(FetchError::TooManyRedirects);
            }
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(FetchError::BadRedirect)?;
            current = current.join(location).map_err(|_| FetchError::BadRedirect)?;
            require_scheme(&current, required_scheme)?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(FetchError::Status(resp.status().as_u16()));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !accept(&content_type) {
            return Err(FetchError::BadContentType);
        }
        let body = read_capped(resp, max_bytes, early_stop).await?;
        return Ok(CappedFetch { final_url: current, content_type, body });
    }
}

async fn read_capped(
    mut resp: reqwest::Response,
    max_bytes: usize,
    early_stop: Option<&[u8]>,
) -> Result<Vec<u8>, FetchError> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| FetchError::Request)? {
        buf.extend_from_slice(&chunk);
        if buf.len() >= max_bytes {
            buf.truncate(max_bytes);
            break;
        }
        if early_stop.is_some_and(|needle| contains_case_insensitive(&buf, needle)) {
            break;
        }
    }
    Ok(buf)
}

fn contains_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.len() >= needle.len()
        && haystack.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

fn validate_url(input: &str, required_scheme: &str) -> Result<Url, FetchError> {
    let parsed = Url::parse(input).map_err(|_| FetchError::InvalidUrl)?;
    require_scheme(&parsed, required_scheme)?;
    Ok(parsed)
}

fn require_scheme(url: &Url, required: &str) -> Result<(), FetchError> {
    if url.scheme() != required || url.host_str().is_none() {
        return Err(FetchError::InvalidUrl);
    }
    Ok(())
}

async fn resolve_allowed(
    host: &str,
    port: u16,
    ip_allowed: &impl Fn(&IpAddr) -> bool,
) -> Result<SocketAddr, FetchError> {
    let addrs = tokio::net::lookup_host((host, port)).await.map_err(|_| FetchError::Dns)?;
    addrs.into_iter().find(|addr| ip_allowed(&addr.ip())).ok_or(FetchError::DisallowedAddress)
}

/// A client pinned to exactly the address we already validated — `host`
/// never triggers a second, un-checked DNS lookup of its own.
fn pinned_client(host: &str, addr: SocketAddr) -> Result<reqwest::Client, FetchError> {
    reqwest::Client::builder()
        // Direct means direct: no ALL_PROXY/HTTP_PROXY picked up implicitly.
        .no_proxy()
        .resolve(host, addr)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| FetchError::Request)
}

/// A client that sends everything through the user's configured proxy.
fn proxied_client(proxy: reqwest::Proxy) -> Result<reqwest::Client, FetchError> {
    reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| FetchError::Request)
}

// ─── Address filtering ──────────────────────────────────────────────────

/// Loopback, private, link-local, multicast, unspecified — plus a few
/// ranges the stable `std` helpers don't cover (carrier-grade NAT,
/// benchmarking, "this network") but that are equally unroutable from the
/// public internet and equally wrong for this fetch to ever reach.
fn is_disallowed_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_disallowed_ipv4(v4),
        IpAddr::V6(v6) => is_disallowed_ipv6(v6),
    }
}

fn is_disallowed_ipv4(v4: &Ipv4Addr) -> bool {
    if v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_unspecified()
        || v4.is_broadcast()
    {
        return true;
    }
    let o = v4.octets();
    o[0] == 0 // 0.0.0.0/8
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10, carrier-grade NAT
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // 198.18.0.0/15, benchmarking
}

fn is_disallowed_ipv6(v6: &Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
        return true;
    }
    let segs = v6.segments();
    // IPv4-mapped (::ffff:a.b.c.d/96): the embedded v4 address gets checked too.
    if segs[0] == 0 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 && segs[4] == 0 && segs[5] == 0xffff
    {
        let v4 = Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            (segs[6] & 0xff) as u8,
            (segs[7] >> 8) as u8,
            (segs[7] & 0xff) as u8,
        );
        return is_disallowed_ipv4(&v4);
    }
    let o = v6.octets();
    let unique_local = (o[0] & 0xfe) == 0xfc; // fc00::/7
    let link_local = o[0] == 0xfe && (o[1] & 0xc0) == 0x80; // fe80::/10
    unique_local || link_local
}

// ─── Meta parsing (html5gum: a real tokenizer, not regex) ──────────────

struct ParsedMeta {
    title: Option<String>,
    description: Option<String>,
    image_url: Option<String>,
}

/// Open Graph wins over Twitter-card wins over a bare `<title>`; stops at
/// `</head>` since nothing we want ever lives in the body.
fn parse_meta(html: &str) -> ParsedMeta {
    let mut og_title = None;
    let mut og_description = None;
    let mut og_image = None;
    let mut twitter_title = None;
    let mut twitter_description = None;
    let mut twitter_image = None;
    let mut doc_title = String::new();
    let mut in_title = false;

    for Ok(token) in Tokenizer::new(html) {
        match token {
            Token::StartTag(tag) => {
                if tag.name.eq_ignore_ascii_case(b"title") {
                    in_title = true;
                } else if tag.name.eq_ignore_ascii_case(b"meta") {
                    apply_meta_tag(
                        &tag,
                        &mut og_title,
                        &mut og_description,
                        &mut og_image,
                        &mut twitter_title,
                        &mut twitter_description,
                        &mut twitter_image,
                    );
                }
            }
            Token::EndTag(tag) => {
                if tag.name.eq_ignore_ascii_case(b"title") {
                    in_title = false;
                } else if tag.name.eq_ignore_ascii_case(b"head") {
                    break;
                }
            }
            Token::String(s) if in_title => {
                doc_title.push_str(&String::from_utf8_lossy(s.as_ref()));
            }
            _ => {}
        }
    }

    let title = og_title.or(twitter_title).or_else(|| {
        let trimmed = doc_title.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });

    ParsedMeta {
        title: title.map(|t| clamp_chars(&t, 200)),
        description: og_description.or(twitter_description).map(|d| clamp_chars(&d, 400)),
        image_url: og_image.or(twitter_image),
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_meta_tag(
    tag: &StartTag<()>,
    og_title: &mut Option<String>,
    og_description: &mut Option<String>,
    og_image: &mut Option<String>,
    twitter_title: &mut Option<String>,
    twitter_description: &mut Option<String>,
    twitter_image: &mut Option<String>,
) {
    // The WHATWG tokenizer lowercases attribute *names* while parsing, so
    // "property"/"name"/"content" are already exactly this case; values keep
    // whatever case the page used.
    let Some(property) = tag_attr(tag, b"property").or_else(|| tag_attr(tag, b"name")) else {
        return;
    };
    let Some(content) = tag_attr(tag, b"content") else { return };
    if content.trim().is_empty() {
        return;
    }
    match property.to_ascii_lowercase().as_str() {
        "og:title" => *og_title = Some(content),
        "og:description" => *og_description = Some(content),
        // First one wins: a page may repeat og:image / og:image:url / …
        // for the same picture at different sizes.
        "og:image" | "og:image:url" | "og:image:secure_url" => {
            if og_image.is_none() {
                *og_image = Some(content);
            }
        }
        "twitter:title" => *twitter_title = Some(content),
        "twitter:description" => *twitter_description = Some(content),
        "twitter:image" | "twitter:image:src" => {
            if twitter_image.is_none() {
                *twitter_image = Some(content);
            }
        }
        _ => {}
    }
}

fn tag_attr(tag: &StartTag<()>, name: &[u8]) -> Option<String> {
    let value = tag.attributes.get(name)?;
    Some(String::from_utf8_lossy(value.as_ref()).trim().to_string())
}

/// Clamps to `max_chars` Unicode scalar values (not bytes), with an
/// ellipsis, so a title/description can never blow up the message size.
fn clamp_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::TcpListener as StdTcpListener;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // ─── URL validation ───────────────────────────────────────────────

    #[test]
    fn requires_https_and_a_host() {
        assert!(validate_url("https://example.com/a", "https").is_ok());
        assert!(validate_url("http://example.com/a", "https").is_err());
        assert!(validate_url("ftp://example.com/a", "https").is_err());
        assert!(validate_url("not a url", "https").is_err());
        assert!(validate_url("javascript:alert(1)", "https").is_err());
    }

    #[test]
    fn require_scheme_is_reused_for_every_redirect_hop() {
        let https = Url::parse("https://example.com/a").unwrap();
        let http = Url::parse("http://example.com/a").unwrap();
        assert!(require_scheme(&https, "https").is_ok());
        assert!(require_scheme(&http, "https").is_err());
    }

    // ─── IP filtering ──────────────────────────────────────────────────

    #[test]
    fn disallows_loopback_private_link_local_multicast_and_unspecified_v4() {
        let disallowed = [
            "127.0.0.1",   // loopback
            "10.1.2.3",    // private
            "172.16.0.5",  // private
            "192.168.1.1", // private
            "169.254.1.1", // link-local
            "224.0.0.1",   // multicast
            "0.0.0.0",     // unspecified / "this network"
            "255.255.255.255", // broadcast
            "100.64.0.1",  // carrier-grade NAT
            "198.18.0.1",  // benchmarking
            "192.0.0.1",   // IETF protocol assignments
        ];
        for ip in disallowed {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(is_disallowed_ip(&addr), "{ip} should be disallowed");
        }
    }

    #[test]
    fn allows_an_ordinary_public_v4_address() {
        let addr: IpAddr = "93.184.216.34".parse().unwrap();
        assert!(!is_disallowed_ip(&addr));
    }

    #[test]
    fn disallows_loopback_unique_local_link_local_multicast_and_mapped_private_v6() {
        let disallowed = [
            "::1",                  // loopback
            "::",                   // unspecified
            "fc00::1",               // unique local
            "fd12:3456:789a::1",     // unique local
            "fe80::1",               // link-local
            "ff02::1",               // multicast
            "::ffff:10.0.0.1",       // IPv4-mapped private
            "::ffff:127.0.0.1",      // IPv4-mapped loopback
        ];
        for ip in disallowed {
            let addr: IpAddr = ip.parse().unwrap();
            assert!(is_disallowed_ip(&addr), "{ip} should be disallowed");
        }
    }

    #[test]
    fn allows_an_ordinary_public_v6_address_including_mapped() {
        let public: IpAddr = "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap();
        assert!(!is_disallowed_ip(&public));
        let mapped_public: IpAddr = "::ffff:93.184.216.34".parse().unwrap();
        assert!(!is_disallowed_ip(&mapped_public));
    }

    #[tokio::test]
    async fn resolve_allowed_rejects_every_address_the_predicate_refuses() {
        let err = resolve_allowed("127.0.0.1", 80, &|_: &IpAddr| false).await;
        assert!(matches!(err, Err(FetchError::DisallowedAddress)));
        let ok = resolve_allowed("127.0.0.1", 80, &|_: &IpAddr| true).await;
        assert!(ok.is_ok());
    }

    // ─── Meta parsing (html5gum) ───────────────────────────────────────

    #[test]
    fn prefers_open_graph_then_twitter_then_bare_title() {
        let html = r#"<html><head>
            <title>Fallback Title</title>
            <meta property="og:title" content="OG Title">
            <meta property="og:description" content="OG description.">
            <meta property="og:image" content="https://example.com/img.png">
            <meta name="twitter:title" content="Twitter Title">
        </head><body>ignored</body></html>"#;
        let meta = parse_meta(html);
        assert_eq!(meta.title, Some("OG Title".to_string()));
        assert_eq!(meta.description, Some("OG description.".to_string()));
        assert_eq!(meta.image_url, Some("https://example.com/img.png".to_string()));
    }

    #[test]
    fn falls_back_to_twitter_card_then_to_a_bare_title_tag() {
        let twitter = parse_meta(
            r#"<head><meta name="twitter:title" content="Twitter Title"><title>Bare</title></head>"#,
        );
        assert_eq!(twitter.title, Some("Twitter Title".to_string()));

        let bare = parse_meta(r#"<head><title>  Just a title  </title></head>"#);
        assert_eq!(bare.title, Some("Just a title".to_string()));
    }

    #[test]
    fn no_title_anywhere_is_none_not_an_empty_string() {
        let meta = parse_meta(r#"<head><meta property="og:description" content="desc"></head>"#);
        assert_eq!(meta.title, None);
    }

    #[test]
    fn decodes_html_entities_in_title_and_attribute_values() {
        let meta = parse_meta(
            r#"<head><meta property="og:title" content="Fish &amp; Chips &mdash; caf&eacute;"></head>"#,
        );
        assert_eq!(meta.title, Some("Fish & Chips — café".to_string()));
    }

    #[test]
    fn ignores_an_empty_content_attribute() {
        let meta = parse_meta(r#"<head><meta property="og:title" content="   "><title>Real</title></head>"#);
        assert_eq!(meta.title, Some("Real".to_string()));
    }

    #[test]
    fn stops_at_the_first_head_close_and_never_sees_the_body() {
        let meta = parse_meta(
            r#"<head><title>Head</title></head><body><title>Body title, must be ignored</title></body>"#,
        );
        assert_eq!(meta.title, Some("Head".to_string()));
    }

    #[test]
    fn clamps_a_very_long_title_with_an_ellipsis() {
        let long = "x".repeat(500);
        let meta = parse_meta(&format!(r#"<head><title>{long}</title></head>"#));
        let title = meta.title.unwrap();
        assert_eq!(title.chars().count(), 200);
        assert!(title.ends_with('…'));
    }

    // ─── Redirects, capping and early-stop (a real local server) ──────

    /// Minimal HTTP/1.1 server: serves whatever `Vec<Route>` it's given,
    /// matched by request path, closing the connection after each response
    /// (so there's no keep-alive state to manage in a four-line test server).
    struct Route {
        status: &'static str,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
        /// Byte offset to pause at (briefly) before sending the rest, so a
        /// test can force the client to see the body as two separate reads
        /// instead of whatever lands in the kernel's socket buffer at once.
        split_at: Option<usize>,
    }

    struct TestServer {
        addr: std::net::SocketAddr,
        _task: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        async fn start(routes: HashMap<&'static str, Route>) -> Self {
            let std_listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
            std_listener.set_nonblocking(true).unwrap();
            let addr = std_listener.local_addr().unwrap();
            let listener = TcpListener::from_std(std_listener).unwrap();
            let routes = Arc::new(routes);
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else { return };
                    let routes = Arc::clone(&routes);
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 8192];
                        let n = match socket.read(&mut buf).await {
                            Ok(n) => n,
                            Err(_) => return,
                        };
                        let request = String::from_utf8_lossy(&buf[..n]);
                        let Some(first_line) = request.lines().next() else { return };
                        let path = first_line.split_whitespace().nth(1).unwrap_or("/");
                        let Some(route) = routes.get(path) else {
                            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n").await;
                            return;
                        };
                        let mut head =
                            format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n", route.status, route.body.len());
                        for (name, value) in &route.headers {
                            head.push_str(&format!("{name}: {value}\r\n"));
                        }
                        head.push_str("\r\n");
                        let _ = socket.write_all(head.as_bytes()).await;
                        match route.split_at {
                            Some(at) if at < route.body.len() => {
                                let _ = socket.write_all(&route.body[..at]).await;
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                let _ = socket.write_all(&route.body[at..]).await;
                            }
                            _ => {
                                let _ = socket.write_all(&route.body).await;
                            }
                        }
                        let _ = socket.shutdown().await;
                    });
                }
            });
            Self { addr, _task: task }
        }

        fn url(&self, path: &str) -> Url {
            Url::parse(&format!("http://{}{}", self.addr, path)).unwrap()
        }
    }

    fn route(status: &'static str, headers: Vec<(&'static str, String)>, body: &str) -> Route {
        Route { status, headers, body: body.as_bytes().to_vec(), split_at: None }
    }

    fn html_route(body: &str) -> Route {
        route("200 OK", vec![("Content-Type", "text/html; charset=utf-8".to_string())], body)
    }

    /// Like `html_route`, but the body is sent in two separate writes split
    /// at `at`, so a server that keeps talking past `</head>` can't land in
    /// the client's very first chunk.
    fn html_route_split(body: &str, at: usize) -> Route {
        Route { split_at: Some(at), ..html_route(body) }
    }

    fn redirect_route(location: &str) -> Route {
        route("302 Found", vec![("Location", location.to_string())], "")
    }

    /// The generic `fetch_capped` run against a plain local server, with
    /// `http` and "allow everything" in place of production's `https` +
    /// address filter — see `fetch_capped_https` for what production uses.
    async fn fetch_test(
        server: &TestServer,
        path: &str,
        max_bytes: usize,
        accept: impl Fn(&str) -> bool,
        early_stop: Option<&[u8]>,
    ) -> Result<CappedFetch, FetchError> {
        fetch_capped(server.url(path), max_bytes, accept, early_stop, "http", None, |_| true).await
    }

    const ACCEPT_HTML: fn(&str) -> bool = |ct| ct.to_ascii_lowercase().contains("html");

    /// With a proxy configured, the request goes to the proxy (absolute URI)
    /// and the site's name is never resolved locally: `.invalid` can't
    /// resolve, and the address filter refuses everything.
    #[tokio::test]
    async fn a_configured_proxy_carries_the_request_without_a_local_lookup() {
        let mut routes = HashMap::new();
        routes.insert("http://site.invalid/page", html_route("<head><title>Via proxy</title></head>"));
        let proxy_server = TestServer::start(routes).await;
        let proxy = reqwest::Proxy::http(format!("http://{}", proxy_server.addr)).unwrap();

        let fetched = fetch_capped(
            Url::parse("http://site.invalid/page").unwrap(),
            MAX_HTML_BYTES,
            ACCEPT_HTML,
            None,
            "http",
            Some(&proxy),
            |_| false,
        )
        .await
        .unwrap();
        assert!(String::from_utf8_lossy(&fetched.body).contains("Via proxy"));
    }

    #[test]
    fn https_proxy_wins_over_the_lowercase_one_and_blank_means_none() {
        assert!(proxy_from(None, None).unwrap().is_none());
        assert!(proxy_from(Some("  ".into()), None).unwrap().is_none());
        assert!(proxy_from(Some("http://127.0.0.1:8080".into()), Some("not a url".into())).unwrap().is_some());
        assert!(proxy_from(None, Some("http://127.0.0.1:8080".into())).unwrap().is_some());
    }

    #[test]
    fn an_unusable_proxy_value_fails_instead_of_going_direct() {
        assert!(matches!(proxy_from(Some("::not a proxy::".into()), None), Err(FetchError::BadProxy)));
    }

    #[tokio::test]
    async fn follows_redirects_up_to_the_limit_and_fetches_the_final_page() {
        let mut routes = HashMap::new();
        routes.insert("/start", redirect_route("/hop1"));
        routes.insert("/hop1", redirect_route("/hop2"));
        routes.insert("/hop2", redirect_route("/final"));
        routes.insert("/final", html_route("<head><title>Landed</title></head>"));
        let server = TestServer::start(routes).await;

        let fetched = fetch_test(&server, "/start", MAX_HTML_BYTES, ACCEPT_HTML, None).await.unwrap();
        assert!(String::from_utf8_lossy(&fetched.body).contains("Landed"));
        assert_eq!(fetched.final_url.path(), "/final");
    }

    #[tokio::test]
    async fn gives_up_after_too_many_redirects() {
        let mut routes = HashMap::new();
        routes.insert("/start", redirect_route("/hop1"));
        routes.insert("/hop1", redirect_route("/hop2"));
        routes.insert("/hop2", redirect_route("/hop3"));
        routes.insert("/hop3", redirect_route("/hop4"));
        routes.insert("/hop4", html_route("<head><title>Too far</title></head>"));
        let server = TestServer::start(routes).await;

        let err = fetch_test(&server, "/start", MAX_HTML_BYTES, ACCEPT_HTML, None).await;
        assert!(matches!(err, Err(FetchError::TooManyRedirects)));
    }

    #[tokio::test]
    async fn rejects_a_non_html_response() {
        let mut routes = HashMap::new();
        routes.insert(
            "/plain",
            route("200 OK", vec![("Content-Type", "text/plain".to_string())], "just text"),
        );
        let server = TestServer::start(routes).await;

        let err = fetch_test(&server, "/plain", MAX_HTML_BYTES, ACCEPT_HTML, None).await;
        assert!(matches!(err, Err(FetchError::BadContentType)));
    }

    #[test]
    fn preview_images_are_restricted_to_safe_raster_types() {
        assert!(is_safe_raster_image("image/png"));
        assert!(is_safe_raster_image("image/jpeg; charset=binary"));
        assert!(is_safe_raster_image("IMAGE/WEBP"));
        assert!(!is_safe_raster_image("image/svg+xml"));
        assert!(!is_safe_raster_image("text/html"));
        assert!(!is_safe_raster_image(""));
    }

    #[tokio::test]
    async fn rejects_a_non_success_status() {
        let mut routes = HashMap::new();
        routes.insert("/missing", route("404 Not Found", vec![], "nope"));
        let server = TestServer::start(routes).await;

        let err = fetch_test(&server, "/missing", MAX_HTML_BYTES, ACCEPT_HTML, None).await;
        assert!(matches!(err, Err(FetchError::Status(404))));
    }

    #[tokio::test]
    async fn stops_reading_early_once_the_needle_is_seen() {
        let mut routes = HashMap::new();
        let head = "<head><title>T</title></head>";
        let padding = "x".repeat(500);
        let body = format!("{head}<body>{padding}</body>");
        // Split right after </head>, so the 500 bytes of padding can only
        // ever be read by a second socket read — one the early-stop check
        // must prevent.
        routes.insert("/page", html_route_split(&body, head.len()));
        let server = TestServer::start(routes).await;

        let fetched = fetch_test(&server, "/page", MAX_HTML_BYTES, ACCEPT_HTML, Some(b"</head")).await.unwrap();
        assert!(fetched.body.len() < 200, "body was {} bytes", fetched.body.len());
        assert!(String::from_utf8_lossy(&fetched.body).contains("</head"));
    }

    #[tokio::test]
    async fn caps_a_response_with_no_early_stop_marker_at_max_bytes() {
        let mut routes = HashMap::new();
        let big = "x".repeat(10_000);
        routes.insert("/big", html_route(&big));
        let server = TestServer::start(routes).await;

        let fetched = fetch_test(&server, "/big", 1024, ACCEPT_HTML, None).await.unwrap();
        assert_eq!(fetched.body.len(), 1024);
    }

    #[tokio::test]
    async fn an_https_only_redirect_target_is_rejected_in_production_mode() {
        // Exercises the *production* scheme check (not the test harness's
        // relaxed "http" mode): a redirect to a plain-http location must
        // fail required_scheme the same way the entry url would.
        let target = Url::parse("http://example.com/after-redirect").unwrap();
        assert!(require_scheme(&target, "https").is_err());
    }

    /// Real sites over the network; run by hand with `cargo test live_sites -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs the network"]
    async fn live_sites() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://x.com/signalapp",
            "https://www.instagram.com/signal_app/",
            "https://github.com/signalapp/Signal-Desktop",
            "https://en.wikipedia.org/wiki/Signal_(software)",
        ] {
            match fetch_preview(url).await {
                Ok(Some(p)) => println!("{url}: title={:?} desc={} image={}", p.title, p.description.is_some(), p.image.is_some()),
                Ok(None) => println!("{url}: no preview"),
                Err(e) => println!("{url}: error {e}"),
            }
        }
    }
}
