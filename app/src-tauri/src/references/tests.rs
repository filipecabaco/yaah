//! Tokens, links, ranking and content as pure functions; then reading and
//! suggesting against a local stand-in for GitHub, GitLab and Linear (shapes of
//! their real answers), with real git repos for the chat's scope.

use super::*;
use crate::integrations::tests::{Req, instance, mock};
use std::sync::{Arc, Mutex};

fn ids(text: &str) -> Vec<(String, Option<Kind>)> {
    tokens(text).into_iter().map(|t| (t.text(), t.kind)).collect()
}

// ── tokens ──────────────────────────────────────────────────────────────────

#[test]
fn finds_tokens_for_every_service() {
    assert_eq!(
        ids("see github#acme/api#9, gitlab#team/sub/api!45 and gitlab#team/api#7 (linear#eng-12)."),
        vec![
            ("github#acme/api#9".into(), None),
            ("gitlab#team/sub/api!45".into(), Some(Kind::Mr)),
            ("gitlab#team/api#7".into(), Some(Kind::Issue)),
            ("linear#ENG-12".into(), Some(Kind::Issue)),
        ],
        "Linear keys are upper case"
    );
    // Where it starts and ends in the text, for whoever needs to mark it.
    let text = "fix github#acme/api#9 now";
    let t = &tokens(text)[0];
    assert_eq!(&text[t.start..t.end], "github#acme/api#9");
    // A token ends at punctuation, even GitLab's `!` after the number.
    assert_eq!(ids("is gitlab#team/api!45!")[0].0, "gitlab#team/api!45");
    assert_eq!(ids("GitHub#Acme/Api#009")[0].0, "github#Acme/Api#9", "the prefix in any case; the number canonical");
}

#[test]
fn ignores_what_isnt_a_token() {
    for text in [
        "github#acme#9",           // no repo
        "github#acme/api",         // no number
        "github#acme/api!9",       // `!` is GitLab's
        "github#acme/../x#1",      // not a path
        "xgithub#acme/api#9",      // inside a word
        "`github#acme/api#9`",     // code stays code
        "github#acme/api#9x",      // runs into a word
        "github#acme/api#0",       // no issue 0
        "linear#ENG",              // no number
        "linear#-12",              // no team
        "gitlab#api#7",            // one segment
        "#acme/api#9 and C# code", // no service
        "github#acme/api#1234567890",
    ] {
        assert_eq!(ids(text), vec![], "{text}");
    }
}

#[test]
fn reads_links_as_tokens() {
    let link = |url: &str, base: Option<&str>| parse_link(url, base).map(|t| (t.text(), t.kind));
    assert_eq!(link("https://github.com/acme/api/pull/9/files", None), Some(("github#acme/api#9".into(), Some(Kind::Pr))));
    assert_eq!(link("<https://github.com/acme/api/issues/12#issuecomment-1>", None), Some(("github#acme/api#12".into(), Some(Kind::Issue))));
    assert_eq!(link("https://linear.app/acme/issue/eng-12/fix-it", None), Some(("linear#ENG-12".into(), Some(Kind::Issue))));
    assert_eq!(link("https://gitlab.com/team/sub/api/-/merge_requests/45/diffs", None), Some(("gitlab#team/sub/api!45".into(), Some(Kind::Mr))));
    let base = Some("https://git.example.com/gitlab");
    assert_eq!(
        link("https://git.example.com/gitlab/team/api/-/issues/7", base),
        Some(("gitlab#team/api#7".into(), Some(Kind::Issue))),
        "an instance under a path"
    );
    // Another GitLab than the connected one, or a page that isn't an item.
    assert_eq!(link("https://gitlab.com/team/api/-/issues/7", base), None);
    for url in ["https://github.com/acme/api", "https://example.com/a/-/issues/1", "github#acme/api#9", "ftp://github.com/a/b/pull/1"] {
        assert_eq!(link(url, None), None, "{url}");
    }
}

// ── ranking ─────────────────────────────────────────────────────────────────

fn r(service: WorkService, id: &str, title: &str, scope: &str, updated: &str) -> Reference {
    Reference {
        service,
        kind: Kind::Issue,
        id: id.into(),
        token: token_of(service, id),
        title: title.into(),
        url: String::new(),
        state: "open".into(),
        status: None,
        scope: scope.into(),
        updated_at: Some(updated.into()),
        error: None,
    }
}

fn c(reference: Reference, tier: Tier, found: bool) -> Candidate {
    Candidate { reference, tier, found }
}

fn order(list: &[Reference]) -> Vec<&str> {
    list.iter().map(|r| r.id.as_str()).collect()
}

