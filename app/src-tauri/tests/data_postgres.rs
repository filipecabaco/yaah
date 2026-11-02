//! `postgres.*` sources against a real database: the demo container
//! (`yaah-pg-demo`, 127.0.0.1:54329, database `shop`) or `YAAH_PG_TEST_URL`
//! (a superuser URL). yaah only connects as a read-only role, so the tests
//! create `yaah_ro` there with the superuser and run yaah as it.
//! Every test skips (passes, with a note) when neither answers.

use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;
use yaah_lib::sources::Sources;

const DEMO: &str = "postgres://postgres:yaahdemo@127.0.0.1:54329/shop";

fn admin_url() -> String {
    std::env::var("YAAH_PG_TEST_URL").unwrap_or_else(|_| DEMO.into())
}

/// The admin URL with another user and password.
fn as_role(admin: &str, user: &str, password: &str) -> String {
    let mut url = reqwest::Url::parse(admin).unwrap();
    url.set_username(user).unwrap();
    url.set_password(Some(password)).unwrap();
    url.into()
}

/// Run `sql` as the superuser; retried, since tests (and test processes) create the same roles at once.
async fn as_admin(sql: &str) -> Result<(), String> {
    let (client, conn) = tokio_postgres::connect(&admin_url(), tokio_postgres::NoTls).await.map_err(|e| e.to_string())?;
    tokio::spawn(conn);
    let mut attempt = 0;
    loop {
        match client.batch_execute(sql).await {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 3 => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(e) => return Err(e.to_string()),
        }
        attempt += 1;
    }
}

/// Create a login role if it's missing, then run `grants`; returns its URL.
async fn role(name: &str, password: &str, grants: &str) -> Result<String, String> {
    as_admin(&format!(
        "do $$ begin if not exists (select from pg_roles where rolname = '{name}') then \
         create role {name} login password '{password}'; end if; end $$; {grants}"
    ))
    .await?;
    Ok(as_role(&admin_url(), name, password))
}

