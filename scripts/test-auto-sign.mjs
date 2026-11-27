import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AutoSignStore, getStudentIdentity, TASK_LEASE_MS, DISPATCHER_LEASE_MS, MAX_PREPARATION_ATTEMPTS } from "../src/lib/auto-sign/store.ts";
import { AutoSignService } from "../src/lib/auto-sign/service.ts";
import { AUTO_SIGN_RECORD_LIMIT } from "../src/lib/auto-sign/types.ts";
import { calculateOccurrence, calculateScheduleOffsetSeconds, normalizeCourseDate, SIGN_RANDOM_WINDOW_SECONDS, DEADLINE_BEFORE_CLASS_MS } from "../src/lib/auto-sign/time.ts";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { verifyMachineCredential } from "../src/lib/auto-sign/environment.ts";
import { parseWeComCallbackMessage, truncateWeComText, verifyWeComCallbackUrl } from "../src/lib/auto-sign/notify.ts";
import { parseBotDateToken, WeComBotService } from "../src/lib/auto-sign/wecom-bot.ts";
import { IclassError } from "../src/lib/iclass.ts";

// No test is permitted to reach any upstream, even if a fake dependency is accidentally omitted.
globalThis.fetch = async () => { throw new Error("Network disabled in scheduling tests"); };

const courseDate = "2026-09-15";
const course = {
	id: "1234567", uuid: "A".repeat(32), courseName: "Synthetic course", teacherName: "Test teacher",
	weekDay: "2", classBeginTime: "08:30", classEndTime: "10:10", signStatus: "0",
};
const occurrence = calculateOccurrence(courseDate, course.classBeginTime, course.classEndTime);

function createFixture(context, databasePath = ":memory:") {
	const store = new AutoSignStore(databasePath);
	context.after(() => store.close());
	const state = {
		now: occurrence.scheduledAt - 60_000,
		courses: [structuredClone(course)],
		loginCalls: 0,
		signCalls: [],
		queriedDates: [],
		config: {
			access: { passwordHash: "test-only", sessionSecret: "test-only", secureCookies: true },
			studentPassword: "test-shared-student-password",
			students: [
				{ id: "alpha", name: "alpha", studentId: "202600000000001" },
				{ id: "duplicate", name: "duplicate", studentId: "202600000000001" },
				{ id: "beta", name: "beta", studentId: "202600000000002" },
			],
		},
	};
	const dependencies = {
		now: () => state.now,
		getScheduleOffsetSeconds: () => 0,
		readConfig: async () => state.config,
		login: async (username, password) => {
			state.loginCalls += 1;
			assert.equal(password, state.config.studentPassword);
			assert.ok(state.config.students.some((account) => account.studentId === username));
			return { userId: "synthetic-user", sessionId: "never-log-this-session" };
		},
		querySchedule: async (_session, date) => {
			state.queriedDates.push(date);
			return structuredClone(state.courses);
		},
		getTimestamp: async () => state.now,
		submitSign: async (session, courseSchedId, timestamp) => {
			state.signCalls.push({ session, courseSchedId, timestamp });
			return { success: true, message: "Synthetic success", upstreamStatus: "0", result: { stuSignId: "test", stuSignStatus: "1" }, status: 200 };
		},
	};
	const service = new AutoSignService(store, dependencies);
	async function schedule(accountId = "alpha", mode = "live", selectedDate = courseDate) {
		await service.setAccountEnabled(accountId, true);
		const body = { accountId, date: selectedDate, courseSchedId: course.id };
		const preview = await service.previewTask(body);
		return service.createTask({ ...body, expectedClassBeginAt: preview.classBeginAt, expectedClassEndAt: preview.classEndAt }, mode);
	}
	return { store, state, dependencies, service, schedule };
}

async function createRetentionFixture(context) {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-retention-test-"));
	context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const databasePath = path.join(temporaryDirectory, "tasks.sqlite");
	const fixture = createFixture(context, databasePath);
	const database = new DatabaseSync(databasePath);
	context.after(() => database.close());
	fixture.store.synchronizeAccounts(fixture.state.config.students, fixture.state.now);
	for (const account of fixture.state.config.students) {
		fixture.store.setAccountEnabled(account.id, getStudentIdentity(account.studentId), true, fixture.state.now);
	}
	function createStoredTask(taskIndex, now = fixture.state.now + taskIndex, selectedStore = fixture.store) {
		const account = fixture.state.config.students[taskIndex % 2 === 0 ? 0 : 2];
		const preview = { ...calculateOccurrence("2026-09-16", "08:30", "10:10"), courseDate: "2026-09-16",
			accountId: account.id, accountName: account.name,
			courseSchedId: String(7000000 + taskIndex), courseName: "Retention test" };
		return selectedStore.createTask(preview, getStudentIdentity(account.studentId), now, "live");
	}
	return { ...fixture, database, databasePath, createStoredTask };
}

test("Shanghai base window starts at 08:20 independent of process timezone and rejects invalid dates/clocks", () => {
	const originalTimezone = process.env.TZ;
	try {
		for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
			process.env.TZ = timezone;
			const scheduledOccurrence = calculateOccurrence(courseDate, "08:30", "10:10");
			assert.equal(scheduledOccurrence.scheduledAt, Date.parse("2026-09-15T00:20:00Z"));
			assert.equal(scheduledOccurrence.deadlineAt, Date.parse("2026-09-15T00:29:30Z"));
		}
	} finally {
		if (originalTimezone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimezone;
	}
	assert.equal(normalizeCourseDate("20260915"), courseDate);
	for (const date of ["20260230", "2026-13-01", "2026-02-29", "2026--09-15", "abcd", "20260915\n"]) {
		assert.throws(() => normalizeCourseDate(date));
	}
	for (const clock of ["", "24:00", "08:60", "8:30", "2026-09-16T08:30", "08:30:61"]) {
		assert.throws(() => calculateOccurrence(courseDate, clock, "10:10"));
	}
	assert.throws(() => calculateOccurrence(courseDate, "10:30", "10:10"));
});

test("random schedule covers 08:20 through 08:24 with pre-class 30-second deadline", () => {
	for (let offsetSeconds = 0; offsetSeconds <= SIGN_RANDOM_WINDOW_SECONDS; offsetSeconds += 1) {
		const randomizedOccurrence = calculateOccurrence(courseDate, "08:30", "10:10", offsetSeconds);
		assert.equal(randomizedOccurrence.scheduledAt, occurrence.scheduledAt + offsetSeconds * 1000);
		assert.equal(randomizedOccurrence.deadlineAt, randomizedOccurrence.classBeginAt - DEADLINE_BEFORE_CLASS_MS);
		assert.equal(randomizedOccurrence.deadlineAt, Date.parse("2026-09-15T08:29:30+08:00"));
		assert.ok(randomizedOccurrence.scheduledAt >= Date.parse("2026-09-15T08:20:00+08:00"));
		assert.ok(randomizedOccurrence.scheduledAt <= Date.parse("2026-09-15T08:24:00+08:00"));
	}
	for (const invalidOffset of [-1, 241, 0.5, NaN, Infinity]) {
		assert.throws(() => calculateOccurrence(courseDate, "08:30", "10:10", invalidOffset), { code: "INVALID_SCHEDULE_OFFSET" });
	}
});

