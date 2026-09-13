use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn main() {
    let arg = env::args().nth(1).unwrap_or_else(|| "cm-pre-tool".into());
    let phase = if arg.contains("post") { "post" } else { "pre" };
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let raw = stdin.trim();
    let input = if raw.is_empty() || !raw.starts_with('{') { "{}" } else { raw };
    if phase == "pre" && fast_allow_pre(input) {
        println!("{{}}");
        return;
    }
    if phase == "post" && fast_allow_post(input) {
        println!("{{}}");
        return;
    }
    let enriched = enrich_input(input);
    let body = format!(
        r#"{{"phase":"{phase}","input":{enriched},"client":"cmhook","v":1}}"#
    );
    match hook_post(&body) {
        Ok(out) => println!("{}", sanitize(&out, phase)),
        Err(_) => minimal(phase),
    }
}

fn minimal(phase: &str) {
    if phase == "pre" {
        println!("{}", allow_payload());
    } else {
        println!("{{}}");
    }
}

/// Dual envelope: Cursor reads flat `permission`; Qoder reads `hookSpecificOutput`. Each host
/// ignores the other's keys — emit both from one binary.
fn allow_payload() -> &'static str {
    r#"{"permission":"allow","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#
}

fn merge_hook_specific(inner: &str, hso: &str) -> String {
    let t = inner.trim();
    if t == "{}" {
        return format!(r#"{{"hookSpecificOutput":{}}}"#, hso);
    }
    let body = t.strip_suffix('}').unwrap_or(t);
    format!(r#"{},"hookSpecificOutput":{}}}"#, body, hso)
}

/// Raw JSON value text for `key`: string literals keep their original escaping, objects and
/// arrays are balanced out. Splicing the source slice straight through avoids needing a JSON
/// parser (and a re-escaper) for the pass-through fields.
fn raw_value<'a>(input: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let i = input.find(&needle)?;
    let rest = input[i + needle.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    match rest.as_bytes().first()? {
        b'"' => {
            let mut esc = false;
            for (idx, c) in rest.char_indices().skip(1) {
                if esc {
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    return Some(&rest[..=idx]);
                }
            }
            None
        }
        b'{' | b'[' => {
            let open = rest.as_bytes()[0];
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0i32;
            let mut in_str = false;
            let mut esc = false;
            for (idx, c) in rest.char_indices() {
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == '\\' {
                        esc = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                    continue;
                }
                if c as u8 == open {
                    depth += 1;
                } else if c as u8 == close {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&rest[..=idx]);
                    }
                } else if c == '"' {
                    in_str = true;
                }
            }
            None
        }
        _ => {
            let end = rest.find(|c| c == ',' || c == '}').unwrap_or(rest.len());
            Some(rest[..end].trim_end())
        }
    }
}

