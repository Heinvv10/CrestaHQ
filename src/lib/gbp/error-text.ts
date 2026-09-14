/**
 * The fixed sentence for Google's quota-0 refusal (`access_not_approved`):
 * the Business Profile APIs answer 429 RESOURCE_EXHAUSTED with a quota of 0
 * until Google approves the project's access request. One constant, so the
 * route, the picker, the sync text and the insights tab all say the same.
 */
export const ACCESS_NOT_APPROVED_TEXT = "Google hasn't approved Business Profile API access for this project yet.";
