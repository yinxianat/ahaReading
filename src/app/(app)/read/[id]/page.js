import Reader from "@/components/reader/Reader.js";

export const metadata = { title: "Reading" };

export default async function ReaderPage({ params }) {
  const { id } = await params;
  return <Reader id={id} />;
}
