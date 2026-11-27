import "server-only";
import { readPrivateConfig, type PrivateConfig } from "../private-config.ts";
import { getIclassTimestamp, loginIclass, queryIclassSchedule, submitIclassSign, IclassError } from "../iclass.ts";
import { buildTaskNotificationText, classifyTaskNotification, resolveNotificationPlan, sendWeComNotification } from "./notify.ts";
import { AutoSignStore, getStudentIdentity, MAX_PREPARATION_ATTEMPTS, MAX_RECONCILIATION_ATTEMPTS, type TaskRecord } from "./store.ts";
import { calculateOccurrence, calculateScheduleOffsetSeconds, normalizeCourseDate, SIGN_TIMESTAMP_BUFFER_MS } from "./time.ts";
import { AutoSignError, type AutoSignMode, type AutoSignPreview } from "./types.ts";

export const MAX_PREPARATION_RETRY_DELAY_MS = 30_000;

export type AutoSignDependencies = {
	now: () => number;
	getScheduleOffsetSeconds: typeof calculateScheduleOffsetSeconds;
	readConfig: () => Promise<PrivateConfig>;
	login: typeof loginIclass;
	querySchedule: typeof queryIclassSchedule;
	getTimestamp: typeof getIclassTimestamp;
	submitSign: typeof submitIclassSign;
	sendAlert?: typeof sendWeComNotification;
};

export const defaultAutoSignDependencies: AutoSignDependencies = {
	now: Date.now,
	getScheduleOffsetSeconds: calculateScheduleOffsetSeconds,
	readConfig: readPrivateConfig,
	login: loginIclass,
	querySchedule: queryIclassSchedule,
	getTimestamp: getIclassTimestamp,
	submitSign: submitIclassSign,
	sendAlert: sendWeComNotification,
};

export class AutoSignService {
	private store: AutoSignStore;
	private dependencies: AutoSignDependencies;

	constructor(store: AutoSignStore, dependencies = defaultAutoSignDependencies) {
		this.store = store;
		this.dependencies = dependencies;
	}

	private async loadAccount(accountId: string, expectedIdentity?: string) {
		const config = await this.dependencies.readConfig();
		this.store.synchronizeAccounts(config.students, this.dependencies.now());
		const account = config.students.find((candidate) => candidate.id === accountId);
		if (!account) throw new AutoSignError("ACCOUNT_CHANGED", 409);
		const identity = getStudentIdentity(account.studentId);
		if (expectedIdentity && identity !== expectedIdentity) throw new AutoSignError("ACCOUNT_CHANGED", 409);
		if (!this.store.isAccountEnabled(accountId, identity)) throw new AutoSignError("ACCOUNT_DISABLED", 409);
		return { account, identity, password: config.studentPassword };
	}

	private async verifySelection(body: Record<string, unknown>) {
		const courseDate = normalizeCourseDate(body.date);
		if (typeof body.accountId !== "string" || typeof body.courseSchedId !== "string" || !/^\d{7}$/.test(body.courseSchedId)) {
			throw new AutoSignError("INVALID_SELECTION");
		}
		const { account, identity, password } = await this.loadAccount(body.accountId);
		const session = await this.dependencies.login(account.studentId, password);
		const courses = await this.dependencies.querySchedule(session, courseDate.replaceAll("-", ""));
		const matches = courses.filter((course) => course.id === body.courseSchedId);
		if (matches.length !== 1) throw new AutoSignError("COURSE_MISSING", 409);
		const course = matches[0];
		if (course.signStatus === "1") throw new AutoSignError("ALREADY_SIGNED", 409);
		if (course.signStatus !== "0") throw new AutoSignError("UNKNOWN_SIGN_STATUS", 409);
		const scheduleOffsetSeconds = this.dependencies.getScheduleOffsetSeconds(identity, courseDate, course.id);
		const occurrence = calculateOccurrence(courseDate, course.classBeginTime, course.classEndTime, scheduleOffsetSeconds);
		const existingTask = this.store.getOccurrenceTask(identity, courseDate, course.id);
		if (existingTask && existingTask.accountId === account.id
			&& existingTask.classBeginAt === occurrence.classBeginAt && existingTask.classEndAt === occurrence.classEndAt) {
			// Existing confirmations remain authoritative, including tasks from the fixed-time policy.
			occurrence.scheduledAt = existingTask.scheduledAt;
			occurrence.deadlineAt = existingTask.deadlineAt;
		}
		if (occurrence.scheduledAt <= this.dependencies.now()) throw new AutoSignError("PLANNED_TIME_PASSED", 409);
		await this.loadAccount(account.id, identity);
		const preview: AutoSignPreview = {
			accountId: account.id, accountName: account.name, courseDate, courseSchedId: course.id,
			courseName: course.courseName, ...occurrence,
		};
		return { preview, identity };
	}

	async previewTask(body: Record<string, unknown>): Promise<AutoSignPreview> {
		return (await this.verifySelection(body)).preview;
	}

