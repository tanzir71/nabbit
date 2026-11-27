use super::{
    model::{Error, ErrorCode, Result},
    session::Scope,
};
use url::Url;

#[derive(Clone, Debug)]
pub struct Endpoint {
    base: Url,
    api: Url,
    scope: Scope,
}
impl Endpoint {
    pub fn new(value: &str) -> Result<Self> {
        Self::parse(value, false)
    }
    fn parse(value: &str, allow_loopback_http: bool) -> Result<Self> {
        let invalid = || Error::new(ErrorCode::InvalidServer);
        if value.len() > 2048 {
            return Err(invalid());
        }
        let mut base = Url::parse(value.trim()).map_err(|_| invalid())?;
        let test_http =
            allow_loopback_http && base.scheme() == "http" && base.host_str() == Some("127.0.0.1");
        if (base.scheme() != "https" && !test_http)
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(invalid());
        }
        let path = format!("{}/", base.path().trim_end_matches('/'));
        base.set_path(&path);
        let api = base.join("api/index.php").map_err(|_| invalid())?;
        let scope = Scope::for_url(&base);
        Ok(Self { base, api, scope })
    }
    pub fn base(&self) -> &Url {
        &self.base
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub(crate) fn action(&self, action: &str) -> Url {
        let mut url = self.api.clone();
        url.query_pairs_mut().append_pair("action", action);
        url
    }
    pub(crate) fn accepts(&self, url: &Url) -> bool {
        url.origin() == self.api.origin() && url.path() == self.api.path()
    }
    #[cfg(test)]
    pub(crate) fn loopback(value: &str) -> Result<Self> {
        Self::parse(value, true)
    }
}
