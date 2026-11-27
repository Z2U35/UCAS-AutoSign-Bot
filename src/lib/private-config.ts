import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type StudentAccount = {
	id: string;
	name: string;
	studentId: string;
	wecomUserId?: string;
	wecomMobile?: string;
	wecomWebhookUrl?: string;
};

export type WeComConfig = {
	enabled?: boolean;
	corpId?: string;
	agentId?: string | number;
	corpSecret?: string;
	adminUserId?: string;
	adminUserIds?: string[];
	webhookUrl?: string;
	apiOrigin?: string;
	callbackToken?: string;
	callbackEncodingAesKey?: string;
	alwaysNotifyAdmin?: boolean;
	notifyOnSuccess?: boolean;
	fallbackAdminOnSuccess?: boolean;
};

export type PrivateConfig = {
	access: {
		passwordHash: string;
		sessionSecret: string;
		secureCookies: boolean;
	};
	studentPassword: string;
	students: StudentAccount[];
	wecom?: WeComConfig;
};

const WECOM_ID_PATTERN = /^[A-Za-z0-9_@.-]{1,64}$/;
const WECOM_CORP_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const WECOM_SECRET_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MOBILE_PATTERN = /^\+?[0-9]{6,20}$/;
const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9]{3,32}$/;
const CALLBACK_AES_KEY_PATTERN = /^[A-Za-z0-9]{43}$/;

function parseOptionalPattern(value: unknown, pattern: RegExp): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error();
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (!pattern.test(trimmed)) throw new Error();
	return trimmed;
}

function parseOptionalWebhookUrl(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > 500) throw new Error();
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const parsed = new URL(trimmed);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
	return trimmed;
}

function validateWeComConfig(raw: unknown): WeComConfig | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
	const candidate = raw as Record<string, unknown>;
	for (const booleanKey of ["enabled", "alwaysNotifyAdmin", "notifyOnSuccess", "fallbackAdminOnSuccess"]) {
		if (candidate[booleanKey] !== undefined && typeof candidate[booleanKey] !== "boolean") throw new Error();
	}
	const corpId = parseOptionalPattern(candidate.corpId, WECOM_CORP_ID_PATTERN) ?? "";
	const corpSecret = parseOptionalPattern(candidate.corpSecret, WECOM_SECRET_PATTERN) ?? "";

	let agentId = "";
	if (candidate.agentId !== undefined && candidate.agentId !== "") {
		const rawAgent = typeof candidate.agentId === "number" && Number.isSafeInteger(candidate.agentId)
			? String(candidate.agentId)
			: typeof candidate.agentId === "string"
				? candidate.agentId.trim()
				: null;
		if (rawAgent === null || (rawAgent !== "" && !/^\d{1,12}$/.test(rawAgent))) throw new Error();
		agentId = rawAgent;
	}

	const collectedAdminIds: string[] = [];
	const singleAdmin = parseOptionalPattern(candidate.adminUserId, WECOM_ID_PATTERN);
	if (singleAdmin) collectedAdminIds.push(singleAdmin);
	if (candidate.adminUserIds !== undefined) {
		if (!Array.isArray(candidate.adminUserIds)) throw new Error();
		for (const item of candidate.adminUserIds) {
			const parsed = parseOptionalPattern(item, WECOM_ID_PATTERN);
			if (parsed) collectedAdminIds.push(parsed);
		}
	}

	const webhookUrl = parseOptionalWebhookUrl(candidate.webhookUrl);
	let apiOrigin: string | undefined;
	if (candidate.apiOrigin !== undefined) {
		const parsedOrigin = parseOptionalWebhookUrl(candidate.apiOrigin);
		if (parsedOrigin) {
			const url = new URL(parsedOrigin);
			apiOrigin = url.origin;
		}
	}

	const callbackToken = parseOptionalPattern(candidate.callbackToken, CALLBACK_TOKEN_PATTERN);
	const callbackEncodingAesKey = parseOptionalPattern(candidate.callbackEncodingAesKey, CALLBACK_AES_KEY_PATTERN);
	const hasAppCredentials = Boolean(corpId && corpSecret && agentId);
	return {
		enabled: (candidate.enabled as boolean | undefined) ?? Boolean(hasAppCredentials || webhookUrl),
		corpId,
		agentId,
		corpSecret,
		adminUserIds: [...new Set(collectedAdminIds)],
		...(webhookUrl ? { webhookUrl } : {}),
		...(apiOrigin ? { apiOrigin } : {}),
		...(callbackToken ? { callbackToken } : {}),
		...(callbackEncodingAesKey ? { callbackEncodingAesKey } : {}),
		alwaysNotifyAdmin: Boolean(candidate.alwaysNotifyAdmin),
		notifyOnSuccess: (candidate.notifyOnSuccess as boolean | undefined) ?? true,
		fallbackAdminOnSuccess: Boolean(candidate.fallbackAdminOnSuccess),
	};
}

export async function readPrivateConfig(): Promise<PrivateConfig> {
	try {
		const configPath = process.env.UCAS_CONFIG_PATH || path.join(process.cwd(), "config/private.json");
		// Runtime credentials must not be traced into build/deployment artifacts.
		const config = JSON.parse(await readFile(/* turbopackIgnore: true */ configPath, "utf8")) as PrivateConfig;
		if (
			!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(config.access?.passwordHash ?? "") ||
			!/^[a-f0-9]{64}$/.test(config.access?.sessionSecret ?? "") ||
			typeof config.access?.secureCookies !== "boolean" ||
			typeof config.studentPassword !== "string" ||
			!config.studentPassword || config.studentPassword.length > 80 ||
			!Array.isArray(config.students)
		) {
			throw new Error();
		}
		const studentIds = new Set<string>();
		const normalizedStudents: StudentAccount[] = [];
		for (const student of config.students) {
			if (
				!student || typeof student.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(student.id) ||
				studentIds.has(student.id) || typeof student.name !== "string" ||
				!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(student.name) ||
				typeof student.studentId !== "string" || !/^\d{15}$/.test(student.studentId)
			) {
				throw new Error();
			}
			const wecomUserId = parseOptionalPattern(student.wecomUserId, WECOM_ID_PATTERN);
			const wecomMobile = parseOptionalPattern(student.wecomMobile, MOBILE_PATTERN);
			const wecomWebhookUrl = parseOptionalWebhookUrl(student.wecomWebhookUrl);
			studentIds.add(student.id);
			normalizedStudents.push({
				id: student.id,
				name: student.name,
				studentId: student.studentId,
				...(wecomUserId ? { wecomUserId } : {}),
				...(wecomMobile ? { wecomMobile } : {}),
				...(wecomWebhookUrl ? { wecomWebhookUrl } : {}),
			});
		}
		const wecom = validateWeComConfig(config.wecom);
		return {
			access: config.access,
			studentPassword: config.studentPassword,
			students: normalizedStudents,
			...(wecom ? { wecom } : {}),
		};
	} catch {
		// Never include parser errors: they can contain credentials from the JSON source.
		throw new Error("Private configuration is missing or invalid");
	}
}

export async function resolveCredentials(body: Record<string, unknown>) {
	const config = await readPrivateConfig();
	if (body.accountId !== undefined) {
		const student = config.students.find((account) => account.id === body.accountId);
		if (!student) return null;
		return { username: student.studentId, password: config.studentPassword };
	}
	const studentId = typeof body.studentId === "string" ? body.studentId.trim() : "";
	// Client-supplied passwords never override the server-managed credential.
	return {
		username: /^\d{15}$/.test(studentId) ? studentId : "",
		password: config.studentPassword,
	};
}
