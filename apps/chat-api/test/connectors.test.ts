// Connector vault: tokens sealed per user and connector; OAuth state bound to the user.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { checkState, makeState, seal, unseal } from "../src/connectors.ts";

const key = randomBytes(32);

test("sealed tokens open only with the same key and the same user/connector", () => {
	const s = seal({ accessToken: "gho_secret" }, "u1/github", key);
	assert.ok(!s.includes("gho_secret"));
	assert.deepEqual(unseal(s, "u1/github", key), { accessToken: "gho_secret" });
	assert.throws(() => unseal(s, "u2/github", key)); // moved to another user
	assert.throws(() => unseal(s, "u1/github", randomBytes(32))); // wrong key
});

test("OAuth state: signed, user-bound, expires, gives the same PKCE verifier", () => {
	const now = Date.now();
	const { state, verifier } = makeState("user-1234", "github", key, now);
	assert.equal(checkState(state, "user-1234", "github", key, now), verifier);
	assert.throws(() => checkState(state, "user-9999", "github", key, now), /foreign/);
	assert.throws(() => checkState(state, "user-1234", "github", key, now + 601_000), /expired/);
	assert.throws(() => checkState(state.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "user-1234", "github", key, now), /bad state/);
	assert.throws(() => checkState(state, "user-1234", "github", randomBytes(32), now), /bad state/);
});