/// `yaah_ro`: what the README tells users to create.
async fn read_only_url() -> Result<String, String> {
    role("yaah_ro", "yaahro", "grant pg_read_all_data to yaah_ro").await
}

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("yaah-data-pg-{}-{}", std::process::id(), yaah_lib::session::random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Sources with one saved connection, `shop`, or `None` when there's no database to test against.
async fn shop() -> Option<(Sources, PathBuf)> {
    let dir = temp_dir();
    let sources = Sources::with_connections_file(dir.join("connections.json"));
    let added = match read_only_url().await {
        Ok(url) => sources.add_connection("shop", &url).await,
        Err(e) => Err(e),
    };
    match added {
        Ok(_) => Some((sources, dir)),
        Err(e) => {
            eprintln!("skipped: no Postgres to test against ({e})");
            None
        }
    }
}

async fn query(s: &Sources, sql: &str, limit: Option<u64>) -> Result<Value, String> {
    let mut source = json!({ "kind": "postgres.query", "connection": "shop", "sql": sql });
    if let Some(l) = limit {
        source["limit"] = json!(l);
    }
    s.read(&source).await
}

#[tokio::test]
async fn rows_keep_their_types_and_the_querys_column_order() {
    let Some((s, _)) = shop().await else { return };
    let v = query(
        &s,
        "select p.category, count(*)::int as orders, sum(o.quantity * p.price_cents) / 100.0 as revenue \
         from orders o join products p on p.id = o.product_id group by 1 order by 3 desc;",
        None,
    )
    .await
    .unwrap();
    assert_eq!(v["columns"], json!(["category", "orders", "revenue"]));
    assert!(v["rows"].as_array().unwrap().len() >= 2);
    assert!(v["rows"][0]["orders"].is_number(), "types survive: {}", v["rows"][0]);
    assert_eq!(v["truncated"], false);

    // A trailing line comment doesn't push the query off the typed path.
    let v = query(&s, "select 1 as one -- the answer", None).await.unwrap();
    assert_eq!(v["rows"], json!([{ "one": 1 }]));
}

#[tokio::test]
async fn results_stop_at_the_row_limit() {
    let Some((s, _)) = shop().await else { return };
    let v = query(&s, "select * from generate_series(1, 50) n", Some(10)).await.unwrap();
    assert_eq!((v["rows"].as_array().unwrap().len(), &v["truncated"]), (10, &json!(true)));
    let v = query(&s, "select * from generate_series(1, 20000) n", Some(1_000_000)).await.unwrap();
    assert_eq!(v["rows"].as_array().unwrap().len(), 10_000, "never more than 10,000 rows, whatever is asked");
    let v = query(&s, "select * from generate_series(1, 3) n", Some(3)).await.unwrap();
    assert_eq!(v["truncated"], false, "exactly the limit isn't truncated");
}

#[tokio::test]
async fn runs_read_only_with_a_timeout_on_both_paths() {
    let Some((s, _)) = shop().await else { return };
    let text = |v: Value| v["rows"][0].as_object().unwrap().values().next().unwrap().as_str().unwrap().to_owned();
    // The wrapped (typed) path and the as-written path (SHOW) are both inside the same guard.
    assert_eq!(text(query(&s, "select current_setting('transaction_read_only') as ro", None).await.unwrap()), "on");
    assert_eq!(text(query(&s, "show transaction_read_only", None).await.unwrap()), "on");
    assert_eq!(text(query(&s, "show statement_timeout", None).await.unwrap()), "15s");
    let plan = query(&s, "explain select * from orders", None).await.unwrap();
    assert_eq!(plan["columns"], json!(["QUERY PLAN"]));
}

#[tokio::test]
async fn writes_and_escapes_are_refused() {
    let Some((s, _)) = shop().await else { return };
    let count = || async { query(&s, "select count(*)::int as n from products", None).await.unwrap()["rows"][0]["n"].as_i64().unwrap() };
    let before = count().await;

    let refused_by_postgres = [
        "insert into products (name, category, price_cents) values ('x', 'y', 1) returning id",
        "update products set price_cents = 0",
        "delete from orders",
        "with gone as (delete from orders returning *) select count(*) from gone",
        "select set_config('transaction_read_only', 'off', true)",
    ];
    for sql in refused_by_postgres {
        let e = query(&s, sql, None).await.unwrap_err();
        assert!(e.contains("read-only") || e.contains("read-write"), "{sql}: {e}");
    }
    let refused_by_yaah = [
        ("create table hacked (id int)", "`create` statements aren't run here"),
        ("copy (select 1) to program 'touch /tmp/yaah-pwned'", "`copy` statements aren't run here"),
        ("/* hide */ do $$ begin perform 1; end $$", "`do` statements aren't run here"),
        ("set transaction read write", "`set` statements aren't run here"),
        ("commit", "`commit` statements aren't run here"),
    ];
    for (sql, why) in refused_by_yaah {
        let e = query(&s, sql, None).await.unwrap_err();
        assert!(e.contains(why), "{sql}: {e}");
    }
    // One statement at a time: a second can't end the read-only transaction.
    let e = query(&s, "select 1; commit; delete from orders", None).await.unwrap_err();
    assert!(e.contains("multiple commands"), "{e}");
    assert_eq!(count().await, before, "nothing was written");
}

#[tokio::test]
async fn reads_the_schema() {
    let Some((s, _)) = shop().await else { return };
    let schema = s.read(&json!({ "kind": "postgres.schema", "connection": "shop" })).await.unwrap();
    let tables: Vec<&str> = schema["tables"].as_array().unwrap().iter().filter_map(|t| t["table"].as_str()).collect();
    for t in ["customers", "orders", "products"] {
        assert!(tables.contains(&t), "{t} in {tables:?}");
    }
    let products = schema["tables"].as_array().unwrap().iter().find(|t| t["table"] == "products").unwrap();
    let columns: Vec<&str> = products["columns"].as_array().unwrap().iter().filter_map(|c| c["name"].as_str()).collect();
    assert!(columns.starts_with(&["id"]) && columns.contains(&"price_cents"), "{columns:?}");
}

#[tokio::test]
async fn errors_say_what_is_wrong() {
    let Some((s, _)) = shop().await else { return };
    assert!(query(&s, "select from nowhere_at_all", None).await.unwrap_err().contains("does not exist"));
    assert_eq!(query(&s, " ; ", None).await.unwrap_err(), "empty query");
    let e = s.read(&json!({ "kind": "postgres.query", "connection": "prod", "sql": "select 1" })).await.unwrap_err();
    assert!(e.contains("no connection named `prod`") && e.contains("shop"), "{e}");
    assert_eq!(s.read(&json!({ "kind": "postgres.query", "connection": "shop" })).await.unwrap_err(), "postgres.query needs `sql`");
}

#[tokio::test]
async fn connections_are_tested_saved_privately_and_shown_without_credentials() {
    use std::os::unix::fs::PermissionsExt;
    let Some((s, dir)) = shop().await else { return };
    let file = dir.join("connections.json");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    let shown = serde_json::to_string(&s.connections()).unwrap();
    assert!(shown.contains("\"name\":\"shop\"") && !shown.contains("yaahro") && !shown.contains("yaah_ro"), "{shown}");

    let e = s.add_connection("shop2", "postgres://postgres:wrong@127.0.0.1:54329/shop").await.unwrap_err();
    assert!(e.starts_with("couldn't connect:") && !e.contains("wrong"), "{e}");
    assert!(s.add_connection("bad name", DEMO).await.unwrap_err().contains("letters, digits"));
    assert_eq!(s.connections().len(), 1, "a connection that doesn't work isn't saved");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn superusers_and_server_file_roles_are_refused() {
    let Some((s, dir)) = shop().await else { return };
    let e = s.add_connection("admin", &admin_url()).await.unwrap_err();
    assert!(e.contains("`postgres`") && e.contains("superuser") && e.contains("CREATE ROLE yaah_ro") && e.contains("pg_read_all_data"), "{e}");
    // A predefined role that reaches the server's files counts too, granted directly or not.
    let files = role("yaah_files", "yaahfiles", "grant pg_read_server_files to yaah_files").await.unwrap();
    let e = s.add_connection("files", &files).await.unwrap_err();
    assert!(e.contains("pg_read_server_files"), "{e}");
    let via = role("yaah_via_super", "yaahvia", "grant postgres to yaah_via_super").await.unwrap();
    assert!(s.add_connection("via", &via).await.unwrap_err().contains("superuser"), "a member of a superuser can SET ROLE to it");
    assert_eq!(s.connections().len(), 1, "only the read-only one was saved");

    // A superuser connection saved before this check (by hand, or an older yaah) runs nothing.
    let file = dir.join("connections.json");
    std::fs::write(&file, json!({ "connections": [{ "name": "old", "url": admin_url() }] }).to_string()).unwrap();
    let e = s.read(&json!({ "kind": "postgres.query", "connection": "old", "sql": "select pg_read_file('/etc/hostname')" })).await.unwrap_err();
    assert!(e.contains("superuser") && e.contains("CREATE ROLE"), "{e}");
    assert!(s.read(&json!({ "kind": "postgres.schema", "connection": "old" })).await.unwrap_err().contains("superuser"));
    // Don't leave roles with these powers (and known passwords) behind.
    as_admin("drop role if exists yaah_files; drop role if exists yaah_via_super").await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_read_only_role_cant_read_server_files_or_end_sessions() {
    let Some((s, _)) = shop().await else { return };
    for sql in [
        "select pg_read_file('/etc/hostname')",
        "select pg_read_binary_file('/etc/passwd')",
        "select * from pg_ls_dir('.')",
        "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'postgres' and pid <> pg_backend_pid()",
    ] {
        match query(&s, sql, None).await {
            Err(e) => assert!(e.contains("permission denied"), "{sql}: {e}"),
            // No other session to end right now: nothing was ended either.
            Ok(v) => assert!(
                sql.contains("pg_terminate_backend")
                    && v["rows"].as_array().unwrap().iter().all(|r| r.as_object().unwrap().values().all(|b| b != true)),
                "{sql}: {v}"
            ),
        }
    }
}