	async createTask(body: Record<string, unknown>, mode: AutoSignMode = "dry-run") {
		const { preview, identity } = await this.verifySelection(body);
		if (body.expectedClassBeginAt !== preview.classBeginAt || body.expectedClassEndAt !== preview.classEndAt) {
			throw new AutoSignError("RECONFIRM_REQUIRED", 409);
		}
		return this.store.createTask(preview, identity, this.dependencies.now(), mode);
	}

	async setAccountEnabled(accountId: string, enabled: boolean): Promise<void> {
		const config = await this.dependencies.readConfig();
		this.store.synchronizeAccounts(config.students, this.dependencies.now());
		const account = config.students.find((candidate) => candidate.id === accountId);
		if (!account) throw new AutoSignError("ACCOUNT_CHANGED", 409);
		this.store.setAccountEnabled(account.id, getStudentIdentity(account.studentId), enabled, this.dependencies.now());
	}

	private async notifyTaskIfNeeded(taskId: string): Promise<void> {
		const task = this.store.getTask(taskId);
		if (!task || this.store.hasNotificationRecord(task.id)) return;
		const kind = classifyTaskNotification(task, MAX_RECONCILIATION_ATTEMPTS);
		if (!kind) return;

		let config: PrivateConfig;
		try {
			config = await this.dependencies.readConfig();
		} catch {
			return;
		}
		const plan = resolveNotificationPlan(config, task.accountId, kind);
		if (!plan) return;

		const now = this.dependencies.now();
		const content = buildTaskNotificationText(task, kind, plan.usedFallback, now);
		const sendAlert = this.dependencies.sendAlert ?? sendWeComNotification;
		let sent = false;
		try {
			sent = await sendAlert({ ...plan.target, content });
		} catch {
			sent = false;
		}
		this.store.recordNotification(task.id, this.dependencies.now(), sent);
	}

	async tick(mode: AutoSignMode) {
		const startedAt = this.dependencies.now();
		const leaseToken = this.store.startTick(startedAt);
		if (!leaseToken) return { busy: true, processed: 0, mode };
		let processed = 0;
		let errorCode = "";
		try {
			const config = await this.dependencies.readConfig();
			this.store.synchronizeAccounts(config.students, this.dependencies.now());
			const recoveredTaskIds = this.store.recoverTasks(this.dependencies.now());
			for (const recoveredId of recoveredTaskIds) {
				await this.notifyTaskIfNeeded(recoveredId);
			}
			// Bounded sequential work keeps upstream load low and remains inside the dispatcher lease.
			while (processed < 2 && this.dependencies.now() - startedAt < 45_000) {
				if (!this.store.renewTick(leaseToken, this.dependencies.now())) break;
				const task = this.store.claimNextTask(this.dependencies.now());
				if (!task) break;
				await this.executeTask(task, mode);
				await this.notifyTaskIfNeeded(task.id);
				processed += 1;
			}
			if (this.dependencies.now() - startedAt < 70_000 && this.store.renewTick(leaseToken, this.dependencies.now())) {
				const uncertain = this.store.claimUncertainTask(this.dependencies.now());
				if (uncertain) {
					await this.reconcileTask(uncertain);
					await this.notifyTaskIfNeeded(uncertain.id);
				}
			}
			return { busy: false, processed, mode };
		} catch {
			errorCode = "DISPATCHER_FAILED";
			throw new AutoSignError(errorCode, 503);
		} finally {
			this.store.finishTick(leaseToken, this.dependencies.now(), errorCode);
		}
	}

	private finishPreparationError(task: TaskRecord, error: unknown): void {
		const now = this.dependencies.now();
		if (now >= task.deadlineAt) {
			this.store.finishTask(task, "expired", "DEADLINE_PASSED", now);
			return;
		}
		if (error instanceof AutoSignError) {
			this.store.finishTask(task, error.code === "ACCOUNT_DISABLED" ? "cancelled" : "paused", error.code, now);
			return;
		}
		const backoffMs = Math.min(15_000 * 2 ** (task.attempts - 1), MAX_PREPARATION_RETRY_DELAY_MS);
		const preferredRetryAt = now + backoffMs;
		const retryAt = preferredRetryAt < task.deadlineAt
			? preferredRetryAt
			: (task.deadlineAt - now >= 15_000 ? now + 10_000 : preferredRetryAt);
		if (error instanceof IclassError && error.retryable && task.attempts < MAX_PREPARATION_ATTEMPTS && retryAt < task.deadlineAt) {
			this.store.finishTask(task, "retry_wait", error.code, now, retryAt);
		} else {
			this.store.finishTask(task, "failed", error instanceof IclassError ? error.code : "PREPARATION_FAILED", now);
		}
	}

