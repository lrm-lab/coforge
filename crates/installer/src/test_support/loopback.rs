//! A loopback HTTP server that answers fixed responses by path, for tests of the release feed
//! client. It speaks just enough HTTP/1.1 for `ureq`: one request per connection, then close.

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// What the `Content-Length` header says about the body.
#[derive(Clone)]
enum Length {
    /// The body's real length.
    Exact,
    /// This many bytes, whatever the body holds.
    Declared(usize),
    /// No header: the end of the connection ends the body.
    Absent,
}

/// What the server does once it has read the request.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Conduct {
    /// Answers, then closes the connection.
    Answer,
    /// Answers, then holds the connection open, silent, until the server is dropped.
    AnswerThenStall,
    /// Closes the connection without answering; the rest of the response is never sent.
    Drop,
}

#[derive(Clone)]
pub(crate) struct Response {
    status: &'static str,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    length: Length,
    conduct: Conduct,
    /// Send the body in pieces of this many bytes, pausing between them.
    drip: Option<(usize, Duration)>,
}

impl Response {
    pub(crate) fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self::with("200 OK", Vec::new(), body.into())
    }

    fn with(status: &'static str, headers: Vec<(&'static str, String)>, body: Vec<u8>) -> Self {
        Self {
            status,
            headers,
            body,
            length: Length::Exact,
            conduct: Conduct::Answer,
            drip: None,
        }
    }

    /// Leaves out `Content-Length`, so only the closed connection tells where the body ends.
    pub(crate) fn without_content_length(mut self) -> Self {
        self.length = Length::Absent;
        self
    }

    /// Announces `length` bytes although the body holds fewer: a connection cut short.
    pub(crate) fn declaring(mut self, length: usize) -> Self {
        self.length = Length::Declared(length);
        self
    }

    /// Sends the body `piece` bytes at a time with `pause` between the pieces: slow, but alive.
    pub(crate) fn dripping(mut self, piece: usize, pause: Duration) -> Self {
        self.drip = Some((piece, pause));
        self
    }

    /// Sends the headers and the body, then holds the connection open, silent, until the
    /// server is dropped.
    pub(crate) fn then_stalling(mut self) -> Self {
        self.conduct = Conduct::AnswerThenStall;
        self
    }

    /// Reads the request and closes the connection without a word: a connection reset before
    /// any answer.
    pub(crate) fn dropped() -> Self {
        Self {
            conduct: Conduct::Drop,
            ..Self::with("", Vec::new(), Vec::new())
        }
    }

    pub(crate) fn status(status: &'static str) -> Self {
        Self::with(status, Vec::new(), b"not the object you asked for".to_vec())
    }

    pub(crate) fn redirect(location: &str) -> Self {
        Self::with(
            "302 Found",
            vec![("Location", location.to_owned())],
            Vec::new(),
        )
    }
}

pub(crate) struct Server {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// Serves `routes` (request path to response); any other path is a 404.
    pub(crate) fn start(routes: BTreeMap<String, Response>) -> Self {
        Self::start_scripted(routes, BTreeMap::new())
    }

    /// Serves `routes`, except that the first requests for a path in `first` get that path's
    /// responses, one per request in order; once they are used up, `routes` answers.
    pub(crate) fn start_scripted(
        routes: BTreeMap<String, Response>,
        first: BTreeMap<String, Vec<Response>>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let first = first
            .into_iter()
            .map(|(path, responses)| (path, VecDeque::from(responses)))
            .collect();
        let routes = Arc::new((routes, Mutex::new(first)));
        let thread = thread::spawn({
            let requests = Arc::clone(&requests);
            let stop = Arc::clone(&stop);
            move || {
                // One thread per connection: a response that stalls must not keep the next
                // connection from being answered.
                let mut connections = Vec::new();
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(stream) = stream {
                        let routes = Arc::clone(&routes);
                        let requests = Arc::clone(&requests);
                        let stop = Arc::clone(&stop);
                        connections.push(thread::spawn(move || {
                            let _ = respond(stream, &routes, &requests, &stop);
                        }));
                    }
                }
                for connection in connections {
                    let _ = connection.join();
                }
            }
        });
        Self {
            address,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub(crate) fn base_url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// The paths requested so far, in order.
    pub(crate) fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocked `accept` so the thread sees the flag.
        let _ = TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The responses still owed to the first requests of each path.
type Scripts = Mutex<BTreeMap<String, VecDeque<Response>>>;

fn respond(
    mut stream: TcpStream,
    (routes, first): &(BTreeMap<String, Response>, Scripts),
    requests: &Mutex<Vec<String>>,
    stop: &AtomicBool,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut header = String::new();
    while reader.read_line(&mut header)? > 0 && header != "\r\n" {
        header.clear();
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    requests.lock().unwrap().push(path.clone());
    let scripted = first
        .lock()
        .unwrap()
        .get_mut(&path)
        .and_then(VecDeque::pop_front);
    let response = scripted
        .or_else(|| routes.get(&path).cloned())
        .unwrap_or_else(|| Response::status("404 Not Found"));
    if response.conduct == Conduct::Drop {
        return Ok(());
    }
    write!(stream, "HTTP/1.1 {}\r\n", response.status)?;
    for (name, value) in &response.headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "Content-Type: application/octet-stream\r\n")?;
    match response.length {
        Length::Exact => write!(stream, "Content-Length: {}\r\n", response.body.len())?,
        Length::Declared(length) => write!(stream, "Content-Length: {length}\r\n")?,
        Length::Absent => {}
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    match response.drip {
        Some((piece, pause)) => {
            for chunk in response.body.chunks(piece) {
                stream.write_all(chunk)?;
                stream.flush()?;
                thread::sleep(pause);
            }
        }
        None => stream.write_all(&response.body)?,
    }
    stream.flush()?;
    while response.conduct == Conduct::AnswerThenStall && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
