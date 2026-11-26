//! Every health probe owns its complete process tree, including Deno children.
use crate::error::{msg, Result};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub struct ProbeOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

#[cfg(windows)]
struct Tree(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Tree {
    fn attach(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let tree = Self(job);
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(tree)
    }
}
#[cfg(windows)]
impl Drop for Tree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(unix)]
struct Tree(i32);
#[cfg(unix)]
impl Tree {
    fn attach(child: &std::process::Child) -> Result<Self> {
        Ok(Self(child.id() as i32))
    }
}
#[cfg(unix)]
impl Drop for Tree {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

fn drain(mut pipe: impl Read, limit: usize) -> (String, bool) {
    let mut stored = Vec::new();
    let mut overflow = false;
    let mut buffer = [0u8; 4096];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let keep = n.min(limit.saturating_sub(stored.len()));
                overflow |= keep < n;
                stored.extend_from_slice(&buffer[..keep]);
            }
        }
    }
    (String::from_utf8_lossy(&stored).into_owned(), overflow)
}
pub fn run_bounded(path: &Path, args: &[String], limit: Duration) -> Result<ProbeOutput> {
    run_bounded_with_output_limit(path, args, limit, 65_536)
}
pub fn run_bounded_with_output_limit(
    path: &Path,
    args: &[String],
    limit: Duration,
    output_limit: usize,
) -> Result<ProbeOutput> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let tree = match Tree::attach(&child) {
        Ok(t) => t,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out = std::thread::spawn(move || drain(stdout, output_limit));
    let err = std::thread::spawn(move || drain(stderr, 65_536));
    let start = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s.success()),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(msg("Engine probe timed out."));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.into());
            }
        }
    };
    // Close the job/process group before joining pipe readers, even when the
    // parent exited successfully but a descendant still owns an output handle.
    drop(tree);
    let (stdout, overflow) = out.join().unwrap_or_default();
    let (stderr, _) = err.join().unwrap_or_default();
    let success = result?;
    if overflow {
        return Err(msg("Engine probe output exceeded its limit."));
    }
    Ok(ProbeOutput {
        success,
        stdout,
        stderr,
    })
}
