import { NextRequest } from "next/server";
import { getAutoSignMode, getAutoSignStore } from "@/lib/auto-sign/environment";
import { handleAutoSignMutation } from "@/lib/auto-sign/http";
import { AutoSignService } from "@/lib/auto-sign/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	return handleAutoSignMutation(request, async (body) => ({
		task: await new AutoSignService(getAutoSignStore()).createTask(body, getAutoSignMode()),
	}), true);
}
