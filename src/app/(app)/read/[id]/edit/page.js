import ArticleEditor from "@/components/library/ArticleEditor.js";

export const metadata = { title: "Edit article" };

export default async function EditArticlePage({ params }) {
  const { id } = await params;
  return <ArticleEditor id={id} />;
}
