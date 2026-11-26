// Background jobs and schedules in FerretDB (H69), portable to MongoDB: no queue service.
//   schedules: what to run and when (a preset turned into a 5-field cron, or a single date);
//   jobs:      one run each, claimed by a worker with an atomic findOneAndUpdate on status and
//              leaseUntil. A worker renews the lease while it runs; a job whose lease expires goes
//              back to the queue (another worker resumes it from its checkpoint).
// Each job id is also its runId in the usage ledger, so every run shows its own cost (H68).
import { randomUUID } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";

// ---- When: presets the portal and the agent use, stored as cron in São Paulo time ----

/** America/Sao_Paulo has had no daylight saving since 2019: a fixed UTC-3 offset. */
const OFFSET_MS = -3 * 3_600_000;

export type Freq = "once" | "daily" | "weekdays" | "weekly" | "monthly";
export interface When {
	freq: Freq;
	/** "HH:MM", São Paulo time. */
	time: string;
	/** weekly: 0 (Sunday) to 6. */
	weekday?: number;
	/** monthly: 1 to 28 (every month has it). */
	day?: number;
	/** once: "YYYY-MM-DD". */
	date?: string;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export function validWhen(w: unknown): When {
	const x = (w ?? {}) as Partial<When>;
	const fail = (m: string) => {
		throw Object.assign(new Error(`when: ${m}`), { status: 400 });
	};
	if (!["once", "daily", "weekdays", "weekly", "monthly"].includes(x.freq as string)) fail("freq must be once, daily, weekdays, weekly or monthly");
	const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(x.time ?? "");
	if (!t) fail("time must be HH:MM (São Paulo time)");
	const out: When = { freq: x.freq as Freq, time: x.time! };
	if (x.freq === "weekly") {
		if (!Number.isInteger(x.weekday) || x.weekday! < 0 || x.weekday! > 6) fail("weekday 0 (Sunday) to 6");
		out.weekday = x.weekday;
	}
	if (x.freq === "monthly") {
		if (!Number.isInteger(x.day) || x.day! < 1 || x.day! > 28) fail("day 1 to 28");
		out.day = x.day;
	}
	if (x.freq === "once") {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date ?? "") || Number.isNaN(Date.parse(`${x.date}T00:00:00Z`))) fail("date must be YYYY-MM-DD");
		out.date = x.date;
	}
	return out;
}

export function cronOf(w: When): string | undefined {
	const [h, m] = w.time.split(":").map(Number);
	if (w.freq === "daily") return `${m} ${h} * * *`;
	if (w.freq === "weekdays") return `${m} ${h} * * 1-5`;
	if (w.freq === "weekly") return `${m} ${h} * * ${w.weekday}`;
	if (w.freq === "monthly") return `${m} ${h} ${w.day} * *`;
	return undefined;
}

/** The single run of a "once" schedule, as a UTC instant. */
export const onceAt = (w: When) => new Date(Date.parse(`${w.date}T${w.time}:00Z`) - OFFSET_MS);

export function describeWhen(w: When): string {
	if (w.freq === "daily") return `Todo dia às ${w.time}`;
	if (w.freq === "weekdays") return `Dias úteis às ${w.time}`;
	if (w.freq === "weekly") return `Toda ${WEEKDAYS[w.weekday!]}${w.weekday === 0 || w.weekday === 6 ? "" : "-feira"} às ${w.time}`.replace("Toda domingo", "Todo domingo").replace("Toda sábado", "Todo sábado");
	if (w.freq === "monthly") return `Todo dia ${w.day} do mês às ${w.time}`;
	const [y, mo, d] = w.date!.split("-");
	return `Em ${d}/${mo}/${y} às ${w.time}`;
}

function cronField(spec: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const part of spec.split(",")) {
		const [range, stepS] = part.split("/");
		const step = stepS ? Number(stepS) : 1;
		const [a, b] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), stepS ? max : Number(range)];
		if (![a, b, step].every(Number.isInteger) || a < min || b > max || a > b || step < 1) throw new Error(`bad cron field ${spec}`);
		for (let v = a; v <= b; v += step) out.add(v);
	}
	return out;
}

