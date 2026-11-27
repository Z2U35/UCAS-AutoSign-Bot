import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/access";
import { getIclassTimestamp, IclassError } from "@/lib/iclass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
};

export async function GET(request: NextRequest) {
	const accessError = await requireAccess(request);
	if (accessError) return accessError;
	try {
		const timestamp = await getIclassTimestamp();
		return NextResponse.json({ success: true, timestamp }, { headers: RESPONSE_HEADERS });
	} catch (error) {
		const isInvalidResponse = error instanceof IclassError && error.code === "UPSTREAM_TIMESTAMP_INVALID_RESPONSE";
		return NextResponse.json(
			{ success: false, message: isInvalidResponse ? "Invalid server response" : "Failed to fetch server timestamp" },
			{ status: isInvalidResponse ? 502 : 504, headers: RESPONSE_HEADERS },
		);
	}
}
