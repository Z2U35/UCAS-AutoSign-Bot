"use client";

import type { FormEvent } from "react";
import { ArrowRight, CalendarClock, CalendarDays, Check, Clock3, ExternalLink, LockKeyhole, Search, UserRound, X } from "lucide-react";
import { Button, SectionHeading, StatusNotice, type StatusKind } from "./editorial-ui";
import SignInCode, { type SignInCodeProps } from "./sign-in-code";
import AutoSignPanel from "./auto-sign-panel";
import { canCancelAutoSignTask, getAutoSignStatusLabel, type AutoSignController } from "./use-auto-sign";

export type CourseItem = {
	id: string;
	uuid: string;
	courseName: string;
	teacherName: string;
	weekDay: string;
	classBeginTime: string;
	classEndTime: string;
	signStatus: string;
};
export type FeatureMode = "query" | "manual";

type QueryView = {
	students: { id: string; name: string }[];
	accountId: string;
	studentId: string;
	date: string;
	keyword: string;
	courses: CourseItem[];
	total: number;
	selectedUuid: string;
	loading: boolean;
	attempted: boolean;
	emptyHelp: string;
	statusKind: StatusKind;
	statusText: string;
	autoSignContextMatches: boolean;
};

type CourseWorkspaceProps = {
	mode: FeatureMode;
	query: QueryView;
	autoSign: AutoSignController;
	manualIdentifier: string;
	manualLoading: boolean;
	busy: boolean;
	logoutPending: boolean;
	signCode: SignInCodeProps;
	onModeChange: (mode: FeatureMode) => void;
	onSelectAccount: (accountId: string) => void;
	onStudentIdChange: (studentId: string) => void;
	onDateChange: (date: string) => void;
	onKeywordChange: (keyword: string) => void;
	onManualIdentifierChange: (identifier: string) => void;
	onQuery: (event: FormEvent<HTMLFormElement>) => void;
	onManualGenerate: (event: FormEvent<HTMLFormElement>) => void;
	onPickCourse: (uuid: string, courseId: string) => void;
	onScheduleAutoSign: (courseId: string) => void;
	onLogout: () => void;
};

function formatCourseTime(value: string): string {
	return value.match(/(\d{2}:\d{2})(?::\d{2})?$/)?.[1] || value || "--";
}

