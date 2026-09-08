"""Replay frozen candidates, including unchanged-seed controls, in both implementations."""

import json
import pathlib
import sys
import time
import uuid
from compare_programs import Client, ROOT

base, proof_path, expected_version = sys.argv[1:]
proof = json.loads(pathlib.Path(proof_path).read_text())
secrets = dict(
    line.strip().split("=", 1)
    for line in (ROOT / "apps/benchmarks/.dev.vars.deployed").read_text().splitlines()
    if "=" in line
)
results = []
for run in proof["runs"]:
    if run["mode"] == "disabled" or run["status"] != "completed":
        continue
    # Each frozen candidate gets both persistence implementations. This keeps
    # code quality out of the persistence comparison.
    for mode in ("harness", "filesystem"):
        client = Client(base, secrets["ADMIN_TOKEN"], f"recovery-{uuid.uuid4()}")
        record = {
            "mode": mode,
            "candidateOrigin": run["mode"],
            "modelGenerated": any("review" in stage for stage in run["stages"]),
            "repetition": run["repetition"],
        }
        results.append(record)
        try:
            metadata = client.call("program-metadata", stage=2)
            record["deployment"] = metadata.get("deployment")
            assert metadata.get("deployment", {}).get("id") == expected_version, (
                "The requested Worker version is not serving this run yet"
            )
            assert "bundled-runtime-v1" in metadata.get("capabilities", []), (
                "Deploy the bundle-safe cell runtime before this verification"
            )
            setup = client.call("recovery-setup", mode=mode, candidate=run["candidate"])
            paused = client.call("recovery-run")
            assert paused["counts"]["effects"] == 0, "An unapproved order was applied"
            try:
                client.call("recovery-run", approved=True)
            except Exception as error:
                record["interruptionResponse"] = str(error)
            restored = client.call("recovery-run", approved=True)
            replay = client.call("recovery-run", approved=True)
            assert setup["incarnation"] != restored["incarnation"], (
                "No actual actor restart occurred"
            )
            assert restored["counts"] == {
                "reads": 1,
                "effects": 1,
                "reconciliations": 1,
            }, restored
            assert replay["counts"] == restored["counts"], (
                "Replay repeated provider work"
            )
            record.update(
                status="passed",
                before=setup["incarnation"],
                after=restored["incarnation"],
                counts=restored["counts"],
                values=restored["values"],
                sourceHash=setup["setup"]["hash"],
            )
        except Exception as error:
            record.update(status="failed", error=str(error))
        record["wallSeconds"] = time.monotonic() - client.started
        print(
            json.dumps(
                {
                    key: record.get(key)
                    for key in (
                        "mode",
                        "candidateOrigin",
                        "repetition",
                        "status",
                        "counts",
                        "error",
                    )
                }
            ),
            flush=True,
        )
output = ROOT / ".wrangler/proofs" / f"program-recovery-{int(time.time())}.json"
output.write_text(
    json.dumps(
        {
            "learningProof": str(proof_path),
            "results": results,
            "limitations": [
                "Provider receipts share actor storage in this synthetic fixture",
                "Filesystem path includes explicit developer-authored checkpoints and idempotency",
                "No human integration-time measurement",
                "Model does not participate during injected recovery",
            ],
        },
        indent=2,
    )
)
print(f"Proof: {output}")
