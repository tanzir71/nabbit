//! Default-alphabet generateKeyBetween port of fractional-indexing 4.0.0
//! (CC0-1.0). The pinned npm implementation generates our differential fixtures.
use crate::error::{msg, Result};
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX: usize = 4096;
fn integer_len(head: u8) -> Result<usize> {
    match head {
        b'a'..=b'z' => Ok((head - b'a') as usize + 2),
        b'A'..=b'Z' => Ok((b'Z' - head) as usize + 2),
        _ => Err(msg("Invalid note rank")),
    }
}
fn integer(key: &str) -> Result<&str> {
    let length = integer_len(
        *key.as_bytes()
            .first()
            .ok_or_else(|| msg("Invalid note rank"))?,
    )?;
    key.get(..length).ok_or_else(|| msg("Invalid note rank"))
}
fn smallest(value: &str) -> bool {
    value == format!("A{}", "0".repeat(26))
}
pub(crate) fn validate(key: &str) -> Result<()> {
    if key.len() > MAX || !key.bytes().all(|b| DIGITS.contains(&b)) {
        return Err(msg("Invalid note rank"));
    }
    let int = integer(key)?;
    if smallest(key) || (key.len() > int.len() && key.ends_with('0')) {
        return Err(msg("Invalid note rank"));
    }
    Ok(())
}
fn step(value: &str, up: bool) -> Result<Option<String>> {
    let mut key = value.as_bytes().to_vec();
    for i in (1..key.len()).rev() {
        let digit = DIGITS
            .iter()
            .position(|d| *d == key[i])
            .ok_or_else(|| msg("Invalid note rank"))?;
        if up && digit + 1 < DIGITS.len() {
            key[i] = DIGITS[digit + 1];
            return Ok(Some(String::from_utf8(key).unwrap()));
        }
        if !up && digit > 0 {
            key[i] = DIGITS[digit - 1];
            return Ok(Some(String::from_utf8(key).unwrap()));
        }
        key[i] = if up { b'0' } else { b'z' };
    }
    let head = key[0];
    if (up && head == b'z') || (!up && head == b'A') {
        return Ok(None);
    }
    key[0] = match (up, head) {
        (true, b'Z') => b'a',
        (false, b'a') => b'Z',
        (true, _) => head + 1,
        (false, _) => head - 1,
    };
    let length = integer_len(key[0])?;
    if length > key.len() {
        key.push(if up { b'0' } else { b'z' });
    } else if length < key.len() {
        key.pop();
    }
    Ok(Some(String::from_utf8(key).unwrap()))
}
fn midpoint(a: &str, b: Option<&str>) -> Result<String> {
    if b.is_some_and(|b| a >= b) || a.ends_with('0') || b.is_some_and(|b| b.ends_with('0')) {
        return Err(msg("Invalid note rank interval"));
    }
    let mut prefix = String::new();
    let mut a = a;
    let mut b = b;
    loop {
        if prefix.len() + a.len() > MAX {
            return Err(msg("Note rank is too long"));
        }
        if let Some(bound) = b {
            let mut common = 0;
            while common < bound.len()
                && a.as_bytes().get(common).copied().unwrap_or(b'0') == bound.as_bytes()[common]
            {
                common += 1;
            }
            if common > 0 {
                prefix.push_str(&bound[..common]);
                a = a.get(common..).unwrap_or("");
                b = Some(&bound[common..]);
                continue;
            }
        }
        let left = a
            .as_bytes()
            .first()
            .map_or(0, |c| DIGITS.iter().position(|d| d == c).unwrap());
        let right = b
            .and_then(|b| b.as_bytes().first())
            .map_or(DIGITS.len(), |c| {
                DIGITS.iter().position(|d| d == c).unwrap()
            });
        if right - left > 1 {
            prefix.push(DIGITS[(left + right).div_ceil(2)] as char);
            return Ok(prefix);
        }
        if let Some(bound) = b.filter(|b| b.len() > 1) {
            prefix.push_str(&bound[..1]);
            return Ok(prefix);
        }
        prefix.push(DIGITS[left] as char);
        a = a.get(1..).unwrap_or("");
        b = None;
    }
}
pub(crate) fn between<'a>(mut a: Option<&'a str>, mut b: Option<&'a str>) -> Result<String> {
    if let Some(value) = a {
        validate(value)?;
    }
    if let Some(value) = b {
        validate(value)?;
    }
    if matches!((a,b),(Some(a),Some(b)) if a>b) {
        std::mem::swap(&mut a, &mut b);
    }
    let result = match (a, b) {
        (None, None) => "a0".to_owned(),
        (None, Some(b)) => {
            let int = integer(b)?;
            if smallest(int) {
                format!("{int}{}", midpoint("", Some(&b[int.len()..]))?)
            } else if int < b {
                int.to_owned()
            } else {
                step(int, false)?.ok_or_else(|| msg("Note rank is exhausted"))?
            }
        }
        (Some(a), None) => {
            let int = integer(a)?;
            match step(int, true)? {
                Some(next) => next,
                None => format!("{int}{}", midpoint(&a[int.len()..], None)?),
            }
        }
        (Some(a), Some(b)) => {
            let ia = integer(a)?;
            let ib = integer(b)?;
            if ia == ib {
                format!("{ia}{}", midpoint(&a[ia.len()..], Some(&b[ib.len()..]))?)
            } else {
                let next = step(ia, true)?.ok_or_else(|| msg("Note rank is exhausted"))?;
                if next.as_str() < b {
                    next
                } else {
                    format!("{ia}{}", midpoint(&a[ia.len()..], None)?)
                }
            }
        }
    };
    validate(&result)?;
    Ok(result)
}
pub(crate) fn with_nonce(a: Option<&str>, b: Option<&str>, nonce: &str) -> Result<String> {
    let suffix = nonce
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .chain(['V'])
        .collect::<String>();
    if suffix.len() > MAX {
        return Err(msg("Note rank is too long"));
    }
    let mut key = between(a, b)?;
    while b.is_some_and(|upper| format!("{key}{suffix}").as_str() >= upper) {
        key = between(Some(&key), b)?;
    }
    key.push_str(&suffix);
    validate(&key)?;
    Ok(key)
}
pub(crate) fn legacy(value: f64) -> Result<String> {
    if !value.is_finite() {
        return Err(msg("Invalid legacy note rank"));
    }
    let bits = value.to_bits();
    let mut ordered = if bits & (1 << 63) != 0 {
        !bits
    } else {
        bits ^ (1 << 63)
    };
    let mut chars = vec![];
    loop {
        chars.push(DIGITS[(ordered % 62) as usize] as char);
        ordered /= 62;
        if ordered == 0 {
            break;
        }
    }
    while chars.len() < 11 {
        chars.push('0');
    }
    Ok(format!("k{}", chars.into_iter().rev().collect::<String>()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tack_nonce_and_legacy_ranks_match_pinned_source() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/tack/rank-tack.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let actual =
                if let Some(number) = case.get("number").and_then(serde_json::Value::as_str) {
                    legacy(number.parse().unwrap()).unwrap()
                } else {
                    with_nonce(
                        case["a"].as_str(),
                        case["b"].as_str(),
                        case["nonce"].as_str().unwrap(),
                    )
                    .unwrap()
                };
            assert_eq!(actual, case["expected"].as_str().unwrap());
        }
    }
    #[test]
    fn pinned_npm_keys_match() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/tack/ranks.json")).unwrap();
        for c in cases.as_array().unwrap() {
            let result = between(c["a"].as_str(), c["b"].as_str());
            if c.get("error").is_some() {
                assert!(result.is_err(), "{}", c["name"]);
            } else {
                assert_eq!(
                    result.unwrap(),
                    c["expected"].as_str().unwrap(),
                    "{}",
                    c["name"]
                );
            }
        }
    }
    #[test]
    fn rejects_malformed_and_bounded_keys() {
        for key in ["", "a", "a!", "a00", "A00000000000000000000000000", "🐰0"] {
            assert!(validate(key).is_err());
        }
        assert!(validate(&format!("a0{}V", "V".repeat(MAX))).is_err());
        let mut last = "a0".to_owned();
        for _ in 0..10000 {
            let next = between(None, Some(&last)).unwrap();
            assert!(next < last);
            last = next;
        }
    }
}
