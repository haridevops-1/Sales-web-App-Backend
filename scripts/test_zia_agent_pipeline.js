"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
	ZiaAgentClient,
	ConfigurationError,
	DEFAULT_ENDPOINT_PLACEHOLDER
} = require("../shared/agent");
const {
	prepareCustomerContent,
	loadMasterTemplate,
	renderMasterTemplate,
	extractTemplateCss,
	extractTemplateJs
} = require("../functions/spikra_experience_generate");

console.log("==================================================");
console.log("RUNNING TARGETED ZIA AGENT PIPELINE UNIT TESTS");
console.log("==================================================\n");

// 1. Test unconfigured endpoint behavior
console.log("Test 1: Unconfigured placeholder behavior...");
const unconfiguredProvider = new ZiaAgentClient({ endpoint: DEFAULT_ENDPOINT_PLACEHOLDER });
assert.strictEqual(unconfiguredProvider.isConfigured(), false);
unconfiguredProvider.analyzeDocument("Sample BRD document content", { businessName: "TestCorp" })
	.then(() => {
		assert.fail("Should have thrown ConfigurationError when endpoint is unconfigured");
	})
	.catch((err) => {
		assert(err instanceof ConfigurationError || err.name === "ConfigurationError");
		assert(err.message.includes("Zia Agent endpoint is not configured"));
		console.log("  [PASS] Gracefully rejects unconfigured placeholder with clear error message.");
	})
	.then(() => {
		// 2. Test normalization of Zia Agent response
		console.log("\nTest 2: Zia Agent output normalization...");
		const sampleZiaAgentOutput = {
			proposal_title: "Omnichannel Customer Experience & Field Operations",
			project_summary: "A unified platform built on Zoho CRM connecting customer service, field engineers, and executive analytics.",
			what_we_deliver: "A turnkey digital engagement layer integrated with existing backend systems.",
			spikra_way: "Transparent, BRD-aligned delivery with verified milestones and hypercare.",
			how_we_support: "Dedicated hypercare, role-based enablement, and SLA-backed support.",
			deliverable_cards: [
				{ label: "Platform", value: "Zoho CRM Suite", note: "Central hub for customer records and workflows." },
				{ label: "Scope", value: "Enterprise Rollout", note: "Multi-phase implementation across all departments." },
				{ label: "Phase 1", value: "Core Service Desk", note: "Consolidated customer ticketing and field dispatch." },
				{ label: "Phase 2", value: "ERP Integration", note: "Bi-directional synchronization of order and inventory data." },
				{ label: "Analytics", value: "Executive Dashboards", note: "Real-time metrics on conversion and SLA performance." },
				{ label: "Training", value: "Role-Based Enablement", note: "Hands-on workshops for sales and support teams." }
			],
			customer_benefits: [
				"360-degree visibility into every customer inquiry and project stage.",
				"Automated technician dispatch reducing response latency by 40%.",
				"Seamless data synchronization eliminating duplicate manual entry.",
				"Standardized reporting across executive leadership and field managers.",
				"Comprehensive audit logs for governance and compliance.",
				"Scalable cloud architecture that grows with business expansion."
			],
			capabilities: [
				{
					title: "Centralized Account Hub",
					subtitle: "Unified Customer Record",
					teaser: "Single pane of glass",
					description: "Brings together all customer interactions, site histories, and open requests into one place."
				},
				{
					title: "Field Service Dispatch",
					subtitle: "Mobile Site Execution",
					teaser: "Rapid on-site response",
					description: "Empowers field engineers to view assigned tickets, log site assessments, and update status."
				},
				{
					title: "Multi-Channel Alerts",
					subtitle: "Automated Notifications",
					teaser: "Instant status updates",
					description: "Sends automated SMS and email alerts at key milestones."
				},
				{
					title: "Legacy System Bridge",
					subtitle: "Enterprise Integration",
					teaser: "Bi-directional sync",
					description: "Connects Zoho CRM with backend operational databases securely."
				},
				{
					title: "Management Cockpit",
					subtitle: "KPI Tracking",
					teaser: "Actionable dashboards",
					description: "Provides leadership with real-time operational and revenue pipeline visibility."
				}
			],
			timeline_phases: [
				{
					name: "Discovery & Blueprinting",
					duration: "2 weeks",
					items: ["Confirm integration specifications", "Map field workflows", "Sign off on functional design"],
					note: "Baseline confirmed before build commences."
				},
				{
					name: "Phase 1: Core Configuration",
					duration: "4 weeks",
					items: ["Configure CRM modules", "Build automated routing", "Implement security profiles"],
					note: "Core system ready for testing."
				},
				{
					name: "Phase 2: Integration & UAT",
					duration: "3 weeks",
					items: ["Connect ERP endpoints", "User acceptance testing", "Data migration"],
					note: "End-to-end flow verified."
				},
				{
					name: "Go-Live & Hypercare",
					duration: "2 weeks",
					items: ["Production cutover", "User training", "Dedicated hypercare"],
					note: "Smooth launch support."
				}
			],
			rollout_overview: [
				{ label: "Phase 1 Focus", value: "Core Engagement", note: "Immediate operational gains in field dispatch." },
				{ label: "Phase 2 Focus", value: "Enterprise Connected", note: "Full system integration and reporting." }
			],
			de_risk_summary: [
				{ label: "Hypercare Guarantee", value: "Hands-on Support", note: "Immediate troubleshooting during launch." },
				{ label: "Verified Milestones", value: "Scope Certainty", note: "Requirements verified before architecture lock." }
			]
		};

		const provider = new ZiaAgentClient({ endpoint: "https://mock-agent.zoho.com/api/v1/run" });
		const normalized = provider.normalizeShowcaseContent(sampleZiaAgentOutput, {
			businessName: "Acme Industrial",
			projectName: "Acme CRM Modernization"
		});

		assert.strictEqual(normalized.proposal_title, "Omnichannel Customer Experience & Field Operations");
		assert.strictEqual(normalized.deliverable_cards.length, 6);
		assert.strictEqual(normalized.customer_benefits.length, 6);
		assert.strictEqual(normalized.capabilities.length, 5);
		assert.strictEqual(normalized.timeline_phases.length, 4);
		assert.strictEqual(normalized.rollout_overview.length, 2);
		assert.strictEqual(normalized.de_risk_summary.length, 2);
		console.log("  [PASS] Zia Agent output normalization verified.");

		// 3. Test Function 4 pure rendering
		console.log("\nTest 3: Function 4 pure template hydration...");
		const customerContent = prepareCustomerContent({
			analysisJson: normalized,
			businessName: "Acme Industrial",
			projectName: "Acme CRM Modernization"
		});

		const masterTemplate = loadMasterTemplate();
		assert(masterTemplate && masterTemplate.length > 1000, "Master template loaded successfully");

		const renderedHtml = renderMasterTemplate(masterTemplate, customerContent, {
			businessName: "Acme Industrial",
			projectName: "Acme CRM Modernization",
			logoRelativePath: null
		});

		assert(renderedHtml.includes("Acme Industrial"), "Rendered HTML contains business name");
		assert(renderedHtml.includes("Omnichannel Customer Experience"), "Rendered HTML contains proposal title");
		assert(renderedHtml.includes("Centralized Account Hub"), "Rendered HTML contains capability title");
		assert(renderedHtml.includes("Discovery & Blueprinting"), "Rendered HTML contains timeline phase");
		assert(renderedHtml.includes("Spikra"), "Rendered HTML preserves Spikra branding");
		assert(!renderedHtml.includes("@anthropic"), "Rendered HTML contains zero Anthropic references");

		const css = extractTemplateCss(masterTemplate);
		assert(css && css.length > 500, "CSS extracted from template");

		const js = extractTemplateJs(renderedHtml);
		assert(js && js.length > 200, "JS extracted from template");

		console.log("  [PASS] Function 4 pure rendering generates complete, valid, Spikra-branded proposal HTML.");

		console.log("\n==================================================");
		console.log(">>> ALL TARGETED UNIT TESTS PASSED SUCCESSFULLY! <<<");
		console.log("==================================================");
	})
	.catch((err) => {
		console.error("Test failed:", err);
		process.exit(1);
	});