/** Next instant strictly after `after` that matches a 5-field cron read in São Paulo time. */
export function nextRun(cron: string, after: Date): Date {
	const f = cron.trim().split(/\s+/);
	if (f.length !== 5) throw new Error("cron needs 5 fields");
	const [min, hour, dom, mon, dow] = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4].replace(/7/g, "0"), 0, 6)];
	const domAny = f[2] === "*";
	const dowAny = f[4] === "*";
	// Local wall time as a UTC date, so getUTC* reads São Paulo fields.
	const t = new Date(Math.floor((+after + OFFSET_MS) / 60_000) * 60_000 + 60_000);
	for (let i = 0; i < 500_000; i++) {
		const dayOk = domAny && dowAny ? true : domAny ? dow.has(t.getUTCDay()) : dowAny ? dom.has(t.getUTCDate()) : dom.has(t.getUTCDate()) || dow.has(t.getUTCDay());
		if (!mon.has(t.getUTCMonth() + 1) || !dayOk) {
			t.setUTCDate(t.getUTCDate() + 1);
			t.setUTCHours(0, 0, 0, 0);
			continue;
		}
		if (!hour.has(t.getUTCHours())) {
			t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
			continue;
		}
		if (!min.has(t.getUTCMinutes())) {
			t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
			continue;
		}
		return new Date(+t - OFFSET_MS);
	}
	throw new Error(`cron ${cron} never matches`);
}

/** When a schedule fires next, or undefined when it never will again. */
export function nextOf(w: When, after: Date): Date | undefined {
	if (w.freq === "once") {
		const at = onceAt(w);
		return +at > +after ? at : undefined;
	}
	return nextRun(cronOf(w)!, after);
}

// ---- Schedules ----

export type JobKind = "prompt" | "research";

export interface Schedule {
	id: string;
	user: string;
	title: string;
	/** What the agent is asked on each run. */
	prompt: string;
	kind: JobKind;
	when: When;
	tz: "America/Sao_Paulo";
	projectId?: string;
	/** Every run of this schedule posts in this conversation. */
	conversation: string;
	model?: string;
	/** Cost cap of one run, USD (shown in BRL). */
	capUsd: number;
	active: boolean;
	nextRunAt?: Date;
	lastRunAt?: Date;
	lastJob?: string;
	createdAt: Date;
}

export const SCHEDULE_LIMITS = { perUser: 20, title: 80, prompt: 4000 };

export interface ScheduleStore {
	create(s: Omit<Schedule, "id" | "createdAt" | "conversation" | "tz" | "nextRunAt" | "active">): Promise<Schedule>;
	get(user: string, id: string): Promise<Schedule | undefined>;
	list(user: string): Promise<Schedule[]>;
	update(user: string, id: string, patch: Partial<Pick<Schedule, "title" | "prompt" | "when" | "capUsd" | "active" | "model">>): Promise<Schedule | undefined>;
	remove(user: string, id: string): Promise<boolean>;
	/** Active schedules whose time came (any user). */
	due(now: Date, limit: number): Promise<Schedule[]>;
	/** Compare-and-set on nextRunAt: true only for the one worker that moved it, so a run starts once. */
	advance(id: string, expected: Date, next: Date | undefined, job: string, now: Date): Promise<boolean>;
}

function withNext(s: Schedule, now: Date): Schedule {
	const next = s.active ? nextOf(s.when, now) : undefined;
	return { ...s, nextRunAt: next, active: s.active && !!next };
}

export class MemorySchedules implements ScheduleStore {
	readonly items = new Map<string, Schedule>();
	async create(s: Parameters<ScheduleStore["create"]>[0]) {
		const now = new Date();
		const v = withNext({ ...s, id: randomUUID(), conversation: randomUUID(), tz: "America/Sao_Paulo", createdAt: now, active: true }, now);
		this.items.set(v.id, v);
		return v;
	}
	async get(user: string, id: string) {
		const s = this.items.get(id);
		return s?.user === user ? s : undefined;
	}
	async list(user: string) {
		return [...this.items.values()].filter((s) => s.user === user).sort((a, b) => +b.createdAt - +a.createdAt);
	}
	async update(user: string, id: string, patch: Parameters<ScheduleStore["update"]>[2]) {
		const s = await this.get(user, id);
		if (!s) return undefined;
		const v = withNext({ ...s, ...patch }, new Date());
		this.items.set(id, v);
		return v;
	}
	async remove(user: string, id: string) {
		return (await this.get(user, id)) ? this.items.delete(id) : false;
	}
	async due(now: Date, limit: number) {
		return [...this.items.values()].filter((s) => s.active && s.nextRunAt && +s.nextRunAt <= +now).slice(0, limit);
	}
	async advance(id: string, expected: Date, next: Date | undefined, job: string, now: Date) {
		const s = this.items.get(id);
		if (!s || +(s.nextRunAt ?? 0) !== +expected) return false;
		this.items.set(id, { ...s, nextRunAt: next, active: s.active && !!next, lastRunAt: now, lastJob: job });
		return true;
	}
}

