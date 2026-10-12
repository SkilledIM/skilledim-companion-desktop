//! Loopback auth-watch server for browser tab liveness (RFC 8252–style).
//!
//! Portal heartbeats to http://127.0.0.1:<port>/heartbeat while the Companion
//! authorize tab is open, and POSTs /closed on pagehide. Companion ends waiting
//! when the tab disconnects instead of using a hardcoded countdown.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tiny_http::{Header, Method, Response, Server, StatusCode};

#[derive(Default)]
pub struct AuthWatchState {
  inner: Mutex<Option<WatchRuntime>>,
}

struct WatchRuntime {
  port: u16,
  stop: Arc<AtomicBool>,
  last_heartbeat_ms: Arc<AtomicU64>,
  saw_heartbeat: Arc<AtomicBool>,
  closed: Arc<AtomicBool>,
  join: Option<JoinHandle<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthWatchStartResult {
  pub port: u16,
  pub watch_base_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthWatchStatus {
  pub active: bool,
  pub port: u16,
  pub last_heartbeat_ms: u64,
  pub saw_heartbeat: bool,
  pub closed: bool,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn origin_allowed(origin: &str) -> bool {
  if origin.is_empty() || origin == "null" {
    return true;
  }
  let Ok(url) = url::Url::parse(origin) else {
    return false;
  };
  let Some(host) = url.host_str() else {
    return false;
  };
  host == "localhost"
    || host == "127.0.0.1"
    || host == "portal.skilledim.com"
    || host.ends_with(".skilledim.com")
}

fn apply_cors(response: &mut Response<std::io::Cursor<Vec<u8>>>, origin: Option<&str>) {
  let allow_origin = origin
    .filter(|o| origin_allowed(o))
    .unwrap_or("*");
  if let Ok(h) = Header::from_bytes("Access-Control-Allow-Origin", allow_origin) {
    response.add_header(h);
  }
  if let Ok(h) = Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS") {
    response.add_header(h);
  }
  if let Ok(h) = Header::from_bytes(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Request-Private-Network",
  ) {
    response.add_header(h);
  }
  if let Ok(h) = Header::from_bytes("Access-Control-Allow-Private-Network", "true") {
    response.add_header(h);
  }
}

fn query_param(url: &str, key: &str) -> Option<String> {
  let query = url.split_once('?')?.1;
  for pair in query.split('&') {
    let mut parts = pair.splitn(2, '=');
    let k = parts.next()?;
    let v = parts.next().unwrap_or("");
    if k == key {
      return Some(percent_decode(v));
    }
  }
  None
}

fn form_or_json_state(body: &str) -> Option<String> {
  if body.contains('=') && !body.trim_start().starts_with('{') {
    for pair in body.split('&') {
      let mut parts = pair.splitn(2, '=');
      let k = parts.next()?;
      let v = parts.next().unwrap_or("");
      if k == "state" {
        return Some(percent_decode(v));
      }
    }
  }
  if let Some(rest) = body.split("\"state\"").nth(1) {
    return rest.split('"').nth(1).map(|s| s.to_string());
  }
  None
}

fn read_body(request: &mut tiny_http::Request) -> String {
  let mut buf = Vec::new();
  let reader = request.as_reader();
  let _ = std::io::Read::read_to_end(reader, &mut buf);
  String::from_utf8_lossy(&buf).into_owned()
}

fn percent_encode(value: &str) -> String {
  let mut out = String::new();
  for b in value.as_bytes() {
    match *b {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
      _ => out.push_str(&format!("%{b:02X}")),
    }
  }
  out
}

fn percent_decode(value: &str) -> String {
  let bytes = value.as_bytes();
  let mut out = Vec::new();
  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'+' => {
        out.push(b' ');
        i += 1;
      }
      b'%' if i + 2 < bytes.len() => {
        let hex = &value[i + 1..i + 3];
        if let Ok(v) = u8::from_str_radix(hex, 16) {
          out.push(v);
          i += 3;
        } else {
          out.push(b'%');
          i += 1;
        }
      }
      c => {
        out.push(c);
        i += 1;
      }
    }
  }
  String::from_utf8_lossy(&out).into_owned()
}

fn respond_json(
  request: tiny_http::Request,
  status: StatusCode,
  origin: Option<&str>,
  body: &str,
) {
  let mut response = Response::from_string(body.to_string()).with_status_code(status);
  apply_cors(&mut response, origin);
  if let Ok(h) = Header::from_bytes("Content-Type", "application/json; charset=utf-8") {
    response.add_header(h);
  }
  let _ = request.respond(response);
}

fn respond_html(
  request: tiny_http::Request,
  status: StatusCode,
  origin: Option<&str>,
  body: &str,
) {
  let mut response = Response::from_string(body.to_string()).with_status_code(status);
  apply_cors(&mut response, origin);
  if let Ok(h) = Header::from_bytes("Content-Type", "text/html; charset=utf-8") {
    response.add_header(h);
  }
  let _ = request.respond(response);
}

