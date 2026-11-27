//! Dev-only behaviour port of Tack backend/merge.php (edb57b69), including its
//! shared dense/sparse/anchor budgets and Unicode scalar edit boundaries.
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

const CELLS: usize = 4_000_000;
const BYTES: usize = 128 * 1024;
const ANCHOR_BYTES: usize = 8 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Edit {
    start: usize,
    end: usize,
    text: String,
}
struct Budget {
    dense: usize,
    sparse: usize,
    anchors: Option<usize>,
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            dense: CELLS,
            sparse: CELLS,
            anchors: None,
        }
    }
}

fn coarse(base: &str, next: &str) -> Vec<Edit> {
    if base == next {
        return vec![];
    }
    let prefix = base
        .chars()
        .zip(next.chars())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    let suffix = base[prefix..]
        .chars()
        .rev()
        .zip(next[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(c, _)| c.len_utf8())
        .sum::<usize>();
    vec![Edit {
        start: prefix,
        end: base.len() - suffix,
        text: next[prefix..next.len() - suffix].into(),
    }]
}
fn whitespace(c: char) -> bool {
    matches!(c,'\u{9}'..='\u{d}'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn tokens(text: &str, level: usize) -> Vec<&str> {
    if level == 0 {
        return text.split_inclusive('\n').collect();
    }
    let mut result = vec![];
    let mut at = 0;
    for (index, c) in text.char_indices() {
        if index > at
            && (level == 2 || whitespace(c) != whitespace(text[at..].chars().next().unwrap()))
        {
            result.push(&text[at..index]);
            at = index;
        }
    }
    if at < text.len() {
        result.push(&text[at..]);
    }
    result
}

fn edits(base: &str, next: &str, level: usize, budget: &mut Budget, spans: u8) -> Vec<Edit> {
    if base == next {
        return vec![];
    }
    if base.is_empty() || next.is_empty() || budget.dense == 0 || base.len() + next.len() > BYTES {
        return sparse(base, next, if spans == 3 { -1 } else { 0 }, budget, spans);
    }
    let mut a = tokens(base, level);
    let mut b = tokens(next, level);
    if level < 2 && (a.len() < 2 || b.len() < 2) {
        return edits(base, next, level + 1, budget, spans);
    }
    let prefix = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let offset = a[..prefix].iter().map(|s| s.len()).sum::<usize>();
    a.drain(..prefix);
    b.drain(..prefix);
    while !a.is_empty() && !b.is_empty() && a.last() == b.last() {
        a.pop();
        b.pop();
    }
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 || n.saturating_mul(m) > budget.dense {
        return sparse(base, next, if spans == 3 { -1 } else { 0 }, budget, spans);
    }
    budget.dense -= n * m;
    let mut previous = vec![0u32; m + 1];
    let mut trace = Vec::with_capacity(n);
    for i in 1..=n {
        let mut row = vec![0u32; m + 1];
        let mut directions = Vec::with_capacity(m);
        for j in 1..=m {
            if a[i - 1] == b[j - 1] {
                row[j] = previous[j - 1] + 1;
                directions.push(b'=');
            } else if previous[j] >= row[j - 1] {
                row[j] = previous[j];
                directions.push(b'-');
            } else {
                row[j] = row[j - 1];
                directions.push(b'+');
            }
        }
        trace.push(directions);
        previous = row;
    }
    let (mut i, mut j) = (n, m);
    let mut operations = vec![];
    while i > 0 || j > 0 {
        let direction = if i > 0 && j > 0 {
            trace[i - 1][j - 1]
        } else if i > 0 {
            b'-'
        } else {
            b'+'
        };
        match direction {
            b'=' => {
                i -= 1;
                j -= 1;
                operations.push((direction, a[i]));
            }
            b'-' => {
                i -= 1;
                operations.push((direction, a[i]));
            }
            _ => {
                j -= 1;
                operations.push((direction, b[j]));
            }
        }
    }
    let mut out = vec![];
    let mut pending: Option<Edit> = None;
    let mut at = offset;
    for (kind, text) in operations.into_iter().rev() {
        if kind == b'=' {
            if let Some(edit) = pending.take() {
                out.push(edit);
            }
            at += text.len();
            continue;
        }
        let edit = pending.get_or_insert(Edit {
            start: at,
            end: at,
            text: String::new(),
        });
        if kind == b'-' {
            at += text.len();
            edit.end = at;
        } else {
            edit.text.push_str(text);
        }
    }
    if let Some(edit) = pending {
        out.push(edit);
    }
    if level == 2 {
        return out;
    }
    out.into_iter()
        .flat_map(|e| {
            edits(&base[e.start..e.end], &e.text, level + 1, budget, spans)
                .into_iter()
                .map(move |mut p| {
                    p.start += e.start;
                    p.end += e.start;
                    p
                })
        })
        .collect()
}

#[derive(Clone)]
struct Position {
    first: usize,
    last: usize,
    count: usize,
    bytes: usize,
}
fn positions(text: &str, level: i32) -> Vec<(Vec<u8>, Position)> {
    let mut result: Vec<(Vec<u8>, Position)> = vec![];
    let mut lookup: HashMap<Vec<u8>, usize> = HashMap::new();
    let limit = if level == 0 { 4096 } else { 8192 };
    let mut add = |token: Vec<u8>, at: usize, bytes: usize| {
        if let Some(index) = lookup.get(&token) {
            let p = &mut result[*index].1;
            p.last = at;
            p.count += 1;
            p.bytes = bytes;
        } else if result.len() < limit {
            lookup.insert(token.clone(), result.len());
            result.push((
                token,
                Position {
                    first: at,
                    last: at,
                    count: 1,
                    bytes,
                },
            ));
        }
    };
    if level == 0 {
        let mut at = 0;
        for token in tokens(text, 1) {
            add(token.as_bytes().to_vec(), at, token.len());
            at += token.len();
        }
    } else if level < 0 {
        let mut start = 0;
        let mut previous = None;
        let mut count = 0;
        for (at, c) in text.char_indices() {
            if previous.is_some_and(|p| p != c) {
                add(
                    format!("r{}:{count}", previous.unwrap()).into_bytes(),
                    start,
                    at - start,
                );
                start = at;
                count = 0;
            }
            previous = Some(c);
            count += 1;
        }
        if let Some(c) = previous {
            add(
                format!("r{c}:{count}").into_bytes(),
                start,
                text.len() - start,
            );
        }
    } else if level == 1 {
        let mut previous: Option<(usize, char)> = None;
        for (at, c) in text.char_indices() {
            if let Some((start, p)) = previous {
                add(
                    format!("p{p}{c}").into_bytes(),
                    start,
                    at + c.len_utf8() - start,
                );
            }
            add(format!("s{c}").into_bytes(), at, c.len_utf8());
            previous = Some((at, c));
        }
    } else {
        let window = level as usize + 1;
        let chars = text.char_indices().collect::<Vec<_>>();
        let (mut power1, mut power2) = (1u32, 1u32);
        for _ in 0..window {
            power1 = power1.wrapping_mul(31);
            power2 = power2.wrapping_mul(257);
        }
        let (mut hash1, mut hash2) = (0u32, 0u32);
        for (i, (at, c)) in chars.iter().enumerate() {
            let old = if i >= window {
                chars[i - window].1 as u32
            } else {
                0
            };
            hash1 = hash1
                .wrapping_mul(31)
                .wrapping_add(*c as u32)
                .wrapping_sub(old.wrapping_mul(power1));
            hash2 = hash2
                .wrapping_mul(257)
                .wrapping_add(*c as u32)
                .wrapping_sub(old.wrapping_mul(power2));
            if i + 1 < window {
                continue;
            }
            let start = chars[i + 1 - window].0;
            let mut key = vec![b'g'];
            key.extend_from_slice(&hash1.to_le_bytes());
            key.extend_from_slice(&hash2.to_le_bytes());
            add(key, start, at + c.len_utf8() - start);
        }
    }
    result
}
type Anchor = (usize, usize, usize);
fn anchors(
    base: &str,
    next: &str,
    level: i32,
    budget: &mut Budget,
    spans: u8,
) -> Option<Vec<Anchor>> {
    let work = budget.anchors.get_or_insert(ANCHOR_BYTES);
    let cost = (base.len() + next.len()).saturating_mul(if level < 2 { 1 } else { 2 })
        + if level < 2 {
            0
        } else {
            (level as usize + 1) * 8
        };
    if cost > *work {
        return Some(vec![]);
    }
    *work -= cost;
    let left = positions(base, level);
    let right = positions(next, level);
    let map = right.iter().map(|(k, p)| (k, p)).collect::<HashMap<_, _>>();
    if level >= 2 && (left.is_empty() || right.is_empty()) {
        return None;
    }
    let mut shared = false;
    let mut pairs = vec![];
    for (token, a) in &left {
        let Some(b) = map.get(token) else {
            continue;
        };
        shared = true;
        if a.count != b.count || (spans == 0 && a.count > 1) {
            continue;
        }
        let length = a.last - a.first + a.bytes;
        let other_length = b.last - b.first + b.bytes;
        if !(0..2).contains(&level) {
            if length != other_length {
                continue;
            }
            let mut equal = true;
            let mut ca = base[a.first..a.last + a.bytes].chars();
            let mut cb = next[b.first..b.last + b.bytes].chars();
            loop {
                match (ca.next(), cb.next()) {
                    (Some(a), Some(b)) => {
                        let cost = a.len_utf8() + b.len_utf8();
                        if cost > *work {
                            equal = false;
                            break;
                        }
                        *work -= cost;
                        if a != b {
                            equal = false;
                            break;
                        }
                    }
                    (None, None) => break,
                    _ => {
                        equal = false;
                        break;
                    }
                }
            }
            if !equal {
                continue;
            }
        } else if a.count > 1 {
            if length != other_length || length.saturating_mul(2) > *work {
                continue;
            }
            *work -= length * 2;
            if base[a.first..a.first + length] != next[b.first..b.first + length] {
                continue;
            }
        }
        pairs.push((a.first, b.first, length));
    }
    if level >= 2 && !shared && left.len() < 8192 && right.len() < 8192 {
        return None;
    }
    let mut tails: Vec<usize> = vec![];
    let mut previous = vec![];
    for (i, pair) in pairs.iter().enumerate() {
        let at = tails.partition_point(|index| pairs[*index].1 < pair.1);
        previous.push(if at > 0 { Some(tails[at - 1]) } else { None });
        if at == tails.len() {
            tails.push(i);
        } else {
            tails[at] = i;
        }
    }
    let mut chain = vec![];
    let mut at = tails.last().copied();
    while let Some(index) = at {
        chain.push(pairs[index]);
        at = previous[index];
    }
    let mut result = vec![];
    let (mut end_a, mut end_b) = (0, 0);
    for (a, b, length) in chain.into_iter().rev() {
        if a >= end_a && b >= end_b {
            result.push((a, b, length));
            end_a = a + length;
            end_b = b + length;
        }
    }
    Some(result)
}

fn fallback(
    base: &str,
    _next: &str,
    anchor_level: i32,
    budget: &mut Budget,
    spans: u8,
    change: &Edit,
) -> Vec<Edit> {
    let original = &base[change.start..change.end];
    let replacement = &change.text;
    let mut level = if spans == 3 {
        anchor_level.max(-1)
    } else {
        anchor_level.max(if spans == 2 { 2 } else { 0 })
    };
    while if spans == 3 {
        level < 0
    } else {
        spans == 2 || level < 2
    } {
        let before = budget.anchors;
        let found = anchors(original, replacement, level, budget, spans);
        let Some(mut found) = found else {
            break;
        };
        if level >= 2 && budget.anchors == before {
            break;
        }
        if !found.is_empty() {
            let mut result = vec![];
            let (mut a, mut b) = (0, 0);
            found.push((original.len(), replacement.len(), 0));
            for (from, to, length) in found {
                for mut part in sparse(
                    &original[a..from],
                    &replacement[b..to],
                    level + 1,
                    budget,
                    spans,
                ) {
                    part.start += change.start + a;
                    part.end += change.start + a;
                    result.push(part);
                }
                a = from + length;
                b = to + length;
            }
            return result;
        }
        level += 1;
    }
    vec![change.clone()]
}
fn sparse(base: &str, next: &str, anchor_level: i32, budget: &mut Budget, spans: u8) -> Vec<Edit> {
    let changes = coarse(base, next);
    let Some(change) = changes.first() else {
        return changes;
    };
    if change.start == change.end || change.text.is_empty() {
        return changes;
    }
    if budget.sparse == 0 {
        return fallback(base, next, anchor_level, budget, spans, change);
    }
    let a = base[change.start..change.end].chars().collect::<Vec<_>>();
    let b = change.text.chars().collect::<Vec<_>>();
    let (n, m) = (a.len(), b.len());
    let mut trace: Vec<Vec<u32>> = vec![];
    let mut frontier: Vec<u32> = vec![];
    let mut distance = None;
    for d in 0..=n + m {
        if budget.sparse < d + 1 {
            return fallback(base, next, anchor_level, budget, spans, change);
        }
        budget.sparse -= d + 1;
        let old = std::mem::take(&mut frontier);
        for i in 0..=d {
            let k = 2 * i as isize - d as isize;
            let insert = i == 0 || (i != d && old[i - 1] < old[i]);
            let mut x = if d == 0 {
                0
            } else if insert {
                old[i] as usize
            } else {
                old[i - 1] as usize + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a[x] == b[y] {
                if budget.sparse == 0 {
                    return fallback(base, next, anchor_level, budget, spans, change);
                }
                budget.sparse -= 1;
                x += 1;
                y += 1;
            }
            frontier.push(x as u32);
            if x >= n && y >= m {
                distance = Some(d);
                break;
            }
        }
        trace.push(frontier.clone());
        if distance.is_some() {
            break;
        }
    }
    let Some(distance) = distance else {
        return fallback(base, next, anchor_level, budget, spans, change);
    };
    let offset_a = base[change.start..change.end]
        .char_indices()
        .map(|(i, _)| i)
        .chain([change.end - change.start])
        .collect::<Vec<_>>();
    let offset_b = change
        .text
        .char_indices()
        .map(|(i, _)| i)
        .chain([change.text.len()])
        .collect::<Vec<_>>();
    let mut out = vec![];
    let mut pending: Option<(usize, usize, usize, usize)> = None;
    let (mut x, mut y) = (n, m);
    let flush = |out: &mut Vec<Edit>, pending: &mut Option<(usize, usize, usize, usize)>| {
        if let Some((start, end, from, to)) = pending.take() {
            out.push(Edit {
                start: change.start + offset_a[start],
                end: change.start + offset_a[end],
                text: change.text[offset_b[from]..offset_b[to]].into(),
            });
        }
    };
    for d in (1..=distance).rev() {
        let old = &trace[d - 1];
        let k = x as isize - y as isize;
        let i = ((k + d as isize) / 2) as usize;
        let insert = i == 0 || (i != d && old[i - 1] < old[i]);
        let px = old[if insert { i } else { i - 1 }] as usize;
        let py = (px as isize - (k + if insert { 1 } else { -1 })) as usize;
        let end = px + usize::from(!insert);
        let to = py + usize::from(insert);
        if x > end || y > to {
            flush(&mut out, &mut pending);
        }
        if let Some(p) = pending.as_mut() {
            p.0 = px;
            p.2 = py;
        } else {
            pending = Some((px, end, py, to));
        }
        x = px;
        y = py;
    }
    flush(&mut out, &mut pending);
    out.reverse();
    out
}

fn attempt(
    base: &str,
    current: &str,
    incoming: &str,
    budget: &mut Budget,
    spans: u8,
) -> Option<String> {
    let left = edits(base, current, 0, budget, spans);
    let right = edits(base, incoming, 0, budget, spans);
    let mut all = left.clone();
    for b in right {
        let mut duplicate = false;
        for a in &left {
            if *a == b {
                duplicate = true;
                break;
            }
            let mut overlap = a.start.max(b.start) < a.end.min(b.end);
            if a.start == a.end {
                overlap |= (a.start >= b.start && a.start < b.end) || a.start == b.start;
            }
            if b.start == b.end {
                overlap |= (b.start >= a.start && b.start < a.end) || a.start == b.start;
            }
            if overlap {
                return None;
            }
        }
        if !duplicate {
            all.push(b);
        }
    }
    all.sort_by_key(|b| std::cmp::Reverse(b.start));
    let mut result = base.to_string();
    for edit in all {
        result.replace_range(edit.start..edit.end, &edit.text);
    }
    Some(result)
}
fn merge_text(base: &str, current: &str, incoming: &str, budget: &mut Budget) -> Option<String> {
    if current == base || current == incoming {
        return Some(incoming.into());
    }
    if incoming == base {
        return Some(current.into());
    }
    let before = budget.anchors;
    let result = attempt(base, current, incoming, budget, 0);
    if result.is_some() || budget.anchors == before || budget.anchors == Some(0) {
        return result;
    }
    let result = attempt(base, current, incoming, budget, 1);
    if result.is_some() || budget.anchors == Some(0) {
        return result;
    }
    attempt(base, current, incoming, budget, 3).or_else(|| {
        if budget.anchors.unwrap_or_default() > 0 {
            attempt(base, current, incoming, budget, 2)
        } else {
            None
        }
    })
}

pub(super) fn merge_fields(
    base: &Value,
    current: &Value,
    incoming: &Value,
    stamp: &str,
) -> Option<Value> {
    let (base, current, incoming) = (
        base.as_object()?,
        current.as_object()?,
        incoming.as_object()?,
    );
    let mut result = current.clone();
    let keys = base.keys().chain(incoming.keys()).collect::<BTreeSet<_>>();
    let null = Value::Null;
    let mut budget = Budget::default();
    for key in keys {
        if [
            "revision",
            "updatedAt",
            "updatedBy",
            "authorId",
            "authorName",
        ]
        .contains(&key.as_str())
        {
            continue;
        }
        let old = base.get(key).unwrap_or(&null);
        let new = incoming.get(key).unwrap_or(&null);
        let remote = current.get(key).unwrap_or(&null);
        if old == new {
            continue;
        }
        if ["labels", "tags", "goalIds"].contains(&key.as_str()) {
            if let (Some(old), Some(new), Some(remote)) =
                (old.as_array(), new.as_array(), remote.as_array())
            {
                let removed = old.iter().filter(|v| !new.contains(v)).collect::<Vec<_>>();
                let added = new.iter().filter(|v| !old.contains(v));
                let mut values = remote
                    .iter()
                    .filter(|v| !removed.contains(v))
                    .cloned()
                    .collect::<Vec<_>>();
                for v in added {
                    if !values.contains(v) {
                        values.push(v.clone());
                    }
                }
                result.insert(key.clone(), values.into());
                continue;
            }
        }
        if [
            "title",
            "name",
            "body",
            "brief",
            "notes",
            "description",
            "doneWhen",
            "instructions",
            "outcome",
            "context",
        ]
        .contains(&key.as_str())
        {
            if let (Some(old), Some(new), Some(remote)) =
                (old.as_str(), new.as_str(), remote.as_str())
            {
                result.insert(
                    key.clone(),
                    merge_text(old, remote, new, &mut budget)?.into(),
                );
                continue;
            }
        }
        if incoming.contains_key(key) {
            result.insert(key.clone(), new.clone());
        } else {
            result.remove(key);
        }
    }
    if let Some(revision) = result.get("revision").and_then(Value::as_u64) {
        result.insert(
            "revision".into(),
            (revision.max(
                incoming
                    .get("revision")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
            ) + 1)
                .into(),
        );
    }
    if result.contains_key("updatedAt") {
        result.insert("updatedAt".into(), stamp.into());
    }
    Some(result.into())
}

// Tack's sharing.php handles a human edit racing an agent-only completion.
pub(super) fn merge_protocol_write(
    base: &Value,
    current: &Value,
    incoming: &Value,
    stamp: &str,
) -> Option<Value> {
    let (base, current, incoming) = (
        base.as_object()?,
        current.as_object()?,
        incoming.as_object()?,
    );
    let null = Value::Null;
    let agent = current.get("agentState")?;
    if agent.is_null() || agent == base.get("agentState").unwrap_or(&null) {
        return None;
    }
    let owned = ["agentState", "completed"];
    let meta = ["revision", "updatedAt"];
    if owned
        .iter()
        .any(|k| incoming.get(*k).unwrap_or(&null) != base.get(*k).unwrap_or(&null))
    {
        return None;
    }
    let human = |object: &serde_json::Map<String, Value>| {
        let mut value = object.clone();
        value.retain(|k, _| !owned.contains(&k.as_str()) && !meta.contains(&k.as_str()));
        value
    };
    if human(current) != human(base) {
        return None;
    }
    let mut value = incoming.clone();
    for key in owned {
        if let Some(remote) = current.get(key) {
            value.insert(key.into(), remote.clone());
        }
    }
    let revision = current
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .max(
            incoming
                .get("revision")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        );
    value.insert("revision".into(), revision.saturating_add(1).into());
    value.insert("updatedAt".into(), stamp.into());
    Some(value.into())
}
