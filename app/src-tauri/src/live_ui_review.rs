// Included inside `session.rs`'s `mod live_tests` (it reuses `run_turns`):
//
//     include!("live_ui_review.rs");
//
// The agent runs as in the app: yaah's UI server attached and its guide
// delivered by whatever routes the agent supports (`agent_guide.rs`).
//
// Six bounded prompts that push agent-built UI past the primitives yaah has
// (slides, video, PDF, 3D, drag-and-drop kanban, a saved component), one fresh
// chat each, one try each. Records every UI tool call with its arguments and
// result, the validation errors, the final trees, and the time per prompt.
//
// YAAH_LIVE_ACCOUNT=personal ANTHROPIC_MODEL=sonnet YAAH_REVIEW_MEDIA=<dir with test-pattern.mp4 and release-notes.pdf> \
//   YAAH_REVIEW_OUT=<dir> cargo test --lib live_ui_review -- --ignored --nocapture

/// A prompt's name, and its text given the chat's repo folder.
type ReviewPrompt = (&'static str, Box<dyn Fn(&std::path::Path) -> String>);

#[test]
#[ignore = "talks to a real agent and spends some of the account's usage"]
fn live_ui_review() {
    let media = PathBuf::from(std::env::var("YAAH_REVIEW_MEDIA").expect("set YAAH_REVIEW_MEDIA"));
    let out = PathBuf::from(std::env::var("YAAH_REVIEW_OUT").expect("set YAAH_REVIEW_OUT"));
    let only: Option<Vec<usize>> = std::env::var("YAAH_REVIEW_ONLY").ok().map(|s| s.split(',').filter_map(|n| n.trim().parse().ok()).collect());
    std::fs::create_dir_all(&out).unwrap();
    let prompts: Vec<ReviewPrompt> = vec![
        ("slides", Box::new(|_| "Show me a 5-slide interactive presentation about our release plan, with next/previous.".into())),
        ("video", Box::new(|repo| format!("Play this video: {}", repo.join("media/test-pattern.mp4").display()))),
        ("pdf", Box::new(|repo| format!("Show this PDF and point me at page 2: {}", repo.join("media/release-notes.pdf").display()))),
        ("cube", Box::new(|_| "Draw a 3D rotating cube".into())),
        (
            "kanban",
            Box::new(|_| {
                "Build a kanban board of these 6 tasks that I can drag between columns: \
                 write release notes, bump version, run migrations, update docs, tag release, announce on blog"
                    .into()
            }),
        ),
        ("component", Box::new(|_| "Save a reusable component for a release checklist and render it".into())),
    ];
    for (i, (name, prompt)) in prompts.iter().enumerate() {
        if only.as_ref().is_some_and(|o| !o.contains(&(i + 1))) {
            continue;
        }
        let root = std::env::temp_dir().join(format!("yaah-review-{name}-{}", random_token()));
        std::fs::create_dir_all(root.join("repo/media")).unwrap();
        let repo = root.join("repo");
        for f in ["test-pattern.mp4", "release-notes.pdf"] {
            std::fs::copy(media.join(f), repo.join("media").join(f)).unwrap();
        }
        let text = prompt(&repo);
        println!("\n=== {} {name}: {text}", i + 1);
        let started = std::time::Instant::now();
        let (run, library) = run_turns(&[text.as_str()], true, Some(root.clone()), |_, _, _| {});
        let secs = started.elapsed().as_secs_f64();
        let session_id = run
            .events
            .iter()
            .find_map(|e| e["payload"]["sessionId"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let entries: Vec<Value> = run.entries.iter().map(|e| serde_json::to_value(e).unwrap()).collect();
        let tools: Vec<Value> = entries
            .iter()
            .filter(|e| e["type"] == "tool")
            .map(|e| {
                let text = e["content"].to_string();
                json!({
                    "title": e["title"], "status": e["status"], "kind": e["kind"],
                    "input": e["rawInput"],
                    "validationError": text.contains("Fix these and call again"),
                    "result": e["content"],
                })
            })
            .collect();
        let uis: Vec<Value> = entries.iter().filter(|e| e["type"] == "ui").cloned().collect();
        let ui_calls: Vec<String> = tools
            .iter()
            .filter_map(|t| t["title"].as_str())
            .filter(|t| t.contains(ui_mcp::SERVER_NAME) || t.starts_with("ui_") || t.contains("source_read"))
            .map(str::to_owned)
            .collect();
        // How the guide reached it: attached to the first prompt, or (otherwise) through session/new.
        let guide_in_first_prompt = run.entries.iter().any(|e| matches!(e, Entry::User { attachments, .. } if attachments.iter().any(|a| a == agent_guide::ATTACHMENT)));
        let components: Vec<Value> = library
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.source != "yaah")
            .map(|c| serde_json::to_value(c).unwrap())
            .collect();
        let files: Vec<String> = walk_files(&repo).into_iter().map(|p| p.strip_prefix(&repo).unwrap().display().to_string()).collect();
        let report = json!({
            "name": name, "prompt": text, "seconds": secs, "sessionId": session_id, "cwd": repo,
            "usedYaahUi": !uis.is_empty(), "uiToolCalls": ui_calls, "guideInFirstPrompt": guide_in_first_prompt,
            "tools": tools, "uis": uis, "savedComponents": components, "filesInRepo": files,
            "agentText": entries.iter().filter(|e| e["type"] == "agent").map(|e| e["text"].clone()).collect::<Vec<_>>(),
            "permissions": entries.iter().filter(|e| e["type"] == "permission").map(|e| json!({ "title": e["title"], "chosen": e["chosen"] })).collect::<Vec<_>>(),
            "errors": entries.iter().filter(|e| e["type"] == "error").cloned().collect::<Vec<_>>(),
        });
        // Keep the pages the agent wrote (a previewed HTML file, say) next to the report.
        let keep = out.join(format!("{}-{name}-files", i + 1));
        for f in &files {
            if !f.starts_with("media/") {
                let dest = keep.join(f);
                std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
                std::fs::copy(repo.join(f), dest).unwrap();
            }
        }
        std::fs::write(out.join(format!("{}-{name}.json", i + 1)), serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!("--- {name}: {secs:.0}s, {} tool calls ({} yaah-ui), {} ui entries", tools.len(), ui_calls.len(), uis.len());
        std::fs::remove_dir_all(&root).ok();
    }
}

fn walk_files(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.file_name().is_some_and(|n| n == ".git") {
            continue;
        }
        if p.is_dir() {
            out.extend(walk_files(&p));
        } else {
            out.push(p);
        }
    }
    out
}
