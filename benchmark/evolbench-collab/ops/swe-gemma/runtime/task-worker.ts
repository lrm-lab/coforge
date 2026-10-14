import { CoforgeProvider } from '../../../../../packages/daemon/src/code-agent/pi/provider.ts';
import type { AgentSession, AgentSessionOptions } from '../../../../../packages/agent/src/contract.ts';
let session: AgentSession | undefined;
let secret = '';
let bridge: ReturnType<typeof Bun.serve> | undefined;
function send(frame: object) { process.stdout.write(JSON.stringify(frame) + '\n'); }
function failure(error: unknown) {
  const e = error as { message?: string; code?: string; name?: string };
  return {message: String(e?.message || 'task runtime failed').replaceAll(secret || '\0', '[redacted]'), code: e?.code, name: e?.name};
}
async function handle(frame: any) {
  try {
    if (frame.method === 'init') {
      const options: AgentSessionOptions = frame.options;
      secret = options.runtime?.providerConfig?.apiKey || '';
      const socket = options.environment?.COFORGE_EVAL_BRIDGE_SOCKET;
      if (socket) {
        bridge = Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(request){
          const url=new URL(request.url);
          return fetch('http://coforge-task'+url.pathname+url.search,{unix:socket,method:request.method,headers:request.headers,
            body:request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer(),proxy:''});
        }});
        const local='http://127.0.0.1:'+bridge.port;
        const path='/testbed/.builtin-runtime/models.json';
        const models=await Bun.file(path).json();
        models.providers[options.runtime!.modelProvider!].baseUrl=local+'/model';
        await Bun.write(path,JSON.stringify(models));
        options.environment={...options.environment,COFORGE_AGENT_PROXY_URL:local};
      }
      session = await new CoforgeProvider().createAgentSession({
        ...options,
        onSessionId: async (sessionId, replacedSessionId) => send({kind: 'session-id', sessionId, replacedSessionId}),
      });
      session.subscribe(event => send({kind: 'event', event, live: session?.hasLiveTurn}));
      session.onExit(() => send({kind: 'exit'}));
      send({kind: 'ready', identity: await session.readSessionIdentity?.(), live: session.hasLiveTurn, pid: process.pid, cwd: process.cwd()});
      return;
    }
    if (!session) throw new Error('task runtime not initialized');
    let value: unknown;
    switch (frame.method) {
      case 'sendMessage': value = await session.sendMessage(frame.text); break;
      case 'notify': value = await session.notify?.(frame.text, frame.options); break;
      case 'interrupt': value = await session.interrupt(); break;
      case 'identity': value = await session.readSessionIdentity?.(); break;
      case 'dispose': value = await session.dispose(); break;
      default: throw new Error('unknown task runtime operation');
    }
    send({kind: 'response', id: frame.id, value, live: session.hasLiveTurn});
  } catch (error) { send({kind: frame.method === 'init' ? 'init-error' : 'response', id: frame.id, error: failure(error), live: session?.hasLiveTurn}); }
}
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
}
await session?.dispose();
bridge?.stop(true);
