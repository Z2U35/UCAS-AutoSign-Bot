import { NextRequest, NextResponse } from "next/server";
import {
	accessJson, consumeLoginAttempt, createSession, isSameOrigin, revokeSession,
	SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, verifyAccessPassword,
} from "@/lib/access";
import { readPrivateConfig } from "@/lib/private-config";

export const runtime = "nodejs";

function redirectToAccessPage(errorStatus?: number) {
	// A relative target keeps the public origin when running behind a reverse proxy.
	return new NextResponse(null, {
		status: 303,
		headers: {
			Location: errorStatus ? `/?accessError=${errorStatus}` : "/",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export async function POST(request: NextRequest) {
	if (!isSameOrigin(request)) return accessJson({ message: "Invalid request origin." }, 403);
	const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
	const isFormSubmission = contentType === "application/x-www-form-urlencoded";
	if (!isFormSubmission && contentType !== "application/json") {
		return accessJson({ message: "Expected JSON or URL-encoded form data." }, 415);
	}
	function loginError(message: string, status: number) {
		return isFormSubmission ? redirectToAccessPage(status) : accessJson({ message }, status);
	}
	const maximumBodyBytes = isFormSubmission ? 8192 : 4096;
	const retryAfter = consumeLoginAttempt(request);
	if (retryAfter) {
		const response = loginError("Too many attempts. Please try again later.", 429);
		response.headers.set("Retry-After", String(retryAfter));
		return response;
	}
	let password: unknown;
	try {
		const reader = request.body?.getReader();
		if (!reader) return loginError("Missing password.", 400);
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			byteLength += chunk.value.byteLength;
			if (byteLength > maximumBodyBytes) {
				await reader.cancel();
				return loginError("Request too large.", 413);
			}
			chunks.push(chunk.value);
		}
		const body = Buffer.concat(chunks).toString("utf8");
		password = isFormSubmission
			? new URLSearchParams(body).get("accessPassword")
			: JSON.parse(body)?.password;
	} catch {
		return loginError("Invalid request.", 400);
	}
	try {
		const config = await readPrivateConfig();
		if (typeof password !== "string" || !await verifyAccessPassword(password, config)) {
			return loginError("Incorrect access password.", 401);
		}
		revokeSession(request.cookies.get(SESSION_COOKIE)?.value);
		const response = isFormSubmission ? redirectToAccessPage() : accessJson({ success: true });
		response.cookies.set(SESSION_COOKIE, createSession(config), {
			httpOnly: true,
			secure: config.access.secureCookies,
			sameSite: "strict",
			path: "/",
			maxAge: SESSION_MAX_AGE_SECONDS,
		});
		return response;
	} catch {
		return loginError("Access configuration unavailable. Contact the administrator.", 503);
	}
}
