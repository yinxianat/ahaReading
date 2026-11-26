import { Suspense } from "react";
import Player from "@/components/listen/Player.js";

export const metadata = { title: "Listening" };

export default async function ListenPage({ params }) {
  const { id } = await params;
  return (
    <Suspense>
      <Player seriesId={id} />
    </Suspense>
  );
}
