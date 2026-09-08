"""Print measured outcomes without turning missing usage into zero or failures into wins."""

import json
import pathlib
import sys


def summarize(proof):
    rows = []
    for run in proof["runs"]:
        usage = []
        reviews = 0
        missing = 0
        for stage in run["stages"]:
            reviews += int("review" in stage)
            if run["mode"] == "disabled":
                continue
            item = stage.get("learning", {}).get("usage")
            if run["mode"] == "gepa" and stage.get("reflections"):
                item = stage["reflections"][-1].get("usage")
            if item is None:
                missing += 1
            else:
                usage.append(item)
        assessment = run.get("assessment")
        rows.append(
            {
                "mode": run["mode"],
                "repetition": run["repetition"],
                "status": run["status"],
                "heldout": f"{assessment['passed']}/{assessment['cases']}"
                if assessment
                else None,
                "modelSteps": sum(item["steps"] for item in usage),
                "knownReportedTokens": sum(item["usedTokens"] for item in usage),
                "unsettledReservations": sum(item["reservedTokens"] for item in usage),
                "stagesWithoutUsageReceipt": missing,
                "activeSeconds": round(
                    sum(item["activeMs"] for item in usage) / 1000, 3
                ),
                "wallSeconds": round(run["wallSeconds"], 3),
                "syntheticReviews": reviews,
                "stagesWithUnappliedChanges": sum(
                    int("error" in stage or "rejected" in stage)
                    for stage in run["stages"]
                ),
                "error": run.get("error"),
            }
        )
    return rows


if __name__ == "__main__":
    print(
        json.dumps(
            summarize(json.loads(pathlib.Path(sys.argv[1]).read_text())), indent=2
        )
    )
