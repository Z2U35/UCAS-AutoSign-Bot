import "server-only";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { PrivateConfig } from "../private-config.ts";
import type { TaskRecord } from "./store.ts";
import { SCHOOL_TIME_ZONE } from "./time.ts";

export const WECOM_DEFAULT_ORIGIN = "https://qyapi.weixin.qq.com";
export const WECOM_TIMEOUT_MS = 5000;
export const WECOM_MAX_TEXT_BYTES = 1950;
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const INVALID_TOKEN_CODES = new Set([40014, 42001, 42007]);

const WECOM_ID_PATTERN = /^[A-Za-z0-9_@.-]{1,64}$/;
const WECOM_CORP_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const WECOM_SECRET_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MOBILE_PATTERN = /^\+?[0-9]{6,20}$/;

export type NotificationKind = "success" | "failure";

export type WeComTarget =
	| {
		channel: "app";
		apiOrigin: string;
		corpId: string;
		corpSecret: string;
		agentId: number;
		userIds: string[];
	}
	| {
		channel: "webhook";
		webhookUrl: string;
		mentionedUserIds: string[];
		mentionedMobiles: string[];
	};

export type WeComDispatchPayload = WeComTarget & { content: string };

export type WeComInboundMessage = {
	toUser: string;
	fromUser: string;
	createTime: string;
	msgType: string;
	content: string;
	msgId: string;
	agentId: string;
	event: string;
};

type TokenCacheEntry = {
	cacheKey: string;
	accessToken: string;
	expiresAt: number;
};

const tokenGlobal = globalThis as typeof globalThis & {
	ucasWeComTokenCache?: TokenCacheEntry;
};

