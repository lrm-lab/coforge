//! A transfer the feed could not complete is asked for again, at most three times, after waits on
//! the clock; an object that arrived and is wrong, or a failure that will not change, is final.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::rc::Rc;
use std::thread::JoinHandle;
use std::time::Duration;

use super::tests::{TARGET, VERSION, manifest_of};
use super::*;
use crate::clock::VirtualClock;
use crate::digest::measure_bytes;
use crate::manifest::computer_artifact;
use crate::test_support::{Release, Response, Scratch, Server, loopback_feed};

const MANIFEST: &str = "/0.2.0/manifest.json";

/// A loopback feed on `server`, and the virtual clock its waits sleep on.
fn watched(server: &Server) -> (Feed, Rc<VirtualClock>) {
    let clock = Rc::new(VirtualClock::new());
    (loopback_feed(&server.base_url(), clock.clone()), clock)
}

/// `release`'s feed, whose first requests for `path` get `first`, one each.
fn flaky(release: &Release, path: &str, first: Vec<Response>) -> Server {
    Server::start_scripted(release.routes(), BTreeMap::from([(path.to_owned(), first)]))
}

#[test]
fn the_retry_line_names_the_object_the_wait_and_the_attempt() {
    let error = FetchError {
        code: FetchErrorCode::Download,
        message: "http://feed/0.2.0/manifest.json: connection reset".into(),
    };
    let object = object_name("http://feed/0.2.0/manifest.json");

    assert_eq!(
        retry_line(object, 2, Duration::from_secs(2), &error),
        "coforge-installer: retrying manifest.json in 2s (attempt 2 of 3): \
         http://feed/0.2.0/manifest.json: connection reset"
    );
}

#[test]
fn a_manifest_whose_connection_is_dropped_once_arrives_on_the_second_attempt() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(&release, MANIFEST, vec![Response::dropped()]);
    let (feed, clock) = watched(&server);

    let manifest = feed.manifest(VERSION).unwrap();

    assert_eq!(manifest.version, VERSION);
    assert_eq!(server.requests(), [MANIFEST; 2]);
    assert_eq!(clock.sleeps(), [Duration::from_secs(2)]);
}

#[test]
fn the_latest_pointer_is_asked_for_again_too() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(&release, "/latest", vec![Response::dropped()]);
    let (feed, clock) = watched(&server);

    assert_eq!(feed.resolve_version("latest").unwrap(), VERSION);

    assert_eq!(server.requests(), ["/latest"; 2]);
    assert_eq!(clock.sleeps(), [Duration::from_secs(2)]);
}

#[test]
fn an_executable_cut_short_mid_body_is_downloaded_whole_on_the_second_attempt() {
    let release = Release::new(VERSION, TARGET);
    let whole = release.computer_gzip.len();
    let cut = Response::ok(release.computer_gzip[..whole / 2].to_vec()).declaring(whole);
    let server = flaky(&release, &release.computer_path(), vec![cut]);
    let (feed, clock) = watched(&server);
    let out = Scratch::new("feed-retry-computer");
    let manifest = manifest_of(&release);
    let artifact = computer_artifact(&manifest, TARGET).unwrap();

    let identity = feed
        .download_computer(
            VERSION,
            TARGET,
            artifact,
            &out.path().join("coforge-computer"),
        )
        .unwrap();

    assert_eq!(identity, measure_bytes(&release.computer));
    assert_eq!(
        fs::read(out.path().join("coforge-computer")).unwrap(),
        release.computer
    );
    assert_eq!(
        out.entries(),
        ["coforge-computer"],
        "a partial file was left"
    );
    assert_eq!(
        server.requests(),
        [release.computer_path(), release.computer_path()]
    );
    assert_eq!(clock.sleeps(), [Duration::from_secs(2)]);
}

#[test]
fn an_image_library_whose_connection_is_dropped_once_arrives_on_the_second_attempt() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(
        &release,
        &release.photon_wasm_path(),
        vec![Response::dropped()],
    );
    let (feed, clock) = watched(&server);
    let out = Scratch::new("feed-retry-wasm");
    let manifest = manifest_of(&release);

    let identity = feed
        .download_photon_wasm(
            VERSION,
            &manifest.photon_wasm,
            &out.path().join(PHOTON_WASM),
        )
        .unwrap();

    assert_eq!(identity, measure_bytes(&release.photon_wasm));
    assert_eq!(out.entries(), [PHOTON_WASM]);
    assert_eq!(
        server.requests(),
        [release.photon_wasm_path(), release.photon_wasm_path()]
    );
    assert_eq!(clock.sleeps(), [Duration::from_secs(2)]);
}

