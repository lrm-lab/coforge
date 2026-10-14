from pathlib import Path
import json,re,collections,datetime,os
run=Path((Path(os.environ.get('COFORGE_EVAL_RUN_ROOT','/tmp/coforge-swe-gemma-p20'))/'latest.txt').read_text().strip());jobs=json.loads((run/'jobs.json').read_text());totals=collections.defaultdict(collections.Counter);errors=[];cases=[]
for job in jobs:
 log=Path(job.get('shard_log','/nonexistent'))
 if not log.exists():continue
 if job.get('runtime_retry') and job.get('shard_log')==job.get('previous_shard_log'):continue
 config=next((json.loads(l.split(' ',1)[1]) for l in log.read_text(errors='replace').splitlines() if l.startswith('[startEvalDaemon:config] ')),None)
 if not config:continue
 home=Path('/tmp/evol-daemon-'+config['workspaceId'][:8]);roles=collections.defaultdict(list)
 for path in home.glob('workspaces/*/agents/*/.builtin-sessions/*.jsonl'):
  role='task' if (path.parent.parent/'docker-task-runtime.json').exists() else 'memory'
  for line in path.read_text(errors='replace').splitlines():
   try:entry=json.loads(line)
   except ValueError:continue
   msg=entry.get('message') or {}
   if msg.get('role')=='assistant':roles[role].append((str(entry.get('timestamp') or msg.get('timestamp') or ''),msg))
 detail={}
 for role,outputs in roles.items():
  outputs.sort(key=lambda x:x[0]);count=collections.Counter();last_good=max((t for t,m in outputs if m.get('stopReason') not in ['error','aborted']),default='')
  for stamp,msg in outputs:
   reason=msg.get('stopReason');kind=reason if reason in ['error','aborted'] else 'successful';count[kind]+=1;totals[job['endpoint']][kind]+=1
   if kind=='successful':continue
   err=str(msg.get('errorMessage') or '');match=re.search(r'(?<!\d)([45]\d\d)(?!\d)',err);status=match.group(1) if match else 'unknown';totals[job['endpoint']]['http_'+status]+=1
   errors.append({'index':job['index'],'episode_id':job['episode_id'],'endpoint':job['endpoint'],'role':role,'utc':stamp,'http':status,'stop_reason':reason,'error':re.sub(r'\s+',' ',re.sub(r'<[^>]*>',' ',err))[:250],'later_success':last_good>stamp})
  detail[role]={'counts':dict(count),'last_output_utc':outputs[-1][0],'last_stop_reason':outputs[-1][1].get('stopReason'),'last_success_utc':last_good}
 cases.append({'index':job['index'],'episode_id':job['episode_id'],'endpoint':job['endpoint'],'phase':job['phase'],'runtime_retry':job.get('runtime_retry',0),'roles':detail})
report={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run':str(run),'phase_counts':dict(collections.Counter(j['phase'] for j in jobs)),'by_endpoint':dict(totals),'errors':errors,'cases':cases,'counting_note':'Recorded assistant outputs, not an HTTP-attempt failure rate. A currently last error does not prove the agent is stuck.'}
(run/'request-error-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['utc','phase_counts','by_endpoint']},ensure_ascii=False));print(json.dumps({'cases_with_errors':len(set(e['index'] for e in errors)),'errors_with_later_success':sum(e['later_success'] for e in errors),'latest_output_is_error':[{'index':c['index'],'episode_id':c['episode_id'],'role':r,'last_output_utc':v['last_output_utc']} for c in cases for r,v in c['roles'].items() if v['last_stop_reason']=='error']},ensure_ascii=False))

fixed=[c for c in cases if c['runtime_retry']];print(json.dumps({'fixed_cases_observed':len(fixed),'fixed_model_outputs':{k:sum(c['roles'].get(r,{}).get('counts',{}).get(k,0) for c in fixed for r in ['memory','task']) for k in ['successful','error','aborted']}}))
