"use client";

import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { AUTO_SIGN_DISPLAY_HISTORY_LIMIT, AUTO_SIGN_HISTORY_LIMIT, type AutoSignTask } from "@/lib/auto-sign/types";
import { Button, SectionHeading, StatusNotice } from "./editorial-ui";
import { canCancelAutoSignTask, getAutoSignReason, getAutoSignStatusLabel, type AutoSignController } from "./use-auto-sign";

const beijingDateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const beijingTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const beijingPreciseTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

function BeijingTime({ timestamp, courseDate, showSeconds = false }: {
	timestamp: number;
	courseDate?: string;
	showSeconds?: boolean;
}) {
	if (!Number.isFinite(timestamp)) return <span>--</span>;
	const dateTime = new Date(timestamp);
	const formattedDate = beijingDateFormatter.format(dateTime);
	const formatter = showSeconds ? beijingPreciseTimeFormatter : beijingTimeFormatter;
	return (
		<time className="font-mono numeric-tabular" dateTime={dateTime.toISOString()}>
			{formattedDate !== courseDate && `${formattedDate} `}
			{formatter.format(dateTime)}
		</time>
	);
}

function AutoSignConfirmation({ controller }: { controller: AutoSignController }) {
	const confirmationRef = useRef<HTMLDivElement>(null);
	useEffect(() => { confirmationRef.current?.focus(); }, []);
	if (!controller.preview) return null;
	const { details, mode } = controller.preview;
	const saving = controller.operation?.kind === "create";
	const accountEnabled = controller.snapshot?.accounts.some((account) => account.accountId === details.accountId && account.enabled);
	const previewChanged = !accountEnabled || controller.snapshot?.mode !== mode;

	return (
		<div ref={confirmationRef} tabIndex={-1} role="region" aria-labelledby="auto-sign-confirm-title"
			aria-describedby="auto-sign-confirm-scope" className="border-2 border-[color:var(--ink)] bg-[color:var(--paper-strong)] p-4 outline-offset-4 sm:p-6"
			onKeyDown={(event) => {
				if (event.key === "Escape" && !saving) {
					event.preventDefault();
					controller.dismissPreview();
				}
			}}>
			<p className="section-kicker">确认自动签到 / 北京时间</p>
			<h3 id="auto-sign-confirm-title" className="mt-2 break-words font-serif text-2xl font-bold">
				{details.courseName || "未命名课程"}
			</h3>
			<p className="field-help">签到账号：<strong className="break-words">{details.accountName}</strong></p>
			<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm leading-6">
				<div>
					<dt className="text-[color:var(--muted)]">课程日期</dt>
					<dd className="font-mono"><time dateTime={details.courseDate}>{details.courseDate}</time></dd>
				</div>
				<div>
					<dt className="text-[color:var(--muted)]">上课时间</dt>
					<dd>
						<BeijingTime timestamp={details.classBeginAt} courseDate={details.courseDate} /> - <BeijingTime timestamp={details.classEndAt} courseDate={details.courseDate} />
					</dd>
				</div>
				<div>
					<dt className="text-[color:var(--muted)]">计划签到</dt>
					<dd><BeijingTime timestamp={details.scheduledAt} courseDate={details.courseDate} showSeconds /></dd>
				</div>
				<div>
					<dt className="text-[color:var(--muted)]">签到截止</dt>
					<dd><BeijingTime timestamp={details.deadlineAt} courseDate={details.courseDate} showSeconds /></dd>
				</div>
			</dl>
			<p id="auto-sign-confirm-scope" className="field-help mt-4">
				{mode === "live" ? "将提交真实签到。" : "仅演练，不提交签到。"}仅安排本次课程，关闭页面仍会执行。
			</p>
			{previewChanged && <div className="mt-4"><StatusNotice kind="info">账号权限或执行模式已变化，请重新预览。</StatusNotice></div>}
			<div className="mt-5 flex flex-wrap gap-3">
				<Button disabled={!controller.ready || Boolean(controller.operation) || previewChanged} onClick={() => void controller.confirmPreview()}>
					<Check aria-hidden="true" size={16} strokeWidth={1.5} />{saving ? "正在保存..." : "确认安排"}
				</Button>
				<Button variant="secondary" disabled={saving} onClick={controller.dismissPreview}>暂不安排</Button>
			</div>
		</div>
	);
}