#[test]
fn ranks_the_chats_repos_first_then_yours_then_recency() {
    let gh = WorkService::Github;
    let all = vec![
        c(r(gh, "me/other#1", "Webhook docs", "me/other", "2026-11-03"), Tier::Yours, false),
        c(r(gh, "acme/api#2", "Webhook retries", "acme/api", "2026-11-01"), Tier::Here, false),
        c(r(gh, "acme/api#3", "Old webhook bug", "acme/api", "2026-10-01"), Tier::Here, false),
        c(r(gh, "x/y#4", "Unrelated", "x/y", "2026-11-04"), Tier::Elsewhere, false),
    ];
    assert_eq!(order(&rank(all.clone(), "", 10)), ["acme/api#2", "acme/api#3", "me/other#1", "x/y#4"], "no query: tier, then newest");
    // Recent items must match; a closer match wins within a tier.
    assert_eq!(order(&rank(all.clone(), "webhook", 10)), ["acme/api#2", "acme/api#3", "me/other#1"]);
    // Letters scattered through a title come after real matches, whatever the tier.
    let loose = vec![
        c(r(gh, "acme/api#5", "Write each bhook", "acme/api", "2026-11-04"), Tier::Here, false),
        c(r(gh, "me/other#6", "webhook", "me/other", "2026-10-01"), Tier::Yours, false),
    ];
    assert_eq!(order(&rank(loose, "webhook", 10)), ["me/other#6", "acme/api#5"]);
    // What the service found stays even when the row doesn't show why (it matched the body).
    let found = vec![c(r(gh, "acme/api#7", "Retry storms", "acme/api", "2026-11-02"), Tier::Here, true)];
    assert_eq!(order(&rank(found, "idempotency", 10)), ["acme/api#7"]);
}

#[test]
fn an_exact_id_or_number_comes_first_and_duplicates_merge() {
    let gh = WorkService::Github;
    let all = vec![
        c(r(gh, "acme/api#212", "Webhooks", "acme/api", "2026-11-01"), Tier::Yours, false),
        c(r(gh, "acme/api#12", "Totals", "acme/api", "2026-10-01"), Tier::Here, true),
        c(r(WorkService::Linear, "ENG-12", "Cents", "ENG", "2026-09-01"), Tier::Elsewhere, true),
        // The same item from another list: the better tier wins, it counts once.
        c(r(gh, "acme/api#212", "Webhooks", "acme/api", "2026-11-01"), Tier::Here, true),
    ];
    let ranked = rank(all.clone(), "#12", 10);
    assert_eq!(order(&ranked)[..2], ["acme/api#12", "ENG-12"], "both are number 12");
    assert_eq!(ranked.iter().filter(|r| r.id == "acme/api#212").count(), 1);
    assert_eq!(order(&rank(all.clone(), "eng-12", 10))[0], "ENG-12");
    assert_eq!(order(&rank(all, "github#acme/api#212", 10))[0], "acme/api#212");
    let many: Vec<Candidate> = (1..=50).map(|n| c(r(gh, &format!("a/b#{n}"), "t", "a/b", "2026"), Tier::Here, false)).collect();
    assert_eq!(rank(many, "", LIMIT).len(), LIMIT);
}

#[test]
fn fuzzy_scores_like_the_frontend() {
    // Mirrors src/lib/fuzzy.ts, so the instant filter there and this one agree.
    assert!((fuzzy("", "x") - 1.0).abs() < f64::EPSILON);
    assert!((fuzzy("abc", "abc") - 1000.0).abs() < f64::EPSILON);
    assert!((fuzzy("ab", "abcd") - 496.0).abs() < f64::EPSILON);
    assert!((fuzzy("cd", "abcd") - 298.0).abs() < f64::EPSILON);
    assert!((fuzzy("ad", "abcd") - 49.6).abs() < 1e-9);
    assert!(fuzzy("zz", "abcd").abs() < f64::EPSILON);
}

// ── content ─────────────────────────────────────────────────────────────────

fn resolved(token: &str, url: &str, md: Option<&str>, error: Option<&str>) -> Resolved {
    let t = &tokens(token)[0];
    let mut reference = r(t.service, &t.id, "A title", "acme/api", "2026");
    reference.url = url.into();
    reference.error = error.map(str::to_owned);
    Resolved { reference, markdown: md.map(str::to_owned) }
}