fn to_host_payload(payload: &str, phase: &str) -> String {
    let t = payload.trim();
    if phase == "post" {
        if let Some(u) = raw_value(t, "updated_mcp_tool_output")
            .or_else(|| raw_value(t, "updated_tool_output"))
        {
            let hso = format!(
                r#"{{"hookEventName":"PostToolUse","updatedToolOutput":{u},"updatedMCPToolOutput":{u}}}"#
            );
            return merge_hook_specific(t, &hso);
        }
        if let Some(a) = raw_value(t, "additional_context") {
            let hso = format!(r#"{{"hookEventName":"PostToolUse","additionalContext":{a}}}"#);
            return merge_hook_specific(t, &hso);
        }
        return payload.to_string();
    }
    let decision = match json_str(t, "permission") {
        Some(d) if d == "allow" || d == "deny" || d == "ask" => d,
        _ => return payload.to_string(),
    };
    let mut extra = String::new();
    if let Some(r) = raw_value(t, "agent_message").or_else(|| raw_value(t, "user_message")) {
        extra.push_str(",\"permissionDecisionReason\":");
        extra.push_str(r);
    }
    if let Some(u) = raw_value(t, "updated_input") {
        extra.push_str(",\"updatedInput\":");
        extra.push_str(u);
    }
    if let Some(a) = raw_value(t, "additional_context") {
        extra.push_str(",\"additionalContext\":");
        extra.push_str(a);
    }
    let hso = format!(
        r#"{{"hookEventName":"PreToolUse","permissionDecision":"{decision}"{extra}}}"#
    );
    merge_hook_specific(t, &hso)
}

fn sanitize(raw: &str, phase: &str) -> String {
    let t = raw.trim();
    if t.starts_with('{') && t.ends_with('}') && !t.contains("HTTP/") {
        return to_host_payload(t, phase);
    }
    if phase == "pre" {
        allow_payload().into()
    } else {
        "{}".into()
    }
}

fn enrich_input(input: &str) -> String {
    let root = env::var("CURSOR_PROJECT_DIR")
        .or_else(|_| env::var("CONTEXTMIND_PROJECT_ROOT"))
        .or_else(|_| env::var("CLAUDE_PROJECT_DIR"))
        .unwrap_or_default();
    if root.is_empty() || input.contains("\"cwd\"") {
        return input.to_string();
    }
    let esc = root.replace('\\', "\\\\").replace('"', "\\\"");
    if input == "{}" {
        return format!(r#"{{"cwd":"{esc}","workspace_roots":["{esc}"]}}"#);
    }
    format!(r#"{{"cwd":"{esc}","workspace_roots":["{esc}"],{}"#, input.trim_start_matches('{'))
}

fn json_str<'a>(input: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let i = input.find(&needle)?;
    let rest = input[i + needle.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let inner = &rest[1..];
    let end = inner.find('"')?;
    Some(&inner[..end])
}

fn lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

fn fast_allow_post(input: &str) -> bool {
    let name = json_str(input, "tool_name")
        .or_else(|| json_str(input, "toolName"))
        .map(|s| lower(s))
        .unwrap_or_default();
    name == "shell" || name.contains("shell")
}

fn fast_allow_pre(input: &str) -> bool {
    let name = json_str(input, "tool_name")
        .or_else(|| json_str(input, "toolName"))
        .map(|s| lower(s))
        .unwrap_or_default();
    if name.is_empty() {
        return false;
    }
    if name == "callmcptool" {
        return fast_allow_mcp(input);
    }
    if name == "shell" && fast_allow_shell(input) {
        return true;
    }
    if name.contains("write") || name.contains("strreplace") {
        let p = json_str(input, "path")
            .or_else(|| json_str(input, "file_path"))
            .or_else(|| json_str(input, "target"))
            .unwrap_or("");
        return !p.to_ascii_lowercase().ends_with(".java");
    }
    false
}

fn fast_allow_mcp(input: &str) -> bool {
    let args = extract_args_block(input);
    let server = lower(
        json_str(args, "server")
            .or_else(|| json_str(args, "mcp_server"))
            .unwrap_or(""),
    );
    let tool = lower(
        json_str(args, "toolName")
            .or_else(|| json_str(args, "tool_name"))
            .unwrap_or(""),
    );
    if server.contains("project-brain") && is_brain_why(&tool) {
        return true;
    }
    if server.contains("ads-mysql") {
        return true;
    }
    if server.contains("contextmind") {
        if matches!(
            tool.as_str(),
            "context_find"
                | "context_get"
                | "context_impact"
                | "context_run"
                | "context_outline"
        ) {
            return true;
        }
        if tool == "context_fetch" && !args.contains("\"full\":true") && !args.contains("\"full\": true") {
            return true;
        }
    }
    false
}

fn fast_allow_shell(input: &str) -> bool {
    let args = extract_args_block(input);
    let cmd = json_str(args, "command").unwrap_or("").trim();
    if cmd.is_empty() {
        return false;
    }
    let c = lower(cmd);
    if c.contains('|') || c.contains(';') || c.contains("&&") || c.contains('>') || c.contains('<') {
        return false;
    }
    c.starts_with("git status")
        || c.starts_with("git branch")
        || c.starts_with("git rev-parse")
        || c.starts_with("git stash list")
        || c.starts_with("git remote -v")
        || c.starts_with("git config --get")
        || c.starts_with("git log")
        || c.starts_with("git diff")
        || c.starts_with("git show")
        || c.starts_with("node .cursor/contextmind/cli.mjs doctor")
        || c.starts_with("node .cursor/contextmind/cli.mjs report")
        || c.starts_with("node .cursor/contextmind/cli.mjs start")
}

fn is_brain_why(tool: &str) -> bool {
    matches!(
        tool,
        "search_project_context"
            | "get_change_context"
            | "save_architecture_decision"
            | "save_bug_memory"
            | "record_task_outcome"
    )
}

fn extract_args_block(input: &str) -> &str {
    if let Some(i) = input.find("\"tool_input\"") {
        return slice_object(input, i + "\"tool_input\"".len());
    }
    if let Some(i) = input.find("\"arguments\"") {
        return slice_object(input, i + "\"arguments\"".len());
    }
    input
}

fn slice_object(s: &str, from: usize) -> &str {
    let rest = s.get(from..).unwrap_or(s).trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    if !rest.starts_with('{') {
        return "";
    }
    let mut depth = 0i32;
    for (i, c) in rest.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &rest[..=i];
                }
            }
            _ => {}
        }
    }
    rest
}

fn hook_post(body: &str) -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(out) = pipe_post(body) {
        let t = out.trim();
        if t.starts_with('{') && t.ends_with('}') {
            return Ok(t.to_string());
        }
    }
    http_post(body)
}

#[cfg(windows)]
fn pipe_post(body: &str) -> Result<String, Box<dyn std::error::Error>> {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(r"\\.\pipe\tokenmind-hook")?;
    let bytes = body.as_bytes();
    let len = bytes.len() as u32;
    pipe.write_all(&len.to_le_bytes())?;
    pipe.write_all(bytes)?;
    pipe.flush()?;
    let mut len_buf = [0u8; 4];
    pipe.read_exact(&mut len_buf)?;
    let n = u32::from_le_bytes(len_buf) as usize;
    if n > 8 * 1024 * 1024 {
        return Err("pipe response too large".into());
    }
    let mut buf = vec![0u8; n];
    pipe.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[cfg(not(windows))]
fn pipe_post(_body: &str) -> Result<String, Box<dyn std::error::Error>> {
    Err("no pipe".into())
}

fn http_post(body: &str) -> Result<String, Box<dyn std::error::Error>> {
    let port = read_port();
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_millis(800)))?;
    stream.set_write_timeout(Some(Duration::from_millis(800)))?;
    let req = format!(
        "POST /hook HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    if !text.contains("HTTP/1.1 200") && !text.contains("HTTP/1.0 200") {
        return Err("bad status".into());
    }
    let header_end = text.find("\r\n\r\n").ok_or("no header end")?;
    let body_bytes = &buf[header_end + 4..];
    Ok(String::from_utf8_lossy(body_bytes).trim().to_string())
}

fn read_port() -> u16 {
    if let Ok(home) = env::var("USERPROFILE") {
        let path = format!(r"{home}\.tokenmind\runtime.json");
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Some(p) = text.split("\"port\"").nth(1).and_then(|s| {
                s.split(':')
                    .nth(1)
                    .and_then(|x| x.trim().trim_matches(',').parse().ok())
            }) {
                return p;
            }
        }
    }
    18787
}
