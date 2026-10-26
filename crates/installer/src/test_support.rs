//! Helpers shared by this crate's tests.

use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::clock::VirtualClock;
use crate::feed::Feed;
use crate::fetch;

/// How long any wait on a child process may last: for it to report, or to exit. A child starts in
/// well under a second; this is only the point at which a stuck one is declared hung, so that it
/// fails one test instead of stalling the whole run.
pub(crate) const CHILD_DEADLINE: Duration = Duration::from_secs(30);

/// A fresh, empty directory under the system temp directory, removed on drop.
pub(crate) struct Scratch(PathBuf);

impl Scratch {
    pub(crate) fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-test-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    /// The names directly inside the directory, sorted.
    pub(crate) fn entries(&self) -> Vec<String> {
        entries_of(&self.0)
    }
}

/// The names directly inside `directory`, sorted.
pub(crate) fn entries_of(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// What an installer from before `current/` leaves, or does to a newer install: `active` is a
/// relative symlink to `versions/<version>`.
#[cfg(unix)]
pub(crate) fn point_active_at_version(install_root: &Path, version: &str) {
    let temporary = install_root.join("active.older");
    std::os::unix::fs::symlink(Path::new("versions").join(version), &temporary).unwrap();
    fs::rename(&temporary, install_root.join("active")).unwrap();
}

/// The permission bits of `path`.
#[cfg(unix)]
pub(crate) fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) use loopback::{Response, Server};

/// A plain-HTTP feed at `base_url` (a loopback [`Server`]) whose waits between attempts sleep on
/// `clock`, so they take no real time and a test can read them back.
pub(crate) fn loopback_feed(base_url: &str, clock: Rc<VirtualClock>) -> Feed {
    let agent = fetch::agent(fetch::Transport::LoopbackHttp);
    Feed::new(base_url, agent, clock)
}

#[cfg(unix)]
pub(crate) use processes::{in_child, in_two_incarnations};