#[test]
fn content_follows_the_agents_capabilities() {
    let refs = [
        resolved("github#acme/api#9", "https://github.com/acme/api/pull/9", Some("# acme/api#9 Fix"), None),
        resolved("linear#ENG-1", "", Some("# ENG-1 Cents"), None),
        resolved("gitlab#team/api!4", "", None, Some("GitLab: not found")),
    ];
    let embedded = content(&refs, true);
    assert_eq!(embedded.before.len(), 2);
    assert_eq!(
        embedded.before[0],
        json!({ "type": "resource", "resource": { "uri": "https://github.com/acme/api/pull/9", "mimeType": "text/markdown", "text": "# acme/api#9 Fix" } })
    );
    assert_eq!(embedded.before[1]["resource"]["uri"], "linear://ENG-1", "no URL: a URI of its own");
    assert_eq!(
        embedded.after,
        vec![json!({ "type": "text", "text": "[yaah couldn't read gitlab#team/api!4: GitLab: not found. Its details aren't attached.]" })]
    );
    assert_eq!(embedded.chips.iter().map(|c| c.token.as_str()).collect::<Vec<_>>(), ["github#acme/api#9", "linear#ENG-1", "gitlab#team/api!4"]);
    assert_eq!(embedded.chips[2].error.as_deref(), Some("GitLab: not found"));

    let plain = content(&refs, false);
    assert!(plain.before.is_empty(), "nothing embedded");
    assert_eq!(plain.after.len(), 3);
    assert_eq!(plain.after[0]["text"], "Referenced github#acme/api#9 (read by yaah from GitHub):\n\n# acme/api#9 Fix");
    assert!(plain.after[2]["text"].as_str().unwrap().starts_with("[yaah couldn't read gitlab#team/api!4"));
}

#[test]
fn references_together_stay_within_the_cap() {
    let big = "x".repeat(TOTAL_CHARS - 10);
    let refs = [
        resolved("github#a/b#1", "https://github.com/a/b/issues/1", Some(&big), None),
        resolved("github#a/b#2", "https://github.com/a/b/issues/2", Some(&"y".repeat(500)), None),
        resolved("github#a/b#3", "https://github.com/a/b/issues/3", Some("z"), None),
    ];
    let out = content(&refs, true);
    let text = |i: usize| out.before[i]["resource"]["text"].as_str().unwrap().to_owned();
    assert_eq!(text(0), big);
    assert!(text(1).starts_with("yyyyyyyyyy…"), "what's left of the cap");
    assert!(text(1).contains("at most 60000 characters"));
    assert!(text(2).contains("(cut:"), "nothing left");
    let total: usize = (0..3).map(|i| text(i).chars().count()).sum();
    assert!(total < TOTAL_CHARS + 300, "{total}");
}

// ── reading and suggesting, against the stand-in APIs ───────────────────────

const SECRET_GH: &str = "ghp_secret_do_not_leak";
const SECRET_GL: &str = "glpat-secret_do_not_leak";
const SECRET_LIN: &str = "lin_api_secret_do_not_leak";

fn gh_issue_node(repo: &str, n: u64, title: &str, state: &str, updated: &str) -> Value {
    json!({ "__typename": "Issue", "number": n, "title": title, "url": format!("https://github.com/{repo}/issues/{n}"), "state": state,
            "stateReason": null, "updatedAt": updated, "repository": { "nameWithOwner": repo } })
}

fn gh_pr_node(repo: &str, n: u64, title: &str, state: &str, draft: bool, updated: &str) -> Value {
    json!({ "__typename": "PullRequest", "number": n, "title": title, "url": format!("https://github.com/{repo}/pull/{n}"), "state": state,
            "isDraft": draft, "updatedAt": updated, "repository": { "nameWithOwner": repo } })
}

fn gl_mr(reference: &str, title: &str, state: &str, updated: &str) -> Value {
    let (p, n) = reference.rsplit_once('!').unwrap();
    json!({ "iid": n.parse::<u64>().unwrap(), "title": title, "state": state, "draft": false, "updated_at": updated,
            "web_url": format!("https://gitlab.example.com/{p}/-/merge_requests/{n}"), "references": { "full": reference } })
}

fn gl_issue(reference: &str, title: &str, updated: &str) -> Value {
    let (p, n) = reference.rsplit_once('#').unwrap();
    json!({ "iid": n.parse::<u64>().unwrap(), "title": title, "state": "opened", "updated_at": updated, "description": "Rotate the keys.",
            "web_url": format!("https://gitlab.example.com/{p}/-/issues/{n}"), "references": { "full": reference },
            "author": { "name": "Grace" }, "labels": ["security"] })
}

