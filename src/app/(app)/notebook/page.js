import Notebook from "@/components/notebook/Notebook.js";

export const metadata = { title: "Notebook" };

// Filters come from the URL on the server so back/refresh keep them without
// a useSearchParams boundary.
export default async function NotebookPage({ searchParams }) {
  const p = await searchParams;
  const pick = (k) => (typeof p?.[k] === "string" ? p[k].slice(0, 200) : "");
  return <Notebook initialSearch={pick("search")} initialTag={pick("tag")} initialArticleId={pick("articleId")} />;
}
