// pi extension: block bash calls not matching SEAT_BASH_PREFIXES (comma list) or carrying shell control chars (repos-k1inp).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function allowed(cmd: string, prefixes: string[]): boolean {
	if (/[;&|`$<>()\r\n]/.test(cmd)) return false;
	return prefixes.some((p) => cmd === p || cmd.startsWith(p + " "));
}

export default function (pi: ExtensionAPI) {
	const prefixes = (process.env.SEAT_BASH_PREFIXES ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const cmd = String(event.input.command ?? "");
		if (allowed(cmd, prefixes)) return undefined;
		return { block: true, reason: `bash command not in allowed prefixes: ${prefixes.join(", ") || "(none)"}` };
	});
}
