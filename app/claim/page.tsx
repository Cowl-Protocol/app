"use client";

// The batch briefly lived at /claim before it took the plainer name. The old
// address keeps working; it just walks you to the new one.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ClaimMoved() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/airdrop");
  }, [router]);
  return null;
}
