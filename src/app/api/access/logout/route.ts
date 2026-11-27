import { NextRequest } from "next/server";
import { accessJson, isSameOrigin, revokeSession, SESSION_COOKIE } from "@/lib/access";

export async function POST(request: NextRequest) {
	if (!isSameOrigin(request)) return accessJson({ message: "Invalid request origin." }, 403);
	revokeSession(request.cookies.get(SESSION_COOKIE)?.value);
	const response = accessJson({ success: true });
	response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
	return response;
}
