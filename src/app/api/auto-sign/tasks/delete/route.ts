import { NextRequest } from "next/server";
import { getAutoSignStore } from "@/lib/auto-sign/environment";
import { handleAutoSignMutation } from "@/lib/auto-sign/http";
import { AutoSignError } from "@/lib/auto-sign/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	return handleAutoSignMutation(request, async (body) => {
		if (typeof body.taskId !== "string" || !body.taskId.trim() || body.taskId.length > 64) {
			throw new AutoSignError("INVALID_TASK_ID");
		}
		getAutoSignStore().deleteTask(body.taskId, Date.now());
		return { success: true };
	});
}
