// Upload error copy in the client (src/lib/client/errors.js).
import { describe, it, expect } from "vitest";
import { describeError } from "@/lib/client/errors.js";

describe("describeError for uploads", () => {
  it("[QA4-8] the upload lock says another file is uploading, not 'a lot of articles'", () => {
    const view = describeError({ code: "upload_in_progress", message: "Another file is still uploading.", retryAfter: 5 }, "upload");
    expect(view).toMatchObject({ message: expect.stringMatching(/^Another file is still uploading/), retryAfter: 5, recovery: "retry" });
    expect(view.message).not.toMatch(/a lot of articles/);
  });

  it("a busy server counts down to a retry", () => {
    expect(describeError({ code: "server_busy", retryAfter: 10 }, "upload")).toMatchObject({ message: expect.stringContaining("{countdown}"), retryAfter: 10, recovery: "retry" });
  });

  it("an interrupted upload offers a retry", () => {
    expect(describeError({ code: "upload_interrupted", message: "The upload stopped before the whole file arrived." }, "upload")).toMatchObject({ recovery: "retry", tone: "warning" });
  });

  it("the per-minute article limit keeps its own wording", () => {
    expect(describeError({ code: "rate_limited", retryAfter: 12 }, "upload").message).toMatch(/a lot of articles/);
  });
});
