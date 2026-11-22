//! File-based upgrade drain channel between `coforge-installer` and the running Computer
//! supervisor (`UpgradeDrainWatcher`).
//!
//! Before stopping a running supervisor for an upgrade, the installer atomically writes
//! `upgrade-drain-request.json` under the daemon state directory (`~/.coforge/daemon/`). A
//! supporting supervisor engages its runner hold, publishes live `busyCount` into
//! `upgrade-drain-state.json`, and keeps the hold active until either the request file disappears
//! or `deadlineAtMs` passes. Older supervisors never write the state file and fast-path after
//! [`DRAIN_ACK_GRACE`].
//!
//! [`DrainGuard`] removes both files when dropped. The caller drops it immediately after the old
//! supervisor stops and before the new supervisor starts, and any early error unwinds it so a
//! still-running supervisor auto-releases its hold.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::clock::Clock;
use crate::private_fs::{FileMode, replace_file};

pub(crate) const DRAIN_SCHEMA_VERSION: u32 = 1;
pub(crate) const DRAIN_REQUEST_FILE: &str = "upgrade-drain-request.json";
pub(crate) const DRAIN_STATE_FILE: &str = "upgrade-drain-state.json";
pub(crate) const DRAIN_REASON_UPGRADE: &str = "upgrade";
pub(crate) const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const DRAIN_ACK_GRACE: Duration = Duration::from_secs(3);
pub(crate) const DRAIN_STALE_STATE_GRACE: Duration = Duration::from_secs(15);
pub(crate) const DRAIN_WAIT_BOUND: Duration = Duration::from_secs(120);
pub(crate) const DRAIN_DEADLINE_GRACE: Duration = Duration::from_secs(30);

const DRAIN_STATE_MAX_BYTES: u64 = 16 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrainRequest<'a> {
    schema_version: u32,
    drain_id: &'a str,
    reason: &'a str,
    requested_at_ms: u64,
    deadline_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DrainState {
    schema_version: u32,
    drain_id: String,
    held: bool,
    busy_count: usize,
    updated_at_ms: u64,
}

/// Removes the upgrade drain files when dropped. Keep alive across `stop_supervisor`, then drop
/// before starting the replacement supervisor.
pub(crate) struct DrainGuard {
    request_path: PathBuf,
    state_path: PathBuf,
}

impl Drop for DrainGuard {
    fn drop(&mut self) {
        remove_regular_file(&self.request_path);
        remove_regular_file(&self.state_path);
    }
}

/// Clears any leftover regular drain files in `state_directory` (for example after an earlier
/// interrupted installer run). Never follows symlinks.
pub(crate) fn clear_drain_files(state_directory: &Path) {
    if !is_real_directory(state_directory) {
        return;
    }
    remove_regular_file(&state_directory.join(DRAIN_REQUEST_FILE));
    remove_regular_file(&state_directory.join(DRAIN_STATE_FILE));
}

/// Requests a runner hold from the running supervisor and waits for busy Agents to reach a quiet
/// boundary, bounded by [`DRAIN_ACK_GRACE`] (unacknowledged), [`DRAIN_STALE_STATE_GRACE`]
/// (heartbeat stops updating), and [`DRAIN_WAIT_BOUND`] (acknowledged). Best effort: filesystem
/// refusal or an uncooperative supervisor never blocks an upgrade.
#[cfg(test)]
pub(crate) fn drain_before_stop(
    state_directory: &Path,
    drain_id: &str,
    clock: &dyn Clock,
    say: &mut dyn FnMut(&str),
) -> Option<DrainGuard> {
    drain_before_stop_with_progress(state_directory, drain_id, clock, say, None)
}

