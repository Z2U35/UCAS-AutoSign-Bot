import { NextRequest } from "next/server";
import { accessJson, requireAccess } from "@/lib/access";
import { readPrivateConfig } from "@/lib/private-config";

export async function GET(request: NextRequest) {
	const accessError = await requireAccess(request);
	if (accessError) return accessError;
	try {
		const config = await readPrivateConfig();
		return accessJson({ students: config.students.map(({ id, name }) => ({ id, name })) });
	} catch {
		return accessJson({ message: "Private configuration is missing or invalid." }, 503);
	}
}
