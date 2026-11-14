import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../src/curator.ts";

test("curator output is parsed defensively", () => {
	assert.deepEqual(parsePlan('```json\n{"core":[{"action":"add","target":"user","text":"x"}],"facts":[]}\n```').core?.length, 1);
	assert.deepEqual(parsePlan("nada a salvar"), {});
	assert.deepEqual(parsePlan('{"core":"oops"}'), { core: [], facts: [] });
});
