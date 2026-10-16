"""Final result snapshots shared by live evaluation and trajectory replay."""
import collections
import datetime
import json


def write_final_summary(run, config, jobs, **metrics):
    stage_counts = {
        name: sum(bool(job.get(name)) for job in jobs)
        for name in ['builder_submitted', 'graph_frozen', 'reader_verified']
    }
    stage_counts['skipped_no_signal'] = sum(job.get('status') == 'skipped_no_signal' for job in jobs)
    phase_counts = dict(collections.Counter(job['phase'] for job in jobs))
    summary = {'config': config, 'jobs': jobs, 'phase_counts': phase_counts,
               'stage_counts': stage_counts, 'finished': True, **metrics}
    status = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'phase_counts': phase_counts, 'stage_counts': stage_counts, 'jobs': jobs, 'finished': True}
    for name, value in [('summary.json', summary), ('latest-status.json', status)]:
        temporary = run/(name+'.tmp')
        temporary.write_text(json.dumps(value, indent=2)+'\n')
        temporary.replace(run/name)
    return summary
