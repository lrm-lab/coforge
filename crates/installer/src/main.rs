//! `coforge-installer` command line. Parses arguments, calls the installation use cases, prints
//! the result, and maps the outcome to an exit status. No installation logic lives here.
//!
//! Commands:
//!   coforge-installer --version
//!   coforge-installer install --version <latest|X.Y.Z> [--from-directory <dir>] [--allow-downgrade]
//!   coforge-installer upgrade --request-id <uuid> --version <latest|X.Y.Z> [--caller-pid <pid>]
//!                             [--from-directory <dir>] [--allow-downgrade]
//!   coforge-installer recover [--caller-pid <pid>]
//!   coforge-installer repair
//!   coforge-installer status [--json]
//!
//! Exit status (`contract.rs`): 0 succeeded, 1 failed (a receipt, or a usage error that wrote
//! nothing), 2 held (another run holds the lock, or the request id is used for something else),
//! 3 unresolved (recovery is needed, or a rollback failed). `install` and `upgrade` print each
//! stage as `==> <stage>`; a refusal's message goes to stderr as `coforge-installer: <message>`.
//!
//! The release feed is the one compiled into this build (`compiled_feed.rs`); no command takes one.
//! `--from-directory` takes one concrete version's objects from a local directory instead, in the
//! layout of the Computer's local package; it is refused with `latest`.

use std::ffi::OsString;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use coforge_installer::compiled_feed;
use coforge_installer::contract::{EXIT_FAILED, ReceiptStatus, UpgradeReceipt, is_request_id};
use coforge_installer::installation::{self, ReleaseOrigin, Setup};
use coforge_installer::recover::RecoverOutcome;
use coforge_installer::request_id::new_request_id;
use coforge_installer::upgrade::Outcome;
use coforge_installer::version::is_valid_release_version;
use lexopt::ValueExt;

const VERSION: &str = env!("CARGO_PKG_VERSION");

enum Command {
    Version,
    Install {
        selection: String,
        from_directory: Option<PathBuf>,
        allow_downgrade: bool,
    },
    Upgrade {
        request_id: String,
        selection: String,
        caller_pid: Option<u32>,
        from_directory: Option<PathBuf>,
        allow_downgrade: bool,
    },
    Recover {
        caller_pid: Option<u32>,
    },
    Repair,
    Status {
        json: bool,
    },
}

fn main() -> ExitCode {
    let command = match parse(std::env::args_os().skip(1)) {
        Ok(command) => command,
        Err(message) => return fail(&message),
    };
    if let Command::Version = command {
        println!("coforge-installer {VERSION}");
        return ExitCode::SUCCESS;
    }
    let setup = match compiled_feed::compiled().and_then(Setup::current) {
        Ok(setup) => setup,
        Err(message) => return fail(&message),
    };
    match command {
        Command::Version => ExitCode::SUCCESS,
        Command::Install {
            selection,
            from_directory,
            allow_downgrade,
        } => transaction(
            &setup,
            &new_request_id(),
            &selection,
            None,
            from_directory,
            allow_downgrade,
        ),
        Command::Upgrade {
            request_id,
            selection,
            caller_pid,
            from_directory,
            allow_downgrade,
        } => transaction(
            &setup,
            &request_id,
            &selection,
            caller_pid,
            from_directory,
            allow_downgrade,
        ),
        Command::Recover { caller_pid } => recover(&setup, caller_pid),
        Command::Repair => repair(&setup, &new_request_id()),
        Command::Status { json } => status(&setup, json),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("coforge-installer: {message}");
    ExitCode::from(EXIT_FAILED)
}

/// Prints each stage line as it happens: a long download must not look hung when piped.
fn stage(line: &str) {
    println!("==> {line}");
    let _ = io::stdout().flush();
}

fn transaction(
    setup: &Setup,
    request_id: &str,
    selection: &str,
    caller_pid: Option<u32>,
    from_directory: Option<PathBuf>,
    allow_downgrade: bool,
) -> ExitCode {
    let origin = from_directory.map_or(ReleaseOrigin::Feed, ReleaseOrigin::Directory);
    match installation::transaction(
        setup,
        request_id,
        selection,
        caller_pid,
        &origin,
        allow_downgrade,
        &mut stage,
    ) {
        Ok(Outcome::Receipt(receipt)) => report_receipt(&receipt),
        Ok(Outcome::NoReceipt { exit, message }) => {
            eprintln!("coforge-installer: {message}");
            ExitCode::from(exit)
        }
        Err(message) => fail(&message),
    }
}

fn report_receipt(receipt: &UpgradeReceipt) -> ExitCode {
    match (receipt.status(), receipt.version()) {
        (ReceiptStatus::Succeeded, Some(version)) => {
            println!("CoForge Computer {version} is active.")
        }
        _ => {
            let error = receipt.error().unwrap_or("the upgrade did not succeed");
            // `CODE: message`, as the Computer prints an `UpdateError`.
            match receipt.error_code() {
                Some(code) => eprintln!("coforge-installer: {code}: {error}"),
                None => eprintln!("coforge-installer: {error}"),
            }
        }
    }
    ExitCode::from(receipt.exit_code())
}

fn recover(setup: &Setup, caller_pid: Option<u32>) -> ExitCode {
    match installation::recover(setup, caller_pid, &mut stage) {
        Ok(outcome) => {
            let exit = outcome.exit_code();
            match outcome {
                RecoverOutcome::NothingToRecover => println!("nothing to recover"),
                RecoverOutcome::Recovered { version } => {
                    println!("CoForge Computer {version} is active.");
                }
                RecoverOutcome::Held { message }
                | RecoverOutcome::Refused { message }
                | RecoverOutcome::Unresolved { message } => {
                    eprintln!("coforge-installer: {message}");
                }
            }
            ExitCode::from(exit)
        }
        Err(message) => fail(&message),
    }
}

fn repair(setup: &Setup, request_id: &str) -> ExitCode {
    match installation::repair(setup, request_id, &mut stage) {
        Ok(Outcome::Receipt(receipt)) => report_receipt(&receipt),
        Ok(Outcome::NoReceipt { exit, message }) => {
            eprintln!("coforge-installer: {message}");
            ExitCode::from(exit)
        }
        Err(message) => fail(&message),
    }
}

fn status(setup: &Setup, json: bool) -> ExitCode {
    let report = installation::status(setup);
    if json {
        match serde_json::to_string(&report) {
            Ok(text) => println!("{text}"),
            Err(error) => return fail(&error.to_string()),
        }
    } else {
        for line in report.lines() {
            println!("{line}");
        }
    }
    ExitCode::SUCCESS
}

fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut parser = lexopt::Parser::from_args(args);
    match parser.next().map_err(|error| error.to_string())? {
        Some(Long("version")) => finish(parser, Command::Version),
        Some(Value(value)) => match value.string().map_err(|error| error.to_string())?.as_str() {
            "install" => parse_install(parser),
            "upgrade" => parse_upgrade(parser),
            "recover" => parse_recover(parser),
            "repair" => parse_repair(parser),
            "status" => parse_status(parser),
            other => Err(format!("unknown command: {other}")),
        },
        Some(other) => Err(other.unexpected().to_string()),
        None => Err(
            "expected a command: install, upgrade, recover, repair, status, or --version".into(),
        ),
    }
}