type SDoc = Omit<Schedule, "id"> & { _id: string };
const sFrom = ({ _id, ...d }: SDoc): Schedule => ({ id: _id, ...d });

export class MongoSchedules implements ScheduleStore {
	private readonly col: Collection<SDoc>;
	constructor(col: Collection<SDoc>) {
		this.col = col;
	}
	static async connect(client: MongoClient) {
		const col = client.db().collection<SDoc>("schedules");
		await col.createIndex({ user: 1, createdAt: -1 });
		await col.createIndex({ active: 1, nextRunAt: 1 });
		return new MongoSchedules(col);
	}
	async create(s: Parameters<ScheduleStore["create"]>[0]) {
		const now = new Date();
		const { id, ...v } = withNext({ ...s, id: randomUUID(), conversation: randomUUID(), tz: "America/Sao_Paulo", createdAt: now, active: true }, now);
		await this.col.insertOne({ _id: id, ...v });
		return { id, ...v };
	}
	async get(user: string, id: string) {
		const d = await this.col.findOne({ _id: id, user });
		return d ? sFrom(d) : undefined;
	}
	async list(user: string) {
		return (await this.col.find({ user }).sort({ createdAt: -1 }).limit(SCHEDULE_LIMITS.perUser * 2).toArray()).map(sFrom);
	}
	async update(user: string, id: string, patch: Parameters<ScheduleStore["update"]>[2]) {
		const s = await this.get(user, id);
		if (!s) return undefined;
		const { id: _, ...v } = withNext({ ...s, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) }, new Date());
		await this.col.replaceOne({ _id: id, user }, v);
		return { id, ...v };
	}
	async remove(user: string, id: string) {
		return (await this.col.deleteOne({ _id: id, user })).deletedCount === 1;
	}
	async due(now: Date, limit: number) {
		return (await this.col.find({ active: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).limit(limit).toArray()).map(sFrom);
	}
	async advance(id: string, expected: Date, next: Date | undefined, job: string, now: Date) {
		const r = await this.col.updateOne(
			{ _id: id, nextRunAt: expected },
			next ? { $set: { nextRunAt: next, lastRunAt: now, lastJob: job } } : { $set: { active: false, lastRunAt: now, lastJob: job }, $unset: { nextRunAt: "" } },
		);
		return r.modifiedCount === 1;
	}
}

// ---- Jobs ----

export type JobStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type StopReason = "budget" | "user" | "attempts";

export interface Job {
	/** Also the runId of every usage row the run writes. */
	id: string;
	user: string;
	kind: JobKind;
	title: string;
	prompt: string;
	conversation: string;
	scheduleId?: string;
	projectId?: string;
	model?: string;
	capUsd: number;
	status: JobStatus;
	stopReason?: StopReason;
	error?: string;
	/** Not before (a busy conversation pushes it back). */
	runAt: Date;
	createdAt: Date;
	startedAt?: Date;
	endedAt?: Date;
	owner?: string;
	leaseUntil?: Date;
	attempts: number;
	/** Live while running (from the worker's heartbeat), final when done. */
	cost: { usd: number; calls: number };
	/** One line for the portal: the step the run is on. */
	progress?: string;
	/** Kind-specific state to resume from after a lost lease (research: finished sub-questions). */
	checkpoint?: unknown;
	cancel?: boolean;
	/** A run of an AI turn that ended waiting for the user (approval): the conversation shows it. */
	waiting?: boolean;
}

export const MAX_ATTEMPTS = 3;
export const isFinal = (s: JobStatus) => s === "done" || s === "failed" || s === "stopped";

export type NewJob = Pick<Job, "user" | "kind" | "title" | "prompt" | "conversation" | "capUsd"> & Partial<Pick<Job, "scheduleId" | "projectId" | "model" | "runAt" | "id">>;
export type JobPatch = Partial<Pick<Job, "cost" | "progress" | "checkpoint">>;
export type JobEnd = Partial<Pick<Job, "cost" | "progress" | "stopReason" | "error" | "waiting">>;

