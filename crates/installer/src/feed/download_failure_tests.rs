//! A feed that could not deliver an object (nothing was judged) reports a download failure; an
//! object that arrived and breaks the feed's rules is an invalid feed.

use super::tests::{TARGET, VERSION, download_failed, feed};
use super::*;
use crate::test_support::{Release, Response, Server};

#[test]
fn a_manifest_the_feed_could_not_deliver_is_a_download_failure_not_an_invalid_feed() {
    // The incident: the connection was reset while `<version>/manifest.json` was being read.
    // Nothing judged the manifest, so it must not be reported as an invalid one.
    let release = Release::new(VERSION, TARGET);
    let manifest = release.manifest().to_string().into_bytes();
    let cut = manifest[..manifest.len() / 2].to_vec();
    for (name, response) in [
        (
            "connection dropped mid-body",
            Some(Response::ok(cut).declaring(manifest.len())),
        ),
        ("503", Some(Response::status("503 Service Unavailable"))),
        ("404", None),
    ] {
        let mut routes = release.routes();
        match response {
            Some(response) => routes.insert("/0.2.0/manifest.json".into(), response),
            None => routes.remove("/0.2.0/manifest.json"),
        };
        let server = Server::start(routes);

        let error = feed(&server).manifest(VERSION).unwrap_err();

        assert_eq!(
            error.code(),
            Some("UPDATE_DOWNLOAD_FAILED"),
            "{name}: {error:?}"
        );
        assert!(
            error.message().contains("manifest.json"),
            "{name}: {error:?}"
        );
    }

    // Nothing listening: the connection is refused before any answer.
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let unreachable = Feed::new(
        &format!("http://{closed}"),
        crate::fetch::agent(crate::fetch::Transport::LoopbackHttp),
    );
    let message = download_failed(unreachable.manifest(VERSION).unwrap_err());
    assert!(message.contains("manifest.json"), "{message}");
}

#[test]
fn a_manifest_that_arrived_but_is_not_json_is_still_an_invalid_feed() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    routes.insert("/0.2.0/manifest.json".into(), Response::ok("<html>"));
    let server = Server::start(routes);

    let error = feed(&server).manifest(VERSION).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_FEED_INVALID"), "{error:?}");
}

#[test]
fn a_pointer_that_redirects_or_is_missing_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    routes.insert("/latest".into(), Response::redirect("/0.2.0/manifest.json"));
    let server = Server::start(routes);
    download_failed(feed(&server).resolve_version("latest").unwrap_err());
    assert_eq!(server.requests(), ["/latest"], "the redirect was followed");

    let empty = Server::start(Default::default());
    download_failed(feed(&empty).resolve_version("latest").unwrap_err());
}

#[test]
fn a_manifest_that_redirects_or_is_missing_is_rejected() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    let elsewhere = "/0.2.0/elsewhere.json".to_string();
    routes.insert(elsewhere.clone(), routes["/0.2.0/manifest.json"].clone());
    routes.insert(
        "/0.2.0/manifest.json".into(),
        Response::redirect(&elsewhere),
    );
    let server = Server::start(routes);

    download_failed(feed(&server).manifest(VERSION).unwrap_err());
    assert_eq!(server.requests(), ["/0.2.0/manifest.json"]);

    let empty = Server::start(Default::default());
    download_failed(feed(&empty).manifest(VERSION).unwrap_err());
}
