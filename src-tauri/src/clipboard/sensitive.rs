use regex::Regex;

pub fn looks_sensitive(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if looks_like_credit_card(trimmed) {
        return true;
    }
    if looks_like_otp(trimmed) {
        return true;
    }
    looks_like_secret(trimmed)
}

fn looks_like_otp(value: &str) -> bool {
    Regex::new(r"^\d{6,8}$")
        .map(|regex| regex.is_match(value))
        .unwrap_or(false)
}

fn looks_like_secret(value: &str) -> bool {
    let compact = value.split_whitespace().collect::<String>();
    if compact.len() < 24 {
        return false;
    }
    let alpha = compact
        .chars()
        .filter(|char| char.is_ascii_alphabetic())
        .count();
    let digits = compact.chars().filter(|char| char.is_ascii_digit()).count();
    let symbols = compact
        .chars()
        .filter(|char| !char.is_ascii_alphanumeric())
        .count();
    alpha > 8 && digits > 3 && symbols > 1
}

fn looks_like_credit_card(value: &str) -> bool {
    let digits = value
        .chars()
        .filter(|char| char.is_ascii_digit())
        .collect::<String>();
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    luhn_valid(&digits)
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0;
    let mut alternate = false;
    for digit in digits.bytes().rev() {
        let mut n = (digit - b'0') as i32;
        if alternate {
            n *= 2;
            if n > 9 {
                n -= 9;
            }
        }
        sum += n;
        alternate = !alternate;
    }
    sum % 10 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_sensitive_shapes() {
        assert!(looks_sensitive("4242 4242 4242 4242"));
        assert!(looks_sensitive("123456"));
        assert!(looks_sensitive(concat!(
            "sk_test_",
            "1234567890",
            "ABCDEFGHIJK"
        )));
        assert!(!looks_sensitive("ordinary planning note"));
    }
}
