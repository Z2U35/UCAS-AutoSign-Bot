"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { canDeleteAutoSignTask, type AutoSignMode, type AutoSignPreview, type AutoSignSnapshot, type AutoSignTask, type TaskStatus } from "@/lib/auto-sign/types";
import type { StatusKind } from "./editorial-ui";

const POLL_INTERVAL_MS = 30 * 1000;
const SNAPSHOT_TIMEOUT_MS = 15 * 1000;
const OPERATION_TIMEOUT_MS = 45 * 1000;

const RESULT_MESSAGES: Readonly<Record<string, string>> = {
	SCHEDULED: "已安排，仅执行已确认的这一次课程。",
	PREPARING: "正在核对账号、课表、签到状态与服务器时间。",
	SUBMITTING: "已进入提交阶段，无法保证撤回，请等待最终结果。",
	CHECKING_RESULT: "正在重新查询官方课表核实结果，不会重复提交签到。",
	ACCOUNT_DISABLED: "账号已关闭自动签到，尚未提交的任务已取消。",
	ACCOUNT_CHANGED: "快捷账号配置已变化，原任务已停止，请重新核对账号。",
	CANCELLED: "任务已取消，不会自动恢复。",
	COURSE_CHANGED: "课程时间或信息已变化，原计划未继续执行，请重新查询并确认。",
	COURSE_MISSING: "当前课表中未找到这一次课程，任务未继续执行。",
	ALREADY_SIGNED: "上游课表已显示签到，无需重复提交。",
	SIGNED: "上游已返回签到成功。",
	CONFIRMED_SIGNED: "已重新查询课表，确认签到成功。",
	DEADLINE_PASSED: "已超过本次自动签到的截止时间，不再补签。",
	DRY_RUN: "演练已完成，没有向上游提交签到。",
	RESULT_UNCERTAIN: "提交结果无法确认，不会盲目重试。请到官方课表核实是否已签到。",
	RETRY_PENDING: "准备阶段遇到临时故障，将在截止时间内按服务端策略重试。",
	RETRIES_EXHAUSTED: "已用尽允许的重试次数，任务已停止。",
	NOTIFY_SENT: "已通过微信推送本次签到结果通知。",
	NOTIFY_FAILED: "企业微信通知发送失败，请管理员检查企业微信配置、可信 IP 或网络。",
	UNKNOWN_SIGN_STATUS: "无法识别上游签到状态，为避免重复签到已停止操作。",
	CLOCK_SKEW: "服务器时钟偏差或时间样本过旧，本次未提交；请结合任务状态查看是否重试，必要时联系管理员校时。",
	UPSTREAM_REJECTED: "上游未接受签到请求，请核对官方签到状态。",
	UPSTREAM_LOGIN_REJECTED: "账号登录未通过，请联系管理员检查快捷账号和统一密码。",
	UPSTREAM_SCHEDULE_REJECTED: "上游未能返回可用课表，请重新查询课程。",
	UPSTREAM_TIMESTAMP_INVALID_RESPONSE: "无法确认上游服务器时间，未继续提交。",
	ACCESS_REQUIRED: "访问授权已失效，请重新解锁页面。",
	RATE_LIMITED: "操作过于频繁，请稍后再试。",
	AUTO_SIGN_UNAVAILABLE: "自动签到服务暂不可用，请联系管理员检查服务端配置。",
	AUTO_SIGN_NOT_CONFIGURED: "自动签到尚未配置，请联系管理员完成服务端配置。",
	INVALID_EXECUTION_MODE: "服务器执行模式配置无效，请联系管理员检查配置。",
	EXECUTION_MODE_CHANGED: "服务器执行模式与安排任务时不同，为避免误提交已停止任务，请重新核对。",
	RESTART_REQUIRED: "服务器配置已变化，请联系管理员重启网站服务以加载新配置。",
	MACHINE_CREDENTIAL_UNAVAILABLE: "调度服务凭据不可用，请联系管理员检查服务端配置。",
	DISPATCHER_FAILED: "调度巡检未完成，请联系管理员检查服务运行状态。",
	PREPARATION_FAILED: "执行前检查失败，任务未继续提交，请联系管理员检查服务。",
	INVALID_ACCOUNT: "只能为服务端已配置的快捷账号安排任务。",
	INVALID_ACCOUNT_SETTING: "账号权限设置无效，请刷新页面后重试。",
	ACCOUNT_NOT_FOUND: "快捷账号不存在或已移除，请刷新账号列表。",
	INVALID_DATE: "课程日期无效，请重新选择日期并查询。",
	INVALID_COURSE_TIME: "无法确认这一次课程的完整时间，不能安排自动签到。",
	INVALID_COURSE: "课程信息无效，请重新查询课表。",
	INVALID_SELECTION: "只能为快捷账号课表中已确认的课程安排任务，请重新查询。",
	PLANNED_TIME_PASSED: "本次计划签到时间已过，不能再新增自动任务。请核对当前可用的签到方式。",
	RECONFIRM_REQUIRED: "课程时间或执行模式已变化，请重新查询并确认本次课程。",
	DUPLICATE_ACCOUNT_TASK: "其他快捷账号已为同一学号安排本次课程，请勿重复安排。",
	TASK_CAPACITY_REACHED: "待执行任务数量已达上限，请先处理已有任务或稍后再试。",
	TASK_RETENTION_BUSY: "较早任务正在提交签到，请待其结束后再安排新任务。",
	TASK_NOT_FOUND: "任务已不存在，请刷新状态。",
	INVALID_TASK_ID: "任务标识无效，请刷新状态后重试。",
	TASK_NOT_CANCELLABLE: "任务已进入提交阶段或已经结束，不能再取消。请查看最新结果，已提交请求无法撤回。",
	TASK_NOT_DELETABLE: "任务仍在等待执行、处理中或结果待核实，暂不能删除。待执行任务请先取消。",
	TASK_ALREADY_COMPLETED: "本次课程已有完成记录，不能重复安排。",
	TASK_IN_FLIGHT: "请求正在提交，无法撤回。请等待任务结果并核对官方课表。",
	TASK_CONFLICT: "本次课程已有任务或状态已变化，请刷新状态。",
	CONFLICT: "任务或课表已变化，或操作正在处理中。请核对最新任务状态后重新操作。",
	PREVIEW_CHANGED: "服务端确认信息已变化，请重新获取本次课程的预览。",
	JSON_REQUIRED: "请求格式不正确，请刷新页面后重试。",
	INVALID_JSON: "请求内容无效，请刷新页面后重试。",
	REQUEST_TOO_LARGE: "请求内容超过限制，请刷新页面后重试。",
	NETWORK_ERROR: "网络请求未完成，请先刷新状态核实结果，勿重复操作。",
	REQUEST_FAILED: "操作未完成，请刷新状态，或联系管理员。",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: "等待执行",
	preparing: "准备中",
	submitting: "正在提交",
	retry_wait: "等待重试",
	succeeded: "签到成功",
	skipped: "已跳过",
	cancelled: "已取消",
	paused: "已暂停",
	expired: "已过期",
	uncertain: "结果待核实",
	dry_run: "演练完成",
	failed: "执行失败",
};