export function clearWeComTokenCache(): void {
	delete tokenGlobal.ucasWeComTokenCache;
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: SCHOOL_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: SCHOOL_TIME_ZONE,
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

const STATUS_NAMES: Readonly<Record<string, string>> = {
	succeeded: "签到成功",
	skipped: "课表已签（跳过重提）",
	failed: "执行失败",
	expired: "超时未完成",
	paused: "异常暂停",
	uncertain: "提交结果待核实",
};

const CODE_REASONS: Readonly<Record<string, string>> = {
	SIGNED: "国科大 iClass 已返回签到成功",
	CONFIRMED_SIGNED: "提交后经重新查询官方课表，确认已签到成功",
	ALREADY_SIGNED: "查询课表时上游已显示为已签到状态，无需重复提交",
	UPSTREAM_LOGIN_TIMEOUT: "登录国科大 iClass 接口请求超时",
	UPSTREAM_LOGIN_NETWORK: "登录国科大 iClass 接口网络异常",
	UPSTREAM_LOGIN_HTTP: "登录国科大 iClass 接口返回 HTTP 异常",
	UPSTREAM_LOGIN_BAD_JSON: "登录国科大 iClass 接口返回格式异常",
	UPSTREAM_LOGIN_REJECTED: "账号登录未通过（请检查学号或服务端统一密码）",
	UPSTREAM_SCHEDULE_TIMEOUT: "查询课表接口请求超时",
	UPSTREAM_SCHEDULE_NETWORK: "查询课表接口网络异常",
	UPSTREAM_SCHEDULE_HTTP: "查询课表接口返回 HTTP 异常",
	UPSTREAM_SCHEDULE_BAD_JSON: "查询课表接口返回格式异常",
	UPSTREAM_SCHEDULE_REJECTED: "上游未返回可用课表",
	UPSTREAM_TIMESTAMP_TIMEOUT: "获取上游服务器时间超时或延迟过高",
	UPSTREAM_TIMESTAMP_NETWORK: "获取上游服务器时间网络异常",
	UPSTREAM_TIMESTAMP_HTTP: "获取上游服务器时间 HTTP 异常",
	UPSTREAM_TIMESTAMP_BAD_JSON: "获取上游服务器时间返回格式异常",
	UPSTREAM_TIMESTAMP_BAD_RESPONSE: "上游服务器时间响应为空",
	UPSTREAM_TIMESTAMP_INVALID_RESPONSE: "上游服务器时间响应无效",
	UPSTREAM_SIGN_TIMEOUT: "签到提交超时，且后续课表复核未确认签到成功",
	UPSTREAM_SIGN_NETWORK: "签到提交网络异常，且后续课表复核未确认签到成功",
	UPSTREAM_SIGN_HTTP: "签到接口返回 HTTP 异常",
	UPSTREAM_SIGN_BAD_JSON: "签到接口返回格式异常",
	DEADLINE_PASSED: "超过最晚截止时间仍未完成签到",
	COURSE_MISSING: "当日课表中未找到该课程",
	COURSE_CHANGED: "课程上下课时间发生变更，需重新确认",
	ACCOUNT_CHANGED: "快捷账号配置已变更，需重新确认",
	CLOCK_SKEW: "服务器时钟与国科大服务器时间偏差过大",
	PREPARATION_LEASE_EXPIRED: "执行租约超时且已过截止窗口",
	EXECUTION_MODE_CHANGED: "运行模式发生变更",
	UNKNOWN_SIGN_STATUS: "上游返回的课程签到状态无法识别",
};

export function truncateWeComText(text: string, maxBytes = WECOM_MAX_TEXT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = "\n…（内容过长已截断）";
	const budget = Math.max(64, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let result = "";
	let usedBytes = 0;
	for (const char of text) {
		const charBytes = Buffer.byteLength(char, "utf8");
		if (usedBytes + charBytes > budget) break;
		result += char;
		usedBytes += charBytes;
	}
	return `${result.trimEnd()}${suffix}`;
}

export function classifyTaskNotification(task: TaskRecord, maxReconcileAttempts: number): NotificationKind | null {
	if (task.executionMode !== "live") return null;
	if (task.status === "succeeded" || task.status === "skipped") return "success";
	if (
		task.status === "failed" ||
		task.status === "expired" ||
		task.status === "paused" ||
		(task.status === "uncertain" && task.reconcileAttempts >= maxReconcileAttempts)
	) {
		return "failure";
	}
	return null;
}

export function resolveDirectWeComTarget(config: PrivateConfig, userId: string): WeComTarget | null {
	const wecom = config.wecom;
	if (!wecom || wecom.enabled === false) return null;
	const trimmedUser = userId.trim();
	if (!WECOM_ID_PATTERN.test(trimmedUser)) return null;

	const corpId = typeof wecom.corpId === "string" ? wecom.corpId.trim() : "";
	const corpSecret = typeof wecom.corpSecret === "string" ? wecom.corpSecret.trim() : "";
	const agentIdText = typeof wecom.agentId === "number" ? String(wecom.agentId)
		: typeof wecom.agentId === "string" ? wecom.agentId.trim() : "";
	if (!WECOM_CORP_ID_PATTERN.test(corpId) || !WECOM_SECRET_PATTERN.test(corpSecret) || !/^\d{1,12}$/.test(agentIdText)) {
		return null;
	}
	const apiOrigin = typeof wecom.apiOrigin === "string" && wecom.apiOrigin.trim()
		? new URL(wecom.apiOrigin.trim()).origin
		: WECOM_DEFAULT_ORIGIN;
	return {
		channel: "app",
		apiOrigin,
		corpId,
		corpSecret,
		agentId: Number(agentIdText),
		userIds: [trimmedUser],
	};
}

export function resolveNotificationPlan(
	config: PrivateConfig,
	accountId: string,
	kind: NotificationKind = "failure",
): { target: WeComTarget; usedFallback: boolean } | null {
	const wecom = config.wecom;
	if (!wecom) return null;
	if (kind === "success" && wecom.notifyOnSuccess === false) return null;

	const corpId = typeof wecom.corpId === "string" ? wecom.corpId.trim() : "";
	const corpSecret = typeof wecom.corpSecret === "string" ? wecom.corpSecret.trim() : "";
	const agentIdText = typeof wecom.agentId === "number" ? String(wecom.agentId)
		: typeof wecom.agentId === "string" ? wecom.agentId.trim() : "";
	const hasAppChannel = WECOM_CORP_ID_PATTERN.test(corpId)
		&& WECOM_SECRET_PATTERN.test(corpSecret)
		&& /^\d{1,12}$/.test(agentIdText);

	const account = config.students.find((candidate) => candidate.id === accountId);
	const studentUserId = typeof account?.wecomUserId === "string" && WECOM_ID_PATTERN.test(account.wecomUserId.trim())
		? account.wecomUserId.trim()
		: "";
	const studentMobile = typeof account?.wecomMobile === "string" && MOBILE_PATTERN.test(account.wecomMobile.trim())
		? account.wecomMobile.trim()
		: "";
	const studentWebhook = typeof account?.wecomWebhookUrl === "string" && account.wecomWebhookUrl.trim()
		? account.wecomWebhookUrl.trim()
		: "";
	const globalWebhook = typeof wecom.webhookUrl === "string" && wecom.webhookUrl.trim()
		? wecom.webhookUrl.trim()
		: "";

	const enabled = wecom.enabled ?? Boolean(hasAppChannel || globalWebhook || studentWebhook);
	if (!enabled) return null;

	const adminIds: string[] = [];
	if (typeof wecom.adminUserId === "string" && WECOM_ID_PATTERN.test(wecom.adminUserId.trim())) {
		adminIds.push(wecom.adminUserId.trim());
	}
	if (Array.isArray(wecom.adminUserIds)) {
		for (const item of wecom.adminUserIds) {
			if (typeof item === "string" && WECOM_ID_PATTERN.test(item.trim())) {
				adminIds.push(item.trim());
			}
		}
	}
	const uniqueAdmins = [...new Set(adminIds)];

	// Mode 1 (preferred): Enterprise WeChat self-built application -> 1-to-1 push via WeChat Plugin
	if (hasAppChannel) {
		let userIds: string[];
		let usedFallback = false;
		if (studentUserId) {
			userIds = wecom.alwaysNotifyAdmin ? [...new Set([studentUserId, ...uniqueAdmins])] : [studentUserId];
		} else if (kind === "failure" || wecom.fallbackAdminOnSuccess) {
			userIds = uniqueAdmins;
			usedFallback = true;
		} else {
			userIds = [];
		}
		if (userIds.length > 0) {
			const apiOrigin = typeof wecom.apiOrigin === "string" && wecom.apiOrigin.trim()
				? new URL(wecom.apiOrigin.trim()).origin
				: WECOM_DEFAULT_ORIGIN;
			return {
				usedFallback,
				target: {
					channel: "app",
					apiOrigin,
					corpId,
					corpSecret,
					agentId: Number(agentIdText),
					userIds,
				},
			};
		}
	}

	// Mode 2: Enterprise WeChat group bot webhook (per-student webhook or shared/admin webhook)
	if (studentWebhook) {
		return {
			usedFallback: false,
			target: {
				channel: "webhook",
				webhookUrl: studentWebhook,
				mentionedUserIds: studentUserId ? [studentUserId] : [],
				mentionedMobiles: studentMobile ? [studentMobile] : [],
			},
		};
	}
	if (globalWebhook) {
		const hasPersonalMention = Boolean(studentUserId || studentMobile);
		if (!hasPersonalMention && kind === "success" && !wecom.fallbackAdminOnSuccess) {
			return null;
		}
		const mentionedUserIds = studentUserId
			? (wecom.alwaysNotifyAdmin ? [...new Set([studentUserId, ...uniqueAdmins])] : [studentUserId])
			: uniqueAdmins;
		return {
			usedFallback: !hasPersonalMention,
			target: {
				channel: "webhook",
				webhookUrl: globalWebhook,
				mentionedUserIds,
				mentionedMobiles: studentMobile ? [studentMobile] : [],
			},
		};
	}

	return null;
}

// Plain text format (msgtype: text) renders natively in Personal WeChat via WeChat Plugin
// without triggering WeCom's "暂不支持此消息类型" markdown restriction.
export function buildTaskNotificationText(
	task: TaskRecord,
	kind: NotificationKind,
	usedFallback: boolean,
	notifiedAt: number,
): string {
	const courseTitle = task.courseName || "未命名课程";
	const statusLabel = STATUS_NAMES[task.status] ?? task.status;
	const reasonText = CODE_REASONS[task.resultCode] ?? (kind === "success" ? "已完成本次课程签到处理" : "请查看任务记录核实具体原因");
	const classWindow = `${clockFormatter.format(new Date(task.classBeginAt))} - ${clockFormatter.format(new Date(task.classEndAt))}`;
	const updatedTime = dateTimeFormatter.format(new Date(task.updatedAt || notifiedAt));

	if (kind === "success") {
		const header = task.status === "skipped" ? "✅ UCAS 课表已签（跳过重提）" : "✅ UCAS 自动签到成功";
		const lines = [
			header,
			`账号：${task.accountName}`,
			`课程：${courseTitle}`,
			`上课：${task.courseDate} ${classWindow}`,
			`结果：${statusLabel}${task.attempts > 1 ? `（共尝试 ${task.attempts} 次）` : ""}`,
			`说明：${reasonText}`,
			`时间：${updatedTime}`,
		];
		if (usedFallback) {
			lines.push(`备注：账号「${task.accountName}」暂未绑定个人企业微信账号，本条通知已推送至管理员。`);
		}
		return lines.join("\n");
	}

	const lines = [
		"⚠️ UCAS 自动签到异常提醒",
		`账号：${task.accountName}`,
		`课程：${courseTitle}`,
		`上课：${task.courseDate} ${classWindow}`,
		`状态：${statusLabel}（尝试 ${task.attempts} 次）`,
		`原因：${reasonText} (${task.resultCode})`,
		`时间：${updatedTime}`,
		"提示：请及时打开国科大 iClass 或签到页面核实状态，必要时手动补签。",
	];
	if (usedFallback) {
		lines.push(`备注：账号「${task.accountName}」暂未绑定个人企业微信账号，本条提醒已兜底推送至管理员。`);
	}
	return lines.join("\n");
}

async function fetchJsonWithTimeout<ResponseData>(url: string, init: RequestInit): Promise<ResponseData | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), WECOM_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			...init,
			redirect: "error",
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			return null;
		}
		return (await response.json()) as ResponseData;
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function getWeComAccessToken(apiOrigin: string, corpId: string, corpSecret: string, forceRefresh = false): Promise<string | null> {
	const cacheKey = `${apiOrigin}|${corpId}|${corpSecret}`;
	const now = Date.now();
	const cached = tokenGlobal.ucasWeComTokenCache;
	if (!forceRefresh && cached && cached.cacheKey === cacheKey && cached.expiresAt > now) {
		return cached.accessToken;
	}
	const tokenUrl = `${apiOrigin}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
	const body = await fetchJsonWithTimeout<{ errcode?: number; access_token?: string; expires_in?: number }>(tokenUrl, {
		method: "GET",
		headers: { Accept: "application/json" },
	});
	if (!body || body.errcode !== 0 || typeof body.access_token !== "string" || !body.access_token) {
		return null;
	}
	const ttlMs = Math.max(60_000, ((body.expires_in ?? 7200) * 1000) - TOKEN_SAFETY_MARGIN_MS);
	tokenGlobal.ucasWeComTokenCache = {
		cacheKey,
		accessToken: body.access_token,
		expiresAt: now + ttlMs,
	};
	return body.access_token;
}

export async function sendWeComNotification(payload: WeComDispatchPayload): Promise<boolean> {
	const safeContent = truncateWeComText(payload.content);
	try {
		if (payload.channel === "webhook") {
			const response = await fetchJsonWithTimeout<{ errcode?: number }>(payload.webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					msgtype: "text",
					text: {
						content: safeContent,
						...(payload.mentionedUserIds.length > 0 ? { mentioned_list: payload.mentionedUserIds } : {}),
						...(payload.mentionedMobiles.length > 0 ? { mentioned_mobile_list: payload.mentionedMobiles } : {}),
					},
				}),
			});
			return response?.errcode === 0;
		}

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const accessToken = await getWeComAccessToken(payload.apiOrigin, payload.corpId, payload.corpSecret, attempt > 0);
			if (!accessToken) return false;
			const sendUrl = `${payload.apiOrigin}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
			const response = await fetchJsonWithTimeout<{ errcode?: number; invaliduser?: string }>(sendUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					touser: payload.userIds.join("|"),
					msgtype: "text",
					agentid: payload.agentId,
					text: { content: safeContent },
					safe: 0,
				}),
			});
			if (!response) return false;
			if (response.errcode === 0) {
				const invalidSet = new Set((response.invaliduser ?? "").split("|").map((s) => s.trim()).filter(Boolean));
				return invalidSet.size < payload.userIds.length;
			}
			if (attempt === 0 && response.errcode !== undefined && INVALID_TOKEN_CODES.has(response.errcode)) {
				clearWeComTokenCache();
				continue;
			}
			return false;
		}
		return false;
	} catch {
		// Never leak secrets, tokens, or upstream errors into scheduler logs.
		return false;
	}
}

