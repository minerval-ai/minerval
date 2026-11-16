import "server-only";
import { cache } from "react";
import { getAssistantHome } from "./account-api";

// The Assistant's home (GET /assistant/conversations), read once for each
// page render: the Ask section's sidebar and a new conversation's page both
// want it, and each read is a round trip to the API. Kept apart from
// account-api.ts, which the root test suite imports without the web app's
// dependencies installed.
export const loadAssistantHome = cache(getAssistantHome);
