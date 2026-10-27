use std::ffi::OsString;
use std::path::PathBuf;

use coforge_installer::contract::is_request_id;
use coforge_installer::version::is_valid_release_version;
use lexopt::ValueExt;

pub(crate) enum Command {
    Version,
    Install {
        selection: String,
        from_directory: Option<PathBuf>,
        allow_downgrade: bool,
        json: bool,
    },
    Upgrade {
        request_id: String,
        selection: String,
        caller_pid: Option<u32>,
        from_directory: Option<PathBuf>,
        allow_downgrade: bool,
        json: bool,
    },
    Recover {
        caller_pid: Option<u32>,
        json: bool,
    },
    Repair {
        selection: Option<String>,
        allow_downgrade: bool,
        json: bool,
    },
    Start {
        caller_pid: Option<u32>,
    },
    Status {
        json: bool,
    },
}

pub(crate) fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut parser = lexopt::Parser::from_args(args);
    match parser.next().map_err(|error| error.to_string())? {
        Some(Long("version")) => finish(parser, Command::Version),
        Some(Value(value)) => match value.string().map_err(|error| error.to_string())?.as_str() {
            "install" => parse_install(parser),
            "upgrade" => parse_upgrade(parser),
            "recover" => parse_recover(parser),
            "repair" => parse_repair(parser),
            "start" => parse_start(parser),
            "status" => parse_status(parser),
            other => Err(format!("unknown command: {other}")),
        },
        Some(other) => Err(other.unexpected().to_string()),
        None => Err(
            "expected a command: install, upgrade, recover, repair, start, status, or --version"
                .into(),
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
    let mut channel = None;
    let mut from_directory = None;
    let mut allow_downgrade = false;
    let mut json = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("version") => selection = Some(selection_value(&mut parser)?),
            Long("channel") => channel = Some(channel_value(&mut parser)?),
            Long("yes") => {}
            Long("from-directory") => from_directory = Some(directory_value(&mut parser)?),
            Long("allow-downgrade") => allow_downgrade = true,
            Long("json") => json = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    let selection = combine_selection(selection, channel)?
        .ok_or("install requires --version/latest or --channel main/latest")?;
    check_from_directory(&selection, from_directory.is_some())?;
    Ok(Command::Install {
        selection,
        from_directory,
        allow_downgrade,
        json,
    })
}

fn parse_upgrade(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut request_id = None;
    let mut selection = None;
    let mut channel = None;
    let mut caller_pid = None;
    let mut from_directory = None;
    let mut allow_downgrade = false;
    let mut json = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("request-id") => request_id = Some(value(&mut parser)?),
            Long("version") => selection = Some(selection_value(&mut parser)?),
            Long("channel") => channel = Some(channel_value(&mut parser)?),
            Long("yes") => {}
            Long("caller-pid") => caller_pid = Some(caller_pid_value(&mut parser)?),
            Long("from-directory") => from_directory = Some(directory_value(&mut parser)?),
            Long("allow-downgrade") => allow_downgrade = true,
            Long("json") => json = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    let request_id = request_id.ok_or("upgrade requires --request-id")?;
    if !is_request_id(&request_id) {
        return Err("--request-id must be an RFC 9562 UUID".into());
    }
    let selection = combine_selection(selection, channel)?
        .ok_or("upgrade requires --version/latest or --channel main/latest")?;
    check_from_directory(&selection, from_directory.is_some())?;
    Ok(Command::Upgrade {
        request_id,
        selection,
        caller_pid,
        from_directory,
        allow_downgrade,
        json,
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
    let mut json = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("caller-pid") => caller_pid = Some(caller_pid_value(&mut parser)?),
            Long("json") => json = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    Ok(Command::Recover { caller_pid, json })
}

fn parse_start(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut caller_pid = None;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("caller-pid") => caller_pid = Some(caller_pid_value(&mut parser)?),
            other => return Err(other.unexpected().to_string()),
        }
    }
    Ok(Command::Start { caller_pid })
}

fn parse_repair(mut parser: lexopt::Parser) -> Result<Command, String> {
    use lexopt::prelude::*;

    let mut selection = None;
    let mut channel = None;
    let mut allow_downgrade = false;
    let mut json = false;
    while let Some(arg) = parser.next().map_err(|error| error.to_string())? {
        match arg {
            Long("version") => selection = Some(selection_value(&mut parser)?),
            Long("channel") => channel = Some(channel_value(&mut parser)?),
            Long("yes") => {}
            Long("allow-downgrade") => allow_downgrade = true,
            Long("json") => json = true,
            other => return Err(other.unexpected().to_string()),
        }
    }
    Ok(Command::Repair {
        selection: combine_selection(selection, channel)?,
        allow_downgrade,
        json,
    })
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

fn channel_value(parser: &mut lexopt::Parser) -> Result<String, String> {
    let channel = value(parser)?;
    match channel.as_str() {
        "main" | "latest" => Ok(channel),
        _ => Err(format!(
            "--channel supports main or latest in this release feed, not {channel}"
        )),
    }
}

fn combine_selection(
    selection: Option<String>,
    channel: Option<String>,
) -> Result<Option<String>, String> {
    match (selection, channel) {
        (Some(_), Some(_)) => Err("--version and --channel cannot be combined".into()),
        (Some(version), None) => Ok(Some(version)),
        (None, Some(_)) => Ok(Some("latest".into())),
        (None, None) => Ok(None),
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
            Ok(Command::Recover {
                caller_pid: None,
                ..
            })
        ));
        assert!(matches!(
            parse(args(&["recover", "--caller-pid", "42"])),
            Ok(Command::Recover {
                caller_pid: Some(42),
                ..
            })
        ));
        assert!(parse(args(&["recover", "--caller-pid", "x"])).is_err());
    }

    #[test]
    fn start_takes_only_a_caller_pid() {
        assert!(matches!(
            parse(args(&["start"])),
            Ok(Command::Start { caller_pid: None })
        ));
        assert!(matches!(
            parse(args(&["start", "--caller-pid", "42"])),
            Ok(Command::Start {
                caller_pid: Some(42)
            })
        ));
        assert!(parse(args(&["start", "--caller-pid", "x"])).is_err());
        assert!(parse(args(&["start", "--json"])).is_err());
        assert!(parse(args(&["start", "--version", "0.2.0"])).is_err());
    }

    #[test]
    fn repair_accepts_raft_selection_flags() {
        assert!(matches!(
            parse(args(&["repair"])),
            Ok(Command::Repair {
                selection: None,
                allow_downgrade: false,
                ..
            })
        ));
        assert!(matches!(
            parse(args(&["repair", "--version", "0.2.0"])),
            Ok(Command::Repair {
                selection: Some(_),
                ..
            })
        ));
        assert!(matches!(
            parse(args(&["repair", "--channel", "main"])),
            Ok(Command::Repair {
                selection: Some(ref value),
                ..
            }) if value == "latest"
        ));
        assert!(matches!(
            parse(args(&["repair", "--json"])),
            Ok(Command::Repair { json: true, .. })
        ));
        assert!(parse(args(&["repair", "--channel", "beta"])).is_err());
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
