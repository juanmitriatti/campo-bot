import pg from "pg";
import dotenv from "dotenv";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";

dotenv.config();

const txContext = new AsyncLocalStorage();

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const originalQuery = pool.query.bind(pool);
const originalConnect = pool.connect.bind(pool);

pool.query = function (...args) {
  const client = txContext.getStore();
  if (client) return client.query(...args);
  return originalQuery(...args);
};

function makeSavepointClient(outer) {
  const spId = `sp_${crypto.randomBytes(4).toString("hex")}`;
  let begun = false;
  return {
    query: async (text, params) => {
      if (typeof text === "string") {
        const trimmed = text.trim().toUpperCase();
        if (trimmed === "BEGIN" || trimmed.startsWith("BEGIN ")) {
          begun = true;
          return outer.query(`SAVEPOINT ${spId}`);
        }
        if (trimmed === "COMMIT") {
          if (!begun) return { rows: [] };
          begun = false;
          return outer.query(`RELEASE SAVEPOINT ${spId}`);
        }
        if (trimmed === "ROLLBACK") {
          if (!begun) return { rows: [] };
          begun = false;
          return outer.query(`ROLLBACK TO SAVEPOINT ${spId}`);
        }
      }
      return outer.query(text, params);
    },
    release: () => {},
  };
}

pool.connect = function (cb) {
  const outer = txContext.getStore();
  if (!outer) return originalConnect(cb);
  const fake = makeSavepointClient(outer);
  if (typeof cb === "function") {
    cb(null, fake, () => {});
    return undefined;
  }
  return Promise.resolve(fake);
};

export async function withTransaction(fn) {
  const existing = txContext.getStore();
  if (existing) {
    return fn();
  }
  const client = await originalConnect();
  try {
    await client.query("BEGIN");
    const result = await txContext.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // swallow rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}
