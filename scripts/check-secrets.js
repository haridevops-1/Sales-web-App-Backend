#!/usr/bin/env node
"use strict";

// Fails if a credential-looking value is about to be committed or deployed.
// Scans every tracked and not-ignored file, and checks that no function config carries a
// secret (secrets belong in the Catalyst Console only). Run by `npm run deploy`.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP = /(^|\/)(node_modules|package-lock\.json)(\/|$)|logos\.js$|\.(png|ico|jpg|jpeg|pdf|zip)$/i;
const PATTERNS = [
	[/[0-9a-f]{40,}/i, "long hex string (looks like a key or secret)"],
	[/sk-ant-[A-Za-z0-9_-]{10,}/, "Anthropic API key"],
	[/AKIA[0-9A-Z]{16}/, "AWS access key id"],
	[/gh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
	[/1000\.[A-Za-z0-9]{20,}/, "Zoho OAuth client id"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"]
];
// Project-identifying values must live only in .env (see scripts/deploy.js).
const IDENTIFIERS = [
	[/catalystserverless\.com/, "Catalyst function/API URL"],
	[/\b698386704\b/, "Catalyst organisation / environment ID"],
	[/\b822000000\d{6}\b/, "Catalyst project or resource ID"],
	[/\b7086000000\d{6}\b/, "Catalyst Slate ID"],
	[/ziaagents\/api\/v1\/agents\/\d+/, "Zia agent endpoint"],
	[/[a-z0-9-]+\.onslate\.com/, "Slate app URL"]
];
const SECRET_KEY = /(SECRET|PASSWORD|PRIVATE|TOKEN|ENCRYPTION_KEY|CLIENT_ID|API_KEY)/i;

const files = execSync("git ls-files -co --exclude-standard", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const problems = [];

// Only the value-free template may be an env file in the repo.
for (const rel of execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
	if (/(^|\/)\.env(\..*)?$/.test(rel) && !/\.env\.example$/.test(rel)) problems.push(`${rel}: env file is tracked by git`);
}

for (const rel of files) {
	if (SKIP.test(rel) || !fs.existsSync(path.join(ROOT, rel))) continue;
	const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
	for (const [regex, label] of PATTERNS) {
		if (regex.test(text)) problems.push(`${rel}: ${label}`);
	}
	for (const [regex, label] of IDENTIFIERS) {
		if (regex.test(text)) problems.push(`${rel}: ${label} - keep it in .env, not in git`);
	}
	if (/catalyst-config\.json$/.test(rel)) {
		const vars = (JSON.parse(text).deployment || {}).env_variables || {};
		for (const key of Object.keys(vars)) problems.push(`${rel}: env_variables.${key} must be empty in git; scripts/deploy.js fills it from .env`);
	}
}

if (problems.length) {
	console.error("Secret check failed:\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log(`Secret check passed (${files.length} files scanned).`);
