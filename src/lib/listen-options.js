/**
 * Aha Listening choices (levels, styles, part lengths), shared by the server (validation,
 * prompts) and the browser (setup sheet, labels). Pure; no database or secrets.
 */

export const LEVELS = Object.freeze({
  foundations: { label: "Foundations", short: "Foundations", hint: "New to this. Plain words, no jargon without a definition." },
  working: { label: "Working knowledge", short: "Working", hint: "Knows the basics. How it works and how it's used." },
  advanced: { label: "Advanced", short: "Advanced", hint: "Comfortable with the field. Trade-offs, edge cases, internals." },
});

export const STYLES = Object.freeze({
  ground_up: { label: "Build it from the ground up", hint: "Starts from first principles; each idea rests on the last." },
  summary: { label: "Quick summary", hint: "The main points in plain words, with a recap at the end." },
  key_concepts: { label: "Key concepts", hint: "One concept per chapter: what it is, why it matters, one example." },
  stories: { label: "Stories and fun facts", hint: "History, people and surprising facts that make it stick." },
  case: { label: "Real-world case", hint: "A worked scenario from start to finish." },
  two_voices: { label: "Two voices", hint: "A host asks the questions a listener would; an expert explains." },
  mistakes: { label: "Common mistakes", hint: "Misconceptions, and why they're wrong." },
  quiz: { label: "Quiz by ear", hint: "A question, a pause to think, then the answer and why." },
});

export const PART_MINUTE_CHOICES = Object.freeze([2, 5, 10, 15]);
