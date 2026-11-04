use crate::{CredentialStore, Error, Result, ServerConnection, transport::limited};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct PendingEnrollment {
    verifier: String,
    state: String,
    request_key: String,
    enrollment_id: String,
    code: String,
    exchange_key: String,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Credentials {
    key: Vec<u8>,
    device_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    refresh_key: String,
    pending: Option<PendingEnrollment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tokens {
    device_id: String,
    token_type: String,
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrollment {
    pub enrollment_id: String,
    pub authorization_url: String,
    pub expires_in: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub server_id: String,
    pub origin: String,
    pub device_id: Option<String>,
    pub enrolled: bool,
    pub enrollment_pending: bool,
}
pub struct DeviceClient {
    pub connection: ServerConnection,
    store: Arc<dyn CredentialStore>,
    credentials: Credentials,
    account: String,
    nonce: String,
    storage_failed: Cell<bool>,
    pub(crate) reported_local: std::collections::BTreeMap<String, String>,
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    B64.encode(bytes)
}
fn sha(value: &[u8]) -> String {
    B64.encode(Sha256::digest(value))
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| Error::Protocol)
}
pub(crate) enum Body<'a> {
    Json(&'a Value),
    Bytes(&'a [u8]),
}
pub(crate) struct WireResponse {
    pub bytes: Zeroizing<Vec<u8>>,
    pub etag: Option<String>,
    pub size: Option<u64>,
    pub offset: Option<u64>,
}
impl DeviceClient {
    pub fn open(connection: ServerConnection, store: Arc<dyn CredentialStore>) -> Result<Self> {
        let account = blake3::hash(
            format!("{}\0{}", connection.origin(), connection.info.server_id).as_bytes(),
        )
        .to_hex()
        .to_string();
        let credentials = match store.read(&account)? {
            Some(bytes) => {
                if bytes.len() > 2048 {
                    return Err(Error::Limit);
                }
                serde_json::from_slice(&bytes).map_err(|_| Error::Credentials)?
            }
            None => {
                let key = SigningKey::random(&mut OsRng);
                Credentials {
                    key: key.to_bytes().to_vec(),
                    device_id: String::new(),
                    access_token: String::new(),
                    refresh_token: String::new(),
                    expires_at: 0,
                    refresh_key: String::new(),
                    pending: None,
                }
            }
        };
        if credentials.key.len() != 32 || SigningKey::from_slice(&credentials.key).is_err() {
            return Err(Error::Credentials);
        }
        let result = Self {
            connection,
            store,
            credentials,
            account,
            nonce: String::new(),
            storage_failed: Cell::new(false),
            reported_local: std::collections::BTreeMap::new(),
        };
        result.save()?;
        Ok(result)
    }
    fn save(&self) -> Result<()> {
        if self.storage_failed.get() {
            return Err(Error::Credentials);
        }
        let value =
            Zeroizing::new(serde_json::to_vec(&self.credentials).map_err(|_| Error::Credentials)?);
        let result = self.store.write(&self.account, &value);
        if result.is_err() {
            self.storage_failed.set(true);
        }
        result
    }
    pub fn status(&self) -> DeviceStatus {
        DeviceStatus {
            server_id: self.connection.info.server_id.clone(),
            origin: self.connection.origin().into(),
            device_id: (!self.credentials.device_id.is_empty())
                .then(|| self.credentials.device_id.clone()),
            enrolled: !self.credentials.refresh_token.is_empty(),
            enrollment_pending: self.credentials.pending.is_some(),
        }
    }
    fn proof(&self, method: &str, url: &str, authenticated: bool) -> Result<String> {
        let key = SigningKey::from_slice(&self.credentials.key).map_err(|_| Error::Credentials)?;
        let public = key.verifying_key().to_encoded_point(false);
        let header=B64.encode(serde_json::to_vec(&json!({"typ":"dpop+jwt","alg":"ES256","jwk":{"kty":"EC","crv":"P-256","x":B64.encode(public.x().ok_or(Error::Protocol)?),"y":B64.encode(public.y().ok_or(Error::Protocol)?)}})).map_err(|_|Error::Protocol)?);
        let uri = reqwest::Url::parse(url).map_err(|_| Error::Protocol)?;
        let mut payload = json!({"htm":method,"htu":format!("{}{}",uri.origin().ascii_serialization(),uri.path()),"iat":now()?,"jti":uuid::Uuid::new_v4().to_string()});
        if !self.nonce.is_empty() {
            payload["nonce"] = json!(self.nonce);
        }
        if authenticated {
            payload["ath"] = json!(sha(self.credentials.access_token.as_bytes()));
        }
        let body = B64.encode(serde_json::to_vec(&payload).map_err(|_| Error::Protocol)?);
        let input = format!("{header}.{body}");
        let signature: Signature = key.sign(input.as_bytes());
        Ok(format!("{input}.{}", B64.encode(signature.to_bytes())))
    }
    fn send(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        key: Option<&str>,
        authenticated: bool,
    ) -> Result<Value> {
        let response =
            self.send_raw(method, path, body.map(Body::Json), key, authenticated, None)?;
        serde_json::from_slice(&response.bytes).map_err(|_| Error::Protocol)
    }
    pub(crate) fn send_raw(
        &mut self,
        method: &str,
        path: &str,
        body: Option<Body<'_>>,
        key: Option<&str>,
        authenticated: bool,
        etag: Option<&str>,
    ) -> Result<WireResponse> {
        if self.storage_failed.get() {
            return Err(Error::Credentials);
        }
        let url = self.connection.endpoint(path)?;
        for attempt in 0..2 {
            let mut request = self
                .connection
                .client
                .request(
                    reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| Error::Protocol)?,
                    &url,
                )
                .header(
                    "DPoP",
                    sensitive(&self.proof(method, &url, authenticated)?)?,
                );
            if authenticated {
                request = request.header(
                    "Authorization",
                    sensitive(&format!("DPoP {}", self.credentials.access_token))?,
                );
            }
            if let Some(body) = &body {
                request = match body {
                    Body::Json(v) => request.json(v),
                    Body::Bytes(v) => request
                        .header("Content-Type", "application/octet-stream")
                        .body(v.to_vec()),
                };
            }
            if let Some(key) = key {
                request = request.header("Idempotency-Key", key);
            }
            if let Some(etag) = etag {
                request = request.header("If-Match", etag);
            }
            let response = request.send().map_err(|_| Error::Transport)?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|h| h.to_str().ok())
                    .filter(|v| v.len() <= 128)
                    .map(str::to_owned)
            };
            let nonce = header("DPoP-Nonce");
            let etag = header("ETag");
            let size = header("X-Blob-Size").and_then(|v| v.parse().ok());
            let offset = header("X-Blob-Offset").and_then(|v| v.parse().ok());
            let bytes = Zeroizing::new(limited(response, 16 * 1024 * 1024 + 65536)?);
            if !(200..300).contains(&status) {
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
                if status == 401 && value["code"] == "use_dpop_nonce" && attempt == 0 {
                    self.nonce = nonce.ok_or(Error::Protocol)?;
                    continue;
                }
                if status == 401 {
                    return Err(Error::Authentication);
                }
                if status == 409 && value["code"] == "HEAD_MOVED" {
                    return Err(Error::HeadMoved);
                }
                return Err(Error::Rejected(status));
            }
            return Ok(WireResponse {
                bytes,
                etag,
                size,
                offset,
            });
        }
        Err(Error::Authentication)
    }
    pub(crate) fn ready(&mut self) -> Result<()> {
        if self.credentials.expires_at <= now()?.saturating_add(30)
            || !self.credentials.refresh_key.is_empty()
        {
            self.refresh()?;
        }
        Ok(())
    }
    pub fn begin_enrollment(&mut self, name: &str, os: &str, version: &str) -> Result<Enrollment> {
        if !self.credentials.refresh_token.is_empty() {
            return Err(Error::Enrollment);
        }
        if name.is_empty()
            || name.len() > 80
            || !matches!(os, "macos" | "windows" | "linux")
            || version.len() > 32
        {
            return Err(Error::Protocol);
        }
        if self.credentials.pending.is_none() {
            self.credentials.pending = Some(PendingEnrollment {
                verifier: random(),
                state: random(),
                request_key: uuid::Uuid::new_v4().to_string(),
                enrollment_id: String::new(),
                code: String::new(),
                exchange_key: uuid::Uuid::new_v4().to_string(),
            });
            self.save()?;
        }
        let pending = self.credentials.pending.as_ref().ok_or(Error::Enrollment)?;
        let key = pending.request_key.clone();
        let body = json!({"deviceName":name,"os":os,"clientVersion":version,"codeChallenge":sha(pending.verifier.as_bytes()),"state":pending.state});
        let value = self.send(
            "POST",
            "/api/v1/auth/enrollments",
            Some(&body),
            Some(&key),
            false,
        )?;
        let enrollment: Enrollment = serde_json::from_value(value).map_err(|_| Error::Protocol)?;
        if enrollment.authorization_url
            != format!(
                "{}/enroll/{}",
                self.connection.origin(),
                enrollment.enrollment_id
            )
            || uuid::Uuid::parse_str(&enrollment.enrollment_id).is_err()
            || enrollment.expires_in > 600
        {
            return Err(Error::Protocol);
        }
        self.credentials
            .pending
            .as_mut()
            .ok_or(Error::Enrollment)?
            .enrollment_id = enrollment.enrollment_id.clone();
        self.save()?;
        Ok(enrollment)
    }
    pub fn accept_callback(&mut self, callback: &str) -> Result<DeviceStatus> {
        if callback.len() > 2048 {
            return Err(Error::Enrollment);
        }
        let url = reqwest::Url::parse(callback).map_err(|_| Error::Enrollment)?;
        if url.scheme() != "app.attuner.desktop"
            || url.host_str().is_some()
            || url.path() != "/enrollment"
            || url.fragment().is_some()
        {
            return Err(Error::Enrollment);
        }
        let pairs = url.query_pairs().collect::<Vec<_>>();
        if pairs.len() != 3
            || pairs
                .iter()
                .any(|(k, _)| !matches!(k.as_ref(), "code" | "state" | "enrollmentId"))
        {
            return Err(Error::Enrollment);
        }
        let get = |name: &str| -> Result<String> {
            let values = pairs.iter().filter(|(k, _)| k == name).collect::<Vec<_>>();
            if values.len() != 1 {
                return Err(Error::Enrollment);
            }
            Ok(values[0].1.to_string())
        };
        let code = get("code")?;
        let state = get("state")?;
        let id = get("enrollmentId")?;
        let pending = self.credentials.pending.as_mut().ok_or(Error::Enrollment)?;
        if !bool::from(pending.state.as_bytes().ct_eq(state.as_bytes()))
            || pending.enrollment_id != id
            || code.len() != 43
            || !code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::Enrollment);
        }
        pending.code = code;
        self.save()?;
        self.finish_enrollment()
    }
    pub fn finish_enrollment(&mut self) -> Result<DeviceStatus> {
        let pending = self.credentials.pending.as_ref().ok_or(Error::Enrollment)?;
        if pending.code.is_empty() {
            return Err(Error::Enrollment);
        }
        let body = json!({"grantType":"authorization_code","enrollmentId":pending.enrollment_id,"code":pending.code,"codeVerifier":pending.verifier});
        let key = pending.exchange_key.clone();
        let value = self.send("POST", "/api/v1/auth/token", Some(&body), Some(&key), false)?;
        self.apply_tokens(value)?;
        self.credentials.pending = None;
        self.save()?;
        Ok(self.status())
    }
    fn apply_tokens(&mut self, value: Value) -> Result<()> {
        let mut tokens: Tokens = serde_json::from_value(value).map_err(|_| Error::Protocol)?;
        let valid = |s: &str| {
            s.len() == 43
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        };
        if tokens.token_type != "DPoP"
            || tokens.expires_in != 300
            || uuid::Uuid::parse_str(&tokens.device_id).is_err()
            || !valid(&tokens.access_token)
            || !valid(&tokens.refresh_token)
        {
            return Err(Error::Protocol);
        }
        self.credentials.device_id = tokens.device_id.clone();
        self.credentials.access_token.zeroize();
        self.credentials.refresh_token.zeroize();
        self.credentials.access_token = std::mem::take(&mut tokens.access_token);
        self.credentials.refresh_token = std::mem::take(&mut tokens.refresh_token);
        self.credentials.expires_at = now()?
            .checked_add(tokens.expires_in)
            .ok_or(Error::Protocol)?;
        self.credentials.refresh_key.clear();
        Ok(())
    }
    pub fn refresh(&mut self) -> Result<()> {
        if self.credentials.refresh_token.is_empty() {
            return Err(Error::Authentication);
        }
        if self.credentials.refresh_key.is_empty() {
            self.credentials.refresh_key = uuid::Uuid::new_v4().to_string();
            self.save()?;
        }
        let body =
            json!({"grantType":"refresh_token","refreshToken":self.credentials.refresh_token});
        let key = self.credentials.refresh_key.clone();
        let value = self.send("POST", "/api/v1/auth/token", Some(&body), Some(&key), false)?;
        self.apply_tokens(value)?;
        self.save()
    }
    pub fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        key: Option<&str>,
    ) -> Result<Value> {
        self.ready()?;
        self.send(method, path, body, key, true)
    }
    pub fn sign_out(&mut self) -> Result<()> {
        self.request("POST", "/api/v1/auth/device-logout", Some(&json!({})), None)?;
        self.store.delete(&self.account)?;
        self.credentials.access_token.zeroize();
        self.credentials.refresh_token.zeroize();
        self.credentials.device_id.clear();
        Ok(())
    }
    /// Forget only this previously verified server's OS entry, without network access.
    /// This is not server-side revocation and must be presented as such by the host.
    pub fn erase_saved_credential(
        origin: &str,
        server_id: &str,
        store: &dyn CredentialStore,
    ) -> Result<()> {
        let url = reqwest::Url::parse(origin).map_err(|_| Error::Protocol)?;
        if origin.len() > 512
            || url.scheme() != "https"
            || url.origin().ascii_serialization() != origin
            || uuid::Uuid::parse_str(server_id).is_err()
        {
            return Err(Error::Protocol);
        }
        let account = blake3::hash(format!("{origin}\0{server_id}").as_bytes())
            .to_hex()
            .to_string();
        store.delete(&account)
    }
    pub fn erase_local_credential(self) -> Result<()> {
        self.store.delete(&self.account)
    }
}
fn sensitive(text: &str) -> Result<reqwest::header::HeaderValue> {
    let mut value = reqwest::header::HeaderValue::from_str(text).map_err(|_| Error::Protocol)?;
    value.set_sensitive(true);
    Ok(value)
}
#[cfg(test)]
mod forgetting_tests {
    use super::*;
    use std::sync::Mutex;
    struct OnlyDelete(Mutex<Vec<String>>);
    impl CredentialStore for OnlyDelete {
        fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
            panic!("Offline forgetting must not read secrets")
        }
        fn write(&self, _: &str, _: &[u8]) -> Result<()> {
            panic!("Offline forgetting must not replace credentials")
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.lock().unwrap().push(account.into());
            Ok(())
        }
    }
    #[test]
    fn offline_forgetting_deletes_only_the_previously_verified_server_entry() {
        let store = OnlyDelete(Mutex::new(vec![]));
        let id = "33333333-3333-4333-8333-333333333333";
        assert!(DeviceClient::erase_saved_credential("http://unsafe.invalid", id, &store).is_err());
        assert!(
            DeviceClient::erase_saved_credential("https://user:secret@safe.invalid", id, &store)
                .is_err()
        );
        assert!(
            DeviceClient::erase_saved_credential("https://safe.invalid/path", id, &store).is_err()
        );
        DeviceClient::erase_saved_credential("https://safe.invalid", id, &store).unwrap();
        let accounts = store.0.lock().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(
            accounts[0],
            blake3::hash(format!("https://safe.invalid\0{id}").as_bytes())
                .to_hex()
                .to_string()
        );
    }
}
