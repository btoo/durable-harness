"""Sequential executable-tool study. GEPA uses its built-in reflective proposer."""

import argparse
import json
import pathlib
import subprocess
import time
import urllib.request
import urllib.error
import urllib.parse
import uuid
import gepa
from gepa.core.adapter import EvaluationBatch

ROOT = pathlib.Path(__file__).resolve().parents[1]
CODE_REFLECTION_TEMPLATE = """Improve this executable JavaScript tool, using the observed execution feedback.
Current source:
```javascript
<curr_param>
```
Contract, customer corrections, inputs, outputs and evaluator feedback:
<side_info>
Return the complete replacement JavaScript source in one ```javascript block.
Return executable code, not instructions for another assistant. Preserve unrelated behavior.
"""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Benchmark redirects are forbidden")


class Client:
    def __init__(self, base, token, identity):
        self.url = f"{base}/{identity}"
        self.token = token
        self.calls = 0
        self.started = time.monotonic()
        self.opener = urllib.request.build_opener(NoRedirects())

    def call(self, action, **kwargs):
        self.calls += 1
        if self.calls > 80 or time.monotonic() - self.started > 360:
            raise RuntimeError("Study request/wall budget exhausted")
        request = urllib.request.Request(
            self.url,
            json.dumps({"action": action, **kwargs}).encode(),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "durable-harness-program-study/1",
                "Authorization": f"Bearer {self.token}",
            },
        )
        try:
            with self.opener.open(request, timeout=130) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"{action}: HTTP {error.code}: {error.read().decode()}"
            ) from None


class Adapter:
    propose_new_texts = None

    def __init__(self, client, stage, metadata):
        self.client, self.stage, self.metadata = client, stage, metadata
        self.reflections = []
        self.attempts = 0
        self.stopped = False

    def evaluate(self, batch, candidate, capture_traces=False):
        result = self.client.call(
            "program-evaluate", stage=self.stage, candidate=candidate, caseIds=batch
        )
        scores = result["scores"]
        return EvaluationBatch(
            outputs=scores,
            scores=[s["score"] for s in scores],
            trajectories=scores if capture_traces else None,
        )

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        # Feed the real inputs, outputs, errors and evaluator feedback to GEPA's
        # default reflective mutation. Held-out cases never enter this dataset.
        return {
            "source": [
                {
                    "contract": self.metadata["contract"],
                    "customer_corrections": self.metadata["corrections"],
                    "execution": json.loads(score["explanation"]),
                }
                for score in eval_batch.outputs
            ]
        }

    def reflect(self, prompt):
        if self.stopped or self.attempts >= 3:
            raise RuntimeError("Three-candidate bound exhausted")
        self.attempts += 1
        try:
            result = self.client.call(
                "program-reflect",
                stage=self.stage,
                prompt=prompt,
                requestId=str(uuid.uuid4()),
            )
        except Exception as error:
            self.stopped = True
            status = self.client.call("program-status", stage=self.stage)
            self.reflections.append(
                {
                    "prompt": prompt,
                    "error": str(error),
                    "usage": status.get("gepaUsage"),
                }
            )
            raise
        self.reflections.append({"prompt": prompt, **result})
        return result["text"]


