use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!(
            "coforge-installer-cli-shim-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn install_root(&self) -> PathBuf {
        self.0.join("install")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn install_versions(install_root: &Path, versions: &[&str]) {
    for version in versions {
        let dir = install_root.join("versions").join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("coforge-computer"), version).unwrap();
        fs::write(dir.join("coforge"), format!("#!/bin/sh\necho {version}\n")).unwrap();
    }
}

#[test]
fn activation_links_coforge_cli_beside_computer_and_repair_restores_it() {
    let scratch = Scratch::new("cli-shim-install");
    let install_root = scratch.install_root();
    let binary_directory = scratch.0.join("bin");
    install_versions(&install_root, &["0.1.0", "0.2.0"]);

    activate(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: "0.1.0".into(),
            previous: None,
        },
        false,
    )
    .unwrap();
    let expected_target = install_root.join("active").join("coforge");
    assert_eq!(
        fs::read_link(binary_directory.join("coforge")).unwrap(),
        expected_target
    );
    assert!(is_activated(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        "0.1.0"
    ));

    activate(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: "0.2.0".into(),
            previous: Some("0.1.0".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read_link(binary_directory.join("coforge")).unwrap(),
        expected_target
    );
    assert_eq!(
        fs::read_to_string(binary_directory.join("coforge")).unwrap(),
        "#!/bin/sh\necho 0.2.0\n"
    );

    fs::remove_file(binary_directory.join("coforge")).unwrap();
    assert!(!is_activated(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        "0.2.0"
    ));
    activate(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: "0.2.0".into(),
            previous: Some("0.1.0".into()),
        },
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read_link(binary_directory.join("coforge")).unwrap(),
        expected_target
    );
}

#[test]
fn foreign_coforge_file_warns_stays_untouched_and_completes_activation() {
    let scratch = Scratch::new("cli-shim-conflict");
    let install_root = scratch.install_root();
    let binary_directory = scratch.0.join("bin");
    fs::create_dir_all(&binary_directory).unwrap();
    install_versions(&install_root, &["0.1.0"]);
    let foreign_cli = binary_directory.join("coforge");
    fs::write(&foreign_cli, "#!/bin/sh\necho foreign\n").unwrap();

    let warning = link_cli_shim(&install_root.join("active").join("coforge"), &foreign_cli)
        .unwrap()
        .expect("expected warning when foreign coforge exists");
    assert!(warning.contains(&foreign_cli.display().to_string()));
    assert!(warning.contains("coforge-computer repair"));

    activate(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: "0.1.0".into(),
            previous: None,
        },
        false,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&foreign_cli).unwrap(),
        "#!/bin/sh\necho foreign\n"
    );
    assert!(is_activated(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        "0.1.0"
    ));
    activate(
        &VersionStore::new(&install_root, "linux-arm64"),
        &binary_directory,
        &ActiveState {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            current: "0.1.0".into(),
            previous: None,
        },
        false,
    )
    .unwrap();
}