function CourseRow({ course, selected, disabled, onPick, autoSign, accountId, courseDate, canSchedule, onSchedule }: {
	course: CourseItem;
	selected: boolean;
	disabled: boolean;
	onPick: () => void;
	autoSign: AutoSignController;
	accountId: string;
	courseDate: string;
	canSchedule: boolean;
	onSchedule: () => void;
}) {
	const signed = course.signStatus === "1";
	const occurrenceTasks = (autoSign.snapshot?.tasks ?? [])
		.filter((task) => task.accountId === accountId && task.courseDate === courseDate && task.courseSchedId === course.id)
		.sort((firstTask, secondTask) => secondTask.updatedAt - firstTask.updatedAt);
	const currentTask = occurrenceTasks.find((task) => canCancelAutoSignTask(task) || task.status === "submitting") ?? occurrenceTasks[0];
	const cancellable = currentTask && canCancelAutoSignTask(currentTask);
	const submitting = currentTask?.status === "submitting";
	const alreadyProcessed = currentTask?.status === "succeeded" || currentTask?.status === "dry_run" || currentTask?.resultCode === "ALREADY_SIGNED";
	const uncertain = currentTask?.status === "uncertain";
	const previewing = autoSign.operation?.kind === "preview" && autoSign.operation.targetId === course.id;
	const cancelling = autoSign.operation?.kind === "cancel" && autoSign.operation.targetId === currentTask?.id;
	const autoSignBusy = disabled || Boolean(autoSign.operation);
	return (
		<article className={`course-item ${selected ? "course-item--selected" : ""}`}>
			<div className="flex items-start justify-between gap-3">
				<h3 className="course-heading break-words">{course.courseName || "未命名课程"}</h3>
				<span className={`status-chip inline-flex shrink-0 items-center gap-1 border px-2 py-1 text-xs ${signed ? "status-chip--signed" : "status-chip--unsigned"}`}>
					{signed && <Check aria-hidden="true" size={12} strokeWidth={1.5} />}{signed ? "已签到" : "未签到"}
				</span>
			</div>
			<div className="mt-4 flex flex-wrap items-end justify-between gap-4">
				<dl className="grid gap-2 text-xs text-[color:var(--muted)]">
					<div className="flex items-center gap-2"><dt><span className="sr-only">教师</span><UserRound aria-hidden="true" size={14} strokeWidth={1.5} /></dt><dd>{course.teacherName || "教师待定"}</dd></div>
					<div className="flex items-center gap-2"><dt><span className="sr-only">上课时间</span><Clock3 aria-hidden="true" size={14} strokeWidth={1.5} /></dt><dd className="font-mono numeric-tabular">{formatCourseTime(course.classBeginTime)} — {formatCourseTime(course.classEndTime)}</dd></div>
				</dl>
				<Button variant={selected ? "primary" : "secondary"} onClick={onPick} disabled={disabled} aria-pressed={selected} className="w-full sm:w-auto">
					{selected ? "已选中" : "生成签到码"}<ArrowRight aria-hidden="true" size={16} strokeWidth={1.5} />
				</Button>
			</div>
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--line-soft)] pt-3">
				<p className="field-help">{currentTask ? `自动签到：${getAutoSignStatusLabel(currentTask.status)}` : "自动签到需单独确认"}</p>
				{cancellable ? (
					<Button variant="secondary" className="w-full sm:w-auto" disabled={!autoSign.ready || autoSignBusy}
						aria-label={`取消${course.courseName}本次自动签到`} onClick={() => void autoSign.cancelTask(currentTask.id)}>
						<X aria-hidden="true" size={14} strokeWidth={1.5} />{cancelling ? "正在取消..." : "取消自动签到"}
					</Button>
				) : (
					<Button variant="secondary" className="w-full sm:w-auto" onClick={onSchedule}
						disabled={!canSchedule || autoSignBusy || signed || submitting || uncertain || alreadyProcessed || !course.id}
						aria-describedby="course-auto-sign-hint">
						<CalendarClock aria-hidden="true" size={14} strokeWidth={1.5} />
						{previewing ? "正在获取确认信息..." : submitting ? "正在提交，无法撤回" : uncertain ? "结果待核实，请勿重复安排" : alreadyProcessed ? "本次任务已处理" : "安排自动签到"}
					</Button>
				)}
			</div>
		</article>
	);
}

