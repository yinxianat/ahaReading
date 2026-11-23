import ConceptDetail from "@/components/notebook/ConceptDetail.js";

export const metadata = { title: "Concept" };

export default async function ConceptPage({ params }) {
  const { id } = await params;
  return <ConceptDetail id={id} />;
}