def run(base, token, mode, repetition, output, checkpoint=lambda: None):
    identity = f"program-{mode}-{uuid.uuid4()}"
    client = Client(base, token, identity)
    report = {
        "mode": mode,
        "repetition": repetition,
        "identity": identity,
        "stages": [],
        "status": "running",
    }
    output["runs"].append(report)
    checkpoint()
    candidate = None
    try:
        for stage in (1, 2):
            metadata = client.call("program-metadata", stage=stage)
            candidate = candidate or metadata["seed"]
            baseline = client.call("program-evaluate", stage=stage, candidate=candidate)
            before = time.monotonic()
            evidence = {"stage": stage, "baseline": baseline}
            report["stages"].append(evidence)
            checkpoint()
            if mode == "harness":
                result = client.call("program-harness", stage=stage)
                evidence["learning"] = result
                if result["run"]["status"] == "awaiting_review":
                    result = client.call("program-review", stage=stage, reviewed=True)
                    candidate = result["candidate"]
                    evidence["review"] = result
                elif result["run"]["status"] != "promoted":
                    evidence["error"] = (
                        f"Learning ended {result['run']['status']}; retaining the approved baseline"
                    )
            elif mode == "gepa":
                adapter = Adapter(client, stage, metadata)
                training = [
                    c["id"] for c in metadata["cases"] if c["split"] == "adaptation"
                ]
                validation = [
                    c["id"] for c in metadata["cases"] if c["split"] == "validation"
                ]
                try:
                    optimized = gepa.optimize(
                        seed_candidate=candidate,
                        trainset=training,
                        valset=validation,
                        adapter=adapter,
                        reflection_lm=adapter.reflect,
                        reflection_prompt_template=CODE_REFLECTION_TEMPLATE,
                        reflection_minibatch_size=len(training),
                        max_metric_calls=128,
                        stop_callbacks=lambda state: adapter.stopped
                        or adapter.attempts >= 3
                        or any(
                            scores and all(score == 1 for score in scores.values())
                            for scores in state.prog_candidate_val_subscores
                        ),
                        display_progress_bar=False,
                        seed=repetition,
                    )
                    proposed = optimized.best_candidate
                    evaluated = client.call(
                        "program-evaluate", stage=stage, candidate=proposed
                    )
                    # Apply the same all-critical validation/review boundary used by
                    # the harness. A partial GEPA winner remains a proposal.
                    if all(s["passed"] for s in evaluated["scores"]):
                        candidate = proposed
                        evidence["review"] = (
                            "synthetic automated reviewer; human effort not measured"
                        )
                    else:
                        evidence["rejected"] = evaluated
                except Exception as error:
                    evidence["error"] = str(error)
                finally:
                    evidence["reflections"] = adapter.reflections
                    if adapter.stopped:
                        evidence["error"] = adapter.reflections[-1].get(
                            "error", "Reflection stopped"
                        )
            evidence["seconds"] = time.monotonic() - before
            evidence["candidate"] = candidate
            evidence["validation"] = client.call(
                "program-evaluate", stage=stage, candidate=candidate
            )
            checkpoint()
            print(
                json.dumps(
                    {
                        "mode": mode,
                        "repetition": repetition,
                        "stage": stage,
                        "passed": sum(
                            s["passed"] for s in evidence["validation"]["scores"]
                        ),
                        "cases": len(evidence["validation"]["scores"]),
                        "seconds": round(evidence["seconds"], 2),
                    }
                ),
                flush=True,
            )
        report["candidate"] = candidate
        report["assessment"] = client.call("program-seal", stage=2, candidate=candidate)
        report["status"] = "completed"
    except Exception as error:
        report["status"] = "inconclusive"
        report["error"] = str(error)
    report["wallSeconds"] = time.monotonic() - client.started
    report["requests"] = client.calls
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("--repetitions", type=int, default=3, choices=range(1, 4))
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not parsed.hostname.endswith(".workers.dev")
        or parsed.path
        or parsed.query
        or parsed.username
    ):
        parser.error("Use the isolated benchmark Worker's HTTPS origin")
    secrets = dict(
        line.strip().split("=", 1)
        for line in (ROOT / "apps/benchmarks/.dev.vars.deployed")
        .read_text()
        .splitlines()
        if "=" in line
    )
    output = {
        "study": "sequential-tool-v2",
        "sourceRevision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        "gepaVersion": "0.1.4",
        "model": "@cf/zai-org/glm-5.3-flash",
        "evidence": "synthetic",
        "runs": [],
        "limits": {
            "repetitions": args.repetitions,
            "perModePerStage": {"candidates": 3, "tokens": 48000, "activeMs": 120000},
        },
        "limitations": [
            "Small synthetic suite; no significance claim",
            "Review is an explicit automated fixture, not measured human judgment",
            "Supplied tool API and schemas; no autonomous connector creation",
            "Shared sandbox evaluation; persistence/recovery assessed separately",
            "Scenario families are hand-authored, not customer-derived independent datasets",
        ],
    }
    path = ROOT / ".wrangler/proofs" / f"program-comparison-{int(time.time())}.json"
    for repetition in range(args.repetitions):
        # Rotate order to reduce a fixed warm-cache/provider-order bias.
        modes = ["disabled", "harness", "gepa"]
        modes = modes[repetition:] + modes[:repetition]
        for mode in modes:
            report = run(
                args.base,
                secrets["ADMIN_TOKEN"],
                mode,
                repetition,
                output,
                lambda: path.write_text(json.dumps(output, indent=2)),
            )
            path.write_text(json.dumps(output, indent=2))
            print(
                json.dumps(
                    {
                        "mode": mode,
                        "repetition": repetition,
                        "status": report["status"],
                        "assessment": report.get("assessment"),
                        "error": report.get("error"),
                    }
                ),
                flush=True,
            )
    print(f"Proof: {path}")


if __name__ == "__main__":
    main()