function decryptWeComPayload(params: {
	token: string;
	encodingAesKey: string;
	corpId: string;
	msgSignature: string;
	timestamp: string;
	nonce: string;
	cipherText: string;
	maxCipherLength: number;
}): string | null {
	const { token, encodingAesKey, corpId, msgSignature, timestamp, nonce, cipherText, maxCipherLength } = params;
	if (!/^[A-Za-z0-9]{3,32}$/.test(token) || !/^[A-Za-z0-9]{43}$/.test(encodingAesKey) || !corpId) {
		return null;
	}
	if (!/^[a-f0-9]{40}$/i.test(msgSignature) || !timestamp || !nonce || !cipherText || cipherText.length > maxCipherLength) {
		return null;
	}
	const expectedSig = createHash("sha1")
		.update([token, timestamp, nonce, cipherText].sort().join(""), "utf8")
		.digest("hex");
	const suppliedSig = msgSignature.toLowerCase();
	if (!timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(suppliedSig, "utf8"))) {
		return null;
	}

	try {
		const aesKey = Buffer.from(`${encodingAesKey}=`, "base64");
		if (aesKey.length !== 32) return null;
		const encrypted = Buffer.from(cipherText, "base64");
		if (encrypted.length < 32 || encrypted.length % 16 !== 0) return null;

		const decipher = createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
		decipher.setAutoPadding(false);
		const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

		// WeCom WXBizMsgCrypt uses 32-byte PKCS#7 padding.
		const padLength = decrypted[decrypted.length - 1];
		if (padLength < 1 || padLength > 32 || padLength > decrypted.length) return null;
		for (let i = decrypted.length - padLength; i < decrypted.length; i += 1) {
			if (decrypted[i] !== padLength) return null;
		}
		const unpadded = decrypted.subarray(0, decrypted.length - padLength);
		if (unpadded.length < 20) return null;

		const messageByteLength = unpadded.readUInt32BE(16);
		if (20 + messageByteLength > unpadded.length) return null;
		const plainMessage = unpadded.subarray(20, 20 + messageByteLength).toString("utf8");
		const receiveId = unpadded.subarray(20 + messageByteLength).toString("utf8");
		if (receiveId !== corpId) return null;
		return plainMessage;
	} catch {
		return null;
	}
}

