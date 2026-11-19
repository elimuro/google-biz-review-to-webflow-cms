import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { createLogger, loadConfig, REQUIRED_ENV_VARS } from "../src/config.js";
import { fetchGoogleReviews, GOOGLE_FIELD_MASK, listingLinkFor, mapPlaceDetails } from "../src/googleClient.js";
import { formatSummary, syncReviews } from "../src/sync.js";
import { FIELD_SLUGS } from "../src/webflowClient.js";
import syncReviewsHandler, { config as functionConfig } from "../netlify/functions/sync-reviews.js";

const placeDetails = JSON.parse(
  readFileSync(new URL("./fixtures/place-details.json", import.meta.url), "utf8"),
);
const existingItems = JSON.parse(
  readFileSync(new URL("./fixtures/existing-items.json", import.meta.url), "utf8"),
);

const TEST_CONFIG = {
  googleApiKey: "test-google-key",
  googlePlaceId: "ChIJtestPlace",
  webflowApiToken: "test-webflow-token",
  webflowCollectionId: "collection-test",
};

const NEWER_ID = "places/ChIJtestPlace/reviews/newer";
const OLDER_ID = "places/ChIJtestPlace/reviews/older";

before(() => {
  globalThis.fetch = async () => {
    throw new Error("Live fetch is not allowed in tests.");
  };
});