test("per-occurrence pseudorandom offsets are stable and spread students, dates and courses", () => {
	const studentIdentity = getStudentIdentity("202600000000001");
	const firstOffset = calculateScheduleOffsetSeconds(studentIdentity, courseDate, course.id);
	assert.equal(calculateScheduleOffsetSeconds(studentIdentity, "20260915", course.id), firstOffset);
	for (const dimension of ["student", "date", "course"]) {
		const offsets = new Set();
		for (let sampleIndex = 0; sampleIndex < 28; sampleIndex += 1) {
			const sampleIdentity = dimension === "student" ? getStudentIdentity(String(202600000000001 + sampleIndex)) : studentIdentity;
			const sampleDate = dimension === "date" ? `2026-10-${String(sampleIndex + 1).padStart(2, "0")}` : courseDate;
			const sampleCourse = dimension === "course" ? String(1234567 + sampleIndex) : course.id;
			const offsetSeconds = calculateScheduleOffsetSeconds(sampleIdentity, sampleDate, sampleCourse);
			assert.ok(Number.isInteger(offsetSeconds) && offsetSeconds >= 0 && offsetSeconds <= 240);
			assert.equal(calculateScheduleOffsetSeconds(sampleIdentity, sampleDate, sampleCourse), offsetSeconds);
			offsets.add(offsetSeconds);
		}
		assert.ok(offsets.size > 10, `${dimension} must not collapse to a shared fixed time`);
	}
});

test("random preview matches saved time across service and database restarts", async (context) => {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-random-test-"));
	context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const databasePath = path.join(temporaryDirectory, "tasks.sqlite");
	const { dependencies, service, schedule, store } = createFixture(context, databasePath);
	dependencies.getScheduleOffsetSeconds = calculateScheduleOffsetSeconds;
	await service.setAccountEnabled("alpha", true);
	const selection = { accountId: "alpha", date: courseDate, courseSchedId: course.id };
	const preview = await service.previewTask(selection);
	assert.deepEqual(await service.previewTask(selection), preview);
	const task = await schedule();
	assert.equal(task.scheduledAt, preview.scheduledAt);
	assert.equal(task.deadlineAt, preview.deadlineAt);
	const reopenedStore = new AutoSignStore(databasePath);
	try {
		const restartedService = new AutoSignService(reopenedStore, dependencies);
		assert.deepEqual(await restartedService.previewTask(selection), preview);
		assert.deepEqual(reopenedStore.listTasks(), store.listTasks());
		const repeatedTask = await restartedService.createTask({ ...selection,
			expectedClassBeginAt: preview.classBeginAt, expectedClassEndAt: preview.classEndAt }, "live");
		assert.equal(repeatedTask.id, task.id);
		assert.equal(repeatedTask.scheduledAt, task.scheduledAt);
	} finally {
		reopenedStore.close();
	}
});

test("retention keeps twenty recently updated tasks across accounts and statuses, removing old events too", async (context) => {
	const { store, state, database, databasePath, createStoredTask } = await createRetentionFixture(context);
	assert.equal(AUTO_SIGN_RECORD_LIMIT, 20);
	assert.deepEqual(store.listTasks(), []);
	const accountsBefore = database.prepare("SELECT * FROM account_settings ORDER BY accountId").all();
	const heartbeatBefore = store.getHeartbeat();
	const statuses = ["pending", "retry_wait", "preparing", "uncertain", "succeeded", "skipped",
		"cancelled", "paused", "expired", "dry_run", "failed", "submitting"];
	const createdTasks = [];
	for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
		const task = createStoredTask(taskIndex);
		database.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(statuses[taskIndex % statuses.length], task.id);
		createdTasks.push(task);
		assert.equal(store.listTasks().length, Math.min(taskIndex + 1, 20));
		assert.equal(database.prepare("SELECT COUNT(*) AS total FROM tasks").get().total, Math.min(taskIndex + 1, 20));
	}
	assert.deepEqual(store.listTasks().map((task) => task.id), createdTasks.slice(-20).reverse().map((task) => task.id));
	assert.deepEqual(new Set(store.listTasks().map((task) => task.accountId)), new Set(["alpha", "beta"]));
	for (const removedTask of createdTasks.slice(0, 5)) {
		assert.equal(store.getTask(removedTask.id), undefined);
		assert.equal(database.prepare("SELECT COUNT(*) AS total FROM events WHERE taskId = ?").get(removedTask.id).total, 0);
	}
	// Updating an older record makes it recent; active tasks have no special exemption.
	database.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(state.now + 100, createdTasks[5].id);
	const newestTask = createStoredTask(25, state.now + 101);
	assert.equal(store.listTasks()[0].id, newestTask.id);
	assert.equal(store.listTasks()[1].id, createdTasks[5].id);
	assert.equal(store.getTask(createdTasks[6].id), undefined);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM events").get().total, 20);
	assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
	assert.deepEqual(database.prepare("SELECT * FROM account_settings ORDER BY accountId").all(), accountsBefore);
	assert.deepEqual(store.getHeartbeat(), heartbeatBefore);
	const retainedTasks = store.listTasks();
	const reopenedStore = new AutoSignStore(databasePath);
	try {
		assert.deepEqual(reopenedStore.listTasks(), retainedTasks);
	} finally {
		reopenedStore.close();
	}
});

test("same-millisecond creations from multiple connections keep the newest inserts and reject backward-clock loss", async (context) => {
	const { store, state, database, databasePath, createStoredTask } = await createRetentionFixture(context);
	const secondStore = new AutoSignStore(databasePath);
	context.after(() => secondStore.close());
	const tasks = [];
	for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
		tasks.push(createStoredTask(taskIndex, state.now, taskIndex % 2 === 0 ? store : secondStore));
	}
	assert.deepEqual(store.listTasks().map((task) => task.id), tasks.slice(-20).reverse().map((task) => task.id));
	assert.deepEqual(secondStore.listTasks(), store.listTasks());
	const rowsBefore = database.prepare("SELECT * FROM tasks ORDER BY rowid").all();
	const eventsBefore = database.prepare("SELECT * FROM events ORDER BY id").all();
	assert.throws(() => createStoredTask(30, state.now - 1), { code: "CLOCK_SKEW" });
	assert.deepEqual(database.prepare("SELECT * FROM tasks ORDER BY rowid").all(), rowsBefore);
	assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), eventsBefore);
});