function AutoSignTaskRecord({ task, controller }: { task: AutoSignTask; controller: AutoSignController }) {
	const cancelling = controller.operation?.kind === "cancel" && controller.operation.targetId === task.id;
	const needsAttention = ["uncertain", "failed", "paused", "expired"].includes(task.status);
	const resultCode = task.status === "preparing" ? "PREPARING"
		: task.status === "submitting" ? "SUBMITTING"
			: task.resultCode || (task.status === "pending" ? "SCHEDULED" : "");

	return (
		<article className="min-w-0 border border-[color:var(--line)] px-4 py-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<h4 className="break-words font-serif text-lg font-bold">{task.courseName || "未命名课程"}</h4>
					<p className="field-help break-words">账号：{task.accountName} · {task.executionMode === "live" ? "正式签到" : "仅演练"}</p>
				</div>
				<span className={`status-chip ${task.status === "succeeded" ? "status-chip--signed" : needsAttention ? "text-[color:var(--accent)]" : ""}`}>
					{getAutoSignStatusLabel(task.status)}
				</span>
			</div>
			<p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-6">
				<span>课程日期 <time className="font-mono" dateTime={task.courseDate}>{task.courseDate}</time></span>
				<span>计划签到 <BeijingTime timestamp={task.scheduledAt} courseDate={task.courseDate} showSeconds /></span>
			</p>
			<div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2">
				<details className="min-w-0 flex-1 break-words">
					<summary className="focus-ring min-h-11 cursor-pointer py-3 text-xs font-bold">查看详情</summary>
					<div className="space-y-3 pb-2 text-xs leading-6">
						<dl className="grid gap-3 sm:grid-cols-2">
							<div>
								<dt className="text-[color:var(--muted)]">上课时间</dt>
								<dd><BeijingTime timestamp={task.classBeginAt} courseDate={task.courseDate} /> - <BeijingTime timestamp={task.classEndAt} courseDate={task.courseDate} /></dd>
							</div>
							<div>
								<dt className="text-[color:var(--muted)]">签到截止</dt>
								<dd><BeijingTime timestamp={task.deadlineAt} courseDate={task.courseDate} showSeconds /></dd>
							</div>
							<div>
								<dt className="text-[color:var(--muted)]">最近更新</dt>
								<dd><BeijingTime timestamp={task.updatedAt} showSeconds /></dd>
							</div>
							<div>
								<dt className="text-[color:var(--muted)]">创建时间</dt>
								<dd><BeijingTime timestamp={task.createdAt} showSeconds /></dd>
							</div>
							<div>
								<dt className="text-[color:var(--muted)]">尝试次数</dt>
								<dd>{task.attempts}</dd>
							</div>
						</dl>
						{resultCode && <p>{getAutoSignReason(resultCode)}</p>}
						{task.events.length > 0 && (
							<ol aria-label="处理记录" className="max-h-56 space-y-2 overflow-y-auto border-t border-[color:var(--line-soft)] pt-3">
								{task.events.map((event) => (
									<li key={event.id}>
										<p className="text-[color:var(--muted)]"><BeijingTime timestamp={event.createdAt} showSeconds /></p>
										<p>{getAutoSignReason(event.code)}</p>
									</li>
								))}
							</ol>
						)}
					</div>
				</details>
				{canCancelAutoSignTask(task) ? (
					<Button variant="secondary" disabled={!controller.ready || Boolean(controller.operation)}
						aria-label={`取消${task.accountName}在${task.courseDate}的${task.courseName}自动签到`}
						onClick={() => void controller.cancelTask(task.id)}>
						<X aria-hidden="true" size={14} strokeWidth={1.5} />{cancelling ? "正在取消..." : "取消任务"}
					</Button>
				) : task.status === "submitting" ? <p className="field-help py-2">已提交，无法撤回</p> : null}
			</div>
		</article>
	);
}

