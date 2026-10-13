"use strict";

const catalyst = require("zcatalyst-sdk-node");
const { requireSession } = require("../session");
const { toErrorResponse } = require("../errors");
const { allowedOriginOrNull } = require("../config");

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readBody(req) {
	if (req.body && Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
	if (req.body && typeof req.body === "string") return Promise.resolve(req.body);
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) { req.destroy(); return reject(Object.assign(new Error("Request body is too large."), { code: "VALIDATION_FAILED", statusCode: 413 })); }
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	res.end(body);
}

function applyCors(req, res) {
	if (allowedOriginOrNull(req.headers && req.headers.origin)) {
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
		res.setHeader("Access-Control-Max-Age", "86400");
		res.setHeader("Vary", "Origin");
	}
}

// Wraps an Advanced-I/O handler so every request needs a signed-in user, except CORS
// preflights and the listed public methods. The user is exposed as req.spikraUser.
function requireAuth(handler, { publicMethods = [] } = {}) {
	return async (req, res) => {
		if (req.method === "OPTIONS" || publicMethods.includes(req.method)) return handler(req, res);
		try {
			applyCors(req, res);
			req.spikraUser = await requireSession(catalyst.initialize(req), req);
		} catch (error) {
			const { statusCode, body } = toErrorResponse(error);
			return send(res, statusCode, JSON.stringify(body));
		}
		return handler(req, res);
	};
}

// Runs a Basic-I/O style handler ((context, basicIO) => ...) as an Advanced-I/O function
// that requires a signed-in user. Arguments come from the query string and, for JSON bodies,
// from the body; the raw body is also exposed as "req_body" like Basic I/O does.
function asAdvancedIO(handler) {
	return async (req, res) => {
		try {
			applyCors(req, res);
			if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

			const app = catalyst.initialize(req);
			await requireSession(app, req);

			const args = {};
			new URL(req.url, "http://localhost").searchParams.forEach((value, key) => { args[key] = value; });
			if (req.method !== "GET" && req.method !== "HEAD") {
				const raw = await readBody(req);
				if (raw) {
					args.req_body = raw;
					try {
						const parsed = JSON.parse(raw);
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
							Object.keys(parsed).forEach((k) => {
								if (args[k] === undefined && parsed[k] !== null) args[k] = typeof parsed[k] === "object" ? JSON.stringify(parsed[k]) : String(parsed[k]);
							});
						}
					} catch { /* not JSON: handlers parse req_body themselves when they expect it */ }
				}
			}

			let status = 200;
			let out = "";
			const basicIO = {
				getArgument: (key) => args[key],
				setStatus: (code) => { status = code; },
				write: (data) => { out += String(data); }
			};
			const context = Object.assign(req, { log: (...a) => console.log(...a), close: () => {} });

			await handler(context, basicIO);
			send(res, status, out || "{}");
		} catch (error) {
			const { statusCode, body } = toErrorResponse(error);
			if (statusCode >= 500) console.error("[adapter] Request failed:", error && error.message);
			send(res, statusCode, JSON.stringify(body));
		}
	};
}

module.exports = { asAdvancedIO, requireAuth };
