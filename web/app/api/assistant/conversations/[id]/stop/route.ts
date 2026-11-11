import { NextRequest } from "next/server";
import { stopAssistantTurn } from "../../../../../../lib/account-api";
import { asUser } from "../../../../../../lib/assistant-proxy";

// Ask the running turn to stop at its next step.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return asUser((externalId) => stopAssistantTurn(externalId, id));
}
