/**
 * Preloaded (`bun --preload`) into a server that a local Web launcher runs through
 * runSupervisedBun: the server stops once that launcher is gone, even when the launcher was
 * killed outright and could not pass a signal on. A child whose parent exits is re-parented
 * (to PID 1, or a subreaper), so a changed `process.ppid` means the launcher is gone. The server
 * is then sent SIGTERM once, and killed if it is still running after its grace: a Nitro server
 * that has served requests closes its listener on SIGTERM but keeps its Redis sockets open.
 */
import {
  LAUNCHER_PID_ENV,
  LAUNCHER_POLL_MS,
  LAUNCHER_STOP_GRACE_ENV,
  SERVER_STOP_GRACE_MS,
} from "./launcher-contract";

const launcher = Number(process.env[LAUNCHER_PID_ENV]);
const grace = Number(process.env[LAUNCHER_STOP_GRACE_ENV]);
const stopGraceMs = Number.isFinite(grace) && grace > 0 ? grace : SERVER_STOP_GRACE_MS;
// Hides them from the server's own code and from children it starts through node:child_process,
// which read process.env. A Bun.spawn without `env` still passes on the environment this process
// started with; that is harmless, because only a process started with this preload acts on them.
delete process.env[LAUNCHER_PID_ENV];
delete process.env[LAUNCHER_STOP_GRACE_ENV];
if (Number.isInteger(launcher) && launcher > 1) {
  // A closed terminal sends SIGHUP to the whole job, server included. The server follows its
  // launcher instead: without `nohup` SIGHUP ends the launcher and the watch below then stops the
  // server; under `nohup` both keep running. Bun does not pass `nohup`'s ignored SIGHUP on to a
  // child, so the server cannot rely on inheriting it.
  process.on("SIGHUP", () => {});
  const watch = setInterval(() => {
    if (process.ppid === launcher) return;
    clearInterval(watch);
    process.kill(process.pid, "SIGTERM");
    // unref: it does not keep the process alive, and still fires while sockets do.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), stopGraceMs).unref();
  }, LAUNCHER_POLL_MS);
  watch.unref();
}
