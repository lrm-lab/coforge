use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use sha2::{Digest, Sha256};
use ureq::http::StatusCode;
use ureq::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_RANGE, RANGE};

use super::{FetchError, FetchErrorCode, FetchReceipt, FetchRequest, install};
use crate::digest::hex;
use crate::private_fs::create_private_directory;

pub(crate) fn fetch(
    agent: &ureq::Agent,
    request: &FetchRequest,
    install_root: &Path,
) -> Result<FetchReceipt, FetchError> {
    let started = Instant::now();
    let path = cache_path(install_root, request).map_err(local)?;
    let mut wire = open_cache(&path).map_err(local)?;
    let result = fetch_and_install(agent, request, &mut wire);
    drop(wire);

    if !matches!(&result, Err(error) if error.is_transient()) {
        let _ = fs::remove_file(path);
    }
    result.map(|mut receipt| {
        receipt.elapsed_ms = started.elapsed().as_millis();
        receipt
    })
}

fn fetch_and_install(
    agent: &ureq::Agent,
    request: &FetchRequest,
    cache: &mut File,
) -> Result<FetchReceipt, FetchError> {
    let reused_prefix = fill_cache(agent, request, cache)?;
    match install_cached(cache, request) {
        Err(error)
            if reused_prefix
                && matches!(
                    error.code,
                    FetchErrorCode::ChecksumMismatch | FetchErrorCode::GzipInvalid
                ) =>
        {
            reset(cache).map_err(local)?;
            fill_cache(agent, request, cache)?;
            install_cached(cache, request)
        }
        result => result,
    }
}

fn install_cached(cache: &mut File, request: &FetchRequest) -> Result<FetchReceipt, FetchError> {
    cache.rewind().map_err(local)?;
    install(cache, true, request)
}

fn fill_cache(
    agent: &ureq::Agent,
    request: &FetchRequest,
    cache: &mut File,
) -> Result<bool, FetchError> {
    let mut offset = cache.seek(SeekFrom::End(0)).map_err(local)?;
    if offset > request.max_wire_bytes {
        reset(cache).map_err(local)?;
        offset = 0;
    }
    if offset < request.max_wire_bytes {
        let response = get(agent, &request.url, offset);
        let response = if offset > 0 {
            match response {
                Ok(response) if response.status() == StatusCode::OK => {
                    offset = 0;
                    reset(cache).map_err(local)?;
                    response
                }
                Ok(response) if valid_range(&response, offset, request.max_wire_bytes) => response,
                Ok(_)
                | Err(FetchError {
                    code: FetchErrorCode::HttpStatus(416),
                    ..
                }) => {
                    offset = 0;
                    reset(cache).map_err(local)?;
                    get(agent, &request.url, 0)?
                }
                Err(error) => return Err(error),
            }
        } else {
            response?
        };
        if offset == 0 && response.status() != StatusCode::OK {
            return Err(FetchError::http_status(
                &request.url,
                response.status().as_u16(),
            ));
        }
        if response
            .headers()
            .get(CONTENT_ENCODING)
            .is_some_and(|value| !value.as_bytes().eq_ignore_ascii_case(b"identity"))
        {
            return Err(FetchError::new(
                FetchErrorCode::Rejected,
                "response encoded the wire object",
            ));
        }
        let remaining = request.max_wire_bytes - offset;
        receive(response.into_body().into_reader(), cache, remaining)?;
        cache.sync_all().map_err(local)?;
    }
    Ok(offset > 0)
}

fn get(
    agent: &ureq::Agent,
    url: &str,
    offset: u64,
) -> Result<ureq::http::Response<ureq::Body>, FetchError> {
    let mut request = agent.get(url).header(ACCEPT_ENCODING, "identity");
    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }
    let response = request
        .call()
        .map_err(|error| FetchError::request(url, error))?;
    if !response.status().is_success() {
        return Err(FetchError::http_status(url, response.status().as_u16()));
    }
    Ok(response)
}

fn valid_range(response: &ureq::http::Response<ureq::Body>, offset: u64, total: u64) -> bool {
    response.status() == StatusCode::PARTIAL_CONTENT
        && response.headers().get(CONTENT_RANGE).is_some_and(|value| {
            value.as_bytes() == format!("bytes {offset}-{}/{total}", total - 1).as_bytes()
        })
}

fn receive(mut body: impl Read, cache: &mut File, mut remaining: u64) -> Result<(), FetchError> {
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = body.read(&mut buffer[..limit]).map_err(transport)?;
        if count == 0 {
            return Err(FetchError::new(
                FetchErrorCode::Download,
                "response ended before the recorded size",
            ));
        }
        cache.write_all(&buffer[..count]).map_err(local)?;
        remaining -= count as u64;
    }
    if body.read(&mut buffer[..1]).map_err(transport)? != 0 {
        return Err(FetchError::new(
            FetchErrorCode::SizeLimit,
            "response exceeds the recorded size",
        ));
    }
    Ok(())
}

fn reset(cache: &mut File) -> io::Result<()> {
    cache.set_len(0)?;
    cache.rewind()
}

fn cache_path(install_root: &Path, request: &FetchRequest) -> io::Result<PathBuf> {
    let directory = install_root.join(".wire-downloads");
    match create_private_directory(&directory) {
        Ok(()) => {}
        Err(error)
            if error.kind() == io::ErrorKind::AlreadyExists
                && fs::symlink_metadata(&directory)?.file_type().is_dir() => {}
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let key = hex(&Sha256::digest(format!(
        "{}\n{}\n{}",
        request.url, request.sha256, request.max_wire_bytes
    )));
    let path = directory.join(format!("{key}.partial"));
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if entry.path() == path || !entry.file_type()?.is_file() {
            continue;
        }
        if entry.file_name().to_str().is_some_and(is_cache_entry) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(path)
}

fn is_cache_entry(name: &str) -> bool {
    name.strip_suffix(".partial")
        .is_some_and(|key| key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn open_cache(path: &Path) -> io::Result<File> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => return Err(io::ErrorKind::InvalidInput.into()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(file)
}

fn local(error: io::Error) -> FetchError {
    FetchError::new(FetchErrorCode::Write, error.to_string())
}

fn transport(error: io::Error) -> FetchError {
    FetchError::new(FetchErrorCode::Download, error.to_string())
}
