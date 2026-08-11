/**
 * Copies the catalogue collections from one MongoDB to another.
 *
 *   node copyCatalogue.mjs            # dry run: report both sides, write nothing
 *   node copyCatalogue.mjs --apply    # actually copy
 *
 * Documents are copied verbatim with their _ids through the raw driver, so
 * slugs and references survive and re-running is idempotent (upsert by _id).
 * Nothing in the target is deleted unless --replace is passed explicitly.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const BACKEND = "/Users/aannaassalam/Documents/Github/travel-backend";
const require = createRequire(`${BACKEND}/package.json`);
const { MongoClient } = require("mongodb");

// Read .env without printing anything sensitive.
const env = Object.fromEntries(
  readFileSync(`${BACKEND}/.env`, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

/** Same rule as src/config/db.config.ts — password is never inline in the URI. */
function buildMongoUri(uri, password) {
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (uri.includes("<PASSWORD>")) {
    if (!password) throw new Error("URI has <PASSWORD> but DATABASE_PASSWORD is unset");
    return uri.replace("<PASSWORD>", encodeURIComponent(password));
  }
  const m = /^(mongodb(?:\+srv)?:\/\/)([^@/]+)@(.+)$/.exec(uri);
  if (m && !m[2].includes(":")) {
    if (!password) throw new Error("URI has a username but DATABASE_PASSWORD is unset");
    return `${m[1]}${m[2]}:${encodeURIComponent(password)}@${m[3]}`;
  }
  return uri;
}

/** Host + database only — never the credentials. */
const describe = (uri) => {
  const u = new URL(uri.replace("mongodb+srv://", "https://").replace("mongodb://", "http://"));
  return `${u.hostname}${u.pathname || ""}`;
};

const SOURCE_URI = process.env.SOURCE_URI ?? "mongodb://127.0.0.1:27017/travel_dev";
const TARGET_URI = buildMongoUri(env.MONGODB_URI, env.DATABASE_PASSWORD);

const COLLECTIONS = ["listings", "hotels", "roomtypes", "rateplans"];
const apply = process.argv.includes("--apply");
const replace = process.argv.includes("--replace");

const counts = async (db) => {
  const out = {};
  for (const c of COLLECTIONS) out[c] = await db.collection(c).countDocuments();
  return out;
};

const source = new MongoClient(SOURCE_URI);
const target = new MongoClient(TARGET_URI, { serverSelectionTimeoutMS: 20000 });

try {
  await source.connect();
  const sdb = source.db();
  console.log(`source : ${describe(SOURCE_URI)}`);
  const sCounts = await counts(sdb);
  console.log("        ", JSON.stringify(sCounts));

  await target.connect();
  const tdb = target.db();
  console.log(`target : ${describe(env.MONGODB_URI)}`);
  const tCounts = await counts(tdb);
  console.log("        ", JSON.stringify(tCounts));

  const targetTotal = Object.values(tCounts).reduce((a, b) => a + b, 0);

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing written. Target currently holds ${targetTotal} catalogue documents.`
    );
    process.exit(0);
  }

  for (const name of COLLECTIONS) {
    const docs = await sdb.collection(name).find({}).toArray();
    if (!docs.length) {
      console.log(`${name}: source empty, skipped`);
      continue;
    }
    if (replace) {
      const { deletedCount } = await tdb.collection(name).deleteMany({});
      console.log(`${name}: cleared ${deletedCount} existing`);
    }
    // Upsert by _id in batches, so a re-run is idempotent rather than duplicating.
    const BATCH = 500;
    let written = 0;
    for (let i = 0; i < docs.length; i += BATCH) {
      const slice = docs.slice(i, i + BATCH);
      const res = await tdb.collection(name).bulkWrite(
        slice.map((doc) => ({
          replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
        })),
        { ordered: false }
      );
      written += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0) + (res.matchedCount ?? 0);
    }
    console.log(`${name}: copied ${docs.length} (${written} written)`);
  }

  console.log("\nfinal target counts:", JSON.stringify(await counts(tdb)));
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await source.close().catch(() => {});
  await target.close().catch(() => {});
}
