"use strict";

const https = require("https");

https.get("https://spikra-ai-proposal-698386704.development.catalystserverless.com/spikra/experience/deploy?slug=hr-policy-and-operations_proposal", (res) => {
  let d = "";
  res.on("data", c => d += c);
  res.on("end", () => {
    const titleMatch = d.match(/<title>([\s\S]*?)<\/title>/);
    console.log("Title:", titleMatch ? titleMatch[1] : "None");

    const imgMatches = d.match(/<img[^>]+src=["'](.*?)["']/g) || [];
    console.log("Images (first 10):", imgMatches.slice(0, 10));

    const linkMatches = d.match(/<link[^>]+href=["'](.*?)["']/g) || [];
    console.log("Links:", linkMatches);

    const scriptMatches = d.match(/<script[^>]+src=["'](.*?)["']/g) || [];
    console.log("Scripts:", scriptMatches);

    // Also check for client-logo or logo class
    const logoSection = d.match(/class=["'][^"']*logo[^"']*["'][\s\S]{0,300}/gi) || [];
    console.log("Logo sections:", logoSection.slice(0, 3));
  });
});
