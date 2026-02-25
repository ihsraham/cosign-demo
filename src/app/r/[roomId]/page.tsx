import { CosignDemoApp } from '@/components/CosignDemoApp';

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;

  return <CosignDemoApp initialRoomId={roomId} />;
}