fn lin_node(id: &str, title: &str, kind: &str, name: &str) -> Value {
    json!({ "identifier": id, "title": title, "url": format!("https://linear.app/acme/issue/{id}/x"), "updatedAt": "2026-10-31T00:00:00.000Z",
            "state": { "name": name, "type": kind }, "team": { "key": id.split('-').next().unwrap() } })
}

/// GitHub, GitLab (self-managed) and Linear answering what references read. Returns the base URL and every request.
#[allow(clippy::too_many_lines, reason = "one stand-in for three services")]
fn trackers() -> (String, Arc<Mutex<Vec<String>>>) {
    mock(|r: &Req| {
        let path = r.path.to_lowercase();
        match path.as_str() {
            "/api.github.com/graphql" => {
                let (q, v) = r.graphql();
                assert!(q.trim_start().starts_with("query"), "only queries: {q}");
                assert_eq!(r.auth.as_deref(), Some(format!("Bearer {SECRET_GH}").as_str()));
                if q.contains("pullRequest(number") {
                    return (
                        200,
                        json!({ "data": { "repository": { "pullRequest": {
                        "number": 9, "title": "Retry webhooks once", "state": "OPEN", "isDraft": false, "url": "https://github.com/acme/api/pull/9",
                        "body": "Moves the idempotency key before the handler.", "additions": 40, "deletions": 3, "changedFiles": 2,
                        "updatedAt": "2026-11-03T08:00:00Z", "reviewDecision": "CHANGES_REQUESTED", "author": { "login": "ghopper" },
                        "headRefName": "fix/webhook-retries", "baseRefName": "main", "labels": { "nodes": [{ "name": "bug" }] },
                        "reviews": { "nodes": [{ "author": { "login": "alan-t" }, "state": "CHANGES_REQUESTED", "body": "Add a test.", "submittedAt": "2026-11-03T09:00:00Z" }] },
                        "comments": { "nodes": [] },
                        "files": { "nodes": [{ "path": "src/webhooks.rs", "additions": 30, "deletions": 3 }, { "path": "tests/webhooks.rs", "additions": 10, "deletions": 0 }] },
                        "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                            { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS" } ] } } } }] }
                    } } } }),
                    );
                }
                if q.contains("issueOrPullRequest(number: $n)") {
                    let item = match (v["r"].as_str(), v["n"].as_u64()) {
                        (Some("api"), Some(9)) => json!({ "__typename": "PullRequest", "number": 9 }),
                        (Some("api"), Some(12)) => {
                            json!({ "__typename": "Issue", "number": 12, "title": "Totals before tax", "url": "https://github.com/acme/api/issues/12",
                            "body": "The invoice shows totals before tax.", "state": "CLOSED", "stateReason": "NOT_PLANNED", "updatedAt": "2026-11-01T00:00:00Z",
                            "author": { "login": "alan-t" }, "assignees": { "nodes": [{ "login": "ghopper" }] }, "labels": { "nodes": [{ "name": "billing" }] },
                            "comments": { "nodes": [{ "author": { "login": "ghopper" }, "body": "Won't fix: tax is shown below.", "createdAt": "2026-11-01T00:00:00Z" }] } })
                        }
                        _ => {
                            return (
                                200,
                                json!({ "data": { "repository": null }, "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to an issue or pull request with the number of 404." }] }),
                            );
                        }
                    };
                    return (200, json!({ "data": { "repository": { "nameWithOwner": "acme/api", "issueOrPullRequest": item } } }));
                }
                if q.contains("d0: repository") {
                    assert_eq!(v["n0"], 12);
                    return (
                        200,
                        json!({ "data": { "d0": { "issueOrPullRequest": gh_issue_node("acme/api", 12, "Totals before tax", "OPEN", "2026-10-01T00:00:00Z") } } }),
                    );
                }
                if q.contains("search(") {
                    let here = v["here"].as_str().unwrap_or("");
                    let mine = v["mine"].as_str().unwrap();
                    assert!(mine.contains("involves:@me"), "{mine}");
                    let pr9 = gh_pr_node("acme/api", 9, "Retry webhooks once", "OPEN", false, "2026-11-03T08:00:00Z");
                    // Recent in the chat's repo; `retry` finds #9 there.
                    let here_nodes = if here.starts_with("repo:") {
                        assert_eq!(here, "repo:acme/api sort:updated-desc");
                        vec![pr9, gh_pr_node("acme/api", 8, "Old draft", "OPEN", true, "2026-10-03T08:00:00Z")]
                    } else if here.starts_with("retry ") {
                        vec![pr9]
                    } else {
                        vec![]
                    };
                    return (
                        200,
                        json!({ "data": { "here": { "nodes": here_nodes }, "mine": { "nodes": [
                        gh_issue_node("me/notes", 3, "Retry notes", "OPEN", "2026-11-04T00:00:00Z"),
                        gh_pr_node("acme/api", 9, "Retry webhooks once", "MERGED", false, "2026-11-03T08:00:00Z"),
                    ] } } }),
                    );
                }
                (400, json!({ "errors": [{ "message": "unexpected query" }] }))
            }
            p if p.starts_with("/gitlab.example.com/api/v4/") => {
                assert_eq!(r.auth.as_deref(), Some(format!("Bearer {SECRET_GL}").as_str()));
                match p.trim_start_matches("/gitlab.example.com/api/v4") {
                    "/projects/team%2fapi/merge_requests/45" => (
                        200,
                        json!({
                            "iid": 45, "title": "Rotate keys", "state": "opened", "draft": true, "description": "Rotates every key.",
                            "web_url": "https://gitlab.example.com/team/api/-/merge_requests/45", "references": { "full": "team/api!45" },
                            "author": { "name": "Grace" }, "source_branch": "rotate", "target_branch": "main", "labels": ["security"],
                            "changes_count": "2", "updated_at": "2026-11-02T00:00:00Z", "detailed_merge_status": "draft_status",
                        }),
                    ),
                    "/projects/team%2fapi/merge_requests/45/approvals" => (200, json!({ "approvals_left": 1, "approved_by": [] })),
                    "/projects/team%2fapi/merge_requests/45/diffs" => (
                        200,
                        json!([
                            { "new_path": "keys.rs", "old_path": "keys.rs", "diff": "@@ -1 +1,2 @@\n-old\n+new\n+more\n" },
                            { "new_path": "README.md", "old_path": "README.md", "diff": "+docs\n" },
                        ]),
                    ),
                    "/projects/team%2fapi/issues/7" => (200, gl_issue("team/api#7", "Rotate keys yearly", "2026-10-29T10:00:00Z")),
                    "/projects/team%2fapi/issues/7/notes" | "/issues" => (200, json!([])),
                    "/projects/team%2fapi/merge_requests" => (200, json!([gl_mr("team/api!45", "Rotate keys", "opened", "2026-11-02T00:00:00Z")])),
                    "/projects/team%2fapi/issues" => (200, json!([gl_issue("team/api#7", "Rotate keys yearly", "2026-10-29T10:00:00Z")])),
                    "/merge_requests" => (200, json!([gl_mr("grace/site!3", "Keys page", "merged", "2026-11-04T00:00:00Z")])),
                    _ => (404, json!({ "message": "404 Not found" })),
                }
            }
            "/api.linear.app/graphql" => {
                let (q, v) = r.graphql();
                assert!(q.trim_start().starts_with("query"), "only queries: {q}");
                assert_eq!(r.auth.as_deref(), Some(SECRET_LIN), "a Linear key goes as is");
                if q.contains("issue(id") {
                    if v["id"] == "ENG-404" {
                        return (200, json!({ "data": null, "errors": [{ "message": "Entity not found: Issue" }] }));
                    }
                    return (
                        200,
                        json!({ "data": { "issue": {
                        "identifier": "ENG-12", "title": "Cents get lost", "url": "https://linear.app/acme/issue/ENG-12/cents", "description": "Round half to even.",
                        "state": { "name": "In Review", "type": "started" }, "assignee": { "name": "Ana" }, "creator": { "name": "Grace" },
                        "team": { "key": "ENG", "name": "Engineering" }, "labels": { "nodes": [{ "name": "bug" }] }, "children": { "nodes": [] },
                        "attachments": { "nodes": [] }, "comments": { "nodes": [] }, "updatedAt": "2026-10-31T00:00:00.000Z",
                    } } }),
                    );
                }
                if q.contains("assigned: issues") {
                    assert_eq!(v["assigned"]["assignee"], json!({ "isMe": { "eq": true } }));
                    return (
                        200,
                        json!({ "data": { "assigned": { "nodes": [lin_node("ENG-12", "Cents get lost", "started", "In Review")] },
                        "created": { "nodes": [] }, "team": { "nodes": [lin_node("OPS-3", "Rotate certs", "completed", "Done")] } } }),
                    );
                }
                if q.contains("found: issues") {
                    assert_eq!(v["found"]["title"]["containsIgnoreCase"], "certs");
                    return (200, json!({ "data": { "found": { "nodes": [lin_node("OPS-3", "Rotate certs", "completed", "Done")] } } }));
                }
                (400, json!({ "errors": [{ "message": "unexpected query" }] }))
            }
            _ => (404, json!({ "message": "Not Found" })),
        }
    })
}