test("opening an older database prunes records and events atomically without preserving hidden overflow", async (context) => {
	const { store, database, databasePath, createStoredTask } = await createRetentionFixture(context);
	const initialTask = createStoredTask(0);
	const template = store.getTask(initialTask.id);
	const columns = Object.keys(template);
	const insertTask = database.prepare(`INSERT INTO tasks (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
	for (let taskIndex = 1; taskIndex < 25; taskIndex += 1) {
		const record = { ...template, id: `legacy-${taskIndex}`, courseSchedId: String(7100000 + taskIndex),
			updatedAt: template.updatedAt + taskIndex, createdAt: template.createdAt + taskIndex,
			status: taskIndex % 2 === 0 ? "pending" : "succeeded", deletedAt: taskIndex === 1 ? template.updatedAt : null };
		insertTask.run(...columns.map((column) => record[column]));
		database.prepare("INSERT INTO events(taskId, createdAt, stage, code) VALUES (?, ?, 'schedule', 'SCHEDULED')")
			.run(record.id, record.createdAt);
	}
	const originalRows = database.prepare("SELECT * FROM tasks ORDER BY rowid").all();
	const originalEvents = database.prepare("SELECT * FROM events ORDER BY id").all();
	database.exec(`CREATE TRIGGER reject_retention_delete BEFORE DELETE ON tasks WHEN OLD.id = 'legacy-1'
		BEGIN SELECT RAISE(ABORT, 'Synthetic deletion failure'); END;`);
	assert.throws(() => new AutoSignStore(databasePath), /Synthetic deletion failure/);
	assert.deepEqual(database.prepare("SELECT * FROM tasks ORDER BY rowid").all(), originalRows);
	assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), originalEvents);
	database.exec("DROP TRIGGER reject_retention_delete");
	const reopenedStore = new AutoSignStore(databasePath);
	try {
		assert.equal(reopenedStore.listTasks().length, 20);
		assert.deepEqual(database.prepare("SELECT * FROM tasks ORDER BY rowid").all(), originalRows.slice(-20));
		assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), originalEvents.slice(-20));
		assert.equal(reopenedStore.getTask("legacy-1"), undefined);
		assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
	} finally {
		reopenedStore.close();
	}
});

test("new tasks wait rather than evict an in-flight submission and its result", async (context) => {
	const { store, state, database, schedule, createStoredTask } = await createRetentionFixture(context);
	const submittingTask = await schedule();
	state.now = submittingTask.scheduledAt;
	const claimedTask = store.claimNextTask(state.now);
	assert.equal(store.markSubmitting(claimedTask, state.now), true);
	for (let taskIndex = 0; taskIndex < 19; taskIndex += 1) createStoredTask(taskIndex, state.now + taskIndex + 1);
	const recordsBefore = database.prepare("SELECT * FROM tasks ORDER BY rowid").all();
	const eventsBefore = database.prepare("SELECT * FROM events ORDER BY id").all();
	assert.throws(() => createStoredTask(19, state.now + 100), { code: "TASK_RETENTION_BUSY", status: 409 });
	assert.deepEqual(database.prepare("SELECT * FROM tasks ORDER BY rowid").all(), recordsBefore);
	assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), eventsBefore);
	store.finishTask(claimedTask, "succeeded", "SIGNED", state.now + 101);
	const createdTask = createStoredTask(19, state.now + 102);
	assert.equal(store.listTasks().length, 20);
	assert.equal(store.listTasks()[0].id, createdTask.id);
	assert.equal(store.getTask(submittingTask.id).status, "succeeded");
});

for (const executionMode of ["live", "dry-run"]) {
	test(`evicting a preparing task prevents execution and orphan events in ${executionMode}`, async (context) => {
		const { store, state, dependencies, service, schedule, database, createStoredTask } = await createRetentionFixture(context);
		const task = await schedule("alpha", executionMode);
		dependencies.getTimestamp = async () => {
			for (let taskIndex = 0; taskIndex < 20; taskIndex += 1) createStoredTask(taskIndex, state.now);
			return state.now;
		};
		state.now = task.scheduledAt;
		await service.tick(executionMode);
		assert.equal(state.signCalls.length, 0);
		assert.equal(store.getTask(task.id), undefined);
		assert.equal(store.listTasks().length, 20);
		assert.equal(database.prepare("SELECT COUNT(*) AS total FROM events WHERE taskId = ?").get(task.id).total, 0);
		assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
	});
}

test("latest random task waits until 08:24 and retries preparation beyond the former 08:22 deadline", async (context) => {
	const { dependencies, state, service, schedule, store } = createFixture(context);
	dependencies.getScheduleOffsetSeconds = () => 240;
	const task = await schedule();
	state.now = Date.parse("2026-09-15T08:22:00+08:00");
	await service.tick("live");
	assert.equal(store.getTask(task.id).status, "pending");
	assert.equal(state.signCalls.length, 0);
	const originalLogin = dependencies.login;
	dependencies.login = async () => { throw new IclassError(504, "UPSTREAM_LOGIN_TIMEOUT", "Synthetic timeout", "login", true); };
	state.now = task.scheduledAt;
	await service.tick("live");
	assert.equal(store.getTask(task.id).status, "retry_wait");
	assert.equal(store.getTask(task.id).scheduledAt, task.scheduledAt);
	dependencies.login = originalLogin;
	state.now += 20_000;
	await service.tick("live");
	assert.equal(store.getTask(task.id).status, "succeeded");
	assert.equal(state.signCalls.length, 1);
});

test("new random policy does not move previously saved fixed-time tasks", async (context) => {
	const { dependencies, state, service, schedule, store } = createFixture(context);
	const legacyTask = await schedule();
	dependencies.getScheduleOffsetSeconds = () => 240;
	const selection = { accountId: "alpha", date: courseDate, courseSchedId: course.id };
	const legacyPreview = await service.previewTask(selection);
	assert.equal(legacyPreview.scheduledAt, legacyTask.scheduledAt);
	assert.equal(legacyPreview.deadlineAt, legacyTask.deadlineAt);
	const repeatedTask = await schedule();
	assert.equal(repeatedTask.id, legacyTask.id);
	assert.equal(repeatedTask.scheduledAt, occurrence.scheduledAt);
	assert.equal(repeatedTask.deadlineAt, occurrence.deadlineAt);
	state.now = legacyTask.scheduledAt;
	await service.tick("live");
	assert.equal(store.getTask(legacyTask.id).status, "succeeded");
	assert.equal(state.signCalls.length, 1);
	state.now = legacyTask.deadlineAt + 1;
	await assert.rejects(service.previewTask(selection), { code: "PLANNED_TIME_PASSED" });
});

test("accounts default disabled; enabling creates no tasks or upstream calls; only explicit dated selection executes", async (context) => {
	const { store, state, service, schedule } = createFixture(context);
	store.synchronizeAccounts(state.config.students, state.now);
	assert.ok(store.listAccounts(state.config.students).every((account) => !account.enabled));
	await assert.rejects(service.previewTask({ accountId: "alpha", date: courseDate, courseSchedId: course.id }), { code: "ACCOUNT_DISABLED" });
	await service.setAccountEnabled("alpha", true);
	await service.tick("live");
	assert.equal(store.listTasks().length, 0);
	assert.equal(state.loginCalls, 0);
	const task = await schedule();
	await service.tick("live");
	assert.equal(state.signCalls.length, 0, "Never execute early");
	state.now = task.scheduledAt;
	await service.tick("live");
	assert.equal(state.signCalls.length, 1);
	assert.equal(state.signCalls[0].timestamp, task.scheduledAt - 3000);
	assert.equal(store.getTask(task.id).status, "succeeded");
	assert.ok(state.queriedDates.every((date) => date === "20260915"));
	state.now += 24 * 60 * 60_000;
	await service.tick("live");
	assert.equal(state.signCalls.length, 1, "Never recur the following day");
	const serialized = JSON.stringify(store.listTasks());
	for (const secret of ["studentIdentity", "leaseToken", "202600000000001", "never-log-this-session", state.config.studentPassword]) {
		assert.ok(!serialized.includes(secret));
	}
});

test("create validates actual schedule, rejects manual IDs and requires reconfirmation when time changes", async (context) => {
	const { service, state } = createFixture(context);
	await service.setAccountEnabled("alpha", true);
	const body = { accountId: "alpha", date: courseDate, courseSchedId: course.id };
	for (const invalid of [
		{ ...body, accountId: undefined, studentId: "202600000000001" },
		{ ...body, courseSchedId: "A".repeat(32) },
		{ ...body, courseSchedId: "7654321" },
	]) await assert.rejects(service.previewTask(invalid));
	const preview = await service.previewTask(body);
	await assert.rejects(service.createTask({ ...body, scheduledAt: 0 }), { code: "RECONFIRM_REQUIRED" });
	state.courses[0].classBeginTime = "09:30";
	await assert.rejects(service.createTask({ ...body, expectedClassBeginAt: preview.classBeginAt, expectedClassEndAt: preview.classEndAt }), { code: "RECONFIRM_REQUIRED" });
	state.courses[0].signStatus = "1";
	await assert.rejects(service.previewTask(body), { code: "ALREADY_SIGNED" });
	state.courses[0].signStatus = "unexpected";
	await assert.rejects(service.previewTask(body), { code: "UNKNOWN_SIGN_STATUS" });
	state.courses[0] = structuredClone(course);
	state.now = preview.scheduledAt;
	await assert.rejects(service.previewTask(body), { code: "PLANNED_TIME_PASSED" });
});

test("duplicate creation and duplicate aliases cannot produce another active task", async (context) => {
	const { store, schedule } = createFixture(context);
	const [first, second] = await Promise.all([schedule(), schedule()]);
	assert.equal(first.id, second.id);
	assert.equal(store.listTasks().length, 1);
	await assert.rejects(schedule("duplicate"), { code: "DUPLICATE_ACCOUNT_TASK" });
	await schedule("beta");
	assert.equal(store.listTasks().length, 2, "Independent students are not deduplicated together");
});

test("cancellation and disabling revoke prepared work; re-enable never resurrects it", async (context) => {
	const { store, state, service, schedule, dependencies } = createFixture(context);
	const cancelled = await schedule();
	store.cancelTask(cancelled.id, state.now);
	const disabled = await schedule();
	await service.setAccountEnabled("alpha", false);
	await service.setAccountEnabled("alpha", true);
	assert.equal(store.getTask(disabled.id).status, "cancelled");
	const prepared = await schedule();
	dependencies.getTimestamp = async () => {
		store.cancelTask(prepared.id, state.now);
		return state.now;
	};
	state.now = prepared.scheduledAt;
	await service.tick("live");
	assert.equal(state.signCalls.length, 0);
	assert.equal(store.getTask(prepared.id).status, "cancelled");
});

test("deleting terminal cards preserves results and is idempotent; cancellation still permits a new confirmation", async (context) => {
	for (const status of ["cancelled", "paused", "expired", "dry_run", "failed"]) {
		const { store, state, schedule, service } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		if (status === "cancelled") store.cancelTask(task.id, state.now);
		else store.finishTask(store.claimNextTask(state.now), status, "SYNTHETIC_RESULT", state.now);
		const resultBeforeDeletion = store.getTask(task.id);
		store.deleteTask(task.id, state.now + 1);
		store.deleteTask(task.id, state.now + 2);
		assert.deepEqual(store.listTasks(), []);
		assert.deepEqual({ ...store.getTask(task.id) }, { ...resultBeforeDeletion, deletedAt: state.now + 1 });
		await service.tick("live");
		assert.equal(state.signCalls.length, 0);
		state.now = task.scheduledAt - 1;
		const replacement = await schedule();
		assert.notEqual(replacement.id, task.id);
		assert.equal(store.listTasks().length, 1);
		assert.equal("deletedAt" in store.listTasks()[0], false, "Internal deletion state is not exposed");
	}
});

test("pending, preparing, retrying, submitting and uncertain tasks cannot be hidden", async (context) => {
	for (const status of ["pending", "preparing", "retry_wait", "submitting", "uncertain"]) {
		const { store, state, schedule } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		if (status !== "pending") {
			const claimedTask = store.claimNextTask(state.now);
			if (status === "submitting" || status === "uncertain") store.markSubmitting(claimedTask, state.now);
			if (status === "retry_wait" || status === "uncertain") store.finishTask(claimedTask, status, "SYNTHETIC_RESULT", state.now);
		}
		assert.equal(store.getTask(task.id).status, status);
		const beforeDeletion = store.listTasks();
		assert.throws(() => store.deleteTask(task.id, state.now), { code: "TASK_NOT_DELETABLE", status: 409 });
		assert.deepEqual(store.listTasks(), beforeDeletion);
		assert.equal(store.getTask(task.id).deletedAt, null);
		assert.throws(() => store.deleteTask("missing-task", state.now), { code: "TASK_NOT_FOUND", status: 404 });
	}
});

for (const completedStatus of ["succeeded", "skipped"]) {
	test(`deleting ${completedStatus} never allows the same occurrence or alias to submit again`, async (context) => {
		const { store, state, schedule, service } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		if (completedStatus === "skipped") state.courses[0].signStatus = "1";
		await service.tick("live");
		assert.equal(store.getTask(task.id).status, completedStatus);
		const previousSignCalls = state.signCalls.length;
		store.deleteTask(task.id, state.now);
		assert.deepEqual(store.listTasks(), []);
		assert.equal(store.getTask(task.id).status, completedStatus);
		// Even a backwards clock and stale unsigned timetable cannot defeat the retained occurrence guard.
		state.now = task.scheduledAt - 1;
		state.courses[0].signStatus = "0";
		await assert.rejects(schedule(), { code: "TASK_ALREADY_COMPLETED" });
		await assert.rejects(schedule("duplicate"), { code: "DUPLICATE_ACCOUNT_TASK" });
		state.now = task.scheduledAt;
		await service.tick("live");
		assert.equal(state.signCalls.length, previousSignCalls);
		assert.deepEqual(store.listTasks(), []);
	});
}

test("version-one database upgrades preserve existing data and deleted cards remain hidden across restarts", async (context) => {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-deletion-migration-"));
	context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const databasePath = path.join(temporaryDirectory, "tasks.sqlite");
	const initialStore = new AutoSignStore(databasePath);
	const account = { id: "alpha", name: "alpha", studentId: "202600000000001" };
	const studentIdentity = getStudentIdentity(account.studentId);
	const now = occurrence.scheduledAt - 60_000;
	let task;
	let originalTask;
	try {
		initialStore.synchronizeAccounts([account], now);
		initialStore.setAccountEnabled(account.id, studentIdentity, true, now);
		task = initialStore.createTask({ ...occurrence, accountId: account.id, accountName: account.name,
			courseDate, courseSchedId: course.id, courseName: course.courseName }, studentIdentity, now, "live");
		initialStore.cancelTask(task.id, now);
		originalTask = initialStore.listTasks()[0];
	} finally {
		initialStore.close();
	}
	const legacyDatabase = new DatabaseSync(databasePath);
	try {
		legacyDatabase.exec("ALTER TABLE tasks DROP COLUMN deletedAt; PRAGMA user_version = 1;");
	} finally {
		legacyDatabase.close();
	}
	const upgradedStore = new AutoSignStore(databasePath);
	try {
		assert.deepEqual(upgradedStore.listTasks(), [originalTask]);
		assert.equal(upgradedStore.isAccountEnabled(account.id, studentIdentity), true);
		upgradedStore.deleteTask(task.id, now + 1);
	} finally {
		upgradedStore.close();
	}
	const reopenedStore = new AutoSignStore(databasePath);
	try {
		assert.deepEqual(reopenedStore.listTasks(), []);
		assert.equal(reopenedStore.getTask(task.id).status, "cancelled");
		assert.equal(reopenedStore.getTask(task.id).deletedAt, now + 1);
		assert.equal(reopenedStore.isAccountEnabled(account.id, studentIdentity), true);
		reopenedStore.deleteTask(task.id, now + 2);
		const inspection = new DatabaseSync(databasePath, { readOnly: true });
		try {
			assert.equal(inspection.prepare("PRAGMA user_version").get().user_version, 2);
			assert.equal(inspection.prepare("SELECT COUNT(*) AS total FROM events WHERE taskId = ?").get(task.id).total, originalTask.events.length + 1);
			assert.equal(inspection.prepare("SELECT COUNT(*) AS total FROM events WHERE taskId = ? AND code = 'RECORD_DELETED'").get(task.id).total, 1);
		} finally {
			inspection.close();
		}
	} finally {
		reopenedStore.close();
	}
});

for (const change of ["removed-account", "replaced-account", "disabled-during-preparation", "changed-course", "missing-course", "already-signed", "unknown-status", "deadline", "clock-skew"]) {
	test(`execution revalidation handles ${change} without submitting`, async (context) => {
		const { store, state, service, schedule, dependencies } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		let expectedStatus = "paused";
		if (change === "removed-account") state.config.students = [];
		if (change === "replaced-account") state.config.students[0].studentId = "202600000000099";
		if (change === "disabled-during-preparation") {
			dependencies.getTimestamp = async () => { await service.setAccountEnabled("alpha", false); return state.now; };
			expectedStatus = "cancelled";
		}
		if (change === "changed-course") state.courses[0].classBeginTime = "09:30";
		if (change === "missing-course") state.courses = [];
		if (change === "already-signed") { state.courses[0].signStatus = "1"; expectedStatus = "skipped"; }
		if (change === "unknown-status") state.courses[0].signStatus = "other";
		if (change === "deadline") {
			dependencies.getTimestamp = async () => { state.now = task.deadlineAt; return state.now; };
			expectedStatus = "expired";
		}
		if (change === "clock-skew") dependencies.getTimestamp = async () => state.now - 60_000;
		await service.tick("live");
		assert.equal(state.signCalls.length, 0);
		assert.equal(store.getTask(task.id).status, expectedStatus);
	});
}

test("multiple database connections atomically claim work and survive restart", async (context) => {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-task-test-"));
	context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
	const databasePath = path.join(temporaryDirectory, "tasks.sqlite");
	const { store, state, schedule } = createFixture(context, databasePath);
	const task = await schedule();
	const otherStore = new AutoSignStore(databasePath);
	context.after(() => otherStore.close());
	state.now = task.scheduledAt;
	const firstClaim = store.claimNextTask(state.now);
	assert.equal(firstClaim.id, task.id);
	assert.equal(otherStore.claimNextTask(state.now), null);
	otherStore.recoverTasks(state.now + TASK_LEASE_MS);
	const recovered = otherStore.claimNextTask(state.now + TASK_LEASE_MS);
	assert.equal(recovered.id, task.id);
	assert.equal(store.markSubmitting(firstClaim, state.now + TASK_LEASE_MS), false, "Old lease cannot submit");
	assert.equal(otherStore.markSubmitting(recovered, state.now + TASK_LEASE_MS), true);
	store.recoverTasks(state.now + 2 * TASK_LEASE_MS);
	assert.equal(store.getTask(task.id).status, "uncertain", "A lost submitting worker is never returned to the send queue");
	assert.equal(store.claimNextTask(state.now + 2 * TASK_LEASE_MS), null);
});

test("concurrent tick requests serialize and do not submit twice", async (context) => {
	const { state, service, schedule, dependencies } = createFixture(context);
	const task = await schedule();
	state.now = task.scheduledAt;
	const originalLogin = dependencies.login;
	let releaseLogin;
	const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
	dependencies.login = async (...argumentsList) => { await loginGate; return originalLogin(...argumentsList); };
	const firstTick = service.tick("live");
	const secondTick = await service.tick("live");
	assert.equal(secondTick.busy, true);
	releaseLogin();
	await firstTick;
	await service.tick("live");
	assert.equal(state.signCalls.length, 1);
});

test("a fresh dispatcher recovers crashed preparation before the execution window expires", async (context) => {
	const { store, state, service, schedule } = createFixture(context);
	const task = await schedule();
	state.now = task.scheduledAt;
	const abandonedTick = store.startTick(state.now);
	assert.ok(abandonedTick);
	assert.equal(store.claimNextTask(state.now).id, task.id);
	state.now += 30_000;
	assert.equal((await service.tick("live")).busy, true);
	state.now = task.scheduledAt + Math.max(TASK_LEASE_MS, DISPATCHER_LEASE_MS);
	assert.ok(state.now < task.deadlineAt);
	await service.tick("live");
	assert.equal(store.getTask(task.id).status, "succeeded");
	assert.equal(state.signCalls.length, 1);
	assert.equal(store.renewTick(abandonedTick, state.now), false, "Stale dispatcher cannot renew a newer lease");
});

test("preparation retries up to 8 times with 30s capped backoff while bad credentials never retry", async (context) => {
	assert.equal(MAX_PREPARATION_ATTEMPTS, 8);
	const { store, state, service, schedule, dependencies } = createFixture(context);
	const task = await schedule();
	state.now = task.scheduledAt;
	dependencies.login = async () => { throw new IclassError(504, "UPSTREAM_LOGIN_TIMEOUT", "safe", "login", true); };
	for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt += 1) {
		await service.tick("live");
		const current = store.getTask(task.id);
		if (attempt < MAX_PREPARATION_ATTEMPTS - 1) {
			assert.equal(current.status, "retry_wait");
			assert.ok(current.nextAttemptAt - state.now <= 30_000, "Retry backoff is capped at 30 seconds");
		}
		state.now += 30_000;
	}
	assert.equal(store.getTask(task.id).status, "failed");
	assert.equal(store.getTask(task.id).attempts, MAX_PREPARATION_ATTEMPTS);
	assert.equal(state.signCalls.length, 0);
	const secondFixture = createFixture(context);
	const secondTask = await secondFixture.schedule();
	secondFixture.state.now = secondTask.scheduledAt;
	secondFixture.dependencies.login = async () => { throw new IclassError(401, "UPSTREAM_LOGIN_REJECTED", "safe", "login", false); };
	await secondFixture.service.tick("live");
	assert.equal(secondFixture.store.getTask(secondTask.id).status, "failed");
	assert.equal(secondFixture.store.getTask(secondTask.id).attempts, 1);
});

test("transient 2-minute upstream login outage (3+ timeouts) recovers and signs in before class", async (context) => {
	const { store, state, service, schedule, dependencies } = createFixture(context);
	dependencies.getScheduleOffsetSeconds = () => 71; // e.g. 08:21:11 like Nov 26 hxy
	const task = await schedule();
	const realLogin = dependencies.login;
	const outageUntil = task.scheduledAt + 119_000; // ~2 minutes of login timeouts
	dependencies.login = async (username, password) => {
		if (state.now < outageUntil) {
			state.now += 10_000;
			throw new IclassError(504, "UPSTREAM_LOGIN_TIMEOUT", "Synthetic timeout", "login", true);
		}
		return realLogin(username, password);
	};
	state.now = task.scheduledAt + 9_000;
	while (state.now < task.deadlineAt && store.getTask(task.id).status !== "succeeded") {
		await service.tick("live");
		state.now += 10_000;
	}
	const completed = store.getTask(task.id);
	assert.equal(completed.status, "succeeded");
	assert.ok(completed.attempts >= 4, "Recovered after surviving 3+ login timeouts");
	assert.equal(state.signCalls.length, 1);
});

test("WeCom alerts route to student wecomUserId or fallback adminUserIds for failure and success, support webhook, and never break ticks", async (context) => {
	const { store, state, service, schedule, dependencies } = createFixture(context);
	const alerts = [];
	dependencies.sendAlert = async (payload) => {
		alerts.push(payload);
		return true;
	};
	state.config.wecom = {
		enabled: true,
		corpId: "ww_synthetic_corp_01",
		agentId: "1000002",
		corpSecret: "synthetic_corp_secret_123456",
		adminUserIds: ["admin_user"],
		notifyOnSuccess: true,
		alwaysNotifyAdmin: false,
		fallbackAdminOnSuccess: false,
	};
	state.config.students[0].wecomUserId = "user_alpha"; // alpha bound; beta unbound

	// 1) Bound student receives direct personal failure alert once
	const alphaTask = await schedule("alpha", "live");
	state.now = alphaTask.scheduledAt;
	dependencies.login = async () => { throw new IclassError(401, "UPSTREAM_LOGIN_REJECTED", "safe", "login", false); };
	await service.tick("live");
	await service.tick("live");
	assert.equal(store.getTask(alphaTask.id).status, "failed");
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].channel, "app");
	assert.deepEqual(alerts[0].userIds, ["user_alpha"]);
	assert.ok(alerts[0].content.includes("⚠️ UCAS 自动签到异常提醒"));
	assert.ok(!alerts[0].content.includes("兜底推送"));
	assert.ok(store.listTasks().find((t) => t.id === alphaTask.id).events.some((e) => e.code === "NOTIFY_SENT"));

	// 2) Unbound student's deadline expiry falls back to adminUserIds
	dependencies.login = async () => ({ userId: "synthetic-user", sessionId: "never-log-this-session" });
	state.now = occurrence.scheduledAt - 60_000;
	const betaTask = await schedule("beta", "live");
	state.now = betaTask.deadlineAt;
	await service.tick("live");
	assert.equal(store.getTask(betaTask.id).status, "expired");
	assert.equal(alerts.length, 2);
	assert.deepEqual(alerts[1].userIds, ["admin_user"]);
	assert.ok(alerts[1].content.includes("兜底推送"));

	// 3) Bound student receives success push; unbound student's routine success does NOT spam admin
	state.now = Date.parse("2026-09-17T08:15:00+08:00");
	const alphaSuccess = await schedule("alpha", "live", "2026-09-17");
	const betaSuccess = await schedule("beta", "live", "2026-09-17");
	state.now = Math.max(alphaSuccess.scheduledAt, betaSuccess.scheduledAt);
	await service.tick("live");
	assert.equal(store.getTask(alphaSuccess.id).status, "succeeded");
	assert.equal(store.getTask(betaSuccess.id).status, "succeeded");
	assert.equal(alerts.length, 3);
	assert.deepEqual(alerts[2].userIds, ["user_alpha"]);
	assert.ok(alerts[2].content.includes("✅ UCAS 自动签到成功"));

	// 4) Group Bot Webhook fallback mode works when App credentials are absent
	state.config.wecom = {
		enabled: true,
		webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-key",
		notifyOnSuccess: true,
	};
	state.config.students[0].wecomMobile = "13800138000";
	state.now = Date.parse("2026-09-18T08:15:00+08:00");
	const webhookSuccess = await schedule("alpha", "live", "2026-09-18");
	state.now = webhookSuccess.scheduledAt;
	await service.tick("live");
	assert.equal(alerts.length, 4);
	assert.equal(alerts[3].channel, "webhook");
	assert.deepEqual(alerts[3].mentionedMobiles, ["13800138000"]);

	// 5) Dry-run never alerts and push failures never crash tick()
	state.now = Date.parse("2026-09-19T08:15:00+08:00");
	const dryTask = await schedule("alpha", "dry-run", "2026-09-19");
	state.now = dryTask.deadlineAt;
	dependencies.sendAlert = async () => { throw new Error("wecom network down"); };
	await service.tick("dry-run");
	assert.equal(store.getTask(dryTask.id).status, "expired");
	assert.equal(alerts.length, 4);

	// Secrets and IDs never leak in public snapshot
	const publicSerialized = JSON.stringify(store.listTasks());
	for (const secret of ["ww_synthetic_corp_01", "synthetic_corp_secret_123456", "user_alpha", "admin_user", "synthetic-key"]) {
		assert.ok(!publicSerialized.includes(secret));
	}
});

test("late restart expires tasks instead of attempting a catch-up sign", async (context) => {
	const { store, state, service, schedule } = createFixture(context);
	const task = await schedule();
	state.now = task.deadlineAt;
	await service.tick("live");
	assert.equal(store.getTask(task.id).status, "expired");
	assert.equal(state.signCalls.length, 0);
});

test("a database wait crossing the deadline cannot authorize a late sign", async (context) => {
	const { store, state, service, schedule } = createFixture(context);
	const task = await schedule();
	state.now = task.deadlineAt - 1000;
	const markSubmitting = store.markSubmitting.bind(store);
	context.mock.method(store, "markSubmitting", (...argumentsList) => {
		const claimed = markSubmitting(...argumentsList);
		state.now += 1500;
		return claimed;
	});
	await service.tick("live");
	assert.equal(state.signCalls.length, 0);
	assert.equal(store.getTask(task.id).status, "expired");
});

for (const responseLatency of [1000, 4000]) {
	test(`timestamp response latency ${responseLatency}ms is included in deadline and freshness checks`, async (context) => {
		const { store, state, service, schedule, dependencies } = createFixture(context);
		const task = await schedule();
		state.now = task.deadlineAt - 5500;
		dependencies.getTimestamp = async () => {
			const sample = state.now + 5000;
			state.now += responseLatency;
			return sample;
		};
		await service.tick("live");
		assert.equal(state.signCalls.length, 0);
		assert.notEqual(store.getTask(task.id).status, "succeeded");
	});
}

for (const upstreamStatus of ["", "0", "1"]) {
	test(`non-success response classification is conservative for STATUS=${JSON.stringify(upstreamStatus)}`, async (context) => {
		const { store, state, service, schedule, dependencies } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		dependencies.submitSign = async () => ({ success: false, upstreamStatus, result: {}, message: "raw error must not be stored", status: 400 });
		await service.tick("live");
		assert.equal(store.getTask(task.id).status, upstreamStatus === "1" ? "failed" : "uncertain");
		assert.ok(!JSON.stringify(store.listTasks()).includes("raw error"));
	});
}

for (const confirmSuccess of [false, true]) {
	test(`uncertain submission is only reconciled, confirmed=${confirmSuccess}`, async (context) => {
		const { store, state, service, schedule, dependencies } = createFixture(context);
		const task = await schedule();
		state.now = task.scheduledAt;
		dependencies.submitSign = async () => {
			state.signCalls.push("one uncertain call");
			assert.throws(() => store.cancelTask(task.id, state.now), { code: "TASK_NOT_CANCELLABLE" });
			if (confirmSuccess) state.courses[0].signStatus = "1";
			throw new Error("possible-upstream-session-do-not-log");
		};
		await service.tick("live");
		assert.equal(store.getTask(task.id).status, "uncertain");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			state.now += 60_000;
			await service.tick("live");
		}
		assert.equal(state.signCalls.length, 1);
		assert.equal(store.getTask(task.id).status, confirmSuccess ? "succeeded" : "uncertain");
		assert.ok(store.getTask(task.id).reconcileAttempts <= 3);
		assert.ok(!JSON.stringify(store.listTasks()).includes("possible-upstream-session"));
	});
}

test("dry-run never calls sign and mode changes require a new confirmation", async (context) => {
	const { store, state, service, schedule } = createFixture(context);
	const task = await schedule("alpha", "dry-run");
	state.now = task.scheduledAt;
	await service.tick("dry-run");
	assert.equal(store.getTask(task.id).status, "dry_run");
	assert.equal(state.signCalls.length, 0);
	await service.tick("live");
	assert.equal(state.signCalls.length, 0);
	const secondFixture = createFixture(context);
	const secondTask = await secondFixture.schedule("alpha", "dry-run");
	secondFixture.state.now = secondTask.scheduledAt;
	await secondFixture.service.tick("live");
	assert.equal(secondFixture.store.getTask(secondTask.id).status, "paused");
	assert.equal(secondFixture.store.getTask(secondTask.id).resultCode, "EXECUTION_MODE_CHANGED");
	assert.equal(secondFixture.state.signCalls.length, 0);
});

test("machine credential fails closed, rejects browser tokens, and requires restrictive permissions", async () => {
	const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ucas-key-test-"));
	const originalPath = process.env.UCAS_AUTO_SIGN_KEY_FILE;
	try {
		const key = "a".repeat(64);
		const keyPath = path.join(temporaryDirectory, "machine.key");
		process.env.UCAS_AUTO_SIGN_KEY_FILE = keyPath;
		await assert.rejects(verifyMachineCredential(`Bearer ${key}`));
		await writeFile(keyPath, key, { mode: 0o600 });
		assert.equal(await verifyMachineCredential(null), false);
		assert.equal(await verifyMachineCredential(`Bearer ${"b".repeat(64)}`), false);
		assert.equal(await verifyMachineCredential(`ucas-access=${key}`), false);
		assert.equal(await verifyMachineCredential(`Bearer ${key}`), true);
		await chmod(keyPath, 0o644);
		await assert.rejects(verifyMachineCredential(`Bearer ${key}`));
		assert.notEqual(getStudentIdentity("202600000000001"), getStudentIdentity("202600000000002"));
	} finally {
		if (originalPath === undefined) delete process.env.UCAS_AUTO_SIGN_KEY_FILE;
		else process.env.UCAS_AUTO_SIGN_KEY_FILE = originalPath;
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
});

test("WeCom WXBizMsgCrypt URL verification validates SHA1, 32-byte PKCS#7 padding, and corpId", () => {
	const token = "TestToken123";
	const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
	const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
	const corpId = "ww1234567890abcdef";
	for (const message of ["echostr-short", "echostr-medium-length-25b", "echostr-longer-than-thirty-two-bytes-12345"]) {
		const msgBuf = Buffer.from(message, "utf8");
		const corpBuf = Buffer.from(corpId, "utf8");
		const lenBuf = Buffer.alloc(4);
		lenBuf.writeUInt32BE(msgBuf.length, 0);
		const raw = Buffer.concat([randomBytes(16), lenBuf, msgBuf, corpBuf]);
		const padLen = 32 - (raw.length % 32 || 0);
		const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
		const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
		cipher.setAutoPadding(false);
		const echostr = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
		const timestamp = "1795694864";
		const nonce = "987654321";
		const msgSignature = createHash("sha1").update([token, timestamp, nonce, echostr].sort().join(""), "utf8").digest("hex");
		assert.equal(verifyWeComCallbackUrl({ token, encodingAesKey, corpId, msgSignature, timestamp, nonce, echostr }), message);
		assert.equal(verifyWeComCallbackUrl({ token, encodingAesKey, corpId: "ww_wrong", msgSignature, timestamp, nonce, echostr }), null);
		assert.equal(verifyWeComCallbackUrl({ token, encodingAesKey, corpId, msgSignature: "0".repeat(40), timestamp, nonce, echostr }), null);
	}
});


function encryptWeComTestPayload(plainText, corpId, token, encodingAesKey, timestamp = "1795694864", nonce = "987654321") {
	const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
	const msgBuf = Buffer.from(plainText, "utf8");
	const corpBuf = Buffer.from(corpId, "utf8");
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(msgBuf.length, 0);
	const raw = Buffer.concat([randomBytes(16), lenBuf, msgBuf, corpBuf]);
	const padLen = 32 - (raw.length % 32 || 0);
	const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
	const cipher = createCipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
	cipher.setAutoPadding(false);
	const cipherText = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
	const msgSignature = createHash("sha1").update([token, timestamp, nonce, cipherText].sort().join(""), "utf8").digest("hex");
	return { cipherText, msgSignature, timestamp, nonce };
}

test("parseWeComCallbackMessage decrypts inbound XML, validates agentId/corpId, and truncateWeComText respects byte cap", () => {
	const token = "BotCallbackToken1";
	const encodingAesKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
	const corpId = "ww1234567890abcdef";
	const innerXml = `<xml>
		<ToUserName><![CDATA[${corpId}]]></ToUserName>
		<FromUserName><![CDATA[user_alpha]]></FromUserName>
		<CreateTime>1795695000</CreateTime>
		<MsgType><![CDATA[text]]></MsgType>
		<Content><![CDATA[/a 1 +1]]></Content>
		<MsgId>998877665544</MsgId>
		<AgentID>1000002</AgentID>
	</xml>`;
	const { cipherText, msgSignature, timestamp, nonce } = encryptWeComTestPayload(innerXml, corpId, token, encodingAesKey);
	const outerXml = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><AgentID><![CDATA[1000002]]></AgentID><Encrypt><![CDATA[${cipherText}]]></Encrypt></xml>`;

	const parsed = parseWeComCallbackMessage({
		token, encodingAesKey, corpId, expectedAgentId: 1000002,
		msgSignature, timestamp, nonce, rawBody: outerXml,
	});
	assert.equal(parsed?.fromUser, "user_alpha");
	assert.equal(parsed?.msgType, "text");
	assert.equal(parsed?.content, "/a 1 +1");
	assert.equal(parsed?.msgId, "998877665544");

	assert.equal(parseWeComCallbackMessage({
		token, encodingAesKey, corpId, expectedAgentId: 9999999,
		msgSignature, timestamp, nonce, rawBody: outerXml,
	}), null);
	assert.equal(parseWeComCallbackMessage({
		token, encodingAesKey, corpId: "ww_other", expectedAgentId: 1000002,
		msgSignature, timestamp, nonce, rawBody: outerXml,
	}), null);

	const longChinese = "课程名称测试".repeat(300);
	const truncated = truncateWeComText(longChinese, 600);
	assert.ok(Buffer.byteLength(truncated, "utf8") <= 600);
	assert.match(truncated, /内容过长已截断/);
});

test("WeComBotService enforces per-student isolation, auto-enables on /auto, supports /sign, /cancel, admin overrides, and MsgId dedupe", async (context) => {
	const store = new AutoSignStore(":memory:");
	context.after(() => store.close());
	const baseNow = Date.parse("2026-09-15T07:30:00+08:00");
	assert.equal(parseBotDateToken("今天", baseNow), "2026-09-15");
	assert.equal(parseBotDateToken("+1", baseNow), "2026-09-16");
	assert.equal(parseBotDateToken("明天", baseNow), "2026-09-16");
	assert.equal(parseBotDateToken("09-20", baseNow), "2026-09-20");

	const botReplies = [];
	const signCalls = [];
	let loginCount = 0;
	const botConfig = {
		access: { passwordHash: "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128), sessionSecret: "c".repeat(64), secureCookies: true },
		studentPassword: "synthetic-student-password",
		wecom: {
			enabled: true,
			corpId: "ww_synthetic_corp_01",
			agentId: 1000002,
			corpSecret: "synthetic_corp_secret_123456",
			adminUserIds: ["admin_only"],
		},
		students: [
			{ id: "alpha", name: "alpha", studentId: "202600000000001", wecomUserId: "wx_alpha" },
			{ id: "beta", name: "beta", studentId: "202600000000002", wecomUserId: "wx_beta" },
		],
	};

	const scheduleByStudent = {
		"202600000000001": [
			{ id: "2222222", uuid: "B".repeat(32), courseName: "下午协议课", teacherName: "李老师", weekDay: "2", classBeginTime: "13:30", classEndTime: "15:10", signStatus: "0" },
			{ id: "1111111", uuid: "A".repeat(32), courseName: "上午安全课", teacherName: "张老师", weekDay: "2", classBeginTime: "08:30", classEndTime: "10:10", signStatus: "0" },
		],
		"202600000000002": [
			{ id: "3333333", uuid: "C".repeat(32), courseName: "密码学", teacherName: "王老师", weekDay: "3", classBeginTime: "10:30", classEndTime: "12:10", signStatus: "0" },
		],
	};

	const bot = new WeComBotService({
		now: () => baseNow,
		readConfig: async () => botConfig,
		getStore: () => store,
		getMode: () => "live",
		getScheduleOffsetSeconds: calculateScheduleOffsetSeconds,
		login: async (studentId) => {
			loginCount += 1;
			return { userId: studentId, sessionId: `sess-${studentId}` };
		},
		querySchedule: async (session) => structuredClone(scheduleByStudent[session.userId] ?? []),
		getTimestamp: async () => baseNow,
		submitSign: async (session, courseSchedId, ts) => {
			signCalls.push({ userId: session.userId, courseSchedId, ts });
			return { success: true, message: "签到成功", upstreamStatus: "0", result: { stuSignId: "s1", stuSignStatus: "1" }, status: 200 };
		},
		sendReply: async (payload) => {
			botReplies.push(payload);
			return true;
		},
	});

	// 1. Casual non-command text is ignored silently.
	const ignored = await bot.processInboundMessage(botConfig, {
		toUser: "ww", fromUser: "wx_alpha", createTime: "1", msgType: "text", content: "收到谢谢", msgId: "m-ignore", agentId: "1000002", event: "",
	});
	assert.equal(ignored.status, "ignored");
	assert.equal(botReplies.length, 0);

	// 2. Unbound WeCom member gets their UserID hint without hitting upstream login.
	const unboundRes = await bot.processInboundMessage(botConfig, {
		toUser: "ww", fromUser: "stranger_user", createTime: "2", msgType: "text", content: "/c", msgId: "m-unbound", agentId: "1000002", event: "",
	});
	assert.equal(unboundRes.status, "replied");
	assert.match(unboundRes.reply, /尚未绑定学号/);
	assert.match(unboundRes.reply, /stranger_user/);
	assert.equal(loginCount, 0);

	// 3. Full-width slash ／c works for bound student and sorts chronologically ([1] 08:30, [2] 13:30).
	const coursesRes = await bot.processInboundMessage(botConfig, {
		toUser: "ww", fromUser: "wx_alpha", createTime: "3", msgType: "text", content: "／c", msgId: "m-c1", agentId: "1000002", event: "",
	});
	assert.equal(coursesRes.status, "replied");
	assert.match(coursesRes.reply, /\[1\] 08:30-10:10 上午安全课/);
	assert.match(coursesRes.reply, /\[2\] 13:30-15:10 下午协议课/);

	// 4. Duplicate MsgId retry from WeCom is deduplicated without calling upstream again.
	const loginsBeforeRetry = loginCount;
	const dupRes = await bot.processInboundMessage(botConfig, {
		toUser: "ww", fromUser: "wx_alpha", createTime: "3", msgType: "text", content: "／c", msgId: "m-c1", agentId: "1000002", event: "",
	});
	assert.equal(dupRes.status, "duplicate");
	assert.equal(loginCount, loginsBeforeRetry);

	// 5. Non-admin student CANNOT query or operate another student's alias.
	for (const forbiddenCmd of ["/c beta", "/a beta 1", "/s beta 1", "/t beta", "/off beta"]) {
		const reply = await bot.executeSlashCommand(botConfig, "wx_alpha", forbiddenCmd);
		assert.match(reply, /权限不足/);
	}

	// 6. /a 1 automatically enables disabled account switch and schedules course [1] (上午安全课).
	const alphaIdentity = getStudentIdentity("202600000000001");
	store.synchronizeAccounts(botConfig.students, baseNow);
	assert.equal(store.isAccountEnabled("alpha", alphaIdentity), false);
	const autoReply = await bot.executeSlashCommand(botConfig, "wx_alpha", "/a 1");
	assert.equal(store.isAccountEnabled("alpha", alphaIdentity), true);
	assert.match(autoReply, /已自动开启「alpha」的自动签到总开关/);
	assert.match(autoReply, /\[1\] 上午安全课（08:30-10:10）：✅ 已预约/);

	// 7. /s 1 submits manual sign and auto-cancels the pending auto-sign task for that course.
	const signReply = await bot.executeSlashCommand(botConfig, "wx_alpha", "/s 1");
	assert.equal(signCalls.length, 1);
	assert.equal(signCalls[0].courseSchedId, "1111111");
	assert.match(signReply, /签到成功（已同步取消原自动签到预约）/);
	assert.equal(store.listTasks().find((t) => t.courseSchedId === "1111111")?.status, "cancelled");

	// 8. Schedule course [2], view via /t, cancel via /cancel 1, and disable switch via /off.
	await bot.executeSlashCommand(botConfig, "wx_alpha", "/a 2");
	const tasksReply = await bot.executeSlashCommand(botConfig, "wx_alpha", "/t");
	assert.match(tasksReply, /\[1\] 09-15 13:30 下午协议课/);
	const cancelReply = await bot.executeSlashCommand(botConfig, "wx_alpha", "/cancel 1");
	assert.match(cancelReply, /已取消自动签到任务/);
	const offReply = await bot.executeSlashCommand(botConfig, "wx_alpha", "/off");
	assert.match(offReply, /已关闭账号「alpha」的自动签到总开关/);
	assert.equal(store.isAccountEnabled("alpha", alphaIdentity), false);

	// 9. Admin without personal student binding can operate any student by alias, and bulk /cancel all is guarded.
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/c"), /未绑定个人学号/);
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/c beta +1"), /密码学/);
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/a beta all +1"), /已预约/);
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/a alpha 2"), /已预约/);
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/cancel all"), /管理员批量取消请指定账号/);
	assert.match(await bot.executeSlashCommand(botConfig, "admin_only", "/cancel beta all"), /已取消 1 条/);
});