#[test]
fn a_manifest_answered_503_three_times_is_a_download_failure_after_3_attempts() {
    let release = Release::new(VERSION, TARGET);
    let unavailable = Response::status("503 Service Unavailable");
    let server = flaky(&release, MANIFEST, vec![unavailable; 3]);
    let (feed, clock) = watched(&server);

    let error = feed.manifest(VERSION).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_DOWNLOAD_FAILED"), "{error:?}");
    assert_eq!(server.requests(), [MANIFEST; 3]);
    assert_eq!(
        clock.sleeps(),
        [Duration::from_secs(2), Duration::from_secs(5)]
    );
    let message = error.message();
    assert!(
        message.contains("answered HTTP 503 (3 attempts; "),
        "{message}"
    );
}

#[test]
fn a_manifest_answered_429_once_arrives_on_the_second_attempt() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(
        &release,
        MANIFEST,
        vec![Response::status("429 Too Many Requests")],
    );
    let (feed, _) = watched(&server);

    assert_eq!(feed.manifest(VERSION).unwrap().version, VERSION);
    assert_eq!(server.requests(), [MANIFEST; 2]);
}

#[test]
fn a_missing_manifest_fails_after_one_request_without_waiting() {
    let release = Release::new(VERSION, TARGET);
    let mut routes = release.routes();
    routes.remove(MANIFEST);
    let server = Server::start(routes);
    let (feed, clock) = watched(&server);

    let error = feed.manifest(VERSION).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_DOWNLOAD_FAILED"), "{error:?}");
    assert!(!error.message().contains("attempts"), "{error:?}");
    assert_eq!(server.requests(), [MANIFEST]);
    assert!(clock.sleeps().is_empty());
}

#[test]
fn a_request_the_agent_refuses_to_make_is_not_asked_for_again() {
    // The production agent is HTTPS-only: a plain-HTTP feed is refused before any connection, and
    // would be refused the same way every time.
    let server = Server::start(Release::new(VERSION, TARGET).routes());
    let clock = Rc::new(VirtualClock::new());
    let https = fetch::agent(fetch::Transport::Https);
    let feed = Feed::new(&server.base_url(), https, clock.clone());

    let error = feed.manifest(VERSION).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_DOWNLOAD_FAILED"), "{error:?}");
    assert!(!error.message().contains("attempts"), "{error:?}");
    assert!(server.requests().is_empty());
    assert!(clock.sleeps().is_empty());
}

#[test]
fn an_executable_that_fails_its_checksum_is_not_asked_for_again() {
    let release = Release::new(VERSION, TARGET);
    let server = Server::start(release.routes());
    let (feed, clock) = watched(&server);
    let out = Scratch::new("feed-retry-checksum");
    let manifest = manifest_of(&release);
    let mut artifact = computer_artifact(&manifest, TARGET).unwrap().clone();
    artifact.gzip.identity.checksum = "0".repeat(64);

    let error = feed
        .download_computer(
            VERSION,
            TARGET,
            &artifact,
            &out.path().join("coforge-computer"),
        )
        .unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_INTEGRITY_FAILED"), "{error:?}");
    assert_eq!(server.requests(), [release.computer_path()]);
    assert!(clock.sleeps().is_empty());
    assert!(out.entries().is_empty(), "{:?}", out.entries());
}

/// A feed at `base_url` whose agent has `proxy` (and nothing else from the environment), and its
/// virtual clock.
fn through(base_url: &str, proxy: Option<ureq::Proxy>) -> (Feed, Rc<VirtualClock>) {
    let clock = Rc::new(VirtualClock::new());
    let agent = ureq::Agent::config_builder()
        .proxy(proxy)
        .max_redirects(0)
        .build()
        .new_agent();
    (Feed::new(base_url, agent, clock.clone()), clock)
}

/// A port on loopback that nothing listens on.
fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

#[test]
fn the_final_message_says_whether_a_proxy_was_configured_and_never_names_it() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(&release, MANIFEST, vec![Response::dropped(); 3]);
    let (direct, _) = through(&server.base_url(), None);
    let message = direct.manifest(VERSION).unwrap_err().message().to_owned();
    assert!(message.ends_with("(3 attempts; no proxy)"), "{message}");

    // A proxy that refuses every connection: the feed itself is never reached.
    let port = closed_port();
    let proxy = ureq::Proxy::new(&format!("http://someone:hunter2@127.0.0.1:{port}")).unwrap();
    let (proxied, clock) = through(&server.base_url(), Some(proxy));
    let error = proxied.manifest(VERSION).unwrap_err();

    assert_eq!(error.code(), Some("UPDATE_DOWNLOAD_FAILED"), "{error:?}");
    let message = error.message();
    assert!(
        message.ends_with("(3 attempts; proxy configured)"),
        "{message}"
    );
    assert!(!message.contains("hunter2"), "{message}");
    assert!(!message.contains(&port.to_string()), "{message}");
    assert_eq!(clock.sleeps().len(), 2);
    assert_eq!(server.requests(), [MANIFEST; 3]);
}

