use super::*;
use std::sync::{Arc, Mutex};

/// A server, its authorization server and the token endpoint in one: what it was asked is recorded.
struct Fake {
    base: String,
    token_forms: Arc<Mutex<Vec<String>>>,
}

fn fake(register: bool) -> Fake {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let token_forms = Arc::new(Mutex::new(vec![]));
    let (b, forms) = (base.clone(), token_forms.clone());
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let json = |v: Value| {
                tiny_http::Response::from_string(v.to_string())
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
            };
            let path = req.url().to_owned();
            let reply = match path.as_str() {
                "/mcp" => tiny_http::Response::from_string("{}").with_status_code(401).with_header(
                    tiny_http::Header::from_bytes(
                        "WWW-Authenticate",
                        format!("Bearer resource_metadata=\"{b}/.well-known/oauth-protected-resource/mcp\""),
                    )
                    .unwrap(),
                ),
                "/.well-known/oauth-protected-resource/mcp" => json(json!({ "authorization_servers": [b] })),
                "/.well-known/oauth-authorization-server" => {
                    let mut m = json!({ "authorization_endpoint": format!("{b}/authorize"), "token_endpoint": format!("{b}/token"), "scopes_supported": ["read", "write"] });
                    if register {
                        m["registration_endpoint"] = json!(format!("{b}/register"));
                    }
                    json(m)
                }
                "/register" => json(json!({ "client_id": "client-1" })),
                "/token" => {
                    let mut body = String::new();
                    std::io::Read::read_to_string(req.as_reader(), &mut body).unwrap();
                    forms.lock().unwrap().push(body.clone());
                    if body.contains("grant_type=refresh_token") {
                        json(json!({ "access_token": "at-2", "expires_in": 3600 }))
                    } else {
                        json(json!({ "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600 }))
                    }
                }
                _ => tiny_http::Response::from_string("").with_status_code(404),
            };
            let _ = req.respond(reply);
        }
    });
    Fake { base, token_forms }
}

/// What a browser does: follow the authorization URL's redirect back to yaah with a code.
#[allow(clippy::unnecessary_wraps, reason = "login takes a fallible opener")]
fn browser(url: &str) -> Result<(), String> {
    let u = reqwest::Url::parse(url).unwrap();
    let q: BTreeMap<_, _> = u.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["client_id"], "client-1");
    assert_eq!(q["scope"], "read write");
    assert!(q["resource"].ends_with("/mcp"));
    let back = format!("{}?code=the-code&state={}", q["redirect_uri"], q["state"]);
    tokio::spawn(async move {
        let _ = reqwest::get(back).await;
    });
    Ok(())
}

#[test]
fn reads_the_metadata_url_out_of_the_header() {
    assert_eq!(resource_metadata_url(r#"Bearer realm="x", resource_metadata="https://a/b""#).as_deref(), Some("https://a/b"));
    assert_eq!(resource_metadata_url("Bearer resource_metadata=https://a/b, error=x").as_deref(), Some("https://a/b"));
    assert_eq!(resource_metadata_url("Bearer"), None);
}

#[test]
fn the_challenge_is_the_hash_of_the_verifier() {
    let (verifier, challenge) = pkce();
    assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
    assert!(verifier.len() >= 43, "RFC 7636: 43 to 128 characters");
}

#[tokio::test]
async fn logs_in_stores_the_tokens_and_refreshes_them() {
    let f = fake(true);
    let url = format!("{}/mcp", f.base);
    assert!(!logged_in("fake", &url));
    login("fake", &url, browser).await.unwrap();
    assert!(logged_in("fake", &url));
    assert_eq!(bearer("fake", &url).as_deref(), Some("at-1"));
    assert_eq!(bearer("fake", "http://elsewhere/mcp"), None, "a login is for the URL it was made at");
    let form = f.token_forms.lock().unwrap()[0].clone();
    assert!(form.contains("grant_type=authorization_code") && form.contains("code=the-code") && form.contains("code_verifier="), "{form}");

    assert!(refresh("fake").await.unwrap());
    assert_eq!(bearer("fake", &url).as_deref(), Some("at-2"));
    assert_eq!(store().read::<File>()["fake"].refresh_token.as_deref(), Some("rt-1"), "the refresh token is kept when the server sends none");

    logout("fake").unwrap();
    assert!(!logged_in("fake", &url));
    assert!(!refresh("fake").await.unwrap());
}

#[tokio::test]
async fn says_why_when_it_cannot_register() {
    let f = fake(false);
    let e = login("noreg", &format!("{}/mcp", f.base), browser).await.unwrap_err();
    assert!(e.contains("registration endpoint"), "{e}");
}

#[tokio::test]
async fn a_wrong_state_is_not_a_login() {
    let f = fake(true);
    let url = format!("{}/mcp", f.base);
    // The browser answers with someone else's state; then, within the window, with the right one.
    let open = |auth: &str| {
        let u = reqwest::Url::parse(auth).unwrap();
        let q: BTreeMap<_, _> = u.query_pairs().into_owned().collect();
        let (redirect, state) = (q["redirect_uri"].clone(), q["state"].clone());
        tokio::spawn(async move {
            let bad = reqwest::get(format!("{redirect}?code=evil&state=wrong")).await.unwrap();
            assert_eq!(bad.status(), 400);
            let _ = reqwest::get(format!("{redirect}?code=good&state={state}")).await;
        });
        Ok(())
    };
    login("state", &url, open).await.unwrap();
    assert!(f.token_forms.lock().unwrap()[0].contains("code=good"));
    logout("state").unwrap();
}