export function getAutoSignReason(code: string): string {
	if (Object.hasOwn(RESULT_MESSAGES, code)) return RESULT_MESSAGES[code];
	const upstreamMatch = /^UPSTREAM_(LOGIN|SCHEDULE|TIMESTAMP|SIGN)_(HTTP|BAD_JSON|TIMEOUT|NETWORK)$/.exec(code);
	if (upstreamMatch) {
		if (upstreamMatch[1] === "SIGN") return "上游签到响应异常，不能据此确认是否成功。请核对官方课表，勿重复提交。";
		const stageNames: Record<string, string> = { LOGIN: "登录", SCHEDULE: "查询课表", TIMESTAMP: "校准服务器时间" };
		return `${stageNames[upstreamMatch[1]]}时上游服务暂不可用，请结合任务状态查看是否等待重试。`;
	}
	return "未能确认处理原因，请核对任务记录，必要时联系管理员。";
}

export function getAutoSignStatusLabel(status: TaskStatus): string {
	return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : "状态待核实";
}

export function canCancelAutoSignTask(task: AutoSignTask): boolean {
	return task.status === "pending" || task.status === "retry_wait" || task.status === "preparing";
}

type ProtectedFetch = (url: string, init: RequestInit) => Promise<Response>;
type OperationKind = "account" | "preview" | "create" | "cancel" | "delete";
type AutoSignOperation = { kind: OperationKind; targetId: string; controller: AbortController; timeoutId: number };
type PreviewConfirmation = { details: AutoSignPreview; mode: AutoSignMode; sequence: number };

class AutoSignRequestError extends Error {
	constructor(readonly code: string, readonly status = 400) {
		super(code);
	}
}

function getRequestErrorMessage(error: unknown): string {
	if (error instanceof AutoSignRequestError && error.status === 409 && !Object.hasOwn(RESULT_MESSAGES, error.code)) {
		return getAutoSignReason("CONFLICT");
	}
	return getAutoSignReason(error instanceof AutoSignRequestError ? error.code : "NETWORK_ERROR");
}

