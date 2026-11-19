import { createLogger, describeError, redactSecrets } from "./config.js";
import { fetchGoogleReviews } from "./googleClient.js";
import { FIELD_SLUGS, createItem, listItems, publishItems } from "./webflowClient.js";

export function formatSummary(outcome) {
  return `Review sync: fetched=${outcome.fetched} created=${outcome.created} skipped=${outcome.skipped} errors=${outcome.errors.length}`;
}

export async function syncReviews({ config, logger = createLogger(), fetchImpl } = {}) {
  const http = fetchImpl ?? globalThis.fetch;
  const secrets = [config.googleApiKey, config.webflowApiToken];
  const errors = [];

  const remember = (error, fallback) => {
    const message = redactSecrets(describeError(error, fallback), secrets);
    errors.push(message);
    logger.error(message);
  };

  let fetchedReviews;
  try {
    fetchedReviews = await fetchGoogleReviews({
      apiKey: config.googleApiKey,
      placeId: config.googlePlaceId,
      fetchImpl: http,
    });
  } catch (error) {
    remember(error, "Google reviews request failed");
    return { fetched: 0, created: 0, skipped: 0, errors };
  }

  for (const message of fetchedReviews.rejected) {
    remember(new Error(message), "Google review was rejected");
  }

  let items;
  try {
    items = await listItems({
      token: config.webflowApiToken,
      collectionId: config.webflowCollectionId,
      fetchImpl: http,
    });
  } catch (error) {
    remember(error, "Webflow list items failed");
    return { fetched: fetchedReviews.fetched, created: 0, skipped: 0, errors };
  }

  const known = new Map();
  for (const item of items) {
    const reviewId = item?.fieldData?.[FIELD_SLUGS.googleReviewId];
    if (typeof reviewId !== "string" || !reviewId.trim()) continue;
    known.set(reviewId.trim(), { id: item.id, isDraft: item.isDraft === true });
  }

  let created = 0;
  let skipped = 0;

  for (const review of fetchedReviews.reviews) {
    const current = known.get(review.reviewId);
    if (current) {
      if (current.isDraft && current.id) {
        try {
          await publishItems({
            token: config.webflowApiToken,
            collectionId: config.webflowCollectionId,
            itemIds: [current.id],
            fetchImpl: http,
          });
        } catch (error) {
          remember(error, `Webflow publish failed for review ${review.reviewId}`);
        }
      }
      skipped += 1;
      continue;
    }

    try {
      const itemId = await createItem({
        token: config.webflowApiToken,
        collectionId: config.webflowCollectionId,
        review,
        fetchImpl: http,
      });
      known.set(review.reviewId, { id: itemId, isDraft: false });
      created += 1;
      try {
        await publishItems({
          token: config.webflowApiToken,
          collectionId: config.webflowCollectionId,
          itemIds: [itemId],
          fetchImpl: http,
        });
      } catch (error) {
        known.set(review.reviewId, { id: itemId, isDraft: true });
        remember(error, `Webflow publish failed for review ${review.reviewId}`);
      }
    } catch (error) {
      remember(error, `Webflow create failed for review ${review.reviewId}`);
    }
  }

  return {
    fetched: fetchedReviews.fetched,
    created,
    skipped,
    errors,
  };
}
