import { mkdir, rm } from "node:fs/promises";
import { trainingTrajectoryFromFile } from "../../../packages/agent/src/training-trajectory";
import { Glob } from "bun";
import { exportTaskFileTrace } from "../src/task-file-trace";
import { join } from "node:path";
const root=process.argv[2] ?? new URL("../../../../experiments/evo-swe-par2-20261025", import.meta.url).pathname;
const rows=[]; const fixtures=[];
for (const p of new Glob("results/train/*/*attempts.jsonl").scanSync(root)) {
 for(const line of (await Bun.file(join(root,p)).text()).trim().split("\n")) {
 const a=JSON.parse(line);const ids=[];
 for(const file of new Glob("*.jsonl").scanSync(join(a.work_dir,".builtin-sessions"))) {
 const path=join(a.work_dir,".builtin-sessions",file);const header=JSON.parse((await Bun.file(path).text()).split("\n")[0]!);ids.push(header.id);
 const before = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
 const parsed = trainingTrajectoryFromFile(path, join(a.work_dir,".builtin-sessions"), header.cwd);
 const trace = await exportTaskFileTrace({cwd:a.work_dir,sessionId:header.id});
 const after = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
 if (before !== after) throw new Error("Source session changed during parse");
 fixtures.push({episode:a.episode_id, sessionId:header.id, source_sha256:before, termination:a.terminationReason, final_complete:a.final_output.includes("TASK_COMPLETE"),
 sends:trace.sends.length,tail_tools:trace.trailingToolExchanges?.length??0,
 steps:parsed.steps.filter(s=>s.kind==="tool").map(s=>{
 const command = s.input && typeof s.input === "object" && "command" in s.input ? String(s.input.command) : "";
 const communication = /^\s*coforge\s+message\s+(send|check|read)\b/.exec(command)?.[1];
 const boundary = trace.sends.some(t=>s.output.includes(t.messageId));
 return {...s,input:communication ? {command:`coforge message ${communication}`} : {}, output:boundary ? s.output : "[training output omitted]"};
 })});
 }
 const traces=[]; for(const sessionId of ids) traces.push(await exportTaskFileTrace({cwd:a.work_dir,sessionId}));
 rows.push({episode:a.episode_id,work_dir:a.work_dir,sessionIds:ids,termination:a.terminationReason,final_complete:a.final_output.includes("TASK_COMPLETE"),sent_tools:traces.flatMap(t=>t.sends).reduce((n,s)=>n+s.toolExchanges.length,0),tail_tools:traces.reduce((n,t)=>n+(t.trailingToolExchanges?.length??0),0),sends:traces.reduce((n,t)=>n+t.sends.length,0)});
 }
}
await Bun.write(join(root,"analysis-20261026/P1-A1-parsed.json"),JSON.stringify(rows,null,2)+"\n");
console.log(JSON.stringify({sessions:rows.length,tools:rows.reduce((n,r)=>n+r.sent_tools+r.tail_tools,0),tail:rows.reduce((n,r)=>n+r.tail_tools,0),tail_sessions:rows.filter(r=>r.tail_tools).length}));

const fixtureRoot = new URL("../test/fixtures/swe-task-session-shapes/", import.meta.url);
await mkdir(fixtureRoot, {recursive:true});
for(const fixture of fixtures) {
 const {steps,...metadata}=fixture;
 const parts=[];
 for(let offset=0;offset<steps.length;offset+=12) {
  const name=`${fixture.episode}-${offset/12}.json`;
  await Bun.write(new URL(name,fixtureRoot),JSON.stringify(steps.slice(offset,offset+12),null,2)+"\n");
  parts.push(name);
 }
 await Bun.write(new URL(`${fixture.episode}.case.json`,fixtureRoot),JSON.stringify({...metadata,parts},null,2)+"\n");
}
await rm(new URL("../test/fixtures/swe-task-session-shapes.json",import.meta.url),{force:true});
