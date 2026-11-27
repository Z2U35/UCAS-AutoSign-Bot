import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	async headers() {
		return [{
			source: "/:path*",
			headers: [
				{ key: "X-Frame-Options", value: "DENY" },
				{ key: "X-Content-Type-Options", value: "nosniff" },
				// no-referrer makes native form POSTs send Origin: null, failing CSRF checks.
				{ key: "Referrer-Policy", value: "same-origin" },
			],
		}];
	},
};

export default nextConfig;
