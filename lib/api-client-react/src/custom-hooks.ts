import { useMutation } from "@tanstack/react-query";
import type { UseMutationOptions, UseMutationResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { ErrorType } from "./custom-fetch";
import type { UserProfileStatus } from "./generated/api.schemas";

export interface UpdateUserStatusBody {
  status: UserProfileStatus;
}

export interface UpdateUserStatusResponse {
  id: number;
  status: string;
}

export const updateUserStatus = async (
  id: number,
  updateUserStatusBody: UpdateUserStatusBody,
): Promise<UpdateUserStatusResponse> => {
  return customFetch<UpdateUserStatusResponse>(`/api/users/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify(updateUserStatusBody),
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
