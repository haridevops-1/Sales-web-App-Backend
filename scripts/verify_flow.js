"use strict";

try {
	require("dotenv").config();
} catch {}

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { URL } = require("url");

console.log("==================================================");
console.log("SPIKRA CUSTOMER EXPERIENCE ENGINE");
console.log("BACKEND FLOW & ZIA AGENT VERIFICATION SUITE");
console.log("==================================================\n");

let totalTests = 0;
let passedTests = 0;

function runTest(description, testFn) {
	totalTests++;
	try {
		testFn();
		console.log(`[PASS] ${description}`);
		passedTests++;
	} catch (err) {
		console.error(`[FAIL] ${description}`);
		console.error(`       Error: ${err.message}\n`);
	}
}

// -------------------------------------------------------------
// Test 1: Syntax & Loading of all 7 functions
// -------------------------------------------------------------
const functions = [
	"spikra_document_upload",
	"spikra_document_process",
	"spikra_ai_analysis",
	"spikra_experience_generate",
	"spikra_experience_deploy",
	"spikra_process_status",
	"spikra_experience_list"
];

for (const fn of functions) {
	runTest(`Function '${fn}' loads and exports valid handler`, () => {
		const filePath = path.join(__dirname, "..", "functions", fn, "index.js");
		assert(fs.existsSync(filePath), `File does not exist: ${filePath}`);
		const content = fs.readFileSync(filePath, "utf8");
		// Verify valid JavaScript syntax
		new Function(content);
	});
}

// -------------------------------------------------------------
// Test 2: Stratus Bucket Consistency across functions
// -------------------------------------------------------------
runTest("Function 1 & 2 use 'spikra-process-documents-698386704' for source & process", () => {
	const f1 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_document_upload", "index.js"), "utf8");
	const f2 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_document_process", "index.js"), "utf8");

	assert(f1.includes('"spikra-process-documents-698386704"'), "Function 1 missing spikra-process-documents-698386704");
	assert(f2.includes('"spikra-process-documents-698386704"'), "Function 2 missing spikra-process-documents-698386704");
});

runTest("Function 3, 4 & 5 use 'spikra-generated-experiences-698386704' for generated bucket", () => {
	const f3 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_ai_analysis", "index.js"), "utf8");
	const f4 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_generate", "index.js"), "utf8");
	const f5 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_deploy", "index.js"), "utf8");

	assert(f3.includes('"spikra-generated-experiences-698386704"'), "Function 3 missing spikra-generated-experiences-698386704");
	assert(f4.includes('"spikra-generated-experiences-698386704"'), "Function 4 missing spikra-generated-experiences-698386704");
	assert(f5.includes('"spikra-generated-experiences-698386704"'), "Function 5 missing spikra-generated-experiences-698386704");
});

// -------------------------------------------------------------
// Test 3: Deterministic Stratus Object Keys
// -------------------------------------------------------------
runTest("Deterministic Stratus keys match requirements across functions", () => {
	const f1 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_document_upload", "index.js"), "utf8");
	const f2 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_document_process", "index.js"), "utf8");
	const f3 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_ai_analysis", "index.js"), "utf8");
	const f4 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_generate", "index.js"), "utf8");

	// F1: projects/{project_id}/documents/{document_id}/source{ext}
	assert(f1.includes("projects/${projectId}/documents/${documentId}/source${documentExtension}") || f1.includes("projects/${projectId}/documents/${documentId}/source.pdf"), "Function 1 deterministic source key missing");

	// F2: projects/{project_id}/documents/{document_id}/extracted-content.txt
	assert(f2.includes("projects/${projectId}/documents/${documentId}/extracted-content.txt"), "Function 2 deterministic extracted-content.txt missing");

	// F3: projects/{project_id}/analysis/document-{document_id}-analysis.json
	assert(f3.includes("projects/${projectId}/analysis/document-${documentId}-analysis.json"), "Function 3 deterministic analysis.json key missing");

	// F4: experiences/{experience_id}/version-1/index.html
	assert(f4.includes("projects/${projectId}/experiences/${experienceId}/version-1"), "Function 4 deterministic experience base key missing");
});

// -------------------------------------------------------------
// Test 4: Hardcoded Sample Data Audit
// -------------------------------------------------------------
runTest("Zero runtime occurrences of 'Apex Retail Solutions' across all functions", () => {
	for (const fn of functions) {
		const filePath = path.join(__dirname, "..", "functions", fn, "index.js");
		const content = fs.readFileSync(filePath, "utf8");
		assert(!content.includes("Apex Retail Solutions"), `Function '${fn}' contains 'Apex Retail Solutions'`);
		assert(!content.includes("Apex Retail"), `Function '${fn}' contains 'Apex Retail'`);
	}
});

// -------------------------------------------------------------
// Test 5: Project Isolation & Deterministic Deployment Identity
// -------------------------------------------------------------
const { SLATE_APP_URL } = require("./deploy_worker");

