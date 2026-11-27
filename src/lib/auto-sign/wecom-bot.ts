import "server-only";
import { readPrivateConfig, type PrivateConfig, type StudentAccount } from "../private-config.ts";
import { getIclassTimestamp, IclassError, loginIclass, queryIclassSchedule, submitIclassSign, type IclassCourse } from "../iclass.ts";
import { getAutoSignMode, getAutoSignStore, isAutoSignConfigured } from "./environment.ts";
import { resolveDirectWeComTarget, sendWeComNotification, type WeComInboundMessage } from "./notify.ts";
import { AutoSignStore, getStudentIdentity } from "./store.ts";
import { calculateOccurrence, calculateScheduleOffsetSeconds, normalizeCourseDate, SCHOOL_TIME_ZONE } from "./time.ts";
import { AutoSignError, type AutoSignMode, type AutoSignPreview, type AutoSignTask } from "./types.ts";

const DEDUPE_TTL_MS = 10 * 60_000;
const DEDUPE_MAX_ENTRIES = 500;
const USER_WINDOW_MS = 5 * 60_000;
const USER_WINDOW_MAX = 20;
const USER_MAX_CONCURRENT = 2;

const CANCELLABLE_TASK_STATUSES = new Set(["pending", "preparing", "retry_wait"]);
const ACTIVE_TASK_STATUSES = new Set(["pending", "preparing", "retry_wait", "submitting", "uncertain"]);

const RESERVED_KEYWORDS = new Set([
	"all", "today", "td", "tomorrow", "tmr", "yesterday",
	"全部", "今天", "今日", "明天", "明日", "后天", "昨天", "昨日",
]);

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
	pending: "⏳ 待执行",
	preparing: "🔄 准备中",
	retry_wait: "🔁 等待重试",
	submitting: "🚀 提交中",
	uncertain: "❓ 待核实",
	succeeded: "✅ 签到成功",
	skipped: "✅ 课表已签",
	cancelled: "🚫 已取消",
	paused: "⚠️ 已暂停",
	expired: "⌛ 超时未签",
	dry_run: "🧪 演练完成",
	failed: "❌ 执行失败",
};

const AUTO_SIGN_ERROR_TEXT: Readonly<Record<string, string>> = {
	AUTO_SIGN_NOT_CONFIGURED: "服务端未配置自动签到数据库",
	PLANNED_TIME_PASSED: "已过自动预约时间窗口（开课前 6～10 分钟）",
	TASK_ALREADY_COMPLETED: "该课程已有完成记录，无需重复预约",
	DUPLICATE_ACCOUNT_TASK: "该学号已通过其他账号别名预约了本节课",
	TASK_RETENTION_BUSY: "当前有任务正在提交签到，请几秒后再试",
	TASK_NOT_FOUND: "未找到对应的任务记录",
	TASK_NOT_CANCELLABLE: "该任务已提交或已结束，无法取消",
	RECONFIRM_REQUIRED: "课程时间或运行模式已变更，请重新预约",
	INVALID_DATE: "日期格式无效（支持 +1、明天、11-28 或 2026-11-28）",
};

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: SCHOOL_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

const timeHmsFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: SCHOOL_TIME_ZONE,
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

const timeHmFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: SCHOOL_TIME_ZONE,
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

export type WeComBotDependencies = {
	now: () => number;
	readConfig: () => Promise<PrivateConfig>;
	getStore: () => AutoSignStore | null;
	getMode: () => AutoSignMode;
	getScheduleOffsetSeconds: typeof calculateScheduleOffsetSeconds;
	login: typeof loginIclass;
	querySchedule: typeof queryIclassSchedule;
	getTimestamp: typeof getIclassTimestamp;
	submitSign: typeof submitIclassSign;
	sendReply: typeof sendWeComNotification;
};

export const defaultWeComBotDependencies: WeComBotDependencies = {
	now: Date.now,
	readConfig: readPrivateConfig,
	getStore: () => (isAutoSignConfigured() ? getAutoSignStore() : null),
	getMode: getAutoSignMode,
	getScheduleOffsetSeconds: calculateScheduleOffsetSeconds,
	login: loginIclass,
	querySchedule: queryIclassSchedule,
	getTimestamp: getIclassTimestamp,
	submitSign: submitIclassSign,
	sendReply: sendWeComNotification,
};

type UserRateState = {
	windowStartedAt: number;
	count: number;
	active: number;
};

function formatShanghaiDate(epochMs: number): string {
	const parts = shanghaiDateFormatter.formatToParts(new Date(epochMs));
	const year = parts.find((part) => part.type === "year")?.value ?? "1970";
	const month = parts.find((part) => part.type === "month")?.value ?? "01";
	const day = parts.find((part) => part.type === "day")?.value ?? "01";
	return `${year}-${month}-${day}`;
}

