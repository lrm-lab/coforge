import queue,concurrent.futures,collections,datetime,hashlib,json,os,re,shutil,signal,subprocess,threading,time,urllib.request
from pathlib import Path
from four_role_results import write_final_summary
from pipeline_resources import EndpointPool, archive_owned_container, process_identity, stop_owned_process

OPS=Path(__file__).resolve().parent;REPO=OPS.parents[3];ROOT=Path(os.environ.get('COFORGE_EVAL_RUN_ROOT','/tmp/coforge-swe-gemma-p20'));ROOT.mkdir(parents=True,exist_ok=True);FORK=Path(os.environ['COFORGE_EVAL_OPENVIKING_ROOT']);PYTHON=FORK/'.venv/bin/python';SOURCE=Path(os.environ.get('COFORGE_EVAL_MANIFEST',str(ROOT/'manifest-docker.jsonl')))
RESUME_RUN=os.environ.get('COFORGE_EVAL_RESUME_RUN')
if RESUME_RUN:
 RUN=Path(RESUME_RUN);STAMP=RUN.name;PREFIX=json.loads((RUN/'config.json').read_text())['prefix'];MANIFEST=RUN/'manifest.jsonl'
else:
 STAMP=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');PREFIX='evoswe-gemma-docker-p20-'+STAMP;RUN=ROOT/STAMP;RUN.mkdir();MANIFEST=RUN/'manifest.jsonl';shutil.copy2(SOURCE,MANIFEST)
ROWS=[json.loads(l) for l in MANIFEST.read_text().splitlines() if l.strip()];assert len(ROWS)==20
ENV=os.environ.copy();key=json.loads((Path.home()/'.pi/agent/models.json').read_text())['providers']['lenovo-gemma']['apiKey'];assert key;ENV.pop('DEV_MEMORY_API_KEY',None);ENV.update(LENOVO_GATEWAY_API_KEY=key,LENOVO_GATEWAY_TIMEOUT_SECONDS='960',COFORGE_LLM_POOL_URL=os.environ.get('COFORGE_LLM_POOL_URL','http://127.0.0.1:18740'),NO_PROXY='localhost,127.0.0.1',no_proxy='localhost,127.0.0.1',HTTP_PROXY='http://127.0.0.1:7893',HTTPS_PROXY='http://127.0.0.1:7893',http_proxy='http://127.0.0.1:7893',https_proxy='http://127.0.0.1:7893');ca=Path.home()/'.pi/lenovo-ca-bundle.pem'
if ca.exists():ENV['SSL_CERT_FILE']=str(ca)
LOCK=threading.RLock();LAUNCH=threading.Lock();JOBS={j['index']:j for j in json.loads((RUN/'jobs.json').read_text())} if RESUME_RUN else {};MODEL='gemma-4-31B-it';MATERIAL=FORK/'benchmark/causal_memory/aig0045_real_material.py';SMOKE=FORK/'benchmark/causal_memory/aig0045_verdict_smoke.py';OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}));RESULTS=REPO/'benchmark/evolbench-collab/result'
CONFIG=json.loads((RUN/'config.json' if RESUME_RUN else OPS/'config-template.json').read_text());CONFIG.update(prefix=PREFIX,stamp=STAMP,lane_policy='One shared 20-worker stage pool and 20-request Gemma pool (Gateway4,new1=8,new2=8), immediate enqueue',shared_workers=20,shared_llm_request_limit=20,llm_pool_url=ENV['COFORGE_LLM_POOL_URL'],scheduler_revision='docker-shared20-v4',lanes=20,endpoint_episode_capacities={'lenovo-gemma':4,'gemma-4-31b-it-2gpu-1':8,'gemma-4-31b-it-2gpu-2':8},task_agent_location='per-task Docker',memory_agent_location='host',manifest_sha256=hashlib.sha256(MANIFEST.read_bytes()).hexdigest());CONFIG['source_hashes'].update({name:'' for name in ['benchmark/causal_memory/model_usage.py','benchmark/causal_memory/lenovo_gemma_provider.py']});CONFIG['source_hashes']={name:hashlib.sha256((FORK/name).read_bytes()).hexdigest() for name in CONFIG['source_hashes']};(RUN/'config.json').write_text(json.dumps(CONFIG,indent=2)+'\n');(ROOT/'latest.txt').write_text(str(RUN)+'\n')

