// Share links (H72): unguessable ids, frozen copy of outputs only, owner-only revoke, expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FolderStore, objectStore, setObjectStore, writeFileToStore } from "../src/workspace.ts";
import { copyOutputs, deleteShareFiles, expired, MemoryShares, newShareId, SHARE_ID, SHARE_LIMITS, sharePrefix, viewOf, type Share } from "../src/shares.ts";

setObjectStore(new FolderStore(await mkdtemp(join(tmpdir(), "shares-"))));
const U = "user-share-0001";

test("share ids are 128-bit, URL-safe and distinct", () => {
	const ids = new Set(Array.from({ length: 200 }, newShareId));
	assert.equal(ids.size, 200);
	for (const id of ids) assert.match(id, SHARE_ID);
});

test("a share copies deliverables only, within the limits, and its copies are deleted on revoke", async () => {
	await writeFileToStore(U, "conv-share-01", "uploads/segredo.xlsx", Buffer.from("input"));
	await writeFileToStore(U, "conv-share-01", "work/notes.md", Buffer.from("notes"));
	await writeFileToStore(U, "conv-share-01", "outputs/deck.pptx", Buffer.from("deck"));
	await writeFileToStore(U, "conv-share-01", "outputs/deck.preview.png", Buffer.from("png"));
	await writeFileToStore(U, "conv-share-01", "outputs/big.bin", Buffer.alloc(SHARE_LIMITS.bytes + 1));
	const id = newShareId();
	const r = await copyOutputs(U, "conv-share-01", id);
	assert.deepEqual(r.files.map((f) => f.path), ["outputs/deck.pptx"]);
	assert.equal(r.skipped, 1);
	assert.deepEqual((await objectStore().list(sharePrefix(id))).map((f) => f.path), ["outputs/deck.pptx"]);
	await deleteShareFiles(id);
	assert.deepEqual(await objectStore().list(sharePrefix(id)), []);
});

test("viewers never get the owner or the conversation id; only the owner revokes; links expire", async () => {
	const s = new MemoryShares();
	const now = new Date();
	const share: Share = { id: newShareId(), user: U, kind: "conversation", conversation: "conv-share-01", title: "Deck", createdAt: now, expiresAt: new Date(+now + 86_400_000), messages: [] };
	await s.put(share);
	const v = viewOf(share) as Record<string, unknown>;
	assert.equal(v.user, undefined);
	assert.equal(v.conversation, undefined);
	assert.equal(await s.remove("someone-else-01", share.id), false);
	assert.equal(expired(share, new Date(+now + 2 * 86_400_000)), true);
	assert.equal(expired(share, now), false);
	assert.deepEqual(await s.removeOfConversation(U, "conv-share-01"), [share.id]);
	assert.equal(await s.get(share.id), undefined);
});
