import { ensureMigrated, isDatabaseConfigured } from "./pool.js";

if (!isDatabaseConfigured()) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

ensureMigrated()
  .then(() => {
    console.log("[db] migrate ok");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
