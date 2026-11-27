//! ConsentStore records are hints. Require a matching live process from this use,
//! never a basename-only match or an unrelated process that reused a PID.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Microphone,
    Camera,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    pub capability: Capability,
    pub key: String,
    pub last_used_time_start: Option<u64>,
    pub last_used_time_stop: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Process {
    pub pid: u32,
    pub image: String,
    pub package_family: Option<String>,
    pub display_name: String,
    pub created_at: u64,
    pub alive: bool,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrySnapshot {
    pub entries: Vec<Usage>,
    pub processes: Vec<Process>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Active {
    pub mic: Vec<String>,
    pub camera: Vec<String>,
    pub pids: Vec<u32>,
}
fn normalized(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}
pub(super) fn matches(key: &str, process: &Process) -> bool {
    let key = normalized(key);
    let parts: Vec<_> = key.split('\\').collect();
    if parts.first() == Some(&"nonpackaged") {
        // Compare the registry encoding against the full process image. Decoding
        // '#' to '\\' would confuse legitimate '#' characters in file names.
        parts
            .get(1)
            .is_some_and(|image| *image == normalized(&process.image).replace('\\', "#"))
    } else {
        process.package_family.as_ref().is_some_and(|family| {
            parts
                .first()
                .is_some_and(|key| key.split('!').next() == Some(normalized(family).as_str()))
        })
    }
}
pub fn resolve(snapshot: &RegistrySnapshot) -> Active {
    let mut mic = BTreeMap::new();
    let mut camera = BTreeMap::new();
    let mut pids = vec![];
    for entry in &snapshot.entries {
        let Some(start) = entry.last_used_time_start.filter(|v| *v > 0) else {
            continue;
        };
        if entry.last_used_time_stop != Some(0) {
            continue;
        }
        for process in &snapshot.processes {
            if !process.alive
                || process.pid == 0
                || process.created_at > start
                || !matches(&entry.key, process)
            {
                continue;
            }
            let name: String = process
                .display_name
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect();
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let names = match entry.capability {
                Capability::Microphone => &mut mic,
                Capability::Camera => &mut camera,
            };
            names
                .entry(name.to_lowercase())
                .or_insert_with(|| name.to_owned());
            pids.push(process.pid);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    Active {
        mic: mic.into_values().collect(),
        camera: camera.into_values().collect(),
        pids,
    }
}
