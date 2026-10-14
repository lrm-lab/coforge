import json
import tempfile
import unittest
from pathlib import Path
from four_role_results import write_final_summary

class SummaryTests(unittest.TestCase):
    def test_final_status_matches_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            run=Path(directory)
            jobs=[{"phase":"done","builder_submitted":True,"graph_frozen":True,"reader_verified":True},
                  {"phase":"done","builder_submitted":True,"reader_verified":False},
                  {"phase":"done","status":"skipped_no_signal"},{"phase":"failed"}]
            summary=write_final_summary(run,{},jobs)
            status=json.loads((run/"latest-status.json").read_text())
            self.assertEqual(status["phase_counts"],summary["phase_counts"])
            self.assertEqual(status["stage_counts"],summary["stage_counts"])
            self.assertEqual(status["stage_counts"]["reader_verified"],1)
            self.assertEqual(status["stage_counts"]["builder_submitted"],2)
            self.assertEqual(status["stage_counts"]["skipped_no_signal"],1)
            self.assertTrue(status["finished"])