describe("Google Place Details mapping", () => {
  it("sorts fixture reviews newest first and keeps the review resource name", () => {
    const mapped = mapPlaceDetails(placeDetails, TEST_CONFIG.googlePlaceId);
    assert.equal(mapped.fetched, 2);
    assert.deepEqual(mapped.rejected, []);
    assert.deepEqual(
      mapped.reviews.map((review) => review.reviewId),
      [NEWER_ID, OLDER_ID],
    );
    assert.deepEqual(mapped.reviews[0], {
      author: "Pat Newer",
      rating: 5,
      text: "Newer review text",
      date: "2025-06-01T15:04:05.000Z",
      reviewId: NEWER_ID,
      listingLink: listingLinkFor(TEST_CONFIG.googlePlaceId),
    });
    assert.notEqual(mapped.reviews[0].listingLink, placeDetails.reviews[1].googleMapsUri);
  });

  it("requests only the reviews field mask and does not put the API key in the URL", async () => {
    const { fetchImpl, calls } = installFetch({ googleBody: placeDetails });
    const mapped = await fetchGoogleReviews({
      apiKey: TEST_CONFIG.googleApiKey,
      placeId: TEST_CONFIG.googlePlaceId,
      fetchImpl,
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    const url = new URL(call.url);
    assert.equal(url.hostname, "places.googleapis.com");
    assert.equal(url.pathname, "/v1/places/ChIJtestPlace");
    assert.equal(url.search, "");
    assert.equal(call.headers["X-Goog-Api-Key"], TEST_CONFIG.googleApiKey);
    assert.equal(call.headers["X-Goog-FieldMask"], GOOGLE_FIELD_MASK);
    assert.equal(GOOGLE_FIELD_MASK, "reviews,rating,userRatingCount");
    assert.equal(mapped.reviews[0].reviewId, NEWER_ID);
  });
});

describe("sync dedupe", () => {
  it("creates and publishes fixture reviews once, then creates nothing on the second run", async () => {
    const world = installFetch({ googleBody: placeDetails });
    const logger = captureLogger();

    const first = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });
    assert.deepEqual(first, { fetched: 2, created: 2, skipped: 0, errors: [] });
    assert.deepEqual(createdReviewIds(world), [NEWER_ID, OLDER_ID]);
    assert.deepEqual(publishedItemIds(world), ["item-1", "item-2"]);
    assert.equal(world.state.items.length, 2);

    const newer = world.state.items[0].fieldData;
    assert.equal(newer[FIELD_SLUGS.name], "Pat Newer");
    assert.equal(newer[FIELD_SLUGS.slug], "pat-newer-newer");
    assert.equal(newer[FIELD_SLUGS.rating], 5);
    assert.equal(newer[FIELD_SLUGS.reviewText], "Newer review text");
    assert.equal(newer[FIELD_SLUGS.reviewDate], "2025-06-01T15:04:05.000Z");
    assert.equal(newer[FIELD_SLUGS.googleReviewId], NEWER_ID);
    assert.equal(newer[FIELD_SLUGS.googleListingLink], listingLinkFor(TEST_CONFIG.googlePlaceId));
    assert.equal(newer[FIELD_SLUGS.featured], false);
    assert.equal(insertBodies(world)[0].items[0].isDraft, false);

    const second = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });
    assert.deepEqual(second, { fetched: 2, created: 0, skipped: 2, errors: [] });
    assert.equal(createdReviewIds(world).length, 2);
    assert.equal(publishedItemIds(world).length, 2);
    assert.equal(world.state.items.length, 2);
    assert.deepEqual(methodsUsed(world), ["GET", "POST"]);
    assert.deepEqual(logger.lines.error, []);
  });

  it("does not update an existing item when the fixture text and rating differ", async () => {
    const world = installFetch({
      googleBody: placeDetails,
      items: structuredClone(existingItems.items),
    });
    const beforeItem = structuredClone(world.state.items[0]);

    const outcome = await syncReviews({ config: TEST_CONFIG, fetchImpl: world.fetchImpl });

    assert.deepEqual(outcome, { fetched: 2, created: 1, skipped: 1, errors: [] });
    assert.deepEqual(createdReviewIds(world), [NEWER_ID]);
    assert.deepEqual(world.state.items[0], beforeItem);
    assert.equal(world.state.items[0].fieldData[FIELD_SLUGS.reviewText], "This text should stay.");
    assert.equal(world.state.items[0].fieldData[FIELD_SLUGS.rating], 1);
    assert.equal(world.state.items[0].fieldData[FIELD_SLUGS.featured], true);
  });

  it("sees a review id that is only on the second Webflow page", async () => {
    const fillers = Array.from({ length: 100 }, (_, index) => ({
      id: `filler-${index}`,
      isDraft: false,
      fieldData: {
        [FIELD_SLUGS.googleReviewId]: `places/ChIJtestPlace/reviews/filler-${index}`,
        [FIELD_SLUGS.reviewText]: "filler",
        [FIELD_SLUGS.rating]: 5,
      },
    }));
    const older = {
      id: "existing-older",
      isDraft: false,
      fieldData: {
        [FIELD_SLUGS.googleReviewId]: OLDER_ID,
        [FIELD_SLUGS.reviewText]: "page two stays",
        [FIELD_SLUGS.rating]: 2,
      },
    };
    const world = installFetch({ googleBody: placeDetails, items: [...fillers, older] });

    const outcome = await syncReviews({ config: TEST_CONFIG, fetchImpl: world.fetchImpl });

    assert.equal(outcome.created, 1);
    assert.equal(outcome.skipped, 1);
    assert.deepEqual(createdReviewIds(world), [NEWER_ID]);
    assert.equal(older.fieldData[FIELD_SLUGS.reviewText], "page two stays");
    const offsets = world.calls
      .filter((call) => new URL(call.url).pathname.endsWith("/items"))
      .map((call) => new URL(call.url).searchParams.get("offset"));
    assert.deepEqual(offsets, ["0", "100"]);
  });

  it("creates one CMS item when the same review id is repeated in one response", async () => {
    const googleBody = structuredClone(placeDetails);
    googleBody.reviews.push(structuredClone(googleBody.reviews[0]));
    const world = installFetch({ googleBody });

    const outcome = await syncReviews({ config: TEST_CONFIG, fetchImpl: world.fetchImpl });

    assert.equal(outcome.fetched, 3);
    assert.equal(outcome.created, 2);
    assert.equal(outcome.skipped, 1);
    assert.equal(new Set(createdReviewIds(world)).size, 2);
  });

  it("publishes an existing draft without writing a second item or changing its text", async () => {
    const draft = {
      id: "draft-newer",
      isDraft: true,
      fieldData: {
        [FIELD_SLUGS.name]: "Pat Newer",
        [FIELD_SLUGS.googleReviewId]: NEWER_ID,
        [FIELD_SLUGS.reviewText]: "Draft text stays.",
        [FIELD_SLUGS.rating]: 1,
        [FIELD_SLUGS.featured]: false,
      },
    };
    const world = installFetch({ googleBody: placeDetails, items: [draft] });

    const first = await syncReviews({ config: TEST_CONFIG, fetchImpl: world.fetchImpl });
    assert.equal(first.created, 1);
    assert.equal(first.skipped, 1);
    assert.deepEqual(publishedItemIds(world), ["draft-newer", "item-2"]);
    assert.equal(draft.fieldData[FIELD_SLUGS.reviewText], "Draft text stays.");
    assert.equal(draft.isDraft, false);

    const publishCount = publishedItemIds(world).length;
    const second = await syncReviews({ config: TEST_CONFIG, fetchImpl: world.fetchImpl });
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 2);
    assert.equal(publishedItemIds(world).length, publishCount);
  });
});