def emit(event,**data):
 out={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'event':event,**data}
 with LOCK:
  with (RUN/'events.jsonl').open('a') as f:f.write(json.dumps(out,ensure_ascii=False)+'\n')
 print(json.dumps(out,ensure_ascii=False),flush=True)

def update(index,**fields):
 with LOCK:
  JOBS.setdefault(index,{'index':index,'episode_id':ROWS[index]['episode_id']}).update(fields)
  tmp=RUN/'jobs.tmp';tmp.write_text(json.dumps(list(JOBS.values()),ensure_ascii=False,indent=2)+'\n');tmp.replace(RUN/'jobs.json')

def checked(index,stage,args,case,timeout):
 update(index,phase=stage);emit('stage_started',index=index,stage=stage)
 with (case/(stage+'.log')).open('ab') as log:
  p=subprocess.Popen([str(x) for x in args],cwd=FORK,env={**ENV,'COFORGE_EVAL_LLM_CLIENT':stage+':m%02d'%index},stdout=log,stderr=subprocess.STDOUT)
  update(index,stage_pid=p.pid,stage_process_identity=process_identity(p.pid))
  try:rc=p.wait(timeout=timeout)
  except subprocess.TimeoutExpired:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
   raise RuntimeError(stage+'_timeout')
 if rc:raise RuntimeError(stage+'_exit_'+str(rc))
 emit('stage_completed',index=index,stage=stage)

