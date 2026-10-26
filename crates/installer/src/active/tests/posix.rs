use std::os::unix::fs::{PermissionsExt, symlink};

use super::*;
use crate::test_support::point_active_at_version;

const TARGET: &str = "linux-x64";

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

struct Layout {
    scratch: Scratch,
    install_root: PathBuf,
    binary_directory: PathBuf,
}

fn layout(label: &str, versions: &[&str]) -> Layout {
    let scratch = Scratch::new(label);
    let install_root = scratch.install_root();
    install_versions(&install_root, "coforge-computer", versions);
    // Two levels that do not exist yet, as on a fresh machine (`~/.local/bin`).
    let binary_directory = scratch.0.join("home").join(".local").join("bin");
    Layout {
        scratch,
        install_root,
        binary_directory,
    }
}

impl Layout {
    fn activate(&self, next: &ActiveState) -> Result<Activation, ActiveError> {
        activate_in(&self.install_root, &self.binary_directory, TARGET, next)
    }

    fn shim(&self) -> PathBuf {
        self.binary_directory.join("coforge-computer")
    }
}

#[test]
fn active_is_the_fixed_link_to_current_and_the_shim_goes_through_it() {
    let layout = layout("links", &["0.2.0"]);
    let next = state("0.2.0", Some("0.1.0"));

    layout.activate(&next).unwrap();

    // Relative, so the installation can be moved as a whole.
    assert_eq!(
        fs::read_link(layout.install_root.join("active")).unwrap(),
        Path::new("current")
    );
    // Absolute, through `active`, so a later switch never rewrites the shim.
    assert_eq!(
        fs::read_link(layout.shim()).unwrap(),
        layout.install_root.join("active").join("coforge-computer")
    );
    // What runs is a copy in `current/`; the version directory stays as the store.
    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
    assert_eq!(
        fs::read_to_string(layout.install_root.join("current/coforge-computer")).unwrap(),
        "0.2.0"
    );
    assert!(
        !fs::symlink_metadata(layout.install_root.join("current"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(read_active(&layout.install_root).unwrap(), Some(next));
}

#[test]
fn the_executable_keeps_one_real_path_across_every_switch_and_rollback() {
    let layout = layout("real-path", &["0.1.0", "0.2.0"]);
    let real = |layout: &Layout| fs::canonicalize(layout.shim()).unwrap();

    layout.activate(&state("0.1.0", None)).unwrap();
    let first = real(&layout);
    layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap();
    let upgraded = real(&layout);
    layout.activate(&state("0.1.0", Some("0.2.0"))).unwrap();
    let rolled_back = real(&layout);

    let expected = fs::canonicalize(&layout.install_root)
        .unwrap()
        .join("current/coforge-computer");
    assert_eq!(
        [first, upgraded, rolled_back],
        [expected.clone(), expected.clone(), expected]
    );
    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.1.0");
    // Both stored versions are untouched: rollback reads them, nothing runs from them.
    for version in ["0.1.0", "0.2.0"] {
        let stored = layout.install_root.join("versions").join(version);
        assert_eq!(
            fs::read_to_string(stored.join("coforge-computer")).unwrap(),
            version
        );
    }
}

#[test]
fn an_active_link_that_points_at_a_version_is_pointed_at_current() {
    let layout = layout("repoint", &["0.1.0"]);
    layout.activate(&state("0.1.0", None)).unwrap();
    // The layout from before `current/`, or what an installer from before it does to this one.
    point_active_at_version(&layout.install_root, "0.1.0");
    fs::remove_dir_all(layout.install_root.join("current")).unwrap();

    layout.activate(&state("0.1.0", None)).unwrap();

    assert_eq!(
        fs::read_link(layout.install_root.join("active")).unwrap(),
        Path::new("current")
    );
    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.1.0");
    assert_eq!(
        fs::canonicalize(layout.shim()).unwrap(),
        fs::canonicalize(&layout.install_root)
            .unwrap()
            .join("current/coforge-computer")
    );
}

#[test]
fn an_activation_is_complete_only_with_active_the_shim_and_current_all_in_place() {
    let layout = layout("is-activated", &["0.1.0"]);
    let store = VersionStore::new(&layout.install_root, TARGET);
    let activated = |layout: &Layout| is_activated(&store, &layout.binary_directory, "0.1.0");
    assert!(!activated(&layout), "nothing is installed yet");
    layout.activate(&state("0.1.0", None)).unwrap();
    assert!(activated(&layout));

    point_active_at_version(&layout.install_root, "0.1.0");
    assert!(!activated(&layout), "active points at the version");
    layout.activate(&state("0.1.0", None)).unwrap();

    fs::write(
        layout.install_root.join("current/coforge-computer"),
        "other",
    )
    .unwrap();
    assert!(!activated(&layout), "current/ differs");
    layout.activate(&state("0.1.0", None)).unwrap();

    fs::remove_file(layout.shim()).unwrap();
    assert!(!activated(&layout), "the shim is gone");
    layout.activate(&state("0.1.0", None)).unwrap();
    assert!(activated(&layout));
}

#[test]
fn a_version_that_cannot_be_copied_leaves_active_on_what_it_was_and_active_json_naming_it() {
    let layout = layout("copy-fails", &["0.1.0"]);
    layout.activate(&state("0.1.0", None)).unwrap();

    // `0.2.0` was never installed: the copy has nothing to read.
    let error = layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap_err();

    assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
    // `active.json` is written first so that running `activate` again finishes the switch.
    assert_eq!(
        read_active(&layout.install_root).unwrap(),
        Some(state("0.2.0", Some("0.1.0")))
    );
    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.1.0");
}

/// What the process umask leaves of `requested` on a directory created now, found by creating
/// one with every bit requested (std offers no way to read the umask without changing it).
fn after_umask(scratch: &Scratch, requested: u32) -> u32 {
    use std::os::unix::fs::DirBuilderExt;
    let probe = scratch.0.join("umask-probe");
    fs::DirBuilder::new().mode(0o777).create(&probe).unwrap();
    let allowed = mode(&probe);
    fs::remove_dir(&probe).unwrap();
    requested & allowed
}

#[test]
fn the_shim_directory_is_world_traversable_and_the_state_file_is_private() {
    let layout = layout("modes", &["0.2.0"]);

    layout.activate(&state("0.2.0", None)).unwrap();

    // 0755, not 0700: `~/.local/bin` is shared with other tools, and a recursive create must
    // not leave `~/.local` owner-only for all of them. The umask still applies, as it does to
    // the Computer's mkdir.
    let expected = after_umask(&layout.scratch, 0o755);
    assert_eq!(mode(&layout.binary_directory), expected);
    assert_eq!(mode(layout.binary_directory.parent().unwrap()), expected);
    assert_eq!(mode(&layout.install_root.join("active.json")), 0o600);
}

#[test]
fn switching_versions_replaces_both_links_and_leaves_no_temporary_behind() {
    let layout = layout("switch", &["0.1.0", "0.2.0"]);

    layout.activate(&state("0.1.0", None)).unwrap();
    layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap();

    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
    assert_eq!(
        fs::read_link(layout.install_root.join("active")).unwrap(),
        Path::new("current")
    );

    // Rollback: the same call in the other direction.
    layout.activate(&state("0.1.0", Some("0.2.0"))).unwrap();

    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.1.0");
    assert_eq!(
        names(&layout.install_root),
        ["active", "active.json", "current", "versions"]
    );
    assert_eq!(names(&layout.binary_directory), ["coforge-computer"]);
    assert_eq!(
        read_active(&layout.install_root).unwrap(),
        Some(state("0.1.0", Some("0.2.0")))
    );
}

#[test]
fn a_shim_that_an_earlier_kind_of_install_left_as_a_file_is_replaced() {
    let layout = layout("old-shim", &["0.2.0"]);
    fs::create_dir_all(&layout.binary_directory).unwrap();
    fs::write(layout.shim(), "an old executable").unwrap();

    layout.activate(&state("0.2.0", None)).unwrap();

    assert!(
        fs::symlink_metadata(layout.shim())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
}

#[test]
fn a_shim_directory_that_exists_keeps_its_mode() {
    let layout = layout("existing-bin", &["0.2.0"]);
    fs::create_dir_all(&layout.binary_directory).unwrap();
    fs::set_permissions(&layout.binary_directory, fs::Permissions::from_mode(0o750)).unwrap();

    layout.activate(&state("0.2.0", None)).unwrap();

    assert_eq!(mode(&layout.binary_directory), 0o750);
}

#[test]
fn a_state_that_names_no_valid_version_changes_nothing() {
    let layout = layout("invalid", &["0.2.0"]);

    let error = layout.activate(&state("../0.2.0", None)).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"));
    assert_eq!(names(&layout.install_root), ["versions"]);
    assert!(!layout.binary_directory.exists());
}

#[test]
fn a_link_that_cannot_be_switched_is_reported_and_leaves_no_temporary_link() {
    let layout = layout("blocked", &["0.2.0"]);
    // A real directory where the link belongs: a symlink cannot be renamed over it.
    fs::create_dir_all(layout.install_root.join("active").join("keep")).unwrap();

    let error = layout.activate(&state("0.2.0", None)).unwrap_err();

    assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
    assert_eq!(error.code(), None);
    assert_eq!(
        names(&layout.install_root),
        ["active", "active.json", "current", "versions"]
    );
    assert!(layout.install_root.join("active/keep").is_dir());
}

/// The Computer's order: `active.json`, then `active`, then the shim. A shim that cannot be
/// replaced therefore fails after `active` has switched, and the shim (which points through
/// `active`) is the only thing left behind.
#[test]
fn a_shim_that_cannot_be_switched_fails_after_active_has_switched() {
    let layout = layout("blocked-shim", &["0.1.0", "0.2.0"]);
    layout.activate(&state("0.1.0", None)).unwrap();
    fs::remove_file(layout.shim()).unwrap();
    // A real, non-empty directory where the shim belongs: a symlink cannot be renamed over it.
    fs::create_dir_all(layout.shim().join("keep")).unwrap();

    let error = layout.activate(&state("0.2.0", Some("0.1.0"))).unwrap_err();

    assert!(matches!(error, ActiveError::Io(_)), "{error:?}");
    assert_eq!(
        fs::read_link(layout.install_root.join("active")).unwrap(),
        Path::new("current")
    );
    assert_eq!(
        read_active(&layout.install_root).unwrap(),
        Some(state("0.2.0", Some("0.1.0")))
    );
    assert!(layout.shim().join("keep").is_dir());
    assert_eq!(names(&layout.binary_directory), ["coforge-computer"]);
}

#[test]
fn the_shim_is_reachable_when_the_install_root_is_itself_a_link() {
    // ~/.coforge may be a symlink to another disk; the absolute shim target still resolves.
    let layout = layout("linked-root", &["0.2.0"]);
    let alias = layout.scratch.0.join("alias");
    symlink(&layout.install_root, &alias).unwrap();

    activate_in(
        &alias,
        &layout.binary_directory,
        TARGET,
        &state("0.2.0", None),
    )
    .unwrap();

    assert_eq!(fs::read_to_string(layout.shim()).unwrap(), "0.2.0");
}
