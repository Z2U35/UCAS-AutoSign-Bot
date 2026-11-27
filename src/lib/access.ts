import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { readPrivateConfig, type PrivateConfig } from "./private-config";

export const SESSION_COOKIE = "ucas-access";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const derivePasswordKey = promisify(scrypt);
type Session = { expiresAt: number; configFingerprint: string };
type AttemptWindow = { count: number; resetAt: number };

// Shared by page rendering and route bundles in this single-process deployment.
const accessGlobal = globalThis as typeof globalThis & {
	ucasAccessState?: { sessions: Map<string, Session>; attempts: Map<string, AttemptWindow> };
};
const accessState = accessGlobal.ucasAccessState ??= {
	sessions: new Map<string, Session>(),
	attempts: new Map<string, AttemptWindow>(),
};

function fingerprintConfig(config: PrivateConfig): string {
	return createHash("sha256").update(config.access.passwordHash + config.access.sessionSecret).digest("hex");
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export async function verifyAccessPassword(password: string, config: PrivateConfig): Promise<boolean> {
	if (password.length < 16 || password.length > 256) return false;
	const [, salt, storedHash] = config.access.passwordHash.split("$");
	const derivedHash = await derivePasswordKey(password, salt, 64) as Buffer;
	return timingSafeEqual(derivedHash, Buffer.from(storedHash, "hex"));
}

export function createSession(config: PrivateConfig): string {
	const now = Date.now();
	for (const [sessionKey, session] of accessState.sessions) {
		if (session.expiresAt <= now) accessState.sessions.delete(sessionKey);
	}
	if (accessState.sessions.size >= 1000) throw new Error("Session capacity reached");
	const token = randomBytes(32).toString("hex");
	accessState.sessions.set(hashToken(token), {
		expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
		configFingerprint: fingerprintConfig(config),
	});
	return token;
}

export function revokeSession(token: string | undefined): void {
	if (token) accessState.sessions.delete(hashToken(token));
}

export async function isSessionValid(token: string | undefined): Promise<boolean> {
	if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
	const session = accessState.sessions.get(hashToken(token));
	if (!session) return false;
	if (session.expiresAt <= Date.now()) {
		revokeSession(token);
		return false;
	}
	return session.configFingerprint === fingerprintConfig(await readPrivateConfig());
}

export function accessJson(body: unknown, status = 200): NextResponse {
	return NextResponse.json(body, {
		status,
		headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}

export async function requireAccess(request: NextRequest): Promise<NextResponse | null> {
	try {
		if (await isSessionValid(request.cookies.get(SESSION_COOKIE)?.value)) {
			if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
				return accessJson({ message: "Invalid request origin." }, 403);
			}
			return null;
		}
		return accessJson({ message: "Access expired. Please unlock the system again.", code: "ACCESS_REQUIRED" }, 401);
	} catch {
		return accessJson({ message: "Private configuration is missing or invalid." }, 503);
	}
}

export function isSameOrigin(request: NextRequest): boolean {
	try {
		const origin = request.headers.get("origin");
		return Boolean(origin && new URL(origin).host === request.headers.get("host")) &&
			request.headers.get("sec-fetch-site") !== "cross-site";
	} catch {
		return false;
	}
}

export function consumeLoginAttempt(request: NextRequest): number {
	const now = Date.now();
	for (const [attemptKey, window] of accessState.attempts) {
		if (window.resetAt <= now) accessState.attempts.delete(attemptKey);
	}
	// The global limit also bounds work when client IP headers are forged.
	const windows = [
		{ key: "global", maximum: 60, duration: 60 * 1000 },
		{ key: `ip:${request.headers.get("x-real-ip") || "local"}`, maximum: 30, duration: 15 * 60 * 1000 },
	];
	for (const window of windows) {
		const attempts = accessState.attempts.get(window.key);
		if (attempts && attempts.count >= window.maximum) {
			return Math.max(1, Math.ceil((attempts.resetAt - now) / 1000));
		}
	}
	for (const window of windows) {
		const attempts = accessState.attempts.get(window.key) ?? { count: 0, resetAt: now + window.duration };
		attempts.count += 1;
		accessState.attempts.set(window.key, attempts);
	}
	return 0;
}
