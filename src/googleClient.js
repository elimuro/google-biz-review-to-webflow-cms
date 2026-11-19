export const GOOGLE_FIELD_MASK = "reviews,rating,userRatingCount";

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places";

export async function fetchGoogleReviews({ apiKey, placeId, fetchImpl = globalThis.fetch }) {
  if (!String(apiKey ?? "").trim() || !String(placeId ?? "").trim()) {
    throw new Error("Google reviews request failed: missing API key or place ID.");
  }

  const url = `${PLACES_ENDPOINT}/${encodeURIComponent(placeId)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": GOOGLE_FIELD_MASK,
      },
    });
  } catch (error) {
    throw new Error(networkFailure("Google reviews request failed", error));
  }

  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(httpFailure("Google reviews request failed", response.status, detail));
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(networkFailure("Google reviews request failed: response was not JSON", error));
  }

  if (body?.error?.message && !Array.isArray(body.reviews)) {
    throw new Error(`Google reviews request failed: ${String(body.error.message).trim()}`);
  }

  return mapPlaceDetails(body, placeId);
}

export function mapPlaceDetails(place, placeId) {
  if (!String(placeId ?? "").trim()) {
    throw new Error("Google reviews request failed: missing place ID.");
  }
  if (place?.reviews == null) {
    return { reviews: [], rejected: [], fetched: 0 };
  }
  if (!Array.isArray(place.reviews)) {
    throw new Error("Google reviews request failed: response did not include a reviews array.");
  }

  const listingLink = listingLinkFor(placeId);
  const rejected = [];
  const reviews = [];

  for (const raw of place.reviews) {
    const mapped = mapReview(raw, listingLink, rejected);
    if (mapped) reviews.push(mapped);
  }

  // Place Details returns at most five reviews, chosen by relevance.
  // Sort that set newest-first. The field mask has no newest-only flag.
  reviews.sort((left, right) => Date.parse(right.date) - Date.parse(left.date));
  return { reviews, rejected, fetched: place.reviews.length };
}

// The allowed field mask does not include the place's googleMapsUri.
// The CMS listing link is the Maps search URL for this place ID.
export function listingLinkFor(placeId) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query_place_id", placeId);
  return url.toString();
}

function mapReview(raw, listingLink, rejected) {
  const reviewId = typeof raw?.name === "string" ? raw.name.trim() : "";
  if (!reviewId) {
    rejected.push(
      "Google review missing a resource name; not creating a CMS item because it cannot be deduped.",
    );
    return null;
  }

  const rating = normalizeRating(raw.rating);
  if (rating == null) {
    rejected.push(
      `Google review ${reviewId} has invalid rating ${JSON.stringify(raw.rating)}; expected an integer from 1 to 5.`,
    );
    return null;
  }

  const date = normalizeDate(raw.publishTime);
  if (!date) {
    rejected.push(`Google review ${reviewId} has no usable publishTime; not creating a CMS item.`);
    return null;
  }

  const author = raw.authorAttribution?.displayName?.trim() || "Anonymous";
  const text = raw.text?.text ?? raw.originalText?.text ?? "";
  return {
    author,
    rating,
    text: String(text),
    date,
    reviewId,
    listingLink,
  };
}

function normalizeRating(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    return null;
  }
  return value;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
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

function networkFailure(prefix, error) {
  const detail = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  return detail ? `${prefix}: ${detail}` : `${prefix}: (no error message)`;
}

function httpFailure(prefix, status, detail) {
  return detail ? `${prefix}: HTTP ${status} ${detail}` : `${prefix}: HTTP ${status} (no error message)`;
}