fn finish(mut parser: lexopt::Parser, command: Command) -> Result<Command, String> {
    use lexopt::prelude::*;

    match parser.next().map_err(|error| error.to_string())? {
        None => Ok(command),
        Some(Long(name)) => Err(format!("unexpected option --{name}")),
        Some(other) => Err(other.unexpected().to_string()),
    }
}

fn parse_install(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut selection = None;
    let mut from_directory = None;
    let mut allow_downgrade = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("version") => selection = Some(selection_value(&mut parser)?),
            Long("from-directory") => from_directory = Some(directory_value(&mut parser)?),
            Long("allow-downgrade") => allow_downgrade = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    let selection = selection.ok_or("install requires --version latest or a version")?;
    check_from_directory(&selection, from_directory.is_some())?;
    Ok(Command::Install {
        selection,
        from_directory,
        allow_downgrade,
    })
}

fn parse_upgrade(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut request_id = None;
    let mut selection = None;
    let mut caller_pid = None;
    let mut from_directory = None;
    let mut allow_downgrade = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("request-id") => request_id = Some(value(&mut parser)?),
            Long("version") => selection = Some(selection_value(&mut parser)?),
            Long("caller-pid") => caller_pid = Some(caller_pid_value(&mut parser)?),
            Long("from-directory") => from_directory = Some(directory_value(&mut parser)?),
            Long("allow-downgrade") => allow_downgrade = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    let request_id = request_id.ok_or("upgrade requires --request-id")?;
    if !is_request_id(&request_id) {
        return Err("--request-id must be an RFC 9562 UUID".into());
    }
    let selection = selection.ok_or("upgrade requires --version latest or a version")?;
    check_from_directory(&selection, from_directory.is_some())?;
    Ok(Command::Upgrade {
        request_id,
        selection,
        caller_pid,
        from_directory,
        allow_downgrade,
    })
}

/// `--from-directory` names one version's objects, so `latest` (which needs the feed's pointer)
/// is a usage error.
fn check_from_directory(selection: &str, from_directory: bool) -> Result<(), String> {
    if from_directory && selection == "latest" {
        return Err("--from-directory needs a concrete version, not latest".into());
    }
    Ok(())
}

fn directory_value(parser: &mut lexopt::Parser) -> Result<PathBuf, String> {
    parser
        .value()
        .map(PathBuf::from)
        .map_err(|error| error.to_string())
}

fn parse_recover(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut caller_pid = None;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("caller-pid") => caller_pid = Some(caller_pid_value(&mut parser)?),
            other => return Err(other.unexpected().to_string()),
        }
    }
    Ok(Command::Recover { caller_pid })
}

