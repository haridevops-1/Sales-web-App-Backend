"use strict";

try {
  require("dotenv").config();
} catch {}

const catalyst = require("zcatalyst-sdk-node");

async function check() {
  const app = catalyst.initialize();
  const zcql = app.zcql();

  console.log("Querying EXPERIENCES...");
  try {
    const expRes = await zcql.executeZCQLQuery("SELECT ROWID, project_id, business_name, status, generated_url FROM EXPERIENCES LIMIT 5");
    console.log("EXPERIENCES records:", JSON.stringify(expRes, null, 2));
  } catch (e) {
    console.error("EXPERIENCES query error:", e.message);
  }

  console.log("\nQuerying PROJECTS...");
  try {
    const projRes = await zcql.executeZCQLQuery("SELECT ROWID, business_name, status, generated_url FROM PROJECTS LIMIT 5");
    console.log("PROJECTS records:", JSON.stringify(projRes, null, 2));
  } catch (e) {
    console.error("PROJECTS query error:", e.message);
  }
}

check().catch(console.error);
