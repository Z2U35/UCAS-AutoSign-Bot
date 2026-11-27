import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { StudentAccount } from "../private-config.ts";
import { AUTO_SIGN_RECORD_LIMIT, AutoSignError, canDeleteAutoSignTask, type AutoSignMode, type AutoSignPreview, type AutoSignTask, type SchedulerHeartbeat, type TaskEvent, type TaskStatus } from "./types.ts";

const CANCELLABLE_STATES = "'pending', 'retry_wait', 'preparing'";
const DEDUPLICATED_STATES = `${CANCELLABLE_STATES}, 'submitting', 'uncertain', 'succeeded', 'skipped'`;
const RECENT_TASK_ORDER = "updatedAt DESC, createdAt DESC, rowid DESC";
export const TASK_LEASE_MS = 60_000;
export const DISPATCHER_LEASE_MS = 60_000;
export const MAX_PREPARATION_ATTEMPTS = 8;
export const MAX_RECONCILIATION_ATTEMPTS = 3;

type AccountSetting = { accountId: string; studentIdentity: string; enabled: number };

export type TaskRecord = Omit<AutoSignTask, "events"> & {
	studentIdentity: string;
	nextAttemptAt: number;
	reconcileAttempts: number;
	leaseToken: string | null;
	leaseUntil: number | null;
	deletedAt: number | null;
};

export function getStudentIdentity(studentId: string): string {
	return createHash("sha256").update(`ucas-student:${studentId}`).digest("hex");
}

export class AutoSignStore {
	private database: DatabaseSync;