pub(crate) fn drain_before_stop_with_progress(
    state_directory: &Path,
    drain_id: &str,
    clock: &dyn Clock,
    say: &mut dyn FnMut(&str),
    progress: Option<&crate::upgrade_progress::UpgradeProgress>,
) -> Option<DrainGuard> {
    if drain_id.is_empty() || !is_real_directory(state_directory) {
        return None;
    }
    let request_path = state_directory.join(DRAIN_REQUEST_FILE);
    if !is_absent_or_regular_file(&request_path) {
        return None;
    }
    let state_path = state_directory.join(DRAIN_STATE_FILE);
    let requested_at_ms = unix_timestamp_ms();
    let total_ttl_ms =
        u64::try_from((DRAIN_WAIT_BOUND + DRAIN_DEADLINE_GRACE).as_millis()).unwrap_or(u64::MAX);
    let request = DrainRequest {
        schema_version: DRAIN_SCHEMA_VERSION,
        drain_id,
        reason: DRAIN_REASON_UPGRADE,
        requested_at_ms,
        deadline_at_ms: requested_at_ms.saturating_add(total_ttl_ms),
    };
    let Ok(mut bytes) = serde_json::to_vec(&request) else {
        return None;
    };
    bytes.push(b'\n');
    if replace_file(&request_path, &bytes, FileMode::Exact(0o600)).is_err() {
        return None;
    }
    let guard = DrainGuard {
        request_path,
        state_path,
    };

    let started = clock.now();
    let mut acknowledged = false;
    let mut last_busy: Option<usize> = None;
    let mut last_updated_at_ms: Option<u64> = None;
    let mut last_progress_at = started;

    loop {
        let now = clock.now();
        if let Some(state) = read_matching_state(&guard.state_path, drain_id) {
            acknowledged = true;
            if last_updated_at_ms != Some(state.updated_at_ms) {
                last_updated_at_ms = Some(state.updated_at_ms);
                last_progress_at = now;
            }
            if state.busy_count == 0 {
                if last_busy.is_some_and(|count| count > 0) {
                    say("All Agents idle; proceeding with upgrade");
                }
                return Some(guard);
            }
            if last_busy != Some(state.busy_count) {
                if last_busy.is_none() {
                    if let Some(progress) = progress {
                        progress.phase("waiting");
                    }
                }
                say(&format!(
                    "Draining ({} busy Agent{})",
                    state.busy_count,
                    plural(state.busy_count)
                ));
                last_busy = Some(state.busy_count);
            }
        }
        let elapsed = now.saturating_sub(started);
        if !acknowledged && elapsed >= DRAIN_ACK_GRACE {
            return Some(guard);
        }
        if acknowledged && now.saturating_sub(last_progress_at) >= DRAIN_STALE_STATE_GRACE {
            say("Drain state stopped updating; stopping anyway");
            return Some(guard);
        }
        if elapsed >= DRAIN_WAIT_BOUND {
            if let Some(count) = last_busy {
                say(&format!(
                    "Drain deadline reached with {count} busy Agent{}; stopping anyway",
                    plural(count)
                ));
            }
            return Some(guard);
        }
        clock.sleep(DRAIN_POLL_INTERVAL);
    }
}

fn read_matching_state(path: &Path, drain_id: &str) -> Option<DrainState> {
    let file = open_regular_file_nofollow(path)?;
    let metadata = file.metadata().ok()?;
    if !metadata.file_type().is_file() || metadata.len() > DRAIN_STATE_MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(DRAIN_STATE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > DRAIN_STATE_MAX_BYTES {
        return None;
    }
    let state: DrainState = serde_json::from_slice(&bytes).ok()?;
    if state.schema_version != DRAIN_SCHEMA_VERSION || state.drain_id != drain_id || !state.held {
        return None;
    }
    Some(state)
}

#[cfg(unix)]
fn open_regular_file_nofollow(path: &Path) -> Option<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()
}