describe("error logging", () => {
  it("logs a Google API failure and does not create items", async () => {
    const world = installFetch({
      googleBody: { error: { message: "The provided API key is invalid." } },
      googleStatus: 403,
    });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.equal(outcome.created, 0);
    assert.equal(world.state.items.length, 0);
    assert.equal(outcome.errors.length, 1);
    assert.match(outcome.errors[0], /Google reviews request failed: HTTP 403 The provided API key is invalid\./);
    assert.deepEqual(logger.lines.error, outcome.errors);
    assert.ok(logger.lines.error.every((line) => line.trim().length > 0));
  });

  it("logs a clear message when the client throws an empty error", async () => {
    const world = installFetch({ googleBody: placeDetails, throwOnGoogle: "   " });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.deepEqual(outcome.errors, ["Google reviews request failed: (no error message)"]);
    assert.deepEqual(logger.lines.error, outcome.errors);
  });

  it("redacts secrets that leak into an error message", async () => {
    const world = installFetch({
      googleBody: placeDetails,
      throwOnGoogle: "boom test-google-key and test-webflow-token",
    });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.match(outcome.errors[0], /\[redacted\]/);
    assert.doesNotMatch(outcome.errors.join("\n"), /test-google-key/);
    assert.doesNotMatch(outcome.errors.join("\n"), /test-webflow-token/);
    assert.doesNotMatch(logger.lines.error.join("\n"), /test-google-key/);
  });

  it("logs a Webflow list failure and does not create items", async () => {
    const world = installFetch({ googleBody: placeDetails, failList: true });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.equal(outcome.fetched, 2);
    assert.equal(outcome.created, 0);
    assert.match(outcome.errors[0], /Webflow request failed: GET \/v2\/collections\/collection-test\/items HTTP 500 Could not list items\./);
    assert.equal(createdReviewIds(world).length, 0);
    assert.equal(logger.lines.error.length, 1);
  });

  it("logs a create failure for one review and still publishes the other", async () => {
    const world = installFetch({ googleBody: placeDetails, failCreateOnReviewId: OLDER_ID });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.deepEqual(
      world.state.items.map((item) => item.fieldData[FIELD_SLUGS.googleReviewId]),
      [NEWER_ID],
    );
    assert.deepEqual(publishedItemIds(world), ["item-1"]);
    assert.equal(outcome.created, 1);
    assert.equal(outcome.errors.length, 1);
    assert.match(outcome.errors[0], /HTTP 400 Collection field missing\./);
    assert.match(logger.lines.error[0], /Collection field missing/);
  });

  it("logs a publish failure and the next run does not create a duplicate", async () => {
    const world = installFetch({ googleBody: placeDetails, failPublish: true });
    const logger = captureLogger();

    const first = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });
    assert.equal(first.created, 2);
    assert.equal(first.errors.length, 2);
    assert.ok(
      first.errors.every((line) =>
        /Webflow request failed: POST \/v2\/collections\/collection-test\/items\/publish HTTP 500 Publish failed for test\./.test(line),
      ),
    );
    assert.equal(world.state.items.length, 2);
    assert.ok(world.state.items.every((item) => item.isDraft === true));

    world.failPublish = false;
    const second = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });
    assert.equal(second.created, 0);
    assert.equal(second.skipped, 2);
    assert.equal(second.errors.length, 0);
    assert.equal(world.state.items.length, 2);
    assert.ok(world.state.items.every((item) => item.isDraft === false));
  });

  it("logs a review that has no resource name and does not create it", async () => {
    const googleBody = structuredClone(placeDetails);
    googleBody.reviews.push({ rating: 5, text: { text: "No id" }, publishTime: "2025-01-01T00:00:00Z" });
    const world = installFetch({ googleBody });
    const logger = captureLogger();

    const outcome = await syncReviews({ config: TEST_CONFIG, logger, fetchImpl: world.fetchImpl });

    assert.equal(outcome.fetched, 3);
    assert.equal(outcome.created, 2);
    assert.match(outcome.errors[0], /missing a resource name/);
    assert.equal(logger.lines.error.length, 1);
  });
});