export default function AutoSignPanel({ controller }: { controller: AutoSignController }) {
	const [disableAccountId, setDisableAccountId] = useState<string | null>(null);
	const { snapshot, operation } = controller;
	const tasks = snapshot?.tasks ?? [];

	return (
		<section id="auto-sign-panel" className="editorial-panel col-span-full border-t border-[color:var(--line)]" aria-label="自动签到权限与记录">
			<SectionHeading number="04" label="SCHEDULED SIGN-IN" title="自动签到" detail={
				<div className="flex flex-wrap items-center gap-3">
					{snapshot?.available && <span>{snapshot.mode === "live" ? "正式签到" : "仅演练"}</span>}
					<Button variant="secondary" disabled={controller.refreshing || Boolean(operation)} onClick={() => void controller.refreshSnapshot()}>
						<RefreshCw aria-hidden="true" size={14} strokeWidth={1.5} />{controller.refreshing ? "正在刷新..." : "刷新"}
					</Button>
				</div>
			} />
			<p className="section-description">启用快捷账号后，在课程列表逐课确认自动签到。</p>
			<div className="space-y-4 empty:hidden [&:not(:empty)]:mt-5">
				{!snapshot && !controller.loadError && <StatusNotice kind="loading">正在读取账号与记录...</StatusNotice>}
				{snapshot?.available === false && <StatusNotice kind="info">自动签到尚未启用，请联系管理员。</StatusNotice>}
				{controller.loadError && <StatusNotice kind="error">同步失败，已暂停操作。{controller.loadError}</StatusNotice>}
				{controller.notice && <StatusNotice kind={controller.notice.kind}>{controller.notice.text}</StatusNotice>}
				{operation?.kind === "preview" && !controller.preview && <StatusNotice kind="loading">正在核对课程，尚未安排任务...</StatusNotice>}
				{controller.preview && <AutoSignConfirmation key={`${controller.preview.details.accountId}-${controller.preview.details.courseSchedId}-${controller.preview.details.classBeginAt}`} controller={controller} />}
			</div>
			<div className="mt-6">
				<h3 className="font-serif text-xl font-bold">快捷账号权限</h3>
				<p className="field-help">权限设置对所有使用者生效。</p>
				<div className="mt-3 grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{snapshot?.accounts.map((account) => {
						const updating = operation?.kind === "account" && operation.targetId === account.accountId;
						const confirmingDisable = disableAccountId === account.accountId && account.enabled;
						const confirmationId = `auto-sign-disable-${account.accountId}`;
						return (
							<div key={account.accountId} className="min-w-0 border border-[color:var(--line)] p-4">
								<div className="flex flex-wrap items-center justify-between gap-3">
									<div className="min-w-0">
										<p className="break-words text-sm font-bold">{account.name}</p>
										<p className="field-help">{account.enabled ? "已启用" : "未启用"}</p>
									</div>
									<Button variant="secondary" disabled={!controller.ready || Boolean(operation)}
										aria-label={`${account.enabled ? "关闭" : "启用"}${account.name}的自动签到权限`}
										aria-expanded={account.enabled ? confirmingDisable : undefined}
										aria-controls={confirmingDisable ? confirmationId : undefined}
										onClick={() => {
											if (account.enabled) setDisableAccountId(confirmingDisable ? null : account.accountId);
											else void controller.setAccountEnabled(account.accountId, true);
										}}>
										{updating ? "正在保存..." : account.enabled ? "关闭权限" : "启用权限"}
									</Button>
								</div>
								{confirmingDisable && (
									<div id={confirmationId} className="mt-4 border-t border-[color:var(--line)] pt-3">
										<p className="text-xs leading-6">关闭「{account.name}」会取消未提交任务，已提交签到无法撤回。</p>
										<div className="mt-3 flex flex-wrap gap-2">
											<Button disabled={!controller.ready || Boolean(operation)} onClick={() => {
												setDisableAccountId(null);
												void controller.setAccountEnabled(account.accountId, false);
											}}>确认关闭</Button>
											<Button variant="quiet" disabled={Boolean(operation)} onClick={() => setDisableAccountId(null)}>保留权限</Button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
				{snapshot?.available && !snapshot.accounts.length && <p className="field-help">暂无快捷账号，请联系管理员添加。</p>}
			</div>
			<section id="auto-sign-history" className="mt-6 border-t border-[color:var(--line)] pt-5" aria-labelledby="auto-sign-history-title">
				<div className="flex flex-wrap items-baseline justify-between gap-2">
					<h3 id="auto-sign-history-title" className="font-serif text-xl font-bold">自动签到记录</h3>
					<p className="field-help">全部账号 · 北京时间{snapshot && ` · ${tasks.length} 条`}</p>
				</div>
				<p className="field-help">展示全部待执行任务及最近 {AUTO_SIGN_DISPLAY_HISTORY_LIMIT} 条历史记录（数据库保留最近 {AUTO_SIGN_HISTORY_LIMIT} 条已结束记录，未结束任务永不自动清理）。</p>
				{tasks.length > 0 ? (
					<ul className="mt-3 space-y-3">
						{tasks.map((task) => <li key={task.id}><AutoSignTaskRecord task={task} controller={controller} /></li>)}
					</ul>
				) : (
					<p className="field-help mt-3 border border-dashed border-[color:var(--line)] px-4 py-6 text-center">
						{controller.loadError ? "记录加载失败，请刷新重试。"
							: !snapshot ? "正在读取记录..."
								: !snapshot.available ? "自动签到暂不可用。" : "暂无自动签到记录"}
					</p>
				)}
			</section>
		</section>
	);
}