fn parse_repair(parser: lexopt::Parser) -> Result<Command, String> {
    finish(parser, Command::Repair)
}

fn caller_pid_value(parser: &mut lexopt::Parser) -> Result<u32, String> {
    value(parser)?
        .parse::<u32>()
        .map_err(|_| "--caller-pid takes a process id".to_string())
}

fn parse_status(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut json = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("json") => json = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    Ok(Command::Status { json })
}

fn value(parser: &mut lexopt::Parser) -> Result<String, String> {
    parser
        .value()
        .and_then(|value| value.string())
        .map_err(|error| error.to_string())
}

/// `latest`, or a version the release rules accept.
fn selection_value(parser: &mut lexopt::Parser) -> Result<String, String> {
    let selection = value(parser)?;
    if selection == "latest" || is_valid_release_version(&selection) {
        Ok(selection)
    } else {
        Err(format!(
            "--version takes latest or a version such as 0.2.0, not {selection}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(Into::into).collect()
    }

    #[test]
    fn version_takes_no_arguments() {
        assert!(matches!(parse(args(&["--version"])), Ok(Command::Version)));
        assert!(parse(args(&["--version", "extra"])).is_err());
        assert!(parse(args(&[])).is_err());
    }

    #[test]
    fn a_fetch_command_is_gone() {
        assert!(parse(args(&["fetch", "--url", "https://example.com/a.gz"])).is_err());
    }

    #[test]
    fn upgrade_needs_a_request_id_in_the_contract_form_and_a_selection() {
        assert!(parse(args(&["upgrade", "--version", "latest"])).is_err());
        assert!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "x",
                "--version",
                "latest"
            ]))
            .is_err()
        );
        assert!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
                "--version",
                "latest",
            ]))
            .is_ok()
        );
    }

    #[test]
    fn a_selection_is_latest_or_a_release_version() {
        assert!(parse(args(&["install", "--version", "0.2.0"])).is_ok());
        assert!(parse(args(&["install", "--version", "../etc"])).is_err());
        assert!(parse(args(&["install", "--version", "0.2 0"])).is_err());
    }

    #[test]
    fn recover_takes_a_caller_pid_like_upgrade() {
        assert!(matches!(
            parse(args(&["recover"])),
            Ok(Command::Recover { caller_pid: None })
        ));
        assert!(matches!(
            parse(args(&["recover", "--caller-pid", "42"])),
            Ok(Command::Recover {
                caller_pid: Some(42)
            })
        ));
        assert!(parse(args(&["recover", "--caller-pid", "x"])).is_err());
    }

    #[test]
    fn repair_takes_no_arguments() {
        assert!(matches!(parse(args(&["repair"])), Ok(Command::Repair)));
        assert!(parse(args(&["repair", "--json"])).is_err());
    }

    #[test]
    fn from_directory_takes_a_concrete_version_only() {
        assert!(matches!(
            parse(args(&[
                "install",
                "--version",
                "0.2.0",
                "--from-directory",
                "release-dir"
            ])),
            Ok(Command::Install {
                from_directory: Some(_),
                ..
            })
        ));
        assert!(
            parse(args(&[
                "install",
                "--version",
                "latest",
                "--from-directory",
                "release-dir"
            ]))
            .is_err()
        );
        assert!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
                "--version",
                "latest",
                "--from-directory",
                "release-dir",
            ]))
            .is_err()
        );
        assert!(matches!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
                "--version",
                "0.2.0",
                "--from-directory",
                "release-dir",
            ])),
            Ok(Command::Upgrade {
                from_directory: Some(_),
                ..
            })
        ));
        assert!(matches!(
            parse(args(&["install", "--version", "0.2.0"])),
            Ok(Command::Install {
                from_directory: None,
                ..
            })
        ));
    }

    #[test]
    fn allow_downgrade_is_a_plain_flag_on_install_and_upgrade() {
        assert!(matches!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
                "--version",
                "0.1.0",
                "--allow-downgrade",
            ])),
            Ok(Command::Upgrade {
                allow_downgrade: true,
                ..
            })
        ));
        assert!(matches!(
            parse(args(&[
                "upgrade",
                "--request-id",
                "0b7d2c9e-3a1f-4c8e-9d2b-5f6a7b8c9d0e",
                "--version",
                "0.1.0",
            ])),
            Ok(Command::Upgrade {
                allow_downgrade: false,
                ..
            })
        ));
        assert!(matches!(
            parse(args(&[
                "install",
                "--version",
                "0.1.0",
                "--allow-downgrade"
            ])),
            Ok(Command::Install {
                allow_downgrade: true,
                ..
            })
        ));
        assert!(parse(args(&["recover", "--allow-downgrade"])).is_err());
        assert!(parse(args(&["status", "--allow-downgrade"])).is_err());
    }

    #[test]
    fn status_takes_json_and_nothing_else() {
        assert!(matches!(
            parse(args(&["status", "--json"])),
            Ok(Command::Status { json: true })
        ));
        assert!(parse(args(&["status", "--yaml"])).is_err());
    }
}
