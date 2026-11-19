export const REQUIRED_ENV_VARS = [
  "GOOGLE_API_KEY",
  "GOOGLE_PLACE_ID",
  "WEBFLOW_API_TOKEN",
  "WEBFLOW_COLLECTION_ID",
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. Refusing to sync without them.`,
    );
  }

  return {
    googleApiKey: String(env.GOOGLE_API_KEY).trim(),
    googlePlaceId: String(env.GOOGLE_PLACE_ID).trim(),
    webflowApiToken: String(env.WEBFLOW_API_TOKEN).trim(),
    webflowCollectionId: String(env.WEBFLOW_COLLECTION_ID).trim(),
  };
}

export function describeError(error, fallback) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.trim();
  if (text) return text;
  return `${fallback}: (no error message)`;
}

export function redactSecrets(message, secrets) {
  let text = String(message ?? "").trim();
  if (!text) text = "(no error message)";
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[redacted]");
    }
  }
  return text || "(no error message)";
}

export function createLogger(sink = console) {
  return {
    info(message) {
      sink.info(asLogLine(message));
    },
    error(message) {
      sink.error(asLogLine(message));
    },
  };
}

function asLogLine(message) {
  const text = String(message ?? "").trim();
  return text || "(no error message)";
}
