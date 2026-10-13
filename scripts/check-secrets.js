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
const SECRET_KEY = /(SECRET|PASSWORD|PRIVATE|TOKEN|ENCRYPTION_KEY|CLIENT_ID|API_KEY)/i;

const files = execSync("git ls-files -co --exclude-standard", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const problems = [];

for (const rel of files) {
	if (SKIP.test(rel) || !fs.existsSync(path.join(ROOT, rel))) continue;
	const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
	for (const [regex, label] of PATTERNS) {
		if (regex.test(text)) problems.push(`${rel}: ${label}`);
	}
	if (/catalyst-config\.json$/.test(rel)) {
		const vars = (JSON.parse(text).deployment || {}).env_variables || {};
		for (const [key, value] of Object.entries(vars)) {
			if (SECRET_KEY.test(key)) problems.push(`${rel}: ${key} must be set in the Catalyst Console, not in the config`);
		}
	}
}

if (problems.length) {
	console.error("Secret check failed:\n  " + problems.join("\n  "));
	process.exit(1);
}
console.log(`Secret check passed (${files.length} files scanned).`);
