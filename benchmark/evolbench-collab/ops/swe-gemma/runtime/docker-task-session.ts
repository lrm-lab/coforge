import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSession, AgentSessionOptions, AgentRuntimeEvent, AgentSessionIdentity } from '../../../../../packages/agent/src/contract.ts';
const RUNTIME = Bun.env.COFORGE_EVAL_DOCKER_RUNTIME_DIR || join(import.meta.dir, 'build');
const INSIDE = '/opt/coforge-task';
const dockerEnv = () => ({...Bun.env, DOCKER_HOST: Bun.env.COFORGE_EVAL_DOCKER_HOST || Bun.env.DOCKER_HOST || 'unix:///data/zhoujie/docker-swe/docker.sock'});
async function docker(args: string[]) {
  const p = Bun.spawn(['docker', ...args], {env: dockerEnv(), stdout: 'pipe', stderr: 'pipe'});
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed (${code}): ${stderr.slice(0, 500)}`);
  return stdout.trim();
}
export async function createDockerTaskSession(options: AgentSessionOptions, config?: {name: string; image: string; models?: object}): Promise<AgentSession> {
  const name = config?.name || Bun.env.COFORGE_EVAL_DOCKER_TASK_CONTAINER || '';
  const image = config?.image || Bun.env.COFORGE_EVAL_DOCKER_TASK_IMAGE || '';
  if (!/^swe-[a-zA-Z0-9_.-]+$/.test(name) || !image.startsWith('swebench/')) throw new Error('missing or invalid per-task Docker configuration');
  const work = options.agentWorkspaceDirectory;
  const sessionDir = join(work, '.builtin-sessions');
  const runtimeDir = join(work, '.docker-task-runtime');
  await mkdir(sessionDir, {recursive: true}); await mkdir(runtimeDir, {recursive: true});
  const modelProvider = options.runtime?.modelProvider || '';
  const source = config?.models || await Bun.file(join(work, '.builtin-runtime/models.json')).json();
  const selected = (source as any).providers?.[modelProvider];
  if (!selected) throw new Error('selected Task model provider configuration missing');
  const {apiKey: _unusedKey, headers: _unusedHeaders, ...publicProvider} = selected;
  await Bun.write(join(runtimeDir, 'models.json'), JSON.stringify({providers: {[modelProvider]: {...publicProvider, apiKey: 'COFORGE_SESSION_ONLY_KEY'}}}));
  await Bun.write(join(runtimeDir, 'settings.json'), JSON.stringify({skills: []}));
  if (!(await Bun.file(join(work, 'patch.diff')).exists())) await Bun.write(join(work, 'patch.diff'), '');
  await chmod(join(runtimeDir, 'models.json'), 0o600);
  const agentProxyURL = options.environment?.COFORGE_AGENT_PROXY_URL;
  const bridgePath = join(runtimeDir, 'bridge.sock');
  const caFile = (Bun.env.HOME || '')+'/.pi/lenovo-ca-bundle.pem';
  const caContents = await Bun.file(caFile).text();
  const poolURL = options.environment?.COFORGE_LLM_POOL_URL || Bun.env.COFORGE_LLM_POOL_URL;
  const relay = Bun.serve({unix: bridgePath, idleTimeout:0, async fetch(request) {
    const url = new URL(request.url);
    const modelRequest = url.pathname.startsWith('/model/');
    if (!modelRequest && !agentProxyURL) return new Response('Agent proxy unavailable',{status:503});
    let target = modelRequest
      ? new URL(publicProvider.baseUrl.replace(/\/$/,'')+url.pathname.slice('/model'.length)+url.search)
      : new URL(url.pathname+url.search, agentProxyURL);
    if (modelRequest && poolURL) target = new URL("/llm/v1/chat/completions", poolURL);
    const local = ['localhost','127.0.0.1'].includes(target.hostname);
    const headers = new Headers(request.headers);headers.delete('host');headers.delete('connection');
    if (modelRequest && poolURL) headers.set('X-Coforge-LLM-Client', 'task');
    return fetch(target, {method: request.method, headers,
      body: request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer(),
      proxy: local?'':(Bun.env.HTTPS_PROXY||'http://127.0.0.1:7893'),
      ...(target.protocol==='https:'?{tls:{ca:caContents}}:{})});
  }});
  await Bun.write(join(work,'docker-task-runtime.json'),JSON.stringify({container:name,image,hostWorkspace:work,status:'starting'})+'\n');
  try {
  const inspect = Bun.spawn(['docker', 'inspect', '--format', '{{index .Config.Labels "coforge.eval.task.workspace"}}', name], {env: dockerEnv(), stdout: 'pipe', stderr: 'pipe'});
  const [exists, owner] = await Promise.all([inspect.exited, new Response(inspect.stdout).text(), new Response(inspect.stderr).text()]);
  if (exists === 0 && owner.trim() !== work) throw new Error('task Docker name belongs to another run');
  if (exists !== 0) {
    const mounts = [
      [process.execPath, INSIDE+'/bin/bun'], [RUNTIME+'/task-worker.js', INSIDE+'/task-worker.js'],
      [RUNTIME+'/coforge-cli.js', INSIDE+'/coforge-cli.js'], [RUNTIME+'/coforge', INSIDE+'/bin/coforge'],
      [sessionDir, '/testbed/.builtin-sessions'], [runtimeDir, '/testbed/.builtin-runtime'],
      [join(work, 'patch.diff'), '/coforge-output/patch.diff'],
    ];
    const ca = (Bun.env.HOME || '')+'/.pi/lenovo-ca-bundle.pem';
    if (await Bun.file(ca).exists()) mounts.push([ca, INSIDE+'/ca.pem']);
    await docker(['run', '-d', '--name', name, '--network', 'host', '--label', 'coforge.eval.task.workspace='+work,
      ...mounts.flatMap(([src,dst]) => ['--mount', `type=bind,source=${src},target=${dst}${dst.startsWith(INSIDE)?',readonly':''}`]),
      image, 'tail', '-f', '/dev/null']);
  }
  const environment: Record<string,string> = {HOME: '/root', PATH: INSIDE+'/bin:/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/bin:/usr/bin:/bin',
    COFORGE_EVAL_DISABLE_HOST_PI_INJECTION: '1', COFORGE_CURRENT_AGENT_WORKSPACE_PATH: '/testbed',
    NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1'};
  for (const [key,value] of Object.entries(options.environment || {})) {
    if (key.startsWith('COFORGE_') || /^(HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy)$/.test(key)) environment[key]=value;
  }
  if (poolURL) environment.COFORGE_LLM_POOL_URL = poolURL;
  environment.COFORGE_EVAL_BRIDGE_SOCKET = '/testbed/.builtin-runtime/bridge.sock';
  environment.COFORGE_CURRENT_AGENT_WORKSPACE_PATH = '/testbed';
  environment.NODE_EXTRA_CA_CERTS = INSIDE+'/ca.pem';
  const key = options.runtime?.providerConfig?.apiKey || '';
  const child = Bun.spawn(['docker', 'exec', '-i', '-w', '/testbed', '--env', 'NODE_EXTRA_CA_CERTS='+INSIDE+'/ca.pem', name, INSIDE+'/bin/bun', INSIDE+'/task-worker.js'],
    {env: dockerEnv(), stdin:'pipe', stdout:'pipe', stderr:'pipe'});
  const listeners = new Set<(event: AgentRuntimeEvent)=>void>();
  const exits = new Set<()=>void>();
  const pending = new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void}>();
  let seq=0, live:boolean|undefined, disposed=false, exitNotified=false, identity:AgentSessionIdentity|undefined, pid:number|undefined;
  let resolveReady!:()=>void, rejectReady!:(error:Error)=>void;
  const ready = new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
  const timeout = setTimeout(()=>rejectReady(new Error('container Task initialization timed out')),90000);
  const errorOf = (data:any)=>Object.assign(new Error(data.message || 'container Task failed'),{code:data.code,name:data.name||'Error'});
  const write = (frame:object)=>{child.stdin.write(JSON.stringify(frame)+'\n');child.stdin.flush()};
  const request=(method:string,fields:object={})=>new Promise<any>((resolve,reject)=>{
    if (disposed && method!=='dispose') {reject(new Error('container Task disposed'));return}
    const id=++seq;pending.set(id,{resolve,reject});
    if(method==='sendMessage'||method==='notify')live=true;
    try{write({id,method,...fields})}catch(error){pending.delete(id);reject(error as Error)}
  });
  const notifyExit=()=>{if(exitNotified)return;exitNotified=true;for(const listener of exits)listener()};
  const readFrames = (async()=>{
    let buffer='';const decoder=new TextDecoder();
    for await(const chunk of child.stdout){buffer+=decoder.decode(chunk,{stream:true});let end:number;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
        let frame:any;try{frame=JSON.parse(line)}catch{throw new Error('invalid container Task response framing')}
        if(typeof frame.live==='boolean')live=frame.live;
        switch(frame.kind){
          case 'session-id':await options.onSessionId?.(frame.sessionId,frame.replacedSessionId);break;
          case 'ready':identity=frame.identity;pid=frame.pid;
            await Bun.write(join(work,'docker-task-runtime.json'),JSON.stringify({container:name,image,pid,cwd:frame.cwd,hostWorkspace:work,sessionDirectory:sessionDir},null,2)+'\n');
            clearTimeout(timeout);resolveReady();break;
          case 'init-error':rejectReady(errorOf(frame.error));break;
          case 'event':if(frame.event.type==='session')identity=frame.event.identity;for(const listener of listeners)listener(frame.event);break;
          case 'response':{const item=pending.get(frame.id);pending.delete(frame.id);if(frame.error)item?.reject(errorOf(frame.error));else item?.resolve(frame.value);break}
          case 'exit':notifyExit();break;
        }
      }
    }
  })();
  void readFrames.catch(error=>{rejectReady(error);for(const item of pending.values())item.reject(error);pending.clear()});
  void (async()=>{const text=await new Response(child.stderr).text();if(text)await Bun.write(join(work,'docker-task.stderr.log'),text.replaceAll(key||'\0','[redacted]'))})();
  void child.exited.then(code=>{clearTimeout(timeout);live=false;rejectReady(new Error(`container Task exited (${code})`));for(const item of pending.values())item.reject(new Error(`container Task exited (${code})`));pending.clear();notifyExit()});
  const {onSessionId:_callback, ...serializable}=options;
  write({method:'init',options:{...serializable,agentWorkspaceDirectory:'/testbed',gitHooks:undefined,
    instructions:options.instructions.replaceAll(work,'/testbed'),environment}});
  try{await ready}catch(error){relay?.stop(true);child.stdin.end();child.kill();throw error}
  return {
    get hasLiveTurn(){return live},
    sendMessage:async text=>{await request('sendMessage',{text})},
    notify:async(text,noticeOptions)=>{await request('notify',{text,options:noticeOptions})},
    readSessionIdentity:async()=>{if(!disposed)identity=await request('identity');return identity},
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
    onExit:listener=>{exits.add(listener);return()=>exits.delete(listener)},
    interrupt:async()=>{await request('interrupt')},
    dispose:async()=>{if(disposed)return;try{await request('dispose')}finally{disposed=true;child.stdin.end();await child.exited;relay?.stop(true)}},
  };
  } catch (error) { relay.stop(true); throw error; }
}
