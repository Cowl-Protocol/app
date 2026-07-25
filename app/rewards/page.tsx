"use client";

// The program briefly lived at /rewards before it was renamed Earn. The old
// address keeps working; it just walks you to the new one.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RewardsMoved() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/earn");
  }, [router]);
  return null;
}
