const upstream=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,async fetch(){await Bun.sleep(12000);return new Response('OK')}});
for(const timeout of [undefined,0]){
 const path='/tmp/swe-bridge-timeout-probe.sock';
 const host=Bun.serve({unix:path,...(timeout===undefined?{}:{idleTimeout:timeout}),fetch(){return fetch(`http://127.0.0.1:${upstream.port}`,{proxy:''})}});
 const worker=Bun.serve({hostname:'127.0.0.1',port:0,...(timeout===undefined?{}:{idleTimeout:timeout}),fetch(){return fetch('http://bridge/',{unix:path,proxy:''})}});
 const start=performance.now();
 try{const r=await fetch(`http://127.0.0.1:${worker.port}`,{proxy:''});console.log(JSON.stringify({idleTimeout:timeout??'default',status:r.status,body:await r.text(),seconds:(performance.now()-start)/1000}))}
 catch(e){console.log(JSON.stringify({idleTimeout:timeout??'default',error:e.message,seconds:(performance.now()-start)/1000}))}
 worker.stop(true);host.stop(true);
}
upstream.stop(true);
