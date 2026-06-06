import { useMutation } from "@tanstack/react-query";
import type { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { ErrorType } from "./custom-fetch";
import type { UpdateUserStatusBody, UpdateUserStatusResponse } from "./generated/api.schemas";

// Calls the legacy non-admin path. The generated `useAdminUpdateUserStatus`
// hook calls /api/admin/users/:id/status. Both paths are aliases on the
// server.
export const updateUserStatus = async (
  id: number,
  body: UpdateUserStatusBody,
): Promise<UpdateUserStatusResponse> => {
  return customFetch<UpdateUserStatusResponse>(`/api/users/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
};

export const useUpdateUserStatus = <
  TError = ErrorType<unknown>,
  TContext = unknown,
>(options?: {
  mutation?: UseMutationOptions<
    UpdateUserStatusResponse,
    TError,
    { id: number; data: UpdateUserStatusBody },
    TContext
  >;
}): UseMutationResult<
  UpdateUserStatusResponse,
  TError,
  { id: number; data: UpdateUserStatusBody },
  TContext
> => {
  const { mutation: mutationOptions } = options ?? {};
  const mutationKey = ["updateUserStatus"];
  return useMutation({
    mutationKey,
    mutationFn: ({ id, data }) => updateUserStatus(id, data),
    ...mutationOptions,
  });
};