export default function CourseWorkspace({ mode, query, autoSign, manualIdentifier, manualLoading, busy,
	logoutPending, signCode, onModeChange, onSelectAccount, onStudentIdChange, onDateChange,
	onKeywordChange, onManualIdentifierChange, onQuery, onManualGenerate, onPickCourse, onScheduleAutoSign, onLogout }: CourseWorkspaceProps) {
	const selectedAccount = query.students.find((student) => student.id === query.accountId);
	const selectedAutoSignAccount = autoSign.snapshot?.accounts.find((account) => account.accountId === query.accountId);
	const canScheduleAutoSign = autoSign.ready && Boolean(selectedAutoSignAccount?.enabled) && query.autoSignContextMatches;
	return (
		<div className="newsprint-shell">
			<div className="newsprint-container">
				<a href="#main-content" className="skip-link sr-only focus:not-sr-only">跳到主要内容</a>
				<header className="editorial-masthead">
					<div className="edition-strip">
						<span>VOL. 01 / UCAS</span>
						<span>国科大 · 课程签到</span>
						<time dateTime={query.date}>{query.date.replaceAll("-", ".")}</time>
					</div>
					<div className="masthead-layout">
						<div>
							<p className="section-kicker">THE CAMPUS EDITION</p>
							<h1 className="masthead-title">The UCAS<br /><em>Course Journal.</em></h1>
						</div>
						<div className="masthead-sidebar">
							<h2 className="font-serif text-2xl font-bold">每一课，都在此。</h2>
							<p className="masthead-deck mt-3 text-justify first-letter:float-left first-letter:mr-2 first-letter:font-serif first-letter:text-5xl first-letter:leading-none">
								从学号开始，找到今天的课程。查询、选课、生成签到码，让课前的每一步井然有序。
							</p>
							<p className="mt-5 border-t border-[color:var(--line)] pt-3 font-mono text-[10px] tracking-widest">STUDENT ID IN. SCHEDULE OUT.</p>
						</div>
					</div>
					<nav className="editorial-navigation" aria-label="签到方式">
						<button className="editorial-nav-button" type="button" aria-pressed={mode === "query"} disabled={busy} onClick={() => onModeChange("query")}>01 / 查询课程</button>
						<button className="editorial-nav-button" type="button" aria-pressed={mode === "manual"} disabled={busy} onClick={() => onModeChange("manual")}>02 / 手动生成</button>
						<Button variant="quiet" className="ml-auto" onClick={onLogout} disabled={busy || logoutPending}>
							<LockKeyhole aria-hidden="true" size={14} strokeWidth={1.5} /><span>{logoutPending ? "锁定中..." : "退出并锁定"}</span>
						</Button>
					</nav>
				</header>
				<main id="main-content" tabIndex={-1} className="editorial-workspace">
					{mode === "query" ? (
						<form onSubmit={onQuery} autoComplete="on" className="query-panel editorial-panel">
							<SectionHeading number="01" label="IDENTITY" title="从这里开始" />
							<p className="section-description mt-2">选择快捷账号，或输入你的学号。</p>
							<div className="mt-6 space-y-5">
								<fieldset disabled={busy}>
									<legend className="field-label">快速登录 / QUICK ACCESS</legend>
									<div className="mt-3 flex flex-wrap gap-2">
										{query.students.map((student) => (
											<button key={student.id} className="account-chip" type="button" aria-pressed={query.accountId === student.id} onClick={() => onSelectAccount(student.id)}>
												<span className="account-avatar" aria-hidden="true">{student.name.slice(0, 1).toUpperCase()}</span>{student.name}
											</button>
										))}
										<button className="account-chip" type="button" aria-pressed={!query.accountId} onClick={() => onSelectAccount("")}>其他学号</button>
									</div>
								</fieldset>
								{!query.accountId ? (
									<div>
										<label className="editorial-field">
											<span className="field-label">学号 / STUDENT ID</span>
											<input className="input-surface focus-ring mt-2" name="studentId" autoComplete="username"
												value={query.studentId} onChange={(event) => onStudentIdChange(event.target.value)}
												disabled={busy} inputMode="numeric" pattern="[0-9]{15}" maxLength={15} required spellCheck={false}
												placeholder="请输入15位学号" title="请输入15位数字学号" aria-describedby="credential-hint" />
										</label>
									</div>
								) : <p className="account-selection p-3 text-sm leading-6">当前账号 <strong className="font-mono">{selectedAccount?.name}</strong><br /><span className="field-help">使用服务端配置的学号。</span></p>}
								<label className="editorial-field">
									<span className="field-label">课程日期 / DATE</span>
									<input className="input-surface focus-ring mt-2" type="date" name="courseDate" value={query.date}
										onChange={(event) => onDateChange(event.target.value)} required disabled={busy} />
								</label>
								<Button type="submit" className="w-full" disabled={busy}><Search aria-hidden="true" size={16} strokeWidth={1.5} />{query.loading ? "正在查询..." : "查询课程"}<ArrowRight aria-hidden="true" size={16} strokeWidth={1.5} className="ml-auto" /></Button>
								<p id="credential-hint" className="field-help">统一密码由服务端使用，无需填写。<br />仅使用本人或已获授权的账号。</p>
								<a href="#auto-sign-panel" className="focus-ring inline-flex min-h-11 items-center gap-2 text-xs underline underline-offset-4"><CalendarClock aria-hidden="true" size={14} strokeWidth={1.5} />自动签到与记录</a>
								<StatusNotice kind={query.statusKind}>{query.statusText}</StatusNotice>
							</div>
						</form>
					) : (
						<form onSubmit={onManualGenerate} className="query-panel editorial-panel">
							<SectionHeading number="01" label="MANUAL ENTRY" title="已有课程编号？" />
							<p className="section-description mt-2">跳过查询，直接生成签到码。</p>
							<div className="mt-6 space-y-5">
								<label className="editorial-field"><span className="field-label">课程 ID / UUID</span>
									<input className="input-surface focus-ring mt-2" name="manualCourseIdentifier" value={manualIdentifier}
										onChange={(event) => onManualIdentifierChange(event.target.value)} placeholder="7位课程ID或32位UUID"
										autoComplete="off" required spellCheck={false} disabled={manualLoading} aria-describedby="identifier-help" />
								</label>
								<p id="identifier-help" className="field-help">课程ID为7位数字，UUID为32位十六进制字符串。手动生成不支持自动签到，已有服务端任务仍可在下方面板管理。</p>
								<Button className="w-full" type="submit" disabled={manualLoading}>{manualLoading ? "生成中..." : "生成签到码"}<ArrowRight aria-hidden="true" size={16} strokeWidth={1.5} /></Button>
								<StatusNotice kind={query.statusKind}>{query.statusText}</StatusNotice>
							</div>
						</form>
					)}
					<div className="min-w-0">
						{mode === "query" && (
							<section className="editorial-panel" aria-label="课程查询结果" aria-busy={query.loading}>
								<SectionHeading number="02" label="THE SCHEDULE" title="课程一览" detail={`${String(query.total).padStart(2, "0")} COURSES`} />
								<p id="course-auto-sign-hint" className="field-help mb-4">
									{!query.accountId ? "自动签到仅支持快捷账号。"
										: !autoSign.snapshot ? "正在读取自动签到设置。"
											: !autoSign.ready ? "自动签到暂不可用。"
												: !selectedAutoSignAccount?.enabled ? "请先启用当前账号的自动签到权限。"
													: "已启用权限，请逐课确认安排。"}
									{" "}<a href="#auto-sign-panel" className="focus-ring underline underline-offset-4">权限与记录</a>
								</p>
								{query.total > 0 && <label className="editorial-field mt-4"><span className="sr-only">筛选课程</span><input className="input-surface focus-ring" name="courseFilter" placeholder="搜索课程或教师" value={query.keyword} onChange={(event) => onKeywordChange(event.target.value)} /></label>}
								<div className="course-list mt-5">
									{query.courses.length ? query.courses.map((course) => (
										<CourseRow key={`${course.id}-${course.uuid}`} course={course} selected={query.selectedUuid === course.uuid}
											disabled={busy} onPick={() => onPickCourse(course.uuid, course.id)} autoSign={autoSign}
											accountId={query.accountId} courseDate={query.date} canSchedule={canScheduleAutoSign}
											onSchedule={() => onScheduleAutoSign(course.id)} />
									)) : (
										<div className="empty-state py-10 text-center">
											<CalendarDays aria-hidden="true" size={36} strokeWidth={1} className="mx-auto mb-4" />
											<h3 className="font-serif text-2xl font-bold">{query.loading ? "正在获取课程" : query.attempted ? "没有找到课程" : "课表，等待翻开。"}</h3>
											<p className="field-help mx-auto mt-3 max-w-sm">{query.loading ? "正在连接教务服务，请稍等片刻。" : query.attempted ? query.emptyHelp : "选择账号并查询，课程时间与签到状态将呈现在这里。"}</p>
										</div>
									)}
								</div>
							</section>
						)}
						<SignInCode {...signCode} />
					</div>
					<AutoSignPanel controller={autoSign} />
				</main>
				<footer className="editorial-footer">
					<div><strong className="font-serif text-lg">The UCAS Course Journal.</strong><p className="mt-1 font-mono text-[10px] tracking-widest">PRIVATE EDITION / VOL. 01</p></div>
					<p className="text-xs">为每一次课前准备。仅供授权使用。</p>
					<a className="editorial-source-link inline-flex min-h-11 items-center gap-2 text-xs" href="https://github.com/Z2U35/UCAS-AutoSign-Bot" target="_blank" rel="noreferrer">SOURCE / GITHUB<ExternalLink aria-hidden="true" size={14} strokeWidth={1.5} /></a>
				</footer>
			</div>
		</div>
	);
}
