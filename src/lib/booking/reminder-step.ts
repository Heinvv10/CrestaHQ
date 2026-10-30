/** The reminder step's QStash callback path, and the retries every publish of it asks for (so the step can tell its last delivery from `upstash-retried`). */
export const REMINDER_STEP_PATH = "/api/events/reminder/step";
export const REMINDER_STEP_RETRIES = 3;
