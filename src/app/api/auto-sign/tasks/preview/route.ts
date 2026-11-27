import { NextRequest } from "next/server";
import { getAutoSignStore } from "@/lib/auto-sign/environment";
import { handleAutoSignMutation } from "@/lib/auto-sign/http";
import { AutoSignService } from "@/lib/auto-sign/service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
	return handleAutoSignMutation(request, async (body) => ({
		preview: await new AutoSignService(getAutoSignStore()).previewTask(body),
	}), true);
}
