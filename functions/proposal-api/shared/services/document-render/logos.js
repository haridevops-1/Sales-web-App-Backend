"use strict";

const fs = require("fs");
const path = require("path");

// Real Spikra brand artwork, copied from the frontend's own asset folder
// (src/assets/brand/) - read from disk and base64-encoded here instead of embedding a
// hand-typed data URI, so the bytes are guaranteed byte-for-byte correct rather than
// relying on transcribing a multi-thousand-character string without error.
function loadDataUri(fileName) {
	try {
		const buffer = fs.readFileSync(path.join(__dirname, "assets", fileName));
		return `data:image/png;base64,${buffer.toString("base64")}`;
	} catch (err) {
		console.log(`[document-render] Could not load logo asset ${fileName}:`, err.message);
		return "";
	}
}

// White wordmark - used in the orange/navy topbar banner on every page.
const HEADER_LOGO_DATA_URI = loadDataUri("spikra-logo-white.png");
// Full-color mark - used once on the cover page.
const COVER_LOGO_DATA_URI = loadDataUri("spikra-logo.png");

module.exports = { HEADER_LOGO_DATA_URI, COVER_LOGO_DATA_URI };
