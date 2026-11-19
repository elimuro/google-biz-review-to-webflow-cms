import { createLogger, loadConfig, redactSecrets } from "../../src/config.js";
import { formatSummary, syncReviews } from "../../src/sync.js";

function readNetlifyEnv(name) {
  if (typeof Netlify === "undefined" || typeof Netlify.env?.get !== "function") {
    throw new Error(
      "Review sync failed: Netlify.env.get is unavailable, so secrets were not read.",
    );
  }
  const value = Netlify.env.get(name);
  if (value == null) return "";
  return String(value);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async function syncReviewsHandler() {
  const logger = createLogger();
  let secrets = [];
  try {
    const config = loadConfig({
      GOOGLE_API_KEY: readNetlifyEnv("GOOGLE_API_KEY"),
      GOOGLE_PLACE_ID: readNetlifyEnv("GOOGLE_PLACE_ID"),
      WEBFLOW_API_TOKEN: readNetlifyEnv("WEBFLOW_API_TOKEN"),
      WEBFLOW_COLLECTION_ID: readNetlifyEnv("WEBFLOW_COLLECTION_ID"),
    });
    secrets = [config.googleApiKey, config.webflowApiToken];
    const outcome = await syncReviews({ config, logger });
    const summary = formatSummary(outcome);
    logger.info(summary);
    if (outcome.errors.length > 0) logger.error(summary);
    return jsonResponse(outcome, outcome.errors.length > 0 ? 500 : 200);
  } catch (error) {
    const raw = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Review sync failed: (no error message)";
    const message = redactSecrets(raw, secrets);
    logger.error(message);
    return jsonResponse({ error: message }, 500);
  }
}

export const config = {
  schedule: "0 0 * * *",
};
