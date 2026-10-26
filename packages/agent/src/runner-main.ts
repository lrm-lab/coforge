#!/usr/bin/env bun

import {
  createAgentSessionRuntime,
  getAgentDir,
  runRpcMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createRuntime } from "./runner";

const cwd = process.cwd();
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir: getAgentDir(),
  sessionManager: SessionManager.inMemory(cwd),
});
await runRpcMode(runtime);
