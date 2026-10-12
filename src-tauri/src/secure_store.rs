use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::command;

const SERVICE: &str = "com.skilledim.companion";
const TOKEN_ACCOUNT: &str = "access_token";
const PENDING_ACCOUNT: &str = "pending_auth";
const PROFILE_ACCOUNT: &str = "user_profile";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuth {
    pub state: String,
    pub created_at: i64,
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn set_secret(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn get_secret(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_secret(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
pub fn secure_store_token(token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Token must not be empty".into());
    }
    set_secret(TOKEN_ACCOUNT, token.trim())
}

#[command]
pub fn secure_load_token() -> Result<Option<String>, String> {
    get_secret(TOKEN_ACCOUNT)
}

#[command]
pub fn secure_clear_token() -> Result<(), String> {
    delete_secret(TOKEN_ACCOUNT)
}

#[command]
pub fn secure_store_pending_auth(pending: PendingAuth) -> Result<(), String> {
    let json = serde_json::to_string(&pending).map_err(|e| e.to_string())?;
    set_secret(PENDING_ACCOUNT, &json)
}

#[command]
pub fn secure_load_pending_auth() -> Result<Option<PendingAuth>, String> {
    match get_secret(PENDING_ACCOUNT)? {
        None => Ok(None),
        Some(raw) => {
            let pending = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            Ok(Some(pending))
        }
    }
}

#[command]
pub fn secure_clear_pending_auth() -> Result<(), String> {
    delete_secret(PENDING_ACCOUNT)
}

/// Non-secret profile cache used only to restore UI quickly after relaunch.
/// Access tokens are never written here.
#[command]
pub fn secure_store_profile(profile_json: String) -> Result<(), String> {
    set_secret(PROFILE_ACCOUNT, &profile_json)
}

#[command]
pub fn secure_load_profile() -> Result<Option<String>, String> {
    get_secret(PROFILE_ACCOUNT)
}

#[command]
pub fn secure_clear_profile() -> Result<(), String> {
    delete_secret(PROFILE_ACCOUNT)
}

#[command]
pub fn secure_clear_all() -> Result<(), String> {
    secure_clear_token()?;
    secure_clear_pending_auth()?;
    secure_clear_profile()?;
    Ok(())
}
