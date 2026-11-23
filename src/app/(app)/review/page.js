import Review from "@/components/review/Review.js";

export const metadata = { title: "Review" };

export default async function ReviewPage({ searchParams }) {
  const p = await searchParams;
  const concept = typeof p?.concept === "string" ? p.concept.slice(0, 100) : "";
  return <Review conceptId={concept} />;
}
