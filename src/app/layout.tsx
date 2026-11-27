import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import {
	Inter,
	JetBrains_Mono,
	Lora,
	Noto_Sans_SC,
	Noto_Serif_SC,
	Playfair_Display,
} from "next/font/google";
import { cookies } from "next/headers";
import { isSessionValid, SESSION_COOKIE } from "@/lib/access";
import AccessGate from "./access-gate";
import "./globals.css";

const playfairDisplay = Playfair_Display({
	variable: "--font-playfair",
	subsets: ["latin"],
	display: "swap",
});

const lora = Lora({
	variable: "--font-lora",
	subsets: ["latin"],
	display: "swap",
});

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
	display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
	variable: "--font-jetbrains",
	subsets: ["latin"],
	display: "swap",
});

const notoSans = Noto_Sans_SC({
	variable: "--font-noto-sans",
	subsets: ["latin"],
	display: "swap",
});

const notoSerif = Noto_Serif_SC({
	variable: "--font-noto-serif",
	subsets: ["latin"],
	display: "swap",
});

export const metadata: Metadata = {
	title: "CookBook 日常食记 | 把日子过得有滋有味",
	description: "发现日常烹饪的美味灵感，收藏喜欢的家常菜、甜点与暖心汤品。从简单食材开始，享受下厨的每一分钟。",
	icons: {
		icon: "/cookbook.svg",
		shortcut: "/cookbook.svg",
		apple: "/cookbook.svg",
	},
};

export const viewport: Viewport = {
	themeColor: "#F9F9F7",
	colorScheme: "light",
};

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	let unlocked = false;
	try {
		unlocked = await isSessionValid((await cookies()).get(SESSION_COOKIE)?.value);
	} catch {
		// Configuration errors must never turn off access protection.
	}
	return (
		<html
			lang="zh-CN"
			data-theme="light"
			className={`${playfairDisplay.variable} ${lora.variable} ${inter.variable} ${jetBrainsMono.variable} ${notoSans.variable} ${notoSerif.variable} h-full antialiased`}
		>
			<body className="min-h-full flex flex-col">
				{unlocked ? children : <Suspense fallback={null}><AccessGate /></Suspense>}
			</body>
		</html>
	);
}