fn connected(base: &str) -> &'static Integrations {
    let i = instance(base, 0);
    i.put("github", json!({ "api_key": SECRET_GH })).unwrap();
    i.put("linear", json!({ "api_key": SECRET_LIN })).unwrap();
    i.put("gitlab", json!({ "api_key": SECRET_GL, "base_url": "https://gitlab.example.com" })).unwrap();
    i
}

fn leaks(text: &str) -> bool {
    [SECRET_GH, SECRET_GL, SECRET_LIN].iter().any(|s| text.contains(s))
}

#[tokio::test]
async fn reads_every_kind_of_reference() {
    let (base, _) = trackers();
    let i = connected(&base);
    let text =
        "Compare github#acme/api#9 with github#acme/api#12, gitlab#team/api!45, gitlab#team/api#7 and linear#eng-12. Also github#acme/api#9 again.";
    let out = resolve_text(i, text).await;
    let chips: Vec<_> = out.iter().map(|r| (r.reference.token.as_str(), r.reference.kind, r.reference.state.as_str())).collect();
    assert_eq!(
        chips,
        [
            ("github#acme/api#9", Kind::Pr, "open"),
            ("github#acme/api#12", Kind::Issue, "closed"),
            ("gitlab#team/api!45", Kind::Mr, "draft"),
            ("gitlab#team/api#7", Kind::Issue, "open"),
            ("linear#ENG-12", Kind::Issue, "open"),
        ],
        "each once, in order"
    );
    let md = |n: usize| out[n].markdown.clone().unwrap();
    // A PR: branch, review, checks, files, body, the latest review.
    for want in [
        "# acme/api#9 Retry webhooks once",
        "**Source:** GitHub pull request: https://github.com/acme/api/pull/9",
        "**Author:** ghopper",
        "**Branch:** fix/webhook-retries → main",
        "**Review:** Changes requested",
        "**Checks:** 1 passed",
        "**Labels:** bug",
        "**Changes:** +40 −3",
        "## Changed files (2)",
        "- src/webhooks.rs (+30 −3)",
        "Moves the idempotency key",
        "**alan-t** (changes requested): Add a test.",
    ] {
        assert!(md(0).contains(want), "{want} in\n{}", md(0));
    }
    // An issue goes through the brief's block, with its author and smaller caps.
    assert_eq!(out[1].reference.status.as_deref(), Some("Not planned"));
    for want in [
        "# acme/api#12 Totals before tax",
        "**Status:** Not planned",
        "**Assignee:** ghopper",
        "**Author:** alan-t",
        "**Labels:** billing",
        "Won't fix",
    ] {
        assert!(md(1).contains(want), "{want} in\n{}", md(1));
    }
    // A merge request: branch, approvals, files counted from the diffs.
    for want in [
        "# team/api!45 Rotate keys",
        "**State:** draft",
        "**Branch:** rotate → main",
        "**Review:** 1 approval needed",
        "- keys.rs (+2 −1)",
        "- README.md (+1 −0)",
    ] {
        assert!(md(2).contains(want), "{want} in\n{}", md(2));
    }
    assert!(md(3).contains("# team/api#7 Rotate keys yearly") && md(3).contains("**Author:** Grace"), "{}", md(3));
    assert_eq!(out[4].reference.status.as_deref(), Some("In Review"));
    assert!(md(4).contains("# ENG-12 Cents get lost") && md(4).contains("**Author:** Grace") && md(4).contains("Round half to even."), "{}", md(4));
    assert_eq!(out[4].reference.url, "https://linear.app/acme/issue/ENG-12/cents");

    // Nothing anyone sees holds a credential.
    let c = content(&out, true);
    let all = serde_json::to_string(&(c.before, c.after, c.chips)).unwrap();
    assert!(!leaks(&all), "{all}");
}

