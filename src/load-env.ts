// Side-effect import: loads .env into process.env before anything else reads
// it. Replaces `import "dotenv/config"`, which since dotenv 17 logs a line on
// every load.
import { config } from "dotenv";

config({ quiet: true });
