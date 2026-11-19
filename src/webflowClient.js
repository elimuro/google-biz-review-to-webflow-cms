// Slugs match Webflow's default slugify of the CMS display names:
// Name, Rating, Review text, Review date, Google review ID, Google listing link, Featured.
// `name` and `slug` are the built-in required fields. `name` stores the review author.
export const FIELD_SLUGS = {
  name: "name",
  slug: "slug",
  rating: "rating",
  reviewText: "review-text",
  reviewDate: "review-date",
  googleReviewId: "google-review-id",
  googleListingLink: "google-listing-link",
  featured: "featured",
};

export const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

export async function listItems({ token, collectionId, fetchImpl }) {
  assertWebflowConfig(token, collectionId);
  const items = [];
  const seenFirstIds = new Set();
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(collectionUrl(collectionId, "/items"));
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    const body = await webflowRequest({
      token,
      url: url.toString(),
      method: "GET",
      fetchImpl,
    });
    if (!Array.isArray(body.items)) {
      throw new Error("Webflow list items failed: response did not include an items array.");
    }
    if (body.items.length === 0) return items;

    const firstId = typeof body.items[0]?.id === "string" ? body.items[0].id : "";
    if (firstId && seenFirstIds.has(firstId)) {
      throw new Error("Webflow list items failed: pagination repeated a page.");
    }
    if (firstId) seenFirstIds.add(firstId);

    items.push(...body.items);
    offset += body.items.length;
    const total = body.pagination?.total;
    const reachedEnd = body.items.length < PAGE_LIMIT || (typeof total === "number" && offset >= total);
    if (reachedEnd) return items;
  }

  throw new Error("Webflow list items failed: stopped after 10000 items before the collection ended.");
}

export async function createItem({ token, collectionId, review, fetchImpl }) {
  assertWebflowConfig(token, collectionId);
  if (!review?.reviewId) {
    throw new Error("Webflow create item failed: review has no Google review id.");
  }

  const body = await webflowRequest({
    token,
    url: collectionUrl(collectionId, "/items/insert"),
    method: "POST",
    fetchImpl,
    payload: {
      items: [
        {
          isArchived: false,
          isDraft: false,
          fieldData: fieldDataFor(review),
        },
      ],
    },
  });

  const created = body.items?.[0];
  if (!created?.id) {
    throw new Error("Webflow create item failed: response did not include an item id.");
  }
  return created.id;
}

export async function publishItems({ token, collectionId, itemIds, fetchImpl }) {
  assertWebflowConfig(token, collectionId);
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new Error("Webflow publish items failed: no item ids to publish.");
  }

  const body = await webflowRequest({
    token,
    url: collectionUrl(collectionId, "/items/publish"),
    method: "POST",
    fetchImpl,
    payload: { itemIds },
  });

  const publishErrors = Array.isArray(body.errors) ? body.errors.filter(Boolean).map(String) : [];
  if (publishErrors.length > 0) {
    throw new Error(`Webflow publish items failed: ${publishErrors.join("; ")}`);
  }
  return Array.isArray(body.publishedItemIds) ? body.publishedItemIds : itemIds;
}

function fieldDataFor(review) {
  return {
    [FIELD_SLUGS.name]: review.author.slice(0, 256),
    [FIELD_SLUGS.slug]: itemSlug(review),
    [FIELD_SLUGS.rating]: review.rating,
    [FIELD_SLUGS.reviewText]: review.text,
    [FIELD_SLUGS.reviewDate]: review.date,
    [FIELD_SLUGS.googleReviewId]: review.reviewId,
    [FIELD_SLUGS.googleListingLink]: review.listingLink,
    [FIELD_SLUGS.featured]: false,
  };
}

function itemSlug(review) {
  const author = slugify(review.author).slice(0, 80);
  const idTail = slugify(review.reviewId.split("/").filter(Boolean).pop() ?? "review").slice(-80);
  const combined = [author, idTail].filter(Boolean).join("-");
  return combined.slice(0, 256) || "review";
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectionUrl(collectionId, suffix) {
  return `${WEBFLOW_API_BASE}/collections/${encodeURIComponent(collectionId)}${suffix}`;
}

async function webflowRequest({ token, url, method, fetchImpl, payload }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
    throw new Error(
      detail
        ? `Webflow request failed: ${method} ${safePath(url)} (${detail})`
        : `Webflow request failed: ${method} ${safePath(url)} (no error message)`,
    );
  }

  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      detail
        ? `Webflow request failed: ${method} ${safePath(url)} HTTP ${response.status} ${detail}`
        : `Webflow request failed: ${method} ${safePath(url)} HTTP ${response.status} (no error message)`,
    );
  }

  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim() : "";
    throw new Error(
      detail
        ? `Webflow request failed: ${method} ${safePath(url)} response was not JSON (${detail})`
        : `Webflow request failed: ${method} ${safePath(url)} response was not JSON (no error message)`,
    );
  }
}

function assertWebflowConfig(token, collectionId) {
  if (!String(token ?? "").trim() || !String(collectionId ?? "").trim()) {
    throw new Error("Webflow request failed: missing API token or collection id.");
  }
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    const candidate = body?.error?.message ?? body?.message ?? "";
    if (typeof candidate !== "string") return "";
    return candidate.trim().slice(0, 300);
  } catch {
    return "";
  }
}