#[cfg(not(unix))]
fn open_regular_file_nofollow(path: &Path) -> Option<File> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() {
        return None;
    }
    OpenOptions::new().read(true).open(path).ok()
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn is_absent_or_regular_file(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type().is_file(),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

fn remove_regular_file(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        let _ = fs::remove_file(path);
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::time::Duration;

    use super::*;
    use crate::clock::VirtualClock;
    use crate::test_support::Scratch;

    struct ScriptedClock<F> {
        inner: VirtualClock,
        on_sleep: F,
    }

    impl<F: Fn(Duration)> ScriptedClock<F> {
        fn new(on_sleep: F) -> Self {
            Self {
                inner: VirtualClock::new(),
                on_sleep,
            }
        }
    }

    impl<F: Fn(Duration)> Clock for ScriptedClock<F> {
        fn now(&self) -> Duration {
            self.inner.now()
        }

        fn sleep(&self, duration: Duration) {
            self.inner.sleep(duration);
            (self.on_sleep)(self.inner.now());
        }
    }

    fn write_state(dir: &Path, drain_id: &str, held: bool, busy_count: usize, updated_at_ms: u64) {
        let body = serde_json::json!({
            "schemaVersion": 1,
            "drainId": drain_id,
            "held": held,
            "busyCount": busy_count,
            "updatedAtMs": updated_at_ms,
        });
        fs::write(dir.join(DRAIN_STATE_FILE), body.to_string()).unwrap();
    }

    #[test]
    fn writes_request_waits_for_busy_to_reach_zero_and_cleans_up_on_drop() {
        let scratch = Scratch::new("drain-busy-to-zero");
        let dir = scratch.path();
        let saw_valid_request = Cell::new(false);
        let clock = ScriptedClock::new(|elapsed| {
            let request_bytes = fs::read(dir.join(DRAIN_REQUEST_FILE)).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&request_bytes).unwrap();
            assert_eq!(request["schemaVersion"], 1);
            assert_eq!(request["drainId"], "req-1");
            assert_eq!(request["reason"], "upgrade");
            assert!(
                request["deadlineAtMs"].as_u64().unwrap()
                    > request["requestedAtMs"].as_u64().unwrap()
            );
            saw_valid_request.set(true);
            let ts = 1_760_000_000_000u64 + elapsed.as_millis() as u64;
            if elapsed == Duration::from_millis(250) {
                write_state(dir, "req-1", true, 2, ts);
            } else if elapsed == Duration::from_millis(750) {
                write_state(dir, "req-1", true, 1, ts);
            } else if elapsed == Duration::from_millis(1_000) {
                write_state(dir, "req-1", true, 0, ts);
            }
        });
        let mut stages = Vec::new();
        let guard = drain_before_stop(dir, "req-1", &clock, &mut |line| {
            stages.push(line.to_owned());
        })
        .expect("drain guard returned");

        assert!(saw_valid_request.get());
        assert_eq!(clock.now(), Duration::from_millis(1_000));
        assert_eq!(
            stages,
            vec![
                "Draining (2 busy Agents)",
                "Draining (1 busy Agent)",
                "All Agents idle; proceeding with upgrade",
            ]
        );
        assert!(dir.join(DRAIN_REQUEST_FILE).exists());
        assert!(dir.join(DRAIN_STATE_FILE).exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(DRAIN_REQUEST_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        drop(guard);
        assert!(!dir.join(DRAIN_REQUEST_FILE).exists());
        assert!(!dir.join(DRAIN_STATE_FILE).exists());
    }

    #[test]
    fn fast_paths_past_unacknowledged_older_daemon_after_ack_grace() {
        let scratch = Scratch::new("drain-unacked");
        let clock = VirtualClock::new();
        let mut stages = Vec::new();

        let guard = drain_before_stop(scratch.path(), "req-old-daemon", &clock, &mut |line| {
            stages.push(line.to_owned());
        })
        .expect("guard returned");

        assert_eq!(clock.elapsed(), DRAIN_ACK_GRACE);
        assert!(stages.is_empty());
        drop(guard);
        assert!(!scratch.path().join(DRAIN_REQUEST_FILE).exists());
    }

    #[test]
    fn proceeds_at_wait_bound_when_agents_stay_busy_with_live_heartbeats() {
        let scratch = Scratch::new("drain-timeout");
        let dir = scratch.path();
        write_state(dir, "req-busy", true, 3, 1_760_000_000_000);
        let clock = ScriptedClock::new(|elapsed| {
            if elapsed.as_millis().is_multiple_of(1_000) {
                write_state(
                    dir,
                    "req-busy",
                    true,
                    3,
                    1_760_000_000_000 + elapsed.as_millis() as u64,
                );
            }
        });
        let mut stages = Vec::new();

        let guard = drain_before_stop(dir, "req-busy", &clock, &mut |line| {
            stages.push(line.to_owned());
        })
        .expect("guard returned");

        assert_eq!(clock.now(), DRAIN_WAIT_BOUND);
        assert_eq!(
            stages,
            vec![
                "Draining (3 busy Agents)",
                "Drain deadline reached with 3 busy Agents; stopping anyway",
            ]
        );
        drop(guard);
    }

    #[test]
    fn proceeds_early_when_drain_state_heartbeat_goes_stale() {
        let scratch = Scratch::new("drain-stale-heartbeat");
        write_state(scratch.path(), "req-stale", true, 2, 1_760_000_000_000);
        let clock = VirtualClock::new();
        let mut stages = Vec::new();

        let guard = drain_before_stop(scratch.path(), "req-stale", &clock, &mut |line| {
            stages.push(line.to_owned());
        })
        .expect("guard returned");

        assert_eq!(clock.elapsed(), DRAIN_STALE_STATE_GRACE);
        assert_eq!(
            stages,
            vec![
                "Draining (2 busy Agents)",
                "Drain state stopped updating; stopping anyway",
            ]
        );
        drop(guard);
    }

    #[test]
    fn ignores_mismatched_drain_id_and_unheld_state() {
        let scratch = Scratch::new("drain-mismatch");
        write_state(scratch.path(), "other-req", true, 0, 1_760_000_000_000);
        let clock = VirtualClock::new();
        let mut stages = Vec::new();

        let guard = drain_before_stop(scratch.path(), "req-expected", &clock, &mut |line| {
            stages.push(line.to_owned());
        })
        .expect("guard returned");

        assert_eq!(clock.elapsed(), DRAIN_ACK_GRACE);
        assert!(stages.is_empty());
        drop(guard);

        write_state(scratch.path(), "req-unheld", false, 0, 1_760_000_000_000);
        let clock2 = VirtualClock::new();
        let guard2 = drain_before_stop(scratch.path(), "req-unheld", &clock2, &mut |_| {})
            .expect("guard returned");
        assert_eq!(clock2.elapsed(), DRAIN_ACK_GRACE);
        drop(guard2);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_request_file_and_symlinked_state_directory() {
        use std::os::unix::fs::symlink;

        let scratch = Scratch::new("drain-symlink");
        let victim = scratch.path().join("victim.txt");
        fs::write(&victim, "keep").unwrap();
        let request_link = scratch.path().join(DRAIN_REQUEST_FILE);
        symlink(&victim, &request_link).unwrap();

        let clock = VirtualClock::new();
        assert!(drain_before_stop(scratch.path(), "req-sym", &clock, &mut |_| {}).is_none());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(clock.elapsed(), Duration::ZERO);

        let real_dir = scratch.path().join("real-state");
        fs::create_dir(&real_dir).unwrap();
        let dir_link = scratch.path().join("link-state");
        symlink(&real_dir, &dir_link).unwrap();
        assert!(drain_before_stop(&dir_link, "req-dir-sym", &clock, &mut |_| {}).is_none());
        assert!(!real_dir.join(DRAIN_REQUEST_FILE).exists());
    }
}