	private async executeTask(task: TaskRecord, mode: AutoSignMode): Promise<void> {
		let submissionStarted = false;
		try {
			if (task.executionMode !== mode) throw new AutoSignError("EXECUTION_MODE_CHANGED", 409);
			const { account, password } = await this.loadAccount(task.accountId, task.studentIdentity);
			const session = await this.dependencies.login(account.studentId, password);
			const courses = await this.dependencies.querySchedule(session, task.courseDate.replaceAll("-", ""));
			const matches = courses.filter((course) => course.id === task.courseSchedId);
			if (matches.length !== 1) throw new AutoSignError("COURSE_MISSING", 409);
			const course = matches[0];
			if (course.signStatus === "1") {
				this.store.finishTask(task, "skipped", "ALREADY_SIGNED", this.dependencies.now());
				return;
			}
			if (course.signStatus !== "0") throw new AutoSignError("UNKNOWN_SIGN_STATUS", 409);
			const occurrence = calculateOccurrence(task.courseDate, course.classBeginTime, course.classEndTime);
			if (occurrence.classBeginAt !== task.classBeginAt || occurrence.classEndAt !== task.classEndAt) {
				throw new AutoSignError("COURSE_CHANGED", 409);
			}
			const timestampRequestedAt = this.dependencies.now();
			const schoolTimestamp = await this.dependencies.getTimestamp();
			const timestampReceivedAt = this.dependencies.now();
			const timestampRoundTrip = timestampReceivedAt - timestampRequestedAt;
			if (timestampRoundTrip > 2000) {
				throw new IclassError(504, "UPSTREAM_TIMESTAMP_TIMEOUT", "Timestamp response too old.", "timestamp", true);
			}
			if (!Number.isFinite(schoolTimestamp) || Math.abs(schoolTimestamp - timestampReceivedAt) > 10_000) {
				throw new AutoSignError("CLOCK_SKEW", 409);
			}
			await this.loadAccount(task.accountId, task.studentIdentity);
			const now = this.dependencies.now();
			const freshSchoolTime = schoolTimestamp + (now - timestampReceivedAt);
			// The sample could have been generated at request start. Bound its age conservatively.
			const latestPossibleSchoolTime = schoolTimestamp + (now - timestampRequestedAt);
			if (now >= task.deadlineAt || latestPossibleSchoolTime >= task.deadlineAt) {
				this.store.finishTask(task, "expired", "DEADLINE_PASSED", now);
				return;
			}
			if (timestampRoundTrip < 0 || now < task.scheduledAt || freshSchoolTime < task.scheduledAt || now - timestampRequestedAt > 2000) {
				this.store.finishTask(task, task.attempts >= MAX_PREPARATION_ATTEMPTS ? "paused" : "retry_wait", "CLOCK_SKEW", now, now + 15_000);
				return;
			}
			if (mode === "dry-run") {
				this.store.finishTask(task, "dry_run", "DRY_RUN", now);
				return;
			}
			if (!this.store.markSubmitting(task, now)) return;
			// SQLite may have waited for a writer; do not use a pre-lock clock for the actual request.
			const submittingAt = this.dependencies.now();
			const submittingSchoolTime = schoolTimestamp + (submittingAt - timestampReceivedAt);
			const latestSubmittingSchoolTime = schoolTimestamp + (submittingAt - timestampRequestedAt);
			if (submittingAt >= task.deadlineAt || latestSubmittingSchoolTime >= task.deadlineAt) {
				this.store.finishTask(task, "expired", "DEADLINE_PASSED", submittingAt);
				return;
			}
			if (submittingAt - timestampRequestedAt > 2000 || submittingAt < now) {
				this.store.finishTask(task, "paused", "CLOCK_SKEW", submittingAt);
				return;
			}
			submissionStarted = true;
			const result = await this.dependencies.submitSign(session, task.courseSchedId, submittingSchoolTime - SIGN_TIMESTAMP_BUFFER_MS);
			if (result.success) {
				this.store.finishTask(task, "succeeded", "SIGNED", this.dependencies.now());
			} else if (result.upstreamStatus === "0" || !result.upstreamStatus) {
				this.store.finishTask(task, "uncertain", "RESULT_UNCERTAIN", this.dependencies.now(), this.dependencies.now() + 30_000);
			} else {
				this.store.finishTask(task, "failed", "UPSTREAM_REJECTED", this.dependencies.now());
			}
		} catch (error) {
			if (submissionStarted) {
				// A timeout or lost response says nothing about the upstream side effect; only query from here on.
				this.store.finishTask(task, "uncertain", "RESULT_UNCERTAIN", this.dependencies.now(), this.dependencies.now() + 30_000);
			} else {
				this.finishPreparationError(task, error);
			}
		}
	}

	private async reconcileTask(task: TaskRecord): Promise<void> {
		try {
			const { account, password } = await this.loadAccount(task.accountId, task.studentIdentity);
			const session = await this.dependencies.login(account.studentId, password);
			const courses = await this.dependencies.querySchedule(session, task.courseDate.replaceAll("-", ""));
			const matches = courses.filter((course) => course.id === task.courseSchedId);
			if (matches.length === 1 && matches[0].signStatus === "1") {
				this.store.finishTask(task, "succeeded", "CONFIRMED_SIGNED", this.dependencies.now());
				return;
			}
		} catch {
			// Unknown results remain visible. Revoked credentials are not used to reconcile.
		}
		this.store.finishTask(task, "uncertain", "RESULT_UNCERTAIN", this.dependencies.now(), this.dependencies.now() + 60_000);
	}
}