export interface JobQueue {
	enqueue(j: NewJob): Promise<Job>;
	/** Oldest due job, or one whose worker stopped renewing its lease. */
	claim(owner: string, leaseMs: number, now?: Date): Promise<Job | undefined>;
	/** Renews the lease and saves progress; undefined when the lease was lost (another worker took it). */
	heartbeat(id: string, owner: string, leaseMs: number, patch?: JobPatch): Promise<{ cancel: boolean } | undefined>;
	finish(id: string, owner: string, status: Exclude<JobStatus, "queued" | "running">, end?: JobEnd): Promise<void>;
	/** Back to the queue without counting an attempt (the conversation was busy). */
	release(id: string, owner: string, runAt: Date): Promise<void>;
	get(user: string, id: string): Promise<Job | undefined>;
	list(user: string, filter: { scheduleId?: string; conversation?: string; kind?: JobKind }, limit?: number): Promise<Job[]>;
	/** Queued: stopped now. Running: the worker stops it at its next heartbeat. */
	requestStop(user: string, id: string): Promise<Job | undefined>;
	/** Deleting a schedule keeps its runs (history and costs) but drops queued ones. */
	dropQueued(user: string, scheduleId: string): Promise<void>;
}

const newJob = (j: NewJob, now: Date): Job => ({
	...j,
	id: j.id ?? randomUUID(),
	runAt: j.runAt ?? now,
	createdAt: now,
	status: "queued",
	attempts: 0,
	cost: { usd: 0, calls: 0 },
});

export class MemoryJobs implements JobQueue {
	readonly items = new Map<string, Job>();
	async enqueue(j: NewJob) {
		const v = newJob(j, new Date());
		this.items.set(v.id, v);
		return v;
	}
	async claim(owner: string, leaseMs: number, now = new Date()) {
		const j = [...this.items.values()]
			.filter((x) => (x.status === "queued" && +x.runAt <= +now) || (x.status === "running" && +(x.leaseUntil ?? 0) < +now))
			.sort((a, b) => +a.runAt - +b.runAt)[0];
		if (!j) return undefined;
		Object.assign(j, { status: "running", owner, leaseUntil: new Date(+now + leaseMs), startedAt: j.startedAt ?? now, attempts: j.attempts + 1 });
		return { ...j };
	}
	async heartbeat(id: string, owner: string, leaseMs: number, patch: JobPatch = {}) {
		const j = this.items.get(id);
		if (!j || j.owner !== owner || j.status !== "running") return undefined;
		Object.assign(j, patch, { leaseUntil: new Date(Date.now() + leaseMs) });
		return { cancel: !!j.cancel };
	}
	async finish(id: string, owner: string, status: Exclude<JobStatus, "queued" | "running">, end: JobEnd = {}) {
		const j = this.items.get(id);
		if (!j || j.owner !== owner) return;
		Object.assign(j, end, { status, endedAt: new Date(), leaseUntil: undefined });
	}
	async release(id: string, owner: string, runAt: Date) {
		const j = this.items.get(id);
		if (!j || j.owner !== owner) return;
		Object.assign(j, { status: "queued", runAt, owner: undefined, leaseUntil: undefined, attempts: j.attempts - 1 });
	}
	async get(user: string, id: string) {
		const j = this.items.get(id);
		return j?.user === user ? { ...j } : undefined;
	}
	async list(user: string, f: { scheduleId?: string; conversation?: string; kind?: JobKind }, limit = 50) {
		return [...this.items.values()]
			.filter((j) => j.user === user && (!f.scheduleId || j.scheduleId === f.scheduleId) && (!f.conversation || j.conversation === f.conversation) && (!f.kind || j.kind === f.kind))
			.sort((a, b) => +b.createdAt - +a.createdAt)
			.slice(0, limit)
			.map((j) => ({ ...j }));
	}
	async requestStop(user: string, id: string) {
		const j = this.items.get(id);
		if (!j || j.user !== user) return undefined;
		if (j.status === "queued") Object.assign(j, { status: "stopped", stopReason: "user", endedAt: new Date() });
		else if (j.status === "running") j.cancel = true;
		return { ...j };
	}
	async dropQueued(user: string, scheduleId: string) {
		for (const j of this.items.values()) if (j.user === user && j.scheduleId === scheduleId && j.status === "queued") Object.assign(j, { status: "stopped", stopReason: "user", endedAt: new Date() });
	}
}

type JDoc = Omit<Job, "id"> & { _id: string };
const jFrom = ({ _id, ...d }: JDoc): Job => ({ id: _id, ...d });

