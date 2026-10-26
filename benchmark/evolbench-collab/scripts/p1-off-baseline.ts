import {channelTraceFromSteps} from "../../../packages/agent/src/channel-turn-trace";
import {OPENVIKING_AGENT_PROTOCOL,OPENVIKING_TOOL_NAMES} from "../../../packages/coforge-sdk/src/agent/openviking-memory";
const repo=new URL("../../../",import.meta.url).pathname;
const proc=Bun.spawn(["git","show","0fad029f5:packages/agent/src/channel-turn-trace.ts"],{cwd:repo,stdout:"pipe"});
const source=(await new Response(proc.stdout).text()).replace(/^import[\s\S]*?;\n/gm,"");
if(await proc.exited)throw Error("baseline unavailable");
const js=new Bun.Transpiler({loader:"ts"}).transformSync(source).replace(/export /g,"");
const legacy=new Function("OPENVIKING_AGENT_PROTOCOL","OPENVIKING_TOOL_NAMES",js+"\nreturn channelTraceFromSteps;")(OPENVIKING_AGENT_PROTOCOL,OPENVIKING_TOOL_NAMES);
let compared=0;
const fixtureRoot=repo+"/benchmark/evolbench-collab/test/fixtures/swe-task-session-shapes/";
for(const name of new Bun.Glob("*.case.json").scanSync(fixtureRoot)){
 const metadata=await Bun.file(fixtureRoot+name).json();const steps=(await Promise.all(metadata.parts.map(p=>Bun.file(fixtureRoot+p).json()))).flat();
 if(JSON.stringify(legacy(metadata.sessionId,steps))!==JSON.stringify(channelTraceFromSteps(metadata.sessionId,steps)))throw Error("off baseline mismatch "+metadata.episode);
 compared++;
}
const result={baseline:"0fad029f5",cases:compared,mismatches:0};
await Bun.write(new URL("../../../../experiments/evo-swe-par2-20261025/analysis-20261026/P1-A1-off-baseline.json",import.meta.url),JSON.stringify(result,null,2)+"\n");
console.log(result);