describe("config and scheduled entry", () => {
  it("fails loudly when required env vars are missing or blank", () => {
    assert.throws(
      () => loadConfig({}),
      /Missing required environment variables: GOOGLE_API_KEY, GOOGLE_PLACE_ID, WEBFLOW_API_TOKEN, WEBFLOW_COLLECTION_ID/,
    );

    let message = "";
    try {
      loadConfig({
        GOOGLE_API_KEY: "  test-google-key  ",
        GOOGLE_PLACE_ID: "ChIJtestPlace",
        WEBFLOW_API_TOKEN: "   ",
        WEBFLOW_COLLECTION_ID: "collection-test",
      });
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /WEBFLOW_API_TOKEN/);
    assert.doesNotMatch(message, /GOOGLE_API_KEY/);

    const loaded = loadConfig({
      GOOGLE_API_KEY: "  test-google-key  ",
      GOOGLE_PLACE_ID: " ChIJtestPlace ",
      WEBFLOW_API_TOKEN: " test-webflow-token ",
      WEBFLOW_COLLECTION_ID: " collection-test ",
    });
    assert.equal(loaded.googleApiKey, "test-google-key");
    assert.equal(loaded.webflowCollectionId, "collection-test");
  });

  it("keeps secrets in env vars and ignores .env", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    for (const key of REQUIRED_ENV_VARS) {
      assert.match(example, new RegExp(`^${key}=$`, "m"));
    }
    assert.doesNotMatch(example, /=.+/);
    assert.match(gitignore, /^\.env$/m);
    assert.match(gitignore, /^!\.env\.example$/m);
  });

  it("schedules the function daily at midnight UTC", () => {
    const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
    assert.equal(functionConfig.schedule, "0 0 * * *");
    assert.match(toml, /\[functions\."sync-reviews"\]\s+schedule = "0 0 \* \* \*"/);
  });

  it("does not read process.env when Netlify.env is missing", async () => {
    const previous = stashEnv({
      GOOGLE_API_KEY: "from-process-env",
      GOOGLE_PLACE_ID: "from-process-env",
      WEBFLOW_API_TOKEN: "from-process-env",
      WEBFLOW_COLLECTION_ID: "from-process-env",
    });
    const previousNetlify = globalThis.Netlify;
    delete globalThis.Netlify;
    const logs = captureConsole();
    try {
      const response = await syncReviewsHandler();
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.match(body.error, /Netlify\.env\.get is unavailable/);
      assert.match(logs.error.join("\n"), /Netlify\.env\.get is unavailable/);
      assert.ok(logs.error.every((line) => line.trim().length > 0));
    } finally {
      restoreEnv(previous);
      globalThis.Netlify = previousNetlify;
      logs.restore();
    }
  });

  it("logs the summary from Netlify env values and publishes on the first run only", async () => {
    const previous = stashEnv({
      GOOGLE_API_KEY: "from-process-env",
      GOOGLE_PLACE_ID: "from-process-env",
      WEBFLOW_API_TOKEN: "from-process-env",
      WEBFLOW_COLLECTION_ID: "from-process-env",
    });
    const previousNetlify = globalThis.Netlify;
    const previousFetch = globalThis.fetch;
    const world = installFetch({ googleBody: placeDetails });
    globalThis.Netlify = {
      env: {
        get(name) {
          const values = {
            GOOGLE_API_KEY: TEST_CONFIG.googleApiKey,
            GOOGLE_PLACE_ID: TEST_CONFIG.googlePlaceId,
            WEBFLOW_API_TOKEN: TEST_CONFIG.webflowApiToken,
            WEBFLOW_COLLECTION_ID: TEST_CONFIG.webflowCollectionId,
          };
          return values[name] ?? "";
        },
      },
    };
    globalThis.fetch = world.fetchImpl;
    const logs = captureConsole();
    try {
      const firstResponse = await syncReviewsHandler();
      assert.equal(firstResponse.status, 200);
      const firstBody = await firstResponse.json();
      assert.equal(firstBody.created, 2);
      assert.match(logs.info.join("\n"), new RegExp(formatSummary(firstBody)));

      const googleCall = world.calls.find((call) => call.url.includes("places.googleapis.com"));
      assert.equal(googleCall.headers["X-Goog-Api-Key"], TEST_CONFIG.googleApiKey);
      assert.equal(new URL(googleCall.url).pathname, "/v1/places/ChIJtestPlace");
      const webflowCall = world.calls.find((call) => call.url.includes("api.webflow.com"));
      assert.equal(webflowCall.headers.Authorization, "Bearer test-webflow-token");
      assert.match(webflowCall.url, /\/collections\/collection-test\//);
      assert.equal(
        world.calls.some((call) => call.url.includes("from-process-env")),
        false,
      );

      logs.info.length = 0;
      const secondResponse = await syncReviewsHandler();
      const secondBody = await secondResponse.json();
      assert.equal(secondResponse.status, 200);
      assert.equal(secondBody.created, 0);
      assert.equal(secondBody.skipped, 2);
      assert.match(logs.info.join("\n"), /Review sync: fetched=2 created=0 skipped=2 errors=0/);
      assert.equal(world.state.items.length, 2);
    } finally {
      restoreEnv(previous);
      globalThis.Netlify = previousNetlify;
      globalThis.fetch = previousFetch;
      logs.restore();
    }
  });
});