#[tauri::command]
pub fn auth_watch_start(
  app: AppHandle,
  watch: State<'_, AuthWatchState>,
  state: String,
) -> Result<AuthWatchStartResult, String> {
  if state.trim().is_empty() {
    return Err("Missing auth state".into());
  }

  let _ = auth_watch_stop(watch.clone());

  let server = Server::http("127.0.0.1:0").map_err(|e| format!("Auth watch bind failed: {e}"))?;
  let ip = server.server_addr().to_ip().ok_or("Auth watch address is not IP")?;
  let port = ip.port();

  let stop = Arc::new(AtomicBool::new(false));
  let last_heartbeat_ms = Arc::new(AtomicU64::new(0));
  let saw_heartbeat = Arc::new(AtomicBool::new(false));
  let closed = Arc::new(AtomicBool::new(false));
  let expected_state = state;

  let stop_t = Arc::clone(&stop);
  let last_t = Arc::clone(&last_heartbeat_ms);
  let saw_t = Arc::clone(&saw_heartbeat);
  let closed_t = Arc::clone(&closed);
  let expected_t = expected_state.clone();
  let app_t = app;

  let join = thread::spawn(move || {
    while !stop_t.load(Ordering::SeqCst) {
      let mut request = match server.recv_timeout(std::time::Duration::from_millis(400)) {
        Ok(Some(r)) => r,
        Ok(None) => continue,
        Err(_) => break,
      };

      let origin = request
        .headers()
        .iter()
        .find(|h| format!("{}", h.field).eq_ignore_ascii_case("Origin"))
        .map(|h| format!("{}", h.value));
      let origin_ref = origin.as_deref();
      let method = request.method().clone();
      let url = request.url().to_string();
      let path = url.split('?').next().unwrap_or(url.as_str());

      if method == Method::Options {
        let mut response = Response::from_string("").with_status_code(StatusCode(204));
        apply_cors(&mut response, origin_ref);
        let _ = request.respond(response);
        continue;
      }

      let body = if method == Method::Post {
        read_body(&mut request)
      } else {
        String::new()
      };

      let provided = query_param(&url, "state").or_else(|| form_or_json_state(&body));

      if path == "/heartbeat" {
        if provided.as_deref() != Some(expected_t.as_str()) {
          respond_json(
            request,
            StatusCode(403),
            origin_ref,
            "{\"ok\":false,\"error\":\"state\"}",
          );
          continue;
        }
        last_t.store(now_ms(), Ordering::SeqCst);
        saw_t.store(true, Ordering::SeqCst);
        let _ = app_t.emit("companion-auth-tab-heartbeat", ());
        respond_json(request, StatusCode(200), origin_ref, "{\"ok\":true}");
        continue;
      }

      if path == "/closed" {
        if provided.as_deref() == Some(expected_t.as_str()) {
          closed_t.store(true, Ordering::SeqCst);
          let _ = app_t.emit("companion-auth-tab-closed", ());
        }
        respond_json(request, StatusCode(200), origin_ref, "{\"ok\":true}");
        continue;
      }

      if path == "/callback" {
        let token = query_param(&url, "token").or_else(|| query_param(&url, "access_token"));
        let cb_state = query_param(&url, "state");
        if let (Some(token), Some(cb_state)) = (token, cb_state) {
          if cb_state == expected_t {
            let deep = format!(
              "skilledim-companion://auth/callback?token={}&state={}",
              percent_encode(&token),
              percent_encode(&cb_state)
            );
            // Emit once to the app — do not also navigate a deep-link iframe
            // (that caused a second callback and "No pending login" after success).
            let _ = app_t.emit("companion-auth-callback", deep);
            let html = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>SkilledIM Companion</title>
  <style>
    body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;
      align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0}
    p{opacity:.9}
  </style>
</head>
<body>
  <p id="msg">Signed in — returning to SkilledIM Companion…</p>
  <script>
    (function () {
      function closeTab() {
        try { window.open('', '_self'); } catch (e) {}
        try { window.close(); } catch (e) {}
        var el = document.getElementById('msg');
        if (el) el.textContent = 'Signed in. You can close this tab.';
      }
      setTimeout(closeTab, 200);
      setTimeout(closeTab, 800);
    })();
  </script>
</body>
</html>"#;
            respond_html(request, StatusCode(200), origin_ref, html);
            continue;
          }
        }
        respond_json(request, StatusCode(400), origin_ref, "{\"ok\":false}");
        continue;
      }

      respond_json(request, StatusCode(404), origin_ref, "{\"ok\":false}");
    }
  });

  let mut guard = watch
    .inner
    .lock()
    .map_err(|_| "Auth watch lock poisoned".to_string())?;
  *guard = Some(WatchRuntime {
    port,
    stop,
    last_heartbeat_ms,
    saw_heartbeat,
    closed,
    join: Some(join),
  });

  Ok(AuthWatchStartResult {
    port,
    watch_base_url: format!("http://127.0.0.1:{port}"),
  })
}

#[tauri::command]
pub fn auth_watch_stop(watch: State<'_, AuthWatchState>) -> Result<(), String> {
  let mut guard = watch
    .inner
    .lock()
    .map_err(|_| "Auth watch lock poisoned".to_string())?;
  if let Some(mut runtime) = guard.take() {
    runtime.stop.store(true, Ordering::SeqCst);
    // Wake blocking recv by connecting once if needed — timeout loop exits on stop flag.
    let _ = std::net::TcpStream::connect(format!("127.0.0.1:{}", runtime.port));
    if let Some(join) = runtime.join.take() {
      let _ = join.join();
    }
  }
  Ok(())
}

#[tauri::command]
pub fn auth_watch_status(watch: State<'_, AuthWatchState>) -> Result<AuthWatchStatus, String> {
  let guard = watch
    .inner
    .lock()
    .map_err(|_| "Auth watch lock poisoned".to_string())?;
  Ok(match guard.as_ref() {
    Some(runtime) => AuthWatchStatus {
      active: true,
      port: runtime.port,
      last_heartbeat_ms: runtime.last_heartbeat_ms.load(Ordering::SeqCst),
      saw_heartbeat: runtime.saw_heartbeat.load(Ordering::SeqCst),
      closed: runtime.closed.load(Ordering::SeqCst),
    },
    None => AuthWatchStatus {
      active: false,
      port: 0,
      last_heartbeat_ms: 0,
      saw_heartbeat: false,
      closed: false,
    },
  })
}
