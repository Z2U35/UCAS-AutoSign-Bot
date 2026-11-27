import { readFile } from "node:fs/promises";
import path from "node:path";

const HELP_TEXT = `Usage:
  node scripts/test-wecom.mjs [--account <accountId>]

Reads config/private.json (or UCAS_CONFIG_PATH) and sends one test Enterprise WeChat
(WeCom) text message using the configured channel (Self-built App or Group Bot Webhook):
  - With --account <id>: routes to that student's wecomUserId (or wecomWebhookUrl), falling back to adminUserIds / webhookUrl.
  - Without --account: sends directly to wecom.adminUserIds (or wecom.webhookUrl).
No secrets or tokens are printed.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP_TEXT);
	process.exit(0);
}

let accountId = null;
for (let i = 0; i < args.length; i += 1) {
	if (args[i] === "--account" && args[i + 1]) {
		accountId = args[i + 1];
		i += 1;
	} else {
		console.error("Invalid arguments. Run with --help for usage.");
		process.exit(1);
	}
}

const configPath = process.env.UCAS_CONFIG_PATH || path.join(process.cwd(), "config/private.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const wecom = config.wecom ?? {};

const corpId = typeof wecom.corpId === "string" ? wecom.corpId.trim() : "";
const corpSecret = typeof wecom.corpSecret === "string" ? wecom.corpSecret.trim() : "";
const agentIdText = typeof wecom.agentId === "number" ? String(wecom.agentId)
	: typeof wecom.agentId === "string" ? wecom.agentId.trim() : "";
const hasApp = Boolean(corpId && corpSecret && /^\d+$/.test(agentIdText));
const globalWebhook = typeof wecom.webhookUrl === "string" ? wecom.webhookUrl.trim() : "";

const adminIds = [];
if (typeof wecom.adminUserId === "string" && wecom.adminUserId.trim()) adminIds.push(wecom.adminUserId.trim());
if (Array.isArray(wecom.adminUserIds)) {
	for (const id of wecom.adminUserIds) {
		if (typeof id === "string" && id.trim()) adminIds.push(id.trim());
	}
}
const uniqueAdmins = [...new Set(adminIds)];

let targetAccount = null;
if (accountId) {
	targetAccount = (config.students ?? []).find((s) => s.id === accountId || s.name === accountId);
	if (!targetAccount) {
		console.error(`ACCOUNT_NOT_FOUND: No student matching '${accountId}' in config/private.json.`);
		process.exit(1);
	}
}

const nowText = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	year: "numeric", month: "2-digit", day: "2-digit",
	hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date());

if (hasApp) {
	const studentUserId = typeof targetAccount?.wecomUserId === "string" ? targetAccount.wecomUserId.trim() : "";
	const userIds = targetAccount
		? (studentUserId
			? (wecom.alwaysNotifyAdmin ? [...new Set([studentUserId, ...uniqueAdmins])] : [studentUserId])
			: uniqueAdmins)
		: uniqueAdmins;
	if (userIds.length === 0) {
		console.error("NO_TARGET_USER: Please set wecom.adminUserIds (or the student's wecomUserId) in config/private.json.");
		process.exit(1);
	}
	const label = targetAccount
		? (studentUserId ? `账号「${targetAccount.name}」本人` : `账号「${targetAccount.name}」（未绑 wecomUserId，走管理员兜底）`)
		: "管理员通道";

	const origin = typeof wecom.apiOrigin === "string" && wecom.apiOrigin.trim()
		? new URL(wecom.apiOrigin.trim()).origin
		: "https://qyapi.weixin.qq.com";
	const tokenRes = await fetch(`${origin}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`, {
		signal: AbortSignal.timeout(10000),
	});
	const tokenBody = await tokenRes.json().catch(() => null);
	if (!tokenRes.ok || tokenBody?.errcode !== 0 || !tokenBody?.access_token) {
		console.error(`WECOM_TOKEN_FAILED: errcode=${tokenBody?.errcode ?? "unknown"}, errmsg=${tokenBody?.errmsg ?? "unknown"}`);
		process.exit(1);
	}
	const sendRes = await fetch(`${origin}/cgi-bin/message/send?access_token=${encodeURIComponent(tokenBody.access_token)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			touser: userIds.join("|"),
			msgtype: "text",
			agentid: Number(agentIdText),
			text: {
				content: [
					"✅ UCAS 自动签到企业微信推送测试成功",
					`测试目标：${label}`,
					`发送时间：${nowText}`,
					"说明：签到成功或出现超时/失败异常时，将直接推送到个人微信（微信插件）。",
				].join("\n"),
			},
		}),
		signal: AbortSignal.timeout(10000),
	});
	const sendBody = await sendRes.json().catch(() => null);
	if (!sendRes.ok || sendBody?.errcode !== 0) {
		console.error(`WECOM_SEND_FAILED: errcode=${sendBody?.errcode ?? "unknown"}, errmsg=${sendBody?.errmsg ?? "unknown"}`);
		if (sendBody?.errcode === 60020) {
			console.error("HINT: errcode 60020 means this VPS outbound IP is not yet added to '企业可信IP' in your WeCom app settings.");
		}
		process.exit(1);
	}
	if (sendBody?.invaliduser) {
		console.error(`WARNING: Message API returned invaliduser='${sendBody.invaliduser}'. Check member UserID spelling in WeCom contacts.`);
		process.exit(1);
	}
	console.log(`SUCCESS: WeCom App message sent to ${userIds.length} recipient(s) (${label}).`);
	process.exit(0);
}

const studentWebhook = typeof targetAccount?.wecomWebhookUrl === "string" ? targetAccount.wecomWebhookUrl.trim() : "";
const webhookUrl = studentWebhook || globalWebhook;
if (webhookUrl) {
	const studentUserId = typeof targetAccount?.wecomUserId === "string" ? targetAccount.wecomUserId.trim() : "";
	const studentMobile = typeof targetAccount?.wecomMobile === "string" ? targetAccount.wecomMobile.trim() : "";
	const label = targetAccount ? `账号「${targetAccount.name}」（群机器人 Webhook）` : "群机器人 Webhook";
	const sendRes = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			msgtype: "text",
			text: {
				content: [
					"✅ UCAS 自动签到企业微信群机器人测试成功",
					`测试目标：${label}`,
					`发送时间：${nowText}`,
				].join("\n"),
				...(studentUserId ? { mentioned_list: [studentUserId] } : {}),
				...(studentMobile ? { mentioned_mobile_list: [studentMobile] } : {}),
			},
		}),
		signal: AbortSignal.timeout(10000),
	});
	const sendBody = await sendRes.json().catch(() => null);
	if (!sendRes.ok || sendBody?.errcode !== 0) {
		console.error(`WECOM_WEBHOOK_FAILED: errcode=${sendBody?.errcode ?? "unknown"}, errmsg=${sendBody?.errmsg ?? "unknown"}`);
		process.exit(1);
	}
	console.log(`SUCCESS: WeCom Webhook message sent (${label}).`);
	process.exit(0);
}

console.error("WECOM_NOT_CONFIGURED: Please fill wecom.{corpId, agentId, corpSecret, adminUserIds} OR wecom.webhookUrl in config/private.json.");
process.exit(1);