describe("logger", () => {
  it("never writes a blank line", () => {
    const lines = [];
    const logger = createLogger({
      info(message) {
        lines.push(message);
      },
      error(message) {
        lines.push(message);
      },
    });
    logger.error("   ");
    logger.info("");
    assert.deepEqual(lines, ["(no error message)", "(no error message)"]);
  });
});

function installFetch({
  googleBody,
  googleStatus = 200,
  items = [],
  failList = false,
  failCreateOnReviewId,
  failPublish = false,
  throwOnGoogle,
} = {}) {
  const world = {
    calls: [],
    state: { items },
    failPublish,
    fetchImpl: async (url, options = {}) => {
      const method = options.method ?? "GET";
      let body;
      if (options.body) body = JSON.parse(options.body);
      const call = { url: String(url), method, headers: options.headers ?? {}, body };
      world.calls.push(call);
      const parsed = new URL(call.url);

      if (parsed.hostname === "places.googleapis.com") {
        if (throwOnGoogle != null) throw new Error(throwOnGoogle);
        return jsonResult(googleBody, googleStatus);
      }

      if (parsed.hostname !== "api.webflow.com") {
        throw new Error(`Unexpected host ${parsed.hostname}`);
      }

      if (parsed.pathname.endsWith("/items/publish")) {
        if (world.failPublish) {
          return jsonResult({ message: "Publish failed for test.", errors: ["Publish failed for test."] }, 500);
        }
        for (const itemId of body.itemIds) {
          const item = world.state.items.find((entry) => entry.id === itemId);
          if (item) item.isDraft = false;
        }
        return jsonResult({ publishedItemIds: body.itemIds, errors: [] }, 202);
      }

      if (parsed.pathname.endsWith("/items/insert")) {
        const fieldData = body.items[0].fieldData;
        if (failCreateOnReviewId && fieldData[FIELD_SLUGS.googleReviewId] === failCreateOnReviewId) {
          return jsonResult({ message: "Collection field missing." }, 400);
        }
        const item = {
          id: `item-${world.state.items.length + 1}`,
          isDraft: true,
          fieldData,
        };
        world.state.items.push(item);
        return jsonResult({ items: [item] }, 202);
      }

      if (parsed.pathname.endsWith("/items")) {
        if (failList) return jsonResult({ message: "Could not list items." }, 500);
        const limit = Number(parsed.searchParams.get("limit") ?? "100");
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        return jsonResult({
          items: world.state.items.slice(offset, offset + limit),
          pagination: { limit, offset, total: world.state.items.length },
        });
      }

      throw new Error(`Unexpected Webflow path ${parsed.pathname}`);
    },
  };
  return world;
}

function jsonResult(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createdReviewIds(world) {
  return insertBodies(world).map((body) => body.items[0].fieldData[FIELD_SLUGS.googleReviewId]);
}

function insertBodies(world) {
  return world.calls.filter((call) => new URL(call.url).pathname.endsWith("/items/insert")).map((call) => call.body);
}

function publishedItemIds(world) {
  return world.calls
    .filter((call) => new URL(call.url).pathname.endsWith("/items/publish") && call.method === "POST")
    .flatMap((call) => call.body?.itemIds ?? []);
}

function methodsUsed(world) {
  return [...new Set(world.calls.map((call) => call.method))].sort();
}

function captureLogger() {
  const lines = { info: [], error: [] };
  return {
    lines,
    info(message) {
      lines.info.push(message);
    },
    error(message) {
      lines.error.push(message);
    },
  };
}

function captureConsole() {
  const info = [];
  const error = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (message) => {
    info.push(String(message));
  };
  console.error = (message) => {
    error.push(String(message));
  };
  return {
    info,
    error,
    restore() {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

function stashEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return previous;
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
