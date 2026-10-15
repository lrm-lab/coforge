#!/usr/bin/env python3
"""Protocol B validity gates for an SLB attempts.jsonl (warm vs cold)."""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path


def load(path: Path) -> dict[tuple[str, str], dict]:
    rows: dict[tuple[str, str], dict] = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rows[(row["arm"], row["episode_id"])] = row
    return rows


def rate(rows: list[dict], pred) -> float:
    if not rows:
        return 0.0
    return 100.0 * sum(1 for row in rows if pred(row)) / len(rows)


def offered(row: dict) -> bool:
    if (row.get("memory_offer_deliveries") or 0) > 0:
        return True
    loop = row.get("loop_offer") or {}
    return bool(loop.get("published"))


def leak_or_timeout(row: dict) -> bool:
    return row.get("mechanism") in {"leak", "timeout"} or bool(row.get("error"))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: lsk-slb-gate.py <attempts.jsonl>", file=sys.stderr)
        return 2
    rows = load(Path(sys.argv[1]))
    by_arm = defaultdict(list)
    for (arm, _), row in rows.items():
        by_arm[arm].append(row)
    warm = by_arm.get("warm", [])
    cold = by_arm.get("cold", [])
    offer_rate = rate(warm, offered)
    warm_code = rate(warm, lambda r: bool(r.get("code_extracted")))
    cold_code = rate(cold, lambda r: bool(r.get("code_extracted")))
    warm_lt = rate(warm, leak_or_timeout)
    cold_lt = rate(cold, leak_or_timeout)
    sidecar_ok = all(
        (row.get("sidecar_verification") or {}).get("graded")
        for row in warm + cold
        if row.get("sidecar_verification") is not None
    )
    code_gap = abs(warm_code - cold_code)
    lt_gap = abs(warm_lt - cold_lt)
    report = {
        "warm_n": len(warm),
        "cold_n": len(cold),
        "warm_offer_rate": round(offer_rate, 1),
        "warm_code_extract_rate": round(warm_code, 1),
        "cold_code_extract_rate": round(cold_code, 1),
        "code_extract_gap_pp": round(code_gap, 1),
        "warm_leak_timeout_rate": round(warm_lt, 1),
        "cold_leak_timeout_rate": round(cold_lt, 1),
        "leak_timeout_gap_pp": round(lt_gap, 1),
        "sidecar_graded": sidecar_ok,
        "pass_offer": offer_rate >= 80.0,
        "pass_code_gap": code_gap <= 5.0,
        "pass_leak_gap": lt_gap <= 10.0,
        "pass_sidecar": sidecar_ok or not any((r.get("sidecar_verification") for r in warm + cold)),
    }
    report["pass"] = all(
        report[key] for key in ("pass_offer", "pass_code_gap", "pass_leak_gap", "pass_sidecar")
    )
    print(json.dumps(report, indent=2))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
