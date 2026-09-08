"""One 24k-token supplemental attempt from a previously approved, incomplete tool."""

import json
import pathlib
import subprocess
import sys
import time
import uuid
from compare_programs import Client, ROOT

base, proof_path = sys.argv[1:]
previous = json.loads(pathlib.Path(proof_path).read_text())
baseline = next(
    run["candidate"]
    for run in previous["runs"]
    if run["mode"] == "harness" and run.get("assessment", {}).get("passed") == 8
)
secrets = dict(
    line.strip().split("=", 1)
    for line in (ROOT / "apps/benchmarks/.dev.vars.deployed").read_text().splitlines()
    if "=" in line
)
identity = f"edits-{uuid.uuid4()}"
client = Client(base, secrets["ADMIN_TOKEN"], identity)
report = {
    "identity": identity,
    "sourceRevision": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True, cwd=ROOT
    ).strip(),
    "priorProof": proof_path,
    "baseline": baseline,
    "limits": {"steps": 1, "tokens": 24000, "activeMs": 120000},
    "limitation": "An additional attempt with a different representation; no causal speed or quality advantage established.",
}
path = ROOT / ".wrangler/proofs" / f"code-edits-{int(time.time())}.json"
path.write_text(json.dumps(report, indent=2))
try:
    report["before"] = client.call("program-evaluate", stage=2, candidate=baseline)
    result = client.call("program-edit", stage=2, candidate=baseline)
    report["learning"] = result
    candidate = baseline
    if result["run"]["status"] == "awaiting_review":
        reviewed = client.call("program-review", stage=2, reviewed=True)
        report["review"] = reviewed
        candidate = reviewed["candidate"]
    report["candidate"] = candidate
    report["after"] = client.call("program-evaluate", stage=2, candidate=candidate)
    report["assessment"] = client.call("program-seal", stage=2, candidate=candidate)
except Exception as error:
    report["error"] = str(error)
finally:
    report["wallSeconds"] = time.monotonic() - client.started
    path.write_text(json.dumps(report, indent=2))
print(
    json.dumps(
        {
            "proof": str(path),
            "assessment": report.get("assessment"),
            "status": report.get("learning", {}).get("run", {}).get("status"),
            "usage": report.get("learning", {}).get("usage"),
            "error": report.get("error"),
        }
    ),
    flush=True,
)
