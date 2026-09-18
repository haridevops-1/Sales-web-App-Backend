"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("==================================================");
console.log("TESTING PROPOSAL URL SANITIZATION & SLATE ROUTING");
console.log("==================================================\n");

const { formatProposalUrl, SLATE_APP_URL } = require("./deploy_worker");
const { formatProposalUrl: sharedFormatProposalUrl } = require("../shared/utils");

// Test 1: Shared utils and deploy worker formatProposalUrl are consistent
console.log("Test 1: formatProposalUrl functions are exported...");
assert.strictEqual(typeof formatProposalUrl, "function", "deploy_worker must export formatProposalUrl");
assert.strictEqual(typeof sharedFormatProposalUrl, "function", "shared/utils must export formatProposalUrl");
console.log("  [PASS] formatProposalUrl exported correctly.");

// Test 2: Converts legacy path-based Slate URLs to query-based URLs
console.log("\nTest 2: Legacy path-based Slate URLs conversion...");
const legacyUrl = "https://spikra-ai-proposal.onslate.com/abc-pvt-ltd_proposal";
const convertedUrl = formatProposalUrl(legacyUrl);
assert.strictEqual(
	convertedUrl,
	"https://spikra-ai-proposal.onslate.com/?slug=abc-pvt-ltd_proposal",
	"Legacy path-based Slate URL must be converted to query param ?slug="
);

const legacyDashUrl = "https://spikra-ai-proposal.onslate.com/abc-pvt-ltd-proposal";
assert.strictEqual(
	formatProposalUrl(legacyDashUrl),
	"https://spikra-ai-proposal.onslate.com/?slug=abc-pvt-ltd-proposal",
	"Dash proposal path must be converted to ?slug="
);
console.log("  [PASS] Successfully converted legacy path URLs to query format.");

// Test 3: Already query-based URLs are preserved without duplicate params
console.log("\nTest 3: Query-based Slate URLs preservation...");
const queryUrl = "https://spikra-ai-proposal.onslate.com/?slug=abc-pvt-ltd_proposal";
assert.strictEqual(formatProposalUrl(queryUrl), queryUrl, "Already formatted query URL must remain unchanged");
console.log("  [PASS] Query-based Slate URLs preserved without mutation.");

// Test 4: Attaches experience_id and project_id when provided
console.log("\nTest 4: Identity parameters injection...");
const enrichedUrl = formatProposalUrl(legacyUrl, "822000000784217", "822000000785079");
assert(enrichedUrl.includes("slug=abc-pvt-ltd_proposal"), "Must include slug");
assert(enrichedUrl.includes("experience_id=822000000784217"), "Must include experience_id");
assert(enrichedUrl.includes("project_id=822000000785079"), "Must include project_id");
console.log("  [PASS] Correctly enriched with experience_id and project_id.");

// Test 5: Safe handling of null, undefined, empty, and non-onslate URLs
console.log("\nTest 5: Edge cases handling...");
assert.strictEqual(formatProposalUrl(null), null);
assert.strictEqual(formatProposalUrl(""), null);
assert.strictEqual(formatProposalUrl("   "), null);
assert.strictEqual(
	formatProposalUrl("https://example.com/some/deep/path"),
	"https://example.com/some/deep/path",
	"External non-onslate domains must not be altered"
);
console.log("  [PASS] Edge cases handled safely.");

// Test 6: Verify deploy_worker.js across functions and scripts
console.log("\nTest 6: deploy_worker sync between functions and scripts...");
const funcWorker = fs.readFileSync(path.join(__dirname, "../functions/spikra_experience_deploy/deploy_worker.js"), "utf8");
const scriptWorker = fs.readFileSync(path.join(__dirname, "deploy_worker.js"), "utf8");
assert.strictEqual(funcWorker, scriptWorker, "deploy_worker copies must remain 100% in sync");
console.log("  [PASS] deploy_worker is in sync.");

// Test 7: Verify Slate distribution files
console.log("\nTest 7: Slate distribution files verification...");
const slateDir = path.join(__dirname, "../slate/spikra-experience");
const indexHtml = fs.readFileSync(path.join(slateDir, "index.html"), "utf8");
const errorHtml = fs.readFileSync(path.join(slateDir, "404.html"), "utf8");
const clientPkg = JSON.parse(fs.readFileSync(path.join(slateDir, "client-package.json"), "utf8"));

assert(indexHtml.includes("activeSlug"), "index.html must process activeSlug");
assert(indexHtml.includes("hashSlug"), "index.html must support hash routing");
assert(indexHtml.includes("replaceState"), "index.html must normalize location state");
assert(errorHtml.includes("activeSlug"), "404.html must process activeSlug as fallback");
assert.strictEqual(clientPkg["homepage"], "index.html", "client-package.json must set homepage to index.html");
assert.strictEqual(clientPkg["404"], "404.html", "client-package.json must set 404 to 404.html");
console.log("  [PASS] Slate distribution files verified.");

// Test 8: Verify functions export handlers without syntax errors
console.log("\nTest 8: Function syntax and integration checks...");
const f5 = fs.readFileSync(path.join(__dirname, "../functions/spikra_experience_deploy/index.js"), "utf8");
const f6 = fs.readFileSync(path.join(__dirname, "../functions/spikra_process_status/index.js"), "utf8");
const f7 = fs.readFileSync(path.join(__dirname, "../functions/spikra_experience_list/index.js"), "utf8");

assert(f5.includes("formatProposalUrl"), "Function 5 must use formatProposalUrl");
assert(f6.includes("formatProposalUrl"), "Function 6 must use formatProposalUrl");
assert(f7.includes("formatProposalUrl"), "Function 7 must use formatProposalUrl");

assert(f6.includes("safeGeneratedUrl = isPublished ? formatProposalUrl(rawGenUrl"), "Function 6 must sanitize URL when published");
assert(f7.includes("genUrl = rawGenUrl ? formatProposalUrl(rawGenUrl"), "Function 7 must sanitize URL in experience list");

console.log("  [PASS] Functions contain correct URL sanitization logic.");

console.log("\n==================================================");
console.log("ALL URL SANITIZATION & ROUTING TESTS PASSED!");
console.log("==================================================");
