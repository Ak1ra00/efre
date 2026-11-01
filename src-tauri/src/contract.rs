//! The code must match docs/IPC.md exactly: these tests read the contract and compare
//! it with the command handler, the ACL command list (build.rs), the capability file
//! and the event names.

use std::collections::BTreeSet;

const IPC_MD: &str = include_str!("../../docs/IPC.md");
const MAIN_RS: &str = include_str!("main.rs");
const BUILD_RS: &str = include_str!("../build.rs");
const CAPABILITY: &str = include_str!("../capabilities/main.json");

/// The lines of the `## <title>` section of docs/IPC.md.
fn section(title: &str) -> Vec<&'static str> {
    let heading = format!("## {title}");
    IPC_MD
        .lines()
        .skip_while(|line| line.trim() != heading)
        .skip(1)
        .take_while(|line| !line.starts_with("## "))
        .collect()
}

/// Every `` `token` `` in `text`.
fn backticked(text: &'static str) -> impl Iterator<Item = &'static str> {
    text.split('`').skip(1).step_by(2)
}

/// The first backticked cell of each table row in a section.
fn table_names(title: &str) -> Vec<&'static str> {
    section(title)
        .into_iter()
        .filter(|line| line.starts_with("| `"))
        .filter_map(|line| backticked(line).next())
        .collect()
}

pub(crate) fn documented_commands() -> Vec<&'static str> {
    table_names("Commands")
}

pub(crate) fn documented_error_codes() -> BTreeSet<&'static str> {
    section("Error codes")
        .into_iter()
        .flat_map(backticked)
        .collect()
}

/// `commands::<name>` entries of `generate_handler![...]` in main.rs.
fn handler_commands() -> Vec<&'static str> {
    let start = MAIN_RS
        .find("generate_handler![")
        .expect("main.rs registers a handler");
    let body = &MAIN_RS[start..];
    let body = &body[..body.find(']').expect("handler list ends")];
    body.split("commands::")
        .skip(1)
        .map(|entry| entry.split(',').next().unwrap_or_default().trim())
        .collect()
}

/// The `COMMANDS` list in build.rs (the app manifest). Works with CRLF checkouts too.
fn manifest_commands() -> Vec<&'static str> {
    let marker = "const COMMANDS: &[&str] = &[";
    let start = BUILD_RS.find(marker).expect("build.rs lists the commands");
    let body = &BUILD_RS[start + marker.len()..];
    let body = &body[..body.find("];").expect("list ends")];
    body.split(',')
        .map(|entry| entry.trim().trim_matches('"'))
        .filter(|entry| !entry.is_empty())
        .collect()
}

#[test]
fn the_contract_lists_the_commands() {
    let documented = documented_commands();
    assert_eq!(documented.len(), 32, "{documented:?}");
    assert_eq!(documented.first(), Some(&"app_status"));
    assert_eq!(documented.last(), Some(&"security_info"));
}

#[test]
fn handler_and_acl_list_exactly_the_documented_commands() {
    let documented = documented_commands();
    assert_eq!(
        handler_commands(),
        documented,
        "generate_handler! in main.rs"
    );
    assert_eq!(manifest_commands(), documented, "COMMANDS in build.rs");
}

#[test]
fn capability_grants_exactly_the_commands_and_event_listening() {
    let capability: serde_json::Value = serde_json::from_str(CAPABILITY).expect("valid JSON");
    assert_eq!(capability["identifier"], "main");
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(capability.get("remote").is_none(), "no remote origins");
    let granted: Vec<&str> = capability["permissions"]
        .as_array()
        .expect("permission list")
        .iter()
        .map(|p| p.as_str().expect("plain permission identifiers"))
        .collect();
    let mut expected = vec!["core:event:allow-listen", "core:event:allow-unlisten"];
    let commands: Vec<String> = documented_commands()
        .into_iter()
        .map(|c| format!("allow-{}", c.replace('_', "-")))
        .collect();
    expected.extend(commands.iter().map(String::as_str));
    assert_eq!(granted, expected);
}

#[test]
fn events_match_the_contract() {
    assert_eq!(
        table_names("Events (Rust → webview)"),
        [crate::ui::KEY_STEP_EVENT, crate::ui::LOCKED_EVENT]
    );
}

#[test]
fn the_contract_lists_the_error_codes() {
    let codes = documented_error_codes();
    for code in ["locked", "authn.cancelled", "vault.notInTrash", "clipboard"] {
        assert!(codes.contains(code), "{code} in {codes:?}");
    }
}