export function verifyWeComCallbackUrl(params: {
	token: string;
	encodingAesKey: string;
	corpId: string;
	msgSignature: string;
	timestamp: string;
	nonce: string;
	echostr: string;
}): string | null {
	return decryptWeComPayload({
		token: params.token,
		encodingAesKey: params.encodingAesKey,
		corpId: params.corpId,
		msgSignature: params.msgSignature,
		timestamp: params.timestamp,
		nonce: params.nonce,
		cipherText: params.echostr,
		maxCipherLength: 4096,
	});
}

function unescapeXmlEntities(raw: string): string {
	return raw
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function extractXmlTag(xml: string, tagName: string): string {
	const cdataPattern = new RegExp(`<${tagName}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`);
	const cdataMatch = cdataPattern.exec(xml);
	if (cdataMatch) return cdataMatch[1];

	const plainPattern = new RegExp(`<${tagName}>([^<]*)</${tagName}>`);
	const plainMatch = plainPattern.exec(xml);
	if (plainMatch) return unescapeXmlEntities(plainMatch[1].trim());
	return "";
}

export function parseWeComCallbackMessage(params: {
	token: string;
	encodingAesKey: string;
	corpId: string;
	expectedAgentId?: string | number;
	msgSignature: string;
	timestamp: string;
	nonce: string;
	rawBody: string;
}): WeComInboundMessage | null {
	if (!params.rawBody || params.rawBody.length > 16384) return null;
	const cipherText = extractXmlTag(params.rawBody, "Encrypt").trim();
	if (!cipherText) return null;

	const decryptedXml = decryptWeComPayload({
		token: params.token,
		encodingAesKey: params.encodingAesKey,
		corpId: params.corpId,
		msgSignature: params.msgSignature,
		timestamp: params.timestamp,
		nonce: params.nonce,
		cipherText,
		maxCipherLength: 16384,
	});
	if (!decryptedXml) return null;

	const fromUser = extractXmlTag(decryptedXml, "FromUserName").trim();
	const msgType = extractXmlTag(decryptedXml, "MsgType").trim().toLowerCase();
	const agentId = extractXmlTag(decryptedXml, "AgentID").trim() || extractXmlTag(params.rawBody, "AgentID").trim();
	if (!fromUser || !WECOM_ID_PATTERN.test(fromUser) || !msgType) return null;

	const expectedAgent = params.expectedAgentId !== undefined ? String(params.expectedAgentId).trim() : "";
	if (expectedAgent && agentId && agentId !== expectedAgent) {
		return null;
	}

	return {
		toUser: extractXmlTag(decryptedXml, "ToUserName").trim(),
		fromUser,
		createTime: extractXmlTag(decryptedXml, "CreateTime").trim(),
		msgType,
		content: extractXmlTag(decryptedXml, "Content"),
		msgId: extractXmlTag(decryptedXml, "MsgId").trim(),
		agentId,
		event: extractXmlTag(decryptedXml, "Event").trim().toLowerCase(),
	};
}
