import "server-only";
import { NextRequest } from "next/server";
import { accessJson, requireAccess } from "../access";
import { IclassError } from "../iclass";
import { AutoSignError } from "./types.ts";

const requestGlobal = globalThis as typeof globalThis & {
	ucasAutoSignRequests?: { startedAt: number; count: number; active: number };
};
const requests = requestGlobal.ucasAutoSignRequests ??= { startedAt: 0, count: 0, active: 0 };

export function autoSignErrorResponse(error: unknown) {
	if (error instanceof AutoSignError) {
		return accessJson({ message: error.code, code: error.code }, error.status);
	}
	if (error instanceof IclassError) {
		return accessJson({ message: error.message, code: error.code }, error.status);
	}
	// Never forward SQLite, filesystem or raw upstream errors (they may contain private data).
	return accessJson({ message: "Auto sign is unavailable. Check server configuration.", code: "AUTO_SIGN_UNAVAILABLE" }, 503);
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
	if (!request.headers.get("content-type")?.includes("application/json")) throw new AutoSignError("JSON_REQUIRED", 415);
	const reader = request.body?.getReader();
	if (!reader) throw new AutoSignError("INVALID_JSON");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			length += result.value.byteLength;
			if (length > 4096) {
				await reader.cancel();
				throw new AutoSignError("REQUEST_TOO_LARGE", 413);
			}
			chunks.push(result.value);
		}
		const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!body || typeof body !== "object" || Array.isArray(body)) throw new AutoSignError("INVALID_JSON");
		return body as Record<string, unknown>;
	} catch (error) {
		if (error instanceof AutoSignError) throw error;
		throw new AutoSignError("INVALID_JSON");
	} finally {
		reader.releaseLock();
	}
}

export async function handleAutoSignMutation(
	request: NextRequest,
	operation: (body: Record<string, unknown>) => Promise<unknown>,
	queriesUpstream = false,
) {
	const accessError = await requireAccess(request);
	if (accessError) return accessError;
	let acquired = false;
	try {
		const body = await readJsonBody(request);
		if (queriesUpstream) {
			const now = Date.now();
			if (now - requests.startedAt >= 5 * 60_000) {
				requests.startedAt = now;
				requests.count = 0;
			}
			if (requests.active >= 2 || requests.count >= 60) throw new AutoSignError("RATE_LIMITED", 429);
			requests.active += 1;
			requests.count += 1;
			acquired = true;
		}
		return accessJson(await operation(body), 200);
	} catch (error) {
		return autoSignErrorResponse(error);
	} finally {
		if (acquired) requests.active -= 1;
	}
}