def verify(index,attempt,case):
 update(index,phase='verify');emit('stage_started',index=index,stage='verify')
 payload={'episode_id':attempt['episode_id'],'domain':'software_engineering','task':ROWS[index],'workspace_dir':attempt.get('work_dir') or ''}
 req=urllib.request.Request('http://127.0.0.1:8737/verify',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
 try:
  with OPENER.open(req,timeout=2000) as response:raw=json.load(response)
 except Exception as exc:raw={'reward':0,'graded':False,'error':'verifier_exception:'+type(exc).__name__}
 (case/'verifier-raw.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
 text='\n'.join(str(raw.get(k) or '') for k in ['error','stderr','stdout_tail']);protocol_error=None
 if 'syntax error near unexpected token' in text:protocol_error='shell_test_selector_syntax'
 elif 'file or directory not found:' in text or raw.get('returncode')==4:protocol_error='invalid_test_selector'
 elif 'No module named pytest' in text:protocol_error='pytest_environment_missing'
 verdict={'run_id':attempt['run_id'],'episode_id':attempt['episode_id'],'session_id':None,'domain_kind':'swe','reward':raw.get('reward'),'graded':raw.get('graded'),'error':raw.get('error'),'detail':{k:v for k,v in raw.items() if k not in ['reward','graded','error','traceback']},'attempt_status':attempt.get('status')}
 if protocol_error:
  verdict.update(graded=False,error='grader_protocol_error:'+protocol_error);verdict['detail']['raw_verifier_graded']=raw.get('graded');verdict['detail']['raw_verifier_reward']=raw.get('reward')
 verdict['detail']['requested_test_count']=len(ROWS[index]['grader'].get('FAIL_TO_PASS',[]))+len(ROWS[index]['grader'].get('PASS_TO_PASS',[]));verdict['detail']['sidecar_test_cap']=30
 (case/'verdicts.jsonl').write_text(json.dumps(verdict,ensure_ascii=False)+'\n');update(index,verdict_reward=verdict['reward'],verdict_graded=verdict['graded'],verdict_error=verdict['error']);emit('verdict',index=index,reward=verdict['reward'],graded=verdict['graded'],error=verdict['error'])

def cleanup_container(index,case):
 name=ROWS[index]['task_container']['name'];env={**ENV,'DOCKER_HOST':os.environ.get('DOCKER_HOST','unix:///data/zhoujie/docker-swe/docker.sock')}
 attempt_path=case/'attempts.jsonl';workspace=None
 if attempt_path.exists():workspace=json.loads(attempt_path.read_text().splitlines()[0]).get('work_dir')
 if not workspace:
  log=Path(JOBS[index].get('shard_log','/nonexistent'))
  if log.exists():
   config=next((json.loads(l.split(' ',1)[1]) for l in log.read_text().splitlines() if l.startswith('[startEvalDaemon:config] ')),None)
   if config:
    root=Path('/tmp/evol-daemon-'+config['workspaceId'][:8])/'workspaces'/config['workspaceId']/'agents'
    for path in root.glob('*/docker-task-runtime.json'):
     if json.loads(path.read_text()).get('container')==name:workspace=str(path.parent);break
 size=archive_owned_container(name,workspace,ROWS[index]['grader']['base_commit'],case/'candidate-container.patch',env)
 if size is not None:emit('container_cleaned',index=index,removed=True,candidate_bytes=size)

proc_identity=process_identity

def post_case(index,adopt):
 case=RUN/('m%02d'%index)
 try:
  if adopt:
   job=JOBS[index];pid=job['stage_pid'];identity=job.get('stage_process_identity');current=proc_identity(pid)
   if current is not None and (not identity or current!=identity):raise RuntimeError('adopted_process_identity_mismatch')
   emit('gemma_roles_adopted',index=index,pid=pid,process_alive=current is not None)
   deadline=job['four_roles_started_epoch']+9000
   while current is not None and proc_identity(pid)==identity:
    if time.time()>deadline:
     stop_owned_process(pid,identity);raise RuntimeError('adopted_gemma_four_roles_timeout')
    time.sleep(2)
   if not (case/'four-roles.json').exists():raise RuntimeError('adopted_gemma_exited_without_report')
   emit('stage_completed',index=index,stage='gemma_four_roles',adopted=True)
  else:
   attempt=json.loads((case/'attempts.jsonl').read_text().splitlines()[0])
   verify(index,attempt,case)
   checked(index,'export_ao',[PYTHON,MATERIAL,'export','--attempts',case/'attempts.jsonl','--manifest',MANIFEST,'--verdicts',case/'verdicts.jsonl','--sessions-out',case/'sessions'],case,timeout=180)
   verdict=json.loads((case/'verdicts.jsonl').read_text().splitlines()[0]);assert verdict.get('session_id'),'AO session join missing'
   update(index,session_id=verdict['session_id'],four_roles_started_epoch=time.time())
   checked(index,'gemma_four_roles',[PYTHON,SMOKE,'--material','real','--verdicts',case/'verdicts.jsonl','--sessions',case/'sessions','--manifest',MANIFEST,'--builder','gemma','--critic','gemma','--refiner','gemma','--reader','gemma','--model',MODEL,'--url',ENV['COFORGE_LLM_POOL_URL']+'/llm/v1/chat/completions','--jobs','1','--attempts','3','--max-calls','128','--max-seconds','1800','--out',case/'four-roles.json','--work-root',case/'four-roles-work'],case,timeout=9000)
  report=json.loads((case/'four-roles.json').read_text());materials=report.get('materials') or [];assert len(materials)==1,'expected one joined material';r=materials[0]
  update(index,phase='done',finished_epoch=time.time(),aig_submit=r.get('submit'),aig_mode=r.get('mode'),aig_phi=r.get('phi_violations_after_refine'),aig_reader_ok=r.get('reader_schema_ok'),aig_fallback=r.get('fallback_reason'),**{key:r.get(key) for key in ['builder_submitted','graph_frozen','reader_verified','status']},attempt_summary=report.get('attempt_summary'));emit('case_completed',index=index,submit=r.get('submit'),reader_ok=r.get('reader_schema_ok'),fallback=r.get('fallback_reason'))
 except Exception as exc:
  code=str(exc) if isinstance(exc,(RuntimeError,AssertionError)) else type(exc).__name__;update(index,phase='failed',finished_epoch=time.time(),error=code);emit('case_failed',index=index,error=code)
 finally:
  try:cleanup_container(index,case)
  except Exception as exc:emit('container_cleanup_failed',index=index,error=type(exc).__name__)

ENDPOINTS=EndpointPool(['gemma-4-31b-it-2gpu-1','gemma-4-31b-it-2gpu-2','lenovo-gemma']*4+['gemma-4-31b-it-2gpu-1','gemma-4-31b-it-2gpu-2']*4)

def run_case(index):
 while index>0 and not (RUN/'allow-full-pool').exists():time.sleep(2)
 endpoint=ENDPOINTS.acquire(JOBS.get(index,{}).get('endpoint'))
 p=None;wrapper_identity=None
 case=RUN/('m%02d'%index);case.mkdir(exist_ok=True);evalid=PREFIX+'-m%02d'%index+('-runtimefix%d'%JOBS[index]['runtime_retry'] if JOBS.get(index,{}).get('runtime_retry') else '');name=evalid.replace('evoswe-','swe-');attempt_path=RESULTS/(evalid+'-attempts.jsonl');summary_path=RESULTS/(evalid+'-summary.txt')
 update(index,endpoint=endpoint,phase='queued',evaluation_id=evalid,case_dir=str(case),attempt_path=str(attempt_path))
 try:
  with LAUNCH:
   assert not attempt_path.exists()
   with (case/'launch.log').open('ab') as log:
    args=['bash',str(OPS/'evol-shard-docker-task.sh'),name,str(MANIFEST),evalid,'warm','software_engineering','20:%d'%index,'COFORGE_EVAL_MEMORY_AGENT_PROVIDER='+endpoint,'COFORGE_EVAL_MEMORY_AGENT_MODEL=gemma-4-31B-it','COFORGE_EVAL_TASK_AGENT_PROVIDER='+endpoint,'COFORGE_EVAL_TASK_AGENT_MODEL=gemma-4-31B-it','COFORGE_EVAL_EPISODE_TIMEOUT_MS=2700000','COFORGE_EVAL_ABORT_QUIET_MS=1500000','COFORGE_EVAL_VERIFY_SIDECAR=','COFORGE_EVAL_DOCKER_TASK_CONTAINER='+ROWS[index]['task_container']['name'],'COFORGE_EVAL_DOCKER_TASK_IMAGE='+ROWS[index]['task_container']['image']]
    episode_env={k:v for k,v in ENV.items() if k!='DEV_MEMORY_API_KEY'}
    p=subprocess.Popen(args,env=episode_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    wrapper_identity=process_identity(p.pid)
   update(index,phase='gemma_group_chat',wrapper_pid=p.pid,shard_log='/tmp/shard-'+name+'.log',started_epoch=time.time());emit('gemma_started',index=index,episode_id=ROWS[index]['episode_id'],wrapper_pid=p.pid)
   time.sleep(8)
  deadline=time.monotonic()+3600
  while not summary_path.exists():
   if time.monotonic()>deadline:raise RuntimeError('gemma_runner_timeout')
   if p.poll() is not None and not summary_path.exists():raise RuntimeError('gemma_wrapper_exit_'+str(p.returncode))
   time.sleep(2)
  attempts=[json.loads(l) for l in attempt_path.read_text().splitlines() if l.strip()];assert len(attempts)==1;attempt=attempts[0];shutil.copy2(attempt_path,case/'attempts.jsonl');update(index,gemma_finished_epoch=time.time(),termination_reason=attempt.get('terminationReason'),task_messages=attempt.get('task_message_count'));emit('gemma_completed',index=index,termination_reason=attempt.get('terminationReason'),task_messages=attempt.get('task_message_count'))
  update(index,phase='postprocessing_queued');POST.submit(post_case,index,False)
 except Exception as exc:
  code=str(exc) if isinstance(exc,(RuntimeError,AssertionError)) else type(exc).__name__;update(index,phase='failed',finished_epoch=time.time(),error=code);emit('case_failed',index=index,error=code)
  if p is not None:stop_owned_process(p.pid,wrapper_identity,group=True)
  try:cleanup_container(index,case)
  except Exception as cleanup_error:emit('container_cleanup_failed',index=index,error=str(cleanup_error))

 finally:
  if p is not None:stop_owned_process(p.pid,wrapper_identity,group=True)
  ENDPOINTS.release(endpoint)

stop_monitor=threading.Event()
def monitor():
 while not stop_monitor.is_set():
  with LOCK:jobs=[dict(x) for x in JOBS.values()]
  counts=collections.Counter(j['phase'] for j in jobs);details=[]
  for j in jobs:
   log=Path(j.get('shard_log','/nonexistent'));text=log.read_text(errors='replace') if log.is_file() else '';prefix='[startEvalDaemon:config] ';d=next((json.loads(l[len(prefix):]) for l in text.splitlines() if l.startswith(prefix)),None)
   if not d:continue
   home=Path('/tmp/evol-daemon-'+d['workspaceId'][:8]);successful=failed=0
   for path in home.glob('workspaces/*/agents/*/.builtin-sessions/*.jsonl'):
    for line in path.read_text().splitlines():
     try:msg=json.loads(line).get('message') or {}
     except ValueError:continue
     if msg.get('role')=='assistant':
      if msg.get('stopReason') in ['error','aborted']:failed+=1
      else:successful+=1
   details.append({'index':j['index'],'phase':j['phase'],'workspace_id':d['workspaceId'],'model_successful_turns':successful,'model_error_or_cancel_turns':failed})
  snap={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase_counts':dict(counts),'jobs':jobs,'live_round_counts':details}
  (RUN/'latest-status.json').write_text(json.dumps(snap,ensure_ascii=False,indent=2)+'\n')
  with (RUN/'snapshots.jsonl').open('a') as f:f.write(json.dumps(snap,ensure_ascii=False)+'\n')
  emit('progress',phase_counts=dict(counts),gemma_active=counts.get('gemma_group_chat',0),four_roles_active=counts.get('gemma_four_roles',0),finished=counts.get('done',0)+counts.get('failed',0))
  stop_monitor.wait(30)

if __name__=='__main__':
 with OPENER.open(ENV['COFORGE_LLM_POOL_URL']+'/status',timeout=5) as response:assert json.load(response)['limit']==20,'shared_llm_pool_must_have_20_slots'
 emit('batch_started',prefix=PREFIX,episodes=20,revision='docker-shared20-v4',shared_workers=20,shared_llm_request_limit=20,adopted_cases=sorted(JOBS))
 POST=concurrent.futures.ThreadPoolExecutor(max_workers=20)
 for index,j in sorted(JOBS.items()):
  if j['phase']=='gemma_four_roles':POST.submit(post_case,index,True)
  elif j['phase'] in ['verify','export_ao','postprocessing_queued']:POST.submit(post_case,index,False)
  elif j['phase'] not in ['done','failed','retry_pending']:raise RuntimeError('unsupported_resume_phase')
 watch=threading.Thread(target=monitor,daemon=True);watch.start()
 pending=[i for i in range(20) if i not in JOBS or JOBS[i]['phase']=='retry_pending']
 futures=[POST.submit(run_case,index) for index in pending]
 for future in futures:future.result()
 POST.shutdown(wait=True)
 stop_monitor.set();watch.join();attempts=[];verdicts=[];roles=[]
 for index in range(20):
  case=RUN/('m%02d'%index)
  for filename,dest in [('attempts.jsonl',attempts),('verdicts.jsonl',verdicts)]:
   path=case/filename
   if path.exists():dest.extend(json.loads(l) for l in path.read_text().splitlines() if l.strip())
  path=case/'four-roles.json'
  if path.exists():roles+=json.loads(path.read_text()).get('materials',[])
 for filename,data in [('attempts.jsonl',attempts),('verdicts.jsonl',verdicts),('four-role-materials.jsonl',roles)]:
  (RUN/filename).write_text('\n'.join(json.dumps(r,ensure_ascii=False) for r in data)+'\n')
 summary=write_final_summary(RUN,CONFIG,list(JOBS.values()),attempts=len(attempts),verdicts=len(verdicts),four_role_materials=len(roles),aig_submitted=sum(r.get('submit') is True for r in roles),reader_schema_ok=sum(r.get('reader_schema_ok') is True for r in roles));emit('batch_completed',attempts=len(attempts),four_role_materials=len(roles),aig_submitted=summary['aig_submitted'])