export class MongoJobs implements JobQueue {
	private readonly col: Collection<JDoc>;
	constructor(col: Collection<JDoc>) {
		this.col = col;
	}
	static async connect(client: MongoClient) {
		const col = client.db().collection<JDoc>("jobs");
		await col.createIndex({ status: 1, runAt: 1 });
		await col.createIndex({ user: 1, createdAt: -1 });
		await col.createIndex({ user: 1, scheduleId: 1, createdAt: -1 });
		await col.createIndex({ user: 1, conversation: 1, createdAt: -1 });
		return new MongoJobs(col);
	}
	async enqueue(j: NewJob) {
		const { id, ...v } = newJob(j, new Date());
		await this.col.insertOne({ _id: id, ...v });
		return { id, ...v };
	}
	async claim(owner: string, leaseMs: number, now = new Date()) {
		const d = await this.col.findOneAndUpdate(
			{ $or: [{ status: "queued", runAt: { $lte: now } }, { status: "running", leaseUntil: { $lt: now } }] },
			{ $set: { status: "running", owner, leaseUntil: new Date(+now + leaseMs) }, $inc: { attempts: 1 } },
			{ sort: { runAt: 1 }, returnDocument: "after" },
		);
		if (!d) return undefined;
		if (!d.startedAt) await this.col.updateOne({ _id: d._id, owner }, { $set: { startedAt: now } });
		return jFrom({ ...d, startedAt: d.startedAt ?? now });
	}
	async heartbeat(id: string, owner: string, leaseMs: number, patch: JobPatch = {}) {
		const d = await this.col.findOneAndUpdate({ _id: id, owner, status: "running" }, { $set: { ...patch, leaseUntil: new Date(Date.now() + leaseMs) } }, { projection: { cancel: 1 }, returnDocument: "after" });
		return d ? { cancel: !!d.cancel } : undefined;
	}
	async finish(id: string, owner: string, status: Exclude<JobStatus, "queued" | "running">, end: JobEnd = {}) {
		await this.col.updateOne({ _id: id, owner }, { $set: { ...end, status, endedAt: new Date() }, $unset: { leaseUntil: "" } });
	}
	async release(id: string, owner: string, runAt: Date) {
		await this.col.updateOne({ _id: id, owner }, { $set: { status: "queued", runAt }, $unset: { owner: "", leaseUntil: "" }, $inc: { attempts: -1 } });
	}
	async get(user: string, id: string) {
		const d = await this.col.findOne({ _id: id, user });
		return d ? jFrom(d) : undefined;
	}
	async list(user: string, f: { scheduleId?: string; conversation?: string; kind?: JobKind }, limit = 50) {
		const q: Record<string, unknown> = { user };
		if (f.scheduleId) q.scheduleId = f.scheduleId;
		if (f.conversation) q.conversation = f.conversation;
		if (f.kind) q.kind = f.kind;
		return (await this.col.find(q, { projection: { checkpoint: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray()).map(jFrom);
	}
	async requestStop(user: string, id: string) {
		await this.col.updateOne({ _id: id, user, status: "queued" }, { $set: { status: "stopped", stopReason: "user", endedAt: new Date() } });
		await this.col.updateOne({ _id: id, user, status: "running" }, { $set: { cancel: true } });
		return this.get(user, id);
	}
	async dropQueued(user: string, scheduleId: string) {
		await this.col.updateMany({ user, scheduleId, status: "queued" }, { $set: { status: "stopped", stopReason: "user", endedAt: new Date() } });
	}
}

export async function openJobs(mongoUrl: string): Promise<{ schedules: ScheduleStore; jobs: JobQueue }> {
	if (!mongoUrl) return { schedules: new MemorySchedules(), jobs: new MemoryJobs() };
	const client = await new MongoClient(mongoUrl, { appName: "chat-jobs" }).connect();
	return { schedules: await MongoSchedules.connect(client), jobs: await MongoJobs.connect(client) };
}

/** Turns every due schedule into a job, once (compare-and-set on nextRunAt). */
export async function tick(schedules: ScheduleStore, jobs: JobQueue, now = new Date()): Promise<Job[]> {
	const out: Job[] = [];
	for (const s of await schedules.due(now, 50)) {
		const id = randomUUID();
		if (!(await schedules.advance(s.id, s.nextRunAt!, nextOf(s.when, now), id, now))) continue; // another worker took it
		out.push(await jobs.enqueue({ id, user: s.user, kind: s.kind, title: s.title, prompt: s.prompt, conversation: s.conversation, scheduleId: s.id, projectId: s.projectId, model: s.model, capUsd: s.capUsd }));
	}
	return out;
}
