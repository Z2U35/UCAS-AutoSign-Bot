import { NextRequest } from "next/server";
import { getAutoSignStore } from "@/lib/auto-sign/environment";
import { handleAutoSignMutation } from "@/lib/auto-sign/http";
import { AutoSignService } from "@/lib/auto-sign/service";
import { AutoSignError } from "@/lib/auto-sign/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	return handleAutoSignMutation(request, async (body) => {
		if (typeof body.accountId !== "string" || typeof body.enabled !== "boolean") throw new AutoSignError("INVALID_ACCOUNT_SETTING");
		await new AutoSignService(getAutoSignStore()).setAccountEnabled(body.accountId, body.enabled);
		return { success: true };
	});
}
