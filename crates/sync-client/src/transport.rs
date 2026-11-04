use crate::{Error, Result};
use reqwest::{
    Certificate, Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::Deserialize;
use std::{cell::Cell, io::Read, time::Duration};
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicServer {
    pub server_id: String,
    pub protocol_version: u32,
    pub namespace_version: u32,
    #[serde(default)]
    pub features: ServerFeatures,
}
#[derive(Clone, Debug, Default, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFeatures {
    #[serde(default)]
    pub job_reporting: bool,
}
pub struct ServerConnection {
    pub(crate) client: Client,
    pub(crate) origin: String,
    pub info: PublicServer,
    identity_rejected: Cell<bool>,
}
impl ServerConnection {
    pub fn connect(origin: &str, certificate_pem: Option<&str>) -> Result<Self> {
        let url = Url::parse(origin).map_err(|_| Error::Protocol)?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || origin.len() > 512
        {
            return Err(Error::Protocol);
        }
        let origin = url.origin().ascii_serialization();
        let mut builder = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60));
        if let Some(pem) = certificate_pem {
            if pem.len() > 16384 {
                return Err(Error::Limit);
            }
            builder = builder.add_root_certificate(
                Certificate::from_pem(pem.as_bytes()).map_err(|_| Error::Protocol)?,
            );
        }
        let client = builder.build().map_err(|_| Error::Transport)?;
        let response = client
            .get(format!("{origin}/api/v1/capabilities"))
            .send()
            .map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::Protocol);
        }
        let info: PublicServer =
            serde_json::from_slice(&limited(response, 65536)?).map_err(|_| Error::Protocol)?;
        if info.protocol_version != 1
            || info.namespace_version != 1
            || uuid::Uuid::parse_str(&info.server_id).is_err()
        {
            return Err(Error::Protocol);
        }
        Ok(Self {
            client,
            origin,
            info,
            identity_rejected: Cell::new(false),
        })
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    /// Recheck the enrolled server's public identity at a foreground comparison
    /// boundary. A restored/replaced service must not silently inherit trust.
    pub fn revalidate(&self) -> Result<()> {
        if self.identity_rejected.get() {
            return Err(Error::ServerIdentity);
        }
        let response = self
            .client
            .get(format!("{}/api/v1/capabilities", self.origin))
            .send()
            .map_err(|_| Error::Transport)?;
        if !response.status().is_success() {
            return Err(Error::Protocol);
        }
        let info: PublicServer =
            serde_json::from_slice(&limited(response, 65536)?).map_err(|_| Error::Protocol)?;
        if info.server_id != self.info.server_id {
            self.identity_rejected.set(true);
            return Err(Error::ServerIdentity);
        }
        if info.protocol_version != self.info.protocol_version
            || info.namespace_version != self.info.namespace_version
        {
            return Err(Error::Protocol);
        }
        Ok(())
    }
    pub(crate) fn endpoint(&self, path: &str) -> Result<String> {
        if self.identity_rejected.get() {
            return Err(Error::ServerIdentity);
        }
        if !path.starts_with("/api/v1/") || path.contains(['#', '\\']) || path.len() > 2048 {
            return Err(Error::Protocol);
        }
        let full = format!("{}{path}", self.origin);
        let url = Url::parse(&full).map_err(|_| Error::Protocol)?;
        if url.origin().ascii_serialization() != self.origin
            || !url.path().starts_with("/api/v1/")
            || path.split('?').next().unwrap_or("").contains("..")
            || path
                .split('?')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("%2e")
        {
            return Err(Error::Protocol);
        }
        Ok(full)
    }
}
pub(crate) fn limited(response: Response, max: u64) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > max) {
        return Err(Error::Limit);
    }
    let mut bytes = Vec::new();
    response
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Transport)?;
    if bytes.len() as u64 > max {
        return Err(Error::Limit);
    }
    Ok(bytes)
}
