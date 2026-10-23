//! `coforge-installer` command line. Parses arguments, calls the installation use cases, prints
//! the result, and maps the outcome to an exit status. No installation logic lives here.
//!
//! Commands:
//!   coforge-installer --version
//!   coforge-installer install --version <latest|X.Y.Z> [--from-directory <dir>] [--allow-downgrade]
//!   coforge-installer upgrade --request-id <uuid> --version <latest|X.Y.Z> [--caller-pid <pid>]
//!                             [--from-directory <dir>] [--allow-downgrade]
//!   coforge-installer recover [--caller-pid <pid>]
//!   coforge-installer repair [--version <latest|X.Y.Z> | --channel main|latest] [--yes]
//!                             [--allow-downgrade] [--json]
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

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use coforge_installer::compiled_feed;
use coforge_installer::contract::{EXIT_FAILED, ReceiptStatus, UpgradeReceipt};
use coforge_installer::installation::{self, ReleaseOrigin, Setup};
use coforge_installer::recover::RecoverOutcome;
use coforge_installer::request_id::new_request_id;
use coforge_installer::upgrade::Outcome;

const VERSION: &str = env!("CARGO_PKG_VERSION");

mod args;
use args::{Command, parse};

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
            json,
        } => transaction(
            &setup,
            &new_request_id(),
            &selection,
            None,
            from_directory,
            allow_downgrade,
            json,
        ),
        Command::Upgrade {
            request_id,
            selection,
            caller_pid,
            from_directory,
            allow_downgrade,
            json,
        } => transaction(
            &setup,
            &request_id,
            &selection,
            caller_pid,
            from_directory,
            allow_downgrade,
            json,
        ),
        Command::Recover { caller_pid, json } => recover(&setup, caller_pid, json),
        Command::Repair {
            selection,
            allow_downgrade,
            json,
        } => repair(
            &setup,
            &new_request_id(),
            selection.as_deref(),
            allow_downgrade,
            json,
        ),
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
    json: bool,
) -> ExitCode {
    let origin = from_directory.map_or(ReleaseOrigin::Feed, ReleaseOrigin::Directory);
    let mut report_stage = |line: &str| {
        if json {
            eprintln!("==> {line}");
        } else {
            stage(line);
        }
    };
    match installation::transaction(
        setup,
        request_id,
        selection,
        caller_pid,
        &origin,
        allow_downgrade,
        &mut report_stage,
    ) {
        Ok(Outcome::Receipt(receipt)) => report_receipt_mode(&receipt, json),
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

fn report_receipt_mode(receipt: &UpgradeReceipt, json: bool) -> ExitCode {
    if json {
        match serde_json::to_string(receipt) {
            Ok(text) => println!("{text}"),
            Err(error) => return fail(&error.to_string()),
        }
        ExitCode::from(receipt.exit_code())
    } else {
        report_receipt(receipt)
    }
}

fn recover(setup: &Setup, caller_pid: Option<u32>, json: bool) -> ExitCode {
    let mut report_stage = |line: &str| {
        if json {
            eprintln!("==> {line}");
        } else {
            stage(line);
        }
    };
    match installation::recover(setup, caller_pid, &mut report_stage) {
        Ok(outcome) => {
            let exit = outcome.exit_code();
            if json {
                println!("{{\"exit_code\":{exit}}}");
            } else {
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
            }
            ExitCode::from(exit)
        }
        Err(message) => fail(&message),
    }
}

fn repair(
    setup: &Setup,
    request_id: &str,
    selection: Option<&str>,
    allow_downgrade: bool,
    json: bool,
) -> ExitCode {
    let mut report_stage = |line: &str| {
        if json {
            eprintln!("==> {line}");
        } else {
            stage(line);
        }
    };
    match installation::repair(
        setup,
        request_id,
        selection,
        allow_downgrade,
        &mut report_stage,
    ) {
        Ok(Outcome::Receipt(receipt)) => report_receipt_mode(&receipt, json),
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
