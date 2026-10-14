//! The installer binary, run as a process with a scratch home directory. Nothing here reaches the
//! network: the cases refuse before they prepare a version, do nothing at all, or install a
//! stand-in release from a local directory.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

const REQUEST: &str = "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e";

/// A fresh home directory under the system temp directory, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-cli-{label}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(path.join("home")).unwrap();
        Self(path)
    }

    fn home(&self) -> PathBuf {
        self.0.join("home")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn installer(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_coforge-installer"))
        .args(args)
        // The installer resolves the home as the Computer does: `HOME` on Unix, `USERPROFILE` on
        // Windows. Name the scratch home through both, or Windows reads the runner's real profile.
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("XDG_BIN_HOME")
        .output()
        .expect("the installer runs")
}

fn exit_code(output: &Output) -> i32 {
    output.status.code().expect("exited normally")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn is_empty(directory: &Path) -> bool {
    fs::read_dir(directory).unwrap().next().is_none()
}

#[test]
fn version_prints_the_crate_version() {
    let scratch = Scratch::new("version");

    let output = installer(&scratch.home(), &["--version"]);

    assert_eq!(exit_code(&output), 0);
    assert_eq!(
        text(&output.stdout),
        format!("coforge-installer {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn a_usage_error_exits_1_and_writes_nothing() {
    let scratch = Scratch::new("usage");

    let output = installer(&scratch.home(), &["bogus"]);

    assert_eq!(exit_code(&output), 1);
    assert!(text(&output.stderr).starts_with("coforge-installer: "));
    assert!(is_empty(&scratch.home()));
}

#[test]
fn an_upgrade_with_a_malformed_request_id_exits_1_and_writes_nothing() {
    let scratch = Scratch::new("bad-id");

    let output = installer(
        &scratch.home(),
        &[
            "upgrade",
            "--request-id",
            "not-a-uuid",
            "--version",
            "latest",
        ],
    );

    assert_eq!(exit_code(&output), 1);
    assert!(text(&output.stderr).contains("request"));
    assert!(is_empty(&scratch.home()));
}

#[test]
fn status_json_on_an_empty_home_reports_nothing_installed() {
    let scratch = Scratch::new("status");

    let output = installer(&scratch.home(), &["status", "--json"]);

    assert_eq!(exit_code(&output), 0, "{}", text(&output.stderr));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["active_version"], serde_json::Value::Null);
    assert_eq!(report["previous_version"], serde_json::Value::Null);
    assert_eq!(report["journal"], serde_json::Value::Null);
    assert!(!scratch.home().join(".coforge").exists());
}

#[test]
fn recover_on_an_empty_home_has_nothing_to_recover() {
    let scratch = Scratch::new("recover");

    let output = installer(&scratch.home(), &["recover"]);

    assert_eq!(exit_code(&output), 0, "{}", text(&output.stderr));
    assert!(text(&output.stdout).contains("nothing to recover"));
}

#[test]
fn an_unfinished_journal_refuses_upgrade_and_install_before_any_download() {
    let scratch = Scratch::new("journal");
    let install = scratch.home().join(".coforge/computer/install");
    fs::create_dir_all(&install).unwrap();
    fs::write(
        install.join("installer-transaction.json"),
        format!(
            "{{\"schema_version\":1,\"request_id\":\"{REQUEST}\",\"from\":null,\
             \"from_previous\":null,\"to\":\"0.2.0\",\"supervisor_running\":false}}\n"
        ),
    )
    .unwrap();

    let upgrade = installer(
        &scratch.home(),
        &["upgrade", "--request-id", REQUEST, "--version", "latest"],
    );
    assert_eq!(exit_code(&upgrade), 3);
    assert!(text(&upgrade.stderr).contains("coforge-computer recover"));

    let install_output = installer(&scratch.home(), &["install", "--version", "latest"]);
    assert_eq!(exit_code(&install_output), 3);
    assert!(text(&install_output.stderr).contains("coforge-computer recover"));
    assert!(!install.join("upgrade-results").exists());
}

/// A release directory for this machine's target: a shell stand-in for `coforge-computer` that
/// answers `__lifecycle protocol` with `version`, gzipped, with a manifest that describes it.
#[cfg(unix)]
fn write_stand_in_release(directory: &Path, version: &str, target: &str) {
    use coforge_installer::digest::measure_bytes;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;

    let computer = format!(
        "#!/bin/sh\n\
         if [ \"$1\" = __lifecycle ] && [ \"$2\" = protocol ]; then\n\
         \x20 echo '{{\"lifecycle_protocol\":1,\"version\":\"{version}\"}}'\n\
         \x20 exit 0\n\
         fi\n\
         echo \"stand-in coforge-computer: $*\" >&2\n\
         exit 64\n"
    )
    .into_bytes();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&computer).unwrap();
    let gzip = encoder.finish().unwrap();
    let photon_wasm = b"\0asm\x01\0\0\0stand-in image library".to_vec();
    let manifest = serde_json::json!({
        "schema_version": 2,
        "version": version,
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "buildDate": "2026-10-08T00:00:00.000Z",
        "platforms": {
            target: {
                "computer": {
                    "binary": "coforge-computer",
                    "size": measure_bytes(&computer).size,
                    "checksum": measure_bytes(&computer).checksum,
                    "gzip": {
                        "binary": "coforge-computer.gz",
                        "size": measure_bytes(&gzip).size,
                        "checksum": measure_bytes(&gzip).checksum,
                    },
                },
            },
        },
        "photonWasm": {
            "file": "photon_rs_bg.wasm",
            "size": measure_bytes(&photon_wasm).size,
            "checksum": measure_bytes(&photon_wasm).checksum,
        },
    });
    fs::write(directory.join("manifest.json"), format!("{manifest:#}\n")).unwrap();
    fs::write(directory.join("coforge-computer.gz"), gzip).unwrap();
    fs::write(directory.join("photon_rs_bg.wasm"), photon_wasm).unwrap();
}

#[cfg(unix)]
#[test]
fn install_from_a_directory_activates_the_version_in_a_scratch_home() {
    let version = "0.2.0";
    let target =
        coforge_installer::paths::release_target().expect("this machine has a release target");
    let scratch = Scratch::new("from-directory");
    let package = scratch.0.join("package");
    fs::create_dir_all(&package).unwrap();
    write_stand_in_release(&package, version, target);

    let output = installer(
        &scratch.home(),
        &[
            "install",
            "--version",
            version,
            "--from-directory",
            package.to_str().unwrap(),
        ],
    );

    assert_eq!(exit_code(&output), 0, "{}", text(&output.stderr));
    assert!(text(&output.stdout).contains("CoForge Computer 0.2.0 is active."));
    let install = scratch.home().join(".coforge/computer/install");
    let active: serde_json::Value =
        serde_json::from_slice(&fs::read(install.join("active.json")).unwrap()).unwrap();
    assert_eq!(active["current"], version);
    assert!(install.join("versions/0.2.0/coforge-computer").is_file());
    let shim = scratch.home().join(".local/bin/coforge-computer");
    assert!(shim.symlink_metadata().is_ok(), "the PATH shim at {shim:?}");
}