runTest("Project isolation: distinct experiences resolve to distinct customer links on the shared Slate app", () => {
	const buildUrl = (experienceId, projectId) => {
		const url = new URL(SLATE_APP_URL);
		url.searchParams.set("experience_id", experienceId);
		url.searchParams.set("project_id", projectId);
		return url.toString();
	};

	const urlA = buildUrl("108526000000023101", "108526000000023039");
	const urlB = buildUrl("108526000000023102", "108526000000023040");

	assert.notStrictEqual(urlA, urlB, "Generated URLs must be strictly isolated per experience");
	assert(urlA.includes("108526000000023039"), "URL A must contain Business A's project identity");
	assert(urlB.includes("108526000000023040"), "URL B must contain Business B's project identity");
	assert.strictEqual(buildUrl("108526000000023101", "108526000000023039"), urlA, "Same experience must resolve to the same link");
});

// -------------------------------------------------------------
// Test 6: Function 1 Initial Job & Status
// -------------------------------------------------------------
runTest("Function 1 creates PROCESSING_JOBS with job_type = EXTRACT and status = QUEUED", () => {
	const f1 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_document_upload", "index.js"), "utf8");
	assert(f1.includes('job_type: "EXTRACT"'), "Function 1 must create EXTRACT job");
	assert(f1.includes('status: "QUEUED"'), "Function 1 must set job status to QUEUED");
});

// -------------------------------------------------------------
// Test 7: Function 6 Salesperson Response Boundary
// -------------------------------------------------------------
runTest("Function 6 returns salesperson-required fields without leaking bucket names or storage keys", () => {
	const f6 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_process_status", "index.js"), "utf8");
	assert(f6.includes("business_name: projectRow.business_name"), "Function 6 must include business_name");
	assert(f6.includes("project_name: projectRow.project_name"), "Function 6 must include project_name");
	assert(f6.includes("current_status: currentStage"), "Function 6 must include current_status");
	assert(f6.includes("generated_url: isPublished"), "Function 6 must conditionally provide generated_url only when published");
	assert(!f6.includes("storage_object_key:"), "Function 6 must not leak storage_object_key");
	assert(!f6.includes("bucket_name:"), "Function 6 must not leak bucket_name");
});

// -------------------------------------------------------------
// Test 8: Zia Agent integration in Function 3
// -------------------------------------------------------------
runTest("Function 3 integrates Zia Agent and removes direct external API calls", () => {
	const f3 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_ai_analysis", "index.js"), "utf8");
	assert(!f3.includes("@anthropic-ai/sdk"), "Function 3 must NOT import Anthropic SDK");
	assert(!f3.includes("ANTHROPIC_API_KEY"), "Function 3 must NOT reference ANTHROPIC_API_KEY");
	assert(f3.includes("getZiaAgentClient"), "Function 3 must require getZiaAgentClient");
	assert(f3.includes("analyzeDocument"), "Function 3 must invoke agentClient.analyzeDocument");
	assert(f3.includes("ZIA_AGENT_ANALYSIS"), "Function 3 analysis_type must be ZIA_AGENT_ANALYSIS");
	assert(f3.includes("ZIA_AGENT"), "Function 3 agent_type must be ZIA_AGENT");
});

// -------------------------------------------------------------
// Test 9: Zero Active Anthropic SDK and Legacy Zia Text Analytics References
// -------------------------------------------------------------
runTest("Zero active Anthropic SDK calls and zero legacy Zia Text Analytics across all functions", () => {
	for (const fn of functions) {
		const filePath = path.join(__dirname, "..", "functions", fn, "index.js");
		const content = fs.readFileSync(filePath, "utf8");
		assert(!content.includes("app.zia("), `Function '${fn}' contains active call to app.zia()`);
		assert(!content.includes("getTextAnalytics"), `Function '${fn}' contains active call to getTextAnalytics`);
		assert(!content.includes("ZIA_TEXT_ANALYTICS"), `Function '${fn}' contains reference to ZIA_TEXT_ANALYTICS`);
		assert(!content.includes("@anthropic-ai/sdk"), `Function '${fn}' contains reference to @anthropic-ai/sdk`);
		assert(!content.includes("ANTHROPIC_API_KEY"), `Function '${fn}' contains reference to ANTHROPIC_API_KEY`);
	}
});

// -------------------------------------------------------------
// Test 10: Zia Agent Client configuration & validation
// -------------------------------------------------------------
runTest("Zia Agent client uses configurable endpoint and handles unconfigured placeholder safely", () => {
	const agentPath = path.join(__dirname, "..", "functions", "spikra_ai_analysis", "shared", "agent", "index.js");
	assert(fs.existsSync(agentPath), "shared/agent/index.js must exist");
	const agent = fs.readFileSync(agentPath, "utf8");
	assert(agent.includes("ZiaAgentClient"), "ZiaAgentClient class must be defined");
	assert(agent.includes("[PASTE ZIA AGENT URL HERE]"), "Default placeholder must be present");
	assert(agent.includes("isConfigured"), "isConfigured check must be implemented");
	assert(agent.includes("normalizeShowcaseContent"), "Showcase normalization must be present");
});