#[test]
fn a_proxy_that_no_proxy_bypasses_for_the_feed_is_reported_as_bypassed() {
    let release = Release::new(VERSION, TARGET);
    let server = flaky(&release, MANIFEST, vec![Response::dropped(); 3]);
    let proxy = ureq::Proxy::builder(ureq::ProxyProtocol::Http)
        .host("127.0.0.1")
        .port(closed_port())
        .no_proxy("127.0.0.1")
        .build()
        .unwrap();
    let (feed, _) = through(&server.base_url(), Some(proxy));

    let message = feed.manifest(VERSION).unwrap_err().message().to_owned();

    assert!(
        message.ends_with("(3 attempts; proxy bypassed)"),
        "{message}"
    );
    assert_eq!(
        server.requests(),
        [MANIFEST; 3],
        "the feed was not reached directly"
    );
}

/// Reads one request head and returns its first line.
fn request_line(reader: &mut impl BufRead) -> String {
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    let mut header = String::new();
    while reader.read_line(&mut header).unwrap() > 0 && header != "\r\n" {
        header.clear();
    }
    first.trim_end().to_owned()
}

/// A loopback CONNECT proxy. Its first connections get `refusals`, one each (an empty one closes
/// without a word); the next one gets a tunnel, in which the proxy itself answers the request
/// with `body`. The thread returns every request line it read.
fn connect_proxy(refusals: Vec<&'static str>, body: Vec<u8>) -> (u16, JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let thread = std::thread::spawn(move || {
        let mut lines = Vec::new();
        for refusal in refusals.into_iter().map(Some).chain([None]) {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            lines.push(request_line(&mut reader));
            let Some(refusal) = refusal else {
                stream
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .unwrap();
                lines.push(request_line(&mut reader));
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
                break;
            };
            stream.write_all(refusal.as_bytes()).unwrap();
        }
        lines
    });
    (port, thread)
}

#[test]
fn a_proxy_that_refuses_connect_once_is_asked_again() {
    let release = Release::new(VERSION, TARGET);
    let body = release.manifest().to_string().into_bytes();
    for (name, refusal) in [
        (
            "503",
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
        ),
        ("no answer", ""),
    ] {
        let (port, proxy) = connect_proxy(vec![refusal], body.clone());
        let agent_proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{port}")).unwrap();
        let (feed, clock) = through("http://127.0.0.1:9", Some(agent_proxy));

        let manifest = feed.manifest(VERSION).unwrap();

        assert_eq!(manifest.version, VERSION, "{name}");
        assert_eq!(clock.sleeps(), [Duration::from_secs(2)], "{name}");
        let lines = proxy.join().unwrap();
        assert_eq!(
            lines,
            [
                "CONNECT 127.0.0.1:9 HTTP/1.1",
                "CONNECT 127.0.0.1:9 HTTP/1.1",
                "GET /0.2.0/manifest.json HTTP/1.1",
            ],
            "{name}"
        );
    }
}

#[test]
fn an_upgrade_whose_manifest_connection_is_reset_once_succeeds() {
    use crate::contract::ReceiptStatus;
    use crate::processes::fakes::FakeTable;
    use crate::service::ServiceState;
    use crate::upgrade::fakes::{
        FakeLifecycle, FakeService, Fixture, NEW, OLD, REQUEST, protocol, stopped,
    };
    use crate::upgrade::{Outcome, UpgradeRequest, upgrade};

    let first = BTreeMap::from([(MANIFEST.to_owned(), vec![Response::dropped()])]);
    let fixture = Fixture::with_first_answers("upgrade-manifest-reset", first);
    fixture.install_old();
    let clock = VirtualClock::new();
    let table = FakeTable::new(&clock);
    let service = FakeService::new(ServiceState::NotInstalled);
    let lifecycle = FakeLifecycle::default();
    lifecycle.answers_status(&fixture.computer(OLD), vec![Some(stopped(OLD))]);
    lifecycle.answers_protocol(&fixture.computer(NEW), vec![Some(protocol(NEW))]);
    let ports = fixture.ports(&lifecycle, &service, &table, &clock);
    let request = UpgradeRequest {
        request_id: REQUEST,
        selection: "latest",
        caller: None,
        allow_downgrade: false,
    };

    let outcome = upgrade(&ports, &request, &mut |_| {});

    let Outcome::Receipt(receipt) = outcome else {
        panic!("expected a receipt, got {outcome:?}");
    };
    assert_eq!(receipt.status(), ReceiptStatus::Succeeded, "{receipt:?}");
    assert_eq!(receipt.version(), Some(NEW));
    assert_eq!(receipt.exit_code(), 0);
}
