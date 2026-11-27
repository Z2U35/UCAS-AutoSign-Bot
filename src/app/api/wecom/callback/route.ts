import { NextRequest, NextResponse } from "next/server";
import { parseWeComCallbackMessage, verifyWeComCallbackUrl } from "@/lib/auto-sign/notify";
import { getWeComBotService } from "@/lib/auto-sign/wecom-bot";
import { readPrivateConfig } from "@/lib/private-config";

export const runtime = "nodejs";

const NO_STORE_HEADERS = {
	"Content-Type": "text/plain; charset=utf-8",
	"Cache-Control": "no-store",
} as const;

async function readBoundedText(request: NextRequest, maxBytes: number): Promise<string | null> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

export async function GET(request: NextRequest) {
	try {
		const config = await readPrivateConfig();
		const wecom = config.wecom;
		if (!wecom?.corpId || !wecom.callbackToken || !wecom.callbackEncodingAesKey) {
			return new NextResponse("Not Found", { status: 404, headers: NO_STORE_HEADERS });
		}
		const search = request.nextUrl.searchParams;
		const plain = verifyWeComCallbackUrl({
			token: wecom.callbackToken,
			encodingAesKey: wecom.callbackEncodingAesKey,
			corpId: wecom.corpId,
			msgSignature: search.get("msg_signature") ?? "",
			timestamp: search.get("timestamp") ?? "",
			nonce: search.get("nonce") ?? "",
			echostr: search.get("echostr") ?? "",
		});
		if (plain === null) {
			return new NextResponse("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
		}
		return new NextResponse(plain, { status: 200, headers: NO_STORE_HEADERS });
	} catch {
		return new NextResponse("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
	}
}

export async function POST(request: NextRequest) {
	try {
		const config = await readPrivateConfig();
		const wecom = config.wecom;
		if (!wecom?.corpId || !wecom.callbackToken || !wecom.callbackEncodingAesKey) {
			return new NextResponse("Not Found", { status: 404, headers: NO_STORE_HEADERS });
		}
		const rawBody = await readBoundedText(request, 16384);
		if (rawBody === null) {
			return new NextResponse("Payload Too Large", { status: 413, headers: NO_STORE_HEADERS });
		}
		const search = request.nextUrl.searchParams;
		const message = parseWeComCallbackMessage({
			token: wecom.callbackToken,
			encodingAesKey: wecom.callbackEncodingAesKey,
			corpId: wecom.corpId,
			expectedAgentId: wecom.agentId,
			msgSignature: search.get("msg_signature") ?? "",
			timestamp: search.get("timestamp") ?? "",
			nonce: search.get("nonce") ?? "",
			rawBody,
		});
		if (!message) {
			return new NextResponse("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
		}
		if (wecom.enabled !== false && message.msgType === "text") {
			// Acknowledge within WeCom's 5-second callback timeout and push the reply asynchronously.
			void getWeComBotService().processInboundMessage(config, message).catch(() => {});
		}
		return new NextResponse("success", { status: 200, headers: NO_STORE_HEADERS });
	} catch {
		return new NextResponse("Forbidden", { status: 403, headers: NO_STORE_HEADERS });
	}
}
