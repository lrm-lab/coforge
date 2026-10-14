import {createDockerTaskSession} from './docker-task-session.ts';
import {mkdir} from 'node:fs/promises';
const root=Bun.env.COFORGE_EVAL_PREFLIGHT_ROOT || '/tmp/coforge-swe-preflight-'+crypto.randomUUID();await mkdir(root,{recursive:true});
let calls=0,proxyCalls=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(request){
  if(request.method==='GET'){proxyCalls++;return new Response('PROXY_OK')}
  const body=await request.json() as any;calls++;if(calls===1)await Bun.sleep(12000);
  const lastUser=body.messages.findLastIndex((m:any)=>m.role==='user');
  const didRun=body.messages.slice(lastUser+1).some((m:any)=>m.role==='tool');
  const message=didRun?{role:'assistant',content:'Container preflight complete.'}:{role:'assistant',content:null,tool_calls:[{id:'container-check',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'pwd\npython --version\ncoforge --help\ntest -f astropy/modeling/separable.py\n/opt/coforge-task/bin/bun -e \'fetch(process.env.COFORGE_AGENT_PROXY_URL+"/bridge-probe").then(r=>r.text()).then(console.log)\'',timeout:30})}}]};
  const delta=didRun?{role:'assistant',content:message.content}:{role:'assistant',tool_calls:message.tool_calls.map((call:any)=>({index:0,...call}))};
  const chunks=[{id:'probe-'+calls,object:'chat.completion.chunk',created:0,model:'probe',choices:[{index:0,delta,finish_reason:null}]},
    {id:'probe-'+calls,object:'chat.completion.chunk',created:0,model:'probe',choices:[{index:0,delta:{},finish_reason:didRun?'stop':'tool_calls'}]},
    {id:'probe-'+calls,object:'chat.completion.chunk',created:0,model:'probe',choices:[],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}];
  return new Response(chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}});
let session;
const name='swe-task-runtime-delay-probe-'+crypto.randomUUID();
try{
 const create=()=>createDockerTaskSession({agentId:'probe-task',agentWorkspaceDirectory:root,instructions:'Test the existing runtime with the provided shell command. Do not modify source.',runtime:{modelProvider:'probe',model:'probe',providerConfig:{kind:'coforge',providerId:'probe',apiKey:'probe-key'}},environment:{COFORGE_EVAL_DISABLE_HOST_PI_INJECTION:'1',COFORGE_AGENT_PROXY_URL:`http://127.0.0.1:${server.port}`}},
 {name,image:'swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest',models:{providers:{probe:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:[{id:'probe',name:'probe',contextWindow:32768,maxTokens:2048,input:['text']}]}}}});
 const events:any[]=[];
 for(let cycle=0;cycle<2;cycle++){
  session=await create();session.subscribe(e=>events.push(e));
  await session.sendMessage('Verify the container runtime.');
  const before=await session.readSessionIdentity?.();
  await session.dispose();
  const after=await session.readSessionIdentity?.();
  if(!before||before.sessionId!==after?.sessionId)throw new Error('identity lost after stop');
 }
 const runtime=await Bun.file(root+'/docker-task-runtime.json').json();
 const files=Array.from(new Bun.Glob('*.jsonl').scanSync(root+'/.builtin-sessions'));
 const raw=(await Promise.all(files.map(file=>Bun.file(root+'/.builtin-sessions/'+file).text()))).join('\n');
 await Bun.write(root+'/debug.json',JSON.stringify({calls,events,runtime},null,2));
 if(calls!==4||proxyCalls!==2||!raw.includes('PROXY_OK')||runtime.cwd!=='/testbed'||!raw.includes('/testbed')||!raw.includes('Python 3.9.20')||!events.some(e=>e.type==='completed'&&e.status==='completed'))throw new Error('container execution evidence missing');
 await Bun.write(root+'/evidence.json',JSON.stringify({runtime,calls,events:events.map(e=>({type:e.type,status:e.status})),sessionFile:files[0],verifiedPython:'3.9.20',daemonLocation:'host',taskLocation:'container'},null,2));
 console.log(JSON.stringify({passed:true,cycles:2,calls,proxyCalls,identityAfterStop:true,container:name,cwd:runtime.cwd,python:'3.9.20'}));
}finally{
 await session?.dispose();server.stop(true);
 const p=Bun.spawn(['docker','rm','-f',name],{env:{...Bun.env,DOCKER_HOST:'unix:///data/zhoujie/docker-swe/docker.sock'},stdout:'ignore',stderr:'ignore'});await p.exited;
}
