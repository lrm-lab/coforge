use super::tests::{TARGET, VERSION, manifest_of};
use crate::manifest::computer_artifact;
use crate::test_support::{Release, Response, Scratch, Server, loopback_feed};
use std::collections::BTreeMap;

#[test]
fn a_new_feed_client_resumes_the_verified_wire_object_after_interruption() {
    let release = Release::new(VERSION, TARGET);
    let manifest = manifest_of(&release);
    let artifact = computer_artifact(&manifest, TARGET).unwrap();
    let wire = &release.computer_gzip;
    let offset = wire.len() / 2;
    let path = release.computer_path();
    let server = Server::start_scripted(
        release.routes(),
        BTreeMap::from([(
            path.clone(),
            vec![
                Response::ok(wire[..offset].to_vec()).declaring(wire.len()),
                Response::dropped(),
                Response::dropped(),
                Response::partial(offset, wire.len(), wire[offset..].to_vec()),
            ],
        )]),
    );
    let root = Scratch::new("resume-wire");
    let out = root.path().join("computer");
    let failed =
        loopback_feed(&server.base_url(), Default::default()).with_resume_cache(root.path());
    assert!(
        failed
            .download_computer(VERSION, TARGET, artifact, &out)
            .is_err()
    );
    assert!(!out.exists());
    let restarted =
        loopback_feed(&server.base_url(), Default::default()).with_resume_cache(root.path());
    restarted
        .download_computer(VERSION, TARGET, artifact, &out)
        .unwrap();
    assert_eq!(std::fs::read(out).unwrap(), release.computer);
    assert_eq!(
        server.requested_ranges(&path),
        [
            None,
            Some(format!("bytes={offset}-")),
            Some(format!("bytes={offset}-")),
            Some(format!("bytes={offset}-")),
        ]
    );
}

#[test]
fn a_full_response_to_a_range_request_replaces_the_prefix() {
    let release = Release::new(VERSION, TARGET);
    let wire = &release.computer_gzip;
    let offset = wire.len() / 2;
    assert_recovers_with(
        &release,
        vec![Response::ok(wire[..offset].to_vec()).declaring(wire.len())],
        &[None, Some(format!("bytes={offset}-"))],
    );
}

#[test]
fn a_wrong_range_response_restarts_without_appending_its_bytes() {
    let release = Release::new(VERSION, TARGET);
    let wire = &release.computer_gzip;
    let offset = wire.len() / 2;
    assert_recovers_with(
        &release,
        vec![
            Response::ok(wire[..offset].to_vec()).declaring(wire.len()),
            Response::partial(offset + 1, wire.len(), wire[offset + 1..].to_vec()),
        ],
        &[None, Some(format!("bytes={offset}-")), None],
    );
}

#[test]
fn a_corrupt_cached_prefix_restarts_and_rechecks_the_whole_object() {
    let release = Release::new(VERSION, TARGET);
    let wire = &release.computer_gzip;
    let offset = wire.len() / 2;
    let mut corrupted_prefix = wire[..offset].to_vec();
    corrupted_prefix[0] ^= 1;
    assert_recovers_with(
        &release,
        vec![
            Response::ok(corrupted_prefix).declaring(wire.len()),
            Response::partial(offset, wire.len(), wire[offset..].to_vec()),
        ],
        &[None, Some(format!("bytes={offset}-")), None],
    );
}

fn assert_recovers_with(release: &Release, initial: Vec<Response>, ranges: &[Option<String>]) {
    let path = release.computer_path();
    let server =
        Server::start_scripted(release.routes(), BTreeMap::from([(path.clone(), initial)]));
    let manifest = manifest_of(release);
    let artifact = computer_artifact(&manifest, TARGET).unwrap();
    let root = Scratch::new("resume-restart");
    let out = root.path().join("computer");
    loopback_feed(&server.base_url(), Default::default())
        .with_resume_cache(root.path())
        .download_computer(VERSION, TARGET, artifact, &out)
        .unwrap();
    assert_eq!(std::fs::read(out).unwrap(), release.computer);
    assert_eq!(server.requested_ranges(&path), ranges);
    assert!(
        std::fs::read_dir(root.path().join(".wire-downloads"))
            .unwrap()
            .next()
            .is_none()
    );
}