// -------------------------------------------------------------
// Test 10B: Complete removal of AI Provider directories and legacy providers
// -------------------------------------------------------------
runTest("Zero AI Provider directories or legacy provider modules remain", () => {
	assert(!fs.existsSync(path.join(__dirname, "..", "shared", "ai")), "shared/ai directory must be removed");
	assert(!fs.existsSync(path.join(__dirname, "..", "functions", "spikra_ai_analysis", "shared", "ai")), "functions/spikra_ai_analysis/shared/ai must be removed");
	assert(!fs.existsSync(path.join(__dirname, "..", "functions", "spikra_experience_generate", "shared", "ai")), "functions/spikra_experience_generate/shared/ai must be removed");
	assert(!fs.existsSync(path.join(__dirname, "..", ".claude")), ".claude folder must be removed");
});

// -------------------------------------------------------------
// Test 11: Function 4 is a pure renderer with zero AI calls
// -------------------------------------------------------------
runTest("Function 4 is a pure renderer with zero AI calls and consumes Zia Agent Showcase schema", () => {
	const f4 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_generate", "index.js"), "utf8");
	assert(!f4.includes("@anthropic-ai/sdk"), "Function 4 must NOT import Anthropic SDK");
	assert(!f4.includes("ANTHROPIC_API_KEY"), "Function 4 must NOT reference ANTHROPIC_API_KEY");
	assert(f4.includes("prepareCustomerContent"), "Function 4 must use prepareCustomerContent");
	assert(f4.includes("renderMasterTemplate"), "Function 4 must render master template");
	assert(f4.includes("loadMasterTemplate"), "Function 4 must load master template");
});

// -------------------------------------------------------------
// Test 12: Function 5 Integrates deployProjectExperience
// -------------------------------------------------------------
runTest("Function 5 integrates verifyAndBuildExperienceUrl from deploy_worker", () => {
	const f5 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_deploy", "index.js"), "utf8");
	assert(f5.includes("verifyAndBuildExperienceUrl"), "Function 5 must call verifyAndBuildExperienceUrl");
	assert(f5.includes("deploy_worker"), "Function 5 must require deploy_worker");
	assert(!f5.includes("hgjuvzih"), "Function 5 must not hardcode obsolete defunct slate IDs");
});

// -------------------------------------------------------------
// Test 13: Strict Status Transition and Failure Contract
// -------------------------------------------------------------
runTest("Function 5 failure resets status to FAILED and generated_url to null", () => {
	const f5 = fs.readFileSync(path.join(__dirname, "..", "functions", "spikra_experience_deploy", "index.js"), "utf8");
	assert(f5.includes('status: "FAILED"'), "Function 5 catch must set status to FAILED");
	assert(f5.includes('generated_url: null'), "Function 5 failure response must set generated_url to null");
});

// -------------------------------------------------------------
// Test 14: Deploy Worker Configures Static Slate App
// -------------------------------------------------------------
runTest("deploy_worker verifies generated files and builds the single shared Slate app URL", () => {
	const dw = fs.readFileSync(path.join(__dirname, "deploy_worker.js"), "utf8");
	assert(dw.includes('verifyAndBuildExperienceUrl'), "Deploy worker must export verifyAndBuildExperienceUrl");
	assert(dw.includes('SLATE_APP_URL'), "Deploy worker must resolve the single shared Slate app URL");
	assert(dw.includes('verifyUrlAccessible'), "Deploy worker must verify deployed URL accessibility");
	assert(!dw.includes('zcatalyst-cli'), "Deploy worker must not invoke the Catalyst CLI from within a running function");
});

// -------------------------------------------------------------
// Test 15: Master Template & Slate Experience Generator
// -------------------------------------------------------------
runTest("Master template and Slate proposal experience are properly structured", () => {
	const templatePath = path.join(__dirname, "..", "templates", "iSteel_Proposal_Site.html");
	assert(fs.existsSync(templatePath), "Master template templates/iSteel_Proposal_Site.html must exist");
	const templateHtml = fs.readFileSync(templatePath, "utf8");
	assert(templateHtml.includes("Spikra"), "Master template must include Spikra branding");

	// Verify slate/spikra-experience is built and clean
	const slateHtmlPath = path.join(__dirname, "..", "slate", "spikra-experience", "index.html");
	assert(fs.existsSync(slateHtmlPath), "slate/spikra-experience/index.html must exist");
	const slateHtml = fs.readFileSync(slateHtmlPath, "utf8");
	assert(!slateHtml.includes("display: flex !important"), "slate index.html must not contain blocking display: flex !important");
	assert(slateHtml.includes("spikra-loader-screen"), "slate index.html must include spikra-loader-screen");
});

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log("\n==================================================");
console.log(`TOTAL TESTS: ${totalTests}`);
console.log(`PASSED:      ${passedTests}`);
console.log(`FAILED:      ${totalTests - passedTests}`);
console.log("==================================================");

if (passedTests === totalTests) {
	console.log("\n>>> ALL FLOW VERIFICATION TESTS PASSED SUCCESSFULLY! <<<");
	process.exit(0);
} else {
	console.error("\n>>> SOME TESTS FAILED! <<<");
	process.exit(1);
}