/// Tests whose subject is process-wide state (the umask, a resource limit, the pid) run
/// themselves again in a child process, because that state cannot be changed for one test while
/// the others run beside it. The child is the test binary itself, told to run that one test.
#[cfg(unix)]
mod processes {
    use std::io::{Read, Write};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Output, Stdio};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::CHILD_DEADLINE;

    /// Set in the child that `in_child` starts.
    const CHILD: &str = "COFORGE_INSTALLER_TEST_CHILD";
    /// Set in the processes of `in_two_incarnations`: "1" for the first, "2" for the second.
    const INCARNATION: &str = "COFORGE_INSTALLER_TEST_INCARNATION";

    /// Runs `command` to its end and collects what it prints, or, when it is still running after
    /// `deadline`, kills it and returns what it had printed until then. It is killed rather than
    /// waited for, so a stuck child fails one test instead of stalling the run.
    fn output_within(command: &mut Command, deadline: Duration) -> Result<Output, String> {
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let (stdout, stdout_reader) = drain(child.stdout.take().unwrap());
        let (stderr, stderr_reader) = drain(child.stderr.take().unwrap());
        let end = Instant::now() + deadline;
        // The completion awaited is the child's own exit status; the pause only spaces the polls.
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if Instant::now() >= end {
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        let Some(status) = status else {
            // Already exited is fine: the goal is that no child is left. The readers are not
            // joined: a stray grandchild holding a pipe open must not hold the test up too.
            let _ = child.kill();
            let _ = child.wait();
            let printed = |buffer: &Mutex<Vec<u8>>| {
                String::from_utf8_lossy(&buffer.lock().unwrap()).into_owned()
            };
            return Err(format!("{}{}", printed(&stdout), printed(&stderr)));
        };
        stdout_reader.join().unwrap();
        stderr_reader.join().unwrap();
        let take = |buffer: Arc<Mutex<Vec<u8>>>| std::mem::take(&mut *buffer.lock().unwrap());
        Ok(Output {
            status,
            stdout: take(stdout),
            stderr: take(stderr),
        })
    }

    /// Collects a pipe on a thread of its own, into a buffer that can be read while the child
    /// still runs: a blocking read cannot be given a deadline.
    fn drain(
        mut pipe: impl Read + Send + 'static,
    ) -> (Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&buffer);
        let reader = thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = pipe.read(&mut chunk) {
                if read == 0 {
                    return;
                }
                sink.lock().unwrap().extend_from_slice(&chunk[..read]);
            }
        });
        (buffer, reader)
    }

    /// `output_within` for a child of the calling test: past `CHILD_DEADLINE` the child is killed
    /// and the test fails saying what it was waiting for.
    fn output_of(command: &mut Command, waiting_for: &str) -> Output {
        output_within(command, CHILD_DEADLINE).unwrap_or_else(|printed| {
            panic!(
                "the child was still running {CHILD_DEADLINE:?} after it started, while the test \
                 waited for {waiting_for}; it was killed. It had printed:\n{printed}"
            )
        })
    }

    fn report(output: &Output) -> String {
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    /// In the test process: runs the calling test (`test`, named as `cargo test` lists it) again
    /// in a child that `sh` starts after `setup` (`umask 077`, say), asserts that it passed, and
    /// returns `false`. In that child: returns `true`, and the test goes on to assert.
    pub(crate) fn in_child(test: &str, setup: &str) -> bool {
        if std::env::var_os(CHILD).is_some() {
            return true;
        }
        let output = output_of(
            Command::new("sh")
                .arg("-c")
                .arg(format!(r#"{setup} && exec "$0" --exact "$1""#))
                .arg(std::env::current_exe().unwrap())
                .arg(test)
                .env(CHILD, "1"),
            "the child to run the test",
        );
        let report = report(&output);
        assert!(output.status.success(), "{report}");
        // A name that matches no test would end just as successfully.
        assert!(report.contains("1 passed"), "{report}");
        false
    }

    /// The results of `probe` in two successive incarnations of one process: the same pid, each a
    /// fresh process image with its own statics and clock reading. The calling test (`test`, named
    /// as `cargo test` lists it) runs itself in a child that prints its probe and then `exec`s
    /// itself, which keeps the pid. Returns `Some` in the test process, and `None` in the
    /// processes that only print their probe, whose test then returns.
    pub(crate) fn in_two_incarnations(
        test: &str,
        probe: impl Fn() -> String,
    ) -> Option<[String; 2]> {
        let command = || {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", test, "--nocapture"]);
            command
        };
        let print_probe = || {
            // `--nocapture` prints after "test <name> ... " on the same line.
            println!("\nPROBE {} {}", std::process::id(), probe());
            std::io::stdout().flush().unwrap();
        };
        match std::env::var(INCARNATION).as_deref() {
            Err(_) => {
                let output = output_of(
                    command().env(INCARNATION, "1"),
                    "the two incarnations to print their probes",
                );
                let report = report(&output);
                assert!(output.status.success(), "{report}");
                let probes: Vec<(u32, String)> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| line.strip_prefix("PROBE "))
                    .map(|rest| {
                        let (pid, result) = rest.split_once(' ').unwrap();
                        (pid.parse().unwrap(), result.to_owned())
                    })
                    .collect();
                assert_eq!(probes.len(), 2, "{report}");
                assert_eq!(probes[0].0, probes[1].0, "exec must keep the pid: {report}");
                Some([probes[0].1.clone(), probes[1].1.clone()])
            }
            Ok("1") => {
                print_probe();
                let error = command().env(INCARNATION, "2").exec();
                panic!("cannot start the second incarnation: {error}");
            }
            Ok(_) => {
                print_probe();
                None
            }
        }
    }

    #[test]
    fn a_child_that_ends_in_time_is_returned_with_what_it_printed() {
        let output = output_within(
            Command::new("sh").args(["-c", "echo out; echo err >&2; exit 3"]),
            CHILD_DEADLINE,
        )
        .unwrap();

        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
    }

    #[test]
    fn a_child_still_running_at_its_deadline_is_killed_and_reported() {
        // The child prints its pid, then becomes a `sleep` (exec keeps the pid) that outlasts the
        // deadline many times over.
        let deadline = Duration::from_secs(1);
        let started = Instant::now();

        let printed = output_within(
            Command::new("sh").args(["-c", "echo $$; exec sleep 60"]),
            deadline,
        )
        .unwrap_err();

        let waited = started.elapsed();
        assert!(waited >= deadline, "{waited:?}");
        assert!(waited < Duration::from_secs(20), "waited out: {waited:?}");
        let pid = printed.trim();
        assert!(pid.parse::<u32>().is_ok(), "printed {printed:?}");
        // `kill -0` succeeds only for a process that exists.
        let alive = Command::new("sh")
            .args(["-c", &format!("kill -0 {pid}")])
            .status()
            .unwrap()
            .success();
        assert!(!alive, "process {pid} is still running");
    }
}

mod loopback;

pub(crate) use release::{Release, gzip};

/// A tiny release tree, for tests of everything that reads the feed.
mod release {
    use std::collections::BTreeMap;
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use serde_json::{Value, json};

    use super::Response;
    use crate::digest::measure_bytes;

    pub(crate) struct Release {
        pub(crate) version: String,
        pub(crate) target: String,
        /// What the feed serves for `<version>/<target>/coforge-computer.gz`, once expanded.
        pub(crate) computer: Vec<u8>,
        pub(crate) computer_gzip: Vec<u8>,
        pub(crate) photon_wasm: Vec<u8>,
    }

    pub(crate) fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    impl Release {
        pub(crate) fn new(version: &str, target: &str) -> Self {
            let computer = b"#!/bin/sh\necho a fake coforge-computer\n".to_vec();
            Self {
                version: version.to_owned(),
                target: target.to_owned(),
                computer_gzip: gzip(&computer),
                computer,
                photon_wasm: b"\0asm\x01\0\0\0a fake photon".to_vec(),
            }
        }

        /// `<version>/manifest.json`, as the release build writes it.
        pub(crate) fn manifest(&self) -> Value {
            let computer = measure_bytes(&self.computer);
            let gzip = measure_bytes(&self.computer_gzip);
            let wasm = measure_bytes(&self.photon_wasm);
            json!({
                "schema_version": 2,
                "version": self.version,
                "commit": "0123456789abcdef0123456789abcdef01234567",
                "buildDate": "2026-09-29T00:00:00.000Z",
                "platforms": {
                    self.target.clone(): {
                        "computer": {
                            "binary": "coforge-computer",
                            "size": computer.size,
                            "checksum": computer.checksum,
                            "gzip": {
                                "binary": "coforge-computer.gz",
                                "size": gzip.size,
                                "checksum": gzip.checksum,
                            },
                        },
                    },
                },
                "photonWasm": {
                    "file": "photon_rs_bg.wasm",
                    "size": wasm.size,
                    "checksum": wasm.checksum,
                },
            })
        }

        pub(crate) fn computer_path(&self) -> String {
            format!("/{}/{}/coforge-computer.gz", self.version, self.target)
        }

        pub(crate) fn photon_wasm_path(&self) -> String {
            format!("/{}/photon_rs_bg.wasm", self.version)
        }

        /// The release laid out as a local package directory (`--from-directory`): the manifest,
        /// the target's gzip, and the image library, side by side with their feed names.
        pub(crate) fn write_directory(&self, directory: &std::path::Path) {
            std::fs::write(
                directory.join("manifest.json"),
                format!("{:#}\n", self.manifest()),
            )
            .unwrap();
            std::fs::write(directory.join("coforge-computer.gz"), &self.computer_gzip).unwrap();
            std::fs::write(directory.join("photon_rs_bg.wasm"), &self.photon_wasm).unwrap();
        }

        /// Every object of the release, plus a `latest` pointer naming it.
        pub(crate) fn routes(&self) -> BTreeMap<String, Response> {
            BTreeMap::from([
                (
                    "/latest".to_owned(),
                    Response::ok(format!("{}\n", self.version)),
                ),
                (
                    format!("/{}/manifest.json", self.version),
                    Response::ok(format!("{:#}\n", self.manifest())),
                ),
                (
                    self.computer_path(),
                    Response::ok(self.computer_gzip.clone()),
                ),
                (
                    self.photon_wasm_path(),
                    Response::ok(self.photon_wasm.clone()),
                ),
            ])
        }
    }
}
