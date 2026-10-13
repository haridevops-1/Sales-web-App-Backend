"use strict";

const { WorkdriveError } = require("../errors");

// Zoho data centres. Accounts/API hosts are only ever taken from this table, never from
// request input, so the OAuth client secret can only be sent to a genuine Zoho host.
const ZOHO_REGIONS = {
	com: { accounts: "https://accounts.zoho.com", api: "https://www.zohoapis.com/workdrive/api/v1" },
	in: { accounts: "https://accounts.zoho.in", api: "https://www.zohoapis.in/workdrive/api/v1" },
	eu: { accounts: "https://accounts.zoho.eu", api: "https://www.zohoapis.eu/workdrive/api/v1" },
	"com.au": { accounts: "https://accounts.zoho.com.au", api: "https://www.zohoapis.com.au/workdrive/api/v1" },
	jp: { accounts: "https://accounts.zoho.jp", api: "https://www.zohoapis.jp/workdrive/api/v1" },
	sa: { accounts: "https://accounts.zoho.sa", api: "https://www.zohoapis.sa/workdrive/api/v1" },
	ca: { accounts: "https://accounts.zohocloud.ca", api: "https://www.zohoapis.ca/workdrive/api/v1" },
	"com.cn": { accounts: "https://accounts.zoho.com.cn", api: "https://www.zohoapis.com.cn/workdrive/api/v1" }
};

function requireEnv(name, minLength = 1) {
	const value = String(process.env[name] || "").trim();
	if (value.length < minLength) {
		console.error(`[config] Required environment variable ${name} is missing or too short.`);
		throw new WorkdriveError("CONFIG_ERROR", "Server configuration error.", 500);
	}
	return value;
}

function getAllowedOrigins() {
	return requireEnv("ALLOWED_ORIGINS")
		.split(",")
		.map((o) => o.trim().replace(/\/+$/, ""))
		.filter(Boolean);
}

// Only accounts whose email domain is listed here may sign in (comma-separated, e.g. "spikra.com").
function emailDomainAllowed(email) {
	const domains = requireEnv("ALLOWED_EMAIL_DOMAINS")
		.split(",")
		.map((d) => d.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);
	const domain = String(email || "").toLowerCase().split("@").pop();
	return domains.includes(domain);
}

function normalizeOrigin(value) {
	if (!value) return null;
	try {
		const url = new URL(String(value));
		return url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}

// Returns the canonical origin if it is on the allowlist, otherwise null.
function allowedOriginOrNull(value) {
	const origin = normalizeOrigin(value);
	return origin && getAllowedOrigins().includes(origin) ? origin : null;
}

function regionKeyForAccounts(accountsUrl) {
	const normalized = String(accountsUrl || "").trim().replace(/\/+$/, "").toLowerCase();
	return Object.keys(ZOHO_REGIONS).find((key) => ZOHO_REGIONS[key].accounts === normalized) || null;
}

// Accepts a region key ("in") or an accounts URL; rejects anything not in ZOHO_REGIONS.
function resolveRegion(input) {
	const raw = String(input || "").trim().toLowerCase();
	const key = ZOHO_REGIONS[raw] ? raw : regionKeyForAccounts(raw);
	if (!key) throw new WorkdriveError("VALIDATION_FAILED", "Unsupported Zoho data centre.", 400);
	return { key, ...ZOHO_REGIONS[key] };
}

function defaultRegion() {
	return resolveRegion(requireEnv("ZOHO_ACCOUNTS_DOMAIN"));
}

module.exports = {
	ZOHO_REGIONS,
	requireEnv,
	getAllowedOrigins,
	allowedOriginOrNull,
	emailDomainAllowed,
	resolveRegion,
	defaultRegion
};
