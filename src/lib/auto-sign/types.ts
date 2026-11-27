export type AutoSignMode = "dry-run" | "live";

export const AUTO_SIGN_HISTORY_LIMIT = 100;
export const AUTO_SIGN_DISPLAY_HISTORY_LIMIT = 20;
export const AUTO_SIGN_RECORD_LIMIT = AUTO_SIGN_DISPLAY_HISTORY_LIMIT;

export type TaskStatus =
	| "pending" | "preparing" | "submitting" | "retry_wait"
	| "succeeded" | "skipped" | "cancelled" | "paused"
	| "expired" | "uncertain" | "dry_run" | "failed";

export type AutoSignAccount = {
	accountId: string;
	name: string;
	enabled: boolean;
};

export type AutoSignPreview = {
	accountId: string;
	accountName: string;
	courseDate: string;
	courseSchedId: string;
	courseName: string;
	classBeginAt: number;
	classEndAt: number;
	scheduledAt: number;
	deadlineAt: number;
};

export type TaskEvent = {
	id: number;
	createdAt: number;
	stage: string;
	code: string;
};

export type AutoSignTask = AutoSignPreview & {
	id: string;
	executionMode: AutoSignMode;
	status: TaskStatus;
	attempts: number;
	resultCode: string;
	createdAt: number;
	updatedAt: number;
	events: TaskEvent[];
};

export function canDeleteAutoSignTask(task: Pick<AutoSignTask, "status">): boolean {
	return ["succeeded", "skipped", "cancelled", "paused", "expired", "dry_run", "failed"].includes(task.status);
}

export type SchedulerHeartbeat = {
	lastStartedAt: number | null;
	lastFinishedAt: number | null;
	lastErrorCode: string;
};

export type AutoSignSnapshot = {
	available: boolean;
	mode: AutoSignMode;
	accounts: AutoSignAccount[];
	tasks: AutoSignTask[];
	scheduler: SchedulerHeartbeat | null;
};

export class AutoSignError extends Error {
	code: string;
	status: number;

	constructor(code: string, status = 400) {
		super(code);
		this.code = code;
		this.status = status;
	}
}
