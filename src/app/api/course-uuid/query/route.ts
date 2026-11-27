import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/access";
import { IclassError, loginIclass, queryIclassSchedule } from "@/lib/iclass";
import { resolveCredentials } from "@/lib/private-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY"
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MAX = toPositiveInt(process.env.RATE_LIMIT_5M_MAX, 100);
const RATE_LIMIT_DAILY_MAX = toPositiveInt(process.env.RATE_LIMIT_DAILY_MAX, 1000);
const RATE_LIMIT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_USERNAME_LENGTH = 40;
const MAX_PASSWORD_LENGTH = 80;

type RateLimitState = {
	windowHits: number[];
	dailyCount: number;
	dailyResetAt: number;
};

const ipRateLimitStore = new Map<string, RateLimitState>();
let lastRateLimitSweepAt = 0;

function normalizeDateToYyyyMMdd(input: string): string | null {
	const compact = input.replace(/-/g, "").trim();
	if (!/^\d{8}$/.test(compact)) {
		return null;
	}
	return compact;
}

function toPositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonWithHeaders(body: unknown, init: { status: number; headers?: Record<string, string> }) {
	return NextResponse.json(body, {
		status: init.status,
		headers: {
			...RESPONSE_HEADERS,
			...(init.headers ?? {})
		}
	});
}

function getClientIp(req: NextRequest): string {
	const xff = req.headers.get("x-forwarded-for");
	if (xff) {
		return xff.split(",")[0]?.trim() || "unknown";
	}
	return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function isSameOriginRequest(req: NextRequest): boolean {
	const origin = req.headers.get("origin");
	if (!origin) {
		return true;
	}

	const host = req.headers.get("host");
	if (!host) {
		return false;
	}

	try {
		const originHost = new URL(origin).host;
		return originHost === host;
	} catch {
		return false;
	}
}

function sweepRateLimitStore(now: number) {
	if (now - lastRateLimitSweepAt < RATE_LIMIT_SWEEP_INTERVAL_MS) {
		return;
	}

	for (const [ip, state] of ipRateLimitStore.entries()) {
		state.windowHits = state.windowHits.filter((ts) => now - ts <= FIVE_MINUTES_MS);

		if (state.dailyResetAt <= now) {
			state.dailyCount = 0;
			state.dailyResetAt = now + ONE_DAY_MS;
		}

		if (state.windowHits.length === 0 && state.dailyCount === 0) {
			ipRateLimitStore.delete(ip);
		}
	}

	lastRateLimitSweepAt = now;
}

function consumeRateLimit(ip: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
	sweepRateLimitStore(now);

	const state =
		ipRateLimitStore.get(ip) ??
		({
			windowHits: [],
			dailyCount: 0,
			dailyResetAt: now + ONE_DAY_MS
		} satisfies RateLimitState);

	if (state.dailyResetAt <= now) {
		state.dailyCount = 0;
		state.dailyResetAt = now + ONE_DAY_MS;
	}

	state.windowHits = state.windowHits.filter((ts) => now - ts <= FIVE_MINUTES_MS);

	if (state.windowHits.length >= RATE_LIMIT_WINDOW_MAX) {
		const oldestAllowed = state.windowHits[0] + FIVE_MINUTES_MS;
		const retryAfterSec = Math.max(1, Math.ceil((oldestAllowed - now) / 1000));
		ipRateLimitStore.set(ip, state);
		return { ok: false, retryAfterSec };
	}

	if (state.dailyCount >= RATE_LIMIT_DAILY_MAX) {
		const retryAfterSec = Math.max(1, Math.ceil((state.dailyResetAt - now) / 1000));
		ipRateLimitStore.set(ip, state);
		return { ok: false, retryAfterSec };
	}

	state.windowHits.push(now);
	state.dailyCount += 1;
	ipRateLimitStore.set(ip, state);

	return { ok: true };
}

function isCredentialInputInvalid(username: string, password: string): boolean {
	if (!username || !password) {
		return true;
	}
	if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		return true;
	}
	if (/\s/.test(username)) {
		return true;
	}
	return false;
}

export async function POST(req: NextRequest) {
	const accessError = await requireAccess(req);
	if (accessError) return accessError;
	const startedAt = Date.now();
	const requestId = crypto.randomUUID();
	let stage: "login" | "schedule" | "request" = "request";

	try {
		if (!isSameOriginRequest(req)) {
			return jsonWithHeaders({ message: "非法来源请求" }, { status: 403 });
		}

		const contentType = req.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return jsonWithHeaders({ message: "请求格式错误，请使用 application/json" }, { status: 415 });
		}

		const ip = getClientIp(req);
		const rateLimitResult = consumeRateLimit(ip, Date.now());
		if (!rateLimitResult.ok) {
			return jsonWithHeaders(
				{ message: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
				{
					status: 429,
					headers: {
						"Retry-After": String(rateLimitResult.retryAfterSec)
					}
				}
			);
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return jsonWithHeaders({ message: "请求体 JSON 格式错误" }, { status: 400 });
		}

		const bodyObject = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
		const credentials = await resolveCredentials(bodyObject);
		if (!credentials) return jsonWithHeaders({ message: "快捷账号不存在，请刷新页面" }, { status: 400 });
		const { username, password } = credentials;
		const dateInput = String(bodyObject.date ?? "").trim();

		if (isCredentialInputInvalid(username, password)) {
			return jsonWithHeaders({ message: "请输入15位数字学号" }, { status: 400 });
		}

		const date = normalizeDateToYyyyMMdd(dateInput);
		if (!date) {
			return jsonWithHeaders({ message: "日期格式错误，请使用 yyyyMMdd 或 yyyy-MM-dd" }, { status: 400 });
		}

		stage = "login";
		const session = await loginIclass(username, password);

		stage = "schedule";
		const courses = await queryIclassSchedule(session, date);

		return jsonWithHeaders(
			{
				date,
				total: courses.length,
				courses
			},
			{ status: 200 }
		);
	} catch (error) {
		const isIclassError = error instanceof IclassError;
		if (isIclassError && (error.code === "UPSTREAM_LOGIN_REJECTED" || error.code === "UPSTREAM_SCHEDULE_REJECTED")) {
			return jsonWithHeaders({ message: error.message }, { status: error.status });
		}

		const durationMs = Date.now() - startedAt;
		const logPayload = {
			requestId,
			stage,
			durationMs,
			errorName: isIclassError ? "IclassError" : "UnknownError",
			errorMessage: isIclassError ? error.message : "Unexpected request failure",
			code: isIclassError ? error.code : "UNEXPECTED_ERROR"
		};

		console.error("[course-uuid/query]", JSON.stringify(logPayload));

		if (isIclassError) {
			return jsonWithHeaders({ message: error.message, code: error.code }, { status: error.status });
		}

		return jsonWithHeaders({ message: "服务暂时不可用，请稍后重试", code: "UNEXPECTED_ERROR" }, { status: 500 });
	}
}