export function useAutoSign(fetchProtected: ProtectedFetch) {
	const [snapshot, setSnapshot] = useState<AutoSignSnapshot | null>(null);
	const [refreshing, setRefreshing] = useState(true);
	const [loadError, setLoadError] = useState("");
	const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
	const [observedAt, setObservedAt] = useState<number | null>(null);
	const [notice, setNotice] = useState<{ kind: StatusKind; text: string } | null>(null);
	const [preview, setPreview] = useState<PreviewConfirmation | null>(null);
	const [operation, setOperation] = useState<AutoSignOperation | null>(null);
	const mountedRef = useRef(false);
	const snapshotControllerRef = useRef<AbortController | null>(null);
	const snapshotSequenceRef = useRef(0);
	const previewSequenceRef = useRef(0);
	const operationRef = useRef<AutoSignOperation | null>(null);

	const request = useCallback(async <ResponseData,>(url: string, init: RequestInit): Promise<ResponseData> => {
		const response = await fetchProtected(url, { ...init, cache: "no-store" });
		const responseData: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const responseCode = responseData && typeof responseData === "object" && "code" in responseData
				&& typeof responseData.code === "string" ? responseData.code : "";
			throw new AutoSignRequestError(responseCode || (response.status === 409 ? "CONFLICT" : "REQUEST_FAILED"), response.status);
		}
		if (!responseData) throw new AutoSignRequestError("REQUEST_FAILED");
		return responseData as ResponseData;
	}, [fetchProtected]);

	const refreshSnapshot = useCallback(async () => {
		if (!mountedRef.current) return;
		const sequence = ++snapshotSequenceRef.current;
		snapshotControllerRef.current?.abort();
		const controller = new AbortController();
		snapshotControllerRef.current = controller;
		const timeout = window.setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
		setRefreshing(true);
		setObservedAt(Date.now());
		try {
			const nextSnapshot = await request<AutoSignSnapshot>("/api/auto-sign", { signal: controller.signal });
			if (!mountedRef.current || sequence !== snapshotSequenceRef.current) return;
			setSnapshot(nextSnapshot);
			setLoadError("");
			setLastRefreshedAt(Date.now());
			setObservedAt(Date.now());
		} catch (error) {
			if (mountedRef.current && sequence === snapshotSequenceRef.current) setLoadError(getRequestErrorMessage(error));
		} finally {
			window.clearTimeout(timeout);
			if (mountedRef.current && sequence === snapshotSequenceRef.current) setRefreshing(false);
		}
	}, [request]);

	useEffect(() => {
		mountedRef.current = true;
		void refreshSnapshot();
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible" && !operationRef.current) void refreshSnapshot();
		};
		const interval = window.setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		return () => {
			mountedRef.current = false;
			snapshotSequenceRef.current += 1;
			previewSequenceRef.current += 1;
			snapshotControllerRef.current?.abort();
			if (operationRef.current) {
				operationRef.current.controller.abort();
				window.clearTimeout(operationRef.current.timeoutId);
			}
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
		};
	}, [refreshSnapshot]);

	const dismissPreview = useCallback(() => {
		previewSequenceRef.current += 1;
		setPreview(null);
		if (operationRef.current?.kind === "preview") {
			operationRef.current.controller.abort();
			window.clearTimeout(operationRef.current.timeoutId);
			operationRef.current = null;
			setOperation(null);
		}
	}, []);

	const beginOperation = (kind: OperationKind, targetId: string) => {
		if (operationRef.current || !mountedRef.current) return null;
		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
		const nextOperation = { kind, targetId, controller, timeoutId };
		operationRef.current = nextOperation;
		setOperation(nextOperation);
		setNotice(null);
		// A poll started before a mutation must not overwrite the post-mutation snapshot.
		snapshotSequenceRef.current += 1;
		snapshotControllerRef.current?.abort();
		setRefreshing(false);
		return nextOperation;
	};

	const finishOperation = (completedOperation: AutoSignOperation) => {
		window.clearTimeout(completedOperation.timeoutId);
		if (mountedRef.current && operationRef.current === completedOperation) {
			operationRef.current = null;
			setOperation(null);
		}
	};

	const ready = Boolean(snapshot?.available && !loadError);

	const requestPreview = async (accountId: string, date: string, courseSchedId: string) => {
		if (!ready || !snapshot?.accounts.some((account) => account.accountId === accountId && account.enabled)) return;
		const currentOperation = beginOperation("preview", courseSchedId);
		if (!currentOperation) return;
		setPreview(null);
		const sequence = ++previewSequenceRef.current;
		try {
			const result = await request<{ preview: AutoSignPreview }>("/api/auto-sign/tasks/preview", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId, date, courseSchedId }),
				signal: currentOperation.controller.signal,
			});
			if (!mountedRef.current || sequence !== previewSequenceRef.current) return;
			if (result.preview.accountId !== accountId || result.preview.courseDate !== date || result.preview.courseSchedId !== courseSchedId) {
				throw new AutoSignRequestError("PREVIEW_CHANGED");
			}
			setPreview({ details: result.preview, mode: snapshot.mode, sequence });
		} catch (error) {
			if (mountedRef.current && sequence === previewSequenceRef.current) setNotice({ kind: "error", text: getRequestErrorMessage(error) });
		} finally {
			if (mountedRef.current && sequence === previewSequenceRef.current) await refreshSnapshot();
			finishOperation(currentOperation);
		}
	};

	const mutate = async <ResponseData,>(kind: Exclude<OperationKind, "preview">, targetId: string,
		url: string, body: object, getSuccessMessage: (result: ResponseData) => string) => {
		if (!ready) return;
		const currentOperation = beginOperation(kind, targetId);
		if (!currentOperation) return;
		previewSequenceRef.current += 1;
		try {
			const result = await request<ResponseData>(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: currentOperation.controller.signal,
			});
			if (mountedRef.current) setNotice({ kind: "success", text: getSuccessMessage(result) });
			return true;
		} catch (error) {
			if (mountedRef.current) setNotice({ kind: "error", text: getRequestErrorMessage(error) });
			return false;
		} finally {
			if (mountedRef.current) {
				setPreview(null);
				await refreshSnapshot();
			}
			finishOperation(currentOperation);
		}
	};

	const setAccountEnabled = async (accountId: string, enabled: boolean) => {
		const account = snapshot?.accounts.find((configuredAccount) => configuredAccount.accountId === accountId);
		if (!account) return;
		await mutate("account", accountId, "/api/auto-sign/accounts", { accountId, enabled }, () => enabled
			? `已启用「${account.name}」，请在课程列表逐课安排。`
			: `已关闭「${account.name}」，未提交任务已取消，不会自动恢复。`);
	};

	const confirmPreview = async () => {
		if (!preview || !snapshot || preview.sequence !== previewSequenceRef.current) return;
		const confirmedPreview = preview.details;
		if (preview.mode !== snapshot.mode || !snapshot.accounts.some((account) => account.accountId === confirmedPreview.accountId && account.enabled)) {
			setPreview(null);
			setNotice({ kind: "error", text: getAutoSignReason("PREVIEW_CHANGED") });
			return;
		}
		await mutate<{ task: AutoSignTask }>("create", confirmedPreview.courseSchedId, "/api/auto-sign/tasks", {
			accountId: confirmedPreview.accountId,
			date: confirmedPreview.courseDate,
			courseSchedId: confirmedPreview.courseSchedId,
			expectedClassBeginAt: confirmedPreview.classBeginAt,
			expectedClassEndAt: confirmedPreview.classEndAt,
		}, ({ task }) => `已为「${task.accountName}」安排「${task.courseName}」。可在下方签到记录查看状态或取消。`);
	};

	const cancelTask = async (taskId: string) => {
		const task = snapshot?.tasks.find((existingTask) => existingTask.id === taskId);
		if (!task || !canCancelAutoSignTask(task)) return;
		await mutate("cancel", taskId, "/api/auto-sign/tasks/cancel", { taskId }, () =>
			`已取消「${task.accountName}」的「${task.courseName}」自动签到。`);
	};

	const deleteTask = async (taskId: string) => {
		const task = snapshot?.tasks.find((existingTask) => existingTask.id === taskId);
		if (!task || !canDeleteAutoSignTask(task)) return;
		const deleted = await mutate("delete", taskId, "/api/auto-sign/tasks/delete", { taskId }, () =>
			`已删除「${task.accountName}」的「${task.courseName}」任务卡片，不影响官方签到结果，后台防重复记录仍保留。`);
		if (deleted && mountedRef.current) {
			setSnapshot((currentSnapshot) => currentSnapshot ? {
				...currentSnapshot, tasks: currentSnapshot.tasks.filter((existingTask) => existingTask.id !== taskId),
			} : null);
		}
	};

	return {
		snapshot, refreshing, loadError, lastRefreshedAt, observedAt, notice, preview, operation, ready,
		refreshSnapshot, requestPreview, dismissPreview, setAccountEnabled, confirmPreview, cancelTask, deleteTask,
	};
}

export type AutoSignController = ReturnType<typeof useAutoSign>;