#[tokio::test]
async fn a_reference_that_cant_be_read_goes_with_a_note() {
    let (base, _) = trackers();
    let i = connected(&base);
    let out = resolve_text(i, "github#acme/api#404 and linear#ENG-404 and gitlab#team/api!99").await;
    assert!(out.iter().all(|r| r.markdown.is_none()));
    let errors: Vec<_> = out.iter().map(|r| r.reference.error.clone().unwrap()).collect();
    assert!(errors[0].starts_with("GitHub: Could not resolve"), "{errors:?}");
    assert_eq!(errors[1], "Linear: Entity not found: Issue");
    assert_eq!(errors[2], "GitLab: not found");
    assert!(errors.iter().all(|e| !leaks(e)));
    let c = content(&out, false);
    assert_eq!(c.after.len(), 3);
    assert!(c.after[1]["text"].as_str().unwrap().contains("couldn't read linear#ENG-404: Linear: Entity not found: Issue"));

    // Not connected: said plainly, never a credential.
    let none = instance(&base, 0);
    let out = resolve_text(none, "github#acme/api#9").await;
    let e = out[0].reference.error.as_deref().unwrap();
    assert!(e.contains("isn't connected") || e.contains("connect"), "{e}");
}

#[tokio::test]
async fn reads_at_most_ten_per_message() {
    let (base, seen) = trackers();
    let i = connected(&base);
    let text: Vec<String> = (1..=12).map(|n| format!("github#acme/nope#{n}")).collect();
    let out = resolve_text(i, &text.join(" ")).await;
    assert_eq!(out.len(), 12);
    // Asked by number, not by counting requests: under a loaded test run other requests can land
    // in the log too, which made a plain count flaky.
    let asked: Vec<u64> =
        (1..=12).filter(|n| seen.lock().unwrap().iter().any(|r| [",", "}"].iter().any(|end| r.contains(&format!("\"n\":{n}{end}"))))).collect();
    assert_eq!(asked, (1..=MAX_REFERENCES as u64).collect::<Vec<_>>(), "the first ten are read, the last two aren't");
    assert_eq!(out[11].reference.error.as_deref(), Some("not read: a message reads at most 10 references"));
    assert_eq!(resolve_text(i, "no references here").await.len(), 0);
}

