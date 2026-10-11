"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiClientError } from "@/lib/client/api";

/** Shared mutation wrapper for scan pages: error toasts + cache invalidation. */
export function useAnalysis<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    },
    onError: (e) => {
      const msg = e instanceof ApiClientError ? e.message : "Analysis failed. Please try again.";
      toast.error(msg, { description: e instanceof ApiClientError && e.requestId ? `Reference: ${e.requestId}` : undefined });
    },
  });
}
