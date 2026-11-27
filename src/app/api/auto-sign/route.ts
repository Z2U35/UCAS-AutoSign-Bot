import { NextRequest } from "next/server";
import { accessJson, requireAccess } from "@/lib/access";
import { readPrivateConfig } from "@/lib/private-config";
import { getAutoSignMode, getAutoSignStore, isAutoSignConfigured } from "@/lib/auto-sign/environment";
import { autoSignErrorResponse } from "@/lib/auto-sign/http";
import type { AutoSignSnapshot } from "@/lib/auto-sign/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
	const accessError = await requireAccess(request);
	if (accessError) return accessError;
	try {
		const config = await readPrivateConfig();
		const available = isAutoSignConfigured();
		const store = available ? getAutoSignStore() : null;
		store?.synchronizeAccounts(config.students, Date.now());
		const snapshot: AutoSignSnapshot = {
			available, mode: getAutoSignMode(),
			accounts: store?.listAccounts(config.students) ?? config.students.map((account) => ({ accountId: account.id, name: account.name, enabled: false })),
			tasks: store?.listTasks() ?? [], scheduler: store?.getHeartbeat() ?? null,
		};
		return accessJson(snapshot, 200);
	} catch (error) {
		return autoSignErrorResponse(error);
	}
}