fn scope() -> Scope {
    Scope { github: vec!["acme/api".into()], gitlab: vec!["team/api".into()], linear_team: Some("OPS".into()) }
}

#[tokio::test]
async fn suggests_from_every_connected_service() {
    let (base, seen) = trackers();
    let i = connected(&base);
    let cache = Cache::default();
    let s = suggest(i, &scope(), None, "", &cache).await;
    assert!(s.errors.is_empty(), "{:?}", s.errors);
    assert_eq!(s.connected, [WorkService::Github, WorkService::Gitlab, WorkService::Linear]);
    let tokens: Vec<&str> = s.items.iter().map(|r| r.token.as_str()).collect();
    // The chat's repos and team first (newest first), then yours.
    assert_eq!(
        tokens,
        [
            "github#acme/api#9",
            "gitlab#team/api!45",
            "linear#OPS-3",
            "gitlab#team/api#7",
            "github#acme/api#8",
            "github#me/notes#3",
            "gitlab#grace/site!3",
            "linear#ENG-12"
        ]
    );
    let pr = &s.items[0];
    assert_eq!((pr.kind, pr.state.as_str(), pr.scope.as_str(), pr.title.as_str()), (Kind::Pr, "open", "acme/api", "Retry webhooks once"));
    assert_eq!(s.items[4].state, "draft");
    assert_eq!(s.items[2].status.as_deref(), Some("Done"));

    // Opening the list again within a minute asks nothing.
    let before = seen.lock().unwrap().len();
    let again = suggest(i, &scope(), None, "", &cache).await;
    assert_eq!(again.items, s.items);
    assert_eq!(seen.lock().unwrap().len(), before, "answered from the cache");

    // One service, searched: `retry` matches recent ones and what GitHub finds.
    let gh = suggest(i, &scope(), Some(WorkService::Github), "retry", &cache).await;
    assert_eq!(gh.connected, [WorkService::Github]);
    assert_eq!(gh.items.iter().map(|r| r.token.as_str()).collect::<Vec<_>>(), ["github#acme/api#9", "github#me/notes#3"]);
    let linear = suggest(i, &scope(), Some(WorkService::Linear), "certs", &cache).await;
    assert_eq!(linear.items.iter().map(|r| r.token.as_str()).collect::<Vec<_>>(), ["linear#OPS-3"]);
}

#[tokio::test]
async fn numbers_ids_and_links_look_the_item_up() {
    let (base, seen) = trackers();
    let i = connected(&base);
    let cache = Cache::default();
    let s = suggest(i, &scope(), Some(WorkService::Github), "12", &cache).await;
    assert_eq!(s.items[0].token, "github#acme/api#12", "number 12 in the chat's repo");
    let gl = suggest(i, &scope(), Some(WorkService::Gitlab), "!45", &cache).await;
    assert_eq!(gl.items[0].token, "gitlab#team/api!45");
    assert!(
        seen.lock().unwrap().iter().any(|r| r.starts_with("/gitlab.example.com/api/v4/projects/team%2Fapi/merge_requests/45?")),
        "{:?}",
        seen.lock().unwrap()
    );
    let link = suggest(i, &scope(), None, "https://github.com/acme/api/pull/9", &cache).await;
    assert_eq!(link.items.len(), 1);
    assert_eq!((link.items[0].token.as_str(), link.items[0].title.as_str()), ("github#acme/api#9", "Retry webhooks once"));
    // A link to anything else isn't searched for.
    let before = seen.lock().unwrap().len();
    assert_eq!(suggest(i, &scope(), None, "https://example.com/x", &cache).await.items, []);
    assert_eq!(seen.lock().unwrap().len(), before);
}

