"""Regression: real GEPA reflection must receive evaluator diagnostics."""

import unittest
import gepa
from compare_programs import Adapter, CODE_REFLECTION_TEMPLATE


class FakeClient:
    def __init__(self):
        self.prompts = []

    def call(self, action, **values):
        if action == "program-evaluate":
            passed = values["candidate"]["source"] == "repaired tool"
            return {
                "scores": [
                    {
                        "caseId": key,
                        "passed": passed,
                        "score": int(passed),
                        "explanation": '{"error":"missing FX normalization sentinel"}',
                    }
                    for key in values["caseIds"]
                ]
            }
        if action == "program-reflect":
            self.prompts.append(values["prompt"])
            return {"text": "```\nrepaired tool\n```", "usage": {"usedTokens": 10}}
        raise AssertionError(action)


class ReflectionTest(unittest.TestCase):
    def test_builtin_reflection_consumes_real_diagnostics(self):
        client = FakeClient()
        adapter = Adapter(
            client,
            1,
            {
                "contract": "Implement a quote tool",
                "corrections": ["convert currencies"],
            },
        )
        result = gepa.optimize(
            seed_candidate={"source": "broken tool"},
            trainset=["train"],
            valset=["validation"],
            adapter=adapter,
            reflection_lm=adapter.reflect,
            reflection_prompt_template=CODE_REFLECTION_TEMPLATE,
            max_metric_calls=8,
            stop_callbacks=lambda state: len(adapter.reflections) >= 1,
            display_progress_bar=False,
            seed=0,
        )
        self.assertEqual(result.best_candidate["source"], "repaired tool")
        self.assertEqual(len(client.prompts), 1)
        self.assertIn("missing FX normalization sentinel", client.prompts[0])
        self.assertIn("convert currencies", client.prompts[0])
        self.assertIn("Return executable code", client.prompts[0])


if __name__ == "__main__":
    unittest.main()
