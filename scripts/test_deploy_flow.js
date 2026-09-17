"use strict";

try {
  require("dotenv").config();
} catch {}

const https = require("https");

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function testDeploy() {
  console.log("Triggering deploy for Joy & Co (experience_id: 822000000769125)...");
  const res = await postJson("https://spikra-ai-proposal-698386704.development.catalystserverless.com/spikra/experience/deploy", {
    experience_id: "822000000769125",
    project_id: "822000000775374",
    document_id: "822000000767731",
    business_name: "Joy & Co Home Appliances"
  });
  console.log("Deploy response status:", res.statusCode);
  console.log("Deploy response body:", JSON.stringify(res.body, null, 2));

  const finalUrl = res.body.generated_url;
  if (finalUrl) {
    console.log("\nTesting generated friendly URL:", finalUrl);
    const slug = finalUrl.split("/").pop();
    console.log("Slug:", slug);

    // Test Function 5 GET by slug
    const fnRes = await new Promise((resolve, reject) => {
      https.get(`https://spikra-ai-proposal-698386704.development.catalystserverless.com/spikra/experience/deploy?slug=${encodeURIComponent(slug)}`, (r) => {
        let b = "";
        r.on("data", c => b += c);
        r.on("end", () => resolve({ status: r.statusCode, length: b.length, preview: b.substring(0, 200).replace(/\n/g, " ") }));
      }).on("error", reject);
    });
    console.log("Function 5 GET by slug status:", fnRes.status, "length:", fnRes.length);
    console.log("Preview:", fnRes.preview);
  }
}

testDeploy().catch(console.error);