#[tokio::test]
async fn nothing_connected_says_so() {
    let (base, seen) = trackers();
    let none = instance(&base, 0);
    let s = suggest(none, &scope(), None, "retry", &Cache::default()).await;
    assert!(s.connected.is_empty() && s.items.is_empty() && s.errors.is_empty());
    let only_linear = instance(&base, 0);
    only_linear.put("linear", json!({ "api_key": SECRET_LIN })).unwrap();
    assert_eq!(suggest(only_linear, &scope(), Some(WorkService::Github), "", &Cache::default()).await.connected, []);
    assert!(seen.lock().unwrap().is_empty(), "nothing asked");
}

#[tokio::test]
async fn a_failing_service_is_reported_without_hiding_the_others() {
    let (base, _) = mock(|r: &Req| {
        if r.path.starts_with("/api.github.com") {
            (403, json!({ "message": "API rate limit exceeded" }))
        } else {
            (200, json!({ "data": { "assigned": { "nodes": [lin_node("ENG-12", "Cents", "started", "In Progress")] }, "created": { "nodes": [] } } }))
        }
    });
    let i = instance(&base, 0);
    i.put("github", json!({ "api_key": SECRET_GH })).unwrap();
    i.put("linear", json!({ "api_key": SECRET_LIN })).unwrap();
    let s = suggest(i, &Scope::default(), None, "", &Cache::default()).await;
    assert_eq!(s.items.iter().map(|r| r.token.as_str()).collect::<Vec<_>>(), ["linear#ENG-12"]);
    assert_eq!(s.errors.len(), 1);
    assert_eq!((s.errors[0].service, s.errors[0].kind), (WorkService::Github, work_items::ErrorKind::RateLimited));
    assert!(!leaks(&serde_json::to_string(&s).unwrap()));
}

#[test]
fn the_scope_comes_from_the_chats_clones_and_its_project() {
    let root = std::env::temp_dir().join(format!("yaah-refs-{}", crate::session::random_token()));
    let clone = |name: &str, origin: &str| {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&dir).output().unwrap().status.success());
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", origin]);
        dir
    };
    let roots = vec![
        clone("api", "git@github.com:Acme/API.git"),
        clone("infra", "ssh://git@gitlab.example.com:2222/team/sub/infra.git"),
        clone("elsewhere", "https://gitlab.com/x/y.git"),
        root.join("not-a-repo"),
        root.join(".yaah/projects/p1"),
    ];
    let s = Scope::of(&roots, "gitlab.example.com", Some(("linear", "eng-142")));
    assert_eq!(s, Scope { github: vec!["acme/api".into()], gitlab: vec!["team/sub/infra".into()], linear_team: Some("ENG".into()) });
    let s = Scope::of(&roots[..1], "gitlab.example.com", Some(("github", "acme/web#3")));
    assert_eq!(s.github, ["acme/api", "acme/web"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn entries_keep_their_references() {
    // A chat saved before references existed reads; one with them keeps them.
    let old: crate::session::Entry = serde_json::from_value(json!({ "type": "user", "text": "hi", "attachments": [] })).unwrap();
    assert!(matches!(old, crate::session::Entry::User { references, .. } if references.is_empty()));
    let mut chip = r(WorkService::Github, "acme/api#9", "Fix", "acme/api", "2026");
    chip.error = Some("GitHub: not found".into());
    let entry = crate::session::Entry::User { text: "github#acme/api#9".into(), attachments: vec![], files: vec![], references: vec![chip.clone()] };
    let v = serde_json::to_value(&entry).unwrap();
    assert_eq!(v["references"][0]["token"], "github#acme/api#9");
    assert_eq!(v["references"][0]["kind"], "issue");
    assert_eq!(v["references"][0]["error"], "GitHub: not found");
    let back: crate::session::Entry = serde_json::from_value(v).unwrap();
    assert!(matches!(back, crate::session::Entry::User { references, .. } if references == [chip]));
}
