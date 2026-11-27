import { createHash } from "node:crypto";
import { AutoSignError } from "./types.ts";

export const SIGN_LEAD_MS = 10 * 60 * 1000;
export const SIGN_RANDOM_WINDOW_SECONDS = 4 * 60;
export const DEADLINE_BEFORE_CLASS_MS = 30 * 1000;
export const SIGN_TIMESTAMP_BUFFER_MS = 3 * 1000;
export const SCHOOL_TIME_ZONE = "Asia/Shanghai";

export function calculateScheduleOffsetSeconds(studentIdentity: string, courseDate: string, courseSchedId: string): number {
	// Stable per student and dated occurrence: preview, confirmation and restarts must not reroll.
	const digest = createHash("sha256")
		.update(JSON.stringify(["ucas-auto-sign-window-v1", studentIdentity, normalizeCourseDate(courseDate), courseSchedId]))
		.digest();
	return digest.readUInt32BE(0) % (SIGN_RANDOM_WINDOW_SECONDS + 1);
}

export function normalizeCourseDate(value: unknown): string {
	if (typeof value !== "string") throw new AutoSignError("INVALID_DATE");
	const compact = value.replaceAll("-", "");
	if (!/^(20\d{2})\d{4}$/.test(compact) || !/^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(value)) {
		throw new AutoSignError("INVALID_DATE");
	}
	const normalized = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
	const parsed = new Date(`${normalized}T00:00:00Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
		throw new AutoSignError("INVALID_DATE");
	}
	return normalized;
}

function parseSchoolClock(courseDate: string, value: string): number {
	const match = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
	if (!match || (match[1] && match[1] !== courseDate)) throw new AutoSignError("INVALID_COURSE_TIME");
	const [, , hours, minutes, seconds = "00"] = match;
	if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
		throw new AutoSignError("INVALID_COURSE_TIME");
	}
	// Contemporary Shanghai course dates use UTC+08:00, regardless of the VPS timezone.
	return Date.parse(`${courseDate}T${hours}:${minutes}:${seconds}+08:00`);
}

export function calculateOccurrence(courseDate: string, beginTime: string, endTime: string, scheduleOffsetSeconds = 0) {
	if (!Number.isInteger(scheduleOffsetSeconds) || scheduleOffsetSeconds < 0 || scheduleOffsetSeconds > SIGN_RANDOM_WINDOW_SECONDS) {
		throw new AutoSignError("INVALID_SCHEDULE_OFFSET");
	}
	const normalizedDate = normalizeCourseDate(courseDate);
	const classBeginAt = parseSchoolClock(normalizedDate, beginTime);
	const classEndAt = parseSchoolClock(normalizedDate, endTime);
	if (classEndAt <= classBeginAt) throw new AutoSignError("INVALID_COURSE_TIME");
	const scheduledAt = classBeginAt - SIGN_LEAD_MS + scheduleOffsetSeconds * 1000;
	const preClassDeadline = classBeginAt - DEADLINE_BEFORE_CLASS_MS;
	return {
		classBeginAt,
		classEndAt,
		scheduledAt,
		deadlineAt: preClassDeadline > scheduledAt ? preClassDeadline : classBeginAt,
	};
}