	constructor(databasePath: string) {
		this.database = new DatabaseSync(databasePath);
		if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
		this.database.exec("PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		this.transaction(() => {
			const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
			if (version.user_version > 2) throw new AutoSignError("DATABASE_VERSION_UNSUPPORTED", 503);
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS account_settings (
					accountId TEXT PRIMARY KEY, studentIdentity TEXT NOT NULL,
					enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)), updatedAt INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS tasks (
					id TEXT PRIMARY KEY, accountId TEXT NOT NULL, accountName TEXT NOT NULL,
					studentIdentity TEXT NOT NULL, courseDate TEXT NOT NULL, courseSchedId TEXT NOT NULL,
					courseName TEXT NOT NULL, classBeginAt INTEGER NOT NULL, classEndAt INTEGER NOT NULL,
					scheduledAt INTEGER NOT NULL, deadlineAt INTEGER NOT NULL, status TEXT NOT NULL,
					attempts INTEGER NOT NULL DEFAULT 0, reconcileAttempts INTEGER NOT NULL DEFAULT 0,
					nextAttemptAt INTEGER NOT NULL, leaseToken TEXT, leaseUntil INTEGER,
					resultCode TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
					executionMode TEXT NOT NULL CHECK(executionMode IN ('dry-run', 'live'))
				);
				CREATE UNIQUE INDEX IF NOT EXISTS unique_active_occurrence
					ON tasks(studentIdentity, courseDate, courseSchedId) WHERE status IN (${DEDUPLICATED_STATES});
				CREATE INDEX IF NOT EXISTS due_tasks ON tasks(status, nextAttemptAt);
				CREATE TABLE IF NOT EXISTS events (
					id INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
					createdAt INTEGER NOT NULL, stage TEXT NOT NULL, code TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS task_events ON events(taskId, id);
				CREATE TABLE IF NOT EXISTS dispatcher (
					id INTEGER PRIMARY KEY CHECK(id = 1), leaseToken TEXT, leaseUntil INTEGER,
					lastStartedAt INTEGER, lastFinishedAt INTEGER, lastErrorCode TEXT NOT NULL DEFAULT ''
				);
				INSERT OR IGNORE INTO dispatcher(id) VALUES(1);
			`);
			if (version.user_version < 2) {
				this.database.exec("ALTER TABLE tasks ADD COLUMN deletedAt INTEGER; PRAGMA user_version = 2;");
			}
		});
		try {
			this.transaction(() => this.pruneTaskRecords());
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	close(): void {
		this.database.close();
	}

	private transaction<Result>(operation: () => Result): Result {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	private addEvent(taskId: string, now: number, stage: string, code: string): void {
		this.database.prepare("INSERT INTO events(taskId, createdAt, stage, code) VALUES(?, ?, ?, ?)")
			.run(taskId, now, stage, code);
	}

	private pruneTaskRecords(newTaskId?: string): void {
		const overflowTasks = this.database.prepare(`SELECT id, status FROM tasks
			ORDER BY ${RECENT_TASK_ORDER} LIMIT -1 OFFSET ?`)
			.all(AUTO_SIGN_RECORD_LIMIT) as Pick<TaskRecord, "id" | "status">[];
		// Roll back new work rather than discard evidence of an in-flight submission.
		if (overflowTasks.some((task) => task.status === "submitting")) {
			throw new AutoSignError("TASK_RETENTION_BUSY", 409);
		}
		if (overflowTasks.some((task) => task.id === newTaskId)) {
			throw new AutoSignError("CLOCK_SKEW", 409);
		}
		const deleteEvents = this.database.prepare("DELETE FROM events WHERE taskId = ?");
		const deleteTask = this.database.prepare("DELETE FROM tasks WHERE id = ?");
		for (const task of overflowTasks) {
			deleteEvents.run(task.id);
			deleteTask.run(task.id);
		}
	}

	private invalidateAccount(accountId: string, now: number, status: TaskStatus, code: string): void {
		const tasks = this.database.prepare(`SELECT id FROM tasks WHERE accountId = ? AND status IN (${CANCELLABLE_STATES})`)
			.all(accountId) as { id: string }[];
		this.database.prepare(`UPDATE tasks SET status = ?, resultCode = ?, updatedAt = ?, leaseToken = NULL,
			leaseUntil = NULL WHERE accountId = ? AND status IN (${CANCELLABLE_STATES})`).run(status, code, now, accountId);
		for (const task of tasks) this.addEvent(task.id, now, "authorization", code);
	}

	synchronizeAccounts(accounts: StudentAccount[], now: number): void {
		this.transaction(() => {
			const configuredAccounts = new Map(accounts.map((account) => [account.id, account]));
			const settings = this.database.prepare("SELECT * FROM account_settings").all() as AccountSetting[];
			for (const setting of settings) {
				const account = configuredAccounts.get(setting.accountId);
				if (!account || getStudentIdentity(account.studentId) !== setting.studentIdentity) {
					this.invalidateAccount(setting.accountId, now, "paused", "ACCOUNT_CHANGED");
					this.database.prepare("DELETE FROM account_settings WHERE accountId = ?").run(setting.accountId);
				}
			}
			for (const account of accounts) {
				this.database.prepare("INSERT OR IGNORE INTO account_settings(accountId, studentIdentity, updatedAt) VALUES(?, ?, ?)")
					.run(account.id, getStudentIdentity(account.studentId), now);
			}
		});
	}

	listAccounts(accounts: StudentAccount[]) {
		return accounts.map((account) => ({ accountId: account.id, name: account.name,
			enabled: this.isAccountEnabled(account.id, getStudentIdentity(account.studentId)) }));
	}

	isAccountEnabled(accountId: string, studentIdentity: string): boolean {
		return Boolean(this.database.prepare("SELECT 1 FROM account_settings WHERE accountId = ? AND studentIdentity = ? AND enabled = 1")
			.get(accountId, studentIdentity));
	}

	setAccountEnabled(accountId: string, studentIdentity: string, enabled: boolean, now: number): void {
		this.transaction(() => {
			const update = this.database.prepare("UPDATE account_settings SET enabled = ?, updatedAt = ? WHERE accountId = ? AND studentIdentity = ?")
				.run(Number(enabled), now, accountId, studentIdentity);
			if (!update.changes) throw new AutoSignError("ACCOUNT_CHANGED", 409);
			if (!enabled) this.invalidateAccount(accountId, now, "cancelled", "ACCOUNT_DISABLED");
		});
	}

	createTask(preview: AutoSignPreview, studentIdentity: string, now: number, mode: AutoSignMode = "dry-run"): AutoSignTask {
		return this.transaction(() => {
			if (!this.isAccountEnabled(preview.accountId, studentIdentity)) throw new AutoSignError("ACCOUNT_DISABLED", 409);
			if (preview.scheduledAt <= now) throw new AutoSignError("PLANNED_TIME_PASSED", 409);
			const existing = this.getOccurrenceTask(studentIdentity, preview.courseDate, preview.courseSchedId);
			if (existing) {
				if (existing.accountId !== preview.accountId) throw new AutoSignError("DUPLICATE_ACCOUNT_TASK", 409);
				if (existing.deletedAt !== null) throw new AutoSignError("TASK_ALREADY_COMPLETED", 409);
				if (existing.classBeginAt !== preview.classBeginAt || existing.classEndAt !== preview.classEndAt || existing.executionMode !== mode) {
					throw new AutoSignError("RECONFIRM_REQUIRED", 409);
				}
				return this.toPublicTask(existing);
			}
			const taskId = randomUUID();
			this.database.prepare(`INSERT INTO tasks(id, accountId, accountName, studentIdentity, courseDate, courseSchedId,
				courseName, classBeginAt, classEndAt, scheduledAt, deadlineAt, status, nextAttemptAt, resultCode, createdAt, updatedAt, executionMode)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'SCHEDULED', ?, ?, ?)`).run(
				taskId, preview.accountId, preview.accountName, studentIdentity, preview.courseDate, preview.courseSchedId,
				preview.courseName, preview.classBeginAt, preview.classEndAt, preview.scheduledAt, preview.deadlineAt, preview.scheduledAt, now, now, mode,
			);
			this.addEvent(taskId, now, "schedule", "SCHEDULED");
			this.pruneTaskRecords(taskId);
			return this.toPublicTask(this.getTask(taskId)!);
		});
	}

	getTask(taskId: string): TaskRecord | undefined {
		return this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRecord | undefined;
	}

	getOccurrenceTask(studentIdentity: string, courseDate: string, courseSchedId: string): TaskRecord | undefined {
		return this.database.prepare(`SELECT * FROM tasks WHERE studentIdentity = ? AND courseDate = ?
			AND courseSchedId = ? AND status IN (${DEDUPLICATED_STATES})`)
			.get(studentIdentity, courseDate, courseSchedId) as TaskRecord | undefined;
	}

	private toPublicTask(task: TaskRecord): AutoSignTask {
		// Explicit projection prevents private identity bindings and leases reaching the browser.
		return {
			id: task.id, accountId: task.accountId, accountName: task.accountName, courseDate: task.courseDate,
			courseSchedId: task.courseSchedId, courseName: task.courseName, classBeginAt: task.classBeginAt,
			classEndAt: task.classEndAt, scheduledAt: task.scheduledAt, deadlineAt: task.deadlineAt,
			status: task.status, attempts: task.attempts, resultCode: task.resultCode,
			executionMode: task.executionMode,
			createdAt: task.createdAt, updatedAt: task.updatedAt,
			events: this.database.prepare("SELECT id, createdAt, stage, code FROM events WHERE taskId = ? ORDER BY id DESC LIMIT 12")
				.all(task.id) as TaskEvent[],
		};
	}

	listTasks(): AutoSignTask[] {
		const tasks = this.database.prepare(`SELECT * FROM tasks WHERE deletedAt IS NULL
			ORDER BY ${RECENT_TASK_ORDER} LIMIT ?`)
			.all(AUTO_SIGN_RECORD_LIMIT) as TaskRecord[];
		return tasks.map((task) => this.toPublicTask(task));
	}

	deleteTask(taskId: string, now: number): void {
		this.transaction(() => {
			const task = this.getTask(taskId);
			if (!task) throw new AutoSignError("TASK_NOT_FOUND", 404);
			if (!canDeleteAutoSignTask(task)) throw new AutoSignError("TASK_NOT_DELETABLE", 409);
			if (task.deletedAt !== null) return;
			// Hidden records retain their occurrence guard only until the shared retention cap evicts them.
			this.database.prepare("UPDATE tasks SET deletedAt = ? WHERE id = ?").run(now, taskId);
			this.addEvent(taskId, now, "delete", "RECORD_DELETED");
		});
	}

	cancelTask(taskId: string, now: number): void {
		this.transaction(() => {
			const task = this.getTask(taskId);
			if (!task) throw new AutoSignError("TASK_NOT_FOUND", 404);
			if (task.status === "cancelled") return;
			if (!["pending", "preparing", "retry_wait"].includes(task.status)) throw new AutoSignError("TASK_NOT_CANCELLABLE", 409);
			this.database.prepare("UPDATE tasks SET status = 'cancelled', resultCode = 'CANCELLED', leaseToken = NULL, leaseUntil = NULL, updatedAt = ? WHERE id = ?")
				.run(now, taskId);
			this.addEvent(taskId, now, "cancel", "CANCELLED");
		});
	}

	startTick(now: number): string | null {
		const leaseToken = randomUUID();
		const update = this.database.prepare(`UPDATE dispatcher SET leaseToken = ?, leaseUntil = ?, lastStartedAt = ?, lastErrorCode = ''
			WHERE id = 1 AND (leaseUntil IS NULL OR leaseUntil <= ?)`).run(leaseToken, now + DISPATCHER_LEASE_MS, now, now);
		return update.changes ? leaseToken : null;
	}

	renewTick(leaseToken: string, now: number): boolean {
		const update = this.database.prepare(`UPDATE dispatcher SET leaseUntil = ?
			WHERE id = 1 AND leaseToken = ? AND leaseUntil > ?`).run(now + DISPATCHER_LEASE_MS, leaseToken, now);
		return Boolean(update.changes);
	}

	finishTick(leaseToken: string, now: number, code = ""): void {
		this.database.prepare(`UPDATE dispatcher SET leaseToken = NULL, leaseUntil = NULL, lastFinishedAt = ?, lastErrorCode = ?
			WHERE id = 1 AND leaseToken = ?`).run(now, code, leaseToken);
	}

	getHeartbeat(): SchedulerHeartbeat {
		return this.database.prepare("SELECT lastStartedAt, lastFinishedAt, lastErrorCode FROM dispatcher WHERE id = 1")
			.get() as SchedulerHeartbeat;
	}

	recoverTasks(now: number): string[] {
		return this.transaction(() => {
			const terminalTaskIds: string[] = [];
			const abandoned = this.database.prepare("SELECT * FROM tasks WHERE status IN ('preparing', 'submitting') AND leaseUntil <= ?")
				.all(now) as TaskRecord[];
			for (const task of abandoned) {
				const uncertain = task.status === "submitting";
				const exhausted = task.attempts >= MAX_PREPARATION_ATTEMPTS;
				const status = uncertain ? "uncertain" : exhausted ? "failed" : "retry_wait";
				const code = uncertain ? "RESULT_UNCERTAIN" : exhausted ? "RETRIES_EXHAUSTED" : "RETRY_PENDING";
				this.database.prepare("UPDATE tasks SET status = ?, resultCode = ?, leaseToken = NULL, leaseUntil = NULL, nextAttemptAt = ?, updatedAt = ? WHERE id = ?")
					.run(status, code, now, now, task.id);
				this.addEvent(task.id, now, "recovery", code);
				if (status === "failed") terminalTaskIds.push(task.id);
			}
			const expired = this.database.prepare("SELECT id FROM tasks WHERE status IN ('pending', 'retry_wait') AND deadlineAt <= ?")
				.all(now) as { id: string }[];
			this.database.prepare("UPDATE tasks SET status = 'expired', resultCode = 'DEADLINE_PASSED', updatedAt = ? WHERE status IN ('pending', 'retry_wait') AND deadlineAt <= ?")
				.run(now, now);
			for (const task of expired) {
				this.addEvent(task.id, now, "deadline", "DEADLINE_PASSED");
				terminalTaskIds.push(task.id);
			}
			return terminalTaskIds;
		});
	}

	claimNextTask(now: number): TaskRecord | null {
		return this.transaction(() => {
			const task = this.database.prepare(`SELECT * FROM tasks WHERE status IN ('pending', 'retry_wait')
				AND scheduledAt <= ? AND nextAttemptAt <= ? AND deadlineAt > ? ORDER BY scheduledAt, id LIMIT 1`)
				.get(now, now, now) as TaskRecord | undefined;
			if (!task) return null;
			const leaseToken = randomUUID();
			this.database.prepare("UPDATE tasks SET status = 'preparing', attempts = attempts + 1, leaseToken = ?, leaseUntil = ?, updatedAt = ? WHERE id = ?")
				.run(leaseToken, now + TASK_LEASE_MS, now, task.id);
			this.addEvent(task.id, now, "prepare", "PREPARING");
			return this.getTask(task.id)!;
		});
	}

	claimUncertainTask(now: number): TaskRecord | null {
		return this.transaction(() => {
			const task = this.database.prepare(`SELECT * FROM tasks WHERE status = 'uncertain' AND nextAttemptAt <= ?
				AND reconcileAttempts < ? AND (leaseUntil IS NULL OR leaseUntil <= ?) ORDER BY nextAttemptAt LIMIT 1`)
				.get(now, MAX_RECONCILIATION_ATTEMPTS, now) as TaskRecord | undefined;
			if (!task) return null;
			this.database.prepare("UPDATE tasks SET reconcileAttempts = reconcileAttempts + 1, leaseToken = ?, leaseUntil = ?, updatedAt = ? WHERE id = ?")
				.run(randomUUID(), now + TASK_LEASE_MS, now, task.id);
			this.addEvent(task.id, now, "reconcile", "CHECKING_RESULT");
			return this.getTask(task.id)!;
		});
	}

	markSubmitting(task: TaskRecord, now: number): boolean {
		return this.transaction(() => {
			if (!this.isAccountEnabled(task.accountId, task.studentIdentity)) return false;
			// This is the cancellation boundary. A crash after this write must never cause an automatic resubmit.
			const update = this.database.prepare(`UPDATE tasks SET status = 'submitting', leaseUntil = ?, updatedAt = ?
				WHERE id = ? AND status = 'preparing' AND leaseToken = ? AND leaseUntil > ? AND scheduledAt <= ? AND deadlineAt > ?`)
				.run(now + TASK_LEASE_MS, now, task.id, task.leaseToken, now, now, now);
			if (update.changes) this.addEvent(task.id, now, "submit", "SUBMITTING");
			return Boolean(update.changes);
		});
	}

	finishTask(task: TaskRecord, status: TaskStatus, code: string, now: number, nextAttemptAt = now): void {
		this.transaction(() => {
			const update = this.database.prepare(`UPDATE tasks SET status = ?, resultCode = ?, updatedAt = ?, nextAttemptAt = ?,
				leaseToken = NULL, leaseUntil = NULL WHERE id = ? AND leaseToken = ? AND status IN ('preparing', 'submitting', 'uncertain')`)
				.run(status, code, now, nextAttemptAt, task.id, task.leaseToken);
			if (update.changes) this.addEvent(task.id, now, status, code);
		});
	}

	hasNotificationRecord(taskId: string): boolean {
		return Boolean(this.database.prepare("SELECT 1 FROM events WHERE taskId = ? AND stage = 'notify' LIMIT 1").get(taskId));
	}

	recordNotification(taskId: string, now: number, sent: boolean): void {
		this.transaction(() => {
			if (!this.getTask(taskId) || this.hasNotificationRecord(taskId)) return;
			this.addEvent(taskId, now, "notify", sent ? "NOTIFY_SENT" : "NOTIFY_FAILED");
		});
	}
}
