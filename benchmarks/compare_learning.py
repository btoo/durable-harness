"""Bounded synthetic comparison using the real GEPA package and deployed Codemode filesystem."""
import json
import pathlib
import sys
import time
import urllib.request
import urllib.error
import uuid
import gepa
from gepa.core.adapter import EvaluationBatch

base = sys.argv[1].rstrip("/")
if not base.startswith("https://") or not base.endswith(".workers.dev"):
    raise SystemExit("Pass the isolated benchmark Worker URL.")
secret_file = pathlib.Path(__file__).parents[1] / "apps/benchmarks/.dev.vars.deployed"
secrets = dict(line.strip().split("=", 1) for line in secret_file.read_text().splitlines() if "=" in line)

class Client:
    def __init__(self, name):
        self.url = f"{base}/{name}-{uuid.uuid4()}"
        self.started = time.monotonic()
        self.requests = 0
        self.model_usage = None
        self.filesystem_ms = 0
    def call(self, action, **values):
        self.requests += 1
        if self.requests > 40 or time.monotonic() - self.started > 120:
            raise RuntimeError("The comparison exceeded its request or wall-time budget")
        request = urllib.request.Request(self.url, json.dumps({"action": action, **values}).encode(), headers={"Content-Type": "application/json", "User-Agent": "durable-harness-benchmark/0.1", "Authorization": f"Bearer {secrets['ADMIN_TOKEN']}"})
        try:
            with urllib.request.urlopen(request, timeout=max(1, 120-(time.monotonic()-self.started))) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{action}: HTTP {error.code}: {error.read().decode()}") from None
        self.filesystem_ms += result.get("filesystemMs", 0)
        if "usage" in result:
            self.model_usage = result["usage"]
        return result

class Adapter:
    propose_new_texts = None
    def __init__(self, client):
        self.client = client
        self.proposals = 0
    def evaluate(self, batch, candidate, capture_traces=False):
        configuration = json.loads(candidate["configuration"])
        result = self.client.call("evaluate", candidate=configuration, caseIds=batch)
        scores = result["scores"]
        return EvaluationBatch(outputs=scores, scores=[item["score"] for item in scores], trajectories=scores if capture_traces else None)
    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        return {"configuration": [{"Feedback": item["explanation"], "score": item["score"]} for item in eval_batch.outputs]}
    def propose(self, candidate, reflective_dataset, components_to_update):
        self.proposals += 1
        if self.proposals > 3:
            raise RuntimeError("GEPA reached the three-candidate bound")
        generated = self.client.call("propose", candidate=json.loads(candidate["configuration"]))
        return {"configuration": json.dumps(generated["candidate"])}

results = []
for mode in ["learning-disabled", "durable-harness", "codemode-filesystem-gepa"]:
    client = Client(mode)
    metadata = client.call("metadata")
    candidate = metadata["seed"]
    if mode == "durable-harness":
        candidate = client.call("harness")["candidate"]
    elif mode == "codemode-filesystem-gepa":
        adapter = Adapter(client)
        # Use GEPA's actual selection/evaluation loop and the same bounded generator as the harness.
        optimized = gepa.optimize(seed_candidate={"configuration": json.dumps(candidate)}, trainset=metadata["adaptationIds"], valset=metadata["caseIds"], adapter=adapter, custom_candidate_proposer=adapter.propose, max_metric_calls=24, stop_callbacks=lambda state: adapter.proposals >= 3, display_progress_bar=False, seed=0)
        candidate = json.loads(optimized.best_candidate["configuration"])
    evaluated = client.call("evaluate", candidate=candidate)
    heldout = client.call("heldout", candidate=candidate)
    results.append({"mode": mode, "candidate": candidate, "validationPassed": sum(item["passed"] for item in evaluated["scores"]), "validationCases": len(evaluated["scores"]), "heldout": heldout, "modelUsage": client.model_usage, "wallSeconds": time.monotonic()-client.started, "filesystemMs": client.filesystem_ms, "requests": client.requests})
    print(json.dumps({"mode": mode, "validationPassed": results[-1]["validationPassed"], "heldout": heldout}), flush=True)
output = pathlib.Path(__file__).parents[1] / ".wrangler/proofs" / f"comparison-{int(time.time())}.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"gepaVersion": "0.1.4", "model": metadata["model"], "evidence": "synthetic", "results": results, "limitations": ["One toy configuration task; no statistical superiority claim", "Adaptation, validation and held-out cases use separate scenario families", "The same proposal generator is used to hold model behavior comparable", "Human integration effort and review effort are not measured"]}, indent=2))
print(f"Proof: {output}")
