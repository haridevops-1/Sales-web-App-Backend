"use strict";

const https = require("https");

https.get("https://spikra-ai-proposal-698386704.development.catalystserverless.com/spikra/experience/deploy?slug=hr-policy-and-operations_proposal", (res) => {
  let d = "";
  res.on("data", c => d += c);
  res.on("end", () => {
    const lines = d.split("\n");
    console.log("Lines 300-380 of HTML:");
    console.log(lines.slice(300, 380).join("\n"));
  });
});