function addDaysToDateString(yyyyMmDd: string, offsetDays: number): string {
	const baseUtc = Date.parse(`${yyyyMmDd}T00:00:00Z`);
	return new Date(baseUtc + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function getWeekdayLabel(yyyyMmDd: string): string {
	const index = new Date(`${yyyyMmDd}T00:00:00Z`).getUTCDay();
	return WEEKDAYS[index] ?? "";
}

export function parseBotDateToken(rawToken: string, nowMs: number): string | null {
	const token = rawToken.trim().toLowerCase();
	if (!token) return null;
	const today = formatShanghaiDate(nowMs);
	if (token === "today" || token === "td" || token === "今天" || token === "今日" || token === "+0" || token === "-0") {
		return today;
	}
	if (token === "tomorrow" || token === "tmr" || token === "明天" || token === "明日" || token === "+1") {
		return addDaysToDateString(today, 1);
	}
	if (token === "后天" || token === "+2") {
		return addDaysToDateString(today, 2);
	}
	if (token === "yesterday" || token === "昨天" || token === "昨日" || token === "-1") {
		return addDaysToDateString(today, -1);
	}
	if (/^[+-]\d{1,2}$/.test(token)) {
		const offset = Number(token);
		if (Math.abs(offset) <= 60) return addDaysToDateString(today, offset);
		return null;
	}
	if (/^20\d{2}-\d{2}-\d{2}$/.test(token) || /^20\d{6}$/.test(token)) {
		try {
			return normalizeCourseDate(token);
		} catch {
			return null;
		}
	}
	const shortSepMatch = /^(\d{1,2})[-/.](\d{1,2})$/.exec(token);
	if (shortSepMatch) {
		const candidate = `${today.slice(0, 4)}-${shortSepMatch[1].padStart(2, "0")}-${shortSepMatch[2].padStart(2, "0")}`;
		try {
			return normalizeCourseDate(candidate);
		} catch {
			return null;
		}
	}
	if (/^\d{4}$/.test(token)) {
		const candidate = `${today.slice(0, 4)}-${token.slice(0, 2)}-${token.slice(2, 4)}`;
		try {
			return normalizeCourseDate(candidate);
		} catch {
			return null;
		}
	}
	return null;
}

function parseIndexSelectionToken(rawToken: string): "all" | number[] | null {
	const token = rawToken.trim().toLowerCase();
	if (token === "all" || token === "全部" || token === "*") return "all";
	if (!/^\d{1,2}(?:[,，]\d{1,2})*$/.test(token)) return null;
	const parts = token.split(/[,，]/);
	const indices: number[] = [];
	for (const part of parts) {
		const value = Number(part);
		if (!Number.isInteger(value) || value < 1 || value > 30) return null;
		if (!indices.includes(value)) indices.push(value);
	}
	return indices.length > 0 ? indices : null;
}

function extractClockHm(rawTime: string): string {
	const match = /(\d{2}):(\d{2})(?::\d{2})?$/.exec(rawTime.trim());
	return match ? `${match[1]}:${match[2]}` : rawTime.trim();
}

function clockSortMinutes(rawTime: string): number {
	const match = /(\d{2}):(\d{2})(?::\d{2})?$/.exec(rawTime.trim());
	if (!match) return 9999;
	return Number(match[1]) * 60 + Number(match[2]);
}

function sortCoursesDeterministically(courses: IclassCourse[]): IclassCourse[] {
	return [...courses].sort((left, right) =>
		clockSortMinutes(left.classBeginTime) - clockSortMinutes(right.classBeginTime)
		|| left.id.localeCompare(right.id),
	);
}

function collectAdminIds(config: PrivateConfig): string[] {
	const wecom = config.wecom;
	if (!wecom) return [];
	const list: string[] = [];
	if (typeof wecom.adminUserId === "string" && wecom.adminUserId.trim()) {
		list.push(wecom.adminUserId.trim());
	}
	if (Array.isArray(wecom.adminUserIds)) {
		for (const id of wecom.adminUserIds) {
			if (typeof id === "string" && id.trim()) list.push(id.trim());
		}
	}
	return [...new Set(list)];
}

function findStudentByAlias(config: PrivateConfig, token: string): StudentAccount | null {
	const lower = token.trim().toLowerCase();
	if (!lower || RESERVED_KEYWORDS.has(lower)) return null;
	return config.students.find(
		(student) => student.name.toLowerCase() === lower || student.id.toLowerCase() === lower,
	) ?? null;
}

function formatFriendlyError(error: unknown): string {
	if (error instanceof AutoSignError) {
		return AUTO_SIGN_ERROR_TEXT[error.code] ?? `操作未完成（${error.code}）`;
	}
	if (error instanceof IclassError) {
		return error.message || `国科大接口异常（${error.code}）`;
	}
	return "服务暂时不可用，请稍后再试";
}

export class WeComBotService {
	private dependencies: WeComBotDependencies;
	private seenMessages = new Map<string, number>();
	private userRateMap = new Map<string, UserRateState>();

	constructor(dependencies: WeComBotDependencies = defaultWeComBotDependencies) {
		this.dependencies = dependencies;
	}

	private checkAndRecordDedupe(dedupeKey: string, now: number): boolean {
		for (const [key, seenAt] of this.seenMessages) {
			if (now - seenAt > DEDUPE_TTL_MS) this.seenMessages.delete(key);
		}
		if (this.seenMessages.has(dedupeKey)) return false;
		while (this.seenMessages.size >= DEDUPE_MAX_ENTRIES) {
			const oldestKey = this.seenMessages.keys().next().value;
			if (oldestKey === undefined) break;
			this.seenMessages.delete(oldestKey);
		}
		this.seenMessages.set(dedupeKey, now);
		return true;
	}

	private acquireUserSlot(fromUser: string, now: number): boolean {
		const key = fromUser.toLowerCase();
		const state = this.userRateMap.get(key) ?? { windowStartedAt: now, count: 0, active: 0 };
		if (now - state.windowStartedAt >= USER_WINDOW_MS) {
			state.windowStartedAt = now;
			state.count = 0;
		}
		if (state.active >= USER_MAX_CONCURRENT || state.count >= USER_WINDOW_MAX) {
			this.userRateMap.set(key, state);
			return false;
		}
		state.count += 1;
		state.active += 1;
		this.userRateMap.set(key, state);
		return true;
	}

	private releaseUserSlot(fromUser: string): void {
		const state = this.userRateMap.get(fromUser.toLowerCase());
		if (state && state.active > 0) state.active -= 1;
	}

	async processInboundMessage(
		config: PrivateConfig,
		message: WeComInboundMessage,
	): Promise<{ status: "ignored" | "duplicate" | "replied" | "send_failed"; reply: string | null }> {
		if (message.msgType !== "text") return { status: "ignored", reply: null };
		const trimmed = message.content.trim();
		const normalized = trimmed.startsWith("／") ? `/${trimmed.slice(1)}` : trimmed;
		if (!normalized.startsWith("/")) return { status: "ignored", reply: null };

		const now = this.dependencies.now();
		const dedupeKey = message.msgId
			? `id:${message.msgId}`
			: `fb:${message.fromUser}:${message.createTime}:${normalized}`;
		if (!this.checkAndRecordDedupe(dedupeKey, now)) {
			return { status: "duplicate", reply: null };
		}

		let reply: string;
		if (!this.acquireUserSlot(message.fromUser, now)) {
			reply = "⏳ 指令发送过于频繁，请稍后再试。";
		} else {
			try {
				reply = await this.executeSlashCommand(config, message.fromUser, normalized);
			} catch (error) {
				reply = `❌ ${formatFriendlyError(error)}`;
			} finally {
				this.releaseUserSlot(message.fromUser);
			}
		}

		const target = resolveDirectWeComTarget(config, message.fromUser);
		if (!target) return { status: "send_failed", reply };
		const sent = await this.dependencies.sendReply({ ...target, content: reply });
		return { status: sent ? "replied" : "send_failed", reply };
	}

	async executeSlashCommand(config: PrivateConfig, fromUser: string, normalizedInput: string): Promise<string> {
		const now = this.dependencies.now();
		const adminIds = collectAdminIds(config);
		const isAdmin = adminIds.some((id) => id.toLowerCase() === fromUser.toLowerCase());
		const selfAccount = config.students.find(
			(student) => student.wecomUserId && student.wecomUserId.toLowerCase() === fromUser.toLowerCase(),
		) ?? null;

		if (!isAdmin && !selfAccount) {
			return [
				"⚠️ 你的企业微信账号尚未绑定学号",
				`当前账号（wecomUserId）：${fromUser}`,
				"请将该账号发给管理员配置到 private.json 后再使用。",
			].join("\n");
		}

		const tokens = normalizedInput.trim().split(/\s+/).filter(Boolean);
		const rawCommand = (tokens[0] ?? "/help").slice(1).split("@")[0].toLowerCase();
		const args = tokens.slice(1);

		if (rawCommand === "" || rawCommand === "help" || rawCommand === "start" || rawCommand === "h") {
			return this.buildHelpText(fromUser, selfAccount, isAdmin);
		}
		if (rawCommand === "id" || rawCommand === "whoami" || rawCommand === "me") {
			return this.buildIdentityText(config, fromUser, selfAccount, isAdmin, now);
		}
		if (rawCommand === "c" || rawCommand === "courses" || rawCommand === "course" || rawCommand === "kb") {
			return this.handleCoursesCommand(config, selfAccount, isAdmin, args, now);
		}
		if (rawCommand === "a" || rawCommand === "auto") {
			return this.handleAutoCommand(config, selfAccount, isAdmin, args, now);
		}
		if (rawCommand === "s" || rawCommand === "sign") {
			return this.handleSignCommand(config, selfAccount, isAdmin, args, now);
		}
		if (rawCommand === "t" || rawCommand === "tasks" || rawCommand === "task") {
			return this.handleTasksCommand(config, selfAccount, isAdmin, args, now);
		}
		if (rawCommand === "cancel" || rawCommand === "unauto") {
			return this.handleCancelCommand(config, selfAccount, isAdmin, args, now);
		}
		if (rawCommand === "on" || rawCommand === "enable") {
			return this.handleSwitchCommand(config, selfAccount, isAdmin, args, true, now);
		}
		if (rawCommand === "off" || rawCommand === "disable") {
			return this.handleSwitchCommand(config, selfAccount, isAdmin, args, false, now);
		}

		return `❓ 未知指令「/${rawCommand}」，发送 /help 查看可用命令。`;
	}

	private buildHelpText(fromUser: string, selfAccount: StudentAccount | null, isAdmin: boolean): string {
		const who = selfAccount
			? `${selfAccount.name}${isAdmin ? "（管理员）" : ""}`
			: `${fromUser}（管理员，未绑个人学号）`;
		const lines = [
			"🤖 UCAS 课程与签到助手",
			`当前身份：${who}`,
			"",
			"常用指令：",
			"• /c [日期] — 查课表（默认今天，支持 +1 / 明天 / 11-28）",
			"• /a <序号|all> [日期] — 预约单次自动签到（如 /a 1 或 /a +1 all）",
			"• /s <序号> [日期] — 立即手动签到（如 /s 1）",
			"• /t — 查看自动签到任务与进度",
			"• /cancel <序号|all> — 取消待执行的自动签到",
			"• /off 与 /on — 关闭或开启自动签到总开关",
			"• /id — 查看当前账号绑定状态",
		];
		if (isAdmin) {
			lines.push("", "管理员附加用法：可在命令中加学生缩写操作任意账号，如 /c zxy、/a zxy 1 +1、/s zxy 1、/t zxy。");
		}
		return lines.join("\n");
	}

	private buildIdentityText(
		config: PrivateConfig,
		fromUser: string,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		now: number,
	): string {
		const store = this.dependencies.getStore();
		let switchLabel = "未配置调度数据库";
		if (store && selfAccount) {
			store.synchronizeAccounts(config.students, now);
			const enabled = store.isAccountEnabled(selfAccount.id, getStudentIdentity(selfAccount.studentId));
			switchLabel = enabled ? "✅ 已开启" : "🚫 已关闭";
		}
		return [
			"🪪 账号绑定信息",
			`企微账号：${fromUser}`,
			`权限角色：${isAdmin ? "管理员" : "普通成员"}`,
			`绑定缩写：${selfAccount ? selfAccount.name : "未绑定个人学号"}`,
			...(selfAccount ? [`自动签到开关：${switchLabel}`] : []),
		].join("\n");
	}

	private resolveAccountChoice(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		explicitAliasToken: string | null,
	): { ok: true; account: StudentAccount } | { ok: false; message: string } {
		if (explicitAliasToken !== null) {
			const matched = findStudentByAlias(config, explicitAliasToken);
			if (!isAdmin) {
				if (matched && selfAccount && matched.id === selfAccount.id) {
					return { ok: true, account: selfAccount };
				}
				return {
					ok: false,
					message: `⛔ 权限不足：你只能查询和操作自己绑定的账号（${selfAccount?.name ?? "未绑定"}）。`,
				};
			}
			if (!matched) {
				const available = config.students.map((s) => s.name).join(", ") || "无";
				return { ok: false, message: `❓ 未找到账号缩写「${explicitAliasToken}」\n可用账号：${available}` };
			}
			return { ok: true, account: matched };
		}

		if (selfAccount) return { ok: true, account: selfAccount };
		const exampleName = config.students[0]?.name ?? "zs";
		return {
			ok: false,
			message: `ℹ️ 你的管理员账号未绑定个人学号，请在指令中指定账号缩写，例如：/c ${exampleName}`,
		};
	}

	private async handleCoursesCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		now: number,
	): Promise<string> {
		if (args.length > 2) {
			return "用法：/c [日期]\n示例：/c、/c +1、/c 明天、/c 11-28";
		}
		let dateStr: string | null = null;
		let aliasToken: string | null = null;

		for (const token of args) {
			const parsedDate = parseBotDateToken(token, now);
			if (parsedDate && dateStr === null) {
				dateStr = parsedDate;
			} else if (aliasToken === null) {
				aliasToken = token;
			} else {
				return "❓ 参数格式无法识别，发送 /c 或 /c +1 查询课表。";
			}
		}

		if (aliasToken !== null && !isAdmin) {
			const matched = findStudentByAlias(config, aliasToken);
			if (!matched || !selfAccount || matched.id !== selfAccount.id) {
				if (matched && (!selfAccount || matched.id !== selfAccount.id)) {
					return `⛔ 权限不足：你只能查询和操作自己绑定的账号（${selfAccount?.name ?? "未绑定"}）。`;
				}
				return `❓ 无法识别日期「${aliasToken}」\n支持格式：今天、明天、+1、11-28、2026-11-28`;
			}
		}

		const resolved = this.resolveAccountChoice(config, selfAccount, isAdmin, aliasToken);
		if (!resolved.ok) return resolved.message;
		const account = resolved.account;
		const today = formatShanghaiDate(now);
		const targetDate = dateStr ?? today;

		const session = await this.dependencies.login(account.studentId, config.studentPassword);
		const rawCourses = await this.dependencies.querySchedule(session, targetDate.replaceAll("-", ""));
		const courses = sortCoursesDeterministically(rawCourses);
		const weekday = getWeekdayLabel(targetDate);

		if (courses.length === 0) {
			return `📅 ${account.name}｜${targetDate}（${weekday}）\n当天没有课程安排。`;
		}

		const store = this.dependencies.getStore();
		const identity = getStudentIdentity(account.studentId);
		if (store) store.synchronizeAccounts(config.students, now);

		const lines = [`📅 课表｜${account.name}｜${targetDate}（${weekday}）`, ""];
		let hasUnsigned = false;

		for (let i = 0; i < courses.length; i += 1) {
			const course = courses[i];
			const idx = i + 1;
			const timeSpan = `${extractClockHm(course.classBeginTime)}-${extractClockHm(course.classEndTime)}`;
			const signText = course.signStatus === "1"
				? "✅ 已签到"
				: course.signStatus === "0"
					? "⏳ 未签到"
					: `❓ 状态(${course.signStatus || "未知"})`;
			if (course.signStatus === "0") hasUnsigned = true;

			let taskHint = "";
			if (store) {
				const task = store.getOccurrenceTask(identity, targetDate, course.id);
				if (task && task.deletedAt === null) {
					if (CANCELLABLE_TASK_STATUSES.has(task.status)) {
						taskHint = `｜⏰ 已约 ${timeHmsFormatter.format(new Date(task.scheduledAt))}`;
					} else if (task.status === "submitting" || task.status === "uncertain") {
						taskHint = `｜${TASK_STATUS_LABELS[task.status]}`;
					}
				}
			}

			const teacherPart = course.teacherName ? `｜${course.teacherName}` : "";
			lines.push(`[${idx}] ${timeSpan} ${course.courseName}`);
			lines.push(`    ${signText}${taskHint}${teacherPart}`);
		}

		if (hasUnsigned) {
			const accountArg = isAdmin && (!selfAccount || account.id !== selfAccount.id) ? ` ${account.name}` : "";
			const dateArg = targetDate === today ? "" : ` ${targetDate}`;
			lines.push(
				"",
				"快捷操作：",
				`• 预约自动签：/a${accountArg} <序号|all>${dateArg}`,
				`• 立即手动签：/s${accountArg} <序号>${dateArg}`,
			);
		}
		return lines.join("\n");
	}

	private async handleAutoCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		now: number,
	): Promise<string> {
		const store = this.dependencies.getStore();
		if (!store) return "⚠️ 服务端未配置自动签到数据库，暂不支持 /a 预约。";
		if (args.length === 0 || args.length > 3) {
			return "用法：/a <课程序号|all> [日期]\n示例：先发 /c 查看序号，再发 /a 1 或 /a +1 all";
		}

		let selection: "all" | number[] | null = null;
		let dateStr: string | null = null;
		let aliasToken: string | null = null;

		for (const token of args) {
			const parsedSelection: "all" | number[] | null = selection === null ? parseIndexSelectionToken(token) : null;
			if (parsedSelection !== null) {
				selection = parsedSelection;
				continue;
			}
			const parsedDate: string | null = dateStr === null ? parseBotDateToken(token, now) : null;
			if (parsedDate !== null) {
				dateStr = parsedDate;
				continue;
			}
			if (aliasToken === null) {
				aliasToken = token;
				continue;
			}
			return "❓ 参数过多或无法识别，示例：/a 1 或 /a +1 all";
		}

		if (aliasToken !== null && !isAdmin) {
			const matched = findStudentByAlias(config, aliasToken);
			if (matched && (!selfAccount || matched.id !== selfAccount.id)) {
				return `⛔ 权限不足：你只能查询和操作自己绑定的账号（${selfAccount?.name ?? "未绑定"}）。`;
			}
			if (!matched) {
				return `❓ 无法识别参数「${aliasToken}」\n用法：/a <序号|all> [日期]（如 /a 1 或 /a +1 all）`;
			}
		}

		if (selection === null) {
			return "❓ 请指定要预约的课程序号或 all，例如：/a 1 或 /a all";
		}

		const resolved = this.resolveAccountChoice(config, selfAccount, isAdmin, aliasToken);
		if (!resolved.ok) return resolved.message;
		const account = resolved.account;
		const today = formatShanghaiDate(now);
		const targetDate = dateStr ?? today;
		const identity = getStudentIdentity(account.studentId);
		const mode = this.dependencies.getMode();

		store.synchronizeAccounts(config.students, now);
		const wasEnabled = store.isAccountEnabled(account.id, identity);
		if (!wasEnabled) {
			store.setAccountEnabled(account.id, identity, true, now);
		}

		const session = await this.dependencies.login(account.studentId, config.studentPassword);
		const courses = sortCoursesDeterministically(
			await this.dependencies.querySchedule(session, targetDate.replaceAll("-", "")),
		);

		if (courses.length === 0) {
			return `📅 ${account.name} 在 ${targetDate} 当天没有课程，无需预约。`;
		}

		const targetIndices = selection === "all"
			? courses.map((_, idx) => idx + 1)
			: selection;
		const invalidIndex = targetIndices.find((idx) => idx < 1 || idx > courses.length);
		if (invalidIndex !== undefined) {
			return `❌ 序号 [${invalidIndex}] 超出范围：${targetDate} 共有 ${courses.length} 节课（1～${courses.length}）。`;
		}

		const lines = [
			`⏰ 自动签到预约｜${account.name}｜${targetDate}${mode === "dry-run" ? "（演练模式）" : ""}`,
		];
		if (!wasEnabled) {
			lines.push(`ℹ️ 已自动开启「${account.name}」的自动签到总开关`);
		}
		lines.push("");

		const accountArg = isAdmin && (!selfAccount || account.id !== selfAccount.id) ? ` ${account.name}` : "";
		const dateArg = targetDate === today ? "" : ` ${targetDate}`;

		for (const idx of targetIndices) {
			const course = courses[idx - 1];
			const timeSpan = `${extractClockHm(course.classBeginTime)}-${extractClockHm(course.classEndTime)}`;

			if (course.signStatus === "1") {
				lines.push(`• [${idx}] ${course.courseName}（${timeSpan}）：✅ 已签到，跳过`);
				continue;
			}
			if (course.signStatus !== "0") {
				lines.push(`• [${idx}] ${course.courseName}（${timeSpan}）：⚠️ 上游签到状态异常(${course.signStatus})，无法预约`);
				continue;
			}

			const offsetSeconds = this.dependencies.getScheduleOffsetSeconds(identity, targetDate, course.id);
			const occurrence = calculateOccurrence(targetDate, course.classBeginTime, course.classEndTime, offsetSeconds);
			const existing = store.getOccurrenceTask(identity, targetDate, course.id);
			if (
				existing
				&& existing.accountId === account.id
				&& existing.classBeginAt === occurrence.classBeginAt
				&& existing.classEndAt === occurrence.classEndAt
			) {
				occurrence.scheduledAt = existing.scheduledAt;
				occurrence.deadlineAt = existing.deadlineAt;
			}

			if (existing && (existing.status === "succeeded" || existing.status === "skipped")) {
				lines.push(`• [${idx}] ${course.courseName}（${timeSpan}）：✅ 已完成签到，跳过`);
				continue;
			}
			if (existing && ACTIVE_TASK_STATUSES.has(existing.status) && occurrence.scheduledAt <= now) {
				const label = TASK_STATUS_LABELS[existing.status] ?? existing.status;
				lines.push(`• [${idx}] ${course.courseName}（${timeSpan}）：${label}`);
				continue;
			}
			if (occurrence.scheduledAt <= now) {
				lines.push(
					`• [${idx}] ${course.courseName}（${timeSpan}）：⌛ 已过预约窗口（${timeHmsFormatter.format(new Date(occurrence.scheduledAt))}），可发 /s${accountArg} ${idx}${dateArg} 手动签`,
				);
				continue;
			}

			const preview: AutoSignPreview = {
				accountId: account.id,
				accountName: account.name,
				courseDate: targetDate,
				courseSchedId: course.id,
				courseName: course.courseName,
				...occurrence,
			};
			try {
				const alreadyExisted = Boolean(existing && existing.deletedAt === null && CANCELLABLE_TASK_STATUSES.has(existing.status));
				const task = store.createTask(preview, identity, this.dependencies.now(), mode);
				const plannedClock = timeHmsFormatter.format(new Date(task.scheduledAt));
				lines.push(
					alreadyExisted
						? `• [${idx}] ${course.courseName}（${timeSpan}）：📌 已在队列（计划 ${plannedClock}）`
						: `• [${idx}] ${course.courseName}（${timeSpan}）：✅ 已预约（计划 ${plannedClock}）`,
				);
			} catch (error) {
				lines.push(`• [${idx}] ${course.courseName}（${timeSpan}）：❌ ${formatFriendlyError(error)}`);
			}
		}

		lines.push("", "发 /t 可查看待执行队列，发 /cancel <序号> 可随时取消。");
		return lines.join("\n");
	}

	private async handleSignCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		now: number,
	): Promise<string> {
		if (args.length === 0 || args.length > 3) {
			return "用法：/s <课程序号> [日期]\n示例：先发 /c 查看序号，再发 /s 1 立即手动签到";
		}

		let selection: "all" | number[] | null = null;
		let dateStr: string | null = null;
		let aliasToken: string | null = null;

		for (const token of args) {
			const parsedSelection: "all" | number[] | null = selection === null ? parseIndexSelectionToken(token) : null;
			if (parsedSelection !== null) {
				selection = parsedSelection;
				continue;
			}
			const parsedDate: string | null = dateStr === null ? parseBotDateToken(token, now) : null;
			if (parsedDate !== null) {
				dateStr = parsedDate;
				continue;
			}
			if (aliasToken === null) {
				aliasToken = token;
				continue;
			}
			return "❓ 参数无法识别，示例：/s 1";
		}

		if (aliasToken !== null && !isAdmin) {
			const matched = findStudentByAlias(config, aliasToken);
			if (matched && (!selfAccount || matched.id !== selfAccount.id)) {
				return `⛔ 权限不足：你只能查询和操作自己绑定的账号（${selfAccount?.name ?? "未绑定"}）。`;
			}
			if (!matched) {
				return `❓ 无法识别参数「${aliasToken}」，用法：/s <序号> [日期]`;
			}
		}

		if (selection === null || selection === "all") {
			return "❓ 手动签到请指定具体课程序号（不支持 all），例如：/s 1";
		}
		if (selection.length > 3) {
			return "⚠️ 单次手动签到最多同时指定 3 节课。";
		}

		const resolved = this.resolveAccountChoice(config, selfAccount, isAdmin, aliasToken);
		if (!resolved.ok) return resolved.message;
		const account = resolved.account;
		const targetDate = dateStr ?? formatShanghaiDate(now);

		const session = await this.dependencies.login(account.studentId, config.studentPassword);
		const courses = sortCoursesDeterministically(
			await this.dependencies.querySchedule(session, targetDate.replaceAll("-", "")),
		);
		if (courses.length === 0) {
			return `📅 ${account.name} 在 ${targetDate} 当天没有课程。`;
		}

		const invalidIndex = selection.find((idx) => idx < 1 || idx > courses.length);
		if (invalidIndex !== undefined) {
			return `❌ 序号 [${invalidIndex}] 超出范围：${targetDate} 共有 ${courses.length} 节课（1～${courses.length}）。`;
		}

		const store = this.dependencies.getStore();
		const identity = getStudentIdentity(account.studentId);
		if (store) store.synchronizeAccounts(config.students, now);

		const results: string[] = [];
		for (const idx of selection) {
			const course = courses[idx - 1];
			const timeSpan = `${extractClockHm(course.classBeginTime)}-${extractClockHm(course.classEndTime)}`;
			if (course.signStatus === "1") {
				results.push(`✅ [${idx}] ${course.courseName}（${timeSpan}）：课表已显示「已签到」，无需重复提交`);
				continue;
			}

			const schoolTimestamp = await this.dependencies.getTimestamp();
			const signResult = await this.dependencies.submitSign(session, course.id, schoolTimestamp);
			if (signResult.success) {
				let cancelledHint = "";
				if (store) {
					const existing = store.getOccurrenceTask(identity, targetDate, course.id);
					if (existing && CANCELLABLE_TASK_STATUSES.has(existing.status)) {
						try {
							store.cancelTask(existing.id, this.dependencies.now());
							cancelledHint = "（已同步取消原自动签到预约）";
						} catch {}
					}
				}
				results.push(`✅ [${idx}] ${course.courseName}（${timeSpan}）：签到成功${cancelledHint}`);
			} else {
				results.push(`❌ [${idx}] ${course.courseName}（${timeSpan}）：${signResult.message}`);
			}
		}

		return [`📝 手动签到结果｜${account.name}｜${targetDate}`, "", ...results].join("\n");
	}

	private getOrderedCancellableTasks(store: AutoSignStore, filterAccountId: string | null): AutoSignTask[] {
		return store
			.listTasks()
			.filter((task) => CANCELLABLE_TASK_STATUSES.has(task.status) && (!filterAccountId || task.accountId === filterAccountId))
			.sort((left, right) => left.scheduledAt - right.scheduledAt || left.id.localeCompare(right.id));
	}

	private handleTasksCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		now: number,
	): string {
		const store = this.dependencies.getStore();
		if (!store) return "⚠️ 服务端未配置自动签到数据库。";
		if (args.length > 1) return "用法：/t（管理员可发 /t <账号> 或 /t all）";

		store.synchronizeAccounts(config.students, now);

		let filterAccountId: string | null = null;
		let scopeTitle: string;

		if (!isAdmin) {
			if (!selfAccount) return "⛔ 未找到绑定账号。";
			if (args.length === 1) {
				const matched = findStudentByAlias(config, args[0]);
				if (!matched || matched.id !== selfAccount.id) {
					return `⛔ 权限不足：你只能查看自己绑定账号（${selfAccount.name}）的任务。`;
				}
			}
			filterAccountId = selfAccount.id;
			scopeTitle = selfAccount.name;
		} else if (args.length === 1 && args[0].toLowerCase() !== "all" && args[0] !== "全部") {
			const matched = findStudentByAlias(config, args[0]);
			if (!matched) {
				const available = config.students.map((s) => s.name).join(", ") || "无";
				return `❓ 未找到账号缩写「${args[0]}」\n可用账号：${available}`;
			}
			filterAccountId = matched.id;
			scopeTitle = matched.name;
		} else {
			filterAccountId = null;
			scopeTitle = "全部账号";
		}

		const allTasks = store.listTasks().filter((task) => !filterAccountId || task.accountId === filterAccountId);
		if (allTasks.length === 0) {
			return `📋 自动签到记录｜${scopeTitle}\n当前没有任何任务记录。`;
		}

		const cancellable = this.getOrderedCancellableTasks(store, filterAccountId);
		const inFlight = allTasks.filter((task) => task.status === "submitting" || task.status === "uncertain");
		const finished = allTasks.filter((task) => !ACTIVE_TASK_STATUSES.has(task.status)).slice(0, 5);

		const lines = [`📋 自动签到任务｜${scopeTitle}`];
		const showAccountTag = filterAccountId === null;

		if (cancellable.length > 0 || inFlight.length > 0) {
			lines.push("", "【待执行 / 进行中】");
			cancellable.forEach((task, index) => {
				const prefix = showAccountTag ? `${task.accountName}｜` : "";
				const classHm = timeHmFormatter.format(new Date(task.classBeginAt));
				const planHms = timeHmsFormatter.format(new Date(task.scheduledAt));
				const statusText = TASK_STATUS_LABELS[task.status] ?? task.status;
				lines.push(
					`[${index + 1}] ${prefix}${task.courseDate.slice(5)} ${classHm} ${task.courseName}`,
					`    ${statusText}｜计划 ${planHms}｜#${task.id.slice(0, 6)}`,
				);
			});
			for (const task of inFlight) {
				const prefix = showAccountTag ? `${task.accountName}｜` : "";
				const classHm = timeHmFormatter.format(new Date(task.classBeginAt));
				const statusText = TASK_STATUS_LABELS[task.status] ?? task.status;
				lines.push(`• ${prefix}${task.courseDate.slice(5)} ${classHm} ${task.courseName}（${statusText}）`);
			}
		} else {
			lines.push("", "当前没有待执行的自动签到任务。");
		}

		if (finished.length > 0) {
			lines.push("", "【最近结束】");
			for (const task of finished) {
				const prefix = showAccountTag ? `${task.accountName}｜` : "";
				const classHm = timeHmFormatter.format(new Date(task.classBeginAt));
				const statusText = TASK_STATUS_LABELS[task.status] ?? task.status;
				lines.push(`• ${prefix}${task.courseDate.slice(5)} ${classHm} ${task.courseName}：${statusText}`);
			}
		}

		if (cancellable.length > 0) {
			const cancelHint = filterAccountId && isAdmin && (!selfAccount || filterAccountId !== selfAccount.id)
				? `/cancel ${scopeTitle} 1`
				: "/cancel 1";
			lines.push("", `取消方式：发 ${cancelHint}（或用短码 /cancel #${cancellable[0].id.slice(0, 6)}）`);
		}
		return lines.join("\n");
	}

	private handleCancelCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		now: number,
	): string {
		const store = this.dependencies.getStore();
		if (!store) return "⚠️ 服务端未配置自动签到数据库。";
		if (args.length === 0 || args.length > 2) {
			return "用法：/cancel <任务序号|#短码|all>\n示例：先发 /t 查看序号，再发 /cancel 1";
		}

		store.synchronizeAccounts(config.students, now);

		let filterAccountId: string | null = !isAdmin && selfAccount ? selfAccount.id : null;
		let targetArg: string;

		if (args.length === 2) {
			const matched = findStudentByAlias(config, args[0]);
			if (!isAdmin) {
				if (!matched || !selfAccount || matched.id !== selfAccount.id) {
					return `⛔ 权限不足：你只能取消自己绑定账号（${selfAccount?.name ?? "未绑定"}）的任务。`;
				}
			} else if (!matched) {
				return `❓ 未找到账号缩写「${args[0]}」`;
			}
			filterAccountId = matched.id;
			targetArg = args[1];
		} else {
			targetArg = args[0];
		}

		const cancellable = this.getOrderedCancellableTasks(store, filterAccountId);
		if (cancellable.length === 0) {
			return "ℹ️ 当前没有可取消的待执行任务。";
		}

		const normalizedTarget = targetArg.trim().toLowerCase();
		if (normalizedTarget === "all" || normalizedTarget === "全部") {
			if (isAdmin && filterAccountId === null) {
				const distinctAccounts = new Set(cancellable.map((task) => task.accountId));
				if (distinctAccounts.size > 1 || (selfAccount && !distinctAccounts.has(selfAccount.id))) {
					return "⚠️ 为防误取消其他同学的预约，管理员批量取消请指定账号（如 /cancel zxy all），或按序号单条取消（/cancel 1）。";
				}
			}
			for (const task of cancellable) {
				store.cancelTask(task.id, now);
			}
			return [
				`🚫 已取消 ${cancellable.length} 条待执行自动签到任务：`,
				...cancellable.map((t) => `• ${t.accountName}｜${t.courseDate} ${t.courseName}`),
			].join("\n");
		}

		const indexSelection = parseIndexSelectionToken(targetArg);
		if (Array.isArray(indexSelection)) {
			const invalid = indexSelection.find((idx) => idx < 1 || idx > cancellable.length);
			if (invalid !== undefined) {
				return `❌ 任务序号 [${invalid}] 超出范围（当前共有 ${cancellable.length} 条待执行任务，请先发 /t 核对）。`;
			}
			const picked = indexSelection.map((idx) => cancellable[idx - 1]);
			for (const task of picked) {
				store.cancelTask(task.id, now);
			}
			return [
				"🚫 已取消自动签到任务：",
				...picked.map((t) => `• ${t.accountName}｜${t.courseDate} ${t.courseName}`),
			].join("\n");
		}

		const cleanPrefix = normalizedTarget.startsWith("#") ? normalizedTarget.slice(1) : normalizedTarget;
		if (cleanPrefix.length >= 4) {
			const matchedTasks = cancellable.filter((task) => task.id.toLowerCase().startsWith(cleanPrefix));
			if (matchedTasks.length === 1) {
				const task = matchedTasks[0];
				store.cancelTask(task.id, now);
				return `🚫 已取消自动签到任务：\n• ${task.accountName}｜${task.courseDate} ${task.courseName}`;
			}
			if (matchedTasks.length > 1) {
				return "⚠️ 短码匹配到多条任务，请发送 /t 使用序号取消。";
			}
		}

		if (!isAdmin && findStudentByAlias(config, targetArg)) {
			return `⛔ 权限不足：你只能取消自己绑定账号（${selfAccount?.name ?? "未绑定"}）的任务。`;
		}
		return `❓ 未找到待取消任务「${targetArg}」，请先发送 /t 查看当前待执行序号。`;
	}

	private handleSwitchCommand(
		config: PrivateConfig,
		selfAccount: StudentAccount | null,
		isAdmin: boolean,
		args: string[],
		enabled: boolean,
		now: number,
	): string {
		const store = this.dependencies.getStore();
		if (!store) return "⚠️ 服务端未配置自动签到数据库。";
		if (args.length > 1) {
			return enabled ? "用法：/on（管理员可发 /on <账号>）" : "用法：/off（管理员可发 /off <账号>）";
		}

		const resolved = this.resolveAccountChoice(config, selfAccount, isAdmin, args[0] ?? null);
		if (!resolved.ok) return resolved.message;
		const account = resolved.account;
		const identity = getStudentIdentity(account.studentId);

		store.synchronizeAccounts(config.students, now);
		store.setAccountEnabled(account.id, identity, enabled, now);

		if (enabled) {
			return `✅ 已开启账号「${account.name}」的自动签到总开关。\n接下来可发 /c 查课表并用 /a <序号> 预约具体课程。`;
		}
		return `🚫 已关闭账号「${account.name}」的自动签到总开关（该账号下未执行的预约已同步取消）。`;
	}
}

const botGlobal = globalThis as typeof globalThis & {
	ucasWeComBotService?: WeComBotService;
};

export function getWeComBotService(): WeComBotService {
	botGlobal.ucasWeComBotService ??= new WeComBotService();
	return botGlobal.ucasWeComBotService;
}
