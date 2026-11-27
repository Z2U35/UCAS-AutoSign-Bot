import { NextRequest } from "next/server";
import { accessJson } from "@/lib/access";
import { getAutoSignMode, getAutoSignStore, verifyMachineCredential } from "@/lib/auto-sign/environment";
import { autoSignErrorResponse } from "@/lib/auto-sign/http";
import { AutoSignService } from "@/lib/auto-sign/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	try {
		// Browser sessions and forwarded IP/Host headers never authorize this endpoint.
		if (!await verifyMachineCredential(request.headers.get("authorization"))) {
			return accessJson({ message: "Machine credential required.", code: "MACHINE_ACCESS_REQUIRED" }, 401);
		}
		const result = await new AutoSignService(getAutoSignStore()).tick(getAutoSignMode());
		return accessJson(result, 200);
	} catch (error) {
		return autoSignErrorResponse(error);
	}
}
